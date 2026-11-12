import { parentPort } from 'node:worker_threads'
import { register } from 'tsx/esm/api'

register()
// Adapt the real worker actor to Node's message port; no inference/model substitution.
globalThis.self = globalThis
globalThis.postMessage = (message) => parentPort.postMessage(message)
globalThis.close = () => parentPort.close()
await import('../src/worker/ai.worker.ts')
parentPort.on('message', (data) => globalThis.self.onmessage({ data }))
parentPort.postMessage({ type: 'ACTOR_LOADED' })
