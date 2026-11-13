import type { ThreeEvent } from '@react-three/fiber'
import { isXRInputSourceState } from '@react-three/xr'
import { type ReactNode, useEffect, useRef } from 'react'

const hovered = new WeakMap<XRInputSource, Set<number>>()

export function isXRUIHovered(source: XRInputSource) {
  return (hovered.get(source)?.size ?? 0) > 0
}

/** Share library pointer ownership with the custom gesture solver; never raycast UI twice. */
export function XRUIInteractionBoundary({ children }: { children: ReactNode }) {
  const pointers = useRef(new Map<number, XRInputSource>())
  const leave = (event: ThreeEvent<PointerEvent>) => {
    const source = pointers.current.get(event.pointerId)
    if (!source) return
    hovered.get(source)?.delete(event.pointerId)
    pointers.current.delete(event.pointerId)
  }
  useEffect(() => {
    const owned = pointers.current
    return () => {
      for (const [pointerId, source] of owned)
        hovered.get(source)?.delete(pointerId)
      owned.clear()
    }
  }, [])
  return (
    <group
      onPointerEnter={(event) => {
        const state = 'pointerState' in event ? event.pointerState : undefined
        if (!isXRInputSourceState(state)) return
        let ids = hovered.get(state.inputSource)
        if (!ids) {
          ids = new Set()
          hovered.set(state.inputSource, ids)
        }
        ids.add(event.pointerId)
        pointers.current.set(event.pointerId, state.inputSource)
      }}
      onPointerLeave={leave}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </group>
  )
}
