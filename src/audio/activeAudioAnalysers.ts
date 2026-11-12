import type * as THREE from 'three'

/** Mutable audio plane registry sampled by the single ECS frame owner. */
export const activeAudioAnalysers = new Map<string, THREE.AudioAnalyser>()
