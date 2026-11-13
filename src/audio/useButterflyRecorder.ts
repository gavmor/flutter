import { useCallback, useEffect, useRef, useState } from 'react'
import { useButterflyStore } from '../state/useButterflyStore.js'
import {
  getXRAudioContext,
  initializeXRAudio,
} from './XRAudioListenerProvider.js'

type ActiveRecording = {
  id: string
  recorder: MediaRecorder
  chunks: Blob[]
  cancelled: boolean
}
type PendingRecording = { id: string; cancelled: boolean }

type RecorderStatus =
  | 'idle'
  | 'warming'
  | 'ready'
  | 'recording'
  | 'processing'
  | 'error'
interface RecordingResult {
  audioUrl: string
  pcm16kHz: Float32Array
}
export interface ButterflyRecorder {
  status: RecorderStatus
  error: string | null
  warmup: () => Promise<void>
  startRecording: (id: string) => Promise<void>
  stopRecording: (id: string) => Promise<RecordingResult | null>
  cancelRecording: (id: string) => void
}
function chooseMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ]
  return (
    candidates.find(
      (type) =>
        typeof MediaRecorder !== 'undefined' &&
        MediaRecorder.isTypeSupported(type),
    ) ?? ''
  )
}

/** Owns one reusable microphone stream and produces both a compressed playback blob and true 16 kHz mono PCM. */
export function useButterflyRecorder(): ButterflyRecorder {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const disposedRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const pendingRef = useRef<PendingRecording | null>(null)
  const permissionRef = useRef<Promise<MediaStream> | null>(null)
  const activeRef = useRef<ActiveRecording | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analyserSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const rmsFrameRef = useRef<number | null>(null)
  const urlsRef = useRef<string[]>([])
  const setRecordingRms = useButterflyStore((state) => state.setRecordingRms)

  const stopRmsMeter = useCallback(() => {
    if (rmsFrameRef.current != null) cancelAnimationFrame(rmsFrameRef.current)
    rmsFrameRef.current = null
    analyserSourceRef.current?.disconnect()
    analyserSourceRef.current = null
    analyserRef.current?.disconnect()
    analyserRef.current = null
    audioContextRef.current = null
  }, [])

  const startRmsMeter = useCallback(
    (id: string, stream: MediaStream) => {
      const context = getXRAudioContext()
      if (context?.state !== 'running')
        throw new Error('Audio must be prepared before recording.')
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const values = new Uint8Array(analyser.fftSize)
      analyserRef.current = analyser
      analyserSourceRef.current = source
      audioContextRef.current = context
      const tick = () => {
        if (
          !analyserRef.current ||
          activeIdRef.current !== id ||
          disposedRef.current
        )
          return
        analyser.getByteTimeDomainData(values)
        let sum = 0
        for (let i = 0; i < values.length; i += 1) {
          const sample = (values[i] - 128) / 128
          sum += sample * sample
        }
        setRecordingRms(id, Math.min(1, Math.sqrt(sum / values.length) * 2.4))
        rmsFrameRef.current = requestAnimationFrame(tick)
      }
      tick()
    },
    [setRecordingRms],
  )

  const warmup = useCallback(async () => {
    if (disposedRef.current) throw new Error('Recorder is no longer mounted.')
    if (mountedRef.current) {
      setStatus('warming')
      setError(null)
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Microphone capture is unavailable in this browser.')
      const audioReady = initializeXRAudio()
      if (streamRef.current?.active) {
        await audioReady
        if (mountedRef.current) setStatus('ready')
        return
      }
      let request = permissionRef.current
      if (!request) {
        request = navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        permissionRef.current = request
      }
      const [requestResult, audioResult] = await Promise.allSettled([
        request,
        audioReady,
      ])
      if (requestResult.status === 'rejected') throw requestResult.reason
      const stream = requestResult.value
      if (audioResult.status === 'rejected') {
        stream.getTracks().forEach((track) => {
          track.stop()
        })
        throw audioResult.reason
      }
      if (disposedRef.current) {
        stream.getTracks().forEach((track) => {
          track.stop()
        })
        throw new Error(
          'Recorder was unmounted while requesting microphone permission.',
        )
      }
      streamRef.current = stream
      if (mountedRef.current) setStatus('ready')
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : 'Microphone permission was not granted.'
      if (mountedRef.current) {
        setError(message)
        setStatus('error')
      }
      throw new Error(message)
    } finally {
      permissionRef.current = null
    }
  }, [])

  const startRecording = useCallback(
    async (id: string) => {
      if (
        pendingRef.current ||
        activeRef.current?.recorder.state === 'recording'
      )
        throw new Error('Another recording is already active.')
      useButterflyStore.getState().beginRecording(id)
      const pending: PendingRecording = { id, cancelled: false }
      pendingRef.current = pending
      const hadWarmStream = streamRef.current?.active === true
      try {
        await warmup()
        if (pending.cancelled) {
          if (!hadWarmStream) {
            streamRef.current?.getTracks().forEach((track) => {
              track.stop()
            })
            streamRef.current = null
          }
          if (mountedRef.current)
            setStatus(streamRef.current?.active ? 'ready' : 'idle')
          return
        }
        if (disposedRef.current)
          throw new Error('Recorder is no longer mounted.')
        const stream = streamRef.current
        if (!stream) throw new Error('Microphone is not ready.')
        const context = getXRAudioContext()
        if (context?.state !== 'running')
          throw new Error('Audio must be prepared before recording.')
        const mimeType = chooseMimeType()
        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        )
        const active: ActiveRecording = {
          id,
          recorder,
          chunks: [],
          cancelled: false,
        }
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) active.chunks.push(event.data)
        }
        activeRef.current = active
        activeIdRef.current = id
        recorder.start(120)
        if (mountedRef.current) {
          setError(null)
          setStatus('recording')
        }
        startRmsMeter(id, stream)
      } finally {
        if (pendingRef.current === pending) pendingRef.current = null
      }
    },
    [startRmsMeter, warmup],
  )

  const decodeTo16kMono = useCallback(async (blob: Blob) => {
    const sourceContext = new OfflineAudioContext(1, 1, 16000)
    const decoded = await sourceContext.decodeAudioData(
      await blob.arrayBuffer(),
    )
    const offline = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(decoded.duration * 16000)),
      16000,
    )
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start(0)
    const rendered = await offline.startRendering()
    return new Float32Array(rendered.getChannelData(0))
  }, [])

  const stopRecording = useCallback(
    async (id: string): Promise<RecordingResult | null> => {
      const pending = pendingRef.current
      if (pending?.id === id) {
        pending.cancelled = true
        if (mountedRef.current)
          setStatus(streamRef.current?.active ? 'ready' : 'idle')
        return null
      }
      const active = activeRef.current
      if (!active || active.id !== id || active.recorder.state !== 'recording')
        return null
      activeRef.current = null
      activeIdRef.current = null
      stopRmsMeter()
      setRecordingRms(id, 0)
      if (mountedRef.current) setStatus('processing')
      const { promise, resolve, reject } = Promise.withResolvers<Blob | null>()
      const recorder = active.recorder
      recorder.addEventListener(
        'stop',
        () =>
          resolve(
            active.cancelled
              ? null
              : new Blob(active.chunks, {
                  type: recorder.mimeType || 'audio/webm',
                }),
          ),
        { once: true },
      )
      recorder.addEventListener(
        'error',
        () =>
          reject(new Error('The microphone recorder stopped unexpectedly.')),
        { once: true },
      )
      try {
        recorder.stop()
      } catch (cause) {
        reject(
          cause instanceof Error
            ? cause
            : new Error('The microphone recorder could not stop.'),
        )
      }
      const blob = await promise
      if (!blob) return null
      let audioUrl: string | null = null
      try {
        audioUrl = URL.createObjectURL(blob)
        const pcm16kHz = await decodeTo16kMono(blob)
        if (disposedRef.current) {
          URL.revokeObjectURL(audioUrl)
          return null
        }
        urlsRef.current.push(audioUrl)
        if (mountedRef.current) setStatus('ready')
        return { audioUrl, pcm16kHz }
      } catch (cause) {
        if (audioUrl) URL.revokeObjectURL(audioUrl)
        const message =
          cause instanceof Error
            ? cause.message
            : 'Could not decode the recording.'
        if (mountedRef.current) {
          setError(message)
          setStatus('error')
        }
        throw new Error(message)
      }
    },
    [decodeTo16kMono, setRecordingRms, stopRmsMeter],
  )

  const cancelRecording = useCallback(
    (id: string) => {
      const pending = pendingRef.current
      if (pending?.id === id) {
        pending.cancelled = true
        if (mountedRef.current)
          setStatus(streamRef.current?.active ? 'ready' : 'idle')
        return
      }
      const active = activeRef.current
      if (!active || active.id !== id) return
      active.cancelled = true
      activeRef.current = null
      activeIdRef.current = null
      stopRmsMeter()
      setRecordingRms(id, 0)
      if (active.recorder.state === 'recording') active.recorder.stop()
      if (mountedRef.current)
        setStatus(streamRef.current?.active ? 'ready' : 'idle')
    },
    [setRecordingRms, stopRmsMeter],
  )

  useEffect(() => {
    mountedRef.current = true
    disposedRef.current = false
    return () => {
      mountedRef.current = false
      disposedRef.current = true
      const pending = pendingRef.current
      if (pending) {
        pending.cancelled = true
        pendingRef.current = null
      }
      const active = activeRef.current
      if (active) {
        active.cancelled = true
        if (active.recorder.state === 'recording') active.recorder.stop()
      }
      stopRmsMeter()
      streamRef.current?.getTracks().forEach((track) => {
        track.stop()
      })
      urlsRef.current.forEach((url) => {
        URL.revokeObjectURL(url)
      })
      urlsRef.current = []
    }
  }, [stopRmsMeter])

  return {
    status,
    error,
    warmup,
    startRecording,
    stopRecording,
    cancelRecording,
  }
}
