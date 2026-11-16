import type { Ground, Surface } from '../sim/flight-sim'
import { fbm, ridged } from './noise'

/** Side length of the terrain square in metres, centred on the origin. */
export const WORLD_SIZE = 96_000
/** Terrain cells per side. */
export const GRID = 960
export const CELL = WORLD_SIZE / GRID
const HALF = WORLD_SIZE / 2
const SEABED = -40

/** The islands as centres and rough radii. The first is the main island. */
export const ISLES = [
  { x: 0, z: 0, radius: 10_500 },
  { x: 12_800, z: -5500, radius: 3800 },
  { x: -9500, z: 12_000, radius: 3400 },
  { x: -22_000, z: -30_000, radius: 9000 },
  { x: 32_000, z: 12_000, radius: 11_000 },
  { x: 8000, z: 34_000, radius: 7000 },
  { x: -36_000, z: -4000, radius: 4500 },
  { x: 30_000, z: -30_000, radius: 5000 },
  { x: -30_000, z: 30_000, radius: 6000 }
]

/** Rectangle on the ground: centre, direction of its long axis in degrees from north, and size. */
export type Strip = { x: number; z: number; heading: number; length: number; width: number }
export type Building = Strip & { height: number; kind: 'terminal' | 'hangar' | 'tower' }
/** Parking spot. Heading is in radians. */
export type Stand = { x: number; z: number; heading: number }

export type Airport = {
  name: string
  /** Three-letter code shown on the navigation display. */
  code: string
  kind: 'international' | 'regional' | 'airstrip'
  x: number
  z: number
  elevation: number
  /** The first runway is the main one. */
  runways: Strip[]
  taxiways: Strip[]
  aprons: Strip[]
  buildings: Building[]
  /** Stands at the terminal for airliners, and on the ramp by the hangars for everything else. */
  gates: Stand[]
  ramps: Stand[]
  /** Levelled ground around the terminal, apron, and hangars. */
  grounds: Strip
  /** Everything belonging to the airport lies within this distance of its centre. */
  reach: number
}

/** `home` is the code of the airport the city's road leads to. */
export type City = Strip & { name: string; home: string; elevation: number }

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const radians = (degrees: number) => (degrees * Math.PI) / 180

/** Natural terrain height before airports and cities are levelled. */
function naturalHeight(x: number, z: number) {
  // Bend the coastline so the islands get bays and headlands
  const warpX = x + 1700 * fbm(x * 0.00015 + 11.3, z * 0.00015 - 4.1, 3, 11)
  const warpZ = z + 1700 * fbm(x * 0.00015 - 7.7, z * 0.00015 + 2.9, 3, 23)
  let land = 0
  for (const isle of ISLES) {
    const reach = Math.hypot(warpX - isle.x, warpZ - isle.z) / isle.radius
    land = Math.max(land, 1 - smoothstep(0.5, 1.1, reach))
  }
  // Open sea: skip the costly hill and mountain noise
  if (land === 0) return SEABED
  const hills = fbm(x * 0.0006, z * 0.0006, 5, 37) * 0.5 + 0.5
  // Mountains gather into ranges, leaving plains and valleys between them
  const ranges = smoothstep(-0.25, 0.35, fbm(x * 0.00022 + 3.1, z * 0.00022 + 8.6, 2, 43))
  const peaks = ridged(x * 0.00026, z * 0.00026, 5, 51)
  return SEABED + land * 70 + land * hills * 70 + land ** 3 * ranges * peaks ** 2.5 * 1500
}

/** Converts a world position to distances along and to the right of a strip's long axis. */
export function toStrip(strip: Strip, x: number, z: number) {
  const angle = radians(strip.heading)
  const dx = x - strip.x
  const dz = z - strip.z
  return {
    along: dx * Math.sin(angle) - dz * Math.cos(angle),
    across: dx * Math.cos(angle) + dz * Math.sin(angle)
  }
}

/** Converts distances along and to the right of a strip's long axis back to a world position. */
export function fromStrip(strip: Strip, along: number, across: number) {
  const angle = radians(strip.heading)
  return {
    x: strip.x + along * Math.sin(angle) + across * Math.cos(angle),
    z: strip.z - along * Math.cos(angle) + across * Math.sin(angle)
  }
}

/** Distance in metres from a point to the edge of a strip, 0 inside it. */
export function outside(strip: Strip, x: number, z: number) {
  const { along, across } = toStrip(strip, x, z)
  return Math.hypot(
    Math.max(Math.abs(along) - strip.length / 2, 0),
    Math.max(Math.abs(across) - strip.width / 2, 0)
  )
}

type AirportPlan = Strip & {
  name: string
  code: string
  kind: Airport['kind']
  /** 1 puts the terminal on the right of the runway heading, -1 on the left. */
  side: 1 | -1
  /** Extra runways as offsets from the main one. */
  crossing?: { along: number; across: number; heading: number; length: number; width: number }[]
}

/** Sizes that set out each kind of airport, measured from the main runway's centreline. */
const LAYOUTS = {
  international: {
    taxiway: 190,
    apron: { from: 205, to: 380, half: 380 },
    terminal: { across: 425, length: 460, depth: 60, height: 17 },
    gates: { across: 345, spacing: 85, count: 7 },
    hangars: { along: 560, across: 345, spacing: 90, count: 3, length: 70, depth: 55, height: 19 },
    ramp: 250,
    tower: { along: -330, across: 430, height: 48 },
    edge: 520
  },
  regional: {
    taxiway: 120,
    apron: { from: 132, to: 240, half: 170 },
    terminal: { across: 272, length: 130, depth: 34, height: 10 },
    gates: { across: 215, spacing: 80, count: 3 },
    hangars: { along: 270, across: 220, spacing: 60, count: 2, length: 44, depth: 38, height: 12 },
    ramp: 165,
    tower: { along: -120, across: 275, height: 24 },
    edge: 340
  },
  airstrip: {
    taxiway: 0,
    apron: { from: 10, to: 95, half: 70 },
    terminal: { across: 0, length: 0, depth: 0, height: 0 },
    gates: { across: 55, spacing: 30, count: 1 },
    hangars: { along: 0, across: 118, spacing: 0, count: 1, length: 32, depth: 26, height: 9 },
    ramp: 55,
    tower: { along: 0, across: 0, height: 0 },
    edge: 160
  }
}

/** Sets out the taxiways, aprons, buildings, and parking stands around a main runway. */
function layoutAirport(plan: AirportPlan): Airport {
  const layout = LAYOUTS[plan.kind]
  const { side } = plan
  const half = plan.length / 2
  /** Strip placed by distances along and across the main runway, pointing along or across it. */
  const strip = (
    along: number,
    across: number,
    length: number,
    width: number,
    crosswise = false
  ): Strip => ({
    ...fromStrip(plan, along, across * side),
    heading: plan.heading + (crosswise ? 90 : 0),
    length,
    width
  })
  const stand = (along: number, across: number, facing: number): Stand => ({
    ...fromStrip(plan, along, across * side),
    heading: radians(plan.heading + facing * side)
  })

  const runways: Strip[] = [
    { x: plan.x, z: plan.z, heading: plan.heading, length: plan.length, width: plan.width },
    ...(plan.crossing ?? []).map(extra => ({
      ...fromStrip(plan, extra.along, extra.across),
      heading: plan.heading + extra.heading,
      length: extra.length,
      width: extra.width
    }))
  ]
  const taxiways: Strip[] = []
  const lane = plan.kind === 'international' ? 26 : 18
  if (layout.taxiway > 0) {
    taxiways.push(strip(0, layout.taxiway, plan.length, lane))
    // Links between the runway and the parallel taxiway: one at each end and one every 850 m or so
    const links = Math.max(2, Math.round(plan.length / 850) + 1)
    for (let i = 0; i < links; i++) {
      const along = -half + lane + (i / (links - 1)) * (plan.length - lane * 2)
      taxiways.push(strip(along, layout.taxiway / 2, layout.taxiway + lane, lane, true))
    }
  }
  const apronDepth = layout.apron.to - layout.apron.from
  const aprons = [strip(0, layout.apron.from + apronDepth / 2, layout.apron.half * 2, apronDepth)]
  const buildings: Building[] = []
  const gates: Stand[] = []
  const ramps: Stand[] = []
  for (let i = 0; i < layout.gates.count; i++) {
    const along = (i - (layout.gates.count - 1) / 2) * layout.gates.spacing
    // Airliners park nose-in at the terminal and push back to leave
    gates.push(stand(along, layout.gates.across, plan.kind === 'airstrip' ? -90 : 90))
  }
  if (layout.terminal.length > 0) {
    const { terminal, tower } = layout
    buildings.push({
      ...strip(0, terminal.across, terminal.length, terminal.depth),
      height: terminal.height,
      kind: 'terminal'
    })
    buildings.push({
      ...strip(tower.along, tower.across, 11, 11),
      height: tower.height,
      kind: 'tower'
    })
  }
  const { hangars } = layout
  if (hangars.along > 0) {
    const span = hangars.spacing * (hangars.count - 1) + hangars.length + 60
    const middle = hangars.along + (hangars.count - 1) * hangars.spacing * 0.5
    aprons.push(
      strip(
        middle,
        (layout.apron.from + hangars.across) / 2,
        span,
        hangars.across - layout.apron.from
      )
    )
  }
  for (let i = 0; i < hangars.count; i++) {
    const along = hangars.along + i * hangars.spacing
    buildings.push({
      ...strip(along, hangars.across + hangars.depth / 2, hangars.length, hangars.depth),
      height: hangars.height,
      kind: 'hangar'
    })
    // Light aircraft and fighters park in front of the hangars, pointing at the taxiway
    ramps.push(stand(along, layout.ramp, -90))
  }

  const farthest = runways.map(
    runway => Math.hypot(runway.x - plan.x, runway.z - plan.z) + runway.length / 2
  )
  return {
    name: plan.name,
    code: plan.code,
    kind: plan.kind,
    x: plan.x,
    z: plan.z,
    elevation: Math.round(Math.max(naturalHeight(plan.x, plan.z), 12)),
    runways,
    taxiways,
    aprons,
    buildings,
    gates,
    ramps,
    grounds: strip(
      hangars.along / 2,
      (layout.edge - 80) / 2,
      plan.length * 0.5 + hangars.along + 300,
      layout.edge + 80
    ),
    reach: Math.max(...farthest) + 900
  }
}

/** The first airport is the home base where flights start. */
export const AIRPORTS: Airport[] = [
  layoutAirport({
    name: 'Coral Bay International',
    code: 'CBI',
    kind: 'international',
    x: 1300,
    z: -4900,
    heading: 90,
    length: 3400,
    width: 60,
    side: -1,
    crossing: [{ along: 1000, across: 910, heading: 50, length: 2500, width: 45 }]
  }),
  layoutAirport({
    name: 'Port Azure International',
    code: 'PAZ',
    kind: 'international',
    x: -3300,
    z: 2600,
    heading: 0,
    length: 3000,
    width: 60,
    side: -1
  }),
  layoutAirport({
    name: 'Ridge Field',
    code: 'RDG',
    kind: 'regional',
    x: 6800,
    z: -1700,
    heading: 70,
    length: 1800,
    width: 40,
    side: 1
  }),
  layoutAirport({
    name: 'Skerry Island',
    code: 'SKY',
    kind: 'regional',
    x: 13_000,
    z: -2300,
    heading: 85,
    length: 1500,
    width: 36,
    side: -1
  }),
  layoutAirport({
    name: 'Mango Creek',
    code: 'MGC',
    kind: 'airstrip',
    x: -1200,
    z: 6800,
    heading: 100,
    length: 1000,
    width: 24,
    side: -1
  }),
  layoutAirport({
    name: 'Southwind',
    code: 'SWD',
    kind: 'airstrip',
    x: -10_000,
    z: 10_700,
    heading: 90,
    length: 1100,
    width: 24,
    side: 1
  }),
  layoutAirport({
    name: 'Eastmark International',
    code: 'EMK',
    kind: 'international',
    x: 33_500,
    z: 15_500,
    heading: 150,
    length: 3000,
    width: 60,
    side: -1
  }),
  layoutAirport({
    name: 'Northgate International',
    code: 'NGT',
    kind: 'international',
    x: -23_500,
    z: -31_500,
    heading: 45,
    length: 3000,
    width: 60,
    side: 1
  }),
  layoutAirport({
    name: 'Cape Verity',
    code: 'CVY',
    kind: 'regional',
    x: 11_000,
    z: 37_000,
    heading: 105,
    length: 1800,
    width: 40,
    side: 1
  }),
  layoutAirport({
    name: 'Saltmarsh',
    code: 'SMH',
    kind: 'regional',
    x: -30_500,
    z: 32_500,
    heading: 165,
    length: 1800,
    width: 40,
    side: 1
  }),
  layoutAirport({
    name: 'Lantern Rock',
    code: 'LRK',
    kind: 'airstrip',
    x: -37_000,
    z: -4500,
    heading: 135,
    length: 1100,
    width: 24,
    side: 1
  }),
  layoutAirport({
    name: 'Gull Point',
    code: 'GPT',
    kind: 'airstrip',
    x: 29_000,
    z: -31_500,
    heading: 90,
    length: 1100,
    width: 24,
    side: -1
  })
]

/** Where a city sits: its distance from the main runway, its shift along it, and its size. */
type CityPlan = { away: number; shift: number; length: number; width: number }

/** Lays a city out on the terminal side of an airport's main runway, on its flattest ground. */
function cityBeside(name: string, home: string, plan: CityPlan): City {
  const airport = AIRPORTS.find(candidate => candidate.code === home)
  if (!airport) throw new Error(`City ${name} needs airport ${home}, which does not exist`)
  const runway = airport.runways[0]
  // The terminal stands on the same side as the middle of the airport grounds
  const side = Math.sign(toStrip(runway, airport.grounds.x, airport.grounds.z).across)
  const { x, z } = fromStrip(runway, plan.shift, side * plan.away)
  const { length, width } = plan
  const city = { x, z, heading: runway.heading, length, width }
  // Level the city at the middle of the ground it covers, so cuts and fills stay small
  const heights: number[] = []
  for (let i = -5; i <= 5; i++) {
    for (let j = -5; j <= 5; j++) {
      const spot = fromStrip(city, (i / 10) * length, (j / 10) * width)
      heights.push(naturalHeight(spot.x, spot.z))
    }
  }
  heights.sort((a, b) => a - b)
  const elevation = Math.round(Math.max(heights[heights.length >> 1], 10))
  return { name, home, ...city, elevation }
}

/**
 * Cities on street grids beside the larger airports. Each sits on the flattest nearby
 * ground that keeps clear of the airport and the approach paths of its runways.
 */
export const CITIES: City[] = [
  cityBeside('Coral Bay', 'CBI', { away: 2800, shift: 900, length: 3000, width: 1000 }),
  cityBeside('Port Azure', 'PAZ', { away: 2200, shift: -1200, length: 1800, width: 1000 }),
  cityBeside('Eastmark', 'EMK', { away: 1800, shift: -600, length: 1800, width: 1600 }),
  cityBeside('Northgate', 'NGT', { away: 1800, shift: 1200, length: 1800, width: 1600 }),
  cityBeside('Verity', 'CVY', { away: 1600, shift: -300, length: 1800, width: 1600 })
]

/**
 * Bombing range on the quiet east side of Gull Point: a level, cleared circle of bare
 * earth well away from the airstrip and any houses, where the B-2 missions drop.
 */
export const RANGE = {
  name: 'Gull Point Range',
  x: 31_750,
  z: -31_250,
  /** Radius of the level ground, which blends into the hills over the next 450 m. */
  radius: 650,
  elevation: Math.round(naturalHeight(31_750, -31_250))
}

/** 1 on the level ground of the bombing range, fading to 0 over the 450 m around it. */
function rangeBlend(x: number, z: number) {
  return 1 - smoothstep(RANGE.radius, RANGE.radius + 450, Math.hypot(x - RANGE.x, z - RANGE.z))
}

/** 1 on ground that an airport levels, fading to 0 over the surrounding 450 m. */
function airportBlend(airport: Airport, x: number, z: number) {
  if (Math.hypot(x - airport.x, z - airport.z) > airport.reach + 600) return 0
  let nearest = outside(airport.grounds, x, z) - 60
  for (const runway of airport.runways) {
    const { along, across } = toStrip(runway, x, z)
    nearest = Math.min(
      nearest,
      Math.hypot(
        Math.max(Math.abs(along) - runway.length / 2 - 200, 0),
        Math.max(Math.abs(across) - 170, 0)
      )
    )
  }
  return 1 - smoothstep(0, 450, nearest)
}

// Hills are lowered this far past each runway end, in metres
const APPROACH_CLEARING = 7500

/** Lowers hills under the approach paths so both ends of every runway stay usable. */
function clearApproach(airport: Airport, x: number, z: number, height: number) {
  let cleared = height
  for (const runway of airport.runways) {
    const { along, across } = toStrip(runway, x, z)
    const overrun = Math.abs(along) - runway.length / 2
    if (overrun <= 0 || overrun > APPROACH_CLEARING) continue
    const ceiling = airport.elevation + 3 + overrun * 0.035
    if (cleared > ceiling) {
      // The cut narrows and fades out toward its far end, so no cliff is left behind
      const width = 1 - smoothstep(120, 400, Math.abs(across))
      const fade = 1 - smoothstep(APPROACH_CLEARING - 1500, APPROACH_CLEARING, overrun)
      cleared = lerp(cleared, ceiling, width * fade)
    }
  }
  return cleared
}

function buildHeights() {
  const heights = new Float32Array((GRID + 1) * (GRID + 1))
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const x = i * CELL - HALF
      const z = j * CELL - HALF
      let height = naturalHeight(x, z)
      for (const city of CITIES) {
        height = lerp(height, city.elevation, 1 - smoothstep(0, 350, outside(city, x, z)))
      }
      height = lerp(height, RANGE.elevation, rangeBlend(x, z))
      for (const airport of AIRPORTS) {
        if (Math.hypot(x - airport.x, z - airport.z) > airport.reach + APPROACH_CLEARING) continue
        height = clearApproach(airport, x, z, height)
        height = lerp(height, airport.elevation, airportBlend(airport, x, z))
      }
      heights[j * (GRID + 1) + i] = height
    }
  }
  return heights
}

/** Terrain heights at grid corners, row by row from the north-west corner. */
export const HEIGHTS = buildHeights()

/** Terrain height in metres. Matches the triangles of the rendered terrain. */
export function heightAt(x: number, z: number) {
  const gx = (x + HALF) / CELL
  const gz = (z + HALF) / CELL
  if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return SEABED
  const i = Math.floor(gx)
  const j = Math.floor(gz)
  const fx = gx - i
  const fz = gz - j
  const row = j * (GRID + 1) + i
  const h10 = HEIGHTS[row + 1]
  const h01 = HEIGHTS[row + GRID + 1]
  if (fx + fz <= 1) {
    const h00 = HEIGHTS[row]
    return h00 + (h10 - h00) * fx + (h01 - h00) * fz
  }
  const h11 = HEIGHTS[row + GRID + 2]
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz)
}

/** True on any runway, taxiway, or apron. */
export function isPaved(x: number, z: number) {
  for (const airport of AIRPORTS) {
    if (Math.hypot(x - airport.x, z - airport.z) > airport.reach) continue
    for (const group of [airport.runways, airport.taxiways, airport.aprons]) {
      for (const strip of group) if (outside(strip, x, z) === 0) return true
    }
  }
  return false
}

export function surfaceAt(x: number, z: number): Surface {
  if (isPaved(x, z)) return 'runway'
  return heightAt(x, z) < 0 ? 'water' : 'grass'
}

export const ISLAND_GROUND: Ground = { heightAt, surfaceAt }

/** Steepness of the terrain as rise over run. */
export function slopeAt(x: number, z: number) {
  const dx = heightAt(x + CELL, z) - heightAt(x - CELL, z)
  const dz = heightAt(x, z + CELL) - heightAt(x, z - CELL)
  return Math.hypot(dx, dz) / (2 * CELL)
}

/** Tree cover from 0 (open grass) to 1 (dense forest). */
export function forestAt(x: number, z: number) {
  return fbm(x * 0.0011 + 40, z * 0.0011 - 17, 3, 71) * 0.5 + 0.5
}

/**
 * True where trees and houses must not stand: airports, their approach paths, cities, and
 * the bombing range.
 */
export function isClearZone(x: number, z: number) {
  for (const city of CITIES) if (outside(city, x, z) < 60) return true
  if (Math.hypot(x - RANGE.x, z - RANGE.z) < RANGE.radius + 200) return true
  for (const airport of AIRPORTS) {
    if (Math.hypot(x - airport.x, z - airport.z) > airport.reach + 1200) continue
    if (outside(airport.grounds, x, z) < 80) return true
    for (const runway of airport.runways) {
      const { along, across } = toStrip(runway, x, z)
      const overrun = Math.abs(along) - runway.length / 2
      if (overrun < 250 && Math.abs(across) < 260) return true
      if (overrun < 1800 && Math.abs(across) < 110) return true
    }
  }
  return false
}

type Rgb = [number, number, number]
const SAND: Rgb = [0.78, 0.72, 0.58]
const SEABED_SAND: Rgb = [0.45, 0.47, 0.4]
const GRASS: Rgb = [0.4, 0.49, 0.25]
const DRY_GRASS: Rgb = [0.56, 0.54, 0.33]
const FOREST: Rgb = [0.2, 0.31, 0.16]
const MOWN: Rgb = [0.44, 0.54, 0.29]
const SCREE: Rgb = [0.47, 0.44, 0.4]
const SNOW: Rgb = [0.93, 0.95, 0.98]
const RANGE_EARTH: Rgb = [0.5, 0.42, 0.31]

function mix(out: Rgb, to: Rgb, t: number) {
  out[0] = lerp(out[0], to[0], t)
  out[1] = lerp(out[1], to[1], t)
  out[2] = lerp(out[2], to[2], t)
}

/**
 * Broad ground colour as sRGB values from 0 to 1, written into `out`.
 * The terrain shader adds fine detail and bare rock on steep slopes.
 */
export function groundColor(x: number, z: number, out: Rgb) {
  const height = heightAt(x, z)
  if (height < 0) {
    out[0] = SAND[0]
    out[1] = SAND[1]
    out[2] = SAND[2]
    mix(out, SEABED_SAND, smoothstep(0, 25, -height))
    return
  }
  const patchy = fbm(x * 0.004, z * 0.004, 2, 91)
  out[0] = GRASS[0]
  out[1] = GRASS[1]
  out[2] = GRASS[2]
  // Sun-bleached grass on exposed ground, greener in the hollows
  mix(out, DRY_GRASS, smoothstep(-0.1, 0.5, fbm(x * 0.0017 - 9, z * 0.0017 + 31, 3, 83)) * 0.7)
  mix(out, FOREST, smoothstep(0.42, 0.6, forestAt(x, z)))
  let mown = 0
  for (const airport of AIRPORTS) mown = Math.max(mown, airportBlend(airport, x, z))
  for (const city of CITIES) mown = Math.max(mown, 1 - smoothstep(0, 300, outside(city, x, z)))
  mix(out, MOWN, smoothstep(0.5, 0.9, mown))
  // The range is bare, churned earth
  mix(out, RANGE_EARTH, smoothstep(0.75, 1, rangeBlend(x, z)) * (0.8 + patchy * 0.2))
  mix(out, SCREE, smoothstep(480, 680, height + patchy * 60))
  mix(out, SNOW, smoothstep(900, 1010, height + patchy * 50))
  mix(out, SAND, 1 - smoothstep(1.5, 5, height))
}
