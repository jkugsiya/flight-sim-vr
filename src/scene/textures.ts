import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  type Texture,
  UnsignedByteType
} from 'three'
import { GRID, HEIGHTS } from '../world/island'
import { seededRandom } from '../world/noise'

const smooth = (t: number) => t * t * (3 - 2 * t)

/** Layered value noise from 0 to 1 that repeats seamlessly at the edges. */
function tileableNoise(size: number, seed: number, cells: number, octaves: number) {
  const random = seededRandom(seed)
  const out = new Float32Array(size * size)
  let amplitude = 1
  let total = 0
  for (let octave = 0; octave < octaves; octave++) {
    const lattice = new Float32Array(cells * cells)
    for (let i = 0; i < lattice.length; i++) lattice[i] = random()
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * cells
      const iy = Math.floor(gy)
      const fy = smooth(gy - iy)
      const row0 = iy * cells
      const row1 = ((iy + 1) % cells) * cells
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells
        const ix = Math.floor(gx)
        const fx = smooth(gx - ix)
        const ix1 = (ix + 1) % cells
        const top = lattice[row0 + ix] + (lattice[row0 + ix1] - lattice[row0 + ix]) * fx
        const bottom = lattice[row1 + ix] + (lattice[row1 + ix1] - lattice[row1 + ix]) * fx
        out[y * size + x] += (top + (bottom - top) * fy) * amplitude
      }
    }
    total += amplitude
    amplitude *= 0.5
    cells *= 2
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(1, Math.max(0, (out[i] / total - 0.5) * 1.7 + 0.5))
  }
  return out
}

/**
 * Seamless detail texture used by the terrain and the sea.
 * Red and green hold a surface normal, blue and alpha hold two independent noise patterns.
 */
function makeDetailTexture() {
  const size = 256
  const bumps = tileableNoise(size, 101, 4, 6)
  const patches = tileableNoise(size, 202, 3, 5)
  const data = new Uint8Array(size * size * 4)
  const at = (x: number, y: number) => bumps[((y + size) % size) * size + ((x + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 5
      const dy = (at(x, y + 1) - at(x, y - 1)) * 5
      const length = Math.hypot(dx, dy, 1)
      const pixel = (y * size + x) * 4
      data[pixel] = (-dx / length) * 127.5 + 127.5
      data[pixel + 1] = (-dy / length) * 127.5 + 127.5
      data[pixel + 2] = bumps[y * size + x] * 255
      data[pixel + 3] = patches[y * size + x] * 255
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

/** Water depth in metres that the depth texture can hold. */
export const MAX_DEPTH = 40

/**
 * Sea depth over the terrain grid, one texel per grid corner.
 * Stores the square root of depth so shallows keep centimetre precision.
 */
function makeDepthTexture() {
  const data = new Uint8Array(HEIGHTS.length)
  for (let i = 0; i < HEIGHTS.length; i++) {
    data[i] = Math.sqrt(Math.min(MAX_DEPTH, Math.max(0, -HEIGHTS[i])) / MAX_DEPTH) * 255
  }
  const texture = new DataTexture(data, GRID + 1, GRID + 1, RedFormat, UnsignedByteType)
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

export const detailTexture = makeDetailTexture()
export const depthTexture = makeDepthTexture()

let puff: Texture | null = null

/** Soft, lumpy white blob used for clouds, smoke, dust, and fire. */
export function puffTexture() {
  if (puff) return puff
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Smoke and cloud textures need a 2D canvas, which this browser refused')
  const random = seededRandom(303)
  for (let i = 0; i < 46; i++) {
    const angle = random() * Math.PI * 2
    const reach = random() ** 0.7 * 30
    const x = size / 2 + Math.cos(angle) * reach
    const y = size / 2 + Math.sin(angle) * reach
    const radius = 12 + random() * 20
    const blob = ctx.createRadialGradient(x, y, 0, x, y, radius)
    blob.addColorStop(0, 'rgba(255,255,255,0.42)')
    blob.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = blob
    ctx.fillRect(0, 0, size, size)
  }
  puff = new CanvasTexture(canvas)
  return puff
}
