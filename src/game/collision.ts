import { Vector3 } from 'three'
import type { CrashReason, FlightSim } from '../sim/flight-sim'
import {
  BALLOONS,
  balloonPosition,
  OBSTACLES,
  type Obstacle,
  orbitPosition,
  SAILBOATS,
  SHIP,
  TALLEST_OBSTACLE
} from '../world/scenery'
import type { Ruins } from './ruins'
import type { Traffic } from './traffic'

// Fixed obstacles are bucketed into square cells this many metres wide
const CELL = 48
const ENVELOPE_RADIUS = 9.5
const BASKET_DROP = 14
const BASKET_RADIUS = 4
const SAILBOAT_RADIUS = 4
const SAILBOAT_HEIGHT = 13
const SHIP_RADIUS = 13
const SHIP_HEIGHT = 20

const cellKey = (x: number, z: number) => Math.floor(x / CELL) * 4096 + Math.floor(z / CELL)

function buildGrid() {
  const grid = new Map<number, Obstacle[]>()
  for (const obstacle of OBSTACLES) {
    const key = cellKey(obstacle.x, obstacle.z)
    const bucket = grid.get(key)
    if (bucket) bucket.push(obstacle)
    else grid.set(key, [obstacle])
  }
  return grid
}

const grid = buildGrid()
const point = new Vector3()
const mover = new Vector3()
const CENTRE = new Vector3()

/** Points on the airframe that can strike something: the hull, the wheels, and the centre. */
function* strikePoints(sim: FlightSim) {
  yield CENTRE
  for (const hull of sim.spec.hullPoints) yield hull.position
  for (const contact of sim.spec.contactPoints) yield contact.position
}

function insideCylinder(x: number, z: number, base: number, top: number, radius: number) {
  return (
    point.y >= base &&
    point.y <= top &&
    (point.x - x) * (point.x - x) + (point.z - z) * (point.z - z) <= radius * radius
  )
}

/**
 * Returns what the aircraft has flown into, or null.
 * `time` is the scenery clock in seconds, which positions the balloons and boats.
 */
export function findCollision(
  sim: FlightSim,
  time: number,
  traffic: Traffic,
  ruins?: Ruins
): CrashReason | null {
  const { position } = sim
  const reach = sim.spec.wingSpan

  // Other aircraft: parked ones always, flying ones only when both are in the air
  for (const other of traffic.parked) {
    const size = (other.shape.tailZ - other.shape.noseZ) * 0.4 + reach * 0.35
    if (other.position.distanceToSquared(position) < size * size) return 'traffic'
  }
  if (!sim.onGround) {
    for (const other of traffic.flying) {
      if (!other.visible || !other.airborne) continue
      const size = other.shape.wing.halfSpan + reach * 0.4
      if (other.position.distanceToSquared(position) < size * size) return 'traffic'
    }
  }

  for (let i = 0; i < BALLOONS.length; i++) {
    balloonPosition(i, time, mover)
    if (mover.distanceToSquared(position) > (ENVELOPE_RADIUS + reach + BASKET_DROP) ** 2) continue
    for (const local of strikePoints(sim)) {
      point.copy(local).applyQuaternion(sim.orientation).add(position)
      const basket = Math.hypot(
        point.x - mover.x,
        point.y - mover.y + BASKET_DROP,
        point.z - mover.z
      )
      if (point.distanceTo(mover) < ENVELOPE_RADIUS || basket < BASKET_RADIUS) return 'balloon'
    }
  }

  // Everything else stands on the ground or floats on the sea
  if (sim.altitudeAgl > TALLEST_OBSTACLE + reach) return null

  for (const local of strikePoints(sim)) {
    point.copy(local).applyQuaternion(sim.orientation).add(position)
    for (let dx = -CELL; dx <= CELL; dx += CELL) {
      for (let dz = -CELL; dz <= CELL; dz += CELL) {
        const bucket = grid.get(cellKey(point.x + dx, point.z + dz))
        if (!bucket) continue
        for (const obstacle of bucket) {
          // A building a bomb brought down is rubble now. Its widest blocks reach past
          // their centre, so the flattened area counts a little wider.
          if (obstacle.kind === 'building' && ruins?.covers(obstacle.x, obstacle.z, 40)) continue
          if (
            insideCylinder(obstacle.x, obstacle.z, obstacle.base, obstacle.top, obstacle.radius)
          ) {
            return obstacle.kind
          }
        }
      }
    }
    for (const boat of SAILBOATS) {
      orbitPosition(boat, time, mover)
      if (insideCylinder(mover.x, mover.z, 0, SAILBOAT_HEIGHT, SAILBOAT_RADIUS)) return 'boat'
    }
    // The ship is long: test three circles along its hull
    const angle = orbitPosition(SHIP, time, mover)
    for (const along of [-24, 0, 24]) {
      const x = mover.x - Math.sin(angle) * along
      const z = mover.z + Math.cos(angle) * along
      if (insideCylinder(x, z, 0, SHIP_HEIGHT, SHIP_RADIUS)) return 'boat'
    }
  }
  return null
}
