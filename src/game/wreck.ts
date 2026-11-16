import { Quaternion, Vector3 } from 'three'
import type { CrashReason, FlightSim, Ground } from '../sim/flight-sim'
import type { Effects } from './effects'

/** The parts every aircraft breaks into, in the order of `AircraftSpec.breakup`. */
export const PART_NAMES = ['fuselage', 'nose', 'leftWing', 'rightWing', 'tail'] as const
export type PartName = (typeof PART_NAMES)[number]

type Debris = {
  position: Vector3
  velocity: Vector3
  orientation: Quaternion
  /** World-frame spin in rad/s. */
  spin: Vector3
  radius: number
  wet: boolean
}

const GRAVITY = 9.81
const offset = new Vector3()
const turn = new Quaternion()
const random = (min: number, max: number) => min + Math.random() * (max - min)

/** Tumbling wreckage after a crash. The aircraft model follows these pieces while `active`. */
export class Wreck {
  active = false
  /** Seconds since the crash. */
  time = 0
  readonly pieces: Debris[] = PART_NAMES.map(() => ({
    position: new Vector3(),
    velocity: new Vector3(),
    orientation: new Quaternion(),
    spin: new Vector3(),
    radius: 0.5,
    wet: false
  }))
  private onFire = false

  reset() {
    this.active = false
    this.time = 0
  }

  /** Breaks the aircraft apart where it is and sets off the blast or splash. */
  start(sim: FlightSim, reason: CrashReason, ground: Ground, effects: Effects) {
    this.active = true
    this.time = 0
    const speed = sim.velocity.length()
    // Heavier, faster aircraft make a bigger blast
    const power = Math.min(1.6, Math.max(0.4, speed / 55) * (sim.spec.mass > 5000 ? 1.5 : 1))
    const inSea = reason === 'water'
    this.onFire = !inSea

    this.pieces.forEach((piece, i) => {
      offset.copy(sim.spec.breakup[i].rest).applyQuaternion(sim.orientation)
      piece.radius = sim.spec.breakup[i].radius
      piece.position.copy(sim.position).add(offset)
      const floor = Math.max(ground.heightAt(piece.position.x, piece.position.z), 0) + piece.radius
      if (piece.position.y < floor) piece.position.y = floor
      piece.orientation.copy(sim.orientation)
      piece.wet = false

      // Each part keeps most of the aircraft's speed and is thrown outward from the centre
      piece.velocity.copy(sim.velocity).multiplyScalar(random(0.25, 0.55))
      if (offset.lengthSq() > 0.01)
        piece.velocity.addScaledVector(offset.normalize(), random(4, 11) * power)
      piece.velocity.y = Math.abs(piece.velocity.y) * 0.25 + random(3, 10) * power
      piece.spin
        .set(random(-1, 1), random(-1, 1), random(-1, 1))
        .multiplyScalar(random(3, 9) * power)
    })
    // The nose section always spins off on its own
    this.pieces[1].spin.multiplyScalar(2.5)

    if (inSea) effects.splash(sim.position, Math.max(0.6, power))
    else effects.explode(sim.position, sim.velocity, power, reason !== 'overspeed')
  }

  step(dt: number, ground: Ground, effects: Effects) {
    if (!this.active) return
    this.time += dt
    this.pieces.forEach((piece, i) => {
      const { position, velocity, spin } = piece
      velocity.y -= GRAVITY * dt
      velocity.multiplyScalar(1 - 0.12 * dt)
      position.addScaledVector(velocity, dt)

      const terrain = ground.heightAt(position.x, position.z)
      if (terrain < 0) {
        // Sea: splash once, then bob at the surface and slowly go under
        if (position.y < 0) {
          if (!piece.wet) {
            piece.wet = true
            effects.splash(position, 0.35)
          }
          velocity.multiplyScalar(Math.max(0, 1 - 3 * dt))
          velocity.y += (-0.3 - Math.max(0, this.time - 5) * 0.12 - position.y) * 6 * dt
          spin.multiplyScalar(Math.max(0, 1 - 2 * dt))
        }
      } else if (position.y < terrain + piece.radius) {
        position.y = terrain + piece.radius
        if (velocity.y < 0) velocity.y = velocity.y < -1.5 ? -velocity.y * 0.3 : 0
        // Scraping along the ground slows the slide and the tumble
        const grip = Math.max(0, 1 - 3.2 * dt)
        velocity.x *= grip
        velocity.z *= grip
        spin.multiplyScalar(Math.max(0, 1 - 3 * dt))
      }

      const rate = spin.length()
      if (rate > 0.01) {
        turn.setFromAxisAngle(offset.copy(spin).divideScalar(rate), rate * dt)
        piece.orientation.premultiply(turn).normalize()
      }
      // Burning parts trail smoke while they fly
      if (this.onFire && !piece.wet && i !== 1 && this.time < 3 && Math.random() < dt * 30) {
        effects.smoulder(position)
      }
    })

    const fuselage = this.pieces[0]
    if (this.onFire && !fuselage.wet)
      effects.burn(fuselage.position, Math.max(0.25, 1 - this.time / 40), dt)
  }
}
