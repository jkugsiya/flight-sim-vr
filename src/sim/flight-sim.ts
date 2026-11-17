import { Quaternion, Vector3 } from 'three'
import {
  type AircraftSpec,
  engineArms,
  GRAVITY,
  KNOT,
  type PistonEngine,
  ROLLING_FRICTION,
  type RotorSpec,
  SEA_LEVEL_DENSITY,
  speedOfSound
} from './aircraft'

export type Surface = 'runway' | 'grass' | 'water'

/** Terrain queries the flight model needs. Heights are metres above sea level. */
export type Ground = {
  heightAt: (x: number, z: number) => number
  surfaceAt: (x: number, z: number) => Surface
}

/** Cockpit lever and switch positions. */
export type Controls = {
  /** -1 to 1, positive pulls the nose up. */
  pitch: number
  /** -1 to 1, positive rolls right. */
  roll: number
  /** -1 to 1, positive yaws right. Also steers the nose wheel. */
  yaw: number
  throttle: number
  /** Both main wheel brakes, 0 to 1. `brakeLeft` and `brakeRight` add one side for turning. */
  brake: number
  brakeLeft: number
  brakeRight: number
  parkingBrake: boolean
  /** Electrical power from the battery. Running engines power the aircraft without it. */
  battery: boolean
  /** Fuel feed to the engines: fuel pumps, or the fuel selector on a light aircraft. */
  fuelPumps: boolean
  /** Flap lever detent, 0 (up) to the aircraft's last flap position (full). */
  flapNotch: number
  gearDown: boolean
  speedBrake: boolean
  /** Reverse thrust. It works in the air too, where it slows the aircraft hard. */
  reverse: boolean
  /** -1 to 1, positive trims the nose up. */
  trim: number
  /** Pumps fuel overboard, on aircraft that can, down to a landing fuel load. */
  fuelDump: boolean
  /** Master switch for each engine, numbered from the left wingtip. */
  engineSwitches: boolean[]
  /**
   * A piston engine's real controls. Without them the engine starts from its switch alone,
   * as on the desktop; with them it needs fuel, a rich mixture, the magnetos, the starter,
   * and a prime when cold.
   */
  procedures?: Procedures
}

export type Magnetos = 'off' | 'right' | 'left' | 'both' | 'start'

/** Piston engine and electrical controls, for aircraft flown by their real procedures. */
export type Procedures = {
  /** 0 is idle cutoff, 1 full rich. */
  mixture: number
  /** The ignition key. START turns the starter while held. */
  magnetos: Magnetos
  fuelSelector: 'off' | 'left' | 'both' | 'right'
  /** The auxiliary fuel pump, which primes the engine before a cold start. */
  auxPump: boolean
  alternator: boolean
  avionics: boolean
}

/** Controls for an aircraft shut down cold, or ready to fly with the engine running. */
export function procedureState(running: boolean): Procedures {
  return {
    mixture: running ? 1 : 0,
    magnetos: running ? 'both' : 'off',
    fuelSelector: 'both',
    auxPump: false,
    alternator: running,
    avionics: running
  }
}

/** Mixture below this starves the engine of fuel. */
export const MIXTURE_CUTOFF = 0.08

/**
 * The mixture setting that gives the most power at a height in metres. Full rich is best at
 * sea level; the thinner air high up needs less fuel.
 */
export const bestMixture = (altitude: number) => 1 - 0.4 * Math.min(1, Math.max(0, altitude) / 3000)

/** One engine's state. `starting` counts the seconds its starter has turned it. */
export type EngineState = {
  running: boolean
  starting: number
  power: number
  rpm: number
  /** A failed engine stops and will not restart for the rest of the flight. */
  failed: boolean
  /** Burning, until the engine is shut down and its fire bottle discharged. */
  fire: boolean
}

export type CrashReason =
  | 'terrain'
  | 'water'
  | 'hard-landing'
  | 'gear-up'
  | 'gear-collapse'
  | 'overspeed'
  | 'missile'
  | 'tree'
  | 'building'
  | 'balloon'
  | 'boat'
  | 'traffic'

const UP = new Vector3(0, 1, 0)
const FORWARD = new Vector3(0, 0, -1)
const RIGHT = new Vector3(1, 0, 0)
// Past this share of its never-exceed speed the airframe strains, and breaks up after
// OVERSPEED_STRAIN seconds there. Past the second share it breaks up at once.
// A ditching holds together below this sink rate in m/s and bank in radians, and below this
// share of the approach speed. The water then slows the aircraft at this rate per second.
const DITCH_SINK = 3.5
const DITCH_BANK = 0.2
const DITCH_SPEED = 1.35
const DITCH_DRAG = 0.6
// A belly landing holds together below this sink rate in m/s and bank in radians. The
// airframe then scrapes to a stop at this deceleration in m/s².
const BELLY_SINK = 3
const BELLY_BANK = 0.15
const BELLY_FRICTION = 3.5
const STRAIN_MARGIN = 1.08
const BREAKUP_MARGIN = 1.25
const OVERSPEED_STRAIN = 8
// Knots past a flap or gear limit before strain builds, and the strain that breaks them
const LIMIT_MARGIN = 5
const STRAIN_LIMIT = 3
// Seconds engines keep running after the fuel feed is cut
const FUEL_LINE_SECONDS = 20
// Engine power share above which the propeller no longer windmills
const WINDMILL_POWER = 0.3
// Seconds of fuel pump with a rich mixture that prime a cold engine, and that flood it
const PRIME_NEEDED = 1.5
const FLOODED = 8
// Seconds after shutdown an engine stays warm enough to start without a prime
const WARM_SECONDS = 600
// Seconds an engine that fired on its prime runs at idle cutoff, for the mixture to come in
const FIRING_SECONDS = 3
// Throttle open this far while cranking at idle cutoff clears a flooded engine
const CLEARING_THROTTLE = 0.8
// Seconds a running engine stumbles on, leaned too far to make power, before it dies
const LEAN_SECONDS = 1.5
// Stalled-wing coupling saturates at these roll and yaw rates, which bounds the spin
const SPIN_RATE_LIMIT = 0.1
// Shares of a full tank: the fuel the aircraft's listed mass includes, the load for a start
// on the ground, and where dumping stops
const LANDING_FUEL = 0.3
const DEPARTURE_FUEL = 0.5
export const DUMP_FLOOR = 0.2
// Seconds to dump a full tank
const DUMP_SECONDS = 300
// How much harder than the main wheels the nose wheel can meet the runway
const NOSE_WHEEL_MARGIN = 1.5
// How much more fuel a jet burns per newton of thrust at Mach 1 than standing still
const TSFC_RISE = 0.6
// Brake pressure the autobrake applies on the landing roll, gentle enough to keep the nose up
const AUTOBRAKE = 0.5
// Wheel height in metres, 50 ft, below which fly-by-wire hands the flare to the pilot
const FLARE_LAW_HEIGHT = 15

// Helicopter rotor. The downwash is never slower than MIN_FLOW m/s through the disc, and
// follows the thrust in INFLOW_LAG seconds. Ground cushion fades past HOVER_INFLOW m/s of
// forward speed and adds at most MAX_CUSHION. Induced power carries INDUCED_LOSS for tip
// losses; the tail rotor takes TAIL_SHARE of the main rotor's power, the gearbox and
// generators ACCESSORY_POWER watts.
const MIN_FLOW = 1
const INFLOW_LAG = 0.15
const HOVER_INFLOW = 10
const MAX_CUSHION = 1.2
const INDUCED_LOSS = 1.15
const TAIL_SHARE = 0.08
const ACCESSORY_POWER = 30_000
// Rotor speed as a share of 100%: the most it reaches in a glide, how fast the governor
// spins it up per second after a start, and where the low rotor warning sounds
const MAX_ROTOR_SPEED = 1.15
const SPIN_UP_RATE = 0.08
const LOW_ROTOR = 0.92
// Stability system. Between these airspeeds in m/s it turns from hover holds to forward
// flight: heading hold gives way to balanced turns, drift hold to wings level.
const CRUISE_FROM = 12
const CRUISE_TO = 22
// Hands off: m/s² of acceleration per m/s of speed error, up to MAX_HOLD_ACCEL, and the
// steepest bank in radians the cyclic asks for in a hover
const SPEED_GAIN = 0.3
const MAX_HOLD_ACCEL = 2
const HOVER_BANK = 0.3
// Turn rate in rad/s per radian off the held heading, and per unit of sideslip
const HEADING_GAIN = 2
const SLIP_GAIN = 1.5
// Attitude loops: rad/s of rate per radian of error, up to the most rate asked for; rate
// loops: rad/s² per rad/s of error, up to the most the rotor and tail rotor can give
const PITCH_GAIN = 2
const ROLL_GAIN = 3
const MAX_PITCH_RATE = 0.5
const MAX_ROLL_RATE = 1
const PITCH_RATE_GAIN = 5
const ROLL_RATE_GAIN = 8
const YAW_RATE_GAIN = 4
const MAX_PITCH_ACCEL = 1.5
const MAX_ROLL_ACCEL = 4
const MAX_YAW_ACCEL = 2
// Below NEAR_GROUND metres of wheel height the nose goes no lower than NEAR_GROUND_PITCH
// radians, reaching full travel at that height
const NEAR_GROUND = 10
const NEAR_GROUND_PITCH = 0.03
// On the wheels a full cyclic asks for this rate in rad/s
const GROUND_RATE = 0.3

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
/** Smallest signed angle from `from` to `to` in radians, positive clockwise. */
const turnAngle = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
/**
 * Share of standing thrust a jet keeps at a Mach number. Turbofans lose thrust up to Mach 1.
 * Engines whose lapse is negative gain from ram air in the intake, up to Mach 2.
 */
const speedFactor = (lapse: number, mach: number) => 1 - lapse * Math.min(lapse < 0 ? 2 : 1, mach)
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
const approach = (value: number, target: number, step: number) =>
  value < target ? Math.min(target, value + step) : Math.max(target, value - step)
/** Height of the aircraft's origin above the ground as it rests on its lowest underside part. */
const bellyHeight = (spec: AircraftSpec) =>
  spec.hullPoints.reduce(
    (lowest, point) => (point.underside ? Math.max(lowest, -point.position.y) : lowest),
    0
  ) || spec.restHeight

export const airDensity = (altitude: number) => SEA_LEVEL_DENSITY * Math.exp(-altitude / 9000)

/**
 * Share of a piston engine's rated power the air allows: all of it up to the supercharger's
 * critical altitude, then falling with the density above it.
 */
const pistonAir = (engine: PistonEngine, density: number) =>
  Math.min(1, density / airDensity(engine.criticalAltitude ?? 0))

// Scratch objects, reused every step to avoid allocations
const qInv = new Quaternion()
const qStep = new Quaternion()
const vBody = new Vector3()
const force = new Vector3()
const torque = new Vector3()
const worldForce = new Vector3()
const contactForce = new Vector3()
const arm = new Vector3()
const pointVelocity = new Vector3()
const wheelForward = new Vector3()
const temp = new Vector3()
const level = new Quaternion()

/**
 * Six-degree-of-freedom rigid body flight model.
 * Call `step` with a small fixed-size time step, then read the telemetry fields.
 */
export class FlightSim {
  readonly position = new Vector3()
  readonly velocity = new Vector3()
  readonly orientation = new Quaternion()
  /** Body-frame spin: x pitches the nose up, y yaws left, z rolls left. */
  readonly angularVelocity = new Vector3()

  /** The aircraft type being flown. Change it with `setAircraft`. */
  spec: AircraftSpec
  /** 0 (up) to 1 (full). Lags the flap lever. */
  flapPosition = 0
  /** 0 (retracted) to 1 (down and locked). */
  gearPosition = 1
  /** 0 (stowed) to 1 (fully open). */
  speedBrakePosition = 0
  /** 0 (forward thrust) to 1 (full reverse). */
  reversePosition = 0
  /** 0 to 1 share of full engine power across all engines, lags the throttle. */
  enginePower = 0
  /** How many of the aircraft's engines are running. */
  enginesRunning = 0
  /** Each engine from the left wingtip to the right. */
  engines: EngineState[] = []
  /** True while spoilers and brakes are slowing the aircraft after touchdown or a rejected takeoff. */
  rollout = false
  /** Remaining fuel in kg. */
  fuel = 0
  crash: CrashReason | null = null
  /** Damage from flying too fast: jammed flaps stay where they are, stuck gear stays down. */
  flapsJammed = false
  gearJammed = false
  /** True while the flaps or gear are out above their speed limit. */
  flapOverspeed = false
  gearOverspeed = false
  /** Electrical power for the displays and starters: battery, or a running engine. */
  powered = false
  /** How far each of the aircraft's contact points is pressed into the ground, in metres. */
  compression: number[] = []

  // Telemetry, refreshed on every step
  onGround = false
  indicatedAirspeed = 0
  trueAirspeed = 0
  /** Mach number: true airspeed over the speed of sound at this altitude. */
  mach = 0
  groundSpeed = 0
  verticalSpeed = 0
  altitudeAgl = 0
  /** Radians clockwise from north, 0 to 2π. North is -Z, east is +X. */
  heading = 0
  pitch = 0
  /** Positive with the right wing down. */
  bank = 0
  /** Heading change in rad/s, positive turning right. */
  turnRate = 0
  /** Slip ball angle in radians, positive when the ball sits right of centre. */
  slip = 0
  gLoad = 1
  /** 0 with smooth airflow over the wing, 1 fully stalled. */
  stall = 0
  stallWarning = false
  /** True while a jet's afterburner is lit. */
  afterburner = false
  /** Average engine speed in the units of the power gauge: rpm, percent for a jet, or torque. */
  rpm = 0
  /** Helicopters: main rotor speed as a share of 100%, and its blade angle in radians. */
  rotorSpeed = 0
  rotorAngle = 0

  /** Distance of each engine from the centreline, negative on the left. */
  private arms: number[] = []
  // Seconds of strain from overspeed, and of running with the fuel feed off
  private flapStrain = 0
  private gearStrain = 0
  private overspeedStrain = 0
  private starved = 0
  /** Seconds of priming fuel in the cylinders of a stopped piston engine. */
  prime = 0
  /** Seconds since the engine last ran. */
  private sinceRun = Number.POSITIVE_INFINITY
  /** Seconds left for an engine running on its prime alone, at idle cutoff. */
  private firing = 0
  /** Seconds the running engine has been too lean to make power. */
  private starving = 0

  /** True once at least one engine has started. */
  get engineRunning() {
    return this.enginesRunning > 0
  }

  /** Skips the start sequence, as when a flight begins in the air. */
  startAllEngines() {
    for (const engine of this.engines) {
      engine.running = true
      engine.starting = 0
    }
    this.enginesRunning = this.engines.length
  }
  /** How much of the upper wing surface has lost its airflow, remembered between steps. */
  private stalledFlow = 0
  /** Rudder, -1 to 1, that cancels the yaw from engines pushing unevenly, as after a failure. */
  balancingRudder = 0
  /** True while fuel streams overboard. */
  dumping = false
  /** Afloat after a gentle touch on the sea. */
  ditched = false
  /** Sliding on its belly, or stopped on it, after a gentle wheels-up touchdown on land. */
  bellied = false
  /** Gear stuck in its bay: it stays up whatever the lever says. Missions set it. */
  gearStuck = false
  /** Without hydraulics the flaps, speed brake, spoilers, and autobrake stop working. */
  hydraulicsFailed = false
  /** Fuel lost overboard through a leak, in kg/s. */
  fuelLeak = 0

  /**
   * Highest indicated airspeed in m/s allowed here: the never-exceed speed, or lower high up,
   * where the Mach limit is reached first.
   */
  get speedLimit() {
    const { neverExceedSpeed, maxMach } = this.spec
    if (maxMach === undefined) return neverExceedSpeed
    const { y } = this.position
    const atMach = maxMach * speedOfSound(y) * Math.sqrt(airDensity(y) / SEA_LEVEL_DENSITY)
    return Math.min(neverExceedSpeed, atMach)
  }

  /** Kilograms: the aircraft with its current fuel. */
  get mass() {
    return this.spec.mass + this.fuel - this.spec.fuelCapacity * LANDING_FUEL
  }
  /** Helicopters: downwash through the rotor in m/s, and the heading the stability system holds. */
  private inflow = 0
  private heldHeading = 0
  /** Helicopters: share of the running engines' power the rotor governor asks for. */
  private rotorDemand = 0
  /** Fly-by-wire trim memorised above the flare height, held for the flare. Null after takeoff. */
  private flareTrim: number | null = null
  private readonly ground: Ground

  constructor(ground: Ground, spec: AircraftSpec) {
    this.ground = ground
    this.spec = spec
    this.setAircraft(spec)
  }

  /** Swaps the aircraft type. Place it with `placeOnGround` or `placeInAir` afterwards. */
  setAircraft(spec: AircraftSpec) {
    this.spec = spec
    this.compression = spec.contactPoints.map(() => 0)
    this.fuel = spec.fuelCapacity
    this.arms = engineArms(spec)
    this.engines = this.arms.map(() => ({
      running: false,
      starting: 0,
      power: 0,
      rpm: 0,
      failed: false,
      fire: false
    }))
  }

  /** Parks the aircraft on its wheels with the engine idling. Heading is in radians. */
  placeOnGround(x: number, z: number, heading: number) {
    this.resetState(heading)
    for (const engine of this.engines) Object.assign(engine, { running: false, power: 0, rpm: 0 })
    this.enginesRunning = 0
    this.enginePower = 0
    this.rotorSpeed = 0
    this.position.set(x, this.ground.heightAt(x, z) + this.spec.restHeight, z)
    this.sitOnTailWheel()
    this.fuel = this.spec.fuelCapacity * DEPARTURE_FUEL
    this.gearPosition = 1
    this.refreshAttitude()
    this.refreshAir()
  }

  /**
   * A tail-dragger rests nose-high, on its main wheels and the tail wheel behind them, so it
   * starts in that attitude instead of dropping onto its tail.
   */
  private sitOnTailWheel() {
    const [tail, main] = this.spec.contactPoints
    if (!tail || !main || tail.position.z <= main.position.z) return
    const { y: tailY, z: tailZ } = tail.position
    const { y: mainY, z: mainZ } = main.position
    // Nose-up pitch that brings both wheels to the same height
    const pitch = Math.atan2(tailY - mainY, tailZ - mainZ)
    level.setFromAxisAngle(RIGHT, pitch)
    this.orientation.multiply(level)
    // Lift the body so the main wheels rest where they did when level
    const dropped = mainY * Math.cos(pitch) - mainZ * Math.sin(pitch)
    this.position.y += mainY - dropped
  }

  /** Starts in level flight with the gear up. Heading is in radians, speed in m/s. */
  placeInAir(x: number, altitude: number, z: number, heading: number, speed: number) {
    this.resetState(heading)
    this.startAllEngines()
    this.powered = true
    // In the air partway through a flight, with the fuel the listed mass includes
    this.fuel = this.spec.fuelCapacity * LANDING_FUEL
    this.position.set(x, altitude, z)
    this.velocity.set(Math.sin(heading) * speed, 0, -Math.cos(heading) * speed)
    this.gearPosition = this.spec.retractableGear ? 0 : 1
    for (const engine of this.engines) engine.power = 0.6
    this.enginePower = 0.6
    if (this.spec.rotor) this.rotorSpeed = 1
    this.refreshAttitude()
    this.refreshAir()
  }

  /**
   * Turns an aircraft placed in the air onto a steady descent `glide` radians below the
   * horizon at its current speed through the air, with flaps and gear already out. Returns
   * the throttle and trim that hold the descent with hands off the controls.
   */
  settleOnPath(glide: number, flapNotch: number, gearDown: boolean, wind: Vector3) {
    const A = this.spec
    if (A.rotor) return this.settleRotor(glide, A.rotor, wind)
    const notches = A.flapLabels.length - 1
    this.flapPosition = notches > 0 ? Math.min(flapNotch, notches) / notches : 0
    this.gearPosition = gearDown || !A.retractableGear ? 1 : 0
    const speed = this.velocity.length()
    const heading = this.heading
    const { alpha, power, throttle } = this.steadyDescent(glide, speed)
    for (const engine of this.engines) engine.power = power
    this.enginePower = power
    this.velocity
      .set(
        Math.sin(heading) * Math.cos(glide) * speed,
        -Math.sin(glide) * speed,
        -Math.cos(heading) * Math.cos(glide) * speed
      )
      .add(wind)
    this.orientation
      .setFromAxisAngle(UP, -heading)
      .multiply(qStep.setFromAxisAngle(RIGHT, alpha - glide))
    this.refreshAttitude()
    this.refreshAir()
    // Fly-by-wire trims itself, so only cable-controlled aircraft need the trim wheel set
    const trim = A.flyByWire ? 0 : -(A.cm0 + A.cmAlpha * Math.sin(alpha)) / A.cmTrim
    return { throttle, trim: clamp(trim, -1, 1) }
  }

  /**
   * A helicopter's version of `settleOnPath`: nose down against the drag, the rotor's
   * downwash settled, and the collective that holds the descent. The trim holds the speed.
   */
  private settleRotor(glide: number, rotor: RotorSpec, wind: Vector3) {
    const speed = this.velocity.length()
    const heading = this.heading
    const density = airDensity(this.position.y)
    const drag = 0.5 * density * speed * speed * rotor.drag.front
    const weight = this.mass * GRAVITY
    const pitch = -Math.atan(drag / weight)
    this.rotorSpeed = 1
    this.heldHeading = heading
    this.velocity
      .set(
        Math.sin(heading) * Math.cos(glide) * speed,
        -Math.sin(glide) * speed,
        -Math.cos(heading) * Math.cos(glide) * speed
      )
      .add(wind)
    this.orientation.setFromAxisAngle(UP, -heading).multiply(qStep.setFromAxisAngle(RIGHT, pitch))
    this.angularVelocity.set(0, 0, 0)
    this.refreshAttitude()
    this.refreshAir()
    // Air through the disc, and the downwash and blade pitch that carry the weight with it
    vBody.copy(this.velocity).sub(wind).applyQuaternion(qInv.copy(this.orientation).invert())
    const radius = rotor.radius
    const rhoA = density * Math.PI * radius * radius
    const tip = rotor.speed * radius
    const across = Math.hypot(vBody.x, vBody.z)
    const mu = across / tip
    const thrust = Math.hypot(weight, drag)
    let inflow = Math.sqrt(thrust / (2 * rhoA))
    for (let i = 0; i < 50; i++) {
      const flow = Math.max(Math.hypot(across, inflow + vBody.y), MIN_FLOW)
      inflow += (thrust / (2 * rhoA * flow) - inflow) * 0.3
    }
    this.inflow = inflow
    const lift = (rotor.blades * rotor.chord * rotor.liftSlope) / (2 * Math.PI * radius)
    const lambda = (inflow + vBody.y) / tip
    const ct = thrust / (rhoA * tip * tip)
    const blade = ((ct / lift + lambda / 2) * 3) / (1 + 1.5 * mu * mu)
    const [low, high] = rotor.collective
    for (const engine of this.engines) engine.power = 0.5
    this.enginePower = 0.5
    const trim = -(speed / (rotor.trimSpeed * KNOT))
    return { throttle: clamp((blade - low) / (high - low), 0, 1), trim: clamp(trim, -1, 0) }
  }

  /** Throttle, 0 to 1, that holds a steady descent `glide` radians down at the current airspeed. */
  throttleFor(glide: number) {
    return this.steadyDescent(glide, this.trueAirspeed).throttle
  }

  /**
   * Wing angle, engine power, and throttle for a steady descent at `speed` m/s through the air,
   * with the flaps and gear where they are now.
   */
  private steadyDescent(glide: number, speed: number) {
    const A = this.spec
    const density = airDensity(this.position.y)
    const qS = 0.5 * density * Math.max(speed, 1) ** 2 * A.wingArea
    const weight = this.mass * GRAVITY
    // The wing angle that carries the weight, and the drag that comes with it
    const cl = (weight * Math.cos(glide)) / qS
    const alpha = (cl - A.cl0 - this.flapPosition * A.flapLift) / A.clAlpha
    const cd =
      A.cd0 +
      this.gearPosition * A.gearDrag +
      this.flapPosition * A.flapDrag +
      A.inducedDrag * cl * cl
    const thrust = Math.max(0, qS * cd - weight * Math.sin(glide))
    const power = this.powerFor(thrust, speed, density)
    const idle = A.engine.type === 'piston' ? A.engine.idlePower : 0
    return { alpha, power, throttle: clamp((power - idle) / (1 - idle), 0, 1) }
  }

  /** Engine power, 0 to 1, that gives `thrust` newtons from all engines at this speed. */
  private powerFor(thrust: number, speed: number, density: number) {
    const engine = this.spec.engine
    const thin = density / SEA_LEVEL_DENSITY
    if (engine.type === 'piston') {
      const full =
        (engine.shaftPower * engine.propEfficiency * pistonAir(engine, density)) /
        Math.hypot(speed, engine.staticThrustSpeed)
      return clamp(thrust / full, 0, 1)
    }
    if (engine.type === 'turboshaft') return 0
    // An engine with no thrust at all, as on a glider, has no power to set
    const span = engine.militaryThrust - engine.idleThrust
    if (span <= 0) return 0
    const lapse = speedFactor(engine.speedLapse, speed / speedOfSound(this.position.y))
    const dry = thrust / (lapse * thin ** 0.7)
    const share = (dry - engine.idleThrust) / span
    return clamp(share * engine.afterburnerFrom, 0, engine.afterburnerFrom)
  }

  /**
   * Sets height above ground and airspeeds for a fresh placement, so nothing reads the
   * previous flight's values before the first step.
   */
  private refreshAir() {
    const { x, y, z } = this.position
    this.altitudeAgl = y - Math.max(this.ground.heightAt(x, z), 0)
    this.trueAirspeed = this.velocity.length()
    this.indicatedAirspeed = this.trueAirspeed * Math.sqrt(airDensity(y) / SEA_LEVEL_DENSITY)
    this.mach = this.trueAirspeed / speedOfSound(y)
  }

  /** Advances the simulation by `dt` seconds. `wind` is the air mass velocity in m/s. */
  step(dt: number, controls: Controls, wind: Vector3) {
    if (this.crash) return
    if (this.ditched) {
      this.float(dt)
      return
    }
    if (this.bellied) {
      this.slide(dt)
      return
    }
    const A = this.spec
    this.updateSystems(dt, controls)

    const q = this.orientation
    qInv.copy(q).invert()

    // Airflow relative to the aircraft, in body axes
    vBody.copy(this.velocity).sub(wind).applyQuaternion(qInv)
    const airspeed = vBody.length()
    const density = airDensity(this.position.y)
    const groundHeight = Math.max(this.ground.heightAt(this.position.x, this.position.z), 0)
    const agl = this.position.y - groundHeight
    this.mach = airspeed / speedOfSound(this.position.y)

    force.set(0, 0, 0)
    if (A.rotor) this.rotorForces(dt, controls, A.rotor, density, agl)
    else this.wingForces(controls, airspeed, density, agl)

    worldForce.copy(force).applyQuaternion(q)
    this.applyGroundContact(controls, worldForce, torque)
    if (this.crash) return

    // Specific force (everything except gravity) drives the g meter and slip ball
    const mass = this.mass
    temp.copy(worldForce).applyQuaternion(qInv).divideScalar(mass)
    this.gLoad = temp.y / GRAVITY
    this.slip = Math.atan2(-temp.x, Math.max(temp.y, 0.2 * GRAVITY))

    // Semi-implicit Euler integration
    worldForce.y -= mass * GRAVITY
    this.velocity.addScaledVector(worldForce, dt / mass)
    this.position.addScaledVector(this.velocity, dt)

    const w = this.angularVelocity
    const spinX = A.inertiaPitch * w.x
    const spinY = A.inertiaYaw * w.y
    const spinZ = A.inertiaRoll * w.z
    w.set(
      w.x + ((torque.x - (w.y * spinZ - w.z * spinY)) / A.inertiaPitch) * dt,
      w.y + ((torque.y - (w.z * spinX - w.x * spinZ)) / A.inertiaYaw) * dt,
      w.z + ((torque.z - (w.x * spinY - w.y * spinX)) / A.inertiaRoll) * dt
    )
    qStep.set(w.x * 0.5 * dt, w.y * 0.5 * dt, w.z * 0.5 * dt, 0).premultiply(q)
    q.set(q.x + qStep.x, q.y + qStep.y, q.z + qStep.z, q.w + qStep.w).normalize()

    this.trueAirspeed = airspeed
    this.indicatedAirspeed = airspeed * Math.sqrt(density / SEA_LEVEL_DENSITY)
    this.altitudeAgl = agl
    this.refreshAttitude()
    // Strain builds while far past the never-exceed speed and eases once back below it
    const over = this.indicatedAirspeed / A.neverExceedSpeed
    this.overspeedStrain =
      over > STRAIN_MARGIN ? this.overspeedStrain + dt : Math.max(0, this.overspeedStrain - dt)
    if (over > BREAKUP_MARGIN || this.overspeedStrain > OVERSPEED_STRAIN) this.crash = 'overspeed'
  }

  /**
   * Wing, tail, and engine forces of a fixed-wing aircraft, in body axes, into `force` and
   * `torque`. Also refreshes the stall and engine speed readings.
   */
  private wingForces(controls: Controls, airspeed: number, density: number, agl: number) {
    const A = this.spec
    const alpha = Math.atan2(-vBody.y, -vBody.z)
    const sinBeta = airspeed > 0.5 ? clamp(vBody.x / airspeed, -1, 1) : 0
    const beta = Math.asin(sinBeta)
    const qS = 0.5 * density * airspeed * airspeed * A.wingArea
    // Lift and drag blend from attached flow to a flat plate as the wing stalls
    const flap = this.flapPosition
    const sinAlpha = Math.sin(alpha)
    const stallAlpha = A.stallAlpha - flap * A.flapStallShift
    // Airflow that has let go of the wing does not reattach until the nose comes well down
    this.stalledFlow = clamp(
      this.stalledFlow,
      sigmoid((alpha - stallAlpha) * A.stallSharpness),
      sigmoid((alpha - stallAlpha + A.stallHysteresis) * A.stallSharpness)
    )
    const separation = Math.max(
      this.stalledFlow,
      sigmoid((-alpha - A.negativeStallAlpha) * A.stallSharpness)
    )
    // Open spoilers spoil part of the wing's lift as well as adding drag
    const clAttached =
      (A.cl0 + flap * A.flapLift + A.clAlpha * alpha) * (1 - A.liftDump * this.speedBrakePosition)
    const cl = lerp(clAttached, 2 * sinAlpha * Math.cos(alpha), separation)

    // Flying within one wingspan of the ground cuts induced drag
    const heightRatio = (16 * Math.max(agl, 0)) / A.wingSpan
    const groundEffect = (heightRatio * heightRatio) / (1 + heightRatio * heightRatio)
    const mach = this.mach
    const cd =
      A.cd0 +
      this.gearPosition * A.gearDrag * (this.gearJammed ? 1.6 : 1) +
      flap * A.flapDrag +
      this.speedBrakePosition * A.speedBrakeDrag +
      A.waveDrag * smoothstep(A.dragRiseMach ?? 0.85, 1.1, mach) +
      A.sideDrag * sinBeta * sinBeta +
      lerp(
        A.inducedDrag * clAttached * clAttached * groundEffect,
        2 * sinAlpha * sinAlpha,
        separation
      )

    force.set(0, 0, 0)
    if (airspeed > 0.01) {
      const vx = vBody.x / airspeed
      const vy = vBody.y / airspeed
      const vz = vBody.z / airspeed
      // Lift acts at right angles to the airflow, in the aircraft's plane of symmetry
      const liftNorm = Math.hypot(vy, vz)
      if (liftNorm > 1e-6) {
        force.y += (qS * cl * -vz) / liftNorm
        force.z += (qS * cl * vy) / liftNorm
      }
      force.x += -qS * cd * vx + qS * A.sideForce * sinBeta
      force.y += -qS * cd * vy
      force.z += -qS * cd * vz
    }

    // Reverse thrust turns part of the engine's push backward to slow down or back up.
    // Engines off the centreline twist the nose away from the one pushing harder.
    const reverser = 1 - this.reversePosition * (1 + A.reverseThrust)
    const forwardSpeed = Math.max(-vBody.z, 0)
    let thrust = 0
    let thrustYaw = 0
    for (let i = 0; i < this.engines.length; i++) {
      const push =
        (this.thrust(forwardSpeed, density, this.engines[i]) * reverser) / this.engines.length
      thrust += push
      thrustYaw += push * this.arms[i]
    }
    force.z -= thrust

    // Fly-by-wire: the computers trim for level flight and guard the edges of the envelope
    let stick = controls.pitch
    let wheel = controls.roll
    let trimMoment = A.cmTrim * controls.trim
    if (A.flyByWire && !this.onGround && airspeed > 25) {
      const limit = stallAlpha - A.flyByWire.alphaMargin
      // Coming in to land, the computers stop holding the flight path at 50 ft and keep the
      // trim they had, so the pilot flares by pulling back as in any other aircraft
      const flaring = this.gearPosition > 0.5 && agl - A.restHeight < FLARE_LAW_HEIGHT
      if (flaring && this.flareTrim !== null) trimMoment = this.flareTrim
      else {
        // Trim holds 1 g, or the extra a turn needs up to 33° of bank
        const load = 1 / Math.cos(clamp(this.bank, -0.58, 0.58))
        const liftNeeded = (load * this.mass * GRAVITY) / Math.max(qS, 1)
        const alphaNeeded = clamp((liftNeeded - A.cl0 - flap * A.flapLift) / A.clAlpha, -0.1, limit)
        trimMoment = clamp(-(A.cm0 + A.cmAlpha * Math.sin(alphaNeeded)), -A.cmTrim, A.cmTrim * 1.6)
        if (!flaring) this.flareTrim = trimMoment
      }
      // Alpha protection: the stick cannot pull the wing past its limit
      stick = Math.min(stick, (limit - alpha) * 10 - this.angularVelocity.x * 2)
      const { maxPitch } = A.flyByWire
      if (maxPitch !== undefined) {
        stick = Math.min(stick, (maxPitch - this.pitch) * 5 - this.angularVelocity.x * 2)
      }
      const overBank = Math.abs(this.bank) - A.flyByWire.maxBank
      if (overBank > 0) wheel = clamp(wheel - Math.sign(this.bank) * overBank * 5, -1, 1)
    }

    // Moments, using roll right / pitch up / yaw right as positive
    const w = this.angularVelocity
    const rateSpeed = 2 * Math.max(airspeed, 1)
    const rollRate = (-w.z * A.wingSpan) / rateSpeed
    const pitchRate = (w.x * A.chord) / rateSpeed
    const yawRate = (-w.y * A.wingSpan) / rateSpeed
    // A stalled wing spins itself up: yaw feeds roll and roll feeds yaw.
    // Ailerons and roll damping fade, so opposite rudder and a lower nose are the way out.
    const spinRoll = clamp(rollRate, -SPIN_RATE_LIMIT, SPIN_RATE_LIMIT)
    const spinYaw = clamp(yawRate, -SPIN_RATE_LIMIT, SPIN_RATE_LIMIT)
    const rollMoment =
      qS *
      A.wingSpan *
      (A.clBeta * beta * (1 + 2 * separation) +
        A.clRollRate * rollRate * (1 - 0.75 * separation) +
        A.clYawRate * yawRate +
        0.5 * separation * spinYaw +
        A.clAileron * wheel * (1 - 0.9 * separation) -
        A.stallRollBias * separation * (0.4 + this.enginePower))
    const pitchMoment =
      qS *
      A.chord *
      (A.cm0 +
        A.cmAlpha * sinAlpha +
        A.cmPitchRate * pitchRate +
        A.cmElevator * stick * (1 - 0.35 * separation) +
        trimMoment +
        A.cmStall * separation * Math.sign(alpha))
    const propYaw =
      A.engine.type === 'piston'
        ? A.engine.propYawArm *
          Math.abs(thrust) *
          clamp(1 - airspeed / A.engine.propYawFadeSpeed, 0, 1)
        : 0
    const yawMoment =
      qS *
        A.wingSpan *
        (A.cnBeta * beta * (1 - 0.5 * separation) +
          A.cnYawRate * yawRate +
          A.cnRollRate * rollRate +
          0.2 * separation * spinRoll +
          A.cnRudder * controls.yaw +
          A.cnAileron * wheel) -
      propYaw
    torque.set(pitchMoment, thrustYaw - yawMoment, -rollMoment)
    // Rudder that would cancel the engines' uneven push, for the autopilot's yaw control
    this.balancingRudder = clamp(thrustYaw / Math.max(qS * A.wingSpan * A.cnRudder, 1), -1, 1)

    this.stall = separation
    this.stallWarning =
      !this.onGround && this.indicatedAirspeed > 10 && alpha > stallAlpha - A.stallWarningMargin
    let rpm = 0
    for (const engine of this.engines) {
      engine.rpm = this.engineSpeed(forwardSpeed, engine)
      rpm += engine.rpm
    }
    this.rpm = rpm / this.engines.length
  }

  /**
   * Main rotor, tail rotor, and fuselage forces of a helicopter, in body axes, into `force`
   * and `torque`. Blade element thrust with momentum inflow gives lift that grows with
   * forward speed and near the ground, fades when sinking into the rotor's own downwash, and
   * keeps the rotor turning in a glide with the engines out. The stability system turns the
   * cyclic and pedals into attitude and turn rate targets.
   */
  private rotorForces(
    dt: number,
    controls: Controls,
    rotor: RotorSpec,
    density: number,
    agl: number
  ) {
    const A = this.spec
    const radius = rotor.radius
    const area = Math.PI * radius * radius
    const rhoA = density * area
    const omega = this.rotorSpeed * rotor.speed
    const tip = Math.max(omega * radius, 1)
    const lift = (rotor.blades * rotor.chord * rotor.liftSlope) / (2 * Math.PI * radius)
    const [low, high] = rotor.collective
    const pitch = low + (high - low) * controls.throttle
    // Air through the disc: climbing, or flying forward nose down, adds to it
    const through = vBody.y
    const across = Math.hypot(vBody.x, vBody.z)
    const mu = across / tip
    const lambda = (this.inflow + through) / tip
    const ct = lift * ((pitch / 3) * (1 + 1.5 * mu * mu) - lambda / 2)
    const thrust = Math.max(0, rhoA * tip * tip * ct)
    // The downwash follows the thrust with a short lag
    const flow = Math.max(Math.hypot(across, this.inflow + through), MIN_FLOW)
    const settled = thrust / (2 * rhoA * flow)
    this.inflow += (settled - this.inflow) * Math.min(1, dt / INFLOW_LAG)

    // Close to the ground the downwash spreads out and the rotor lifts more, until the
    // helicopter flies faster than its own downwash
    const height = Math.max(agl + rotor.hub.y, radius / 2)
    const fade = 1 / (1 + (across / HOVER_INFLOW) ** 2)
    const cushion = Math.min(MAX_CUSHION, 1 / (1 - (radius / (4 * height)) ** 2 * fade))
    force.y += thrust * cushion

    // The fuselage drags against the air from every side
    const { drag } = rotor
    const half = 0.5 * density * vBody.length()
    force.x -= half * vBody.x * drag.side
    force.y -= half * vBody.y * drag.top
    force.z -= half * vBody.z * drag.front

    // Power the rotor takes: pushing air down, plus blade drag. Sinking through the disc
    // gives power back, which is what turns the rotor in a glide with the engines out.
    const profile =
      (rhoA * tip ** 3 * lift * rotor.profileDrag * (1 + 4.65 * mu * mu)) / (4 * rotor.liftSlope)
    const main = thrust * (INDUCED_LOSS * this.inflow + through) + profile
    const needed = main + TAIL_SHARE * Math.max(main, 0) + ACCESSORY_POWER
    const available =
      A.engine.type === 'turboshaft' ? A.engine.shaftPower * this.turbineAir(density) : 0
    let delivered = 0
    for (const engine of this.engines) delivered += engine.power * available
    // The rotor speeds up or slows on the difference. The freewheel clutch lets the rotor
    // run faster than the engines, so they can never hold it back.
    const energy = rotor.inertia * rotor.speed * rotor.speed
    const share = Math.max(this.rotorSpeed, 0.05)
    this.rotorSpeed = clamp(
      this.rotorSpeed + ((delivered - needed) / (energy * share)) * dt,
      0,
      MAX_ROTOR_SPEED
    )
    this.rotorAngle = (this.rotorAngle + omega * dt) % (Math.PI * 2)
    // The governor asks the engines for the power that holds 100%, and spins the rotor up
    // gently after a start
    const spinUp = clamp((1 - this.rotorSpeed) * 2, -1, SPIN_UP_RATE)
    const wanted = needed + energy * share * spinUp
    const running = this.engines.filter(engine => engine.running).length
    this.rotorDemand = running > 0 ? clamp(wanted / (available * running), 0, 1) : 0
    // The torque gauge reads each engine's output against its sea level rating
    let torqueShare = 0
    for (const engine of this.engines) {
      engine.rpm = engine.power * this.turbineAir(density) * 100
      torqueShare += engine.rpm
    }
    this.rpm = torqueShare / this.engines.length

    this.stabilise(controls, rotor, Math.hypot(vBody.x, vBody.z), agl)
    this.balancingRudder = 0
    this.stall = 0
    this.stallWarning = !this.onGround && this.rotorSpeed < LOW_ROTOR && this.position.y > 0
  }

  /**
   * The stability system: the cyclic asks for a pitch and bank, and hands off it holds the
   * trimmed ground speed and stops any drift in a hover. The pedals ask for a turn rate,
   * and hands off they hold the heading in a hover or keep the turn balanced in forward
   * flight. Control power falls with the rotor speed.
   */
  private stabilise(controls: Controls, rotor: RotorSpec, airspeed: number, agl: number) {
    const A = this.spec
    const w = this.angularVelocity
    const authority = Math.min(1, this.rotorSpeed * this.rotorSpeed)
    const forward =
      Math.sin(this.heading) * this.velocity.x - Math.cos(this.heading) * this.velocity.z
    const side = Math.cos(this.heading) * this.velocity.x + Math.sin(this.heading) * this.velocity.z
    // Share of forward flight, where the helicopter banks to turn like an aeroplane. It
    // counts over the ground, so a hover in a strong wind still holds its heading.
    const cruising = smoothstep(CRUISE_FROM, CRUISE_TO, this.groundSpeed)

    // The rotor leans into the drag of the air flowing past, as m/s² ahead and to the
    // right, so the holds below work over the ground in any wind
    const blow = (0.5 * airDensity(this.position.y) * Math.hypot(vBody.x, vBody.z)) / this.mass
    const drag = -vBody.z * blow * rotor.drag.front
    const sideDrag = vBody.x * blow * rotor.drag.side

    // Hands off, lean back to slow toward the trimmed speed
    const trimmed = Math.max(0, -controls.trim) * rotor.trimSpeed * KNOT
    // Low down it never asks for more speed than it has, so letting go after a flare never
    // pitches the nose down. It still stops a drift backward.
    const low = agl - A.restHeight < NEAR_GROUND * 2
    const target = low ? Math.min(trimmed, Math.max(forward, 0)) : trimmed
    const speedUp = clamp((target - forward) * SPEED_GAIN, -MAX_HOLD_ACCEL, MAX_HOLD_ACCEL)
    const holdPitch = clamp(-Math.atan((speedUp + drag) / GRAVITY), -rotor.maxPitch, rotor.maxPitch)
    // Hands off in a hover, lean against any sideways drift
    const slide = clamp(-side * SPEED_GAIN, -MAX_HOLD_ACCEL, MAX_HOLD_ACCEL)
    const holdBank = Math.atan((slide + sideDrag) / GRAVITY) * (1 - cruising)
    const bankReach = lerp(HOVER_BANK, rotor.maxBank, cruising)
    // Hands off close to the ground, the nose stays about level so it clears the ground
    const wheels = agl - A.restHeight
    const lowest = lerp(-NEAR_GROUND_PITCH, -rotor.maxPitch, clamp(wheels / NEAR_GROUND, 0, 1))
    // A held stick takes over from the speed hold. Sideways it adds to the drift hold, so in
    // a hover a held stick settles on a steady sideways drift.
    const pitchTarget = lerp(
      Math.max(lowest, holdPitch),
      controls.pitch * rotor.maxPitch,
      Math.min(1, Math.abs(controls.pitch) * 3)
    )
    const bankTarget = clamp(holdBank + controls.roll * bankReach, -bankReach, bankReach)

    // Turn rate to the right: the pedals' rate, or holding the heading in a hover and a
    // balanced turn at speed
    const steering = Math.abs(controls.yaw) > 0.02
    if (steering || cruising > 0.5) this.heldHeading = this.heading
    const hold = clamp(
      turnAngle(this.heading, this.heldHeading) * HEADING_GAIN,
      -rotor.maxYawRate,
      rotor.maxYawRate
    )
    const balanced =
      (GRAVITY * Math.tan(clamp(this.bank, -1, 1))) / Math.max(airspeed, CRUISE_FROM) +
      (vBody.x / Math.max(airspeed, 1)) * SLIP_GAIN
    const turnTarget = lerp(hold, balanced, cruising) + controls.yaw * rotor.maxYawRate

    // On the wheels the system only damps: the cyclic and pedals turn the aircraft directly
    let pitchRate = clamp((pitchTarget - this.pitch) * PITCH_GAIN, -MAX_PITCH_RATE, MAX_PITCH_RATE)
    let rollRate = clamp((bankTarget - this.bank) * ROLL_GAIN, -MAX_ROLL_RATE, MAX_ROLL_RATE)
    if (this.onGround) {
      pitchRate = controls.pitch * GROUND_RATE
      rollRate = controls.roll * GROUND_RATE
    }
    const pitchPush = clamp((pitchRate - w.x) * PITCH_RATE_GAIN, -MAX_PITCH_ACCEL, MAX_PITCH_ACCEL)
    const rollPush = clamp((rollRate + w.z) * ROLL_RATE_GAIN, -MAX_ROLL_ACCEL, MAX_ROLL_ACCEL)
    const turnPush = clamp((turnTarget + w.y) * YAW_RATE_GAIN, -MAX_YAW_ACCEL, MAX_YAW_ACCEL)
    torque.set(
      A.inertiaPitch * pitchPush * authority,
      -A.inertiaYaw * turnPush * authority,
      -A.inertiaRoll * rollPush * authority
    )
  }

  /** Share of a turbine's sea level power the air allows. */
  private turbineAir(density: number) {
    return (density / SEA_LEVEL_DENSITY) ** 0.8
  }

  /** Thrust in newtons at a forward airspeed in m/s if every engine ran like `state`. */
  private thrust(forwardSpeed: number, density: number, state: EngineState) {
    const engine = this.spec.engine
    const thin = density / SEA_LEVEL_DENSITY
    if (engine.type === 'piston') {
      const pull =
        (state.power * engine.shaftPower * engine.propEfficiency * pistonAir(engine, density)) /
        Math.hypot(forwardSpeed, engine.staticThrustSpeed)
      const windmill = Math.max(0, 1 - state.power / WINDMILL_POWER)
      const drag =
        0.5 * density * forwardSpeed * Math.abs(forwardSpeed) * (engine.windmillArea ?? 0)
      return pull - drag * windmill
    }
    if (engine.type === 'turboshaft' || (!state.running && state.power < 0.02)) return 0
    const dry = lerp(
      engine.idleThrust,
      engine.militaryThrust,
      Math.min(1, state.power / engine.afterburnerFrom)
    )
    // The afterburner cannot light while the engine is in reverse
    const boost =
      (1 - this.reversePosition) *
      this.reheat(state.power, engine.afterburnerFrom) *
      (engine.afterburnerThrust - engine.militaryThrust)
    const lapse = speedFactor(engine.speedLapse, forwardSpeed / speedOfSound(this.position.y))
    return (dry + boost) * lapse * thin ** 0.7
  }

  /** Reading for one engine's power gauge: propeller rpm, or percent of full speed for a jet. */
  private engineSpeed(forwardSpeed: number, state: EngineState) {
    const engine = this.spec.engine
    // While the starter turns it, the engine speeds up toward light-off
    const cranking = Math.min(1, state.starting / this.spec.starterSeconds)
    if (engine.type === 'jet') {
      if (!state.running) return state.starting > 0 ? 4 + 16 * cranking : state.power * 60
      // A fighter engine idles near 60% speed, an airliner's big fan near 20%
      const idle = engine.speedLapse > 0 ? 20 : 62
      return idle + (100 - idle) * Math.min(1, state.power / engine.afterburnerFrom) ** 0.7
    }
    if (engine.type === 'turboshaft') return state.power * 100
    if (!state.running) {
      return state.starting > 0 ? 150 + 150 * cranking : Math.min(900, 12 * forwardSpeed)
    }
    const span = engine.maxRpm - 200 - engine.idleRpm
    return Math.min(
      engine.maxRpm + 100,
      engine.idleRpm + span * state.power ** 0.6 + 4 * forwardSpeed
    )
  }

  private resetState(heading: number) {
    this.velocity.set(0, 0, 0)
    this.angularVelocity.set(0, 0, 0)
    this.orientation.setFromAxisAngle(UP, -heading)
    this.flapPosition = 0
    this.speedBrakePosition = 0
    this.reversePosition = 0
    for (const engine of this.engines) {
      engine.starting = 0
      engine.failed = false
      engine.fire = false
    }
    this.ditched = false
    this.bellied = false
    this.inflow = 0
    this.heldHeading = heading
    this.rotorDemand = 0
    this.gearStuck = false
    this.hydraulicsFailed = false
    this.fuelLeak = 0
    this.flapsJammed = false
    this.gearJammed = false
    this.flapOverspeed = false
    this.gearOverspeed = false
    this.flapStrain = 0
    this.gearStrain = 0
    this.overspeedStrain = 0
    this.starved = 0
    this.prime = 0
    this.sinceRun = Number.POSITIVE_INFINITY
    this.firing = 0
    this.starving = 0
    this.rollout = false
    this.fuel = this.spec.fuelCapacity
    this.crash = null
    this.onGround = false
    this.stall = 0
    this.stalledFlow = 0
    this.flareTrim = null
    this.dumping = false
    this.stallWarning = false
    this.afterburner = false
    this.gLoad = 1
    this.slip = 0
    this.compression.fill(0)
  }

  /** Moves flaps, gear, speed brake, and the engine toward their lever positions. */
  private updateSystems(dt: number, controls: Controls) {
    const A = this.spec
    const notches = A.flapLabels.length - 1
    if (notches > 0 && !this.flapsJammed && !this.hydraulicsFailed) {
      this.flapPosition = approach(
        this.flapPosition,
        Math.min(controls.flapNotch, notches) / notches,
        dt / (A.flapSecondsPerNotch * notches)
      )
    }
    // The gear stays locked down while weight is on the wheels. Without hydraulics it still
    // falls out under its own weight.
    const gearTarget =
      controls.gearDown || this.onGround || !A.retractableGear || this.gearJammed ? 1 : 0
    const gear = this.gearStuck ? 0 : gearTarget
    this.gearPosition = approach(this.gearPosition, gear, dt / A.gearSeconds)
    // Airliners raise the spoilers and brake by themselves once they are down and throttled back
    // The spoilers stay out through a small bounce, so the aircraft settles back down
    const bounced = this.altitudeAgl - A.restHeight > 10
    const autobrake = A.autobrake && !this.hydraulicsFailed
    if (bounced || controls.throttle > 0.3 || this.groundSpeed < 2) this.rollout = false
    else if (this.onGround && autobrake && controls.throttle < 0.1 && this.groundSpeed > 18) {
      this.rollout = true
    }
    const spoilers = (controls.speedBrake || this.rollout) && !this.hydraulicsFailed ? 1 : 0
    this.speedBrakePosition = approach(this.speedBrakePosition, spoilers, dt)
    // Without reversers the lever does nothing
    const reverseTarget = controls.reverse && A.reverseThrust > 0 ? 1 : 0
    this.reversePosition = approach(this.reversePosition, reverseTarget, dt)

    this.checkLimits(dt, controls)
    const procedures = A.engine.type === 'piston' ? controls.procedures : undefined
    // Engines run on with the fuel feed off only until the lines run dry
    const feeding = procedures ? procedures.fuelSelector !== 'off' : controls.fuelPumps
    this.starved = feeding ? 0 : this.starved + dt
    const fed = this.fuel > 0 && this.starved < FUEL_LINE_SECONDS
    // The starter needs electrical power, and the engine needs fuel to light
    const canStart = this.powered && controls.fuelPumps
    if (procedures) this.updatePrime(dt, procedures, fed, controls.throttle)
    // One starter turns at a time, so switched-on engines start in order
    let starterBusy = !canStart
    const idle = A.engine.type === 'piston' ? A.engine.idlePower : 0
    const spool = 1 - Math.exp(-dt / A.spoolSeconds)
    let power = 0
    let running = 0
    let burn = 0
    // Fuel flow follows the thrust the engines deliver: less in thin air, and for jets less
    // as the intake slows down. Jets burn more per newton as the Mach number rises.
    const density = airDensity(this.position.y)
    const thin = density / SEA_LEVEL_DENSITY
    let fuelFlow = A.engine.type === 'piston' ? pistonAir(A.engine, density) : thin
    if (A.engine.type === 'jet') {
      const mach = Math.min(1, this.mach)
      fuelFlow = thin ** 0.7 * speedFactor(A.engine.speedLapse, this.mach) * (1 + TSFC_RISE * mach)
    }
    this.afterburner = false
    for (let i = 0; i < this.engines.length; i++) {
      const engine = this.engines[i]
      if (procedures) {
        this.runByHand(dt, engine, procedures, fed)
      } else if (!controls.engineSwitches[i] || !fed || engine.failed) {
        engine.running = false
        engine.starting = 0
      } else if (!engine.running && !starterBusy) {
        starterBusy = true
        engine.starting += dt
        if (engine.starting >= A.starterSeconds) {
          engine.running = true
          engine.starting = 0
        }
      } else if (!engine.running) {
        // Another engine took the starter, so this one spins down and starts over later
        engine.starting = 0
      }
      // A helicopter's governor sets the power; the lever is the collective
      const mixture = procedures ? this.mixturePower(procedures) : 1
      const lever = A.rotor ? this.rotorDemand : lerp(idle, 1, controls.throttle) * mixture
      const target = engine.running ? lever : 0
      engine.power += (target - engine.power) * spool
      power += engine.power
      if (!engine.running) continue
      running++
      burn += lerp(A.fuelBurnIdle, A.fuelBurnFull, this.fuelDemand(engine.power)) * fuelFlow
      if (A.engine.type === 'jet' && engine.power > A.engine.afterburnerFrom) {
        this.afterburner = this.reversePosition < 0.5
      }
    }
    this.enginePower = power / this.engines.length
    this.enginesRunning = running
    // With real procedures the master switch alone powers the bus, as on a light aircraft
    this.powered = controls.battery || (running > 0 && !procedures)
    this.sinceRun = running > 0 ? 0 : this.sinceRun + dt
    this.fuel = Math.max(0, this.fuel - (burn / this.engines.length + this.fuelLeak) * dt)
    // Dumping needs power for the pumps and stops by itself at a landing fuel load
    const floor = A.fuelCapacity * DUMP_FLOOR
    this.dumping =
      controls.fuelDump && A.fuelDump && this.powered && !this.onGround && this.fuel > floor
    if (this.dumping) {
      this.fuel = Math.max(floor, this.fuel - (A.fuelCapacity / DUMP_SECONDS) * dt)
    }
  }

  /**
   * Flags flaps or gear out above their speed limit. A few seconds of strain jams the flaps
   * where they are, or leaves the gear stuck down with its doors torn. Retracting them
   * above the limit is allowed.
   */
  private checkLimits(dt: number, controls: Controls) {
    const A = this.spec
    const knots = this.indicatedAirspeed / KNOT
    const notches = A.flapLabels.length - 1
    const notch = Math.ceil(this.flapPosition * notches - 0.02)
    const flapLimit = notch > 0 ? A.flapSpeeds[notch - 1] : Number.POSITIVE_INFINITY
    const gearLimit =
      this.gearPosition > 0.02 && A.gearSpeed ? A.gearSpeed : Number.POSITIVE_INFINITY
    this.flapOverspeed = knots > flapLimit
    this.gearOverspeed = knots > gearLimit && !this.onGround
    // Strain builds faster the further past the limit, and eases off below it
    const strain = (over: number, value: number) =>
      over > LIMIT_MARGIN ? value + (dt * over) / 20 : Math.max(0, value - dt)
    // Parts already folding away carry no new strain: the pilot has fixed the problem
    const flapsRetracting = controls.flapNotch / Math.max(notches, 1) < this.flapPosition - 0.01
    const gearRetracting = !controls.gearDown && !this.onGround
    this.flapStrain = strain(flapsRetracting ? 0 : knots - flapLimit, this.flapStrain)
    this.gearStrain = strain(gearRetracting ? 0 : knots - gearLimit, this.gearStrain)
    if (this.flapStrain > STRAIN_LIMIT) this.flapsJammed = true
    if (this.gearStrain > STRAIN_LIMIT && A.retractableGear) this.gearJammed = true
  }

  /** How far the throttle is into the afterburner range, 0 to 1. Always 0 without an afterburner. */
  private reheat(power: number, from: number) {
    return from < 1 ? clamp((power - from) / (1 - from), 0, 1) : 0
  }

  /** One engine's share of its full fuel burn, 0 to 1. An afterburner uses six times full dry power. */
  /**
   * Priming: the fuel pump with a rich mixture wets the cylinders of a stopped engine. The
   * fuel slowly evaporates. Cranking with the throttle wide open and the mixture at cutoff
   * blows out a flood, as the handbook's flooded start does.
   */
  private updatePrime(dt: number, procedures: Procedures, fed: boolean, throttle: number) {
    if (this.enginesRunning > 0 && this.firing <= 0) {
      this.prime = 0
      return
    }
    if (procedures.auxPump && procedures.mixture > 0.5 && fed) this.prime += dt
    const clearing =
      procedures.magnetos === 'start' &&
      procedures.mixture < MIXTURE_CUTOFF &&
      throttle > CLEARING_THROTTLE
    this.prime = Math.max(0, this.prime - dt * (clearing ? 1.5 : 0.02))
  }

  /** True while a flooded engine will not fire until it is cleared. */
  get flooded() {
    return this.prime > FLOODED
  }

  /**
   * A piston engine started and run by its real controls. It fires on its prime while the
   * starter turns, even at idle cutoff, then dies unless the mixture comes in within seconds.
   */
  private runByHand(dt: number, engine: EngineState, procedures: Procedures, fed: boolean) {
    const rich = procedures.mixture > MIXTURE_CUTOFF
    const ignition = procedures.magnetos !== 'off'
    if (engine.running) {
      // The prime carries the engine until the mixture is in far enough to run on
      const power = this.mixturePower(procedures)
      if (power >= 0.5) this.firing = 0
      else if (this.firing > 0) this.firing -= dt
      const onPrime = this.firing > 0
      // Too lean to burn for more than a moment, or no spark or fuel, and it stops
      this.starving = power < 0.05 && !onPrime ? this.starving + dt : 0
      const quits = this.starving > LEAN_SECONDS || (!rich && !onPrime)
      if (!ignition || !fed || engine.failed || quits) {
        engine.running = false
        this.firing = 0
        this.starving = 0
      }
      return
    }
    const cranking = procedures.magnetos === 'start' && this.powered && !engine.failed
    if (!cranking) {
      engine.starting = 0
      return
    }
    engine.starting += dt
    const warm = this.sinceRun < WARM_SECONDS
    const primed = warm || (this.prime >= PRIME_NEEDED && !this.flooded)
    if (engine.starting >= this.spec.starterSeconds && fed && primed) {
      engine.running = true
      engine.starting = 0
      if (!rich) this.firing = FIRING_SECONDS
    }
  }

  /**
   * Share of full power the mixture allows: full at the best setting, a little less rich of
   * it, falling fast when leaned past it, and a little less on one magneto.
   */
  private mixturePower(procedures: Procedures) {
    const off = procedures.mixture - bestMixture(this.position.y)
    const mixture = off >= 0 ? 1 - 0.6 * off * off : 1 - 6 * off * off
    const single = procedures.magnetos === 'left' || procedures.magnetos === 'right'
    return Math.max(0, mixture) * (single ? 0.97 : 1)
  }

  private fuelDemand(power: number) {
    const engine = this.spec.engine
    if (engine.type !== 'jet' || engine.afterburnerFrom >= 1) return power
    const dry = Math.min(1, power / engine.afterburnerFrom)
    return dry * 0.17 + this.reheat(power, engine.afterburnerFrom) * 0.83
  }

  /** Adds wheel and skid forces, and flags a crash when anything else touches down. */
  private applyGroundContact(controls: Controls, totalForce: Vector3, totalTorque: Vector3) {
    const A = this.spec
    const q = this.orientation
    const gearDown = this.gearPosition > 0.95

    for (const point of A.hullPoints) {
      arm.copy(point.position).applyQuaternion(q).add(this.position)
      const terrain = this.ground.heightAt(arm.x, arm.z)
      if (arm.y >= Math.max(terrain, 0)) continue
      if (terrain < 0) {
        if (!this.ditch(gearDown)) this.crash = 'water'
      } else if (point.underside && !gearDown) {
        if (!this.bellyLand()) this.crash = 'gear-up'
      } else this.crash = 'terrain'
      return
    }

    const brake = Math.max(
      controls.brake,
      controls.parkingBrake ? 1 : 0,
      this.rollout ? AUTOBRAKE : 0
    )
    const leftBrake = Math.max(brake, controls.brakeLeft)
    const rightBrake = Math.max(brake, controls.brakeRight)
    const speed = Math.hypot(this.velocity.x, this.velocity.z)
    let touching = false

    for (let i = 0; i < A.contactPoints.length; i++) {
      const point = A.contactPoints[i]
      const wasTouching = this.compression[i] > 0
      this.compression[i] = 0
      if (point.gear && !gearDown) continue

      arm.copy(point.position).applyQuaternion(q)
      const x = this.position.x + arm.x
      const y = this.position.y + arm.y
      const z = this.position.z + arm.z
      const terrain = this.ground.heightAt(x, z)
      if (terrain < 0) {
        if (y < 0) {
          // Wheels down dig in and flip the aircraft. A tail bumper can skim a ditching.
          if (point.gear || !this.ditch(gearDown)) this.crash = 'water'
          return
        }
        continue
      }
      const depth = terrain - y
      if (depth <= 0) continue

      pointVelocity
        .crossVectors(this.angularVelocity, point.position)
        .applyQuaternion(q)
        .add(this.velocity)
      const sink = -pointVelocity.y
      if (point.gear) {
        // The nose wheel comes down after the main wheels, faster as the nose pitches down, so
        // it takes a harder contact before it counts as a crash
        const limit = A.maxTouchdownSink * (point.braked ? 1 : NOSE_WHEEL_MARGIN)
        if (!wasTouching && sink > limit) {
          this.crash = 'hard-landing'
          return
        }
        if (depth > A.gearTravel) {
          this.crash = 'gear-collapse'
          return
        }
      }
      this.compression[i] = depth
      touching = true
      const load = Math.max(0, point.stiffness * depth + point.damping * sink)

      // Rolling direction on the ground. Rudder turns the nose wheel, less so at speed.
      wheelForward.copy(FORWARD).applyQuaternion(q)
      if (point.steered) {
        const steer = controls.yaw * lerp(A.maxSteerAngle, 0.08, clamp(speed / 25, 0, 1))
        wheelForward.applyAxisAngle(UP, -steer)
      }
      wheelForward.y = 0
      contactForce.set(0, load, 0)
      if (wheelForward.lengthSq() > 1e-6) {
        wheelForward.normalize()
        const sideX = -wheelForward.z
        const sideZ = wheelForward.x
        const rolling = pointVelocity.x * wheelForward.x + pointVelocity.z * wheelForward.z
        const sliding = pointVelocity.x * sideX + pointVelocity.z * sideZ
        const friction =
          ROLLING_FRICTION[this.ground.surfaceAt(x, z)] +
          point.scrape +
          (point.braked ? (point.position.x < 0 ? leftBrake : rightBrake) * A.brakeFriction : 0)
        const along = -load * friction * clamp(rolling / 0.2, -1, 1)
        const across =
          -load * A.sideFriction * clamp(sliding / (0.3 + 0.03 * Math.abs(rolling)), -1, 1)
        contactForce.x = wheelForward.x * along + sideX * across
        contactForce.z = wheelForward.z * along + sideZ * across
      }

      totalForce.add(contactForce)
      totalTorque.add(temp.copy(contactForce).applyQuaternion(qInv).cross(point.position).negate())
    }
    this.onGround = touching
    if (touching) this.flareTrim = null
  }

  /**
   * Discharges an engine's fire bottle. It puts the fire out only once the engine is shut
   * down, with its fuel cut off. Returns true if the fire went out.
   */
  extinguish(index: number, switchedOn: boolean) {
    const engine = this.engines[index]
    if (!engine?.fire || switchedOn) return false
    engine.fire = false
    return true
  }

  /**
   * A touch on the sea: a ditching if it is gentle, with the wheels up, the wings level, and
   * the nose not down. Returns false for a crash.
   */
  private ditch(gearDown: boolean) {
    const gentle =
      !gearDown &&
      -this.velocity.y < DITCH_SINK &&
      Math.abs(this.bank) < DITCH_BANK &&
      this.pitch > -0.02 &&
      this.trueAirspeed < this.spec.approachSpeed * KNOT * DITCH_SPEED
    if (gentle) {
      this.ditched = true
      this.onGround = true
      this.velocity.y = 0
      this.angularVelocity.set(0, 0, 0)
    }
    return gentle
  }

  /**
   * A wheels-up touch on land: a belly landing if it is gentle, with the wings level and the
   * nose not down. Returns false for a crash.
   */
  private bellyLand() {
    const gentle =
      -this.velocity.y < BELLY_SINK &&
      Math.abs(this.bank) < BELLY_BANK &&
      this.pitch > -0.02 &&
      this.trueAirspeed < this.spec.approachSpeed * KNOT * DITCH_SPEED
    if (gentle) {
      this.bellied = true
      this.onGround = true
      this.rollout = false
      this.velocity.y = 0
      this.angularVelocity.set(0, 0, 0)
    }
    return gentle
  }

  /**
   * Sliding on the belly: the airframe scrapes along the ground to a stop and settles level.
   * The engines are wrecked by the touchdown. Sliding off the coast turns into a ditching.
   */
  private slide(dt: number) {
    const speed = Math.hypot(this.velocity.x, this.velocity.z)
    const share = speed > 0 ? Math.max(0, speed - BELLY_FRICTION * dt) / speed : 0
    this.velocity.x *= share
    this.velocity.z *= share
    this.velocity.y = 0
    this.position.addScaledVector(this.velocity, dt)
    const terrain = this.ground.heightAt(this.position.x, this.position.z)
    if (terrain < 0) {
      this.bellied = false
      this.ditched = true
      return
    }
    this.position.y = terrain + bellyHeight(this.spec)
    this.settleLevel(dt)
  }

  /** Afloat after a ditching: the water slows the aircraft to a stop and it settles level. */
  private float(dt: number) {
    const slow = Math.exp(-dt * DITCH_DRAG)
    this.velocity.x *= slow
    this.velocity.z *= slow
    this.velocity.y = 0
    this.position.addScaledVector(this.velocity, dt)
    this.position.y = this.spec.restHeight * 0.35
    this.settleLevel(dt)
  }

  /**
   * Down on the belly, on land or sea: the nose and wings ease level, keeping the heading,
   * and the engines stop.
   */
  private settleLevel(dt: number) {
    level.setFromAxisAngle(UP, -this.heading)
    this.orientation.slerp(level, 1 - Math.exp(-dt * 1.5))
    this.trueAirspeed = Math.hypot(this.velocity.x, this.velocity.z)
    this.indicatedAirspeed = this.trueAirspeed
    this.altitudeAgl = 0
    this.stall = 0
    this.stallWarning = false
    for (const engine of this.engines) {
      engine.running = false
      engine.power = 0
    }
    this.refreshAttitude()
  }

  private refreshAttitude() {
    const q = this.orientation
    temp.copy(FORWARD).applyQuaternion(q)
    const heading = Math.atan2(temp.x, -temp.z)
    this.heading = heading < 0 ? heading + Math.PI * 2 : heading
    this.pitch = Math.asin(clamp(temp.y, -1, 1))
    const rightY = temp.copy(RIGHT).applyQuaternion(q).y
    this.bank = Math.atan2(-rightY, temp.copy(UP).applyQuaternion(q).y)
    this.turnRate = -temp.copy(this.angularVelocity).applyQuaternion(q).y
    this.groundSpeed = Math.hypot(this.velocity.x, this.velocity.z)
    this.verticalSpeed = this.velocity.y
  }
}
