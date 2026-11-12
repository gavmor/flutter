/// <reference lib="webworker" />
import {
  type AutomaticSpeechRecognitionPipeline,
  env,
  type FeatureExtractionPipeline,
  pipeline,
} from '@huggingface/transformers'
import type { Vec3, WorkerRequest, WorkerResponse } from '../protocol'
import { RoomQuantizer } from './emeans'
import { type EmbeddedNote, StabilizedDualPCA } from './spatialPCA'

env.allowLocalModels = false
const scope = self as unknown as DedicatedWorkerGlobalScope
const ASR_MODEL = 'onnx-community/whisper-tiny.en'
const EMBEDDING_MODEL = 'mixedbread-ai/mxbai-embed-xsmall-v1'
const notes = new Map<string, EmbeddedNote & { origin: Vec3 }>()
const removed = new Set<string>()
const pca = new StabilizedDualPCA()
const room = new RoomQuantizer()
let queue = Promise.resolve()
let ready = false
const post = (message: WorkerResponse) => scope.postMessage(message)
const progress =
  (stage: string) => (event: { status: string; progress?: number }) => {
    post({
      type: 'STATUS',
      stage: `${stage}: ${event.status}`,
      progress: (event.progress ?? 0) / 100,
    })
  }
const createTranscriber = () =>
  pipeline('automatic-speech-recognition', ASR_MODEL, {
    device: 'webgpu',
    dtype: 'fp32',
    progress_callback: progress('Whisper'),
  })
const createEmbedder = () =>
  pipeline('feature-extraction', EMBEDDING_MODEL, {
    device: 'webgpu',
    dtype: 'fp32',
    progress_callback: progress('Semantic model'),
  })
let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let embedder: FeatureExtractionPipeline | null = null
async function initialize() {
  if (ready) {
    post({ type: 'READY', embeddingModel: EMBEDDING_MODEL, dimensions: 384 })
    return
  }
  if (!('gpu' in navigator))
    throw new Error(
      'WebGPU is unavailable. Use a WebGPU-capable browser over HTTPS; no acoustic/hash embedding substitute is used.',
    )
  post({
    type: 'STATUS',
    stage: 'Loading WebGPU models (first use downloads model weights)',
    progress: 0,
  })
  try {
    transcriber ??= await createTranscriber()
    embedder ??= await createEmbedder()
    ready = true
    post({ type: 'READY', embeddingModel: EMBEDDING_MODEL, dimensions: 384 })
  } catch (error) {
    ready = false
    throw error
  }
}

function targets() {
  const items = Array.from(notes.values())
  const raw = pca.project(items)
  const perches = room.fit(
    raw,
    items.map((item) => item.origin),
    items.map((item) => item.id),
  )
  return items.map((item, index) => {
    const point = raw[index]
    const neighbors = items
      .filter((other) => other.id !== item.id)
      .map((other) => {
        let similarity = 0
        for (let d = 0; d < 384; d++)
          similarity += item.vector[d] * other.vector[d]
        return { id: other.id, similarity }
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3)
      .map((neighbor) => neighbor.id)
    const hue = (Math.atan2(point[2], point[0]) / (Math.PI * 2) + 1) % 1
    return {
      id: item.id,
      pcaTarget: perches[index],
      semanticColorHSL: [
        hue,
        0.7 + Math.min(0.2, Math.hypot(point[0], point[2]) * 0.2),
        0.6 + point[1] * 0.1,
      ] as Vec3,
      neighbors,
    }
  })
}

async function processNote(
  message: Extract<WorkerRequest, { type: 'PROCESS_AUDIO' | 'PROCESS_TEXT' }>,
) {
  if (!ready || !embedder || !transcriber)
    throw new Error('Initialize the WebGPU models before submitting a note.')
  let text: string
  if (message.type === 'PROCESS_AUDIO') {
    if (
      message.sampleRate !== 16000 ||
      !message.audio.length ||
      !message.audio.every(Number.isFinite)
    )
      throw new Error(
        'Whisper requires non-empty finite mono 16 kHz PCM audio.',
      )
    post({ type: 'STATUS', stage: 'Transcribing voice note', progress: 0 })
    const result = await transcriber(message.audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    })
    text = (
      Array.isArray(result)
        ? result.map((part) => part.text).join(' ')
        : result.text
    ).trim()
  } else text = message.text.trim()
  if (!text) throw new Error('No speech or text was found. Try another note.')
  post({ type: 'STATUS', stage: 'Embedding note meaning', progress: 0 })
  const output = await embedder(text, { pooling: 'mean', normalize: true })
  const vector = Float32Array.from(output.data as Float32Array)
  const norm = Math.hypot(...vector)
  if (
    vector.length !== 384 ||
    !vector.every(Number.isFinite) ||
    Math.abs(norm - 1) > 0.01
  )
    throw new Error(
      'Semantic model did not return a normalized 384-dimensional embedding.',
    )
  if (removed.has(message.id)) return
  notes.set(message.id, { id: message.id, vector, origin: message.origin })
  post({
    type: 'NOTE_PROCESSED',
    id: message.id,
    text,
    projectedNotes: targets(),
  })
}

async function handle(message: WorkerRequest) {
  switch (message.type) {
    case 'INIT':
      await initialize()
      break
    case 'PROCESS_AUDIO':
    case 'PROCESS_TEXT':
      await processNote(message)
      break
    case 'SET_ROOM':
      room.setRoom(message.geometry)
      post({ type: 'TARGETS_UPDATED', projectedNotes: targets() })
      break
    case 'REMOVE_NOTE':
      notes.delete(message.id)
      post({ type: 'TARGETS_UPDATED', projectedNotes: targets() })
      break
    case 'DISPOSE':
      await transcriber?.dispose()
      await embedder?.dispose()
      scope.close()
      break
  }
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  // Tombstones apply immediately, even if a note is currently awaiting GPU inference.
  if (message.type === 'REMOVE_NOTE') removed.add(message.id)
  queue = queue
    .then(() => handle(message))
    .catch((error) => {
      const id = 'id' in message ? message.id : undefined
      post({
        type: 'ERROR',
        scope:
          message.type === 'INIT'
            ? 'model'
            : message.type === 'SET_ROOM'
              ? 'room'
              : 'note',
        id,
        message: error instanceof Error ? error.message : String(error),
      })
      // Catch terminates this request only: future messages still run.
    })
}
