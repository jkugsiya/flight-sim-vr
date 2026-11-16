import { CITIES, outside } from '../world/island'
import { HOUSES, TOWERS } from '../world/scenery'

/** Buildings within this many metres of a bomb's blast fall. */
export const BLAST_REACH = 100

/** One building's footprint on the ground: a tower with its stacked blocks, or a house. */
export type Site = {
  x: number
  z: number
  width: number
  depth: number
  turn: number
  /** Index into CITIES, or -1 for a village house. */
  city: number
}

// The houses around a city's edge belong to it, as far out as this many metres
const SUBURBS = 400
const cityOf = (x: number, z: number) => CITIES.findIndex(city => outside(city, x, z) <= SUBURBS)

function buildSites(): Site[] {
  const sites: Site[] = []
  // Stacked tower blocks share a spot, and the lowest block comes first
  const seen = new Set<string>()
  for (const tower of TOWERS) {
    const key = `${tower.x} ${tower.z}`
    if (seen.has(key)) continue
    seen.add(key)
    const depth = tower.round ? tower.width : tower.depth
    const { x, z, width, turn } = tower
    sites.push({ x, z, width, depth, turn, city: cityOf(x, z) })
  }
  for (const { x, z, width, depth, turn } of HOUSES) {
    sites.push({ x, z, width, depth, turn, city: cityOf(x, z) })
  }
  return sites
}

const SITES = buildSites()
/** Buildings on the whole map that a bomb can bring down. */
export const SITE_COUNT = SITES.length
/** Buildings in each city, in the order of CITIES. */
export const CITY_BUILDINGS = CITIES.map((_, i) => SITES.filter(site => site.city === i).length)

/** Where each bomb burst, and every building it brought down. Cleared for each flight. */
export class Ruins {
  /** Each blast on land, and how many buildings it brought down. */
  readonly craters: { x: number; z: number; fell: number }[] = []
  /** Fallen buildings in the order they fell. */
  readonly fallen: Site[] = []
  /** Counts up each time the ruins clear, so drawings can tell a fresh start apart. */
  generation = 0
  private readonly down = new Uint8Array(SITES.length)
  private readonly fallenIn = CITIES.map(() => 0)

  /** Brings down every building within reach of a blast on land. Returns how many fell. */
  blast(x: number, z: number) {
    let fell = 0
    const reach = BLAST_REACH * BLAST_REACH
    SITES.forEach((site, i) => {
      if (this.down[i] || (site.x - x) ** 2 + (site.z - z) ** 2 > reach) return
      this.down[i] = 1
      this.fallen.push(site)
      if (site.city >= 0) this.fallenIn[site.city]++
      fell++
    })
    this.craters.push({ x, z, fell })
    return fell
  }

  /** True where a blast, widened by `margin` metres, has flattened everything. */
  covers(x: number, z: number, margin = 0) {
    const reach = (BLAST_REACH + margin) ** 2
    return this.craters.some(crater => (crater.x - x) ** 2 + (crater.z - z) ** 2 <= reach)
  }

  /** Buildings brought down in a city. */
  fallenInCity(name: string) {
    return this.fallenIn[CITIES.findIndex(city => city.name === name)] ?? 0
  }

  clear() {
    this.generation++
    this.craters.length = 0
    this.fallen.length = 0
    this.down.fill(0)
    this.fallenIn.fill(0)
  }
}
