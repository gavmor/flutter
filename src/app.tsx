import { Canvas } from '@react-three/fiber'
import { Container, Text } from '@react-three/uikit'
import {
  createXRStore,
  noEvents,
  PointerEvents,
  useXR,
  useXRSessionModeSupported,
  XR,
} from '@react-three/xr'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  type ButterflyRecorder,
  useButterflyRecorder,
} from './audio/useButterflyRecorder.js'
import {
  initializeXRAudio,
  XRAudioListenerProvider,
} from './audio/XRAudioListenerProvider.js'
import { PluckedButterflyEntity } from './components/PluckedButterflyEntity.js'
import { SemanticFilaments } from './components/SemanticFilaments.js'
import { useButterflyStore } from './state/useButterflyStore.js'
import { SwarmPhysicsSystem } from './xr-systems/SwarmPhysicsSystem.js'
import { useHandSummonGesture } from './xr-systems/useHandSummonGesture.js'
import { XRUIInteractionBoundary } from './xr-systems/XRUIInteractionBoundary.js'
import './app.css'

const xrStore = createXRStore({
  domOverlay: true,
  handTracking: true,
  meshDetection: true,
  planeDetection: true,
  hitTest: true,
  // XR controls activate on same-target release, including deliberate long holds.
  controller: {
    grabPointer: false,
    rayPointer: { minDistance: 0, clickThresholdMs: Infinity },
  },
  hand: {
    rayPointer: { minDistance: 0, clickThresholdMs: Infinity },
    grabPointer: { clickThresholdMs: Infinity },
    touchPointer: { clickThresholdMs: Infinity },
  },
})

function unlockSpatialAudio() {
  void initializeXRAudio().catch((cause: unknown) => {
    useButterflyStore
      .getState()
      .setError(
        cause instanceof Error
          ? cause.message
          : 'Spatial audio could not start.',
      )
  })
}

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
      if (!useButterflyStore.getState().workerReady) {
        setError('Load AI from the XR status panel before recording a memory.')
        return
      }
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
  const workerReady = useButterflyStore((state) => state.workerReady)
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
    if (!useButterflyStore.getState().workerReady) {
      setError('Load AI before recording a memory.')
      return
    }
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
        disabled={!workerReady && !desktopId}
        title={!workerReady ? 'Load AI before recording.' : undefined}
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
        <button
          className="control-button"
          type="submit"
          disabled={!workerReady}
        >
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
  const [xrErrors, setXrErrors] = useState<{
    ar: string | null
    vr: string | null
  }>({ ar: null, vr: null })
  const onSupportError = (mode: 'ar' | 'vr', cause: unknown) => {
    const message =
      cause instanceof Error
        ? cause.message
        : 'Browser permissions or site policy blocked the XR support check.'
    setXrErrors((current) => ({ ...current, [mode]: message }))
  }
  const arSupported = useXRSessionModeSupported(
    'immersive-ar',
    (cause: unknown) => onSupportError('ar', cause),
  )
  const vrSupported = useXRSessionModeSupported(
    'immersive-vr',
    (cause: unknown) => onSupportError('vr', cause),
  )
  const xrAvailable = window.isSecureContext && navigator.xr != null
  const gpuAvailable = 'gpu' in navigator && navigator.gpu != null
  const initWorker = useButterflyStore((state) => state.initWorker)
  const recorder = useButterflyRecorder()
  const [busy, setBusy] = useState(false)
  const [ambientMuted, setAmbientMuted] = useState(false)
  const [notice, setNotice] = useState(
    'Desktop controls do not require XR. Prepare the microphone before entering an available XR mode.',
  )
  const dispose = useButterflyStore((state) => state.dispose)
  useEffect(() => () => dispose(), [dispose])
  const microphoneReady =
    recorder.status === 'ready' ||
    recorder.status === 'recording' ||
    recorder.status === 'processing'
  const prepareMicrophone = async () => {
    setBusy(true)
    unlockSpatialAudio()
    try {
      await recorder.warmup()
      setNotice(
        'Microphone ready. Use a new click to enter an available XR mode, or record on desktop.',
      )
    } catch (cause) {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'Microphone permission could not be prepared.',
      )
    } finally {
      setBusy(false)
    }
  }
  const toggleAmbient = () => {
    unlockSpatialAudio()
    setAmbientMuted((value) => !value)
  }

  const enter = async (mode: 'ar' | 'vr') => {
    const supported = mode === 'ar' ? arSupported : vrSupported
    if (
      !xrAvailable ||
      supported !== true ||
      xrErrors[mode] ||
      !microphoneReady
    )
      return
    setBusy(true)
    try {
      // requestSession must run in this click, before awaiting microphone/audio/model work.
      const sessionRequest =
        mode === 'ar' ? xrStore.enterAR() : xrStore.enterVR()
      unlockSpatialAudio()
      await sessionRequest
      initWorker()
      setNotice(
        mode === 'ar'
          ? 'AR session started; measured room geometry is requested.'
          : 'VR session started; controller tracking is requested.',
      )
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
        events={noEvents}
      >
        <XR store={xrStore}>
          <PointerEvents />
          <Experience
            recorder={recorder}
            ambientMuted={ambientMuted}
            onMute={toggleAmbient}
          />
        </XR>
      </Canvas>
      <section className="hud" aria-live="polite">
        <div className="eyebrow">MORPHIC / MEMORY SWARM</div>
        <p className="notice">{notice}</p>
        <p className="notice">
          {!window.isSecureContext
            ? 'Immersive XR requires a secure HTTPS connection.'
            : !navigator.xr
              ? 'Immersive XR is unavailable in this browser. Desktop controls remain available; immersive mode needs an XR-capable browser and device.'
              : 'XR availability below is checked separately for AR and VR on this browser and device.'}
        </p>
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
        <div className="entry-actions" style={{ flexWrap: 'wrap' }}>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !gpuAvailable || workerStatus === 'loading'}
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
            className="secondary-button"
            disabled={busy}
            onClick={() => void prepareMicrophone()}
          >
            {recorder.status === 'warming'
              ? 'Preparing microphone…'
              : microphoneReady
                ? 'Microphone ready'
                : 'Prepare microphone'}
          </button>
          {(
            [
              { mode: 'ar', supported: arSupported },
              { mode: 'vr', supported: vrSupported },
            ] as const
          ).map(({ mode, supported }) => {
            const reason = !xrAvailable
              ? 'Immersive XR is unavailable in this browser or connection.'
              : xrErrors[mode]
                ? `XR support check blocked: ${xrErrors[mode]}`
                : supported === undefined
                  ? 'Checking this XR mode…'
                  : !supported
                    ? `Immersive ${mode.toUpperCase()} is unsupported by this browser or device.`
                    : !microphoneReady
                      ? 'Prepare the microphone first, then enter with a new click.'
                      : `Immersive ${mode.toUpperCase()} is available. Session permissions are checked when entering.`
            return (
              <button
                key={mode}
                type="button"
                className="secondary-button"
                disabled={
                  busy ||
                  !xrAvailable ||
                  supported !== true ||
                  !!xrErrors[mode] ||
                  !microphoneReady
                }
                title={reason}
                aria-label={`${mode.toUpperCase()}: ${reason}`}
                onClick={() => void enter(mode)}
              >
                {!xrAvailable || supported === false
                  ? `${mode.toUpperCase()} unavailable`
                  : xrErrors[mode]
                    ? `${mode.toUpperCase()} blocked`
                    : supported === undefined
                      ? `Checking ${mode.toUpperCase()}…`
                      : `Enter ${mode.toUpperCase()}`}
              </button>
            )
          })}
        </div>
        <small>
          {!gpuAvailable
            ? 'WebGPU is not exposed by this browser; semantic AI needs a compatible browser and GPU. '
            : 'WebGPU API detected; model initialization still checks the actual GPU. '}
          Desktop recording and typed semantic notes do not need WebXR. Room
          geometry and model results are never simulated.
        </small>
      </section>
      <DesktopSceneControls
        recorder={recorder}
        muted={ambientMuted}
        onMute={toggleAmbient}
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
  const initWorker = useButterflyStore((state) => state.initWorker)
  const workerMessage = useButterflyStore((state) => state.workerMessage)
  return (
    <group position={[-0.7, 1.75, -1.15]}>
      <XRUIInteractionBoundary>
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
            AI {workerStatus} / room {roomStatus} / mic {recorderStatus}
          </Text>
          <Text fontSize={10} color="#b7c4e9">
            {workerStatus === 'ready'
              ? 'Hold palm up or hold a trigger away from UI to record; release to send.'
              : `Load AI before recording. ${workerMessage}`}
          </Text>
          <Container flexDirection="row" gap={6}>
            <Container
              paddingX={8}
              paddingY={5}
              borderRadius={5}
              backgroundColor="#1d4ed8"
              onClick={
                workerStatus === 'idle' || workerStatus === 'error'
                  ? initWorker
                  : undefined
              }
            >
              <Text fontSize={10} color="#f8fafc">
                {workerStatus === 'loading'
                  ? 'Loading AI'
                  : workerStatus === 'ready'
                    ? 'AI ready'
                    : 'Load AI'}
              </Text>
            </Container>
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
      </XRUIInteractionBoundary>
    </group>
  )
}
