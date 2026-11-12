import { Canvas } from '@react-three/fiber'
import { Container, Text } from '@react-three/uikit'
import { createXRStore, useXR, XR } from '@react-three/xr'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  type ButterflyRecorder,
  useButterflyRecorder,
} from './audio/useButterflyRecorder.js'
import { XRAudioListenerProvider } from './audio/XRAudioListenerProvider.js'
import { PluckedButterflyEntity } from './components/PluckedButterflyEntity.js'
import { SemanticFilaments } from './components/SemanticFilaments.js'
import { useButterflyStore } from './state/useButterflyStore.js'
import { SwarmPhysicsSystem } from './xr-systems/SwarmPhysicsSystem.js'
import { useHandSummonGesture } from './xr-systems/useHandSummonGesture.js'
import './app.css'

const xrStore = createXRStore({
  domOverlay: true,
  handTracking: true,
  meshDetection: true,
  planeDetection: true,
  hitTest: true,
})

function findNearestButterfly(
  position: THREE.Vector3,
  maxDistance: number,
  heldOnly: boolean,
) {
  const { entities, notes } = useButterflyStore.getState()
  let nearest: string | null = null
  for (let index = 0; index < entities.length; index++) {
    const entity = entities[index]
    const note = notes[entity.id]
    if (!note) continue
    if (
      heldOnly
        ? note.state !== 'PLUCKED'
        : note.state === 'RECORDING' || note.state === 'TRANSCRIBING'
    )
      continue
    const distance = entity.currentPos.distanceTo(position)
    if (distance < maxDistance) {
      nearest = entity.id
      maxDistance = distance
    }
  }
  return nearest
}

function Experience({
  recorder,
  ambientMuted,
  onMute,
}: {
  recorder: ButterflyRecorder
  ambientMuted: boolean
  onMute: () => void
}) {
  const notes = useButterflyStore((state) => state.notes)
  const workerStatus = useButterflyStore((state) => state.workerStatus)
  const roomStatus = useButterflyStore((state) => state.roomStatus)
  const kinematics = useButterflyStore.getState().kinematics
  const spawnRecordingButterfly = useButterflyStore(
    (state) => state.spawnRecordingButterfly,
  )
  const submitAudioToWorker = useButterflyStore(
    (state) => state.submitAudioToWorker,
  )
  const togglePluck = useButterflyStore((state) => state.togglePluck)
  const deleteNote = useButterflyStore((state) => state.deleteNote)
  const setError = useButterflyStore((state) => state.setError)
  const updatePerch = useButterflyStore((state) => state.updatePerch)
  const registerVisual = useButterflyStore((state) => state.registerVisual)
  const setPluckPosition = useButterflyStore((state) => state.setPluckPosition)
  const recordings = useRef(new Map<string, string>())
  const [focusedIds, setFocusedIds] = useState<Set<string>>(() => new Set())
  const onAudioError = useCallback(
    (id: string, message: string) => setError(message, id),
    [setError],
  )
  const onFocus = useCallback(
    (id: string) => setFocusedIds((current) => new Set(current).add(id)),
    [],
  )
  const onFocusOut = useCallback(
    (id: string) =>
      setFocusedIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      }),
    [],
  )

  const onSummonStart = useCallback(
    (position: THREE.Vector3, sourceId: string) => {
      if (recordings.current.size > 0 || recordings.current.has(sourceId))
        return
      const id = crypto.randomUUID()
      recordings.current.set(sourceId, id)
      spawnRecordingButterfly(id, position)
      void recorder.startRecording(id).catch((cause) => {
        setError(
          cause instanceof Error ? cause.message : 'Microphone capture failed.',
          id,
        )
        recordings.current.delete(sourceId)
        deleteNote(id)
      })
    },
    [deleteNote, recorder, setError, spawnRecordingButterfly],
  )

  const onSummonMove = useCallback(
    (position: THREE.Vector3, sourceId: string) => {
      const id = recordings.current.get(sourceId)
      if (id) updatePerch(id, position)
    },
    [updatePerch],
  )

  const onSummonEnd = useCallback(
    (sourceId: string) => {
      const id = recordings.current.get(sourceId)
      if (!id) return
      recordings.current.delete(sourceId)
      void recorder
        .stopRecording(id)
        .then((result) => {
          if (result) submitAudioToWorker(id, result.audioUrl, result.pcm16kHz)
          else deleteNote(id)
        })
        .catch((cause) => {
          deleteNote(id)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Recording could not be processed.',
            id,
          )
        })
    },
    [deleteNote, recorder, setError, submitAudioToWorker],
  )

  const onPinchStart = useCallback(
    (position: THREE.Vector3) => {
      const nearest = findNearestButterfly(position, 0.14, false)
      if (!nearest) return false
      setFocusedIds((current) => {
        const next = new Set(current)
        next.add(nearest)
        return next
      })
      setPluckPosition(nearest, position)
      togglePluck(nearest, position)
      return true
    },
    [setPluckPosition, togglePluck],
  )

  const onPinchMove = useCallback(
    (position: THREE.Vector3) => {
      const nearest = findNearestButterfly(position, 0.5, true)
      if (nearest) setPluckPosition(nearest, position)
    },
    [setPluckPosition],
  )

  useHandSummonGesture({
    onSummonStart,
    onSummonMove,
    onPinchMove,
    onSummonEnd,
    onPinchStart,
  })

  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight position={[2, 4, 2]} intensity={1.4} />
      <XRAudioListenerProvider>
        <SwarmPhysicsSystem />
        {Object.values(notes).map((note) => {
          const kin = kinematics.get(note.id)
          if (!kin) return null
          return (
            <PluckedButterflyEntity
              key={note.id}
              note={note}
              registerVisual={registerVisual}
              onTogglePluck={togglePluck}
              onDelete={deleteNote}
              onAudioError={onAudioError}
              onFocus={onFocus}
              onFocusOut={onFocusOut}
              ambientMuted={ambientMuted}
            />
          )
        })}
        <SemanticFilaments
          notes={notes}
          kinematics={kinematics}
          focusedIds={focusedIds}
        />
        <XRStatusPanel
          workerStatus={workerStatus}
          roomStatus={roomStatus}
          recorderStatus={recorder.status}
          muted={ambientMuted}
          onMute={onMute}
        />
      </XRAudioListenerProvider>
    </>
  )
}

function DesktopSceneControls({
  recorder,
  muted,
  onMute,
}: {
  recorder: ButterflyRecorder
  muted: boolean
  onMute: () => void
}) {
  const spawnText = useButterflyStore((state) => state.submitText)
  const spawn = useButterflyStore((state) => state.spawnRecordingButterfly)
  const submitAudio = useButterflyStore((state) => state.submitAudioToWorker)
  const deleteNote = useButterflyStore((state) => state.deleteNote)
  const setError = useButterflyStore((state) => state.setError)
  const [text, setText] = useState('')
  const [desktopId, setDesktopId] = useState<string | null>(null)
  const desktopIdRef = useRef<string | null>(null)
  const desktopPosition = useRef(new THREE.Vector3(0, 1.4, -1)).current

  const updateDesktopId = useCallback((id: string | null) => {
    desktopIdRef.current = id
    setDesktopId(id)
  }, [])

  useEffect(
    () => () => {
      const id = desktopIdRef.current
      if (id) void recorder.cancelRecording(id)
    },
    [recorder.cancelRecording],
  )

  const toggleRecording = async () => {
    const activeId = desktopIdRef.current
    if (activeId) {
      updateDesktopId(null)
      try {
        const result = await recorder.stopRecording(activeId)
        if (result) submitAudio(activeId, result.audioUrl, result.pcm16kHz)
        else deleteNote(activeId)
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Recording could not be processed.',
          activeId,
        )
        deleteNote(activeId)
      }
      return
    }
    const id = crypto.randomUUID()
    updateDesktopId(id)
    spawn(id, desktopPosition)
    try {
      await recorder.startRecording(id)
      if (desktopIdRef.current !== id) return
    } catch (cause) {
      if (desktopIdRef.current !== id) return
      updateDesktopId(null)
      setError(
        cause instanceof Error ? cause.message : 'Microphone capture failed.',
        id,
      )
      deleteNote(id)
    }
  }

  const submitText = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const clean = text.trim()
    if (!clean) return
    try {
      spawnText(clean, desktopPosition)
      setText('')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Typed note could not be submitted.',
      )
    }
  }

  return (
    <div className="desktop-scene-controls">
      <button
        type="button"
        className="control-button"
        onClick={() => void toggleRecording()}
      >
        {desktopId ? 'Stop recording' : 'Record note'}
      </button>
      <button
        type="button"
        className="control-button control-button--quiet"
        onClick={onMute}
      >
        {muted ? 'Unmute chimes' : 'Mute chimes'}
      </button>
      <form className="semantic-form" onSubmit={submitText}>
        <input
          aria-label="Type a semantic note"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type a note into the swarm"
        />
        <button className="control-button" type="submit">
          Release text
        </button>
      </form>
    </div>
  )
}

export function App() {
  const workerStatus = useButterflyStore((state) => state.workerStatus)
  const workerMessage = useButterflyStore((state) => state.workerMessage)
  const workerProgress = useButterflyStore((state) => state.workerProgress)
  const roomStatus = useButterflyStore((state) => state.roomStatus)
  const roomError = useButterflyStore((state) => state.roomError)
  const globalError = useButterflyStore((state) => state.error)
  const initWorker = useButterflyStore((state) => state.initWorker)
  const recorder = useButterflyRecorder()
  const [busy, setBusy] = useState(false)
  const [ambientMuted, setAmbientMuted] = useState(false)
  const [notice, setNotice] = useState(
    'Warm the microphone before entering XR.',
  )
  const dispose = useButterflyStore((state) => state.dispose)
  useEffect(() => () => dispose(), [dispose])

  const enter = async (mode: 'ar' | 'vr') => {
    setBusy(true)
    try {
      await recorder.warmup()
      initWorker()
      setNotice(
        mode === 'ar'
          ? 'Room scan and hand tracking requested.'
          : 'Controller tracking requested.',
      )
      if (mode === 'ar') await xrStore.enterAR()
      else await xrStore.enterVR()
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Could not start XR.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app-shell">
      <Canvas
        style={{ position: 'absolute', inset: 0 }}
        camera={{ position: [0, 1.4, 2.4], rotation: [0, 0, 0], fov: 60 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <XR store={xrStore}>
          <Experience
            recorder={recorder}
            ambientMuted={ambientMuted}
            onMute={() => setAmbientMuted((value) => !value)}
          />
        </XR>
      </Canvas>
      <section className="hud" aria-live="polite">
        <div className="eyebrow">MORPHIC / MEMORY SWARM</div>
        <p className="notice">{notice}</p>
        <div className="status-grid">
          <span>
            AI <b className={`status-dot status-dot--${workerStatus}`} />
            {workerMessage || workerStatus}
          </span>
          <span>
            Room <b>{roomStatus}</b>
          </span>
          <span>
            Mic <b>{recorder.status}</b>
          </span>
        </div>
        {workerStatus === 'loading' && (
          <div className="progress-track">
            <span style={{ width: `${Math.round(workerProgress * 100)}%` }} />
          </div>
        )}
        {(globalError || roomError || recorder.error) && (
          <p className="error-line">
            {globalError || roomError || recorder.error}
          </p>
        )}
        <div className="entry-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy || workerStatus === 'loading'}
            onClick={() => initWorker()}
          >
            {workerStatus === 'ready'
              ? 'AI ready'
              : workerStatus === 'loading'
                ? 'Loading AI…'
                : 'Load AI'}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void enter('ar')}
          >
            {busy ? 'Preparing…' : 'Enter AR'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void enter('vr')}
          >
            Enter VR
          </button>
        </div>
        <small>
          Requires microphone permission. Room geometry and semantic model
          status are never simulated.
        </small>
      </section>
      <DesktopSceneControls
        recorder={recorder}
        muted={ambientMuted}
        onMute={() => setAmbientMuted((value) => !value)}
      />
    </main>
  )
}
function XRStatusPanel({
  workerStatus,
  roomStatus,
  recorderStatus,
  muted,
  onMute,
}: {
  workerStatus: string
  roomStatus: string
  recorderStatus: string
  muted: boolean
  onMute: () => void
}) {
  const session = useXR((state) => state.session)
  return (
    <group position={[-0.7, 1.75, -1.15]}>
      <Container
        pixelSize={0.0015}
        flexDirection="column"
        width={250}
        padding={12}
        gap={7}
        borderRadius={8}
        backgroundColor="rgba(16,24,39,0.88)"
      >
        <Text fontSize={14} color="#f8fafc">
          MEMORY SWARM
        </Text>
        <Text fontSize={10} color="#b7c4e9">
          AI {workerStatus} · room {roomStatus} · mic {recorderStatus}
        </Text>
        <Text fontSize={10} color="#b7c4e9">
          Hold palm up or pinch/trigger to summon; release to send.
        </Text>
        <Container flexDirection="row" gap={6}>
          <Container
            paddingX={8}
            paddingY={5}
            borderRadius={5}
            backgroundColor="#334155"
            onClick={onMute}
          >
            <Text fontSize={10} color="#f8fafc">
              {muted ? 'Unmute' : 'Mute chimes'}
            </Text>
          </Container>
          <Container
            paddingX={8}
            paddingY={5}
            borderRadius={5}
            backgroundColor="#7f1d1d"
            onClick={() => void session?.end()}
          >
            <Text fontSize={10} color="#fee2e2">
              Exit XR
            </Text>
          </Container>
        </Container>
      </Container>
    </group>
  )
}
