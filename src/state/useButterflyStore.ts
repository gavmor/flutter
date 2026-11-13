import { Mesh, MeshStandardMaterial, type Object3D, Vector3 } from 'three'
import { create } from 'zustand'
import type {
  ProjectedNote,
  RoomGeometry,
  RoomStatus,
  Vec3,
  WorkerRequest,
  WorkerResponse,
} from '../protocol'

type ButterflyLifecycleState =
  | 'SUMMONED'
  | 'RECORDING'
  | 'TRANSCRIBING'
  | 'TRANSIT'
  | 'HOVERING'
  | 'PLUCKED'
export interface ButterflyMetadata {
  id: string
  text: string
  audioUrl: string
  semanticColorHSL: Vec3
  state: ButterflyLifecycleState
  error: string | null
  neighbors: string[]
}
export interface ButterflyKinematics {
  id: string
  pcaTarget: Vector3
  diffusedPos: Vector3
  currentPos: Vector3
  velocity: Vector3
  perchPos: Vector3
  pluckPos: Vector3
  flightStart: Vector3
  flightElapsed: number
  flightDuration: number
  rms: number
  phase: number
  object: Object3D | null
  leftWing: Object3D | null
  rightWing: Object3D | null
  leftMaterial: MeshStandardMaterial | null
  rightMaterial: MeshStandardMaterial | null
  roomRevision: number
  trackingBlocked: boolean
}
export interface ButterflyStore {
  workerReady: boolean
  workerStatus: 'idle' | 'loading' | 'ready' | 'error'
  workerMessage: string
  workerProgress: number
  roomStatus: RoomStatus
  roomError: string | null
  error: string | null
  notes: Record<string, ButterflyMetadata>
  kinematics: Map<string, ButterflyKinematics>
  /** Dense transient registry avoids Map entry tuple allocation in the frame loop. */
  entities: ButterflyKinematics[]
  initWorker: () => void
  summonButterfly: (id: string, spawnPos: Vector3) => void
  beginRecording: (id: string) => void
  restoreSummoned: (id: string) => void
  submitAudioToWorker: (
    id: string,
    audioUrl: string,
    pcm16kHz: Float32Array,
  ) => void
  submitText: (text: string, spawnPos?: Vector3) => string
  togglePluck: (id: string, handPos?: Vector3) => void
  deleteNote: (id: string) => void
  markHovered: (id: string) => void
  setRecordingRms: (id: string, rms: number) => void
  updatePerch: (id: string, position: Vector3) => void
  setPluckPosition: (id: string, position: Vector3) => void
  registerVisual: (
    id: string,
    object: Object3D,
    leftWing: Object3D,
    rightWing: Object3D,
  ) => () => void
  setError: (message: string | null, id?: string) => void
  publishRoom: (geometry: RoomGeometry) => void
  setRoomError: (message: string | null) => void
  dispose: () => void
}
let aiWorker: Worker | null = null
let latestRoom: RoomGeometry | null = null

export const useButterflyStore = create<ButterflyStore>((set, get) => {
  const fail = (message: string | null, id?: string) => {
    if (id) {
      const note = get().notes[id]
      if (note) {
        set({
          error: message,
          notes: { ...get().notes, [id]: { ...note, error: message } },
        })
        return
      }
    }
    set({ error: message })
  }
  const send = (message: WorkerRequest, transfer: Transferable[] = []) => {
    if (!aiWorker)
      throw new Error('Initialize WebGPU models before submitting notes.')
    aiWorker.postMessage(message, transfer)
  }
  const applyTargets = (
    projected: ProjectedNote[],
    processed?: { id: string; text: string },
  ) => {
    const state = get()
    const notes = { ...state.notes }
    for (const projection of projected) {
      const kin = state.kinematics.get(projection.id)
      const note = notes[projection.id]
      if (!kin || !note) continue
      kin.pcaTarget.fromArray(projection.pcaTarget)
      notes[projection.id] = {
        ...note,
        semanticColorHSL: projection.semanticColorHSL,
        neighbors: projection.neighbors,
      }
    }
    if (processed && notes[processed.id]?.state === 'TRANSCRIBING') {
      const kin = state.kinematics.get(processed.id)
      if (kin) {
        kin.flightStart.copy(kin.currentPos)
        kin.flightElapsed = 0
        kin.flightDuration = Math.max(
          1.2,
          Math.min(4, kin.currentPos.distanceTo(kin.pcaTarget) / 0.65),
        )
        notes[processed.id] = {
          ...notes[processed.id],
          text: processed.text,
          state: 'TRANSIT',
          error: null,
        }
      }
    }
    // Publish metadata only after ALL mutable targets are updated.
    set({ notes, workerMessage: 'Ready for another memory', workerProgress: 1 })
  }
  return {
    workerReady: false,
    workerStatus: 'idle',
    workerMessage: 'Models are not loaded',
    workerProgress: 0,
    roomStatus: 'unscanned',
    roomError: null,
    error: null,
    notes: {},
    kinematics: new Map(),
    entities: [],
    initWorker: () => {
      if (get().workerStatus === 'loading' || get().workerReady) return
      set({
        workerStatus: 'loading',
        workerMessage: 'Starting WebGPU worker',
        workerProgress: 0,
        error: null,
      })
      try {
        if (!aiWorker) {
          aiWorker = new Worker(
            new URL('../worker/ai.worker.ts', import.meta.url),
            { type: 'module' },
          )
          aiWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const message = event.data
            switch (message.type) {
              case 'READY':
                set({
                  workerReady: true,
                  workerStatus: 'ready',
                  workerMessage: 'Whisper + semantic model ready',
                  workerProgress: 1,
                  error: null,
                })
                break
              case 'STATUS':
                set({
                  workerMessage: message.stage,
                  workerProgress: message.progress,
                })
                break
              case 'ERROR':
                if (message.scope === 'model')
                  set({
                    workerReady: false,
                    workerStatus: 'error',
                    workerMessage: message.message,
                  })
                if (message.scope === 'room')
                  get().setRoomError(message.message)
                fail(message.message, message.id)
                break
              case 'NOTE_PROCESSED':
                applyTargets(message.projectedNotes, message)
                break
              case 'TARGETS_UPDATED':
                applyTargets(message.projectedNotes)
                break
            }
          }
          aiWorker.onerror = (event) => {
            const message = `${event.message || 'The AI worker stopped unexpectedly.'} The memory session was reset; initialize models to start again.`
            const room = latestRoom
            get().dispose()
            if (room) get().publishRoom(room)
            set({
              workerReady: false,
              workerStatus: 'error',
              workerMessage: message,
              error: message,
            })
          }
          aiWorker.onmessageerror = () => {
            const room = latestRoom
            get().dispose()
            if (room) get().publishRoom(room)
            set({
              workerStatus: 'error',
              error: 'Unreadable worker message. The memory session was reset.',
              workerMessage: 'The memory session was reset.',
            })
          }
        }
        send({ type: 'INIT' })
        if (latestRoom) send({ type: 'SET_ROOM', geometry: latestRoom })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        set({
          workerReady: false,
          workerStatus: 'error',
          error: message,
          workerMessage: message,
        })
      }
    },
    summonButterfly: (id, spawnPos) => {
      if (get().notes[id]) return
      const kin: ButterflyKinematics = {
        id,
        pcaTarget: spawnPos.clone(),
        diffusedPos: spawnPos.clone(),
        currentPos: spawnPos.clone(),
        velocity: new Vector3(),
        perchPos: spawnPos.clone(),
        pluckPos: spawnPos.clone(),
        flightStart: spawnPos.clone(),
        flightElapsed: 0,
        flightDuration: 1.2,
        rms: 0,
        phase: get().entities.length * 2.399963229728653,
        object: null,
        leftWing: null,
        rightWing: null,
        leftMaterial: null,
        rightMaterial: null,
        roomRevision: -1,
        trackingBlocked: false,
      }
      get().kinematics.set(id, kin)
      get().entities.push(kin)
      set({
        notes: {
          ...get().notes,
          [id]: {
            id,
            text: 'Butterfly summoned. Choose Record when ready.',
            audioUrl: '',
            semanticColorHSL: [0.55, 0.65, 0.7],
            state: 'SUMMONED',
            error: null,
            neighbors: [],
          },
        },
      })
    },
    beginRecording: (id) => {
      const note = get().notes[id]
      if (note?.state !== 'SUMMONED')
        throw new Error('Choose a summoned butterfly before recording.')
      if (!get().workerReady)
        throw new Error('Load AI before recording a memory.')
      set({
        notes: {
          ...get().notes,
          [id]: {
            ...note,
            state: 'RECORDING',
            text: 'Listening…',
            error: null,
          },
        },
      })
    },
    restoreSummoned: (id) => {
      const note = get().notes[id]
      if (note?.state !== 'RECORDING') return
      get().setRecordingRms(id, 0)
      set({
        notes: {
          ...get().notes,
          [id]: {
            ...note,
            state: 'SUMMONED',
            text: 'Butterfly summoned. Choose Record when ready.',
          },
        },
      })
    },
    submitAudioToWorker: (id, audioUrl, pcm16kHz) => {
      const note = get().notes[id]
      if (note?.state !== 'RECORDING') {
        if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl)
        return
      }
      set({
        notes: {
          ...get().notes,
          [id]: {
            ...note,
            audioUrl,
            state: 'TRANSCRIBING',
            text: 'Transcribing…',
            error: null,
          },
        },
      })
      try {
        if (!get().workerReady)
          throw new Error(
            'WebGPU models are not ready. Initialize them before recording.',
          )
        const origin = get().kinematics.get(id)?.perchPos
        if (!origin) throw new Error('The recording has no spatial origin.')
        send(
          {
            type: 'PROCESS_AUDIO',
            id,
            audio: pcm16kHz,
            sampleRate: 16000,
            origin: [origin.x, origin.y, origin.z],
          },
          [pcm16kHz.buffer as ArrayBuffer],
        )
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), id)
      }
    },
    submitText: (text, spawnPos = new Vector3(0, 1.35, -0.8)) => {
      if (!text.trim()) throw new Error('Write a memory first.')
      if (!get().workerReady)
        throw new Error('Initialize the WebGPU models before adding a memory.')
      const id = crypto.randomUUID()
      get().summonButterfly(id, spawnPos)
      const note = get().notes[id]
      set({
        notes: {
          ...get().notes,
          [id]: { ...note, text: text.trim(), state: 'TRANSCRIBING' },
        },
      })
      try {
        send({
          type: 'PROCESS_TEXT',
          id,
          text: text.trim(),
          origin: [spawnPos.x, spawnPos.y, spawnPos.z],
        })
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), id)
      }
      return id
    },
    togglePluck: (id, handPos) => {
      const note = get().notes[id],
        kin = get().kinematics.get(id)
      if (
        !note ||
        !kin ||
        (note.state !== 'PLUCKED' && note.state !== 'HOVERING')
      )
        return
      if (note.state === 'HOVERING') {
        kin.pluckPos.copy(handPos ?? kin.currentPos)
        set({ notes: { ...get().notes, [id]: { ...note, state: 'PLUCKED' } } })
      } else {
        kin.flightStart.copy(kin.currentPos)
        kin.flightElapsed = 0
        set({ notes: { ...get().notes, [id]: { ...note, state: 'TRANSIT' } } })
      }
    },
    deleteNote: (id) => {
      const note = get().notes[id]
      if (!note) return
      if (note.audioUrl.startsWith('blob:')) URL.revokeObjectURL(note.audioUrl)
      get().kinematics.delete(id)
      const index = get().entities.findIndex((entity) => entity.id === id)
      if (index >= 0) get().entities.splice(index, 1)
      const notes = { ...get().notes }
      delete notes[id]
      set({ notes })
      if (aiWorker && note.state !== 'SUMMONED' && note.state !== 'RECORDING')
        send({ type: 'REMOVE_NOTE', id })
    },
    markHovered: (id) => {
      const note = get().notes[id]
      if (note?.state === 'TRANSIT')
        set({ notes: { ...get().notes, [id]: { ...note, state: 'HOVERING' } } })
    },
    setRecordingRms: (id, rms) => {
      const kin = get().kinematics.get(id)
      if (kin) kin.rms = Math.min(1, Math.max(0, rms))
    },
    updatePerch: (id, position) => {
      get().kinematics.get(id)?.perchPos.copy(position)
    },
    setPluckPosition: (id, position) => {
      get().kinematics.get(id)?.pluckPos.copy(position)
    },
    registerVisual: (id, object, leftWing, rightWing) => {
      const kin = get().kinematics.get(id)
      if (kin) {
        kin.object = object
        kin.leftWing = leftWing
        kin.rightWing = rightWing
        kin.leftMaterial =
          leftWing instanceof Mesh &&
          leftWing.material instanceof MeshStandardMaterial
            ? leftWing.material
            : null
        kin.rightMaterial =
          rightWing instanceof Mesh &&
          rightWing.material instanceof MeshStandardMaterial
            ? rightWing.material
            : null
      }
      return () => {
        if (kin?.object === object) {
          kin.object = null
          kin.leftWing = null
          kin.rightWing = null
          kin.leftMaterial = null
          kin.rightMaterial = null
        }
      }
    },
    setError: fail,
    setRoomError: (message) => set({ roomError: message, error: message }),
    publishRoom: (geometry) => {
      latestRoom = geometry
      set({ roomStatus: geometry.status })
      if (aiWorker) send({ type: 'SET_ROOM', geometry })
    },
    dispose: () => {
      if (aiWorker) {
        aiWorker.onmessage = null
        aiWorker.onerror = null
        aiWorker.onmessageerror = null
        aiWorker.terminate()
        aiWorker = null
      }
      const state = get()
      for (const id in state.notes)
        if (state.notes[id].audioUrl.startsWith('blob:'))
          URL.revokeObjectURL(state.notes[id].audioUrl)
      for (const entity of state.entities) {
        entity.object = null
        entity.leftWing = null
        entity.rightWing = null
        entity.leftMaterial = null
        entity.rightMaterial = null
      }
      state.kinematics.clear()
      state.entities.length = 0
      latestRoom = null
      set({
        notes: {},
        workerReady: false,
        workerStatus: 'idle',
        workerMessage: 'Models are not loaded',
        workerProgress: 0,
        roomStatus: 'unscanned',
        roomError: null,
        error: null,
      })
    },
  }
})
