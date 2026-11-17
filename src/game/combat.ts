import { Vector3 } from 'three'
import { GRAVITY } from '../sim/aircraft'
import type { FlightSim, Ground } from '../sim/flight-sim'
import { outside, type Strip } from '../world/island'
import type { Effects } from './effects'

export type EnemyKind = 'fighter' | 'bomber'

/**
 * Where an enemy appears. Heading is in degrees; a bomber heads for `goal`. A fighter with
 * `prey: 'escort'` hunts the friendly bomber instead of the player. With `nearEscort`, `x` is
 * metres right of the escort, `z` metres ahead of it, and the heading is relative to its own.
 * `shots` overrides the missiles it carries.
 */
export type EnemySpawn = {
  kind: EnemyKind
  x: number
  z: number
  altitude: number
  heading: number
  goal?: { x: number; z: number }
  prey?: 'escort'
  nearEscort?: boolean
  shots?: number
}

/** A friendly bomber to protect, flying level from its start to `goal` to drop its load. */
export type EscortSpawn = {
  x: number
  z: number
  altitude: number
  heading: number
  goal: { x: number; z: number }
}

/** The friendly bomber. One hit sets it smoking; the second brings it down. */
export type Escort = {
  position: Vector3
  velocity: Vector3
  bank: number
  hits: number
  alive: boolean
  falling: boolean
  /** True once its bombs are away, then once they have struck the goal. */
  bombed: boolean
  struck: boolean
  /** Seconds until the falling bombs strike. */
  bombsFall: number
  goal: Vector3
  /** Where it started, which it turns back toward once its bombs have struck. */
  home: Vector3
  /** Seconds until it may drop flares again. */
  flareWait: number
}

/** Everything a mission brings to the fight. */
export type CombatSetup = {
  enemies: EnemySpawn[]
  /** Later waves. Each comes once the one before is down and the player is in the air. */
  waves?: EnemySpawn[][]
  missiles: number
  flares: number
  escort?: EscortSpawn
  /** Runways where the ground crew refuels and reloads; the next wave waits for it. */
  base?: Strip[]
}

/** An enemy aircraft, flown by simple rules rather than the full flight model. */
export type Enemy = {
  kind: EnemyKind
  position: Vector3
  velocity: Vector3
  /** Bank in radians, for drawing: right wing down is positive. */
  bank: number
  alive: boolean
  /** Shot down and falling in flames until it reaches the ground or the sea. */
  falling: boolean
  /** Seconds until it may fire again, and missiles it has left. */
  cooldown: number
  shots: number
  /** Seconds left of a break turn away from a missile, and which way it breaks. */
  evading: number
  /** Seconds left before it may start another pass, after flying past the player. */
  extending: number
  breakSide: number
  goal: Vector3 | null
  prey: 'player' | 'escort'
}

/** A heat-seeking missile in flight, from the player or an enemy. */
export type Missile = {
  position: Vector3
  velocity: Vector3
  /** The enemy it homes on, the player, the escort, a flare that fooled it, or nothing. */
  target: Enemy | 'player' | 'escort' | Flare | null
  age: number
  fromPlayer: boolean
}

export type Flare = { position: Vector3; velocity: Vector3; age: number }

/** Something worth a sound or a notice. */
export type CombatEvent =
  | { kind: 'launch'; fromPlayer: boolean }
  | { kind: 'kill'; at: Vector3 }
  | { kind: 'wreck'; at: Vector3 }
  | { kind: 'hit' }
  | { kind: 'escort-hit'; at: Vector3 }
  | { kind: 'escort-down'; at: Vector3 }
  | { kind: 'escort-bombs'; at: Vector3 }
  | { kind: 'rearmed' }

const SPEED: Record<EnemyKind, number> = { fighter: 240, bomber: 210 }
// Sustained g a fighter pulls in a turn, and a bomber's gentle limit
const MAX_G: Record<EnemyKind, number> = { fighter: 4.5, bomber: 1.5 }
const SHOTS: Record<EnemyKind, number> = { fighter: 2, bomber: 0 }
// The player's seeker locks within this cone off the nose and this range
export const AIR_LOCK_CONE = 0.3
export const AIR_LOCK_RANGE = 6000
// An enemy fires when the player is this close to its nose and in range
const FIRE_CONE = 0.22
const FIRE_RANGE = 4000
const FIRST_SHOT = 14
const RELOAD = 12
// Missile speed in m/s, the sideways acceleration its fins allow, and its fuse distance.
// Enemy missiles turn less sharply, so a hard break or flares can beat them.
const MISSILE_SPEED = 600
const PLAYER_MISSILE_TURN = 320
const ENEMY_MISSILE_TURN = 190
const MISSILE_LIFE = 14
const FUSE = 15
// A fighter breaks away from a missile within this range, for this long
const BREAK_RANGE = 3500
const BREAK_SECONDS = 4
// Within this distance of the player a fighter has made its pass. It then flies straight for
// EXTEND_STRAIGHT seconds and makes no new pass until EXTEND_SECONDS have gone by.
const MERGE = 1200
const EXTEND_STRAIGHT = 8
const EXTEND_SECONDS = 20
// Flares burn this long, and fool a missile homing on their aircraft with these odds
const FLARE_LIFE = 4
const PLAYER_DECOY = 0.75
const ENEMY_DECOY = 0.5
// Enemies keep at least this far above the ground, looking this many seconds ahead for
// rising ground. They start pulling up when a dive would reach the floor within
// PULL_UP_SECONDS, and never fly lower than MIN_CLEARANCE.
const FLOOR = 250
const LOOK_AHEAD = [0, 2, 4, 7]
const PULL_UP_SECONDS = 5
const MIN_CLEARANCE = 40
// The escort's speed in m/s, how far short of its goal it releases (bombs carry forward as
// they fall), the seconds they take to fall, and its flares' odds and pause
const ESCORT_SPEED = 220
const ESCORT_RELEASE = 7500
const ESCORT_FALL = 34
const ESCORT_DECOY = 0.5
const ESCORT_FLARE_WAIT = 4
// The escort's gentle turn for home, in g
const ESCORT_G = 0.5
// A new wave comes once the player climbs this high, in metres above the ground
const WAVE_HEIGHT = 150
// Seconds the ground crew takes to refuel and reload, and the fuel share they fill to
const REARM_SECONDS = 15
const REARM_FUEL = 1
// Below this height in metres and within this distance of a base, the player is under its
// guns. Enemies then circle this far from the player until it climbs out.
const SHELTER_HEIGHT = 300
const SHELTER_REACH = 8000
const HOLD_RADIUS = 7000
const STEP = 1 / 60
const RAIL = new Vector3(0, -1, 0)

const toTarget = new Vector3()
const wanted = new Vector3()
const lead = new Vector3()
const dir = new Vector3()

/** Turns `velocity` toward `wanted` (a unit vector) by at most `accel * dt` sideways. */
function steer(velocity: Vector3, desired: Vector3, accel: number, dt: number) {
  const speed = velocity.length()
  dir.copy(velocity).divideScalar(speed)
  const angle = dir.angleTo(desired)
  const most = (accel / speed) * dt
  if (angle > 1e-5) dir.lerp(desired, Math.min(1, most / angle)).normalize()
  velocity.copy(dir).multiplyScalar(speed)
  return Math.min(angle, most) / dt
}

/**
 * Air combat: enemy fighters and bombers, the player's heat-seeking missiles and theirs, and
 * flares. Call `update` every frame while flying.
 */
export class AirCombat {
  readonly enemies: Enemy[] = []
  readonly missiles: Missile[] = []
  readonly flares: Flare[] = []
  /** Missiles and flares the player has left. */
  ammo = 0
  flaresLeft = 0
  /** The enemy a missile fired now would home on, or -1. */
  lock = -1
  /** True while an enemy missile homes on the player. */
  warning = false

  /** The friendly bomber on escort missions, or null. */
  escort: Escort | null = null
  /** Waves sent so far, out of `waves`, and the wave count when the player last rearmed. */
  wave = 0
  rearmedAfter = 0
  /** Share of the ground crew's work done while stopped at the base, 0 to 1. */
  rearm = 0
  private waves: EnemySpawn[][] = []
  private base: Strip[] = []
  private loadout = { missiles: 0, flares: 0 }

  load(setup: CombatSetup) {
    this.enemies.length = 0
    this.missiles.length = 0
    this.flares.length = 0
    this.ammo = setup.missiles
    this.flaresLeft = setup.flares
    this.loadout = { missiles: setup.missiles, flares: setup.flares }
    this.lock = -1
    this.warning = false
    this.waves = setup.waves ?? []
    this.wave = 0
    this.rearmedAfter = 0
    this.rearm = 0
    this.base = setup.base ?? []
    const escort = setup.escort
    this.escort = escort
      ? {
          position: new Vector3(escort.x, escort.altitude, escort.z),
          velocity: new Vector3(),
          bank: 0,
          hits: 0,
          alive: true,
          falling: false,
          bombed: false,
          struck: false,
          bombsFall: 0,
          goal: new Vector3(escort.goal.x, escort.altitude, escort.goal.z),
          home: new Vector3(escort.x, escort.altitude, escort.z),
          flareWait: 0
        }
      : null
    if (this.escort) {
      const toward = toTarget.copy(this.escort.goal).sub(this.escort.position).normalize()
      this.escort.velocity.copy(toward).multiplyScalar(ESCORT_SPEED)
    }
    this.launch(setup.enemies)
  }

  clear() {
    this.load({ enemies: [], missiles: 0, flares: 0 })
  }

  /** True on a mission with enemies, now or still to come. */
  get active() {
    return this.enemies.length > 0 || this.waves.length > 0
  }

  /** Enemies still flying. */
  get alive() {
    return this.enemies.filter(enemy => enemy.alive).length
  }

  /** Enemies in every wave, sent or not. */
  get total() {
    return this.enemies.length + this.waves.slice(this.wave).reduce((sum, w) => sum + w.length, 0)
  }

  /** True when a wave is down and the next waits for the player to land at the base. */
  get awaitingRearm() {
    const between = this.wave < this.waves.length && this.rearmedAfter < this.wave
    return this.base.length > 0 && between && this.alive === 0
  }

  /** Sends enemies into the fight, placing those that start near the escort around it. */
  private launch(spawns: EnemySpawn[]) {
    for (const spawn of spawns) {
      const near = spawn.nearEscort && this.escort
      let { x, z } = spawn
      let heading = (spawn.heading * Math.PI) / 180
      if (near && this.escort) {
        const { position, velocity } = this.escort
        const course = Math.atan2(velocity.x, -velocity.z)
        x = position.x + spawn.x * Math.cos(course) + spawn.z * Math.sin(course)
        z = position.z + spawn.x * Math.sin(course) - spawn.z * Math.cos(course)
        heading += course
      }
      this.enemies.push({
        kind: spawn.kind,
        position: new Vector3(x, spawn.altitude, z),
        velocity: new Vector3(Math.sin(heading), 0, -Math.cos(heading)).multiplyScalar(
          SPEED[spawn.kind]
        ),
        bank: 0,
        alive: true,
        falling: false,
        cooldown: FIRST_SHOT,
        // A fighter hunting the escort carries one missile for it
        shots: spawn.shots ?? (spawn.prey === 'escort' ? 1 : SHOTS[spawn.kind]),
        evading: 0,
        extending: 0,
        breakSide: 1,
        goal: spawn.goal ? new Vector3(spawn.goal.x, spawn.altitude, spawn.goal.z) : null,
        prey: spawn.prey ?? 'player'
      })
    }
  }

  /** Enemies shot down so far. */
  get downed() {
    return this.enemies.filter(enemy => !enemy.alive).length
  }

  /** Fires a missile at the locked enemy, or straight ahead without a lock. */
  fire(sim: FlightSim) {
    if (this.ammo <= 0 || sim.onGround) return false
    this.ammo--
    const position = toTarget.copy(RAIL).applyQuaternion(sim.orientation).add(sim.position)
    const forward = dir.set(0, 0, -1).applyQuaternion(sim.orientation)
    this.missiles.push({
      position: position.clone(),
      velocity: sim.velocity.clone().addScaledVector(forward, 30),
      target: this.enemies[this.lock] ?? null,
      age: 0,
      fromPlayer: true
    })
    return true
  }

  /** Drops a pair of flares behind the player. Each may lure away a missile homing on it. */
  dropFlares(sim: FlightSim) {
    if (this.flaresLeft <= 0 || sim.onGround) return false
    this.flaresLeft--
    const flare = this.release(sim.position, sim.velocity)
    for (const missile of this.missiles) {
      if (missile.target === 'player' && Math.random() < PLAYER_DECOY) missile.target = flare
    }
    return true
  }

  /**
   * Moves the enemies, missiles, and flares, and draws their trails. Returns what happened,
   * including a hit on the player.
   */
  update(dt: number, sim: FlightSim, ground: Ground, effects: Effects): CombatEvent[] {
    const events: CombatEvent[] = []
    for (let t = 0; t < dt; t += STEP) {
      const step = Math.min(STEP, dt - t)
      if (this.escort) this.flyEscort(this.escort, step, ground, events)
      for (const enemy of this.enemies) this.fly(enemy, step, sim, ground, events)
      for (let i = this.missiles.length - 1; i >= 0; i--) {
        if (this.flyMissile(this.missiles[i], step, sim, ground, events)) this.missiles.splice(i, 1)
      }
      for (let i = this.flares.length - 1; i >= 0; i--) {
        const flare = this.flares[i]
        flare.age += step
        flare.velocity.multiplyScalar(Math.exp(-step * 1.5))
        flare.velocity.y -= 3 * step
        flare.position.addScaledVector(flare.velocity, step)
        if (flare.age > FLARE_LIFE) this.flares.splice(i, 1)
      }
    }
    for (const missile of this.missiles) effects.missileTrail(missile.position, dt)
    for (const flare of this.flares) effects.flare(flare.position)
    for (const enemy of this.enemies) if (enemy.falling) effects.engineFire(enemy.position, dt)
    const { escort } = this
    if (escort && (escort.falling || (escort.alive && escort.hits > 0))) {
      effects.engineFire(escort.position, dt)
    }
    this.warning = this.missiles.some(missile => missile.target === 'player')
    this.updateLock(sim)
    this.resupply(dt, sim, events)
    // The next wave comes once this one is down and the player is back in the air
    const next = this.waves[this.wave]
    const ready = this.base.length === 0 || this.rearmedAfter >= this.wave
    if (next && this.alive === 0 && ready && !sim.onGround && sim.altitudeAgl > WAVE_HEIGHT) {
      this.wave++
      this.launch(next)
    }
    return events
  }

  /**
   * The ground crew at work while the player sits stopped on a base runway: after
   * REARM_SECONDS the missiles, flares, and fuel are full again.
   */
  private resupply(dt: number, sim: FlightSim, events: CombatEvent[]) {
    const { x, z } = sim.position
    const parked =
      sim.onGround && sim.groundSpeed < 1.5 && this.base.some(runway => outside(runway, x, z) === 0)
    const needed =
      this.ammo < this.loadout.missiles ||
      this.flaresLeft < this.loadout.flares ||
      sim.fuel < sim.spec.fuelCapacity * REARM_FUEL * 0.95 ||
      this.awaitingRearm
    if (!parked || !needed) {
      this.rearm = 0
      return
    }
    this.rearm = Math.min(1, this.rearm + dt / REARM_SECONDS)
    if (this.rearm < 1) return
    this.rearm = 0
    this.ammo = this.loadout.missiles
    this.flaresLeft = this.loadout.flares
    sim.fuel = Math.max(sim.fuel, sim.spec.fuelCapacity * REARM_FUEL)
    // Rearming between waves readies the next one; mid-wave it only reloads
    if (this.alive === 0) this.rearmedAfter = this.wave
    events.push({ kind: 'rearmed' })
  }

  /** Highest ground or sea under an enemy now and over the next few seconds of its path. */
  private floorAhead(position: Vector3, velocity: Vector3, ground: Ground) {
    let highest = 0
    for (const seconds of LOOK_AHEAD) {
      const x = position.x + velocity.x * seconds
      const z = position.z + velocity.z * seconds
      highest = Math.max(highest, ground.heightAt(x, z))
    }
    return highest
  }

  /** True while the player is on the ground, or low near a base, where enemies hold off. */
  private sheltered(sim: FlightSim) {
    if (sim.onGround) return true
    if (sim.altitudeAgl > SHELTER_HEIGHT) return false
    const { x, z } = sim.position
    return this.base.some(runway => Math.hypot(runway.x - x, runway.z - z) < SHELTER_REACH)
  }

  /**
   * The escort's step: level and straight for its goal, where it drops its load and flies
   * on. It drops flares when a missile closes on it.
   */
  private flyEscort(escort: Escort, dt: number, ground: Ground, events: CombatEvent[]) {
    const { position, velocity } = escort
    if (escort.falling) {
      velocity.multiplyScalar(Math.exp(-dt * 0.2))
      velocity.y -= GRAVITY * dt
      position.addScaledVector(velocity, dt)
      escort.bank += dt * 0.6
      if (position.y <= Math.max(ground.heightAt(position.x, position.z), 0)) {
        escort.falling = false
        events.push({ kind: 'wreck', at: position.clone() })
      }
      return
    }
    // Bombs already away strike even if the bomber goes down
    if (escort.bombed && !escort.struck) {
      escort.bombsFall -= dt
      if (escort.bombsFall <= 0) {
        escort.struck = true
        const at = escort.goal.clone()
        at.y = Math.max(ground.heightAt(at.x, at.z), 0)
        events.push({ kind: 'escort-bombs', at })
      }
    }
    if (!escort.alive) return
    // Its job done, it turns gently for home, so it stays over the islands
    if (escort.struck) {
      wanted.copy(escort.home).sub(position).setY(0).normalize()
      const sideways = wanted.x * velocity.z - wanted.z * velocity.x
      const rate = steer(velocity, wanted, ESCORT_G * GRAVITY, dt)
      const bank = Math.atan2(rate * velocity.length(), GRAVITY) * (sideways > 0 ? -1 : 1)
      escort.bank += (bank - escort.bank) * Math.min(1, dt * 2)
    }
    position.addScaledVector(velocity, dt)
    const across = Math.hypot(position.x - escort.goal.x, position.z - escort.goal.z)
    if (!escort.bombed && across < ESCORT_RELEASE) {
      escort.bombed = true
      escort.bombsFall = ESCORT_FALL
    }
    escort.flareWait = Math.max(0, escort.flareWait - dt)
    if (escort.flareWait > 0) return
    const threats = this.missiles.filter(
      missile => missile.target === 'escort' && missile.position.distanceTo(position) < BREAK_RANGE
    )
    if (threats.length === 0) return
    escort.flareWait = ESCORT_FLARE_WAIT
    const flare = this.release(position, velocity)
    for (const missile of threats) if (Math.random() < ESCORT_DECOY) missile.target = flare
  }

  /** One enemy's step: chase or head for its goal, break from missiles, and fire. */
  private fly(enemy: Enemy, dt: number, sim: FlightSim, ground: Ground, events: CombatEvent[]) {
    const { position, velocity } = enemy
    if (enemy.falling) {
      velocity.multiplyScalar(Math.exp(-dt * 0.3))
      velocity.y -= GRAVITY * dt
      position.addScaledVector(velocity, dt)
      enemy.bank += dt * 1.5
      if (position.y <= Math.max(ground.heightAt(position.x, position.z), 0)) {
        enemy.falling = false
        events.push({ kind: 'wreck', at: position.clone() })
      }
      return
    }
    if (!enemy.alive) return
    enemy.cooldown -= dt
    enemy.evading = Math.max(0, enemy.evading - dt)
    enemy.extending = Math.max(0, enemy.extending - dt)
    // Its prey: the escort while it flies, otherwise the player
    const escort = enemy.prey === 'escort' && this.escort?.alive ? this.escort : null
    const preyPosition = escort ? escort.position : sim.position
    const preyVelocity = escort ? escort.velocity : sim.velocity
    toTarget.copy(preyPosition).sub(position)
    const distance = toTarget.length()
    // After a close pass it flies straight on for a while, then turns back for another run
    if (distance < MERGE && enemy.extending === 0 && !enemy.goal) enemy.extending = EXTEND_SECONDS
    // A player on the ground, or low over the base, sits under its guns. The enemy circles
    // out of their reach and waits, close enough to fight again once the player climbs out.
    const sheltered = !escort && this.sheltered(sim)
    if (enemy.goal) {
      // A bomber flies level and straight for its goal
      wanted.copy(enemy.goal).sub(position).setY(0).normalize()
    } else if (sheltered) {
      const out = lead.copy(position).sub(sim.position).setY(0)
      const reach = out.length()
      out.divideScalar(Math.max(reach, 1))
      // Around the circle, leaning in or out toward its radius
      const drift = Math.max(-1, Math.min(1, (reach - HOLD_RADIUS) / 2000))
      wanted.set(-out.z, 0, out.x).addScaledVector(out, -drift).normalize()
    } else if (enemy.extending > EXTEND_SECONDS - EXTEND_STRAIGHT) {
      wanted.copy(velocity).setY(0).normalize()
    } else if (enemy.evading > 0) {
      // Break turn: hard across the missile's path and a little down
      wanted
        .set(-velocity.z * enemy.breakSide, -0.15 * velocity.length(), velocity.x * enemy.breakSide)
        .normalize()
    } else {
      // Lead pursuit: aim where the player will be by the time it gets there
      const seconds = Math.min(3, distance / SPEED[enemy.kind])
      wanted
        .copy(lead.copy(preyPosition).addScaledVector(preyVelocity, seconds))
        .sub(position)
        .normalize()
    }
    // Pull up for the highest ground under the next few seconds of flight, early enough that
    // the climb starts before a dive reaches it
    const floor = this.floorAhead(position, velocity, ground) + FLOOR
    const soon = position.y + Math.min(0, velocity.y) * PULL_UP_SECONDS
    if (soon < floor) wanted.y = Math.max(wanted.y, position.y < floor ? 0.5 : 0.25)
    wanted.normalize()
    const sideways = wanted.x * velocity.z - wanted.z * velocity.x
    const rate = steer(velocity, wanted, MAX_G[enemy.kind] * GRAVITY, dt)
    const bank = Math.atan2(rate * velocity.length(), GRAVITY) * (sideways > 0 ? -1 : 1)
    enemy.bank += (bank - enemy.bank) * Math.min(1, dt * 3)
    position.addScaledVector(velocity, dt)
    // Never through the ground or the sea, whatever the turn asked for
    const lowest = Math.max(ground.heightAt(position.x, position.z), 0) + MIN_CLEARANCE
    if (position.y < lowest) {
      position.y = lowest
      if (velocity.y < 0) velocity.y = 0
    }
    // Fire when the prey sits ahead and in range
    const offNose = dir.copy(velocity).normalize().angleTo(toTarget)
    const inSight = distance < FIRE_RANGE && offNose < FIRE_CONE && !sheltered
    if (enemy.shots > 0 && enemy.cooldown <= 0 && inSight) {
      enemy.shots--
      enemy.cooldown = RELOAD
      this.missiles.push({
        position: position.clone(),
        velocity: velocity.clone(),
        target: escort ? 'escort' : 'player',
        age: 0,
        fromPlayer: false
      })
      events.push({ kind: 'launch', fromPlayer: false })
    }
  }

  /** One missile's step. Returns true once it is gone: a hit, a miss, or burnt out. */
  private flyMissile(
    missile: Missile,
    dt: number,
    sim: FlightSim,
    ground: Ground,
    events: CombatEvent[]
  ) {
    missile.age += dt
    if (missile.age > MISSILE_LIFE) return true
    const { position, velocity, target } = missile
    const speed = Math.min(MISSILE_SPEED, velocity.length() + 250 * dt)
    velocity.setLength(speed)
    // Where the target is, and how fast it moves, if it still flies
    let aim: Vector3 | null = null
    let aimVelocity: Vector3 | null = null
    if (target === 'player') {
      aim = sim.position
      aimVelocity = sim.velocity
    } else if (target === 'escort') {
      if (this.escort?.alive) {
        aim = this.escort.position
        aimVelocity = this.escort.velocity
      }
    } else if (target && 'alive' in target) {
      if (target.alive) {
        aim = target.position
        aimVelocity = target.velocity
      }
    } else if (target && target.age < FLARE_LIFE) {
      aim = target.position
      aimVelocity = target.velocity
    }
    if (aim && aimVelocity) {
      const distance = toTarget.copy(aim).sub(position).length()
      if (distance < FUSE) return this.detonate(missile, events)
      // Aim ahead of the target by the time to close the gap
      const closing = Math.max(50, speed - aimVelocity.dot(toTarget.normalize()))
      lead
        .copy(aim)
        .addScaledVector(aimVelocity, distance / closing)
        .sub(position)
        .normalize()
      // A missile fired from behind and passed by its target loses it
      if (dir.copy(velocity).normalize().angleTo(lead) > 1.4) missile.target = null
      else steer(velocity, lead, missile.fromPlayer ? PLAYER_MISSILE_TURN : ENEMY_MISSILE_TURN, dt)
    }
    position.addScaledVector(velocity, dt)
    return position.y <= Math.max(ground.heightAt(position.x, position.z), 0)
  }

  /**
   * A missile bursts by its target: an enemy goes down in flames, the player is hit, or the
   * escort takes a hit.
   */
  private detonate(missile: Missile, events: CombatEvent[]) {
    const { target, position } = missile
    const { escort } = this
    if (target === 'player') events.push({ kind: 'hit' })
    else if (target === 'escort' && escort) {
      escort.hits++
      if (escort.hits >= 2) {
        escort.alive = false
        escort.falling = true
        events.push({ kind: 'escort-down', at: escort.position.clone() })
      } else events.push({ kind: 'escort-hit', at: position.clone() })
    } else if (target && target !== 'escort' && 'alive' in target) {
      target.alive = false
      target.falling = true
      events.push({ kind: 'kill', at: target.position.clone() })
    }
    return true
  }

  /** Flares from an aircraft, falling behind it and burning bright. */
  private release(position: Vector3, velocity: Vector3) {
    const flare = {
      position: position.clone(),
      velocity: velocity.clone().multiplyScalar(0.4),
      age: 0
    }
    flare.velocity.y -= 10
    this.flares.push(flare)
    return flare
  }

  /**
   * The live enemy nearest the nose within the seeker's cone and range, or -1. Fighters
   * also break away from a missile homing on them, dropping flares as they go.
   */
  private updateLock(sim: FlightSim) {
    this.lock = -1
    const forward = dir.set(0, 0, -1).applyQuaternion(sim.orientation)
    let best = AIR_LOCK_CONE
    this.enemies.forEach((enemy, i) => {
      if (!enemy.alive) return
      toTarget.copy(enemy.position).sub(sim.position)
      // The seeker moves on from an enemy that already has a missile on its way
      const engaged = this.missiles.some(missile => missile.target === enemy)
      if (!engaged && toTarget.length() <= AIR_LOCK_RANGE && this.ammo > 0) {
        const off = forward.angleTo(toTarget)
        if (off < best) {
          best = off
          this.lock = i
        }
      }
      if (enemy.kind !== 'fighter' || enemy.evading > 0) return
      for (const missile of this.missiles) {
        if (missile.target !== enemy) continue
        if (missile.position.distanceTo(enemy.position) > BREAK_RANGE) continue
        enemy.evading = BREAK_SECONDS
        enemy.breakSide = Math.random() < 0.5 ? -1 : 1
        const flare = this.release(enemy.position, enemy.velocity)
        if (Math.random() < ENEMY_DECOY) missile.target = flare
      }
    })
  }
}

/**
 * Advice for the fight: a missile warning first, then a lock, then which way to turn for the
 * nearest enemy, preferring those hunting the escort. With a base, `base` names it for the
 * rearming advice. Keys sit in square brackets.
 */
export function combatAdvice(combat: AirCombat, sim: FlightSim, base?: string): string | null {
  if (!combat.active) return null
  if (sim.onGround) {
    if (combat.rearm > 0) {
      const seconds = Math.ceil((1 - combat.rearm) * REARM_SECONDS)
      return `The ground crew is refuelling and reloading: ${seconds} s. Keep still.`
    }
    if (base && combat.alive === 0 && !combat.awaitingRearm && combat.total > combat.downed) {
      return 'Ready. Take off: the next wave comes once you climb away.'
    }
    return null
  }
  if (combat.warning) return 'Missile! Press [Space] for flares and turn hard across its path.'
  if (combat.missiles.some(missile => missile.target === 'escort')) {
    return 'A missile is chasing the B-2! It drops flares; shoot its attackers down.'
  }
  const name = (enemy: Enemy) => (enemy.kind === 'bomber' ? 'bomber' : 'fighter')
  const locked = combat.enemies[combat.lock]
  if (locked) {
    const km = (locked.position.distanceTo(sim.position) / 1000).toFixed(1)
    return `Locked on the ${name(locked)}, ${km} km: press [Enter] to fire.`
  }
  if (base && combat.awaitingRearm) {
    return `Wave down. Land at ${base} and stop on the runway to rearm and refuel.`
  }
  if (combat.ammo <= 0) {
    if (combat.missiles.some(missile => missile.fromPlayer)) return 'Missile away.'
    return base ? `Out of missiles. Land at ${base} and stop on the runway to reload.` : null
  }
  // Those hunting the escort come first
  let nearest: Enemy | null = null
  const hunting = combat.enemies.some(enemy => enemy.alive && enemy.prey === 'escort')
  for (const enemy of combat.enemies) {
    if (!enemy.alive || (hunting && enemy.prey !== 'escort')) continue
    if (
      !nearest ||
      enemy.position.distanceTo(sim.position) < nearest.position.distanceTo(sim.position)
    ) {
      nearest = enemy
    }
  }
  if (!nearest) return null
  const x = nearest.position.x - sim.position.x
  const z = nearest.position.z - sim.position.z
  const across = Math.hypot(x, z)
  const km = (Math.hypot(across, nearest.position.y - sim.position.y) / 1000).toFixed(1)
  const bearing = Math.atan2(x, -z) - sim.heading
  const turn = Math.atan2(Math.sin(bearing), Math.cos(bearing)) * (180 / Math.PI)
  if (Math.abs(turn) > 15) {
    return `Turn ${Math.round(Math.abs(turn))}° ${turn > 0 ? 'right' : 'left'} for the nearest ${name(nearest)}, ${km} km.`
  }
  const climb =
    (Math.atan2(nearest.position.y - sim.position.y, across) - sim.pitch) * (180 / Math.PI)
  if (Math.abs(climb) > 12) {
    return `${climb > 0 ? 'Pull the nose up' : 'Push the nose down'} ${Math.round(Math.abs(climb))}° toward the ${name(nearest)}, ${km} km.`
  }
  return `The ${name(nearest)} is ahead, ${km} km. It locks within ${AIR_LOCK_RANGE / 1000} km.`
}
