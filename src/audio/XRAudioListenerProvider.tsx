import { useThree } from '@react-three/fiber'
import { createContext, useContext, useEffect, useState } from 'react'
import * as THREE from 'three'

const XRAudioListenerContext = createContext<THREE.AudioListener | null>(null)

export function XRAudioListenerProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { camera } = useThree()
  const [listener, setListener] = useState<THREE.AudioListener | null>(null)

  useEffect(() => {
    // Three owns a browser-wide AudioContext singleton. Own only this listener's gain.
    const ownedListener = new THREE.AudioListener()
    setListener(ownedListener)
    return () => {
      ownedListener.removeFromParent()
      ownedListener.gain.disconnect()
    }
  }, [])

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
  if (listener?.context.state === 'suspended') await listener.context.resume()
}
