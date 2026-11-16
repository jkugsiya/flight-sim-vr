import { game } from '../game/game'
import type { Interactor } from './input'

// Seconds between the pulses that make up a buffet or a rumble
const BUFFET_GAP = 0.09
const RUMBLE_GAP = 0.13

/** Sends one vibration pulse to a controller. Bare hands and old browsers do nothing. */
export function pulse(it: Interactor, strength: number, ms: number) {
  const actuator = it.gamepad?.hapticActuators?.[0] as
    | { pulse?: (value: number, duration: number) => Promise<boolean> }
    | undefined
  void actuator?.pulse?.(Math.min(1, Math.max(0, strength)), ms)
}

/**
 * What the pilot feels through the controllers: the stall buffet and overspeed shudder in
 * the hand on the flight controls, the runway under the wheels, the touchdown, the gear
 * locking, and the crash. Only controllers vibrate; this does nothing for bare hands.
 */
export class Feel {
  private buffetClock = 0
  private rumbleClock = 0
  private wasOnGround = true
  private sink = 0
  private gear = 1
  private running = 0
  private crashed = false

  /** `flying` is the hand on the stick or yoke, which feels the airframe most. */
  update(dt: number, controllers: Interactor[], flying: Interactor | null) {
    const { sim } = game
    const { status } = game.getState()
    if (controllers.length === 0) return
    const all = (strength: number, ms: number) => {
      for (const it of controllers) pulse(it, strength, ms)
    }

    const crashed = status === 'crashed'
    if (crashed && !this.crashed) all(1, 500)
    this.crashed = crashed
    if (status !== 'flying') return

    // The wing shakes as the airflow breaks away, harder the deeper the stall
    this.buffetClock -= dt
    const buffet = sim.stallWarning
      ? 0.25 + sim.stall * 0.6
      : sim.indicatedAirspeed > sim.speedLimit
        ? 0.3
        : 0
    if (buffet > 0 && this.buffetClock <= 0) {
      this.buffetClock = BUFFET_GAP
      for (const it of flying ? [flying] : controllers) pulse(it, buffet, 60)
    }

    // The runway's joints and the grass, felt through the wheels
    this.rumbleClock -= dt
    if (sim.onGround && sim.groundSpeed > 3 && this.rumbleClock <= 0) {
      this.rumbleClock = RUMBLE_GAP
      const rough = sim.ditched ? 0.5 : 1
      all(Math.min(0.35, sim.groundSpeed / 160) * rough, 40)
    }

    // A thump on touchdown, as firm as the landing
    if (sim.onGround && !this.wasOnGround) all(Math.min(1, 0.25 + this.sink / 4), 120)
    if (!sim.onGround) this.sink = Math.max(0, -sim.verticalSpeed)
    this.wasOnGround = sim.onGround

    // The gear locking up or down, and each engine catching
    const locked = sim.gearPosition >= 1 || sim.gearPosition <= 0
    if (locked && this.gear !== sim.gearPosition && sim.spec.retractableGear) all(0.5, 70)
    this.gear = sim.gearPosition
    if (sim.enginesRunning > this.running) all(0.45, 220)
    this.running = sim.enginesRunning
  }
}
