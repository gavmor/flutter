import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type {
  ButterflyKinematics,
  ButterflyMetadata,
} from '../state/useButterflyStore.js'

interface SemanticFilamentsProps {
  notes: Record<string, ButterflyMetadata>
  kinematics: Map<string, ButterflyKinematics>
  focusedIds: Set<string>
}

interface FilamentProps {
  from: ButterflyKinematics
  to: ButterflyKinematics
  color: THREE.Color
}
function Filament({ from, to, color }: FilamentProps) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(21)
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return result
  }, [])
  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    [color],
  )
  const line = useMemo(
    () => new THREE.Line(geometry, material),
    [geometry, material],
  )
  const control = useMemo(() => new THREE.Vector3(), [])
  const curve = useMemo(
    () =>
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3(),
      ),
    [],
  )
  const sample = useMemo(() => new THREE.Vector3(), [])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  useFrame(() => {
    const attribute = geometry.getAttribute('position') as THREE.BufferAttribute
    const a = from.currentPos
    const b = to.currentPos
    control.addVectors(a, b).multiplyScalar(0.5)
    control.y += 0.07 + Math.min(0.2, a.distanceTo(b) * 0.08)
    curve.v0.copy(a)
    curve.v1.copy(control)
    curve.v2.copy(b)
    for (let index = 0; index < 7; index += 1) {
      curve.getPoint(index / 6, sample)
      attribute.setXYZ(index, sample.x, sample.y, sample.z)
    }
    attribute.needsUpdate = true
  })

  return <primitive object={line} />
}
export function SemanticFilaments({
  notes,
  kinematics,
  focusedIds,
}: SemanticFilamentsProps) {
  const visible = Object.values(notes).filter(
    (note) => focusedIds.has(note.id) || note.state === 'PLUCKED',
  )
  return (
    <group>
      {visible.flatMap((note) =>
        note.neighbors.slice(0, 3).map((neighborId) => {
          const target = notes[neighborId]
          const from = kinematics.get(note.id)
          const to = kinematics.get(neighborId)
          if (
            !target ||
            !from ||
            !to ||
            (focusedIds.has(note.id) &&
              focusedIds.has(neighborId) &&
              note.id > neighborId)
          )
            return null
          const [h, s, l] = note.semanticColorHSL
          return (
            <Filament
              key={`${note.id}:${neighborId}`}
              from={from}
              to={to}
              color={new THREE.Color().setHSL(h, s, Math.min(0.8, l + 0.1))}
            />
          )
        }),
      )}
    </group>
  )
}
