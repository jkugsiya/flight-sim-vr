import { Vector3 } from 'three'
import type { FlightSim } from '../sim/flight-sim'
import { heightAt } from '../world/island'
import { seededRandom } from '../world/noise'
import { WEATHER } from '../world/weather'

/**
 * A microburst: a column of sinking air that spreads out along the ground. Flying through
 * it gives a headwind, then a downdraft, then a tailwind, each robbing the aircraft of lift.
 */
export type Microburst = {
  x: number
  z: number
  /** Radius of the sinking core in metres. */
  radius: number
  /** Strongest outflow in m/s, about 60 m above the ground just outside the core. */
  outflow: number
  /** Height above the ground in metres where the downdraft fades out. */
  ceiling: number
}

/** A thunderstorm: a cumulonimbus tower with an anvil top, rain shafts, and a downburst. */
export type StormCell = {
  x: number
  z: number
  /** Radius of the rough, raining core in metres. */
  radius: number
  /** Height of the anvil top in metres. */
  top: number
  burst: Microburst
}

const cell = (x: number, z: number, radius: number, top: number): StormCell => ({
  x,
  z,
  radius,
  top,
  burst: { x, z, radius: radius * 0.6, outflow: 8, ceiling: 6000 }
})

/** Storm cells in Storm weather, placed clear of every final approach so a pilot can fly around them. */
export const STORM_CELLS: StormCell[] = [
  // North-west of Coral Bay, in sight on the approach to runway 09
  cell(-7000, -13_500, 2200, 9500),
  // Between Ridge Field and Mango Creek, south-east of the main island's airports
  cell(9500, 6500, 2000, 8800),
  // On the way from Coral Bay to Northgate
  cell(-17_500, -19_000, 2400, 10_000),
  // Between Eastmark and Cape Verity
  cell(22_000, 27_000, 2300, 9200)
]

// Microburst shape: the outflow is deepest at OUTFLOW_DEPTH and slowed by the ground within
// SURFACE_LAYER metres, as in the Oseguera and Bowles model
const OUTFLOW_DEPTH = 220
const SURFACE_LAYER = 25
const layer = (height: number) =>
  Math.exp(-height / OUTFLOW_DEPTH) - Math.exp(-height / SURFACE_LAYER)
// Height-integrated layer, for the downdraft that feeds the outflow
const layerBelow = (height: number) =>
  OUTFLOW_DEPTH * (1 - Math.exp(-height / OUTFLOW_DEPTH)) -
  SURFACE_LAYER * (1 - Math.exp(-height / SURFACE_LAYER))
const LAYER_PEAK = layer(
  (Math.log(OUTFLOW_DEPTH / SURFACE_LAYER) * OUTFLOW_DEPTH * SURFACE_LAYER) /
    (OUTFLOW_DEPTH - SURFACE_LAYER)
)
// Peak of (1 - e^-x²) / x, at about 1.12 core radii
const SPREAD_PEAK = 0.6382

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Adds a microburst's wind at a point `height` metres above the ground to `out`.
 * The downdraft and the outflow conserve mass, so the air that sinks in the core spreads out.
 */
export function addMicroburst(
  burst: Microburst,
  x: number,
  height: number,
  z: number,
  out: Vector3
) {
  const dx = x - burst.x
  const dz = z - burst.z
  const distance = Math.hypot(dx, dz)
  const r = distance / burst.radius
  if (r > 6) return
  const h = Math.max(height, 0)
  const core = Math.exp(-r * r)
  // Far from the core the outflow dies away instead of trailing off for kilometres
  const reach = Math.exp(-((r / 3) ** 4))
  const spread = r > 1e-3 ? (1 - core) / r / SPREAD_PEAK : 0
  const outward = (burst.outflow * spread * reach * layer(h)) / LAYER_PEAK
  if (distance > 1e-3) {
    out.x += (dx / distance) * outward
    out.z += (dz / distance) * outward
  }
  const aloft = 1 - smoothstep(burst.ceiling * 0.6, burst.ceiling, h)
  out.y -=
    ((2 * burst.outflow) / (SPREAD_PEAK * burst.radius * LAYER_PEAK)) * core * layerBelow(h) * aloft
}

/**
 * How deep a point is in a storm cell's core: 1 in the heart, 0 outside. `halo` reaches
 * farther, for the rough air around a cell.
 */
function cellDepth(storm: StormCell, x: number, y: number, z: number, halo: boolean) {
  const distance = Math.hypot(x - storm.x, z - storm.z)
  const across = halo
    ? 1 - smoothstep(storm.radius * 0.6, storm.radius * 2, distance)
    : 1 - smoothstep(storm.radius * 0.55, storm.radius, distance)
  return across * (1 - smoothstep(storm.top - 1500, storm.top, y))
}

/** Depth inside the nearest storm cell's core at a point, 0 to 1, for the dark cloud inside. */
export function insideCell(x: number, y: number, z: number) {
  let deepest = 0
  for (const storm of STORM_CELLS) deepest = Math.max(deepest, cellDepth(storm, x, y, z, false))
  return deepest
}

// Gust strength (standard deviation in m/s of the vertical gust) everywhere in a storm, extra
// in and around a cell, and extra around a microburst
const STORM_GUSTS = 0.8
const CELL_GUSTS = 3
const BURST_GUSTS = 1.2
// Longest gust in metres, the Dryden model's scale above 1,000 ft
const GUST_SCALE = 530
// Seconds of smoothing for gusts shorter than the aircraft, which the wing averages out
const GUST_BLUR = 0.35
const FEET = 3.28084
const SQRT3 = Math.sqrt(3)

/**
 * Random gusts with the Dryden spectrum: each axis is filtered noise whose length scale and
 * strength follow the height above the ground. Longitudinal gusts lie along the ground track,
 * lateral across it. Deterministic for a given seed.
 */
export class Turbulence {
  /** The current gust in m/s, in world axes. */
  readonly gust = new Vector3()
  private readonly raw = new Vector3()
  private random = seededRandom(1)
  private spare: number | null = null
  private along = 0
  private across = [0, 0]
  private up = [0, 0]

  reset(seed: number) {
    this.random = seededRandom(seed)
    this.spare = null
    this.along = 0
    this.across = [0, 0]
    this.up = [0, 0]
    this.gust.set(0, 0, 0)
    this.raw.set(0, 0, 0)
  }

  /**
   * Advances the gusts by `dt` seconds for an aircraft flying at `velocity` (m/s, world axes),
   * `airspeed` m/s, `height` metres above the ground, in gusts of strength `sigma` m/s.
   */
  update(dt: number, velocity: Vector3, airspeed: number, height: number, sigma: number) {
    if (dt <= 0) return
    // Near the ground gusts are shorter, and stronger along the wind than up and down
    const feet = Math.max(height * FEET, 10)
    const low = feet < 1000
    const base = 0.177 + 0.000823 * feet
    const scaleUp = low ? Math.max(feet / FEET, 20) : GUST_SCALE
    const scaleSide = low ? Math.min(feet / base ** 1.2 / FEET, GUST_SCALE) : GUST_SCALE
    const sideSigma = low ? sigma / base ** 0.4 : sigma
    const speed = Math.max(airspeed, 20)
    const along = this.firstOrder(this.along, dt, scaleSide / speed)
    this.along = along
    const across = this.secondOrder(this.across, dt, scaleSide / speed)
    const up = this.secondOrder(this.up, dt, scaleUp / speed)
    // Turn the along and across gusts from the ground track into world axes
    const ground = Math.hypot(velocity.x, velocity.z)
    const tx = ground > 1 ? velocity.x / ground : 1
    const tz = ground > 1 ? velocity.z / ground : 0
    const u = along * sideSigma
    const v = across * sideSigma
    this.raw.set(tx * u - tz * v, up * sigma, tz * u + tx * v)
    this.gust.lerp(this.raw, 1 - Math.exp(-dt / GUST_BLUR))
  }

  /** One step of unit-variance noise low-passed over `tau` seconds. */
  private firstOrder(state: number, dt: number, tau: number) {
    const keep = Math.exp(-dt / tau)
    return state * keep + Math.sqrt(1 - keep * keep) * this.normal()
  }

  /**
   * One step of the Dryden lateral and vertical shape, (1 + √3 τs) / (1 + τs)², built from two
   * chained low-pass filters. Returns a unit-variance gust.
   */
  private secondOrder(state: number[], dt: number, tau: number) {
    const keep = Math.exp(-dt / tau)
    state[0] = state[0] * keep + Math.sqrt(1 - keep * keep) * this.normal()
    state[1] = state[1] * keep + (1 - keep) * state[0]
    // The pair has a variance of 2, so scale back to 1
    return (state[1] + SQRT3 * (state[0] - state[1])) / Math.SQRT2
  }

  /** Normally distributed random number, by the Box-Muller method. */
  private normal() {
    if (this.spare !== null) {
      const value = this.spare
      this.spare = null
      return value
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(this.random(), 1e-9)))
    const angle = 2 * Math.PI * this.random()
    this.spare = radius * Math.sin(angle)
    return radius * Math.cos(angle)
  }
}

// Windshear alert thresholds on the smoothed F-factor, and how long it averages over
const SHEAR_WARN = 0.1
const SHEAR_CLEAR = 0.04
const SHEAR_SMOOTHING = 1.5
// The alert only sounds below this height in metres (1,500 ft), as in a real reactive system
const SHEAR_CEILING = 457

/**
 * Reactive windshear detection. The F-factor is the share of g the shear takes from the
 * aircraft's energy: a growing tailwind plus a downdraft divided by the airspeed. Above 0.1
 * it calls WINDSHEAR, and the call holds until the shear has eased for a few seconds.
 */
export class ShearDetector {
  warning = false
  /** Smoothed F-factor. Positive when the shear costs energy. */
  factor = 0
  private readonly last = new Vector3()
  private primed = false
  private calm = 0

  reset() {
    this.warning = false
    this.factor = 0
    this.primed = false
    this.calm = 0
  }

  /** `shear` is the steady storm wind at the aircraft, without random gusts. */
  update(dt: number, sim: FlightSim, shear: Vector3) {
    if (dt <= 0) return
    if (!this.primed) {
      this.last.copy(shear)
      this.primed = true
      return
    }
    const ground = Math.hypot(sim.velocity.x, sim.velocity.z)
    const tx = ground > 1 ? sim.velocity.x / ground : 0
    const tz = ground > 1 ? sim.velocity.z / ground : 0
    // A rising tailwind costs airspeed; sinking air costs height
    const tailwindRate = ((shear.x - this.last.x) * tx + (shear.z - this.last.z) * tz) / dt
    this.last.copy(shear)
    const raw = tailwindRate / 9.81 - shear.y / Math.max(sim.trueAirspeed, 30)
    this.factor += (raw - this.factor) * Math.min(1, dt / SHEAR_SMOOTHING)
    const low = !sim.onGround && sim.altitudeAgl < SHEAR_CEILING
    if (low && this.factor > SHEAR_WARN) {
      this.warning = true
      this.calm = 0
    } else if (this.warning) {
      this.calm = this.factor < SHEAR_CLEAR ? this.calm + dt : 0
      if (!low || this.calm > 2) this.warning = false
    }
  }
}

// Mean seconds between lightning flashes, and the shortest gap
const FLASH_GAP = 6
const FLASH_MIN_GAP = 1.2
// Seconds each return stroke takes to fade
const STROKE_FADE = 0.07
// Segments in the longest bolt, main channel and branches together
export const BOLT_SEGMENTS = 220
// Flashes farther than this from the pilot are too faint to light the scene
const FLASH_RANGE = 16_000

/**
 * Lightning around the pilot in Storm weather: flashes inside the cloud, and now and then a
 * bolt to the ground or sea. Most strike in the nearest storm cell. Each flash flickers with
 * a few return strokes.
 */
export class Lightning {
  /** Brightness of the flash lighting the scene, 0 to about 1. */
  flash = 0
  /** Brightness of the visible bolt, 0 when there is none. */
  glow = 0
  /** Bolt segments: start x, y, z, end x, y, z, and width share, per segment. */
  readonly bolt = new Float32Array(BOLT_SEGMENTS * 7)
  segments = 0
  /** Changes with every new bolt, so the scene knows to rebuild it. */
  version = 0
  /** Where the latest flash struck, for the thunder. */
  readonly strike = new Vector3()
  private wait = 3
  private age = 10
  private strokes: number[] = []
  private power = 0
  private random = seededRandom(9)

  /**
   * Advances the lightning by `dt` seconds around `focus`. Returns the distance in metres to a
   * new flash, for the thunder, or null.
   */
  update(dt: number, storm: boolean, focus: Vector3): number | null {
    this.age += dt
    let envelope = 0
    for (const at of this.strokes) {
      const since = this.age - at
      if (since >= 0) envelope += Math.exp(-since / STROKE_FADE) * (at === 0 ? 1 : 0.7)
    }
    this.glow = Math.min(1.4, envelope)
    this.flash = this.glow * this.power
    if (!storm) {
      this.wait = Math.max(this.wait, 2)
      return null
    }
    this.wait -= dt
    if (this.wait > 0) return null
    this.wait = FLASH_MIN_GAP - Math.log(Math.max(this.random(), 0.01)) * FLASH_GAP
    return this.strikeNear(focus)
  }

  /** Starts a flash, in the nearest storm cell if one is close, otherwise somewhere nearby. */
  private strikeNear(focus: Vector3) {
    const random = this.random
    let nearest = STORM_CELLS[0]
    let best = Number.POSITIVE_INFINITY
    for (const candidate of STORM_CELLS) {
      const distance = Math.hypot(candidate.x - focus.x, candidate.z - focus.z)
      if (distance < best) {
        best = distance
        nearest = candidate
      }
    }
    let x: number
    let z: number
    if (best < 30_000 && random() < 0.6) {
      const angle = random() * Math.PI * 2
      const reach = Math.sqrt(random()) * nearest.radius * 0.7
      x = nearest.x + Math.cos(angle) * reach
      z = nearest.z + Math.sin(angle) * reach
    } else {
      const angle = random() * Math.PI * 2
      const reach = 2500 + random() * 12_000
      x = focus.x + Math.cos(angle) * reach
      z = focus.z + Math.sin(angle) * reach
    }
    const ground = Math.max(heightAt(x, z), 0)
    const base = WEATHER.storm.deck?.base ?? 500
    const toGround = random() < 0.45
    this.strike.set(x, toGround ? ground : base + 300, z)
    const distance = this.strike.distanceTo(focus)
    // Close flashes light everything; far ones only glow on the horizon
    this.power = Math.max(0.1, 1.15 - distance / FLASH_RANGE) * (toGround ? 1 : 0.65)
    this.age = 0
    this.strokes = [0]
    const extra = Math.floor(random() * 4)
    for (let i = 0, at = 0; i < extra; i++) {
      at += 0.04 + random() * 0.09
      this.strokes.push(at)
    }
    if (toGround) this.growBolt(x, base, z, ground)
    else this.segments = 0
    this.version++
    return distance
  }

  /** Builds a jagged channel from the cloud base down to the ground, with a few branches. */
  private growBolt(x: number, top: number, z: number, ground: number) {
    const random = this.random
    this.segments = 0
    let px = x
    let py = top
    let pz = z
    // The channel wanders sideways as it falls, drifting a little one way overall
    const driftX = (random() - 0.5) * 0.5
    const driftZ = (random() - 0.5) * 0.5
    while (py > ground && this.segments < BOLT_SEGMENTS) {
      const step = 25 + random() * 55
      const nx = px + (driftX + (random() - 0.5) * 1.3) * step
      const ny = Math.max(ground, py - step)
      const nz = pz + (driftZ + (random() - 0.5) * 1.3) * step
      this.addSegment(px, py, pz, nx, ny, nz, 1)
      if (random() < 0.14 && py - ground > 120) this.growBranch(nx, ny, nz, ground)
      px = nx
      py = ny
      pz = nz
    }
  }

  private growBranch(x: number, y: number, z: number, ground: number) {
    const random = this.random
    const angle = random() * Math.PI * 2
    const outX = Math.cos(angle) * 0.8
    const outZ = Math.sin(angle) * 0.8
    const steps = 4 + Math.floor(random() * 10)
    for (let i = 0; i < steps && this.segments < BOLT_SEGMENTS - 40; i++) {
      const step = 20 + random() * 40
      const nx = x + (outX + (random() - 0.5)) * step
      const ny = Math.max(ground + 20, y - step * (0.4 + random() * 0.6))
      const nz = z + (outZ + (random() - 0.5)) * step
      this.addSegment(x, y, z, nx, ny, nz, 0.45 * (1 - i / steps))
      x = nx
      y = ny
      z = nz
    }
  }

  private addSegment(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    width: number
  ) {
    this.bolt.set([x1, y1, z1, x2, y2, z2, width], this.segments * 7)
    this.segments++
  }
}

// Felt jolts: how fast the smoothed load follows, and camera shake per g of sudden change
const JOLT_SMOOTHING = 3
const JOLT_SHAKE = 0.35
const JOLT_LIMIT = 0.35

/**
 * The storm's air: cell downdrafts, microbursts, and gusts, plus the windshear alert and the
 * lightning. The game owns one; tests build their own to fly through the same air.
 */
export class Storm {
  readonly turbulence = new Turbulence()
  readonly detector = new ShearDetector()
  readonly lightning = new Lightning()
  /** Steady wind from downdrafts and microbursts at the aircraft, without the gusts. */
  readonly shear = new Vector3()
  private smoothLoad = 1

  /** Clears the gusts and the windshear alert for a new flight. */
  reset(seed = 1) {
    this.turbulence.reset(seed)
    this.detector.reset()
    this.shear.set(0, 0, 0)
    this.smoothLoad = 1
  }

  /**
   * Adds the storm's wind at the aircraft to `wind`, advancing the gusts by `dt` seconds.
   * `cells` is false outside Storm weather, where only a mission's microburst blows.
   */
  addWind(dt: number, sim: FlightSim, cells: boolean, burst: Microburst | null, wind: Vector3) {
    const { x, y, z } = sim.position
    const height = Math.max(sim.altitudeAgl, 0)
    this.shear.set(0, 0, 0)
    let rough = 0
    if (cells) {
      for (const storm of STORM_CELLS) {
        addMicroburst(storm.burst, x, height, z, this.shear)
        rough = Math.max(rough, cellDepth(storm, x, y, z, true) * CELL_GUSTS)
      }
    }
    if (burst) {
      addMicroburst(burst, x, height, z, this.shear)
      const r = Math.hypot(x - burst.x, z - burst.z) / burst.radius
      rough = Math.max(rough, BURST_GUSTS * (1 - smoothstep(1, 3, r)))
    }
    wind.add(this.shear)
    if (!cells) return
    this.turbulence.update(dt, sim.velocity, sim.trueAirspeed, height, STORM_GUSTS + rough)
    wind.add(this.turbulence.gust)
  }

  /** Updates the windshear alert from the latest steady wind. Returns true while it sounds. */
  detectShear(dt: number, sim: FlightSim) {
    this.detector.update(dt, sim, this.shear)
    return this.detector.warning
  }

  /** Camera shake from sudden changes in load, as gusts jolt the aircraft. */
  jolt(dt: number, sim: FlightSim) {
    this.smoothLoad += (sim.gLoad - this.smoothLoad) * Math.min(1, dt * JOLT_SMOOTHING)
    if (sim.onGround) return 0
    return Math.min(JOLT_LIMIT, Math.abs(sim.gLoad - this.smoothLoad) * JOLT_SHAKE)
  }
}
