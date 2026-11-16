import { AIRPORTS, type Airport, fromStrip, heightAt, type Strip, toStrip } from './island'
import { seededRandom } from './noise'

/** One end of a runway, seen by an aircraft landing on it. Heading is in degrees. */
export type RunwayEnd = {
  airport: Airport
  runway: Strip
  /** Painted number, such as 09 or 27L. */
  designator: string
  heading: number
  /** Where the landing part of the runway begins. */
  x: number
  z: number
  elevation: number
  /** Which way along the runway's own axis the landing runs: 1 or -1. */
  sense: 1 | -1
}

export type FixRole = 'DEP' | 'WPT' | 'IAF' | 'IF' | 'FAF' | 'RWY'

/** A named point on the approach, with the altitude to cross it at in metres. */
export type Fix = {
  name: string
  role: FixRole
  x: number
  z: number
  altitude: number
  /** Distance before the threshold in metres. */
  distance: number
}

/**
 * ILS: radio beams give a localizer for the centreline and a glideslope for the descent,
 * both more sensitive near the runway. RNAV: GPS guidance through waypoints, with a fixed
 * tolerance either side.
 */
export type ApproachKind = 'ILS' | 'RNAV'

export type Approach = {
  /** Such as 'ILS 27 CBI'. */
  id: string
  kind: ApproachKind
  end: RunwayEnd
  /** Descent angle in radians. Steeper than 3° where hills stand under the approach. */
  glide: number
  /** From the initial approach fix to the runway threshold. */
  fixes: Fix[]
}

/** Glide path height above the threshold, in metres. */
export const THRESHOLD_CROSSING = 15
/** Distances from the threshold for the initial, intermediate, and final approach fixes. */
const FIX_DISTANCES: [FixRole, number][] = [
  ['IAF', 20_000],
  ['IF', 13_000],
  ['FAF', 8_000]
]
// Glide angles tried in order until the path clears the ground
const GLIDE_ANGLES = [3, 3.5, 4, 4.5, 5].map(degrees => (degrees * Math.PI) / 180)
// Signals beyond this distance in metres are too weak to fly
const ILS_RANGE = 46_000
const ILS_SECTOR = (35 * Math.PI) / 180
// Deviation per dot: degrees for the ILS beams, metres for RNAV
const LOCALIZER_DOT = 1.25
const GLIDESLOPE_DOT = 0.35
const LNAV_DOT_TERMINAL = 926
const LNAV_DOT_FINAL = 278
const VNAV_DOT = 23

const DEGREES = 180 / Math.PI
const radians = (degrees: number) => degrees / DEGREES

/** Runway number from a heading: 270° becomes 27, 360° becomes 36. */
function runwayNumber(heading: number) {
  const number = Math.round((((heading % 360) + 360) % 360) / 10)
  return String(number === 0 ? 36 : number).padStart(2, '0')
}

function buildEnds() {
  return AIRPORTS.flatMap(airport => {
    const ends = airport.runways.flatMap(runway =>
      ([1, -1] as const).map(sense => {
        const threshold = fromStrip(runway, (-sense * runway.length) / 2, 0)
        return {
          airport,
          runway,
          designator: runwayNumber(runway.heading + (sense === 1 ? 0 : 180)),
          heading: (runway.heading + (sense === 1 ? 0 : 180)) % 360,
          x: threshold.x,
          z: threshold.z,
          elevation: airport.elevation,
          sense
        }
      })
    )
    // Parallel runways share a number, so add L or R as seen by the landing pilot
    for (const end of ends) {
      const twins = ends.filter(other => other.designator === end.designator)
      if (twins.length < 2) continue
      const across = (candidate: RunwayEnd) =>
        toStrip(candidate.runway, airport.x, airport.z).across * candidate.sense
      // The runway further right of the airport centre is the right one
      end.designator += across(end) < Math.min(...twins.map(across)) + 1 ? 'R' : 'L'
    }
    return ends
  })
}

export const RUNWAY_ENDS: RunwayEnd[] = buildEnds()

/** Position on the extended centreline `distance` metres before the threshold. */
export function onCentreline(end: RunwayEnd, distance: number, across = 0) {
  const course = radians(end.heading)
  return {
    x: end.x - Math.sin(course) * distance + Math.cos(course) * across,
    z: end.z + Math.cos(course) * distance + Math.sin(course) * across
  }
}

/** Height of the glide path above sea level, `distance` metres before the threshold. */
export function pathAltitude(end: RunwayEnd, glide: number, distance: number) {
  return end.elevation + THRESHOLD_CROSSING + Math.max(distance, 0) * Math.tan(glide)
}

/** The shallowest glide angle whose path stays clear of the hills, or null if none does. */
function clearGlide(end: RunwayEnd) {
  return (
    GLIDE_ANGLES.find(glide => {
      for (let distance = 600; distance <= FIX_DISTANCES[0][1]; distance += 100) {
        const needed = Math.min(120, 8 + distance * 0.01)
        const path = pathAltitude(end, glide, distance)
        for (const across of [-90, 0, 90]) {
          const { x, z } = onCentreline(end, distance, across)
          if (path - Math.max(heightAt(x, z), 0) < needed) return false
        }
      }
      return true
    }) ?? null
  )
}

const CONSONANTS = 'BDFGKLMNPRSTVZ'
const VOWELS = 'AEIOU'

/** Five-letter waypoint names that are pronounceable, such as KOBAL. */
export function fixName(random: () => number) {
  const pick = (letters: string) => letters[Math.floor(random() * letters.length)]
  return pick(CONSONANTS) + pick(VOWELS) + pick(CONSONANTS) + pick(VOWELS) + pick(CONSONANTS)
}

function buildApproaches() {
  const approaches: Approach[] = []
  RUNWAY_ENDS.forEach((end, i) => {
    const glide = clearGlide(end)
    if (glide === null) return
    const random = seededRandom(9100 + i)
    const fixes: Fix[] = FIX_DISTANCES.map(([role, distance]) => ({
      name: fixName(random),
      role,
      ...onCentreline(end, distance),
      altitude: pathAltitude(end, glide, distance),
      distance
    }))
    fixes.push({
      name: `RW${end.designator}`,
      role: 'RWY',
      x: end.x,
      z: end.z,
      altitude: end.elevation + THRESHOLD_CROSSING,
      distance: 0
    })
    const code = end.airport.code
    // Big airports have ILS on every runway, regional ones on the main runway
    const main = end.runway === end.airport.runways[0]
    const ils = end.airport.kind === 'international' || (end.airport.kind === 'regional' && main)
    if (ils)
      approaches.push({ id: `ILS ${end.designator} ${code}`, kind: 'ILS', end, glide, fixes })
    approaches.push({ id: `RNAV ${end.designator} ${code}`, kind: 'RNAV', end, glide, fixes })
  })
  return approaches
}

export const APPROACHES: Approach[] = buildApproaches()

/** Where the aircraft is relative to an approach, and which way to steer to fly it. */
export type Guidance = {
  /** Metres before the threshold along the approach course, negative past it. */
  along: number
  /** Metres right of the extended centreline, seen by the landing pilot. */
  across: number
  /** Deviation in dots, -2.5 to 2.5. Positive when the course lies to the right. */
  lateral: number
  /** Deviation in dots, -2.5 to 2.5. Positive when the glide path lies above. */
  vertical: number
  /** False when an ILS beam is out of range or the aircraft is behind it. */
  receiving: boolean
  pathAltitude: number
}

/** Works out the deviations an approach's instruments would show at a position. */
export function guide(approach: Approach, x: number, y: number, z: number, out: Guidance) {
  const { end, glide } = approach
  const course = radians(end.heading)
  const dx = x - end.x
  const dz = z - end.z
  out.along = -(dx * Math.sin(course) - dz * Math.cos(course))
  out.across = dx * Math.cos(course) + dz * Math.sin(course)
  out.pathAltitude = pathAltitude(end, glide, out.along)
  const clampDots = (dots: number) => Math.min(2.5, Math.max(-2.5, dots))
  if (approach.kind === 'ILS') {
    // The localizer stands past the far end, the glideslope antenna beside the touchdown zone
    const toLocalizer = out.along + end.runway.length + 300
    const offCourse = Math.atan2(out.across, toLocalizer) * DEGREES
    const toGlideslope = Math.max(out.along + 300, 1)
    const elevation = Math.atan2(y - end.elevation, toGlideslope) * DEGREES
    out.lateral = clampDots(-offCourse / LOCALIZER_DOT)
    out.vertical = clampDots((glide * DEGREES - elevation) / GLIDESLOPE_DOT)
    out.receiving = Math.hypot(dx, dz) < ILS_RANGE && Math.abs(radians(offCourse)) < ILS_SECTOR
  } else {
    const final = out.along < FIX_DISTANCES[2][1] + 500
    out.lateral = clampDots(-out.across / (final ? LNAV_DOT_FINAL : LNAV_DOT_TERMINAL))
    out.vertical = clampDots((out.pathAltitude - y) / VNAV_DOT)
    out.receiving = true
  }
  return out
}
