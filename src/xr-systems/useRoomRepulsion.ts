import { useXR, useXRMeshes, useXRPlanes } from '@react-three/xr'
import { useRef } from 'react'
import {
  Box3,
  Matrix4,
  type Object3D,
  ShapeUtils,
  Vector2,
  Vector3,
} from 'three'
import type { RoomGeometry, RoomSurfaceData, Vec3 } from '../protocol'
import { useButterflyStore } from '../state/useButterflyStore'
import { pointTuple, RoomCollider } from './roomGeometry'

type DetectedSurface = XRMesh | XRPlane
interface CachedSource {
  source: DetectedSurface
  changed: number
  matrix: Matrix4
  visible: boolean
}

/** Invoked by the single ECS callback; geometry work occurs only for topology/pose changes. */
class XRRoomCache {
  readonly collider = new RoomCollider()
  meshes: readonly XRMesh[] = []
  planes: readonly XRPlane[] = []
  referenceSpace: XRReferenceSpace | undefined
  origin: Object3D | undefined
  private cache: CachedSource[] = []
  private poseMatrix = new Matrix4()
  private originMatrix = new Matrix4()
  private revision = 0
  private viewer = new Vector3()
  private failed = false

  update(
    frame: XRFrame | undefined,
    camera: Pick<Object3D, 'getWorldPosition'>,
  ) {
    if (!frame || !this.referenceSpace) {
      if (this.cache.length) {
        this.cache = []
        this.publish(camera)
      }
      return
    }
    let changed = this.cache.length !== this.meshes.length + this.planes.length
    if (this.origin) this.origin.updateWorldMatrix(true, false)
    const currentOrigin = this.origin?.matrixWorld
    if (
      currentOrigin
        ? !this.originMatrix.equals(currentOrigin)
        : !this.originMatrix.equals(this.poseMatrix.identity())
    ) {
      if (currentOrigin) this.originMatrix.copy(currentOrigin)
      else this.originMatrix.identity()
      changed = true
    }
    // Array traversal avoids Map-entry tuples and synthetic source arrays in the steady frame path.
    for (
      let index = 0;
      index < this.meshes.length + this.planes.length;
      index++
    ) {
      const source =
        index < this.meshes.length
          ? this.meshes[index]
          : this.planes[index - this.meshes.length]
      let cached = this.cache[index]
      if (cached?.source !== source) {
        cached = { source, changed: -1, matrix: new Matrix4(), visible: false }
        this.cache[index] = cached
        changed = true
      }
      const pose = frame.getPose(
        'meshSpace' in source ? source.meshSpace : source.planeSpace,
        this.referenceSpace,
      )
      if (!pose) {
        if (cached.visible) changed = true
        cached.visible = false
        continue
      }
      this.poseMatrix
        .fromArray(pose.transform.matrix)
        .premultiply(this.originMatrix)
      let moved = false
      for (let i = 0; i < 16; i++)
        if (
          Math.abs(this.poseMatrix.elements[i] - cached.matrix.elements[i]) >
          1e-5
        ) {
          moved = true
          break
        }
      if (
        !cached.visible ||
        cached.changed !== source.lastChangedTime ||
        moved
      ) {
        cached.matrix.copy(this.poseMatrix)
        cached.changed = source.lastChangedTime
        cached.visible = true
        changed = true
      }
    }
    if (this.cache.length > this.meshes.length + this.planes.length)
      this.cache.length = this.meshes.length + this.planes.length
    if (changed) {
      try {
        this.publish(camera)
        this.failed = false
      } catch (error) {
        if (!this.failed)
          useButterflyStore
            .getState()
            .setError(
              `Room scan: ${error instanceof Error ? error.message : String(error)}`,
            )
        this.failed = true
      }
    }
  }

  private publish(camera: Pick<Object3D, 'getWorldPosition'>) {
    camera.getWorldPosition(this.viewer)
    const surfaces: RoomSurfaceData[] = []
    const bounds = new Box3()
    let floorPolygon: Vec3[] | null = null
    let floorY: number | null = null
    let floorArea = 0
    let hasCeiling = false
    for (let index = 0; index < this.cache.length; index++) {
      const cached = this.cache[index]
      if (!cached.visible) continue
      const source = cached.source
      const localBox = new Box3()
      const local: Vector3[] = []
      const triangles: number[] = []
      const label = source.semanticLabel ?? ''
      let closed = false
      if ('meshSpace' in source) {
        for (let i = 0; i < source.vertices.length; i += 3) {
          const point = new Vector3().fromArray(source.vertices, i)
          local.push(point)
          localBox.expandByPoint(point)
        }
        const edges = new Map<string, number>()
        const vertexKeys = local.map(
          (point) => `${point.x},${point.y},${point.z}`,
        )
        for (let i = 0; i < source.indices.length; i += 3) {
          const a = source.indices[i],
            b = source.indices[i + 1],
            c = source.indices[i + 2]
          if (!local[a] || !local[b] || !local[c]) continue
          for (const vertex of [a, b, c])
            triangles.push(
              ...pointTuple(local[vertex].clone().applyMatrix4(cached.matrix)),
            )
          for (const [x, y] of [
            [a, b],
            [b, c],
            [c, a],
          ]) {
            const key =
              vertexKeys[x] < vertexKeys[y]
                ? `${vertexKeys[x]}|${vertexKeys[y]}`
                : `${vertexKeys[y]}|${vertexKeys[x]}`
            edges.set(key, (edges.get(key) ?? 0) + 1)
          }
        }
        closed =
          edges.size > 0 &&
          Array.from(edges.values()).every((count) => count === 2)
      } else {
        for (const vertex of source.polygon) {
          const point = new Vector3(vertex.x, vertex.y, vertex.z)
          local.push(point)
          localBox.expandByPoint(point)
        }
        const contour = local.map((point) => new Vector2(point.x, point.z))
        for (const face of ShapeUtils.triangulateShape(contour, []))
          for (const vertex of face)
            triangles.push(
              ...pointTuple(local[vertex].clone().applyMatrix4(cached.matrix)),
            )
        const polygon = local.map((point) =>
          pointTuple(point.clone().applyMatrix4(cached.matrix)),
        )
        let area = 0
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++)
          area += polygon[j][0] * polygon[i][2] - polygon[i][0] * polygon[j][2]
        area = Math.abs(area / 2)
        const y =
          polygon.reduce((sum, point) => sum + point[1], 0) /
          Math.max(1, polygon.length)
        // Semantic floor is authoritative; unlabeled horizontal planes are not guessed to be floors/tables.
        if (label === 'floor' && area > floorArea) {
          floorArea = area
          floorPolygon = polygon
          floorY = y
        }
      }
      if (!triangles.length) continue
      if (label === 'ceiling') hasCeiling = true
      bounds.union(localBox.clone().applyMatrix4(cached.matrix))
      surfaces.push({
        id: `${'meshSpace' in source ? 'mesh' : 'plane'}-${index}`,
        kind: 'meshSpace' in source ? 'mesh' : 'plane',
        label,
        triangles: new Float32Array(triangles),
        closed,
        localBounds: {
          min: pointTuple(localBox.min),
          max: pointTuple(localBox.max),
        },
        worldMatrix: cached.matrix.toArray(),
      })
    }
    if (floorY !== null && !hasCeiling)
      bounds.max.y = Math.max(bounds.max.y, floorY + 2.2)
    const geometry: RoomGeometry = {
      revision: ++this.revision,
      status: !surfaces.length ? 'unscanned' : 'partial',
      floorY,
      floorPolygon,
      bounds: bounds.isEmpty()
        ? null
        : { min: pointTuple(bounds.min), max: pointTuple(bounds.max) },
      viewer: pointTuple(this.viewer),
      surfaces,
    }
    this.collider.setGeometry(geometry)
    geometry.status = !surfaces.length
      ? 'unscanned'
      : floorPolygon || this.collider.hasEnclosure
        ? 'scanned'
        : 'partial'
    useButterflyStore.getState().publishRoom(geometry)
  }
}

export function useRoomRepulsion() {
  const meshes = useXRMeshes()
  const planes = useXRPlanes()
  const referenceSpace = useXR((state) => state.originReferenceSpace)
  const origin = useXR((state) => state.origin)
  const cache = useRef<XRRoomCache | null>(null)
  if (!cache.current) cache.current = new XRRoomCache()
  cache.current.meshes = meshes
  cache.current.planes = planes
  cache.current.referenceSpace = referenceSpace
  cache.current.origin = origin
  return cache.current
}
