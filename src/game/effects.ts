import { Vector3 } from 'three'
import type { FlightSim, Ground } from '../sim/flight-sim'

type Rgb = readonly [number, number, number]

/** Everything that defines one puff of smoke, dust, vapour, or fire. */
type Puff = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Seconds until it disappears. */
  life: number
  /** Diameter in metres at birth and at death. */
  size: number
  growTo: number
  /** Linear colour at birth and at death. */
  color: Rgb
  fadeTo?: Rgb
  opacity: number
  /** True for fire and sparks, which add light instead of covering what is behind. */
  glow?: boolean
  /** Share of speed lost per second. */
  drag?: number
  /** Downward pull in m/s². Negative values make hot smoke rise. */
  gravity?: number
}

export const EFFECTS_CAPACITY = 9000
// Floats stored per particle
const STRIDE = 20

const WHITE: Rgb = [1, 1, 1]
const VAPOUR: Rgb = [0.9, 0.93, 0.97]
const TYRE_SMOKE: Rgb = [0.75, 0.75, 0.77]
const DUST: Rgb = [0.5, 0.43, 0.31]
const SOOT: Rgb = [0.05, 0.045, 0.04]
const ASH: Rgb = [0.22, 0.21, 0.2]
const FLAME: Rgb = [1.7, 0.55, 0.06]
const EMBER: Rgb = [0.75, 0.1, 0.01]
const SPARK: Rgb = [1.8, 0.9, 0.25]
const SPRAY: Rgb = [0.85, 0.9, 0.93]

/** Seconds a bomb's shock ring takes to spread out and fade. */
export const SHOCKWAVE_LIFE = 1.6

const spot = new Vector3()
const random = (min: number, max: number) => min + Math.random() * (max - min)

/**
 * Pool of short-lived particles: vapour trails, tyre smoke, dust, and crash effects.
 * The renderer reads `data` and `count` every frame.
 */
export class Effects {
  /** Packed particle state. See the offsets in `add` for the layout. */
  readonly data = new Float32Array(EFFECTS_CAPACITY * STRIDE)
  count = 0
  /** Brightness of the explosion light, 1 at the moment of the blast. */
  flash = 0
  readonly flashPosition = new Vector3()
  /** Camera shake strength from 0 to 1. */
  shake = 0
  /** Shock rings racing out across the ground from bomb blasts, oldest first. */
  readonly shockwaves: { x: number; y: number; z: number; age: number }[] = []

  // Nose wheel and both main wheels
  private readonly wheelWasDown = [true, true, true]
  private trailDebt = 0
  /** Metres flown since the last puff of dumped fuel. */
  private dumpDebt = 0
  private dustDebt = 0

  clear() {
    this.count = 0
    this.flash = 0
    this.shake = 0
    this.shockwaves.length = 0
    this.wheelWasDown.fill(true)
  }

  add(puff: Puff) {
    if (this.count >= EFFECTS_CAPACITY) return
    const fade = puff.fadeTo ?? puff.color
    this.data.set(
      [
        puff.x,
        puff.y,
        puff.z,
        puff.vx,
        puff.vy,
        puff.vz,
        0,
        puff.life,
        puff.size,
        puff.growTo,
        puff.color[0],
        puff.color[1],
        puff.color[2],
        fade[0],
        fade[1],
        fade[2],
        puff.opacity,
        puff.glow ? 1 : 0,
        puff.drag ?? 0,
        puff.gravity ?? 0
      ],
      this.count++ * STRIDE
    )
  }

  /** Ages every particle and removes the ones that have faded out. */
  update(dt: number, wind: Vector3) {
    const d = this.data
    for (let i = this.count - 1; i >= 0; i--) {
      const o = i * STRIDE
      d[o + 6] += dt
      if (d[o + 6] >= d[o + 7]) {
        // Fill the gap with the last particle
        this.count--
        d.copyWithin(o, this.count * STRIDE, (this.count + 1) * STRIDE)
        continue
      }
      const keep = Math.max(0, 1 - d[o + 18] * dt)
      // Drag pulls each puff toward the speed of the wind
      d[o + 3] = wind.x + (d[o + 3] - wind.x) * keep
      d[o + 4] = d[o + 4] * keep - d[o + 19] * dt
      d[o + 5] = wind.z + (d[o + 5] - wind.z) * keep
      d[o] += d[o + 3] * dt
      d[o + 1] += d[o + 4] * dt
      d[o + 2] += d[o + 5] * dt
    }
    for (const ring of this.shockwaves) ring.age += dt
    while ((this.shockwaves[0]?.age ?? 0) > SHOCKWAVE_LIFE) this.shockwaves.shift()
    this.flash *= Math.exp(-dt * 5)
    this.shake *= Math.exp(-dt * 2.5)
  }

  /**
   * Adds the effects a flying or rolling aircraft leaves behind.
   * Returns true on the frame a tyre touches down at speed.
   */
  emitFlight(dt: number, sim: FlightSim, ground: Ground) {
    let chirp = false
    // Wingtip vapour appears when the wing works hard: tight turns, pull-ups, and near the stall
    const effort = Math.max((Math.abs(sim.gLoad) - 1.6) / 1.5, sim.stall)
    if (!sim.onGround && sim.indicatedAirspeed > sim.spec.maneuverSpeed * 0.55 && effort > 0) {
      this.trailDebt += sim.trueAirspeed * dt
      while (this.trailDebt > 1.5) {
        this.trailDebt -= 1.5
        for (const tip of sim.spec.wingtips) {
          spot.copy(tip).applyQuaternion(sim.orientation).add(sim.position)
          this.add({
            x: spot.x,
            y: spot.y,
            z: spot.z,
            vx: 0,
            vy: 0,
            vz: 0,
            life: random(0.9, 1.5),
            size: 0.5,
            growTo: 2.2,
            color: VAPOUR,
            opacity: Math.min(0.5, 0.15 + effort * 0.3),
            drag: 1
          })
        }
      }
    }

    // Dumped fuel streams back from both wings as a fine mist
    if (sim.dumping) {
      this.dumpDebt += sim.trueAirspeed * dt
      while (this.dumpDebt > 4) {
        this.dumpDebt -= 4
        for (const tip of sim.spec.wingtips) {
          spot.copy(tip).multiplyScalar(0.6).applyQuaternion(sim.orientation).add(sim.position)
          this.add({
            x: spot.x,
            y: spot.y,
            z: spot.z,
            vx: 0,
            vy: -1,
            vz: 0,
            life: random(2.5, 4),
            size: 1,
            growTo: 6,
            color: VAPOUR,
            opacity: 0.35,
            drag: 1
          })
        }
      }
    }

    const wheels = sim.spec.contactPoints
    let rolling = false
    for (let i = 0; i < 3; i++) {
      const down = sim.compression[i] > 0
      if (down) {
        spot.copy(wheels[i].position).applyQuaternion(sim.orientation).add(sim.position)
        rolling ||= ground.surfaceAt(spot.x, spot.z) === 'grass'
        // Tyres spin up from standstill on touchdown and burn a puff of rubber
        if (!this.wheelWasDown[i] && sim.groundSpeed > 12) {
          chirp = true
          for (let n = 0; n < 9; n++) this.addGroundPuff(sim, TYRE_SMOKE, 0.45, 0.25)
        }
      }
      this.wheelWasDown[i] = down
    }
    if (rolling && sim.groundSpeed > 5) {
      this.dustDebt += sim.groundSpeed * dt
      while (this.dustDebt > 2.5) {
        this.dustDebt -= 2.5
        spot.copy(wheels[1 + Math.floor(Math.random() * 2)].position)
        spot.applyQuaternion(sim.orientation).add(sim.position)
        this.addGroundPuff(sim, DUST, 0.28, 0.1)
      }
    } else this.dustDebt = 0
    return chirp
  }

  /**
   * Fireball, sparks, and smoke. `power` runs from 0.4 for a slow crash to 1.6 for a jet.
   * A blast on the ground also throws up a ring of dirt.
   */
  explode(at: Vector3, carry: Vector3, power: number, onGround: boolean) {
    this.flash = power
    this.shake = power
    this.flashPosition.copy(at).setY(at.y + 2)
    const push = (speed: number, upward: number) => {
      const angle = Math.random() * Math.PI * 2
      const rise = Math.random() * upward
      const flat = Math.sqrt(1 - Math.min(1, rise) ** 2)
      return {
        vx: carry.x * 0.3 + Math.cos(angle) * flat * speed,
        vy: Math.abs(carry.y) * 0.1 + rise * speed,
        vz: carry.z * 0.3 + Math.sin(angle) * flat * speed
      }
    }
    const here = { x: at.x, y: at.y + 1, z: at.z }
    this.add({
      ...here,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0.22,
      size: 8,
      growTo: 46 * power,
      color: WHITE,
      opacity: 0.9,
      glow: true
    })
    // Smoke goes in first so the fire draws over it
    for (let i = 0; i < 60; i++) {
      this.add({
        ...here,
        ...push(random(3, 13) * power, 1),
        life: random(3, 6.5),
        size: random(2.5, 5),
        growTo: random(14, 24) * power,
        color: SOOT,
        fadeTo: ASH,
        opacity: 0.75,
        drag: 1.3,
        gravity: -3.5
      })
    }
    for (let i = 0; i < 70; i++) {
      this.add({
        ...here,
        ...push(random(5, 20) * power, 1),
        life: random(0.9, 2.3),
        size: random(3, 5),
        growTo: random(10, 17) * power,
        color: FLAME,
        fadeTo: EMBER,
        opacity: 0.85,
        glow: true,
        drag: 2.2,
        gravity: -4
      })
    }
    for (let i = 0; i < 90; i++) {
      this.add({
        ...here,
        ...push(random(14, 48) * power, 1),
        life: random(0.7, 2.2),
        size: random(0.25, 0.5),
        growTo: 0.15,
        color: SPARK,
        fadeTo: EMBER,
        opacity: 1,
        glow: true,
        drag: 0.4,
        gravity: 9.8
      })
    }
    for (let i = 0; onGround && i < 36; i++) {
      this.add({
        ...here,
        ...push(random(8, 22) * power, 0.15),
        life: random(1.5, 3),
        size: random(2, 3.5),
        growTo: random(9, 15),
        color: DUST,
        opacity: 0.5,
        drag: 2.4
      })
    }
  }

  /**
   * A heavy bomb bursting on the ground: a white flash, a rolling fireball, a column of smoke
   * that climbs and spreads, debris and sparks thrown high, and a ring of dust racing outward.
   */
  bombBlast(at: Vector3) {
    this.flash = 6
    this.flashPosition.copy(at).setY(at.y + 30)
    this.shockwaves.push({ x: at.x, y: at.y, z: at.z, age: 0 })
    const burst = (speed: number, upward: number) => {
      const angle = Math.random() * Math.PI * 2
      const rise = upward * Math.sqrt(Math.random())
      const flat = Math.sqrt(1 - rise * rise)
      return {
        x: at.x,
        y: at.y + 2,
        z: at.z,
        vx: Math.cos(angle) * flat * speed,
        vy: rise * speed,
        vz: Math.sin(angle) * flat * speed
      }
    }
    this.add({
      ...burst(0, 0),
      life: 0.45,
      size: 40,
      growTo: 340,
      color: WHITE,
      opacity: 1,
      glow: true
    })
    // Smoke first, so the fire draws over it. It climbs into a column and spreads at the top.
    for (let i = 0; i < 70; i++) {
      this.add({
        ...burst(random(20, 75), random(0.75, 1)),
        life: random(8, 14),
        size: random(14, 24),
        growTo: random(80, 140),
        color: SOOT,
        fadeTo: ASH,
        opacity: 0.8,
        drag: random(0.35, 0.7),
        gravity: -1.5
      })
    }
    for (let i = 0; i < 110; i++) {
      this.add({
        ...burst(random(12, 85), random(0.2, 1)),
        life: random(1.8, 4),
        size: random(14, 24),
        growTo: random(50, 90),
        color: FLAME,
        fadeTo: EMBER,
        opacity: 0.9,
        glow: true,
        drag: 1.6,
        gravity: -6
      })
    }
    // Debris and sparks arc high and fall back
    for (let i = 0; i < 90; i++) {
      this.add({
        ...burst(random(40, 120), random(0.4, 1)),
        life: random(3, 6),
        size: random(1.5, 3.5),
        growTo: random(1, 2.5),
        color: SOOT,
        opacity: 1,
        drag: 0.15,
        gravity: 9.8
      })
    }
    for (let i = 0; i < 110; i++) {
      this.add({
        ...burst(random(50, 150), random(0.2, 1)),
        life: random(1.2, 3),
        size: random(1, 2),
        growTo: 0.3,
        color: SPARK,
        fadeTo: EMBER,
        opacity: 1,
        glow: true,
        drag: 0.3,
        gravity: 9.8
      })
    }
    // Dust kicked up by the shock, racing out low over the ground
    for (let i = 0; i < 60; i++) {
      this.add({
        ...burst(random(100, 200), random(0, 0.08)),
        life: random(2.5, 4),
        size: random(10, 16),
        growTo: random(50, 80),
        color: DUST,
        opacity: 0.6,
        drag: 1.8
      })
    }
  }

  /** Column of spray and a ring of foam for anything that hits the sea. */
  splash(at: Vector3, power: number) {
    this.shake = Math.max(this.shake, power * 0.6)
    for (let i = 0; i < 70 * power; i++) {
      const angle = Math.random() * Math.PI * 2
      const spread = random(1, 9) * power
      this.add({
        x: at.x,
        y: 0.5,
        z: at.z,
        vx: Math.cos(angle) * spread,
        vy: random(8, 30) * power,
        vz: Math.sin(angle) * spread,
        life: random(1.2, 2.6),
        size: random(1, 2.5),
        growTo: random(4, 8),
        color: SPRAY,
        opacity: 0.7,
        drag: 0.5,
        gravity: 9.8
      })
    }
    for (let i = 0; i < 26 * power; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = random(4, 12)
      this.add({
        x: at.x,
        y: 0.4,
        z: at.z,
        vx: Math.cos(angle) * speed,
        vy: 0,
        vz: Math.sin(angle) * speed,
        life: random(2, 4),
        size: 3,
        growTo: random(9, 14),
        color: WHITE,
        opacity: 0.55,
        drag: 1.5
      })
    }
  }

  /** A missile's rocket flame and the white smoke trail it leaves hanging in the air. */
  missileTrail(at: Vector3, dt: number) {
    this.add({
      x: at.x,
      y: at.y,
      z: at.z,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0.15,
      size: 4,
      growTo: 1,
      color: FLAME,
      opacity: 1,
      glow: true
    })
    for (let n = Math.round(random(0, 2) * 40 * dt); n > 0; n--) {
      this.add({
        x: at.x + random(-0.3, 0.3),
        y: at.y + random(-0.3, 0.3),
        z: at.z + random(-0.3, 0.3),
        vx: random(-0.5, 0.5),
        vy: random(0, 0.6),
        vz: random(-0.5, 0.5),
        life: random(3.5, 5.5),
        size: random(1.5, 2.5),
        growTo: random(9, 14),
        color: VAPOUR,
        fadeTo: ASH,
        opacity: 0.55,
        drag: 0.6
      })
    }
  }

  /** A cloud of dust and grit rolling out from the foot of a building as it falls. */
  collapse(at: Vector3) {
    for (let i = 0; i < 5; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = random(3, 10)
      this.add({
        x: at.x,
        y: at.y + random(1, 6),
        z: at.z,
        vx: Math.cos(angle) * speed,
        vy: random(1, 5),
        vz: Math.sin(angle) * speed,
        life: random(3.5, 6),
        size: random(5, 9),
        growTo: random(18, 30),
        color: DUST,
        fadeTo: ASH,
        opacity: 0.55,
        drag: 0.8,
        gravity: -0.3
      })
    }
  }

  /**
   * A burning engine in flight: flames at the nacelle and black smoke left hanging in the air
   * behind it, so the trail grows longer the faster the aircraft flies.
   */
  engineFire(at: Vector3, dt: number) {
    for (let n = Math.round(random(0, 2) * 40 * dt); n > 0; n--) {
      this.add({
        x: at.x + random(-0.6, 0.6),
        y: at.y + random(-0.4, 0.4),
        z: at.z + random(-0.6, 0.6),
        vx: random(-2, 2),
        vy: random(-1, 2),
        vz: random(-2, 2),
        life: random(0.25, 0.6),
        size: random(1.4, 2.6),
        growTo: random(2.5, 4),
        color: FLAME,
        fadeTo: EMBER,
        opacity: 0.9,
        glow: true,
        drag: 1
      })
    }
    for (let n = Math.round(random(0, 2) * 24 * dt); n > 0; n--) {
      this.add({
        x: at.x,
        y: at.y,
        z: at.z,
        vx: random(-1, 1),
        vy: random(0, 2),
        vz: random(-1, 1),
        life: random(4, 7),
        size: random(1.5, 3),
        growTo: random(10, 16),
        color: SOOT,
        fadeTo: ASH,
        opacity: 0.7,
        drag: 0.5,
        gravity: -0.4
      })
    }
  }

  /** Burning wreckage: flames at the base and a rising column of black smoke. */
  burn(at: Vector3, strength: number, dt: number) {
    if (Math.random() < strength * 16 * dt) {
      this.add({
        x: at.x + random(-1, 1),
        y: at.y + 0.5,
        z: at.z + random(-1, 1),
        vx: random(-1, 1),
        vy: random(3, 6),
        vz: random(-1, 1),
        life: random(3.5, 6),
        size: random(1.5, 3),
        growTo: random(9, 16),
        color: SOOT,
        fadeTo: ASH,
        opacity: 0.6 * strength,
        drag: 0.25,
        gravity: -0.6
      })
    }
    if (Math.random() < strength * 24 * dt) {
      this.add({
        x: at.x + random(-1.2, 1.2),
        y: at.y + 0.3,
        z: at.z + random(-1.2, 1.2),
        vx: 0,
        vy: random(2, 5),
        vz: 0,
        life: random(0.45, 1),
        size: random(2, 3.6),
        growTo: 0.8,
        color: FLAME,
        fadeTo: EMBER,
        opacity: 0.8 * strength,
        glow: true,
        drag: 0.6
      })
    }
    // The fire keeps the surroundings flickering
    this.flash = Math.max(this.flash, strength * random(0.01, 0.025))
  }

  /** Thin smoke shed by a piece of wreckage as it tumbles away. */
  smoulder(at: Vector3) {
    this.add({
      x: at.x,
      y: at.y,
      z: at.z,
      vx: 0,
      vy: 1,
      vz: 0,
      life: random(1, 2.2),
      size: 0.8,
      growTo: random(3, 5),
      color: SOOT,
      fadeTo: ASH,
      opacity: 0.45,
      drag: 1,
      gravity: -1
    })
  }

  /** Low puff thrown up at the last wheel position, drifting with the aircraft. */
  private addGroundPuff(sim: FlightSim, color: Rgb, opacity: number, carry: number) {
    this.add({
      x: spot.x + random(-0.3, 0.3),
      y: spot.y + 0.2,
      z: spot.z + random(-0.3, 0.3),
      vx: sim.velocity.x * carry + random(-1, 1),
      vy: random(0.5, 1.8),
      vz: sim.velocity.z * carry + random(-1, 1),
      life: random(0.9, 1.8),
      size: random(0.5, 0.9),
      growTo: random(2.5, 4.5),
      color,
      opacity,
      drag: 1.6
    })
  }
}
