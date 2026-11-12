import type { Vector3 } from 'three'
import type { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js'

/** Curl of a three-channel Perlin vector potential, central-differenced without allocations. */
export function sampleCurlNoise(
  noise: ImprovedNoise,
  position: Vector3,
  time: number,
  out: Vector3,
) {
  const h = 0.01
  const x = position.x * 0.8 + time * 0.15,
    y = position.y * 0.8,
    z = position.z * 0.8
  const dAzdy =
    (noise.noise(x + 71, y + h, z) - noise.noise(x + 71, y - h, z)) / (2 * h)
  const dAydz =
    (noise.noise(x + 31, y, z + h) - noise.noise(x + 31, y, z - h)) / (2 * h)
  const dAxdz = (noise.noise(x, y, z + h) - noise.noise(x, y, z - h)) / (2 * h)
  const dAzdx =
    (noise.noise(x + 71 + h, y, z) - noise.noise(x + 71 - h, y, z)) / (2 * h)
  const dAydx =
    (noise.noise(x + 31 + h, y, z) - noise.noise(x + 31 - h, y, z)) / (2 * h)
  const dAxdy = (noise.noise(x, y + h, z) - noise.noise(x, y - h, z)) / (2 * h)
  return out.set(dAzdy - dAydz, dAxdz - dAzdx, dAydx - dAxdy)
}
