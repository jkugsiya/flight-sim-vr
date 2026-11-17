import { Vector3 } from 'three'
import { GRAVITY, SEA_LEVEL_DENSITY } from '../sim/aircraft'
import { airDensity, type FlightSim, type Ground } from '../sim/flight-sim'
import { Ruins } from './ruins'

/**
 * A target on the range. A bomb or missile landing within `radius` metres destroys it.
 * `height` is how tall it stands, for a missile to fly into, if not a low one.
 */
export type Target = { x: number; z: number; radius: number; label: string; height?: number }

/**
 * Where a bomb landed, how far it fell from the nearest target still standing, and how many
 * buildings it brought down.
 */
export type Impact = { at: Vector3; water: boolean; hit: number | null; miss: number; fell: number }

// A 500 lb bomb: drag per metre of flight at sea level, so it falls at up to 500 m/s
const DRAG = 4e-5
// Released from the bomb bay, this far below the aircraft's centre in body axes
const BAY = new Vector3(0, -1.4, 0.5)
// Seconds per step of a falling bomb, and of the aiming prediction
const STEP = 1 / 60
const PREDICT_STEP = 0.1
const PREDICT_LIMIT = 200
// A guided bomb released with the aiming cross this close to a target steers onto it, with
// up to this much sideways acceleration in m/s²
export const GUIDED_REACH = 900
const GUIDED_ACCELERATION = 25
// Missiles lock onto a target this many radians off the nose and up to this many metres away
export const LOCK_CONE = 0.26
export const LOCK_RANGE = 9000
// The seeker looks this far below the nose, in radians, as a missile's does
export const LOCK_DOWN = 0.8
// Metres a missile aims above its target per metre still to go, and at most
const LOFT = 0.08
const MAX_LOFT = 300
// Missile top speed in m/s, how fast its motor reaches it, how sharply it turns in rad/s,
// and the seconds it flies before it destroys itself
const MISSILE_SPEED = 330
const MISSILE_BOOST = 120
const MISSILE_TURN = 1.2
const MISSILE_LIFE = 30
// Launch rails under each wing, in body axes
const RAIL = new Vector3(2, -1, 0)
const NOSE = new Vector3(0, 0, -1)
// Height of a low target's middle, where a missile aims
const LOW_TARGET = 4
// Release armed with the cross lined up and up to this far short of a target waits for it
const ARM_REACH = 3000
// Seconds the bombsight stays on a blast before it turns back to the aiming cross
const WATCH_BLAST = 2.5

/** Where the aiming cross lies from a target: `long` ahead along the track, `side` to the right. */
type Offset = { long: number; side: number }

const air = new Vector3()
const rail = new Vector3()
const nose = new Vector3()
const seek = new Vector3()

/** Moves a bomb one step: gravity, and drag that grows with speed and thicker air. */
function fall(position: Vector3, velocity: Vector3, dt: number) {
  const speed = velocity.length()
  const drag = DRAG * (airDensity(position.y) / SEA_LEVEL_DENSITY) * speed
  velocity.addScaledVector(air.copy(velocity), -drag * dt)
  velocity.y -= GRAVITY * dt
  position.addScaledVector(velocity, dt)
}

const groundUnder = (ground: Ground, position: Vector3) =>
  Math.max(ground.heightAt(position.x, position.z), 0)

/**
 * The bomb bay: bombs loaded for a mission, the ones falling, the targets they are for, and
 * where a bomb released now would land. Call `update` every frame.
 */
export class Bombs {
  /** Bombs left in the bay. */
  loaded = 0
  /**
   * Bombs on their way down. `target` is what a guided bomb steers for and `aimedAt` what the
   * cross lay on at release, each a target index or -1. `lands` is where the cross lay.
   */
  readonly falling: {
    position: Vector3
    velocity: Vector3
    target: number
    aimedAt: number
    lands: Vector3
  }[] = []
  /** Buildings the bombs have brought down. */
  readonly ruins = new Ruins()
  /** Where the last bomb burst, and seconds since. */
  readonly lastImpact = new Vector3()
  sinceImpact = Number.POSITIVE_INFINITY
  targets: Target[] = []
  /** GPS-guided bombs steer themselves onto a target from the launch zone around it. */
  guided = false
  destroyed: boolean[] = []
  /** Where a bomb released now would land, while bombs are loaded and the aircraft flies. */
  readonly aim = new Vector3()
  aiming = false
  /** The target a release is armed for: the bomb drops as the cross reaches it. */
  armed = -1
  /** Missiles left on the rails. */
  missiles = 0
  /** Missiles in flight, each with the target it homes on, or -1 flying straight. */
  readonly flying: { position: Vector3; velocity: Vector3; target: number; age: number }[] = []
  /** The target a missile fired now would home on, or -1. */
  lock = -1
  private launches = 0

  /** Fills the bay and sets up the targets for a mission. */
  load(count: number, targets: Target[], guided = false, missiles = 0) {
    this.loaded = count
    this.missiles = missiles
    this.flying.length = 0
    this.lock = -1
    this.guided = guided
    this.falling.length = 0
    this.targets = targets
    this.destroyed = targets.map(() => false)
    this.aiming = false
    this.armed = -1
    this.ruins.clear()
    this.sinceImpact = Number.POSITIVE_INFINITY
  }

  clear() {
    this.load(0, [])
  }

  get hits() {
    return this.destroyed.filter(Boolean).length
  }

  /**
   * Index of the nearest target to a point that still stands with no bomb on its way to it,
   * or -1 when there is none.
   */
  nearestStanding(x: number, z: number) {
    let best = -1
    let distance = Number.POSITIVE_INFINITY
    this.targets.forEach((target, i) => {
      if (this.destroyed[i] || this.falling.some(bomb => bomb.aimedAt === i)) return
      if (this.flying.some(missile => missile.target === i)) return
      const away = Math.hypot(target.x - x, target.z - z)
      if (away < distance) {
        distance = away
        best = i
      }
    })
    return best
  }

  /** How far the aiming cross lies short of a target, and how far to its side. */
  offset(sim: FlightSim, index: number): Offset {
    const target = this.targets[index]
    // Ground track, and the target relative to the aiming cross along it
    const track = Math.atan2(sim.velocity.x, -sim.velocity.z)
    const x = target.x - this.aim.x
    const z = target.z - this.aim.z
    return {
      long: x * Math.sin(track) - z * Math.cos(track),
      side: x * Math.cos(track) + z * Math.sin(track)
    }
  }

  /** Whether the cross will pass over a target if the course holds, and is close enough to wait for it. */
  linedUp(sim: FlightSim, index: number) {
    const { long, side } = this.offset(sim, index)
    return long > 0 && long < ARM_REACH && Math.abs(side) <= this.targets[index].radius * 0.8
  }

  /**
   * The bomb release key. With the cross lined up short of a target, it arms the release and
   * the bomb drops as the cross reaches the target. Otherwise, or pressed again, it drops now.
   */
  release(sim: FlightSim) {
    if (this.loaded <= 0 || sim.onGround || !this.aiming) return
    const index = this.nearestStanding(this.aim.x, this.aim.z)
    if (this.armed < 0 && !this.guided && index >= 0 && this.linedUp(sim, index)) {
      this.armed = index
      return
    }
    this.drop(sim)
  }

  /** Releases a bomb from the bay. Returns false with none left, or on the ground. */
  drop(sim: FlightSim) {
    this.armed = -1
    if (this.loaded <= 0 || sim.onGround) return false
    this.loaded--
    const position = BAY.clone().applyQuaternion(sim.orientation).add(sim.position)
    // A guided bomb locks onto the target nearest the aiming cross, if it is in reach
    const nearest = this.aiming ? this.nearestStanding(this.aim.x, this.aim.z) : -1
    const spot = this.targets[nearest]
    const away = spot
      ? Math.hypot(spot.x - this.aim.x, spot.z - this.aim.z)
      : Number.POSITIVE_INFINITY
    const target = this.guided && away <= GUIDED_REACH ? nearest : -1
    const aimedAt = away <= (this.guided ? GUIDED_REACH : (spot?.radius ?? 0)) ? nearest : -1
    const lands = target >= 0 ? new Vector3(spot.x, this.aim.y, spot.z) : this.aim.clone()
    this.falling.push({ position, velocity: sim.velocity.clone(), target, aimedAt, lands })
    return true
  }

  /**
   * Moves the falling bombs and updates the aiming point. Returns each bomb that landed this
   * frame, after marking the targets it destroyed.
   */
  update(dt: number, sim: FlightSim, ground: Ground): Impact[] {
    const impacts: Impact[] = []
    this.sinceImpact += dt
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const bomb = this.falling[i]
      for (let t = 0; t < dt; t += STEP) {
        const step = Math.min(STEP, dt - t)
        if (bomb.target >= 0) this.steer(bomb, ground, step)
        fall(bomb.position, bomb.velocity, step)
        if (bomb.position.y <= groundUnder(ground, bomb.position)) break
      }
      const floor = groundUnder(ground, bomb.position)
      if (bomb.position.y > floor) continue
      bomb.position.y = floor
      impacts.push(this.land(bomb.position, ground.heightAt(bomb.position.x, bomb.position.z) < 0))
      this.lastImpact.copy(bomb.position)
      this.sinceImpact = 0
      this.falling.splice(i, 1)
    }
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const impact = this.flyMissile(this.flying[i], dt, ground)
      if (impact === undefined) continue
      this.flying.splice(i, 1)
      if (!impact) continue
      impacts.push(impact)
      this.lastImpact.copy(impact.at)
      this.sinceImpact = 0
    }
    this.updateLock(sim)
    this.predict(sim, ground)
    // An armed release drops once the cross reaches the target, and gives up if the course
    // carries the cross well wide of it
    if (this.armed >= 0) {
      const { long, side } = this.offset(sim, this.armed)
      if (!this.aiming || Math.abs(side) > this.targets[this.armed].radius * 3) this.armed = -1
      else if (long <= 0) this.drop(sim)
    }
    return impacts
  }

  /**
   * Guidance: turns the bomb's sideways motion toward what reaches its target by the time it
   * lands, within the fins' limit.
   */
  private steer(bomb: Bombs['falling'][number], ground: Ground, dt: number) {
    const target = this.targets[bomb.target]
    const { position, velocity } = bomb
    const drop = position.y - groundUnder(ground, position)
    const seconds = Math.max(0.5, drop / Math.max(1, -velocity.y))
    const wantX = (target.x - position.x) / seconds
    const wantZ = (target.z - position.z) / seconds
    const change = Math.hypot(wantX - velocity.x, wantZ - velocity.z)
    const limit = GUIDED_ACCELERATION * dt
    const share = change > limit ? limit / change : 1
    velocity.x += (wantX - velocity.x) * share
    velocity.z += (wantZ - velocity.z) * share
  }

  /** Where a missile aims on a target: its middle, above the ground. */
  aimPoint(index: number, ground: Ground, out: Vector3) {
    const target = this.targets[index]
    const middle = (target.height ?? LOW_TARGET * 2) / 2
    return out.set(target.x, groundUnder(ground, out.set(target.x, 0, target.z)) + middle, target.z)
  }

  /**
   * Fires a missile from the rails, alternating sides. It homes on the locked target, or
   * flies straight ahead without one. Returns false with none left, or on the ground.
   */
  fire(sim: FlightSim) {
    if (this.missiles <= 0 || sim.onGround) return false
    this.missiles--
    const side = this.launches++ % 2 === 0 ? 1 : -1
    const position = rail
      .copy(RAIL)
      .setX(RAIL.x * side)
      .applyQuaternion(sim.orientation)
    const forward = nose.copy(NOSE).applyQuaternion(sim.orientation)
    this.flying.push({
      position: position.clone().add(sim.position),
      velocity: sim.velocity.clone().addScaledVector(forward, 15),
      target: this.lock,
      age: 0
    })
    return true
  }

  /**
   * The standing target nearest the nose that the seeker can see: in range, within
   * LOCK_CONE either side of the nose, and up to LOCK_DOWN below it, or -1.
   */
  private updateLock(sim: FlightSim) {
    this.lock = -1
    if (this.missiles <= 0 || sim.onGround) return
    let best = LOCK_CONE
    this.targets.forEach((target, i) => {
      if (this.destroyed[i] || this.flying.some(missile => missile.target === i)) return
      const x = target.x - sim.position.x
      const z = target.z - sim.position.z
      const across = Math.hypot(x, z)
      const up = sim.altitudeAgl - (target.height ?? 0) / 2
      if (Math.hypot(across, up) > LOCK_RANGE) return
      const side = Math.abs(
        Math.atan2(
          Math.sin(Math.atan2(x, -z) - sim.heading),
          Math.cos(Math.atan2(x, -z) - sim.heading)
        )
      )
      const below = Math.atan2(up, across) + sim.pitch
      if (side >= best || below > LOCK_DOWN || below < -LOCK_CONE) return
      best = side
      this.lock = i
    })
  }

  /**
   * Moves a missile: the motor speeds it up, and the seeker turns it toward its target within
   * the fins' limit. Returns the impact when it hits, null when it burns out in the air, and
   * undefined while it flies on.
   */
  private flyMissile(missile: Bombs['flying'][number], dt: number, ground: Ground) {
    for (let t = 0; t < dt; t += STEP) {
      const step = Math.min(STEP, dt - t)
      missile.age += step
      if (missile.age > MISSILE_LIFE) return null
      const { position, velocity } = missile
      const speed = Math.min(MISSILE_SPEED, velocity.length() + MISSILE_BOOST * step)
      const heading = air.copy(velocity).normalize()
      if (missile.target >= 0) {
        const aim = this.aimPoint(missile.target, ground, seek)
        if (aim.distanceTo(position) < Math.max(8, speed * step * 1.5)) {
          position.set(aim.x, groundUnder(ground, aim), aim.z)
          return this.land(position, false)
        }
        // Lofted: it aims above the target while far off, so a launch at low level clears
        // the hills on the way in, then dives onto it
        const across = Math.hypot(aim.x - position.x, aim.z - position.z)
        aim.y += Math.min(MAX_LOFT, across * LOFT)
        const wanted = aim.sub(position).normalize()
        const angle = heading.angleTo(wanted)
        // Turn toward the target, at most the fins' rate this step
        if (angle > 1e-4)
          heading.lerp(wanted, Math.min(1, (MISSILE_TURN * step) / angle)).normalize()
      } else heading.y -= 0.02 * step
      velocity.copy(heading).multiplyScalar(speed)
      position.addScaledVector(velocity, step)
      const floor = groundUnder(ground, position)
      if (position.y <= floor) {
        position.y = floor
        return this.land(position, ground.heightAt(position.x, position.z) < 0)
      }
    }
    return undefined
  }

  /** Marks the targets a bomb landing here destroys. */
  private land(at: Vector3, water: boolean): Impact {
    let hit: number | null = null
    this.targets.forEach((target, i) => {
      if (this.destroyed[i]) return
      if (Math.hypot(target.x - at.x, target.z - at.z) <= target.radius) {
        this.destroyed[i] = true
        hit ??= i
      }
    })
    const nearest = this.targets.reduce(
      (best, target) => Math.min(best, Math.hypot(target.x - at.x, target.z - at.z)),
      Number.POSITIVE_INFINITY
    )
    const fell = water ? 0 : this.ruins.blast(at.x, at.z)
    return { at: at.clone(), water, hit, miss: nearest, fell }
  }

  /**
   * Where the bombsight looks: the aiming cross while it has work to do, otherwise the spot
   * the next bomb falls on, then its blast for a moment.
   */
  sightPoint(sim: FlightSim): Vector3 | null {
    const index = this.nearestStanding(this.aim.x, this.aim.z)
    const busy = this.armed >= 0 || (index >= 0 && this.linedUp(sim, index))
    if (!busy && this.falling.length > 0) return this.falling[0].lands
    if (!busy && this.sinceImpact < WATCH_BLAST) return this.lastImpact
    return this.aiming ? this.aim : null
  }

  /** Follows a bomb released now down to the ground, for the aiming cross. */
  private predict(sim: FlightSim, ground: Ground) {
    this.aiming = this.loaded > 0 && !sim.onGround
    if (!this.aiming) return
    const position = this.aim.copy(BAY).applyQuaternion(sim.orientation).add(sim.position)
    const velocity = air.copy(sim.velocity)
    const step = new Vector3()
    for (let t = 0; t < PREDICT_LIMIT; t += PREDICT_STEP) {
      // A copy of the velocity, as `fall` uses the shared vector for its drag
      step.copy(velocity)
      fall(position, step, PREDICT_STEP)
      velocity.copy(step)
      if (position.y <= groundUnder(ground, position)) break
    }
    position.y = groundUnder(ground, position)
  }
}

/**
 * Aiming advice for the nearest standing target: how to steer toward it, or how far the
 * aiming cross lies short, long, and to the side. Keys sit in square brackets.
 */
export function bombAdvice(bombs: Bombs, sim: FlightSim): string | null {
  if (!bombs.aiming) return null
  if (bombs.armed >= 0) {
    return `Release armed: hold your course. The bomb drops as the cross reaches the ${bombs.targets[bombs.armed].label}.`
  }
  // Without targets, as over a city, every press drops at once
  if (bombs.targets.length === 0) return 'Press [Enter] to drop, or hold it for a string of bombs.'
  const index = bombs.nearestStanding(bombs.aim.x, bombs.aim.z)
  if (index < 0) return bombs.falling.length > 0 ? 'Bomb away. Watch the target.' : null
  const target = bombs.targets[index]
  const label = target.label
  const { long, side } = bombs.offset(sim, index)
  // Guided bombs only need the cross inside the launch zone
  if (bombs.guided && Math.hypot(long, side) <= GUIDED_REACH) {
    return `In the launch zone: press [Enter]. The bomb steers itself onto the ${label}.`
  }
  if (!bombs.guided && Math.hypot(long, side) <= target.radius) {
    return `On target: press [Enter] to drop on the ${label}.`
  }
  if (!bombs.guided && bombs.linedUp(sim, index)) {
    return `Lined up, ${Math.round(long)} m to go: press [Enter] and the bomb drops on the ${label}.`
  }
  // The target relative to the aircraft's track
  const track = Math.atan2(sim.velocity.x, -sim.velocity.z)
  const x = target.x - sim.position.x
  const z = target.z - sim.position.z
  const turn = Math.atan2(
    x * Math.cos(track) + z * Math.sin(track),
    x * Math.sin(track) - z * Math.cos(track)
  )
  const degrees = turn * (180 / Math.PI)
  const zone = bombs.guided ? GUIDED_REACH : target.radius
  // Far off to the side or behind: steer first
  if (Math.abs(degrees) > 20) {
    const way = degrees > 0 ? 'right' : 'left'
    const km = (Math.hypot(x, z) / 1000).toFixed(1)
    return `Steer ${Math.round(Math.abs(degrees))}° ${way} for the ${label}, ${km} km away.`
  }
  // Still ahead of the aircraft, but the cross is already beyond it
  if (long < 0) return `The cross is past the ${label}. Fly on, turn around, and make another run.`
  const steer = ` Steer a little ${side > 0 ? 'right' : 'left'}.`
  const what = bombs.guided ? `the launch zone around the ${label}` : `the ${label}`
  const short = Math.round(bombs.guided ? long - zone : long)
  return Math.abs(side) > zone * 0.6
    ? `The cross passes ${Math.round(Math.abs(side))} m to the ${side > 0 ? 'left' : 'right'} of ${what}.${steer}`
    : `The cross falls ${short} m short of ${what}. Hold your course.`
}

/**
 * Missile advice for the nearest standing target: how to point the nose at it, and when to
 * fire. Keys sit in square brackets.
 */
export function missileAdvice(bombs: Bombs, sim: FlightSim): string | null {
  if (sim.onGround) return null
  if (bombs.lock >= 0) {
    const target = bombs.targets[bombs.lock]
    const km = (Math.hypot(target.x - sim.position.x, target.z - sim.position.z) / 1000).toFixed(1)
    return `Locked on the ${target.label}, ${km} km: press [Enter] to fire.`
  }
  if (bombs.missiles <= 0) return bombs.flying.length > 0 ? 'Missile away.' : null
  if (bombs.targets.length === 0) return 'Press [Enter] to fire a missile straight ahead.'
  const index = bombs.nearestStanding(sim.position.x, sim.position.z)
  if (index < 0) return bombs.flying.length > 0 ? 'Missile away. Watch it hit.' : null
  const target = bombs.targets[index]
  const x = target.x - sim.position.x
  const z = target.z - sim.position.z
  const distance = Math.hypot(x, z)
  const km = (distance / 1000).toFixed(1)
  const turn = Math.atan2(
    Math.sin(Math.atan2(x, -z) - sim.heading),
    Math.cos(Math.atan2(x, -z) - sim.heading)
  )
  const degrees = Math.round(Math.abs(turn) * (180 / Math.PI))
  if (degrees > 12) {
    return `Turn ${degrees}° ${turn > 0 ? 'right' : 'left'} toward the ${target.label}, ${km} km.`
  }
  if (distance > LOCK_RANGE) {
    return `Fly on toward the ${target.label}, ${km} km. It locks within ${LOCK_RANGE / 1000} km.`
  }
  // Ahead and in range but out of the seeker's view: too steep below, or above the nose
  const below = Math.atan2(sim.altitudeAgl, distance) + sim.pitch
  const degreesBelow = Math.round((below - LOCK_DOWN) * (180 / Math.PI))
  return below > LOCK_DOWN
    ? `Lower the nose ${degreesBelow}° toward the ${target.label} to lock on.`
    : `Raise the nose toward the ${target.label} to lock on.`
}
