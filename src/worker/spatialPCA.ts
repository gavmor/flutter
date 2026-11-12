import {
  EigenvalueDecomposition,
  Matrix,
  SingularValueDecomposition,
} from 'ml-matrix'
import type { Vec3 } from '../protocol'

export interface EmbeddedNote {
  id: string
  vector: Float32Array
}

/** Row-vector convention: C=AᵀB=UΣVᵀ, so the minimizer of ||AQ-B|| is UVᵀ. */
export function alignProcrustes(source: Vec3[], reference: Vec3[]): Matrix {
  const a = new Matrix(source)
  const b = new Matrix(reference)
  const c = a.transpose().mmul(b)
  // Resolve unconstrained null-space axes toward identity without changing meaningful axes.
  const scale = Math.max(1, c.norm()) * 1e-12
  for (let axis = 0; axis < 3; axis++)
    c.set(axis, axis, c.get(axis, axis) + scale)
  const svd = new SingularValueDecomposition(c)
  return svd.leftSingularVectors.mmul(svd.rightSingularVectors.transpose())
}

/** Dual Gram PCA retains only N×N decomposition work when N≪384. */
export class StabilizedDualPCA {
  private previous = new Map<string, Vec3>()

  project(notes: EmbeddedNote[]): Vec3[] {
    if (!notes.length) {
      this.previous.clear()
      return []
    }
    const n = notes.length
    const dimensions = notes[0].vector.length
    if (
      !dimensions ||
      notes.some(
        (note) =>
          note.vector.length !== dimensions ||
          !note.vector.every(Number.isFinite),
      )
    ) {
      throw new Error('PCA requires equal, finite embedding vectors.')
    }
    const mean = new Float64Array(dimensions)
    for (const note of notes)
      for (let d = 0; d < dimensions; d++) mean[d] += note.vector[d] / n
    const centered = notes.map((note) =>
      Float64Array.from(note.vector, (value, d) => value - mean[d]),
    )
    const gram = Matrix.zeros(n, n)
    for (let i = 0; i < n; i++)
      for (let j = i; j < n; j++) {
        let dot = 0
        for (let d = 0; d < dimensions; d++)
          dot += centered[i][d] * centered[j][d]
        gram.set(i, j, dot)
        gram.set(j, i, dot)
      }
    const evd = new EigenvalueDecomposition(gram, { assumeSymmetric: true })
    const order = evd.realEigenvalues
      .map((value, index) => ({ value, index }))
      .sort((a, b) => b.value - a.value)
    const tolerance = Math.max(1e-12, (order[0]?.value ?? 0) * 1e-10)
    const coordinates: Vec3[] = notes.map(() => [0, 0, 0])
    for (let axis = 0; axis < Math.min(3, n); axis++) {
      const eigen = order[axis]
      if (eigen.value <= tolerance) continue
      // Canonical sign by largest loading, independent of input insertion order.
      let pivot = 0
      for (let i = 1; i < n; i++) {
        const candidate = Math.abs(evd.eigenvectorMatrix.get(i, eigen.index))
        const current = Math.abs(evd.eigenvectorMatrix.get(pivot, eigen.index))
        if (
          candidate > current + 1e-12 ||
          (Math.abs(candidate - current) < 1e-12 &&
            notes[i].id < notes[pivot].id)
        )
          pivot = i
      }
      const sign = evd.eigenvectorMatrix.get(pivot, eigen.index) < 0 ? -1 : 1
      for (let i = 0; i < n; i++)
        coordinates[i][axis] =
          evd.eigenvectorMatrix.get(i, eigen.index) *
          Math.sqrt(eigen.value) *
          sign
    }
    let radius = 0
    for (const point of coordinates)
      radius = Math.max(radius, Math.hypot(...point))
    if (radius > 1e-9)
      for (const point of coordinates)
        for (let axis = 0; axis < 3; axis++) point[axis] /= radius
    // Coincident embeddings remain coincident; room quantization/repulsion supplies physical separation.
    const shared = notes
      .map((note, index) => ({ index, previous: this.previous.get(note.id) }))
      .filter((item) => item.previous !== undefined)
    if (shared.length && radius > 1e-9) {
      const previous = shared.map((item) => item.previous)
      if (previous.some((point): point is undefined => point === undefined))
        throw new Error('Shared PCA history is incomplete.')
      const q = alignProcrustes(
        shared.map((item) => coordinates[item.index]),
        previous as Vec3[],
      )
      for (const point of coordinates) {
        const [x, y, z] = point
        for (let axis = 0; axis < 3; axis++)
          point[axis] =
            x * q.get(0, axis) + y * q.get(1, axis) + z * q.get(2, axis)
      }
    }
    this.previous = new Map(
      notes.map((note, index) => [note.id, coordinates[index].slice() as Vec3]),
    )
    return coordinates
  }
}
