import type { AircraftSpec } from '../sim/aircraft'
import type { FlightSim } from '../sim/flight-sim'
import {
  APPROACHES,
  type Approach,
  type Fix,
  fixName,
  type Guidance,
  guide
} from '../world/approaches'
import { type Airport, heightAt } from '../world/island'
import { seededRandom } from '../world/noise'

// A fix counts as passed within this many metres, or once the aircraft is abeam it
const FIX_PASSED = 1500
const ABEAM_WIDTH = 2500
// Seconds to settle onto a route leg, and the steepest intercept angle in radians
const INTERCEPT_TIME = 25
const MAX_INTERCEPT = 0.52
// Planned descent angle to the first approach waypoint
const DESCENT = (3 * Math.PI) / 180
// Route waypoints are about this far apart, and the first one this far past the runway
const LEG_LENGTH = 22_000
const DEPARTURE_LEG = 8000
// Height kept above the highest ground near the route, in metres
const ROUTE_CLEARANCE = 450

/**
 * A route to another airport: a departure waypoint straight out from the runway, waypoints
 * along the way at the cruise altitude, then the destination's approach.
 */
export type FlightPlan = {
  to: Airport
  /** Where the route starts, and the waypoints before the approach. */
  origin: { x: number; z: number }
  fixes: Fix[]
  /** Lowest safe altitude on the leg to each waypoint, in metres. */
  safe: number[]
  /** Lowest safe altitude from the last route waypoint to the approach's first waypoint. */
  joinSafe: number
  cruise: number
  approach: Approach
}

/**
 * The approach picked for landing, and progress along its waypoints.
 * Call `update` every frame, then read `guidance` and `active`.
 */
export class Navigator {
  plan: FlightPlan | null = null
  /** Index of the route waypoint ahead, or the waypoint count once the approach has begun. */
  leg = 0
  approach: Approach | null = null
  /** Index of the waypoint the aircraft is flying toward. */
  active = 0
  readonly guidance: Guidance = {
    along: 0,
    across: 0,
    lateral: 0,
    vertical: 0,
    receiving: false,
    pathAltitude: 0
  }
  /** The route's waypoints followed by the approach's, for drawing on maps. */
  waypoints: Fix[] = []
  /** True from the end of a route until the aircraft reaches the approach's first waypoint. */
  private joining = false
  /** Approaches in the order N steps through them, nearest airport first. */
  private choices: Approach[] = []

  /**
   * Steps to the next approach, starting with the nearest airport. After the last one, none.
   * `windFrom` is in degrees, so runways facing into the wind come first.
   */
  cycle(sim: FlightSim, windFrom: number) {
    // A plan's approach is not in an old list, so the list is rebuilt around it
    if (!this.approach || !this.choices.includes(this.approach)) {
      this.choices = rankApproaches(sim.position.x, sim.position.z, windFrom)
    }
    const next = this.approach ? this.choices.indexOf(this.approach) + 1 : 0
    this.select(this.choices[next] ?? null, sim)
  }

  /** Loads a flight plan and its approach, or clears both. */
  load(plan: FlightPlan | null, sim: FlightSim) {
    this.plan = plan
    this.leg = 0
    this.select(plan?.approach ?? null, sim)
    this.active = 0
  }

  /** Index into `waypoints` of the one ahead. */
  get waypointAhead() {
    return (this.plan ? this.leg : 0) + (this.enroute ? 0 : this.active)
  }

  /** True while flying the route's waypoints, before the approach. */
  get enroute() {
    return this.plan !== null && this.leg < this.plan.fixes.length
  }

  /** Picks an approach, or none, and starts at the first waypoint still ahead. */
  select(approach: Approach | null, sim: FlightSim) {
    this.approach = approach
    this.active = 0
    this.joining = false
    this.waypoints = [...(this.plan?.fixes ?? []), ...(approach?.fixes ?? [])]
    if (!approach) return
    const { along, across } = guide(
      approach,
      sim.position.x,
      sim.position.y,
      sim.position.z,
      this.guidance
    )
    // Already lined up on the centreline: skip the waypoints behind
    if (along > 0 && Math.abs(across) < ABEAM_WIDTH) {
      const ahead = approach.fixes.findIndex(fix => fix.distance < along - 300)
      this.active = ahead < 0 ? approach.fixes.length - 1 : ahead
    }
  }

  update(sim: FlightSim) {
    const { approach, plan } = this
    if (plan && this.enroute) {
      const { x, z } = sim.position
      const fix = plan.fixes[this.leg]
      const from = this.leg === 0 ? plan.origin : plan.fixes[this.leg - 1]
      // Passed once close, or once past the line through the waypoint square to the leg
      const legX = fix.x - from.x
      const legZ = fix.z - from.z
      const beyond = (x - fix.x) * legX + (z - fix.z) * legZ > 0
      if (Math.hypot(fix.x - x, fix.z - z) < FIX_PASSED || beyond) {
        this.leg++
        // The route is done: join the approach at its first waypoint, wherever the route
        // ended, so there is room to descend and slow down
        if (!this.enroute) {
          this.select(approach, sim)
          this.active = 0
          this.joining = true
        }
      }
    }
    if (!approach) return
    const { x, y, z } = sim.position
    const { along, across } = guide(approach, x, y, z, this.guidance)
    // The approach's waypoints count only once the route is flown, even if it passes them
    if (this.enroute) return
    const last = approach.fixes.length - 1
    const fix = approach.fixes[this.active]
    const near = Math.hypot(fix.x - x, fix.z - z) < FIX_PASSED
    // Past a waypoint along the course counts too, but never from beyond the runway
    const abeam = along > 0 && along < fix.distance && Math.abs(across) < ABEAM_WIDTH
    if (this.active < last && (near || (abeam && !this.joining))) {
      this.active++
      this.joining = false
    }
  }

  /** The waypoint ahead: on the route, then on the approach. */
  get next() {
    if (this.plan && this.enroute) return this.plan.fixes[this.leg]
    return this.approach?.fixes[this.active] ?? null
  }

  /**
   * Ground track in radians that follows the route leg ahead, turning onto it at up to 30°.
   * Null once the route is flown, when the approach takes over.
   */
  routeTrack(sim: FlightSim) {
    const { plan } = this
    if (!plan || !this.enroute) return null
    const fix = plan.fixes[this.leg]
    const from = this.leg === 0 ? plan.origin : plan.fixes[this.leg - 1]
    const course = Math.atan2(fix.x - from.x, -(fix.z - from.z))
    const { x, z } = sim.position
    // Metres right of the leg, seen along it
    const across = (x - from.x) * Math.cos(course) + (z - from.z) * Math.sin(course)
    const speed = Math.max(sim.groundSpeed, 30)
    const intercept = Math.min(
      MAX_INTERCEPT,
      Math.max(-MAX_INTERCEPT, -across / (speed * INTERCEPT_TIME))
    )
    return course + intercept
  }

  /**
   * Altitude the planned profile asks for here: the cruise altitude, then a 3° descent that
   * reaches the first approach waypoint at its height, never below the leg's safe altitude.
   */
  profileAltitude(sim: FlightSim) {
    const { plan } = this
    if (!plan || !this.enroute) return null
    const { x, z } = sim.position
    let remaining = Math.hypot(plan.fixes[this.leg].x - x, plan.fixes[this.leg].z - z)
    const route = [...plan.fixes.slice(this.leg), plan.approach.fixes[0]]
    for (let i = 1; i < route.length; i++) {
      remaining += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z)
    }
    const descent = plan.approach.fixes[0].altitude + remaining * Math.tan(DESCENT)
    return Math.max(Math.min(plan.cruise, descent), plan.safe[this.leg])
  }

  /** True once past the initial fix and following the centreline in. */
  get onFinal() {
    return this.approach !== null && this.active > 0
  }
}

/**
 * Orders approaches by airport distance, then by the runway best facing the wind,
 * with the ILS before the RNAV approach to the same runway.
 */
export function rankApproaches(x: number, z: number, windFrom: number) {
  const headwind = (approach: Approach) =>
    Math.cos(((approach.end.heading - windFrom) * Math.PI) / 180)
  const distance = (approach: Approach) =>
    Math.hypot(approach.end.airport.x - x, approach.end.airport.z - z)
  return [...APPROACHES].sort(
    (a, b) =>
      distance(a) - distance(b) ||
      headwind(b) - headwind(a) ||
      (a.kind === 'ILS' ? 0 : 1) - (b.kind === 'ILS' ? 0 : 1)
  )
}

/** Highest ground within 1.5 km either side of a straight line, in metres. */
function highestGround(fromX: number, fromZ: number, toX: number, toZ: number) {
  const length = Math.hypot(toX - fromX, toZ - fromZ)
  const sideX = -(toZ - fromZ) / Math.max(length, 1)
  const sideZ = (toX - fromX) / Math.max(length, 1)
  let highest = 0
  for (let along = 0; along <= length; along += 250) {
    const t = along / Math.max(length, 1)
    for (const offset of [-1500, -750, 0, 750, 1500]) {
      const x = fromX + (toX - fromX) * t + sideX * offset
      const z = fromZ + (toZ - fromZ) * t + sideZ * offset
      highest = Math.max(highest, heightAt(x, z))
    }
  }
  return highest
}

/**
 * Plans a route from a start point and heading (radians) to an airport's best approach for
 * the wind. The cruise altitude grows with distance and clears the hills along the way.
 */
export function planRoute(
  start: { x: number; z: number; heading: number },
  to: Airport,
  spec: AircraftSpec,
  windFrom: number
): FlightPlan | null {
  const approach = rankApproaches(to.x, to.z, windFrom).find(
    candidate => candidate.end.airport === to
  )
  if (!approach) return null
  const random = seededRandom(Math.round(start.x * 7 + start.z * 13 + to.x))
  const departure = {
    x: start.x + Math.sin(start.heading) * DEPARTURE_LEG,
    z: start.z - Math.cos(start.heading) * DEPARTURE_LEG
  }
  const entry = approach.fixes[0]
  const span = Math.hypot(entry.x - departure.x, entry.z - departure.z)
  const legs = Math.max(1, Math.round(span / LEG_LENGTH))
  const points = [departure]
  for (let i = 1; i < legs; i++) {
    points.push({
      x: departure.x + ((entry.x - departure.x) * i) / legs,
      z: departure.z + ((entry.z - departure.z) * i) / legs
    })
  }
  // Leg safe altitudes, then a cruise altitude above all of them, rounded up to 500 ft
  const corners = [start, ...points, entry]
  const safe = points.map(
    (_, i) =>
      highestGround(corners[i].x, corners[i].z, corners[i + 1].x, corners[i + 1].z) +
      ROUTE_CLEARANCE
  )
  const last = corners.length - 1
  const ceiling = spec.engine.type === 'piston' ? 2600 : 7500
  const wanted = Math.min(ceiling, Math.max(900, span * 0.02 + to.elevation))
  const joinSafe =
    highestGround(corners[last - 1].x, corners[last - 1].z, entry.x, entry.z) + ROUTE_CLEARANCE
  const highest = Math.max(...safe, joinSafe)
  const cruise = Math.ceil(Math.max(wanted, highest, entry.altitude) / 152.4) * 152.4
  let distance = 0
  const fixes: Fix[] = points.map((point, i) => {
    distance += Math.hypot(point.x - corners[i].x, point.z - corners[i].z)
    return {
      name: fixName(random),
      role: i === 0 ? 'DEP' : 'WPT',
      x: point.x,
      z: point.z,
      altitude: cruise,
      distance
    }
  })
  return { to, origin: { x: start.x, z: start.z }, fixes, safe, joinSafe, cruise, approach }
}
