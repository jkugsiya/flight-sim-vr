// Seeded 2D gradient noise for terrain generation.

const GRADIENT_COUNT = 256
const gradientX = new Float32Array(GRADIENT_COUNT)
const gradientY = new Float32Array(GRADIENT_COUNT)
for (let i = 0; i < GRADIENT_COUNT; i++) {
  const angle = (i / GRADIENT_COUNT) * Math.PI * 2
  gradientX[i] = Math.cos(angle)
  gradientY[i] = Math.sin(angle)
}

function hash(ix: number, iy: number, seed: number) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

function corner(ix: number, iy: number, dx: number, dy: number, seed: number) {
  const g = hash(ix, iy, seed) % GRADIENT_COUNT
  return gradientX[g] * dx + gradientY[g] * dy
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/** Gradient noise in about -1 to 1. */
export function noise2(x: number, y: number, seed: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const u = fade(fx)
  const top = corner(ix, iy, fx, fy, seed)
  const bottom = corner(ix, iy + 1, fx, fy - 1, seed)
  const topRow = top + (corner(ix + 1, iy, fx - 1, fy, seed) - top) * u
  const bottomRow = bottom + (corner(ix + 1, iy + 1, fx - 1, fy - 1, seed) - bottom) * u
  return (topRow + (bottomRow - topRow) * fade(fy)) * Math.SQRT2
}

/** Layered noise in about -1 to 1. Each octave doubles the detail and halves the strength. */
export function fbm(x: number, y: number, octaves: number, seed: number) {
  let sum = 0
  let amplitude = 1
  let total = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, y, seed + i) * amplitude
    total += amplitude
    amplitude *= 0.5
    x *= 2
    y *= 2
  }
  return sum / total
}

/** Layered noise from 0 to 1 with sharp crests, for mountain ridges. */
export function ridged(x: number, y: number, octaves: number, seed: number) {
  let sum = 0
  let amplitude = 1
  let total = 0
  for (let i = 0; i < octaves; i++) {
    const crest = 1 - Math.abs(noise2(x, y, seed + i))
    sum += crest * crest * amplitude
    total += amplitude
    amplitude *= 0.5
    x *= 2
    y *= 2
  }
  return sum / total
}

/** Small deterministic random number generator returning values from 0 to 1. */
export function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
