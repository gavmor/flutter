import { Box3, Matrix4, Ray, Triangle, Vector3 } from 'three'
import { OBB } from 'three/addons/math/OBB.js'
import type { RoomGeometry, RoomSurfaceData, Vec3 } from '../protocol'

const BUTTERFLY_RADIUS = 0.075
interface Surface {
  data: RoomSurfaceData
  triangles: Triangle[]
  bounds: Box3
  obb: OBB
  containsViewer: boolean
  hits: Float64Array
}

/** Cached exact triangles, not solid mesh bounding boxes. Scratch storage is reused by every query. */
export class RoomCollider {
  geometry: RoomGeometry = {
    revision: 0,
    status: 'unscanned',
    floorY: null,
    floorPolygon: null,
    bounds: null,
    viewer: [0, 0, 0],
    surfaces: [],
  }
  private surfaces: Surface[] = []
  private closest = new Vector3()
  private normal = new Vector3()
  private sample = new Vector3()
  private delta = new Vector3()
  private hit = new Vector3()
  private sweepBox = new Box3()
  private ray = new Ray(
    new Vector3(),
    new Vector3(0.932171, 0.271361, 0.239713).normalize(),
  )
  private identity = new Matrix4()
  hasEnclosure = false
  private collisionNormal = new Vector3()
  private recoveryCandidate = new Vector3()

  setGeometry(geometry: RoomGeometry) {
    this.geometry = geometry
    this.surfaces = geometry.surfaces.map((data) => {
      const triangles: Triangle[] = []
      const bounds = new Box3()
      for (let i = 0; i < data.triangles.length; i += 9) {
        const a = new Vector3().fromArray(data.triangles, i)
        const b = new Vector3().fromArray(data.triangles, i + 3)
        const c = new Vector3().fromArray(data.triangles, i + 6)
        if (new Triangle(a, b, c).getArea() <= 1e-12) continue
        triangles.push(new Triangle(a, b, c))
        bounds.expandByPoint(a).expandByPoint(b).expandByPoint(c)
      }
      const matrix = data.worldMatrix
        ? new Matrix4().fromArray(data.worldMatrix)
        : this.identity
      const obb = new OBB()
        .fromBox3(
          data.localBounds
            ? new Box3(
                new Vector3(...data.localBounds.min),
                new Vector3(...data.localBounds.max),
              )
            : bounds,
        )
        .applyMatrix4(matrix)
      return {
        data,
        triangles,
        bounds,
        obb,
        containsViewer: false,
        hits: new Float64Array(triangles.length),
      }
    })
    this.sample.fromArray(geometry.viewer)
    for (const surface of this.surfaces)
      surface.containsViewer =
        surface.data.closed && this.insideMesh(this.sample, surface)
    this.hasEnclosure = this.surfaces.some((surface) => surface.containsViewer)
  }

  private insideMesh(position: Vector3, surface: Surface): boolean {
    if (!surface.bounds.containsPoint(position)) return false
    this.ray.origin.copy(position)
    let crossings = 0
    // De-duplicate all ray distances, including non-adjacent shared edges.
    for (const triangle of surface.triangles)
      if (
        this.ray.intersectTriangle(
          triangle.a,
          triangle.b,
          triangle.c,
          false,
          this.hit,
        )
      ) {
        const distance = this.hit.distanceToSquared(position)
        let duplicate = false
        for (let i = 0; i < crossings; i++)
          if (Math.abs(distance - surface.hits[i]) < 1e-9) {
            duplicate = true
            break
          }
        if (distance > 1e-12 && !duplicate) {
          surface.hits[crossings] = distance
          crossings++
        }
      }
    return crossings % 2 === 1
  }

  private insideFloor(position: Vector3): boolean {
    const polygon = this.geometry.floorPolygon
    if (!polygon) return true
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i],
        b = polygon[j]
      if (
        a[2] > position.z !== b[2] > position.z &&
        position.x <
          ((b[0] - a[0]) * (position.z - a[2])) / (b[2] - a[2]) + a[0]
      )
        inside = !inside
    }
    return inside
  }

  private setFloorEdgeOffset(position: Vector3, a: Vec3, b: Vec3) {
    const dx = b[0] - a[0],
      dz = b[2] - a[2]
    const t = Math.max(
      0,
      Math.min(
        1,
        ((position.x - a[0]) * dx + (position.z - a[2]) * dz) /
          Math.max(1e-15, dx * dx + dz * dz),
      ),
    )
    this.normal.set(position.x - a[0] - t * dx, 0, position.z - a[2] - t * dz)
  }

  private floorClearance(position: Vector3): number {
    const polygon = this.geometry.floorPolygon
    if (!polygon) return Infinity
    let distance = Infinity
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      this.setFloorEdgeOffset(position, polygon[i], polygon[j])
      distance = Math.min(distance, this.normal.length())
    }
    return distance
  }

  isFree(position: Vector3, radius = BUTTERFLY_RADIUS): boolean {
    if (!this.insideFloor(position)) return false
    if (this.floorClearance(position) < radius) return false
    if (
      this.geometry.floorY !== null &&
      position.y < this.geometry.floorY + radius
    )
      return false
    for (const surface of this.surfaces) {
      if (
        surface.data.closed &&
        this.insideMesh(position, surface) !== surface.containsViewer
      )
        return false
      surface.obb.clampPoint(position, this.closest)
      if (this.closest.distanceToSquared(position) > radius * radius) continue
      for (const triangle of surface.triangles) {
        triangle.closestPointToPoint(position, this.closest)
        if (this.closest.distanceToSquared(position) < radius * radius)
          return false
      }
    }
    return true
  }

  addWallRepulsionForce(
    position: Vector3,
    out: Vector3,
    margin = 0.35,
    strength = 1.8,
  ) {
    for (const surface of this.surfaces) {
      surface.obb.clampPoint(position, this.closest)
      if (position.distanceToSquared(this.closest) > margin * margin) continue
      let nearest = Infinity
      for (const triangle of surface.triangles) {
        triangle.closestPointToPoint(position, this.closest)
        const distance = this.closest.distanceToSquared(position)
        if (distance < nearest) {
          nearest = distance
          this.normal.subVectors(position, this.closest)
        }
      }
      if (nearest > 1e-12 && nearest < margin * margin) {
        const distance = Math.sqrt(nearest)
        const penetration = 1 - distance / margin
        out.addScaledVector(
          this.normal,
          (strength * penetration * Math.exp(2.5 * penetration)) / distance,
        )
      }
    }
  }

  /** Finds a valid recovery after newly observed geometry invalidates an old pose.
   * This is an explicit scan-correction relocation, never an unconstrained flight segment.
   */
  recoverPosition(
    position: Vector3,
    out: Vector3,
    radius = BUTTERFLY_RADIUS,
  ): boolean {
    if (this.isFree(position, radius)) {
      out.copy(position)
      return true
    }
    let nearest = Infinity
    for (let ring = 1; ring <= 8; ring++)
      for (let x = -1; x <= 1; x++)
        for (let y = -1; y <= 1; y++)
          for (let z = -1; z <= 1; z++) {
            if (!x && !y && !z) continue
            this.recoveryCandidate
              .copy(position)
              .addScaledVector(this.normal.set(x, y, z), ring * 0.12)
            const distance = this.recoveryCandidate.distanceToSquared(position)
            if (
              distance < nearest &&
              this.isFree(this.recoveryCandidate, radius + 0.01)
            ) {
              nearest = distance
              out.copy(this.recoveryCandidate)
            }
          }
    const bounds = this.geometry.bounds
    if (!Number.isFinite(nearest) && bounds) {
      for (let x = 0; x < 16; x++)
        for (let y = 0; y < 8; y++)
          for (let z = 0; z < 16; z++) {
            this.recoveryCandidate.set(
              bounds.min[0] +
                ((x + 0.5) / 16) * (bounds.max[0] - bounds.min[0]),
              bounds.min[1] + ((y + 0.5) / 8) * (bounds.max[1] - bounds.min[1]),
              bounds.min[2] +
                ((z + 0.5) / 16) * (bounds.max[2] - bounds.min[2]),
            )
            const distance = this.recoveryCandidate.distanceToSquared(position)
            if (
              distance < nearest &&
              this.isFree(this.recoveryCandidate, radius + 0.01)
            ) {
              nearest = distance
              out.copy(this.recoveryCandidate)
            }
          }
    }
    return Number.isFinite(nearest)
  }
  private retainNearestBlockingContact(
    radius: number,
    minimum: number,
  ): number {
    const clearance = this.normal.length() - radius
    this.normal.normalize()
    if (clearance <= 2e-5 && this.delta.dot(this.normal) >= -1e-10)
      return minimum
    if (clearance < minimum) {
      this.collisionNormal.copy(this.normal)
      return clearance
    }
    return minimum
  }

  private movementClearance(position: Vector3, radius: number): number {
    let minimum = Infinity
    const polygon = this.geometry.floorPolygon
    if (polygon)
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        this.setFloorEdgeOffset(position, polygon[i], polygon[j])
        minimum = this.retainNearestBlockingContact(radius, minimum)
      }
    if (this.geometry.floorY !== null) {
      const clearance = position.y - this.geometry.floorY - radius
      if ((clearance > 2e-5 || this.delta.y < -1e-10) && clearance < minimum) {
        minimum = clearance
        this.collisionNormal.set(0, 1, 0)
      }
    }
    for (const surface of this.surfaces) {
      if (!surface.obb.intersectsBox3(this.sweepBox)) continue
      for (const triangle of surface.triangles) {
        triangle.closestPointToPoint(position, this.closest)
        this.normal.subVectors(position, this.closest)
        minimum = this.retainNearestBlockingContact(radius, minimum)
      }
    }
    return minimum
  }

  /** Conservative swept sphere plus contact-plane sliding; every final flutter/flight is constrained. */
  constrainMovement(
    from: Vector3,
    desired: Vector3,
    out: Vector3,
    radius = BUTTERFLY_RADIUS,
  ): boolean {
    this.delta.subVectors(desired, from)
    let slid = false
    for (let attempt = 0; attempt < 4; attempt++) {
      const length = this.delta.length()
      if (length < 1e-9) {
        out.copy(from)
        return !slid
      }
      this.hit.copy(from).add(this.delta)
      this.sweepBox
        .makeEmpty()
        .expandByPoint(from)
        .expandByPoint(this.hit)
        .expandByScalar(radius)
      let fraction = 0
      for (let step = 0; step < 64 && fraction < 1; step++) {
        this.sample.copy(from).addScaledVector(this.delta, fraction)
        const clearance = this.movementClearance(this.sample, radius)
        if (clearance <= 2e-5) break
        fraction = Math.min(
          1,
          fraction + Math.max(0, clearance - 1e-5) / length,
        )
      }
      if (fraction === 0 && this.delta.dot(this.collisionNormal) < 0) {
        this.delta.projectOnPlane(this.collisionNormal)
        slid = true
        continue
      }
      out.copy(from).addScaledVector(this.delta, fraction)
      if (!this.isFree(out, radius * 0.999)) {
        out.copy(from)
        return false
      }
      return fraction >= 1 && !slid
    }
    out.copy(from)
    return false
  }
}

export function pointTuple(point: Vector3): Vec3 {
  return [point.x, point.y, point.z]
}
