import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import { CatmullRomCurve3, Vector3 } from 'three'
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js'
import { activeAudioAnalysers } from '../audio/activeAudioAnalysers'
import { useButterflyStore } from '../state/useButterflyStore'
import { sampleCurlNoise } from './flightMath'
import { useRoomRepulsion } from './useRoomRepulsion'

/** One ECS frame owner: mutable coordinates, diffusion, constrained flight, transforms, wings. */
export function SwarmPhysicsSystem() {
  const room = useRoomRepulsion()
  const scratch = useMemo(() => {
    const points = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
    return {
      force: new Vector3(),
      difference: new Vector3(),
      desired: new Vector3(),
      safe: new Vector3(),
      viewer: new Vector3(),
      curl: new Vector3(),
      noise: new ImprovedNoise(),
      curve: new CatmullRomCurve3(points),
    }
  }, [])
  useFrame(({ clock, camera }, delta, frame) => {
    room.update(frame, camera)
    const state = useButterflyStore.getState()
    const entities = state.entities
    const dt = Math.min(0.033, delta)
    const time = clock.elapsedTime
    const { force, difference, desired, safe, viewer, curl, noise, curve } =
      scratch
    camera.getWorldPosition(viewer)
    // Geometry revisions may invalidate an old pose. Recover once per revision, never freeze invisibly.
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i]
      if (entity.roomRevision === room.collider.geometry.revision) continue
      entity.roomRevision = room.collider.geometry.revision
      entity.trackingBlocked = false
      if (!room.collider.isFree(entity.currentPos)) {
        if (room.collider.recoverPosition(entity.currentPos, safe)) {
          entity.currentPos.copy(safe)
          entity.diffusedPos.copy(safe)
          entity.perchPos.copy(safe)
          entity.pluckPos.copy(safe)
          entity.flightStart.copy(safe)
          entity.flightElapsed = 0
          state.setRoomError(
            'The updated room scan relocated a memory into observed free space.',
          )
        } else {
          entity.trackingBlocked = true
          state.setRoomError(
            'A memory is hidden because the room scan has no safe pose. Rescan the room or delete the memory.',
          )
        }
      }
      if (
        !entity.trackingBlocked &&
        !room.collider.isFree(entity.diffusedPos)
      ) {
        if (room.collider.recoverPosition(entity.diffusedPos, safe))
          entity.diffusedPos.copy(safe)
        else entity.diffusedPos.copy(entity.currentPos)
      }
    }
    // Two passes: all diffusion equilibria advance before any rendered position advances.
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i]
      const note = state.notes[entity.id]
      if (
        !note ||
        note.error ||
        entity.trackingBlocked ||
        (note.state !== 'HOVERING' && note.state !== 'TRANSIT')
      )
        continue
      force.subVectors(entity.pcaTarget, entity.diffusedPos).multiplyScalar(1.8)
      for (let j = 0; j < entities.length; j++) {
        if (i === j) continue
        const other = entities[j]
        difference.subVectors(entity.diffusedPos, other.diffusedPos)
        let distance = difference.lengthSq()
        if (distance < 1e-10) {
          // Physical symmetry breaking only; no invented semantic embedding.
          difference.set(Math.cos(entity.phase), 0.3, Math.sin(entity.phase))
          distance = 0.01
        }
        if (distance < 1)
          force.addScaledVector(
            difference,
            0.025 / ((distance + 0.04) * Math.sqrt(distance + 0.04)),
          )
      }
      room.collider.addWallRepulsionForce(entity.diffusedPos, force)
      force.clampLength(0, 1)
      // Sum of independent uniforms approximates zero-mean unit Gaussian Brownian increments.
      const noise = Math.sqrt(2 * 0.001 * dt)
      desired.copy(entity.diffusedPos).addScaledVector(force, dt)
      desired.x +=
        (Math.random() + Math.random() + Math.random() - 1.5) * 2 * noise
      desired.y +=
        (Math.random() + Math.random() + Math.random() - 1.5) * 2 * noise
      desired.z +=
        (Math.random() + Math.random() + Math.random() - 1.5) * 2 * noise
      room.collider.constrainMovement(entity.diffusedPos, desired, safe)
      entity.diffusedPos.copy(safe)
    }
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i]
      const analyser = activeAudioAnalysers.get(entity.id)
      if (analyser) entity.rms = analyser.getAverageFrequency() / 255
      const note = state.notes[entity.id]
      if (!note) continue
      if (entity.object) entity.object.visible = !entity.trackingBlocked
      if (entity.trackingBlocked) continue
      if (note.error) desired.copy(entity.currentPos)
      else if (note.state === 'RECORDING') desired.copy(entity.perchPos)
      else if (note.state === 'TRANSCRIBING') {
        desired.copy(entity.perchPos)
        desired.x += Math.sin(time * 2.5 + entity.phase) * 0.12
        desired.y += 0.1 + Math.sin(time * 5 + entity.phase) * 0.045
        desired.z += Math.cos(time * 2.5 + entity.phase) * 0.045
      } else if (note.state === 'PLUCKED') desired.copy(entity.pluckPos)
      else if (note.state === 'TRANSIT') {
        entity.flightElapsed += dt
        const u = Math.min(1, entity.flightElapsed / entity.flightDuration)
        curve.points[0].copy(entity.flightStart)
        curve.points[1].lerpVectors(
          entity.flightStart,
          entity.diffusedPos,
          1 / 3,
        )
        curve.points[1].y += 0.25
        curve.points[2].lerpVectors(
          entity.flightStart,
          entity.diffusedPos,
          2 / 3,
        )
        curve.points[2].y += 0.18
        curve.points[3].copy(entity.diffusedPos)
        curve.getPoint(u, desired)
        sampleCurlNoise(noise, desired, time + entity.phase, curl).clampLength(
          0,
          1,
        )
        desired.addScaledVector(curl, 0.045 * Math.sin(Math.PI * u))
        if (
          u === 1 &&
          entity.currentPos.distanceToSquared(entity.diffusedPos) < 0.025
        )
          state.markHovered(entity.id)
      } else {
        desired.copy(entity.diffusedPos)
        desired.x += Math.sin(time * 3.1 + entity.phase) * 0.035
        desired.y += Math.cos(time * 5.4 + entity.phase) * 0.045
        desired.z += Math.sin(time * 2.7 + entity.phase) * 0.035
        sampleCurlNoise(noise, desired, time + entity.phase, curl).clampLength(
          0,
          1,
        )
        desired.addScaledVector(curl, 0.025)
      }
      // Bound catch-up after a moved manifold/hand and constrain the final fluttered path as a swept sphere.
      difference
        .subVectors(desired, entity.currentPos)
        .clampLength(
          0,
          dt *
            (note.state === 'PLUCKED' || note.state === 'RECORDING' ? 2 : 0.8),
        )
      desired.copy(entity.currentPos).add(difference)
      room.collider.constrainMovement(entity.currentPos, desired, safe)
      entity.velocity
        .subVectors(safe, entity.currentPos)
        .divideScalar(Math.max(1e-6, dt))
      entity.currentPos.copy(safe)
      if (entity.object) {
        entity.object.position.copy(entity.currentPos)
        if (note.state === 'PLUCKED')
          entity.object.lookAt(viewer.x, entity.currentPos.y, viewer.z)
        else if (entity.velocity.lengthSq() > 0.001)
          entity.object.rotation.y = Math.atan2(
            entity.velocity.x,
            entity.velocity.z,
          )
      }
      const perched = note.state === 'RECORDING' || note.state === 'PLUCKED'
      const angle =
        Math.sin(time * (perched ? 5 + entity.rms * 12 : 20) + entity.phase) *
        (0.65 + entity.rms * 0.3)
      if (entity.leftWing) entity.leftWing.rotation.y = angle
      if (entity.rightWing) entity.rightWing.rotation.y = -angle
      if (entity.leftMaterial)
        entity.leftMaterial.emissiveIntensity = 0.25 + entity.rms * 1.4
      if (entity.rightMaterial)
        entity.rightMaterial.emissiveIntensity = 0.25 + entity.rms * 1.4
    }
  })
  return null
}
