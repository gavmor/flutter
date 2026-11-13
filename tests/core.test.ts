import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { Worker as NodeWorker } from 'node:worker_threads'
import { Matrix } from 'ml-matrix'
import {
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three'
import type {
  RoomGeometry,
  RoomSurfaceData,
  Vec3,
  WorkerRequest,
  WorkerResponse,
} from '../src/protocol'
import { useButterflyStore } from '../src/state/useButterflyStore'
import { RoomQuantizer, runEMeans } from '../src/worker/emeans'
import { alignProcrustes, StabilizedDualPCA } from '../src/worker/spatialPCA'
import { RoomCollider } from '../src/xr-systems/roomGeometry'

const emptyRoom = (): RoomGeometry => ({
  revision: 1,
  status: 'unscanned',
  floorY: null,
  floorPolygon: null,
  bounds: null,
  viewer: [0, 1, 0],
  surfaces: [],
})
function box(
  id: string,
  width: number,
  height: number,
  depth: number,
  center: Vec3,
): RoomSurfaceData {
  const geometry = new BoxGeometry(width, height, depth).toNonIndexed()
  const positions = geometry.attributes.position.array as Float32Array
  const triangles = new Float32Array(positions)
  for (let i = 0; i < triangles.length; i += 3)
    for (let d = 0; d < 3; d++) triangles[i + d] += center[d]
  geometry.dispose()
  return { id, kind: 'mesh', label: '', triangles, closed: true }
}

test('row-vector Procrustes recovers nonsymmetric rotations and rank-deficient orthogonality', () => {
  const a: Vec3[] = [
    [1, 2, 3],
    [-2, 1, 0],
    [0, -1, 2],
    [2, 0, -1],
  ]
  const rotation = new Matrix([
    [0, -1, 0],
    [0.6, 0, -0.8],
    [0.8, 0, 0.6],
  ])
  const b = new Matrix(a).mmul(rotation).to2DArray() as Vec3[]
  const q = alignProcrustes(a, b)
  assert.ok(new Matrix(a).mmul(q).sub(new Matrix(b)).norm() < 1e-8)
  for (const [source, reference] of [
    [
      [
        [1, 0, 0],
        [-1, 0, 0],
      ],
      [
        [0, 1, 0],
        [0, -1, 0],
      ],
    ],
    [[[0, 0, 0]], [[0, 0, 0]]],
  ] as [Vec3[], Vec3[]][]) {
    const aligned = alignProcrustes(source, reference)
    assert.ok(
      aligned.transpose().mmul(aligned).sub(Matrix.eye(3)).norm() < 1e-8,
    )
    assert.ok(
      new Matrix(source).mmul(aligned).sub(new Matrix(reference)).norm() < 1e-8,
    )
  }
})

test('dual PCA is finite for small/identical/rank-one inputs, stable on reorder and deletion', () => {
  const pca = new StabilizedDualPCA()
  const identical = Array.from({ length: 5 }, (_, i) => ({
    id: `equal-${i}`,
    vector: new Float32Array([1, 0, 0, 0]),
  }))
  assert.deepEqual(
    pca.project(identical),
    identical.map(() => [0, 0, 0]),
  )
  const notes = [-2, -1, 1, 2].map((x, i) => ({
    id: String(i),
    vector: new Float32Array([x, x * 2, 0, 0]),
  }))
  const first = pca.project(notes)
  assert.ok(first.flat().every(Number.isFinite))
  const reordered = pca.project(notes.slice().reverse()).reverse()
  first.forEach((point, i) => {
    assert.ok(
      new Vector3(...point).distanceTo(new Vector3(...reordered[i])) < 1e-8,
    )
  })
  assert.ok(pca.project(notes.slice(0, 2)).flat().every(Number.isFinite))
  assert.deepEqual(pca.project([]), [])
  assert.deepEqual(pca.project(notes.slice(0, 1)), [[0, 0, 0]])
})

test('whole-room mesh bounds do not become solids and swept motion cannot tunnel through triangles', () => {
  const collider = new RoomCollider()
  collider.setGeometry({
    ...emptyRoom(),
    status: 'scanned',
    surfaces: [
      box('room', 4, 4, 4, [0, 1, 0]),
      box('table', 0.5, 0.5, 0.5, [0.7, 1, 0]),
    ],
  })
  assert.equal(collider.isFree(new Vector3(0, 1, 0)), true)
  assert.equal(collider.isFree(new Vector3(0.7, 1, 0)), false)
  assert.equal(collider.isFree(new Vector3(3, 1, 0)), false)
  const safe = new Vector3()
  assert.equal(
    collider.constrainMovement(
      new Vector3(0, 1, 0),
      new Vector3(1.5, 1, 0),
      safe,
    ),
    false,
  )
  assert.ok(safe.x <= 0.37501 && safe.x > 0)
  assert.ok(collider.isFree(safe, 0.0749))
  collider.setGeometry({
    ...emptyRoom(),
    surfaces: [
      {
        id: 'triangle',
        kind: 'mesh',
        label: '',
        closed: false,
        triangles: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
      },
    ],
  })
  assert.equal(
    collider.isFree(new Vector3(1.6, 1.6, 0.01)),
    true,
    'broadphase box must not reject empty triangle corners',
  )
  assert.equal(
    collider.constrainMovement(
      new Vector3(0.5, 0.5, 1),
      new Vector3(0.5, 0.5, -1),
      safe,
    ),
    false,
  )
  assert.ok(safe.z >= 0.07499)
})

test('concave observed floor and nonzero floor height constrain quantizer medoids and swept flutter', () => {
  const floorY = 4.5
  const floorPolygon: Vec3[] = [
    [0, floorY, 0],
    [3, floorY, 0],
    [3, floorY, 1],
    [1, floorY, 1],
    [1, floorY, 3],
    [0, floorY, 3],
  ]
  const geometry: RoomGeometry = {
    ...emptyRoom(),
    status: 'scanned',
    floorY,
    floorPolygon,
    bounds: { min: [0, floorY, 0], max: [3, floorY + 2.2, 3] },
    surfaces: [box('furniture', 0.5, 1.5, 0.5, [0.5, floorY + 0.75, 1.8])],
  }
  const quantizer = new RoomQuantizer()
  quantizer.setRoom(geometry)
  const collider = new RoomCollider()
  collider.setGeometry(geometry)
  const ids = Array.from({ length: 12 }, (_, i) => String(i))
  const targets = quantizer.fit(
    ids.map(() => [0, 0, 0]),
    ids.map(() => [0.5, floorY + 1, 0.5]),
    ids,
  )
  assert.equal(targets.length, ids.length)
  for (const target of targets) {
    assert.ok(collider.isFree(new Vector3(...target), 0.1499))
    assert.ok(target[1] > floorY + 0.79)
  }
  const safe = new Vector3()
  assert.equal(
    collider.constrainMovement(
      new Vector3(2.5, floorY + 1, 0.5),
      new Vector3(0.5, floorY + 1, 2.5),
      safe,
    ),
    false,
  )
  assert.ok(collider.isFree(safe, 0.0749))
  const samples: Vec3[] = [
    [0, 0, 0],
    [0, 2, 0],
    [2, 0, 0],
  ]
  for (const centroid of runEMeans(samples, 2))
    assert.ok(
      samples.some((point) => point.every((value, d) => value === centroid[d])),
    )
})

test('unscanned small-N spread is deterministic physical layout, not a fabricated room', () => {
  const quantizer = new RoomQuantizer()
  const first = quantizer.fit(
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 0],
    ],
    ['a', 'b'],
  )
  assert.notDeepEqual(first[0], first[1])
  assert.deepEqual(quantizer.fit([[0, 0, 0]], [[0, 1, 0]], ['b'])[0], first[1])
})

// Bridge-only transport double: real structuredClone transfers detach PCM; no model output is fabricated in app code.
class WorkerTransport {
  static current: WorkerTransport
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  requests: WorkerRequest[] = []
  terminated = false
  constructor() {
    WorkerTransport.current = this
  }
  postMessage(message: WorkerRequest, transfers: Transferable[] = []) {
    this.requests.push(structuredClone(message, { transfer: transfers }))
  }
  terminate() {
    this.terminated = true
  }
  receive(message: WorkerResponse) {
    this.onmessage?.({ data: message })
  }
}

test('summoning is visible state without AI, while recording requires readiness and cancellation preserves the butterfly', () => {
  const store = useButterflyStore
  store.getState().dispose()
  try {
    store.getState().summonButterfly('pending', new Vector3(0, 1.4, -0.8))
    assert.equal(store.getState().notes.pending.state, 'SUMMONED')
    assert.equal(store.getState().notes.pending.error, null)
    assert.equal(store.getState().entities.length, 1)
    assert.ok(store.getState().kinematics.has('pending'))
    assert.throws(() => store.getState().beginRecording('pending'), /Load AI/)
    assert.equal(store.getState().notes.pending.state, 'SUMMONED')
    store.setState({ workerReady: true })
    store.getState().beginRecording('pending')
    assert.equal(store.getState().notes.pending.state, 'RECORDING')
    store.getState().restoreSummoned('pending')
    assert.equal(store.getState().notes.pending.state, 'SUMMONED')
    assert.equal(store.getState().notes.pending.audioUrl, '')
    store.getState().deleteNote('pending')
    assert.equal(store.getState().entities.length, 0)
    assert.equal(store.getState().kinematics.size, 0)
  } finally {
    store.getState().dispose()
  }
})

test('store bridge applies all targets before metadata, enforces lifecycle, transfers audio and disposes', () => {
  const originalWorker = globalThis.Worker
  globalThis.Worker = WorkerTransport as unknown as typeof Worker
  const store = useButterflyStore

  try {
    store.getState().dispose()
    store.getState().initWorker()
    const transport = WorkerTransport.current
    transport.receive({
      type: 'STATUS',
      stage: 'Loading Whisper',
      progress: 0.25,
    })
    store.getState().summonButterfly('draft', new Vector3(0, 1.4, 0))
    store.getState().deleteNote('draft')
    assert.deepEqual(
      transport.requests.map((request) => request.type),
      ['INIT'],
    )
    assert.equal(store.getState().workerMessage, 'Loading Whisper')
    assert.equal(store.getState().workerProgress, 0.25)
    transport.receive({
      type: 'READY',
      embeddingModel: 'mixedbread-ai/mxbai-embed-xsmall-v1',
      dimensions: 384,
    })
    const origin = new Vector3(0, 1, 0)
    store.getState().summonButterfly('a', origin)
    store.getState().beginRecording('a')
    store.getState().togglePluck('a')
    assert.equal(store.getState().notes.a.state, 'RECORDING')
    const audio = new Float32Array([0.1, -0.1])
    store.getState().submitAudioToWorker('a', '', audio)
    assert.equal(audio.byteLength, 0)
    assert.equal(store.getState().notes.a.state, 'TRANSCRIBING')
    const b = store.getState().submitText('A real typed-text request', origin)
    assert.equal(transport.requests.at(-1)?.type, 'PROCESS_TEXT')
    let observedAtomicUpdate = false
    const unsubscribe = store.subscribe((state) => {
      if (state.notes.a.state === 'TRANSIT') {
        assert.deepEqual(
          state.kinematics.get('a')?.pcaTarget.toArray(),
          [1, 1, 1],
        )
        assert.deepEqual(
          state.kinematics.get(b)?.pcaTarget.toArray(),
          [2, 1, 1],
        )
        observedAtomicUpdate = true
      }
    })
    transport.receive({
      type: 'NOTE_PROCESSED',
      id: 'a',
      text: 'Transcribed voice',
      projectedNotes: [
        {
          id: 'a',
          pcaTarget: [1, 1, 1],
          semanticColorHSL: [0.1, 0.7, 0.6],
          neighbors: [b],
        },
        {
          id: b,
          pcaTarget: [2, 1, 1],
          semanticColorHSL: [0.2, 0.7, 0.6],
          neighbors: ['a'],
        },
      ],
    })
    unsubscribe()
    assert.ok(observedAtomicUpdate)
    assert.deepEqual(
      store.getState().kinematics.get('a')?.currentPos.toArray(),
      origin.toArray(),
      'targets never teleport actual positions',
    )
    store.getState().markHovered('a')
    store.getState().togglePluck('a')
    assert.equal(store.getState().notes.a.state, 'PLUCKED')
    transport.receive({
      type: 'ERROR',
      scope: 'note',
      id: b,
      message: 'GPU inference failed',
    })
    assert.equal(store.getState().notes[b].error, 'GPU inference failed')
    const object = new Object3D(),
      wing = new Mesh(undefined, new MeshStandardMaterial())
    store.getState().registerVisual('a', object, wing, wing)
    const kin = store.getState().kinematics.get('a')
    assert.ok(kin)
    store.getState().deleteNote(b)
    transport.receive({
      type: 'NOTE_PROCESSED',
      id: b,
      text: 'late',
      projectedNotes: [
        {
          id: b,
          pcaTarget: [9, 9, 9],
          semanticColorHSL: [0, 0, 0],
          neighbors: [],
        },
      ],
    })
    assert.equal(store.getState().notes[b], undefined)
    store.getState().dispose()
    assert.ok(transport.terminated)
    assert.equal(kin.object, null)
    assert.equal(store.getState().kinematics.size, 0)
    assert.equal(store.getState().entities.length, 0)
  } finally {
    store.getState().dispose()
    globalThis.Worker = originalWorker
  }
})
test('contact permits escape/sliding; an L-floor corridor reaches the other arm without crossing the notch', () => {
  const collider = new RoomCollider()
  const geometry: RoomGeometry = {
    ...emptyRoom(),
    status: 'scanned',
    floorY: 0,
    floorPolygon: [
      [0, 0, 0],
      [3, 0, 0],
      [3, 0, 1],
      [1, 0, 1],
      [1, 0, 3],
      [0, 0, 3],
    ],
    bounds: { min: [0, 0, 0], max: [3, 2.2, 3] },
  }
  collider.setGeometry(geometry)
  const safe = new Vector3()
  const contact = new Vector3(2, 1, 0.925)
  assert.equal(
    collider.constrainMovement(contact, new Vector3(2, 1, 0.8), safe),
    true,
  )
  assert.ok(safe.z < contact.z)
  const position = new Vector3(2.5, 1, 0.5),
    target = new Vector3(0.5, 1, 2.5),
    desired = new Vector3(),
    direction = new Vector3()
  for (let i = 0; i < 1000 && position.distanceTo(target) > 0.03; i++) {
    direction.subVectors(target, position).clampLength(0, 0.02)
    desired.copy(position).add(direction)
    collider.constrainMovement(position, desired, safe)
    assert.ok(collider.isFree(safe, 0.0749))
    position.copy(safe)
  }
  assert.ok(
    position.distanceTo(target) < 0.03,
    `must traverse corridor, not stall at ${position.toArray()}`,
  )
  collider.setGeometry({
    ...geometry,
    revision: 2,
    surfaces: [box('new-obstacle', 0.6, 1, 0.6, [0.5, 1, 2.5])],
  })
  assert.equal(collider.isFree(target), false)
  assert.ok(collider.recoverPosition(target, safe))
  assert.ok(collider.isFree(safe))
  const furnitureOnly = new RoomCollider()
  furnitureOnly.setGeometry({
    ...emptyRoom(),
    surfaces: [box('unrelated-furniture', 1, 1, 1, [4, 1, 4])],
  })
  assert.equal(furnitureOnly.hasEnclosure, false)
})

test('actual actor serializes rejected requests without poisoning subsequent room/deletion messages', async () => {
  const worker = new NodeWorker(new URL('./actor-runtime.mjs', import.meta.url))
  try {
    await once(worker, 'message')
    const responses: WorkerResponse[] = []
    const { promise: received, resolve, reject } = Promise.withResolvers<void>()
    worker.on('error', reject)
    worker.on('message', (message) => {
      responses.push(message)
      if (responses.length === 4) resolve()
    })
    worker.postMessage({ type: 'INIT' })
    worker.postMessage({
      type: 'PROCESS_TEXT',
      id: 'without-gpu',
      text: 'Not a fake embedding',
      origin: [0, 1, 0],
    })
    worker.postMessage({ type: 'SET_ROOM', geometry: emptyRoom() })
    worker.postMessage({ type: 'REMOVE_NOTE', id: 'without-gpu' })
    await received
    assert.deepEqual(
      responses.map((response) => response.type),
      ['ERROR', 'ERROR', 'TARGETS_UPDATED', 'TARGETS_UPDATED'],
    )
    assert.equal(
      (responses[0] as Extract<WorkerResponse, { type: 'ERROR' }>).scope,
      'model',
    )
    assert.equal(
      (responses[1] as Extract<WorkerResponse, { type: 'ERROR' }>).id,
      'without-gpu',
    )
  } finally {
    await worker.terminate()
  }
})

test('unexpected worker failure resets semantic session, revokes audio, and preserves measured room for reinit', async () => {
  const originalWorker = globalThis.Worker
  globalThis.Worker = WorkerTransport as unknown as typeof Worker
  const store = useButterflyStore
  const audioUrl = URL.createObjectURL(new Blob(['recorded-voice']))
  try {
    store.getState().dispose()
    store.getState().initWorker()
    const transport = WorkerTransport.current
    transport.receive({
      type: 'READY',
      embeddingModel: 'mixedbread-ai/mxbai-embed-xsmall-v1',
      dimensions: 384,
    })
    store
      .getState()
      .publishRoom({ ...emptyRoom(), revision: 4, status: 'partial' })
    store.getState().summonButterfly('crash-note', new Vector3(0, 1, 0))
    store.getState().beginRecording('crash-note')
    store
      .getState()
      .submitAudioToWorker('crash-note', audioUrl, new Float32Array([0.1]))
    transport.onerror?.({ message: 'GPU device lost' })
    assert.equal(store.getState().entities.length, 0)
    assert.deepEqual(store.getState().notes, {})
    assert.equal(store.getState().workerStatus, 'error')
    assert.equal(store.getState().roomStatus, 'partial')
    const error = store.getState().error
    assert.ok(error)
    assert.match(error, /session was reset/)
    await assert.rejects(fetch(audioUrl))
    store.getState().initWorker()
    assert.deepEqual(
      WorkerTransport.current.requests.map((request) => request.type),
      ['INIT', 'SET_ROOM'],
    )
  } finally {
    store.getState().dispose()
    globalThis.Worker = originalWorker
    URL.revokeObjectURL(audioUrl)
  }
})
