import { Vector3 } from 'three'
import type { RoomGeometry, Vec3 } from '../protocol'
import { RoomCollider } from '../xr-systems/roomGeometry'

function squared(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sum = 0
  for (let d = 0; d < a.length; d++) sum += (a[d] - b[d]) ** 2
  return sum
}

/** Adopted EMA mini-batch quantizer, not a claimed reference Meta implementation.
 * Two deterministic passes, cosine-decayed step, farthest-point seeding, empty-cluster
 * revival, final assigned means. Medoid projection keeps every returned perch in free space.
 */
export function runEMeans(points: Vec3[], k: number): Vec3[] {
  if (!points.length || k <= 0) return []
  k = Math.min(k, points.length)
  const centers: Vec3[] = [points[0].slice() as Vec3]
  while (centers.length < k) {
    let farthest = points[0],
      distance = -1
    for (const point of points) {
      const nearest = Math.min(
        ...centers.map((center) => squared(point, center)),
      )
      if (nearest > distance) {
        farthest = point
        distance = nearest
      }
    }
    centers.push(farthest.slice() as Vec3)
  }
  const weights = new Float64Array(k).fill(1e-6)
  const sums = centers.map((center) => center.map((value) => value * 1e-6))
  const batchSize = Math.min(
    points.length,
    Math.max(16, Math.ceil(Math.sqrt(points.length * k))),
  )
  const steps = 2 * Math.ceil(points.length / batchSize)
  let step = 0
  const nearest = (point: Vec3) => {
    let winner = 0,
      distance = Infinity
    for (let j = 0; j < k; j++) {
      const d = squared(point, centers[j])
      if (d < distance) {
        distance = d
        winner = j
      }
    }
    return winner
  }
  for (let epoch = 0; epoch < 2; epoch++)
    for (let start = 0; start < points.length; start += batchSize) {
      const counts = new Float64Array(k)
      const batch = Array.from({ length: k }, () => [0, 0, 0])
      for (let i = start; i < Math.min(start + batchSize, points.length); i++) {
        // Coprime cyclic ordering changes batches without nondeterministic shuffling.
        const point = points[epoch ? points.length - 1 - i : i]
        const j = nearest(point)
        counts[j]++
        for (let d = 0; d < 3; d++) batch[j][d] += point[d]
      }
      const alpha =
        0.5 * (0.1 + (0.9 * (1 + Math.cos((Math.PI * ++step) / steps))) / 2)
      for (let j = 0; j < k; j++) {
        weights[j] = (1 - alpha) * weights[j] + alpha * counts[j]
        for (let d = 0; d < 3; d++) {
          sums[j][d] = (1 - alpha) * sums[j][d] + alpha * batch[j][d]
          centers[j][d] = sums[j][d] / weights[j]
        }
      }
    }
  const counts = new Uint32Array(k)
  const final = Array.from({ length: k }, (): Vec3 => [0, 0, 0])
  for (const point of points) {
    const j = nearest(point)
    counts[j]++
    for (let d = 0; d < 3; d++) final[j][d] += point[d]
  }
  const used = new Set<Vec3>()
  return final.map((sum, j) => {
    const mean = counts[j] ? sum.map((value) => value / counts[j]) : centers[j]
    let best: Vec3 | undefined,
      distance = Infinity
    for (const point of points)
      if (!used.has(point)) {
        const d = squared(point, mean)
        if (d < distance) {
          best = point
          distance = d
        }
      }
    if (!best) throw new Error('Unable to select a distinct cluster center.')
    used.add(best)
    return [best[0], best[1], best[2]]
  })
}

function radicalInverse(index: number, base: number) {
  let value = 0,
    fraction = 1 / base
  while (index) {
    value += (index % base) * fraction
    index = Math.floor(index / base)
    fraction /= base
  }
  return value
}

export class RoomQuantizer {
  private collider = new RoomCollider()
  private samples: Vec3[] = []
  private geometry: RoomGeometry | null = null
  private coldOffsets = new Map<string, Vec3>()
  private coldIndex = 0

  setRoom(geometry: RoomGeometry) {
    this.geometry = geometry
    this.collider.setGeometry(geometry)
    this.samples = []
    // No invented desktop volume: require a measured floor or viewer-containing closed enclosure.
    if (
      !geometry.bounds ||
      (!geometry.floorPolygon && !this.collider.hasEnclosure)
    )
      return
    const bounds = geometry.bounds
    const minY =
      geometry.floorY === null ? bounds.min[1] + 0.15 : geometry.floorY + 0.8
    const maxY = Math.min(
      bounds.max[1] - 0.15,
      geometry.floorY === null ? bounds.max[1] : geometry.floorY + 2,
    )
    if (maxY <= minY) return
    const point = new Vector3()
    for (let i = 1; i <= 12000 && this.samples.length < 1600; i++) {
      point.set(
        bounds.min[0] + radicalInverse(i, 2) * (bounds.max[0] - bounds.min[0]),
        minY + radicalInverse(i, 3) * (maxY - minY),
        bounds.min[2] + radicalInverse(i, 5) * (bounds.max[2] - bounds.min[2]),
      )
      if (this.collider.isFree(point, 0.15))
        this.samples.push([point.x, point.y, point.z])
    }
  }

  fit(raw: Vec3[], origins: Vec3[], ids: string[]): Vec3[] {
    const active = new Set(ids)
    for (const id of this.coldOffsets.keys())
      if (!active.has(id)) this.coldOffsets.delete(id)
    if (!this.samples.length) {
      if (this.geometry?.floorPolygon)
        throw new Error(
          'The scanned floor has no valid free-space perches with the configured clearance.',
        )
      // Explicitly unscanned virtual layout, not a fabricated collision container.
      // Small-N physical separation is outside raw PCA and carries no semantic claim.
      return raw.map((point, index) => {
        let offset = this.coldOffsets.get(ids[index])
        if (!offset) {
          const phase = this.coldIndex++ * 2.399963229728653
          offset = [
            Math.cos(phase) * 0.12,
            Math.sin(phase * 0.7) * 0.06,
            Math.sin(phase) * 0.12,
          ]
          this.coldOffsets.set(ids[index], offset)
        }
        const target = new Vector3(
          ...(point.map(
            (value, axis) =>
              origins[index][axis] +
              value * 0.6 +
              (raw.length < 4 ? offset?.[axis] : 0),
          ) as Vec3),
        )
        const safe = new Vector3()
        if (!this.collider.recoverPosition(target, safe, 0.15))
          throw new Error(
            'No valid target remains in the observed room geometry.',
          )
        return [safe.x, safe.y, safe.z]
      })
    }
    const perches = runEMeans(this.samples, raw.length)
    const bounds = this.geometry?.bounds
    if (!bounds) throw new Error('Room bounds are unavailable.')
    const used = new Set<number>()
    return raw.map((point) => {
      const mapped = point.map(
        (value, d) =>
          (bounds.min[d] + bounds.max[d]) / 2 +
          value * (bounds.max[d] - bounds.min[d]) * 0.4,
      )
      let winner = -1,
        distance = Infinity
      for (let i = 0; i < perches.length; i++)
        if (!used.has(i)) {
          const d = squared(mapped, perches[i])
          if (d < distance) {
            distance = d
            winner = i
          }
        }
      if (winner < 0) {
        // More notes than distinct free samples may share a perch; never return an invalid point.
        for (let i = 0; i < perches.length; i++) {
          const d = squared(mapped, perches[i])
          if (d < distance) {
            distance = d
            winner = i
          }
        }
      }
      used.add(winner)
      return perches[winner]
    })
  }
}
