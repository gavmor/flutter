import { useThree } from '@react-three/fiber'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

const XRAudioListenerContext = createContext<THREE.AudioListener | null>(null)

type XRAudioState = { context: AudioContext | null }

const audioContextStore = createStore<XRAudioState>(() => ({ context: null }))
let resumePromise: Promise<void> | null = null
function resumeAudioContext(context: AudioContext): Promise<void> {
  if (context.state === 'running') return Promise.resolve()
  if (!resumePromise) {
    resumePromise = context.resume().finally(() => {
      resumePromise = null
    })
  }
  return resumePromise.then(() => {
    if (context.state !== 'running')
      throw new Error('The browser did not resume Web Audio.')
  })
}

/**
 * Initializes Three's shared realtime context synchronously from a user
 * gesture. The returned promise tracks resuming that already-created context.
 */
export async function initializeXRAudio(): Promise<void> {
  if (typeof window === 'undefined')
    throw new Error('Audio is unavailable outside a browser.')
  const context =
    audioContextStore.getState().context ?? THREE.AudioContext.getContext()
  if (!audioContextStore.getState().context)
    audioContextStore.setState({ context })
  await resumeAudioContext(context)
}

export function getXRAudioContext() {
  return audioContextStore.getState().context
}

export function XRAudioListenerProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { camera } = useThree()
  const audioContext = useStore(audioContextStore, (state) => state.context)
  const [listener, setListener] = useState<THREE.AudioListener | null>(null)
  const listenerRef = useRef<THREE.AudioListener | null>(null)

  useEffect(() => {
    if (!audioContext || listenerRef.current) return
    const ownedListener = new THREE.AudioListener()
    listenerRef.current = ownedListener
    setListener(ownedListener)
    return () => {
      if (listenerRef.current !== ownedListener) return
      listenerRef.current = null
      setListener(null)
      ownedListener.removeFromParent()
      ownedListener.gain.disconnect()
    }
  }, [audioContext])

  useEffect(() => {
    if (!listener) return
    camera.add(listener)
    return () => {
      camera.remove(listener)
    }
  }, [camera, listener])

  return (
    <XRAudioListenerContext.Provider value={listener}>
      {children}
    </XRAudioListenerContext.Provider>
  )
}

export function useXRAudioListener() {
  return useContext(XRAudioListenerContext)
}

export async function resumeXRAudio(listener: THREE.AudioListener | null) {
  if (!listener)
    throw new Error('Audio has not been initialized by a user gesture.')
  await resumeAudioContext(listener.context)
}
