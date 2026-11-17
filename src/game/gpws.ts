import { KNOT } from '../sim/aircraft'
import type { Controls, FlightSim } from '../sim/flight-sim'
import { AIRPORTS, heightAt } from '../world/island'
import type { Navigator } from './navigation'

const FEET = 3.28084
const FPM = 196.85

/**
 * Ground proximity and windshear warnings, highest priority first. Warnings are red and need
 * action now; cautions are amber.
 */
export type Alert =
  | 'WINDSHEAR'
  | 'PULL UP'
  | 'TERRAIN AHEAD'
  | 'TERRAIN'
  | 'SINK RATE'
  | "DON'T SINK"
  | 'TOO LOW GEAR'
  | 'TOO LOW FLAPS'
  | 'GLIDESLOPE'
  | 'BANK ANGLE'

export const WARNINGS: ReadonlySet<Alert> = new Set(['WINDSHEAR', 'PULL UP', 'TERRAIN AHEAD'])

// Heights in feet above the ground that are called out on the way down to land
const CALLOUTS = [500, 100, 50, 40, 30, 20, 10]
// Seconds ahead the terrain look-ahead warns, as a caution and then as a warning
const LOOK_CAUTION = 40
const LOOK_WARNING = 20
// Seconds after takeoff the "don't sink" mode stays armed
const CLIMB_OUT_SECONDS = 120
// Seconds between repeats of the same spoken alert
const REPEAT = 2.2

/**
 * Ground proximity warning system. Call `update` every frame while flying, then read
 * `alert`. `speak` receives each phrase to say out loud, urgent ones cutting off the rest.
 */
export class Gpws {
  alert: Alert | null = null
  /** Set by the game each frame while the windshear detector warns. */
  windshear = false
  private lastHeight = 0
  private closure = 0
  private spokenAt = Number.NEGATIVE_INFINITY
  private time = 0
  private calledBelow = Number.POSITIVE_INFINITY
  /** Highest height above ground since takeoff, while still climbing out. */
  private climbOutPeak: number | null = null
  private climbOutTime = 0
  private lastDt = 0

  constructor(private readonly speak: (phrase: string, urgent: boolean) => void) {}

  /** Clears the state for a new flight. */
  reset(sim: FlightSim) {
    this.alert = null
    this.lastHeight = this.height(sim)
    this.closure = 0
    this.spokenAt = Number.NEGATIVE_INFINITY
    this.calledBelow = Number.POSITIVE_INFINITY
    this.climbOutPeak = null
    this.climbOutTime = 0
  }

  update(dt: number, sim: FlightSim, controls: Controls, nav: Navigator) {
    this.time += dt
    this.lastDt = dt
    const feet = this.height(sim) * FEET
    // Rate the ground comes up at, smoothed so bumps in the terrain do not trip it
    const rising = ((this.lastHeight - this.height(sim)) / Math.max(dt, 1e-3)) * FPM
    this.lastHeight = this.height(sim)
    this.closure += (rising - this.closure) * Math.min(1, dt * 1.5)
    if (sim.onGround || !sim.powered) {
      this.alert = null
      if (sim.onGround) {
        this.climbOutPeak = 0
        this.climbOutTime = 0
        // Nothing left to call out until the next approach, even after a bounce
        this.calledBelow = 0
      }
      return
    }
    // High enough above the top callout to arm them all for the next descent
    if (feet > CALLOUTS[0] + 100) this.calledBelow = Number.POSITIVE_INFINITY
    const alert = this.windshear ? 'WINDSHEAR' : this.check(sim, controls, nav, feet)
    // Windshear is called three times when it starts, not over and over
    const repeats = alert !== 'WINDSHEAR' && this.time - this.spokenAt > REPEAT
    if (alert !== this.alert || (alert && repeats)) {
      if (alert) {
        this.speak(PHRASES[alert] ?? capitalise(alert), true)
        this.spokenAt = this.time
      }
    }
    this.alert = alert
    if (!alert) this.callHeights(sim, controls, feet)
  }

  /** Height of the wheels above the ground or sea, in metres. */
  private height(sim: FlightSim) {
    return Math.max(0, sim.altitudeAgl - sim.spec.restHeight)
  }

  private check(sim: FlightSim, controls: Controls, nav: Navigator, feet: number): Alert | null {
    const spec = sim.spec
    const sink = -sim.verticalSpeed * FPM
    const flapNotches = spec.flapLabels.length - 1
    const landingFlaps = flapNotches === 0 || controls.flapNotch >= Math.max(1, flapNotches - 1)
    const gearDown = sim.gearPosition > 0.99
    const landing = gearDown && landingFlaps

    // Terrain ahead: follow the flight path forward and look for ground in the way
    const impact = this.timeToTerrain(sim, landing)
    if (impact !== null && impact < LOOK_WARNING) return 'PULL UP'
    // Descending far too fast for the height left
    if (feet < 2450 && sink > 1700 + 2.2 * feet) return 'PULL UP'
    // Ground rising fast underneath, outside the landing configuration
    const terrainModes = !landing && !nearAirport(sim.position.x, sim.position.z)
    if (terrainModes && feet < 1800 && this.closure > 3000 + 2.2 * feet) return 'PULL UP'
    if (impact !== null && impact < LOOK_CAUTION) return 'TERRAIN AHEAD'
    if (terrainModes && feet < 1800 && this.closure > 2000 + 1.6 * feet) return 'TERRAIN'
    if (feet < 2450 && sink > 1000 + 1.64 * feet) return 'SINK RATE'

    // Losing height while climbing out after takeoff. The mode ends at 1500 ft, after
    // two minutes, or once the aircraft is set up to land.
    if (this.climbOutPeak !== null) {
      this.climbOutTime += this.lastDt
      if (feet > 1500 || landing || this.climbOutTime > CLIMB_OUT_SECONDS) this.climbOutPeak = null
      else {
        this.climbOutPeak = Math.max(this.climbOutPeak, feet)
        if (this.climbOutPeak > 50 && this.climbOutPeak - feet > 30 + this.climbOutPeak * 0.1) {
          return "DON'T SINK"
        }
      }
    }

    const knots = sim.indicatedAirspeed / KNOT
    const descending = sink > 200
    if (spec.retractableGear && !gearDown && feet < 500 && knots < 190 && descending) {
      return 'TOO LOW GEAR'
    }
    if (flapNotches > 0 && gearDown && !landingFlaps && feet < 245 && knots < 159 && descending) {
      return 'TOO LOW FLAPS'
    }
    // Well below the ILS glide slope on final
    const { approach, guidance } = nav
    if (
      approach?.kind === 'ILS' &&
      nav.onFinal &&
      guidance.receiving &&
      feet < 1000 &&
      feet > 30 &&
      guidance.vertical > 1.3
    ) {
      return 'GLIDESLOPE'
    }
    // Airliners warn of steep banks
    if (spec.panel === 'glass' && Math.abs(sim.bank) > (35 * Math.PI) / 180) return 'BANK ANGLE'
    return null
  }

  /**
   * Seconds until the flight path, held as it is, meets the ground within 30 m. Null when
   * clear for the look-ahead time, or when the aircraft is set up to land and the ground
   * ahead is the runway it is landing on.
   */
  private timeToTerrain(sim: FlightSim, landing: boolean) {
    const { position, velocity } = sim
    if (landing && sim.altitudeAgl < 600) return null
    // Near an airport and low, the ground ahead is most likely the runway
    if (sim.altitudeAgl < 400 && nearAirport(position.x, position.z)) return null
    for (let t = 2; t <= LOOK_CAUTION; t += 2) {
      const x = position.x + velocity.x * t
      const z = position.z + velocity.z * t
      // Climbs count only partly: the aircraft may not keep climbing at this rate
      const y = position.y + Math.min(velocity.y, velocity.y * 0.5) * t
      if (y < Math.max(heightAt(x, z), 0) + 30) return t
    }
    return null
  }

  /**
   * Calls out the height on the way down when the gear is down. Only the lowest height
   * crossed is spoken, so a fast descent past several never plays them all at once.
   */
  private callHeights(sim: FlightSim, controls: Controls, feet: number) {
    if (sim.verticalSpeed >= 0 || sim.gearPosition < 0.99) return
    let crossed = 0
    for (const height of CALLOUTS) {
      if (feet <= height && height < this.calledBelow) crossed = height
    }
    if (!crossed) return
    this.calledBelow = crossed
    // Airbus aircraft remind the pilot to close the thrust levers at 20 ft
    const airbus = sim.spec.id === 'a320' || sim.spec.id === 'a380'
    if (crossed === 20 && airbus && controls.throttle > 0.05) this.speak('Retard. Retard.', false)
    else this.speak(crossed === 500 ? 'Five hundred' : String(crossed), false)
  }
}

/** True within 3 km of an airport's grounds, where the terrain modes stand down. */
function nearAirport(x: number, z: number) {
  return AIRPORTS.some(airport => Math.hypot(airport.x - x, airport.z - z) < airport.reach + 3000)
}

const PHRASES: Partial<Record<Alert, string>> = {
  WINDSHEAR: 'Windshear! Windshear! Windshear!',
  'PULL UP': 'Pull up! Pull up!'
}

const capitalise = (alert: Alert) => alert.charAt(0) + alert.slice(1).toLowerCase()
