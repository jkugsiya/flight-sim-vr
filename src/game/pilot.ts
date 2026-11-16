import { type AircraftSpec, isGlider, KNOT, tailStrikePitch } from '../sim/aircraft'
import type { Controls, FlightSim } from '../sim/flight-sim'
import type { Approach } from '../world/approaches'
import { heightAt } from '../world/island'
import type { Navigator } from './navigation'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const approach = (value: number, target: number, step: number) =>
  value < target ? Math.min(target, value + step) : Math.max(target, value - step)
/** Smallest signed angle from `from` to `to`, in radians. */
const turnTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))
const FEET = 0.3048
const FPM = 0.00508

// Control travel per second at full rate while a key is held, and while it springs back.
// The elevator moves slower so a short tap makes a small pitch change.
const DEFLECT_RATE = 1.8
const PITCH_RATE = 0.9
const CENTER_RATE = 3
// A tap moves controls at this share of full rate; holding builds up to full rate in RAMP_SECONDS
const TAP_SHARE = 0.3
const RAMP_SECONDS = 0.6
// Shift limits stick and rudder to this share of their travel, for fine corrections
const FINE_SHARE = 0.35
const THROTTLE_RATE = 0.5
const TRIM_RATE = 0.25
// Stick or yoke travel, as a share of full, that overpowers the autopilot and switches it off
const OVERRIDE = 0.3
// Autopilot knob speeds per second while held: radians, metres, m/s, and m/s of climb
const HEADING_RATE = 0.35
const ALTITUDE_RATE = 60
const SPEED_RATE = 8
const VERTICAL_SPEED_RATE = 2.5
const AUTOPILOT_BANK = 0.44
// Fly-by-wire jets up to this mass in kg get the autopilot's full slow pitch correction
const RESPONSE_MASS = 80_000
// Yaw damper rudder per radian of slip, and per radian-second of slip it builds up
const YAW_DAMPER = 2
const YAW_TRIM = 1
// Aileron per radian-second of bank error the autopilot builds up
const ROLL_TRIM = 0.3
// Without autoland, the approach autopilot hands over to the pilot at this height in metres
const MINIMUMS = 15
// Autoland: wheel heights in metres where the flare starts and the throttle closes, the
// seconds of descent the flare keeps left, the gentlest sink it asks for in m/s, the nose-down
// rate in radians per second once down, and the ground speed in m/s where it hands back
const FLARE_HEIGHT = 15
// Seconds ahead the flare judges the descent
const FLARE_AHEAD = 1
const RETARD_HEIGHT = 6
const FLARE_SECONDS = 4
const FLARE_SINK = 0.4
// Flare stick per m/s of extra sink, per m/s-second it builds up, and against each radian
// per second the nose is already rising
const FLARE_GAIN = 0.14
const FLARE_BUILD = 0.02
const FLARE_DAMPING = 6
// Pitch in radians the flare keeps clear of a tail strike
const TAIL_MARGIN = 0.03
const DEROTATE_RATE = -0.03
const ROLLOUT_END = 15

/** Airliners and the bomber land themselves; fighters and light aircraft hand over at 50 ft. */
export const canAutoland = (sim: FlightSim) =>
  sim.spec.shape.type === 'airliner' || sim.spec.shape.type === 'bomber'

/** Height of the wheels above the runway, or above the ground on the way in over hills. */
const wheelHeight = (sim: FlightSim, runway: Approach) =>
  Math.min(sim.altitudeAgl, sim.position.y - runway.end.elevation) - sim.spec.restHeight
// Seconds to settle onto the centreline, and the steepest intercept angle in radians
const INTERCEPT_TIME = 12
const MAX_INTERCEPT = 0.52
// Before the final approach the autopilot stays this high above the ground, in metres
const TERRAIN_FLOOR = 300
// Metres either side of the centreline that count as lined up for the glide path
const ESTABLISHED = 250

// Keys 1 to 4 switch the engines numbered from the left wingtip
const ENGINE_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4']

/**
 * Lateral modes: HDG flies the heading knob, NAV the flight plan, APP the approach course.
 * Vertical modes: ALT holds an altitude, VS a climb rate, FLCH climbs or descends to the
 * altitude knob at the speed knob, VNAV flies the flight plan's profile, APP the glide path.
 */
export type LateralMode = 'HDG' | 'NAV' | 'APP'
export type VerticalMode = 'ALT' | 'VS' | 'FLCH' | 'VNAV' | 'APP'
export type Knob = 'speed' | 'heading' | 'altitude' | 'verticalSpeed'

const PARKED: Omit<Controls, 'engineSwitches'> = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  brake: 0,
  brakeLeft: 0,
  brakeRight: 0,
  parkingBrake: true,
  battery: false,
  fuelPumps: false,
  flapNotch: 0,
  gearDown: true,
  speedBrake: false,
  reverse: false,
  trim: 0,
  fuelDump: false
}

/**
 * Controls moved by VR hands or controllers. A null axis leaves that control to the keyboard.
 * The VR cockpit writes them every frame.
 */
export type Analog = {
  /** Stick or yoke from -1 to 1: back raises the nose, right rolls right. */
  stick: { pitch: number; roll: number } | null
  /** Rudder from -1 to 1, positive yaws right. */
  yaw: number | null
  /** Throttle lever from 0 to 1. Moving it takes over from the autothrottle. */
  throttle: number | null
  /** Wheel brakes from 0 to 1. */
  brake: number
  /** Trim switch from -1, nose down, to 1, nose up. */
  trim: number
  /**
   * True in VR, which has no rudder pedals: the stick steers on the ground, and the yaw
   * damper balances turns in the air, unless a thumbstick works the rudder.
   */
  noPedals: boolean
}

/** Turns held keys into stick, rudder, and lever positions, and flies the autopilot. */
export class Pilot {
  readonly controls: Controls = { ...PARKED, engineSwitches: ENGINE_KEYS.map(() => false) }
  readonly analog: Analog = {
    stick: null,
    yaw: null,
    throttle: null,
    brake: 0,
    trim: 0,
    noPedals: false
  }
  /**
   * Autopilot panel. The knobs hold a heading in radians, an altitude in metres, and a climb
   * rate in m/s; they can be set with the autopilot off. `hold` is the altitude ALT keeps.
   */
  readonly autopilot = {
    on: false,
    lateral: 'HDG' as LateralMode,
    vertical: 'ALT' as VerticalMode,
    heading: 0,
    altitude: 0,
    verticalSpeed: 0,
    hold: 0
  }
  /** True after the approach autopilot let go at 50 ft, until it is engaged again. */
  handedOver = false
  /** Autothrottle: holds the speed knob, an indicated airspeed in m/s. */
  readonly autothrottle = { on: false, speed: 0 }
  landingLights = false

  private readonly held = new Map<string, number>()
  private climbTrim = 0
  /** Stick the autoland flare has built up, or null outside the flare. */
  private flareStick: number | null = null
  /** Climb rate at the last flare step, to see how fast the descent is easing. */
  private flareSink: number | null = null
  /** Aileron the autopilot has built up against a steady roll. */
  private rollTrim = 0
  /** Rudder the yaw damper has built up against a steady slip. */
  private rudderHold = 0
  private lastAirspeed = 0
  private lastFix = 0
  private throttleTrim = 0
  /** Climb rate the level change mode asks for, in m/s. */
  private levelChange = 0

  /**
   * Sets the levers for a start on the ground: engines off, parking brake set.
   * Cold and dark leaves the battery and fuel pumps off too.
   */
  resetForGround(sim: FlightSim, cold: boolean) {
    Object.assign(this.controls, PARKED, { battery: !cold, fuelPumps: !cold })
    this.landingLights = false
    this.controls.engineSwitches.fill(false)
    this.disengage()
    this.syncKnobs(sim)
  }

  /** Sets the levers for a start in level flight. */
  resetForAir(spec: AircraftSpec, sim?: FlightSim) {
    this.landingLights = false
    Object.assign(this.controls, PARKED, {
      throttle: 0.55,
      parkingBrake: false,
      battery: true,
      fuelPumps: true,
      gearDown: !spec.retractableGear
    })
    this.controls.engineSwitches.fill(true)
    this.disengage()
    if (sim) this.syncKnobs(sim)
  }

  /** True while the autopilot flies the approach. */
  get flyingApproach() {
    return this.autopilot.on && this.autopilot.lateral === 'APP'
  }

  /** Registers a key press. Returns true when the key is a flight control. */
  press(code: string, repeat: boolean, sim: FlightSim, nav?: Navigator, shift = false) {
    const c = this.controls
    if (!repeat) {
      // On fighters the flight computer sets the flaps, so the keys do nothing
      const lever = !sim.spec.autoFlaps
      if (code === 'KeyF' && lever) {
        c.flapNotch = Math.min(sim.spec.flapLabels.length - 1, c.flapNotch + 1)
      } else if (code === 'KeyV' && lever) c.flapNotch = Math.max(0, c.flapNotch - 1)
      else if (code === 'KeyG') {
        // The Shuttle's gear falls by gravity and locks: once down it stays down
        const locked = c.gearDown && isGlider(sim.spec)
        c.gearDown = !c.gearDown || !sim.spec.retractableGear || locked
      } else if (code === 'KeyB') c.speedBrake = !c.speedBrake
      else if (code === 'KeyR') c.reverse = !c.reverse
      else if (code === 'KeyP') c.parkingBrake = !c.parkingBrake
      else if (code === 'Minus') c.fuelDump = !c.fuelDump
      else if (code === 'KeyO') c.battery = !c.battery
      else if (code === 'KeyU') c.fuelPumps = !c.fuelPumps
      else if (code === 'KeyI') {
        // Starts every engine, or stops them all once they are all on
        const switches = c.engineSwitches.slice(0, sim.engines.length)
        c.engineSwitches.fill(!switches.every(Boolean))
      } else if (ENGINE_KEYS.includes(code)) {
        const engine = ENGINE_KEYS.indexOf(code)
        // With Shift, the key discharges that engine's fire bottle instead
        if (engine < sim.engines.length) {
          if (shift) sim.extinguish(engine, c.engineSwitches[engine])
          else c.engineSwitches[engine] = !c.engineSwitches[engine]
        }
      } else if (code === 'KeyL') this.landingLights = !this.landingLights
      else if (code === 'KeyZ') this.engage(!this.autopilot.on, sim)
      else if (code === 'KeyX') this.toggleAutothrottle(sim)
      else if (code === 'KeyH') this.setLateral('HDG', sim, nav)
      else if (code === 'KeyJ')
        this.setLateral(this.autopilot.lateral === 'NAV' ? 'HDG' : 'NAV', sim, nav)
      else if (code === 'KeyK') this.setVertical('VS', sim, nav)
      else if (code === 'KeyY') this.setVertical('FLCH', sim, nav)
    }
    // Shift with a control key means a fine, small movement
    if (!this.held.has(code)) this.held.set(code, 0)
    if (shift) this.held.set('Shift', 0)
    return FLIGHT_KEYS.has(code)
  }

  release(code: string) {
    this.held.delete(code)
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.held.delete('Shift')
  }

  releaseAll() {
    this.held.clear()
  }

  /**
   * Switches the autopilot on in heading and altitude hold at the current values, or off.
   * `syncAltitude` also sets the altitude knob to here, as Z does; a mode key keeps it.
   */
  engage(on: boolean, sim: FlightSim, syncAltitude = true) {
    const { autopilot } = this
    autopilot.on = on && !sim.onGround && sim.powered
    autopilot.lateral = 'HDG'
    autopilot.vertical = 'ALT'
    autopilot.heading = sim.heading
    autopilot.hold = sim.position.y
    if (syncAltitude) autopilot.altitude = Math.round(sim.position.y / FEET / 100) * 100 * FEET
    this.climbTrim = 0
    this.handedOver = false
  }

  toggleAutothrottle(sim: FlightSim) {
    this.autothrottle.on = !this.autothrottle.on && !sim.onGround && sim.powered
    if (this.autothrottle.on && this.autothrottle.speed < 1) {
      this.autothrottle.speed = sim.indicatedAirspeed
    }
    this.throttleTrim = this.controls.throttle
  }

  /** Picks a lateral mode, switching the autopilot on if needed. */
  setLateral(mode: LateralMode, sim: FlightSim, nav?: Navigator) {
    if (mode === 'NAV' && !nav?.plan && !nav?.approach) return
    if (mode === 'APP' && !nav?.approach) return
    if (!this.autopilot.on) this.engage(true, sim, false)
    if (!this.autopilot.on) return
    const { autopilot } = this
    // Leaving the approach or the plan: hold where the aircraft is now
    if (autopilot.vertical === 'APP' || (autopilot.vertical === 'VNAV' && mode !== 'NAV')) {
      autopilot.vertical = 'ALT'
      autopilot.hold = sim.position.y
    }
    if (mode === 'HDG' && autopilot.lateral !== 'HDG') autopilot.heading = sim.heading
    autopilot.lateral = mode
    if (mode === 'APP') {
      autopilot.vertical = 'APP'
      // No waypoint matches, so the autothrottle picks the speed for the current one
      this.lastFix = -1
    } else if (mode === 'NAV' && nav?.plan && nav.enroute) {
      autopilot.vertical = 'VNAV'
    } else if (mode === 'NAV') {
      // No route left to follow, so NAV means the approach
      this.setLateral('APP', sim, nav)
    }
  }

  /** Picks a vertical mode, switching the autopilot on if needed. */
  setVertical(mode: VerticalMode, sim: FlightSim, nav?: Navigator) {
    if (!this.autopilot.on) this.engage(true, sim, false)
    if (!this.autopilot.on) return
    const { autopilot } = this
    if (autopilot.lateral === 'APP') {
      autopilot.lateral = 'HDG'
      autopilot.heading = sim.heading
    }
    autopilot.vertical = mode
    autopilot.hold = sim.position.y
    if (mode === 'VS') {
      // Start from the current climb rate, or 1000 ft/min toward the altitude knob
      const toward = Math.sign(autopilot.altitude - sim.position.y) || 1
      const current = Math.round(sim.verticalSpeed / (100 * FPM)) * 100 * FPM
      autopilot.verticalSpeed = Math.abs(current) > 1 ? current : toward * 1000 * FPM
    } else if (mode === 'FLCH') {
      this.levelChange = sim.verticalSpeed
      if (this.autothrottle.speed < 1) this.autothrottle.speed = sim.indicatedAirspeed
    } else if (mode === 'VNAV' && !nav?.plan) autopilot.vertical = 'ALT'
  }

  /** Turns an autopilot knob by `steps` clicks: 1 kt, 1°, 100 ft, or 100 ft/min each. */
  adjust(knob: Knob, steps: number) {
    const { autopilot, autothrottle } = this
    if (knob === 'speed') autothrottle.speed = Math.max(0, autothrottle.speed + steps * KNOT)
    else if (knob === 'heading') autopilot.heading += (steps * Math.PI) / 180
    else if (knob === 'altitude') {
      const feet = Math.round(autopilot.altitude / FEET / 100) * 100 + steps * 100
      autopilot.altitude = Math.max(0, feet) * FEET
    } else autopilot.verticalSpeed += steps * 100 * FPM
  }

  /**
   * Lets the autopilot fly the selected approach, switching the autopilot on if needed.
   * Switching it off leaves the autopilot holding the current heading and altitude.
   */
  flyApproach(on: boolean, sim: FlightSim, nav: Navigator) {
    if (on) this.setLateral('APP', sim, nav)
    else if (this.autopilot.lateral === 'APP') this.setLateral('HDG', sim, nav)
  }

  /** Moves the controls toward the held keys, or flies the autopilot's targets. */
  update(dt: number, sim: FlightSim, nav?: Navigator) {
    const c = this.controls
    const spec = sim.spec
    const airspeed = sim.indicatedAirspeed
    for (const [code, time] of this.held) this.held.set(code, time + dt)
    // Up to manoeuvring speed the stick reaches full travel, and a full pull stalls the wing.
    // Above it, air loads on the controls limit how far a pilot can move them.
    const loading = spec.maneuverSpeed / Math.max(airspeed, 1)
    const fine = this.held.has('Shift') ? FINE_SHARE : 1
    const pitchReach = clamp(loading * loading, 0.12, 1) * fine
    const rollReach = clamp(loading, 0.3, 1) * fine
    const stick = this.axis('ArrowDown', 'ArrowUp')
    const wheel = this.axis('ArrowRight', 'ArrowLeft')
    const lever = this.axis('KeyW', 'KeyS')
    const { autopilot, analog } = this
    // A firm push or pull on the stick takes over from the autopilot, as in a real cockpit
    if (autopilot.on && analog.stick) {
      if (Math.hypot(analog.stick.pitch, analog.stick.roll) > OVERRIDE) this.disengage(true)
    }
    // An autoland stays engaged on the runway, steering and braking down to taxi speed
    const rollingOut = this.landing(sim, nav) && sim.groundSpeed > ROLLOUT_END
    if ((sim.onGround && !rollingOut) || sim.stall > 0.5 || !sim.powered) this.disengage()

    if (autopilot.lateral === 'APP' && nav?.approach && nav.onFinal && autopilot.on) {
      // Without autoland, hand over for the flare: autopilot off, throttle closed
      if (!canAutoland(sim) && sim.altitudeAgl < MINIMUMS && nav.guidance.along < 2000) {
        this.disengage()
        this.handedOver = true
        c.throttle = 0
      }
    }
    if (autopilot.lateral === 'APP' && !nav?.approach) this.setLateral('HDG', sim, nav)
    // The flight plan hands over to the approach once its last waypoint passes
    if (autopilot.on && autopilot.lateral === 'NAV' && nav && !nav.enroute) {
      // With the approach cleared, hold the heading and altitude the route ended at
      if (nav.approach) this.setLateral('APP', sim, nav)
      else this.setLateral('HDG', sim, nav)
    }

    if (autopilot.on) {
      // The arrows still move the aircraft up and down: while holding an altitude, they
      // start a climb or descent, with the altitude knob turning from where the aircraft is
      if (stick !== 0 && autopilot.vertical === 'ALT') {
        this.setVertical('VS', sim, nav)
        autopilot.verticalSpeed = Math.sign(stick) * 1000 * FPM
        autopilot.altitude = sim.position.y
      }
      // Arrow keys turn the heading and altitude knobs, brackets the climb rate wheel.
      // Back on the stick turns the altitude up, as it raises the nose by hand.
      autopilot.heading += wheel * HEADING_RATE * this.boost('ArrowRight', 'ArrowLeft') * dt
      autopilot.altitude = Math.max(
        0,
        autopilot.altitude + stick * ALTITUDE_RATE * this.boost('ArrowDown', 'ArrowUp') * dt
      )
      autopilot.verticalSpeed += this.axis('BracketRight', 'BracketLeft') * VERTICAL_SPEED_RATE * dt
      this.fly(dt, sim, nav, rollReach, pitchReach)
    } else if (analog.stick && stick === 0 && wheel === 0) {
      // A hand on the stick moves the surfaces at once: the cockpit control smooths it
      c.pitch = analog.stick.pitch * pitchReach
      c.roll = analog.stick.roll * rollReach
    } else {
      c.pitch = this.deflect(c.pitch, stick * pitchReach, dt, PITCH_RATE, 'ArrowDown', 'ArrowUp')
      c.roll = this.deflect(c.roll, wheel * rollReach, dt, DEFLECT_RATE, 'ArrowRight', 'ArrowLeft')
    }

    if (analog.throttle !== null && lever === 0) {
      this.autothrottle.on = false
      c.throttle = analog.throttle
    } else if (this.autothrottle.on) this.flyThrottle(dt, sim, lever)
    else c.throttle = clamp(c.throttle + lever * THROTTLE_RATE * dt, 0, 1)
    this.lastAirspeed = airspeed

    if (spec.autoFlaps) c.flapNotch = c.gearDown ? spec.flapLabels.length - 1 : 0
    const pedals = this.axis('KeyD', 'KeyA')
    // Without pedals, the stick steers the nose wheel on the ground
    const steer = analog.noPedals && sim.onGround ? (analog.stick?.roll ?? null) : null
    const handRudder = pedals === 0 ? (analog.yaw ?? steer) : null
    // Without pedals in the air, the yaw damper balances the turns as the autopilot's does
    const damped = autopilot.on || (analog.noPedals && !sim.onGround)
    if (handRudder !== null) {
      c.yaw = handRudder
      this.rudderHold = 0
    } else if (autopilot.on && pedals === 0 && sim.onGround) {
      // Rolling out after an autoland: the rudder steers along the runway
      c.yaw = this.rudderHold
    } else if (damped && pedals === 0) {
      // Yaw damper: the autopilot sets the rudder that balances uneven engines, as after an
      // engine failure, and works it to centre the slip ball
      // Both the slip it feels and the rudder's bite grow as the airspeed squared, so above
      // manoeuvring speed the damper eases off. The thin air up high damps a swing less, so
      // there it eases off too, and past Mach 1 the airframe holds itself straight. Without
      // this the damper swings the tail side to side at speed or height.
      const thin = sim.indicatedAirspeed / Math.max(sim.trueAirspeed, 1)
      const supersonic = Math.min(1, Math.max(0, (sim.mach - 0.9) / 0.2))
      const fast = Math.min(1, (spec.maneuverSpeed / Math.max(airspeed, 1)) ** 4)
      const bite = fast * thin * thin * (1 - supersonic)
      this.rudderHold = clamp(this.rudderHold + sim.slip * YAW_TRIM * bite * dt, -1, 1)
      c.yaw = clamp(sim.balancingRudder + this.rudderHold + sim.slip * YAW_DAMPER * bite, -1, 1)
    } else {
      c.yaw = this.deflect(c.yaw, pedals * fine, dt, DEFLECT_RATE, 'KeyD', 'KeyA')
      this.rudderHold = 0
    }
    const trim = this.axis('KeyE', 'KeyQ')
    c.trim = clamp(c.trim + trim * TRIM_RATE * this.ramp('KeyE', 'KeyQ') * dt, -1, 1)
    c.trim = clamp(c.trim + analog.trim * TRIM_RATE * dt, -1, 1)
    c.brake = this.held.has('Space') ? 1 : analog.brake
    c.brakeLeft = this.held.has('Comma') ? 1 : 0
    c.brakeRight = this.held.has('Period') ? 1 : 0
  }

  /** Flies the autopilot's lateral and vertical modes. */
  private fly(
    dt: number,
    sim: FlightSim,
    nav: Navigator | undefined,
    rollReach: number,
    pitchReach: number
  ) {
    const c = this.controls
    const spec = sim.spec
    const { autopilot } = this
    const airspeed = sim.indicatedAirspeed
    const groundTrack = Math.atan2(sim.velocity.x, -sim.velocity.z)

    // Lateral: where to point, and whether to compare against heading or ground track
    let track = sim.heading
    let target = autopilot.heading
    let commanded = autopilot.hold
    let descent = 0
    let gentle = false
    if (this.landing(sim, nav) && nav?.approach) {
      const wheels = wheelHeight(sim, nav.approach)
      if (sim.onGround) {
        this.rollOut(sim, nav.approach, nav)
        return
      }
      // Once started, the flare carries on to the touchdown
      if (this.flareStick !== null || wheels < FLARE_HEIGHT) {
        this.flare(dt, sim, nav.approach, wheels, rollReach)
        return
      }
    }
    this.flareStick = null
    this.flareSink = null
    if (autopilot.lateral === 'APP' && nav?.approach) {
      const steer = this.steerApproach(sim, nav)
      track = groundTrack
      target = steer.heading
      if (
        autopilot.vertical === 'APP' &&
        !(this.landing(sim, nav) && wheelHeight(sim, nav.approach) < FLARE_HEIGHT)
      ) {
        commanded = steer.altitude
        descent = steer.descent
        gentle = true
      }
    } else if (autopilot.lateral === 'NAV' && nav) {
      const route = nav.routeTrack(sim)
      if (route !== null) {
        track = groundTrack
        target = route
      }
    }

    // Vertical: the climb rate each mode asks for, at up to 60% of the best rate
    const limit = clamp((spec.stats.climb / 197) * 0.6, 3, 20)
    let climb = 0
    const toKnob = autopilot.altitude - sim.position.y
    if (autopilot.vertical === 'VS' || autopilot.vertical === 'FLCH') {
      if (autopilot.vertical === 'VS') climb = clamp(autopilot.verticalSpeed, -limit * 2, limit)
      else {
        // Level change trades height for speed: too fast pitches up, too slow pitches down
        const error = airspeed - this.autothrottle.speed
        const up = toKnob > 0
        this.levelChange = clamp(
          this.levelChange + error * 0.4 * dt,
          up ? 0.5 : -limit * 2,
          up ? limit * 1.4 : -0.5
        )
        climb = clamp(this.levelChange + error * 0.6, up ? 0 : -limit * 2, up ? limit * 1.4 : 0)
      }
      // Capture the altitude knob, leading by a few seconds of climb
      if (Math.abs(toKnob) < Math.max(25, Math.abs(sim.verticalSpeed) * 5)) {
        autopilot.vertical = 'ALT'
        autopilot.hold = autopilot.altitude
      }
    }
    if (autopilot.vertical === 'VNAV') {
      const profile = nav?.profileAltitude(sim) ?? null
      if (profile === null) {
        autopilot.vertical = 'ALT'
        autopilot.hold = sim.position.y
      } else commanded = profile
    }
    if (
      autopilot.vertical === 'ALT' ||
      autopilot.vertical === 'VNAV' ||
      autopilot.vertical === 'APP'
    ) {
      // Far below the target, as when a short route ends mid-climb, climb harder
      const steep = commanded - sim.position.y > 150 ? 1.5 : 1
      climb = clamp(
        (commanded - sim.position.y) * (gentle ? 0.06 : 0.12) - descent,
        -limit - descent,
        limit * steep
      )
    }

    // How hard the aircraft answers a full stick at this speed: roll rate, and extra g
    const flow = Math.max(airspeed, spec.stats.stallSpeed * 0.4)
    const pressure = 0.5 * 1.225 * flow * flow * spec.wingArea
    const rollPower = ((spec.clAileron / -spec.clRollRate) * 2 * flow * rollReach) / spec.wingSpan
    const pitchPower =
      ((spec.cmElevator / -spec.cmAlpha) * spec.clAlpha * pressure * pitchReach) / (sim.mass * 9.81)
    const bank = clamp(turnTo(track, target) * 1.2, -AUTOPILOT_BANK, AUTOPILOT_BANK)
    // Roll toward the target bank within about a second. A slow sum trims out a steady roll,
    // such as the pull of the good engine after an engine failure.
    // Only a small, lasting error counts, not the roll into a turn
    const steady = clamp(bank - sim.bank, -0.05, 0.05)
    this.rollTrim = clamp(this.rollTrim + steady * ROLL_TRIM * dt, -0.5, 0.5)
    c.roll = clamp(
      ((bank - sim.bank) / 1.2 + sim.angularVelocity.z * 0.4) / rollPower + this.rollTrim,
      -1,
      1
    )
    const error = climb - sim.verticalSpeed
    // Ask for the extra g that closes the climb-rate error in about three seconds. A slow sum
    // trims out what is left. Heavy fly-by-wire jets answer slowly and trim themselves, so
    // for them the sum shrinks steeply with weight, or it swings them up and down.
    const heavy = spec.flyByWire ? Math.min(1, RESPONSE_MASS / sim.mass) ** 4 : 1
    const trimRate = 0.015 * heavy
    this.climbTrim = clamp(this.climbTrim + error * trimRate * dt, -0.5, 0.5)
    const extraG = error / (3 * 9.81) + this.climbTrim
    c.pitch = clamp(extraG / pitchPower - sim.angularVelocity.x * 0.8, -1, 1)
  }

  /** True while the autopilot lands the aircraft: an airliner in approach mode on the final approach. */
  private landing(sim: FlightSim, nav?: Navigator) {
    const { autopilot } = this
    return (
      autopilot.on &&
      autopilot.lateral === 'APP' &&
      autopilot.vertical === 'APP' &&
      canAutoland(sim) &&
      nav?.approach != null &&
      nav.onFinal
    )
  }

  /**
   * The autoland flare: the descent slows in step with the height for a soft touchdown, the
   * wings stay level along the runway, and the throttle closes, as in a real autoland.
   */
  private flare(dt: number, sim: FlightSim, runway: Approach, wheels: number, rollReach: number) {
    const c = this.controls
    const wanted = -Math.max(FLARE_SINK, wheels / FLARE_SECONDS)
    // Judge the descent a moment ahead, so a nose still rising does not carry it into a balloon
    const rising = this.flareSink === null ? 0 : (sim.verticalSpeed - this.flareSink) / dt
    this.flareSink = sim.verticalSpeed
    const error = wanted - (sim.verticalSpeed + rising * FLARE_AHEAD)
    // Start from the stick the approach left, then pull in proportion to the extra sink
    this.flareStick = clamp((this.flareStick ?? c.pitch) + error * FLARE_BUILD * dt, -0.3, 1)
    // Never so far nose-up that the tail or engine pods meet the runway
    const room = tailStrikePitch(sim.spec) - TAIL_MARGIN - sim.pitch
    if (room < 0) this.flareStick = Math.min(this.flareStick, 0)
    const pull = this.flareStick + error * FLARE_GAIN - sim.angularVelocity.x * FLARE_DAMPING
    c.pitch = clamp(Math.min(pull, room * 10), -0.3, 1)
    const course = (runway.end.heading * Math.PI) / 180
    const bank = clamp(turnTo(Math.atan2(sim.velocity.x, -sim.velocity.z), course), -0.05, 0.05)
    c.roll = clamp(((bank - sim.bank) * 2) / Math.max(rollReach, 0.3), -1, 1)
    if (wheels > RETARD_HEIGHT) return
    this.autothrottle.on = false
    c.throttle = approach(c.throttle, 0, dt * 0.5)
  }

  /**
   * On the runway after an autoland: the nose comes down gently, the wings stay level, and
   * the rudder steers along the centreline while the autobrake slows the aircraft.
   */
  private rollOut(sim: FlightSim, runway: Approach, nav: Navigator) {
    const c = this.controls
    c.throttle = 0
    // Hold back pressure while the nose is falling faster than a gentle rate
    c.pitch = clamp((DEROTATE_RATE - sim.angularVelocity.x) * 8, 0, 0.6)
    c.roll = clamp(-sim.bank * 3, -1, 1)
    const course = (runway.end.heading * Math.PI) / 180
    const wanted = course + clamp(-nav.guidance.across / 30, -1, 1) * 0.08
    this.rudderHold = clamp(turnTo(sim.heading, wanted) * 4, -1, 1)
    this.climbTrim = 0
  }

  /**
   * Holds the speed knob with the throttle. In a level change it sets climb power going up
   * and idle going down, and the pitch holds the speed instead.
   */
  private flyThrottle(dt: number, sim: FlightSim, lever: number) {
    const c = this.controls
    const spec = sim.spec
    const target = this.autothrottle
    const airspeed = sim.indicatedAirspeed
    const slowest = spec.stats.stallSpeed * KNOT * 1.1
    target.speed = Math.max(slowest, target.speed + lever * SPEED_RATE * dt)
    if (this.autopilot.on && this.autopilot.vertical === 'FLCH') {
      const up = this.autopilot.altitude > sim.position.y
      const climbPower =
        spec.engine.type === 'jet' ? Math.min(0.95, spec.engine.afterburnerFrom) : 1
      c.throttle = approach(c.throttle, up ? climbPower : 0, 0.3 * dt)
      this.throttleTrim = c.throttle
      return
    }
    // Speed error and acceleration set the throttle directly; a slow sum trims out the rest
    const gaining = (airspeed - this.lastAirspeed) / dt
    const error = target.speed - airspeed
    this.throttleTrim = clamp(this.throttleTrim + error * 0.02 * dt, 0, 1)
    c.throttle = clamp(this.throttleTrim + error * 0.06 - gaining * 0.3, 0, 1)
  }

  /**
   * Where the approach autopilot steers: straight to the first waypoint, then onto the
   * centreline and down the glide path.
   */
  private steerApproach(sim: FlightSim, nav: Navigator) {
    const approach = nav.approach as NonNullable<Navigator['approach']>
    const guidance = nav.guidance
    const { x, z } = sim.position
    const hold = this.autopilot.hold
    // Slow down in steps as each waypoint passes, to the approach speed at the final fix
    if (nav.active !== this.lastFix) {
      this.lastFix = nav.active
      const steps = [1.3, 1.3, 1.15, 1]
      if (this.autothrottle.on) {
        this.autothrottle.speed = sim.spec.approachSpeed * KNOT * steps[nav.active]
      }
    }
    if (!nav.onFinal) {
      const fix = approach.fixes[0]
      // Descend no lower than the first waypoint. Climb if needed to stay clear of the
      // ground, and of the hills between a flight plan's route and the approach.
      const joining = nav.plan?.approach === approach ? nav.plan.joinSafe : 0
      const required = Math.max(terrainAhead(sim) + TERRAIN_FLOOR, joining)
      const floor = Math.max(fix.altitude, guidance.pathAltitude)
      return {
        heading: Math.atan2(fix.x - x, -(fix.z - z)),
        altitude: Math.max(Math.min(hold, floor), required),
        descent: 0
      }
    }
    const course = (approach.end.heading * Math.PI) / 180
    const speed = Math.max(sim.groundSpeed, 30)
    const intercept = clamp(
      -guidance.across / (speed * INTERCEPT_TIME),
      -MAX_INTERCEPT,
      MAX_INTERCEPT
    )
    // Follow the glide path once it comes down to the held altitude, as a real one is
    // captured, and only once lined up: beside the centreline the hills can stand higher
    const established = Math.abs(guidance.across) < ESTABLISHED
    const following = established && guidance.pathAltitude < hold
    const altitude = Math.min(hold, guidance.pathAltitude)
    return {
      heading: course + intercept,
      altitude: established ? altitude : Math.max(altitude, terrainAhead(sim) + TERRAIN_FLOOR),
      descent: following ? Math.tan(approach.glide) * speed : 0
    }
  }

  /** Sets the knobs to the current heading, altitude, and speed. */
  private syncKnobs(sim: FlightSim) {
    this.autopilot.heading = sim.heading
    this.autopilot.altitude = Math.round(sim.position.y / FEET / 100) * 100 * FEET
    this.autopilot.hold = sim.position.y
    this.autopilot.verticalSpeed = 0
    // Telemetry lags a fresh placement, so read the speed from the velocity itself
    this.autothrottle.speed = sim.velocity.length()
  }

  /** Switches off the autopilot, and the autothrottle too unless `keepThrottle`. */
  private disengage(keepThrottle = false) {
    this.rollTrim = 0
    this.autopilot.on = false
    this.autopilot.lateral = 'HDG'
    this.autopilot.vertical = 'ALT'
    if (!keepThrottle) this.autothrottle.on = false
    this.climbTrim = 0
  }

  private axis(positive: string, negative: string) {
    return (this.held.has(positive) ? 1 : 0) - (this.held.has(negative) ? 1 : 0)
  }

  /** Share of full control rate: small for a tap, building to full while the key is held. */
  private ramp(positive: string, negative: string) {
    const time = Math.max(this.held.get(positive) ?? 0, this.held.get(negative) ?? 0)
    return Math.min(1, TAP_SHARE + ((1 - TAP_SHARE) * time) / RAMP_SECONDS)
  }

  /** Knobs turn faster the longer a key is held, up to four times. */
  private boost(positive: string, negative: string) {
    const time = Math.max(this.held.get(positive) ?? 0, this.held.get(negative) ?? 0)
    return Math.min(4, 1 + time * 1.5)
  }

  private deflect(
    value: number,
    target: number,
    dt: number,
    rate: number,
    positive: string,
    negative: string
  ) {
    if (target === 0) return approach(value, 0, CENTER_RATE * dt)
    return approach(value, target, rate * this.ramp(positive, negative) * dt)
  }
}

/**
 * Highest ground under the next 40 seconds of the flight path, and a little to each side,
 * so the autopilot climbs before a hill rather than once it is underneath.
 */
function terrainAhead(sim: FlightSim) {
  const { position, velocity } = sim
  const speed = Math.max(Math.hypot(velocity.x, velocity.z), 1)
  const sideX = (-velocity.z / speed) * 500
  const sideZ = (velocity.x / speed) * 500
  let highest = 0
  for (let t = 0; t <= 40; t += 5) {
    const x = position.x + velocity.x * t
    const z = position.z + velocity.z * t
    highest = Math.max(
      highest,
      heightAt(x, z),
      heightAt(x + sideX, z + sideZ),
      heightAt(x - sideX, z - sideZ)
    )
  }
  return highest
}

const FLIGHT_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyS',
  'KeyA',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyF',
  'KeyV',
  'KeyG',
  'KeyB',
  'KeyR',
  'KeyP',
  'KeyO',
  'KeyU',
  'KeyI',
  ...ENGINE_KEYS,
  'KeyL',
  'KeyZ',
  'KeyX',
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyY',
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Period',
  'Minus',
  'Space'
])
