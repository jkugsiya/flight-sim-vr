import { CatmullRomCurve3, Quaternion, Vector3 } from 'three'
import { type AirlinerShape, HANGAR } from '../sim/aircraft'
import {
  AIRPORTS,
  type Airport,
  fromStrip,
  heightAt,
  type Stand,
  type Strip
} from '../world/island'

/** Another aircraft in the world: flying a route, or parked at a gate. */
export type OtherAircraft = {
  shape: AirlinerShape
  /** Height of the fuselage centreline above the wheels. */
  gearHeight: number
  position: Vector3
  orientation: Quaternion
  /** False while it is out of sight between flights. */
  visible: boolean
  airborne: boolean
}

type Leg = {
  /** Positions along the flight, and the time in seconds each one is reached. */
  points: Vector3[]
  times: number[]
  duration: number
}

const UP = new Vector3(0, 1, 0)
const FORWARD = new Vector3(0, 0, -1)
// Seconds an aircraft stays out of sight after landing, before it flies back
const TURNAROUND = 40
const CRUISE_ALTITUDE = 2300
const SAMPLES = 500
const tangent = new Vector3()
const flat = new Vector3()
const yaw = new Quaternion()
const tilt = new Quaternion()

function shapeOf(id: string, accent: string): AirlinerShape {
  const spec = HANGAR.find(candidate => candidate.id === id)
  if (spec?.shape.type !== 'airliner') throw new Error(`No airliner called ${id} in the hangar`)
  return { ...spec.shape, accent }
}

const gearHeightOf = (id: string) => {
  const spec = HANGAR.find(candidate => candidate.id === id)
  return spec ? spec.restHeight : 3.5
}

/**
 * One flight from the start of a runway to a stop on another: takeoff roll, climb,
 * cruise, a straight-in approach, touchdown, and rollout.
 */
function planLeg(
  from: Airport,
  fromRunway: Strip,
  to: Airport,
  toRunway: Strip,
  gear: number
): Leg {
  const along = (runway: Strip, distance: number, height: number) => {
    const spot = fromStrip(runway, -runway.length / 2 + distance, 0)
    return new Vector3(spot.x, height, spot.z)
  }
  const ground1 = from.elevation + gear
  const ground2 = to.elevation + gear
  const climbOut = along(fromRunway, 6500, from.elevation + 750)
  const fix = along(toRunway, -9000, to.elevation + 560)
  const cruise = climbOut.clone().lerp(fix, 0.5).setY(CRUISE_ALTITUDE)
  const stop = Math.min(1900, toRunway.length - 200)
  // Waypoints with the speed in m/s the aircraft holds at each
  const route: [Vector3, number][] = [
    [along(fromRunway, 100, ground1), 0],
    [along(fromRunway, 700, ground1), 55],
    [along(fromRunway, 1300, ground1), 78],
    [along(fromRunway, 2400, from.elevation + 110), 88],
    [climbOut, 115],
    [cruise, 135],
    [fix, 100],
    [along(toRunway, -3500, to.elevation + 215), 80],
    [along(toRunway, -1200, to.elevation + 78), 72],
    [along(toRunway, 250, ground2), 68],
    [along(toRunway, 250 + stop * 0.5, ground2), 35],
    [along(toRunway, 250 + stop, ground2), 0]
  ]
  const curve = new CatmullRomCurve3(
    route.map(([point]) => point),
    false,
    'centripetal'
  )
  const points: Vector3[] = []
  const times: number[] = []
  let time = 0
  for (let i = 0; i <= SAMPLES; i++) {
    const share = i / SAMPLES
    const point = curve.getPoint(share)
    // Never below the wheels-on-ground height of the terrain underneath
    point.y = Math.max(point.y, Math.max(heightAt(point.x, point.z), 0) + gear)
    if (i > 0) {
      const leg = share * (route.length - 1)
      const index = Math.min(route.length - 2, Math.floor(leg))
      const speed = route[index][1] + (route[index + 1][1] - route[index][1]) * (leg - index)
      time += point.distanceTo(points[i - 1]) / Math.max(speed, 6)
    }
    points.push(point)
    times.push(time)
  }
  return { points, times, duration: time }
}

type Flight = { craft: OtherAircraft; out: Leg; back: Leg; offset: number }

/** Airliners that fly between the airports on fixed routes, and others parked at the gates. */
export class Traffic {
  readonly flying: OtherAircraft[] = []
  readonly parked: (OtherAircraft & { stand: Stand })[] = []
  private readonly flights: Flight[] = []

  constructor() {
    const at = (code: string) => {
      const airport = AIRPORTS.find(candidate => candidate.code === code)
      if (!airport) throw new Error(`Traffic route needs airport ${code}, which does not exist`)
      return airport
    }
    const [coral, azure, ridge, skerry, east, north, cape] = [
      'CBI',
      'PAZ',
      'RDG',
      'SKY',
      'EMK',
      'NGT',
      'CVY'
    ].map(at)
    const routes: [string, string, Airport, Strip, Airport, Strip][] = [
      ['a320', '#b3261e', coral, coral.runways[1], azure, azure.runways[0]],
      ['b737', '#e08a1c', azure, azure.runways[0], ridge, ridge.runways[0]],
      ['a320', '#2f7d4f', coral, coral.runways[1], skerry, skerry.runways[0]],
      ['b737', '#5a3d8a', east, east.runways[0], coral, coral.runways[0]],
      ['a320', '#1c7a8a', north, north.runways[0], azure, azure.runways[0]],
      ['b737', '#8a1c5a', east, east.runways[0], cape, cape.runways[0]],
      ['a320', '#c2a01e', north, north.runways[0], east, east.runways[0]]
    ]
    routes.forEach(([id, accent, from, fromRunway, to, toRunway], i) => {
      const gear = gearHeightOf(id)
      const craft = this.craft(id, accent)
      this.flying.push(craft)
      this.flights.push({
        craft,
        out: planLeg(from, fromRunway, to, toRunway, gear),
        back: planLeg(to, toRunway, from, fromRunway, gear),
        offset: i * 190
      })
    })

    // Park airliners at the outer gates, leaving the middle gates for the player
    const liveries = ['#b3261e', '#2f7d4f', '#e08a1c', '#5a3d8a', '#1c3f7a']
    for (const airport of AIRPORTS) {
      if (airport.kind === 'airstrip') continue
      const middle = Math.floor(airport.gates.length / 2)
      airport.gates.forEach((stand, index) => {
        if (Math.abs(index - middle) < 2 || (index + airport.gates.length) % 3 === 1) return
        const id = index % 2 ? 'b737' : 'a320'
        const craft = this.craft(id, liveries[(index + this.parked.length) % liveries.length])
        craft.position.set(stand.x, airport.elevation + craft.gearHeight, stand.z)
        craft.orientation.setFromAxisAngle(UP, -stand.heading)
        craft.visible = true
        this.parked.push({ ...craft, stand })
      })
    }
  }

  /** Moves every flying aircraft to its place at `time` seconds on the scenery clock. */
  update(time: number) {
    for (const flight of this.flights) {
      const cycle = flight.out.duration + flight.back.duration + TURNAROUND * 2
      let clock = (time + flight.offset) % cycle
      let leg = flight.out
      if (clock > flight.out.duration + TURNAROUND) {
        clock -= flight.out.duration + TURNAROUND
        leg = flight.back
      }
      const { craft } = flight
      craft.visible = clock < leg.duration
      if (!craft.visible) continue

      // Find the two samples around this moment
      let low = 0
      let high = leg.times.length - 1
      while (high - low > 1) {
        const middle = (low + high) >> 1
        if (leg.times[middle] <= clock) low = middle
        else high = middle
      }
      const span = leg.times[high] - leg.times[low]
      const share = span > 0 ? (clock - leg.times[low]) / span : 0
      craft.position.lerpVectors(leg.points[low], leg.points[high], share)
      const ground = Math.max(heightAt(craft.position.x, craft.position.z), 0)
      craft.airborne = craft.position.y - ground > craft.gearHeight + 2

      // Nose along the direction of travel, wings banked into the turn
      const before = leg.points[Math.max(0, low - 4)]
      const after = leg.points[Math.min(leg.points.length - 1, high + 4)]
      tangent.subVectors(after, before)
      if (tangent.lengthSq() < 1e-6) continue
      tangent.normalize()
      const heading = Math.atan2(tangent.x, -tangent.z)
      const earlier = flat.subVectors(leg.points[low], before)
      const turn = Math.atan2(
        Math.sin(heading - Math.atan2(earlier.x, -earlier.z)),
        Math.cos(heading - Math.atan2(earlier.x, -earlier.z))
      )
      yaw.setFromAxisAngle(UP, -heading)
      tilt.setFromAxisAngle(flat.set(1, 0, 0), Math.asin(Math.max(-0.5, Math.min(0.5, tangent.y))))
      craft.orientation.copy(yaw).multiply(tilt)
      const bank = craft.airborne ? Math.max(-0.5, Math.min(0.5, turn * 6)) : 0
      craft.orientation.multiply(tilt.setFromAxisAngle(FORWARD, bank))
    }
  }

  private craft(id: string, accent: string): OtherAircraft {
    return {
      shape: shapeOf(id, accent),
      gearHeight: gearHeightOf(id),
      position: new Vector3(),
      orientation: new Quaternion(),
      visible: false,
      airborne: false
    }
  }
}
