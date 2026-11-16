import {
  AIRPORTS,
  CITIES,
  forestAt,
  fromStrip,
  heightAt,
  ISLES,
  isClearZone,
  slopeAt,
  toStrip,
  WORLD_SIZE
} from './island'
import { seededRandom } from './noise'

// Where the scenery stands and how it moves. The renderer draws it and the game
// checks the aircraft against it, so both must read the same data.

export type Tree = {
  x: number
  y: number
  z: number
  tall: number
  wide: number
  broadleaf: boolean
}

/** Upright cylinder the aircraft cannot fly through. */
export type Obstacle = {
  x: number
  z: number
  base: number
  top: number
  radius: number
  kind: 'tree' | 'building'
}

export type House = {
  x: number
  y: number
  z: number
  /** Rotation around the vertical axis in radians. */
  turn: number
  width: number
  depth: number
  wallHeight: number
  roofHeight: number
}

/** One block of a city building. Skyscrapers stack several, each standing on the last. */
export type Tower = {
  x: number
  y: number
  z: number
  turn: number
  width: number
  depth: number
  height: number
  /** Glass curtain wall instead of concrete with windows. */
  glass: boolean
  /** A cylinder `width` across instead of a box. */
  round: boolean
  /** Index into the facade or glass colours. 6 is plain roof plant grey. */
  tint: number
}

/** A point that circles a centre: boats at sea, balloons over a valley, birds in a flock. */
export type Orbit = {
  centerX: number
  centerZ: number
  radius: number
  height: number
  /** Starting angle in radians and angular speed in rad/s. Negative speeds circle the other way. */
  angle: number
  rate: number
}

const VILLAGE_SITES = [
  [-4300, -4300],
  [-2200, 4400],
  [5300, -300],
  [-600, 7700],
  [14_300, -1900],
  [-9900, 11_500],
  [3700, -6400],
  // The outer islands each get a village 1.4 km from the runway, on the side away from the terminal
  ...AIRPORTS.slice(6).map(airport => {
    const runway = airport.runways[0]
    const side = Math.sign(toStrip(runway, airport.grounds.x, airport.grounds.z).across)
    const spot = fromStrip(runway, 0, -side * 1400)
    return [spot.x, spot.z]
  })
]

function buildHouses() {
  const pick = seededRandom(404)
  const houses: House[] = []
  for (const [siteX, siteZ] of VILLAGE_SITES) {
    if (heightAt(siteX, siteZ) < 5) continue
    const first = houses.length
    const wanted = 28 + Math.floor(pick() * 22)
    for (let attempt = 0; attempt < 400 && houses.length - first < wanted; attempt++) {
      const angle = pick() * Math.PI * 2
      const reach = Math.sqrt(pick()) * 300
      const x = siteX + Math.cos(angle) * reach
      const z = siteZ + Math.sin(angle) * reach
      const y = heightAt(x, z)
      if (y < 5 || slopeAt(x, z) > 0.2 || isClearZone(x, z)) continue
      if (houses.slice(first).some(other => Math.hypot(other.x - x, other.z - z) < 20)) continue
      // The first building of each village is its church tower
      const tower = houses.length === first
      houses.push({
        x,
        y: y - 0.5,
        z,
        turn: pick() * Math.PI,
        width: tower ? 5.5 : 7 + pick() * 4,
        depth: tower ? 5.5 : 9 + pick() * 6,
        wallHeight: tower ? 15 : 3.2 + pick() * 3,
        roofHeight: tower ? 7 : 2 + pick() * 1.4
      })
    }
  }
  return houses
}

/** Streets between city blocks, and the wider avenue after every fourth block. */
export const STREET = 16
export const AVENUE = 28

export type CityBlock = {
  /** Centre of the block in the city's own axes, as for `fromStrip`. */
  along: number
  across: number
  length: number
  width: number
  use: 'buildings' | 'houses' | 'park' | 'plaza'
}

/** Pointed cap on a skyscraper, or a mast on its roof. */
export type Spire = { x: number; y: number; z: number; height: number; radius: number }
export type Crown = Tower

/** Tree in a city park. */
export type ParkTree = { x: number; y: number; z: number; size: number }

/** Block extents along one side of a city, with streets of random-sized blocks between them. */
function blockSpans(span: number, pick: () => number) {
  const spans: [number, number][] = []
  let at = -span / 2 + 12
  for (let block = 1; ; block++) {
    const size = 70 + Math.floor(pick() * 4) * 20
    if (at + size > span / 2 - 12) break
    spans.push([at, at + size])
    at += size + (block % 4 === 0 ? AVENUE : STREET)
  }
  // Centre the grid in the city
  const shift = -(spans[0][0] + spans[spans.length - 1][1]) / 2
  return spans.map(([from, to]): [number, number] => [from + shift, to + shift])
}

/**
 * Highest a building may reach at a point, in metres above sea level. The limit rises
 * gently away from each runway and stays low under its approach and climb-out paths.
 */
function buildingCeiling(x: number, z: number) {
  let ceiling = Number.POSITIVE_INFINITY
  for (const airport of AIRPORTS) {
    if (Math.hypot(x - airport.x, z - airport.z) > airport.reach + 9000) continue
    for (const runway of airport.runways) {
      const { along, across } = toStrip(runway, x, z)
      const overrun = Math.max(Math.abs(along) - runway.length / 2, 0)
      const aside = Math.max(Math.abs(across) - 150, 0)
      let limit = 45 + Math.max(Math.hypot(overrun, aside) - 300, 0) * 0.15
      if (overrun > 0 && Math.abs(across) < 600 + overrun * 0.15) {
        limit = Math.min(limit, overrun * 0.025)
      }
      ceiling = Math.min(ceiling, airport.elevation + limit)
    }
  }
  return ceiling
}

/** Lowest ground under a footprint, so buildings at the edge of a city never float. */
function baseHeight(x: number, z: number, radius: number) {
  let base = heightAt(x, z)
  for (const [dx, dz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ]) {
    base = Math.min(base, heightAt(x + dx * radius, z + dz * radius))
  }
  return base - 0.5
}

/**
 * Lays out every city: a downtown of skyscrapers on the side away from the airport,
 * a ring of mid-rise offices and flats, then low-rise streets and houses at the edge.
 */
function buildCities() {
  const pick = seededRandom(707)
  const between = (min: number, max: number) => min + pick() * (max - min)
  const plans: { city: (typeof CITIES)[number]; blocks: CityBlock[] }[] = []
  const towers: Tower[] = []
  const spires: Spire[] = []
  const crowns: Crown[] = []
  const trees: ParkTree[] = []
  const houses: House[] = []

  for (const city of CITIES) {
    const turn = (-city.heading * Math.PI) / 180
    const runway = AIRPORTS.find(airport => airport.code === city.home)?.runways[0]
    const runwaySide = runway ? Math.sign(toStrip(city, runway.x, runway.z).across) : 1
    const core = {
      along: between(-0.15, 0.15) * city.length,
      across: -runwaySide * city.width * 0.18
    }
    const blocks: CityBlock[] = []
    for (const [alongFrom, alongTo] of blockSpans(city.length, pick)) {
      for (const [acrossFrom, acrossTo] of blockSpans(city.width, pick)) {
        blocks.push({
          along: (alongFrom + alongTo) / 2,
          across: (acrossFrom + acrossTo) / 2,
          length: alongTo - alongFrom,
          width: acrossTo - acrossFrom,
          use: 'buildings'
        })
      }
    }
    // How far a block is from downtown, 0 at its heart and about 1 at the city edge
    const reach = (block: CityBlock) =>
      Math.hypot(
        (block.along - core.along) / (city.length * 0.5),
        (block.across - core.across) / (city.width * 0.5)
      )
    const heart = blocks.reduce((best, block) => (reach(block) < reach(best) ? block : best))
    for (const block of blocks) {
      const r = reach(block)
      if (block === heart) block.use = 'plaza'
      else if (pick() < (r < 0.3 ? 0.03 : 0.08)) block.use = 'park'
      else if (r > 0.78 && pick() < 0.55) block.use = 'houses'
    }
    plans.push({ city, blocks })
    // The three building blocks closest to the plaza get the city's landmark skyscrapers
    const landmarks = blocks
      .filter(block => block.use === 'buildings')
      .sort((a, b) => reach(a) - reach(b))
      .slice(0, 3)

    /** Adds one building part on the city grid. Returns its top, in metres above sea level. */
    const place = (
      along: number,
      across: number,
      part: Omit<Tower, 'x' | 'y' | 'z' | 'turn'>,
      base?: number
    ) => {
      const spot = fromStrip(city, along, across)
      const y = base ?? baseHeight(spot.x, spot.z, Math.max(part.width, part.depth) / 2)
      towers.push({ ...part, x: spot.x, y, z: spot.z, turn })
      return y + part.height
    }

    /** A skyscraper: a plain block, a stack of setbacks, or a glass cylinder, topped off. */
    /** `look` picks the shape (0 to 1) and the roof (0 to 1) instead of leaving them to chance. */
    const tower = (
      along: number,
      across: number,
      size: number,
      height: number,
      base: number,
      look?: [style: number, finish: number]
    ) => {
      const style = look?.[0] ?? pick()
      const glass = pick() < 0.65
      const tint = Math.floor(pick() * 6)
      let top = base
      let topSize = size
      const round = style >= 0.35 && style < 0.52
      if (style < 0.35) {
        // Setbacks: each tier narrower than the one below
        const shares = [0.5, 0.3, 0.2]
        shares.forEach((share, tier) => {
          topSize = size * (1 - tier * 0.2)
          top = place(
            along,
            across,
            {
              width: topSize,
              depth: topSize * 1.15,
              height: height * share,
              glass,
              round: false,
              tint
            },
            top
          )
        })
      } else if (round) {
        top = place(
          along,
          across,
          { width: size, depth: size, height, glass: true, round: true, tint },
          top
        )
      } else {
        const depth = size * between(0.8, 1.5)
        top = place(along, across, { width: size, depth, height, glass, round: false, tint }, top)
      }
      const spot = fromStrip(city, along, across)
      const finish = look?.[1] ?? pick()
      if (finish < 0.3) {
        spires.push({
          ...spot,
          y: top,
          height: height * between(0.12, 0.25),
          radius: between(1, 2)
        })
      } else if (finish < 0.5 && !round) {
        crowns.push({
          ...spot,
          y: top,
          turn,
          width: topSize,
          depth: topSize,
          height: height * between(0.06, 0.12),
          glass,
          round: false,
          tint
        })
      } else {
        // Plant room and a mast
        const plant = place(
          along,
          across,
          {
            width: topSize * 0.45,
            depth: topSize * 0.45,
            height: 6,
            glass: false,
            round: false,
            tint: 6
          },
          top
        )
        if (pick() < 0.5) spires.push({ ...spot, y: plant, height: between(8, 20), radius: 0.4 })
      }
    }

    for (const block of blocks) {
      const r = reach(block)
      const center = fromStrip(city, block.along, block.across)
      const ceiling = buildingCeiling(center.x, center.z)
      const ground = baseHeight(center.x, center.z, Math.max(block.length, block.width) / 2)
      const room = ceiling - ground

      if (block.use === 'park' || block.use === 'plaza') {
        const spacing = block.use === 'park' ? 13 : 24
        for (let a = -block.length / 2 + 8; a < block.length / 2 - 6; a += spacing) {
          for (let c = -block.width / 2 + 8; c < block.width / 2 - 6; c += spacing) {
            // The plaza keeps its middle open, the park leaves a few clearings
            if (block.use === 'plaza' && Math.abs(a) < block.length / 2 - 14) {
              if (Math.abs(c) < block.width / 2 - 14) continue
            }
            if (block.use === 'park' && pick() < 0.25) continue
            const spot = fromStrip(city, block.along + a + between(-3, 3), block.across + c)
            trees.push({ x: spot.x, y: heightAt(spot.x, spot.z), z: spot.z, size: between(3, 5.5) })
          }
        }
        continue
      }

      if (block.use === 'houses') {
        // Two rows of houses facing the streets on the long sides of the block
        for (const edge of [-1, 1]) {
          for (let a = -block.length / 2 + 9; a < block.length / 2 - 8; a += between(17, 22)) {
            const spot = fromStrip(
              city,
              block.along + a,
              block.across + edge * (block.width / 2 - 13)
            )
            houses.push({
              x: spot.x,
              y: baseHeight(spot.x, spot.z, 6),
              z: spot.z,
              turn: turn + (pick() < 0.5 ? 0 : Math.PI / 2),
              width: between(8, 11),
              depth: between(9, 13),
              wallHeight: between(3.2, 6.4),
              roofHeight: between(2, 3.2)
            })
          }
        }
        continue
      }

      if (r < 0.38 && room > 70) {
        // Downtown: towers on podiums, tallest near the heart of the city
        const landmark = landmarks.indexOf(block)
        const pair = block.length > 100 && landmark < 0 ? 2 : 1
        if (pick() < 0.6) {
          place(block.along, block.across, {
            width: block.width - 10,
            depth: block.length - 10,
            height: between(10, 18),
            glass: false,
            round: false,
            tint: Math.floor(pick() * 6)
          })
        }
        for (let k = 0; k < pair; k++) {
          const along = block.along + (pair === 2 ? (k - 0.5) * block.length * 0.5 : 0)
          if (landmark >= 0) {
            // A stepped tower with a spire, a glass cylinder, and a block with a pointed crown
            const size = Math.min(block.width - 16, block.length - 16, between(46, 58))
            const height = Math.min([340, 290, 255][landmark] * between(0.92, 1.05), room - 12)
            const looks: [number, number][] = [
              [0.1, 0.1],
              [0.4, 0.9],
              [0.8, 0.4]
            ]
            tower(along, block.across, size, height, ground, looks[landmark])
            continue
          }
          const size = Math.min(block.width - 18, block.length / pair - 14, between(30, 52))
          const wanted = (260 - (r / 0.38) * 160) * between(0.5, 1.05)
          const height = Math.min(wanted, room - 12)
          if (height < 45) continue
          tower(along, block.across, size, height, ground)
        }
        continue
      }

      // Mid-rise ring and low-rise edge: the block is split into lots
      const mid = r < 0.7
      const lotsAlong = block.length > 95 ? (mid ? 2 : 3) : mid ? 1 : 2
      const lotsAcross = block.width > 95 ? 2 : 1
      const lotLength = block.length / lotsAlong
      const lotWidth = block.width / lotsAcross
      for (let i = 0; i < lotsAlong; i++) {
        for (let j = 0; j < lotsAcross; j++) {
          if (pick() < 0.08) continue
          const along = block.along + (i - (lotsAlong - 1) / 2) * lotLength
          const across = block.across + (j - (lotsAcross - 1) / 2) * lotWidth
          const fade = mid ? 1 - (r - 0.38) / 0.32 : 0
          let height = mid ? between(16, 30) + fade * between(0, 45) : between(7, 17)
          // Now and then an apartment or office tower rises out of the mid-rise ring
          if (mid && pick() < 0.08) height = between(70, 120)
          height = Math.min(height, room - 8)
          if (height < 6) continue
          const glass = mid && height > 40 ? pick() < 0.5 : pick() < 0.12
          const top = place(along, across, {
            width: lotWidth - between(6, 14),
            depth: lotLength - between(6, 14),
            height,
            glass,
            round: false,
            tint: Math.floor(pick() * 6)
          })
          // Plant on the roofs of bigger buildings
          if (height > 20 && pick() < 0.5) {
            place(
              along + between(-4, 4),
              across + between(-4, 4),
              {
                width: between(5, 9),
                depth: between(5, 12),
                height: between(2.5, 4.5),
                glass: false,
                round: false,
                tint: 6
              },
              top
            )
          }
        }
      }
    }

    // Suburbs: rows of houses on the gentle ground around the city, thinning out with distance
    const SUBURB = 420
    const SPACING = 32
    for (let a = -city.length / 2 - SUBURB; a <= city.length / 2 + SUBURB; a += SPACING) {
      for (let c = -city.width / 2 - SUBURB; c <= city.width / 2 + SUBURB; c += SPACING) {
        const away = Math.hypot(
          Math.max(Math.abs(a) - city.length / 2, 0),
          Math.max(Math.abs(c) - city.width / 2, 0)
        )
        if (away < 70 || pick() > 0.8 * (1 - away / SUBURB)) continue
        const spot = fromStrip(city, a + between(-5, 5), c + between(-5, 5))
        if (heightAt(spot.x, spot.z) < 4 || slopeAt(spot.x, spot.z) > 0.15) continue
        if (isClearZone(spot.x, spot.z)) continue
        houses.push({
          x: spot.x,
          y: baseHeight(spot.x, spot.z, 6),
          z: spot.z,
          turn: turn + (pick() < 0.5 ? 0 : Math.PI / 2) + between(-0.1, 0.1),
          width: between(8, 11),
          depth: between(9, 13),
          wallHeight: between(3.2, 6.4),
          roofHeight: between(2, 3.2)
        })
      }
    }
  }
  return { plans, towers, spires, crowns, trees, houses }
}

/** Walks inland along a compass bearing and returns the first point at least `minHeight` high. */
function coastPoint(bearing: number, minHeight: number) {
  for (let reach = WORLD_SIZE / 2; reach > 0; reach -= 20) {
    const x = Math.sin(bearing) * reach
    const z = -Math.cos(bearing) * reach
    if (heightAt(x, z) >= minHeight) return { x, y: heightAt(x, z), z, reach }
  }
  return { x: 0, y: heightAt(0, 0), z: 0, reach: 0 }
}

/** The headland of the main island that reaches farthest west gets the lighthouse. */
function findHeadland() {
  let best = coastPoint(Math.PI * 1.25, 8)
  for (let step = 0; step < 24; step++) {
    const point = coastPoint(Math.PI * (1.25 + step / 48), 8)
    if (point.reach > best.reach) best = point
  }
  return best
}

const random = seededRandom(505)
const between = (min: number, max: number) => min + random() * (max - min)
const eitherWay = () => (random() < 0.5 ? -1 : 1)

/** Finds circular routes that stay over deep water all the way round. */
function seaRoutes(count: number, minRadius: number, maxRadius: number, speed: [number, number]) {
  const routes: Orbit[] = []
  for (let attempt = 0; attempt < 4000 && routes.length < count; attempt++) {
    const centerX = between(-WORLD_SIZE * 0.42, WORLD_SIZE * 0.42)
    const centerZ = between(-WORLD_SIZE * 0.42, WORLD_SIZE * 0.42)
    const radius = between(minRadius, maxRadius)
    let clear = true
    for (let i = 0; i < 48 && clear; i++) {
      const angle = (i / 48) * Math.PI * 2
      clear = heightAt(centerX + Math.cos(angle) * radius, centerZ + Math.sin(angle) * radius) < -22
    }
    if (!clear) continue
    routes.push({
      centerX,
      centerZ,
      radius,
      height: 0,
      angle: between(0, Math.PI * 2),
      rate: (eitherWay() * between(speed[0], speed[1])) / radius
    })
  }
  return routes
}

const CITY = buildCities()
export const CITY_PLANS = CITY.plans
export const TOWERS = CITY.towers
export const SPIRES = CITY.spires
export const CROWNS = CITY.crowns
export const PARK_TREES = CITY.trees
export const HOUSES = [...buildHouses(), ...CITY.houses]
export const LIGHTHOUSE = findHeadland()
export const SAILBOATS = seaRoutes(36, 700, 2600, [2, 4.5])
export const SHIP = seaRoutes(1, 3000, 4200, [6, 6])[0] ?? SAILBOATS[0]

/** Hot-air balloons drift in wide circles over the villages. */
export const BALLOONS: Orbit[] = VILLAGE_SITES.slice(0, 5).map(([x, z]) => ({
  centerX: x + between(-600, 600),
  centerZ: z + between(-600, 600),
  radius: between(500, 1100),
  height: Math.max(heightAt(x, z), 0) + between(260, 620),
  angle: between(0, Math.PI * 2),
  rate: (eitherWay() * between(1.5, 3)) / 800
}))

/** Each flock circles a spot on the shoreline. */
export const FLOCKS: Orbit[][] = Array.from({ length: 8 }, (_, flock) => {
  const coast = coastPoint(((flock + 0.4) / 8) * Math.PI * 2, 1)
  const height = between(45, 140)
  const way = eitherWay()
  return Array.from({ length: 14 }, () => ({
    centerX: coast.x + between(-40, 40),
    centerZ: coast.z + between(-40, 40),
    radius: between(90, 240),
    height: coast.y + height + between(-15, 15),
    angle: between(0, Math.PI * 2),
    rate: (way * between(9, 13)) / 160
  }))
})

function buildTrees() {
  const pick = seededRandom(7)
  const trees: Tree[] = []
  let pines = 0
  let broadleaves = 0
  // Bigger islands get more of the tries, in proportion to their area
  const area = ISLES.reduce((sum, isle) => sum + isle.radius ** 2, 0)
  for (let attempt = 0; attempt < 3_000_000 && trees.length < 90_000; attempt++) {
    let share = pick() * area
    const isle = ISLES.find(candidate => {
      share -= candidate.radius ** 2
      return share <= 0
    })
    if (!isle) continue
    const x = isle.x + (pick() - 0.5) * isle.radius * 2.6
    const z = isle.z + (pick() - 0.5) * isle.radius * 2.6
    const height = heightAt(x, z)
    if (height < 4 || height > 640) continue
    // Trees thin out toward open grassland
    if (pick() > Math.min(1, Math.max(0.03, (forestAt(x, z) - 0.38) * 5))) continue
    if (slopeAt(x, z) > 0.6 || isClearZone(x, z)) continue
    // Broadleaf woods in the lowlands give way to conifers higher up
    const broadleaf = pick() > (height - 20) / 160
    if (broadleaf ? broadleaves >= 24_000 : pines >= 66_000) continue
    const tall = broadleaf ? 9 + pick() * 7 : 12 + pick() * 12
    const wide = tall * (broadleaf ? 0.95 + pick() * 0.3 : 0.85 + pick() * 0.3)
    trees.push({ x, y: height - 0.3, z, tall, wide, broadleaf })
    if (broadleaf) broadleaves++
    else pines++
  }
  return trees
}

export const TREES = buildTrees()

/**
 * Roads as lists of waypoints: from each city to its airport terminal and to the nearest village.
 * They follow the ground between waypoints.
 */
export const ROADS: [number, number][][] = CITIES.flatMap(city => {
  const airport = AIRPORTS.find(candidate => candidate.code === city.home) ?? AIRPORTS[0]
  const terminal = airport.buildings[0]
  // Arrive on the landside of the terminal, away from the apron
  const landside = fromStrip(terminal, 0, -60)
  const village = VILLAGE_SITES.reduce((nearest, site) =>
    Math.hypot(site[0] - city.x, site[1] - city.z) <
    Math.hypot(nearest[0] - city.x, nearest[1] - city.z)
      ? site
      : nearest
  )
  return [
    [
      [city.x, city.z],
      [(city.x + landside.x) / 2, (city.z + landside.z) / 2],
      [landside.x, landside.z]
    ],
    [
      [city.x, city.z],
      [village[0], village[1]]
    ]
  ] as [number, number][][]
})

/** Every fixed thing the aircraft can hit. */
export const OBSTACLES: Obstacle[] = [
  // The crown is the widest part of a tree, and narrower on a conifer
  ...TREES.map(
    (tree): Obstacle => ({
      x: tree.x,
      z: tree.z,
      base: tree.y,
      top: tree.y + tree.tall * 0.95,
      radius: tree.wide * (tree.broadleaf ? 0.3 : 0.18),
      kind: 'tree'
    })
  ),
  ...HOUSES.map(
    (house): Obstacle => ({
      x: house.x,
      z: house.z,
      base: house.y,
      top: house.y + house.wallHeight + house.roofHeight * 0.7,
      radius: Math.max(house.width, house.depth) * 0.5,
      kind: 'building'
    })
  ),
  // Big blocks become a grid of circles, small enough for the collision lookup
  ...TOWERS.flatMap(tower => {
    if (tower.round) {
      const { x, z, y, height, width } = tower
      return [{ x, z, base: y, top: y + height, radius: width / 2, kind: 'building' } as Obstacle]
    }
    const across = Math.ceil(tower.width / 50)
    const along = Math.ceil(tower.depth / 50)
    const cellWidth = tower.width / across
    const cellDepth = tower.depth / along
    const circles: Obstacle[] = []
    for (let i = 0; i < across; i++) {
      for (let j = 0; j < along; j++) {
        // Width runs along the building's local X axis and depth along its local Z axis
        const localX = (i - (across - 1) / 2) * cellWidth
        const localZ = (j - (along - 1) / 2) * cellDepth
        circles.push({
          x: tower.x + Math.cos(tower.turn) * localX + Math.sin(tower.turn) * localZ,
          z: tower.z - Math.sin(tower.turn) * localX + Math.cos(tower.turn) * localZ,
          base: tower.y,
          top: tower.y + tower.height,
          radius: Math.hypot(cellWidth, cellDepth) * 0.45,
          kind: 'building'
        })
      }
    }
    return circles
  }),
  ...SPIRES.map(
    (spire): Obstacle => ({
      x: spire.x,
      z: spire.z,
      base: spire.y,
      top: spire.y + spire.height,
      radius: spire.radius,
      kind: 'building'
    })
  ),
  ...CROWNS.map(
    (crown): Obstacle => ({
      x: crown.x,
      z: crown.z,
      base: crown.y,
      top: crown.y + crown.height * 0.6,
      radius: crown.width * 0.4,
      kind: 'building'
    })
  ),
  ...PARK_TREES.map(
    (tree): Obstacle => ({
      x: tree.x,
      z: tree.z,
      base: tree.y,
      top: tree.y + tree.size * 2.6,
      radius: tree.size * 0.6,
      kind: 'tree'
    })
  ),
  {
    x: LIGHTHOUSE.x,
    z: LIGHTHOUSE.z,
    base: LIGHTHOUSE.y,
    top: LIGHTHOUSE.y + 33.5,
    radius: 4,
    kind: 'building'
  },
  // Long buildings become a row of circles, one for every stretch as long as they are deep
  ...AIRPORTS.flatMap(airport =>
    airport.buildings.flatMap(building => {
      const circles = Math.max(1, Math.round(building.length / building.width))
      return Array.from({ length: circles }, (_, i): Obstacle => {
        const along = ((i + 0.5) / circles - 0.5) * building.length
        return {
          ...fromStrip(building, along, 0),
          base: airport.elevation,
          top: airport.elevation + building.height,
          radius: building.width * 0.55,
          kind: 'building'
        }
      })
    })
  )
]

/** Height of the tallest obstacle above its base, in metres. */
export const TALLEST_OBSTACLE = OBSTACLES.reduce(
  (tallest, obstacle) => Math.max(tallest, obstacle.top - obstacle.base),
  0
)

type Point = { x: number; y: number; z: number }

/** Writes the position on an orbit at `time` seconds into `out` and returns the orbit angle. */
export function orbitPosition(orbit: Orbit, time: number, out: Point) {
  const angle = orbit.angle + orbit.rate * time
  out.x = orbit.centerX + Math.cos(angle) * orbit.radius
  out.y = orbit.height
  out.z = orbit.centerZ + Math.sin(angle) * orbit.radius
  return angle
}

/** Centre of a balloon's envelope at `time`. Balloons also rise and sink a little. */
export function balloonPosition(index: number, time: number, out: Point) {
  orbitPosition(BALLOONS[index], time, out)
  out.y += Math.sin(time * 0.15 + index * 1.7) * 14
}
