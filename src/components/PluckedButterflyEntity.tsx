import { Container, Text } from '@react-three/uikit'
import { useXR } from '@react-three/xr'
import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { activeAudioAnalysers } from '../audio/activeAudioAnalysers.js'
import {
  resumeXRAudio,
  useXRAudioListener,
} from '../audio/XRAudioListenerProvider.js'
import type { ButterflyMetadata } from '../state/useButterflyStore.js'

interface PluckedButterflyEntityProps {
  note: ButterflyMetadata
  registerVisual: (
    id: string,
    object: THREE.Object3D,
    leftWing: THREE.Object3D,
    rightWing: THREE.Object3D,
  ) => () => void
  onTogglePluck: (id: string, handPosition?: THREE.Vector3) => void
  onDelete: (id: string) => void
  onAudioError?: (id: string, message: string) => void
  onFocus?: (id: string) => void
  onFocusOut?: (id: string) => void
  ambientMuted?: boolean
}

function ButterflyWing({
  side,
  color,
  wingRef,
}: {
  side: -1 | 1
  color: THREE.Color
  wingRef: RefObject<THREE.Mesh | null>
}) {
  return (
    <mesh
      ref={wingRef}
      position={[side * 0.045, 0, 0]}
      rotation={[0, -side * 0.18, side * 0.15]}
    >
      <planeGeometry args={[0.11, 0.16]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.55}
        transparent
        opacity={0.9}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

export function PluckedButterflyEntity({
  note,
  registerVisual,
  onTogglePluck,
  onDelete,
  onAudioError,
  onFocus,
  onFocusOut,
  ambientMuted = false,
}: PluckedButterflyEntityProps) {
  const groupRef = useRef<THREE.Group>(null)
  const leftWingRef = useRef<THREE.Mesh>(null)
  const rightWingRef = useRef<THREE.Mesh>(null)
  const listener = useXRAudioListener()
  const session = useXR((state) => state.session)
  const soundRef = useRef<THREE.PositionalAudio | null>(null)
  const desiredPlayingRef = useRef(false)

  const wingColor = useMemo(() => {
    const [h, s, l] = note.semanticColorHSL
    return new THREE.Color().setHSL(
      h,
      s,
      Math.min(0.78, l + (note.state === 'PLUCKED' ? 0.12 : 0)),
    )
  }, [note.semanticColorHSL, note.state])

  useEffect(() => {
    if (!groupRef.current || !leftWingRef.current || !rightWingRef.current)
      return
    return registerVisual(
      note.id,
      groupRef.current as unknown as THREE.Object3D,
      leftWingRef.current as unknown as THREE.Object3D,
      rightWingRef.current as unknown as THREE.Object3D,
    )
  }, [note.id, registerVisual])

  const playVoiceMemo = useCallback(
    async (sound: THREE.PositionalAudio) => {
      try {
        await resumeXRAudio(listener)
      } catch (cause) {
        onAudioError?.(
          note.id,
          cause instanceof Error ? cause.message : 'Audio could not resume.',
        )
        return
      }
      if (
        soundRef.current !== sound ||
        !desiredPlayingRef.current ||
        sound.isPlaying
      )
        return
      try {
        sound.play()
      } catch (cause) {
        onAudioError?.(
          note.id,
          cause instanceof Error
            ? cause.message
            : 'Voice memo playback failed.',
        )
      }
    },
    [listener, note.id, onAudioError],
  )

  const replayVoiceMemo = () => {
    const sound = soundRef.current
    if (!sound?.buffer) return
    if (sound.isPlaying) sound.stop()
    void playVoiceMemo(sound)
  }

  useEffect(() => {
    const group = groupRef.current
    if (!listener || !group || !note.audioUrl) return
    const sound = new THREE.PositionalAudio(listener)
    const panner = sound.getOutput()
    panner.panningModel = 'HRTF'
    panner.distanceModel = 'inverse'
    sound.setRefDistance(0.25)
    sound.setRolloffFactor(2.2)
    sound.setMaxDistance(6)
    sound.setDirectionalCone(160, 260, 0.35)
    soundRef.current = sound
    group.add(sound)
    let cancelled = false
    const loader = new THREE.AudioLoader()
    loader.load(
      note.audioUrl,
      (buffer) => {
        if (cancelled) return
        sound.setBuffer(buffer)
        activeAudioAnalysers.set(note.id, new THREE.AudioAnalyser(sound, 32))
        void playVoiceMemo(sound)
      },
      undefined,
      () => onAudioError?.(note.id, 'Voice memo could not be decoded.'),
    )
    return () => {
      cancelled = true
      if (sound.isPlaying) sound.stop()
      activeAudioAnalysers.delete(note.id)
      sound.disconnect()
      group.remove(sound)
      soundRef.current = null
    }
  }, [listener, note.audioUrl, note.id, onAudioError, playVoiceMemo])

  useEffect(() => {
    const sound = soundRef.current
    desiredPlayingRef.current = note.state === 'PLUCKED'
    if (!sound?.buffer) return
    if (desiredPlayingRef.current) {
      void playVoiceMemo(sound)
    } else if (sound.isPlaying) {
      sound.stop()
    }
  }, [note.state, playVoiceMemo])

  useEffect(() => {
    const group = groupRef.current
    if (!listener || !group) return
    const context = listener.context
    const sound = new THREE.PositionalAudio(listener)
    sound.getOutput().panningModel = 'HRTF'
    sound.setRefDistance(0.45)
    sound.setRolloffFactor(1.8)
    sound.setVolume(0.045)
    const sampleRate = context.sampleRate
    const length = Math.floor(sampleRate * 0.42)
    const buffer = context.createBuffer(1, length, sampleRate)
    const data = buffer.getChannelData(0)
    const pitch = [261.63, 293.66, 329.63, 392, 440][
      Math.abs(Math.round(note.semanticColorHSL[0] * 12)) % 5
    ]
    for (let index = 0; index < length; index += 1) {
      const time = index / sampleRate
      data[index] = Math.sin(time * pitch * Math.PI * 2) * Math.exp(-time * 9)
    }
    sound.setBuffer(buffer)
    group.add(sound)
    const timer = window.setInterval(
      () => {
        if (ambientMuted || context.state !== 'running' || sound.isPlaying)
          return
        void resumeXRAudio(listener)
          .then(() => {
            if (!ambientMuted && !sound.isPlaying) sound.play()
          })
          .catch((cause) =>
            onAudioError?.(
              note.id,
              cause instanceof Error
                ? cause.message
                : 'Ambient chime could not resume.',
            ),
          )
      },
      4300 + (Math.abs(note.id.length * 37) % 1200),
    )
    return () => {
      window.clearInterval(timer)
      if (sound.isPlaying) sound.stop()
      sound.disconnect()
      group.remove(sound)
    }
  }, [ambientMuted, listener, note.id, note.semanticColorHSL, onAudioError])

  const pointerDown = (event: {
    stopPropagation: () => void
    point: THREE.Vector3
  }) => {
    event.stopPropagation()
    if (!session) onTogglePluck(note.id, event.point)
  }
  const showCard = note.state === 'PLUCKED' || note.error != null

  return (
    <group
      ref={groupRef}
      onPointerDown={pointerDown}
      onPointerOver={() => onFocus?.(note.id)}
      onPointerOut={() => onFocusOut?.(note.id)}
    >
      <ButterflyWing side={-1} color={wingColor} wingRef={leftWingRef} />
      <ButterflyWing side={1} color={wingColor} wingRef={rightWingRef} />
      <mesh scale={0.028}>
        <sphereGeometry args={[1, 12, 8]} />
        <meshStandardMaterial
          color="#f8fafc"
          emissive={wingColor}
          emissiveIntensity={0.9}
        />
      </mesh>
      {showCard && (
        <group
          position={[0, 0.2, 0]}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Container
            pixelSize={0.0018}
            flexDirection="column"
            width={240}
            padding={12}
            gap={8}
            borderRadius={8}
            backgroundColor="rgba(16,24,39,0.94)"
            borderWidth={1.5}
            borderColor={wingColor}
          >
            <Text fontSize={14} color="#f8fafc" maxWidth={220}>
              {note.text || 'No transcription yet.'}
            </Text>
            {note.error && (
              <Text fontSize={10} color="#fb7185">
                {note.error}
              </Text>
            )}
            <Container flexDirection="row" gap={6} marginTop={8}>
              {!note.error && (
                <Container
                  paddingX={8}
                  paddingY={5}
                  borderRadius={5}
                  backgroundColor="#1d4ed8"
                  onClick={replayVoiceMemo}
                >
                  <Text fontSize={10} color="#eff6ff">
                    Replay
                  </Text>
                </Container>
              )}
              {!note.error && (
                <Container
                  paddingX={8}
                  paddingY={5}
                  borderRadius={5}
                  backgroundColor="#334155"
                  onClick={() => onTogglePluck(note.id)}
                >
                  <Text fontSize={10} color="#f8fafc">
                    Release
                  </Text>
                </Container>
              )}
              <Container
                paddingX={8}
                paddingY={5}
                borderRadius={5}
                backgroundColor="#7f1d1d"
                onClick={() => onDelete(note.id)}
              >
                <Text fontSize={10} color="#fee2e2">
                  Delete
                </Text>
              </Container>
            </Container>
          </Container>
        </group>
      )}
    </group>
  )
}
