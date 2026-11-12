export type Vec3 = [number, number, number]
export type RoomStatus = 'unscanned' | 'partial' | 'scanned'
interface RoomBounds {
  min: Vec3
  max: Vec3
}
/** World-space surface triangles; a mesh AABB is never a solid obstacle. */
export interface RoomSurfaceData {
  id: string
  kind: 'plane' | 'mesh'
  label: string
  triangles: Float32Array
  closed: boolean
  localBounds?: RoomBounds
  worldMatrix?: number[]
}
export interface RoomGeometry {
  revision: number
  status: RoomStatus
  floorY: number | null
  floorPolygon: Vec3[] | null
  bounds: RoomBounds | null
  viewer: Vec3
  surfaces: RoomSurfaceData[]
}
export interface ProjectedNote {
  id: string
  pcaTarget: Vec3
  semanticColorHSL: Vec3
  neighbors: string[]
}
export type WorkerRequest =
  | { type: 'INIT' }
  | {
      type: 'PROCESS_AUDIO'
      id: string
      audio: Float32Array
      sampleRate: 16000
      origin: Vec3
    }
  | { type: 'PROCESS_TEXT'; id: string; text: string; origin: Vec3 }
  | { type: 'SET_ROOM'; geometry: RoomGeometry }
  | { type: 'REMOVE_NOTE'; id: string }
  | { type: 'DISPOSE' }
export type WorkerResponse =
  | { type: 'STATUS'; stage: string; progress: number }
  | { type: 'READY'; embeddingModel: string; dimensions: 384 }
  | {
      type: 'ERROR'
      scope: 'model' | 'note' | 'room'
      id?: string
      message: string
    }
  | {
      type: 'NOTE_PROCESSED'
      id: string
      text: string
      projectedNotes: ProjectedNote[]
    }
  | { type: 'TARGETS_UPDATED'; projectedNotes: ProjectedNote[] }
