import { useFrame, useThree } from '@react-three/fiber'
import { useXRInputSourceStates } from '@react-three/xr'
import { useCallback, useRef } from 'react'
import * as THREE from 'three'
import { isXRUIHovered } from './XRUIInteractionBoundary.js'

interface GestureCallbacks {
  onSummonStart: (position: THREE.Vector3, sourceId: string) => void
  onSummonMove?: (position: THREE.Vector3, sourceId: string) => void
  onRecordStart: (sourceId: string) => void
  onPinchMove?: (position: THREE.Vector3, sourceId: string) => void
  onSummonEnd: (sourceId: string) => void
  onPinchStart?: (position: THREE.Vector3, sourceId: string) => boolean
}

const JOINTS = {
  wrist: 'wrist',
  indexTip: 'index-finger-tip',
  indexBase: 'index-finger-metacarpal',
  pinkyBase: 'pinky-finger-metacarpal',
  thumbTip: 'thumb-tip',
} as const

function readJoint(
  frame: XRFrame,
  hand: XRHand,
  jointName: string,
  referenceSpace: XRReferenceSpace,
  target: THREE.Vector3,
) {
  const joint = hand.get(jointName as XRHandJoint)
  if (!joint || !frame.getJointPose) return false
  const pose = frame.getJointPose(joint, referenceSpace)
  if (!pose) return false
  target.set(
    pose.transform.position.x,
    pose.transform.position.y,
    pose.transform.position.z,
  )
  return true
}

/** Emits gesture edges only; recording and pluck state remain in the orchestration plane. */
export function useHandSummonGesture({
  onSummonStart,
  onSummonMove,
  onRecordStart,
  onPinchMove,
  onSummonEnd,
  onPinchStart,
}: GestureCallbacks) {
  const states = useXRInputSourceStates()
  const { gl } = useThree()
  const activeSummons = useRef(new Set<string>())
  const recordingHolds = useRef(new Set<string>())
  const activePinches = useRef(new Set<string>())
  const consumedPinches = useRef(new Set<string>())
  const uiOwnedGestures = useRef(new Set<string>())
  const seen = useRef(new Set<string>())
  const candidateSince = useRef(new Map<string, number>())
  const wrist = useRef(new THREE.Vector3())
  const indexTip = useRef(new THREE.Vector3())
  const indexBase = useRef(new THREE.Vector3())
  const pinkyBase = useRef(new THREE.Vector3())
  const thumbTip = useRef(new THREE.Vector3())
  const palmA = useRef(new THREE.Vector3())
  const palmB = useRef(new THREE.Vector3())
  const palmNormal = useRef(new THREE.Vector3())
  const controllerPosition = useRef(new THREE.Vector3())
  const originMatrix = useRef(new THREE.Matrix4())
  const inspect = useCallback(
    (frame: XRFrame | undefined) => {
      const referenceSpace = gl.xr.getReferenceSpace()
      if (!frame || !referenceSpace) return
      const now = frame.predictedDisplayTime || performance.now()
      const present = seen.current
      present.clear()
      for (const state of states) {
        const source = state.inputSource
        const id = state.id ?? source.handedness
        present.add(id)
        let position: THREE.Vector3
        let candidate = false
        let pinch = false
        if (state.type === 'hand' && source.hand) {
          const hand = source.hand
          const enough =
            readJoint(
              frame,
              hand,
              JOINTS.wrist,
              referenceSpace,
              wrist.current,
            ) &&
            readJoint(
              frame,
              hand,
              JOINTS.indexTip,
              referenceSpace,
              indexTip.current,
            ) &&
            readJoint(
              frame,
              hand,
              JOINTS.indexBase,
              referenceSpace,
              indexBase.current,
            ) &&
            readJoint(
              frame,
              hand,
              JOINTS.pinkyBase,
              referenceSpace,
              pinkyBase.current,
            ) &&
            readJoint(
              frame,
              hand,
              JOINTS.thumbTip,
              referenceSpace,
              thumbTip.current,
            )
          if (!enough) continue
          const origin = gl.xr.getCamera().parent
          if (origin) originMatrix.current.copy(origin.matrixWorld)
          else originMatrix.current.identity()
          wrist.current.applyMatrix4(originMatrix.current)
          indexTip.current.applyMatrix4(originMatrix.current)
          indexBase.current.applyMatrix4(originMatrix.current)
          pinkyBase.current.applyMatrix4(originMatrix.current)
          thumbTip.current.applyMatrix4(originMatrix.current)
          position = indexTip.current
          palmA.current.subVectors(indexBase.current, wrist.current)
          palmB.current.subVectors(pinkyBase.current, wrist.current)
          palmNormal.current
            .crossVectors(palmA.current, palmB.current)
            .normalize()
          if (source.handedness === 'left') palmNormal.current.negate()
          const palmUp = palmNormal.current.y > 0.32
          pinch = indexTip.current.distanceTo(thumbTip.current) < 0.055
          candidate = palmUp || pinch
        } else if (state.type === 'controller') {
          if (!state.object) continue
          state.object.getWorldPosition(controllerPosition.current)
          position = controllerPosition.current
          const trigger =
            state.gamepad?.['xr-standard-trigger']?.state === 'pressed'
          const squeeze =
            state.gamepad?.['xr-standard-squeeze']?.state === 'pressed'
          candidate = trigger || squeeze
          pinch = trigger || squeeze
        } else continue

        if (!candidate && !pinch) uiOwnedGestures.current.delete(id)
        if (
          isXRUIHovered(source) &&
          !activeSummons.current.has(id) &&
          !consumedPinches.current.has(id) &&
          (candidate || pinch)
        ) {
          uiOwnedGestures.current.add(id)
        }
        if (uiOwnedGestures.current.has(id)) {
          candidateSince.current.delete(id)
          continue
        }

        if (pinch && !activePinches.current.has(id)) {
          activePinches.current.add(id)
          if (onPinchStart?.(position.clone(), id) === true)
            consumedPinches.current.add(id)
        } else if (pinch && consumedPinches.current.has(id)) {
          onPinchMove?.(position, id)
        } else if (!pinch) {
          activePinches.current.delete(id)
          consumedPinches.current.delete(id)
        }
        const pinchConsumed = consumedPinches.current.has(id)
        if (candidate && !pinchConsumed) {
          let since = candidateSince.current.get(id)
          if (since == null) {
            since = now
            candidateSince.current.set(id, since)
            activeSummons.current.add(id)
            onSummonStart(position.clone(), id)
          } else onSummonMove?.(position, id)
          if (now - since >= 160 && !recordingHolds.current.has(id)) {
            recordingHolds.current.add(id)
            onRecordStart(id)
          }
        } else {
          candidateSince.current.delete(id)
          recordingHolds.current.delete(id)
          if (activeSummons.current.delete(id)) onSummonEnd(id)
        }
      }
      for (const id of uiOwnedGestures.current) {
        if (!present.has(id)) uiOwnedGestures.current.delete(id)
      }
      for (const id of activeSummons.current) {
        if (!present.has(id)) {
          activeSummons.current.delete(id)
          recordingHolds.current.delete(id)
          candidateSince.current.delete(id)
          onSummonEnd(id)
        }
      }
      for (const id of activePinches.current) {
        if (!present.has(id)) {
          activePinches.current.delete(id)
          consumedPinches.current.delete(id)
        }
      }
    },
    [
      gl,
      onPinchMove,
      onPinchStart,
      onRecordStart,
      onSummonEnd,
      onSummonMove,
      onSummonStart,
      states,
    ],
  )

  useFrame((_state, _delta, frame) => inspect(frame))
}
