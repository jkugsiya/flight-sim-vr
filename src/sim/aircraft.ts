import { Vector3 } from 'three'

export const GRAVITY = 9.81
export const SEA_LEVEL_DENSITY = 1.225
/** Speed of sound in m/s at an altitude in metres: it falls with the temperature up to 11 km. */
export const speedOfSound = (altitude: number) =>
  340.3 * Math.sqrt(Math.max(216.65, 288.15 - 0.0065 * altitude) / 288.15)
export const KNOT = 0.5144

/** Rolling resistance of a free wheel on each surface. */
export const ROLLING_FRICTION = { runway: 0.02, grass: 0.06, water: 0.06 } as const

export type ContactPoint = {
  position: Vector3
  stiffness: number
  damping: number
  /** Retracts with the landing gear and breaks on a hard touchdown. */
  gear: boolean
  braked: boolean
  steered: boolean
  /** Extra drag friction for parts that scrape instead of roll. */
  scrape: number
}

export type PistonEngine = {
  type: 'piston'
  /** Shaft power in watts. */
  shaftPower: number
  propEfficiency: number
  /** Thrust stops rising below this airspeed (m/s), which caps static thrust. */
  staticThrustSpeed: number
  idlePower: number
  /** Yaw arm in metres: the propeller pulls the nose left at low speed and high power. */
  propYawArm: number
  propYawFadeSpeed: number
  idleRpm: number
  maxRpm: number
  /**
   * Height in metres up to which a supercharger keeps full power. Above it power falls with
   * the air. Without one, power falls from sea level.
   */
  criticalAltitude?: number
}

export type JetEngine = {
  type: 'jet'
  /** Total thrust in newtons at idle, at full dry power, and with afterburners lit. */
  idleThrust: number
  militaryThrust: number
  afterburnerThrust: number
  /** Throttle position from 0 to 1 where the afterburner lights. 1 for engines without one. */
  afterburnerFrom: number
  /** Share of thrust lost by Mach 1. Airliner turbofans lose about half, fighter engines little. */
  speedLapse: number
}

/** Ranges and coloured arcs for the cockpit dials, in the units the dials show. */
export type GaugeSpec = {
  airspeed: {
    min: number
    max: number
    labelEvery: number
    tickEvery: number
    flapRange: [number, number] | null
    normalRange: [number, number]
    cautionRange: [number, number]
  }
  /** Full-scale climb rate in feet per minute. */
  climb: number
  power: {
    caption: string
    max: number
    labelEvery: number
    tickEvery: number
    /** Divides the reading for the printed labels, such as 100 for RPM × 100. */
    labelScale: number
    normalRange: [number, number]
    redline: number
  }
}

export type AirlinerShape = {
  type: 'airliner'
  /** Concorde keeps the airliner proportions for gates and maps, with its own model. */
  variant?: 'concorde'
  /** Fuselage radius, and how much taller than wide it is (above 1 for a double-decker). */
  radius: number
  tall: number
  noseZ: number
  tailZ: number
  decks: 1 | 2
  wing: {
    y: number
    dihedral: number
    /** Distance from the centreline to the wingtip. */
    halfSpan: number
    /** Leading edge at the root and at the tip, measured along the body. */
    rootZ: number
    tipZ: number
    rootChord: number
    tipChord: number
    tip: 'sharklet' | 'split' | 'raked' | 'fence'
  }
  /** Right-hand engines as [distance from centreline, front of the nacelle]. Mirrored on the left. */
  engines: [number, number][]
  engineRadius: number
  engineLength: number
  engineY: number
  tailSpan: number
  finHeight: number
  paint: string
  accent: string
}

/** Proportions of the visible model. Positions are in body axes. */
export type Shape =
  | {
      type: 'propeller'
      /** The P-51 has its own model: a tail-dragger with a belly scoop and a bubble canopy. */
      variant?: 'mustang'
      noseZ: number
      tailZ: number
      cabinRadius: number
      /** Height of the wing on the fuselage, and its upward tilt in radians. */
      wingY: number
      dihedral: number
      highWing: boolean
      tailSpan: number
      finHeight: number
      propRadius: number
      paint: string
      accent: string
    }
  | { type: 'fighter'; variant: 'f16' | 'f35'; paint: string; accent: string }
  | BomberShape
  | AirlinerShape
  | ShuttleShape

/**
 * The Space Shuttle orbiter. The outline runs from the nose around the right side of the
 * double-delta wing to the tail, as (x, z) pairs, the same way as the bomber's.
 */
export type ShuttleShape = {
  type: 'shuttle'
  outline: [number, number][]
  paint: string
  accent: string
}

/**
 * A flying wing with no fuselage or tail. The outline runs from the nose to the right
 * wingtip and back along the sawtooth trailing edge, as (x, z) pairs; the left half mirrors it.
 */
export type BomberShape = {
  type: 'bomber'
  outline: [number, number][]
  /** Right-hand engines as [distance from centreline, z], buried in the wing. */
  engines: [number, number][]
  paint: string
  accent: string
}

/**
 * Everything that makes one aircraft type fly, look, and read differently.
 * SI units and radians unless a field says otherwise.
 * Body axes: -Z points out the nose, +X out the right wing, +Y up.
 */
export type AircraftSpec = {
  id: string
  name: string
  /** Short name for tight spaces, such as A320. */
  label: string
  role: string
  description: string
  /** Headline numbers for the aircraft picker. Speeds in knots, climb in feet per minute. */
  stats: { power: string; topSpeed: number; stallSpeed: number; climb: number }

  /** Kilograms with a typical landing fuel load, 30% of the tanks. Fuel adds to it or takes away. */
  mass: number
  inertiaPitch: number
  inertiaYaw: number
  inertiaRoll: number
  wingArea: number
  wingSpan: number
  chord: number

  // Lift
  cl0: number
  clAlpha: number
  flapLift: number
  stallAlpha: number
  negativeStallAlpha: number
  /** Change in stall angle with full flap. Negative where slats let the wing fly at steeper angles. */
  flapStallShift: number
  stallSharpness: number
  /** Once stalled, the wing stays stalled until the angle of attack drops this far below the stall. */
  stallHysteresis: number
  /** The stall horn sounds this far below the stall angle. */
  stallWarningMargin: number

  // Drag
  cd0: number
  gearDrag: number
  flapDrag: number
  inducedDrag: number
  sideDrag: number
  sideForce: number
  /** Mach number where the extra drag of shock waves starts to build. 0.85 if not given. */
  dragRiseMach?: number
  /** Extra drag near and above the speed of sound. */
  waveDrag: number
  speedBrakeDrag: number
  /** Share of wing lift the open airbrake or spoilers destroy. */
  liftDump: number

  // Pitch moment
  cm0: number
  cmAlpha: number
  cmPitchRate: number
  cmElevator: number
  cmTrim: number
  cmStall: number

  // Roll moment
  clBeta: number
  clRollRate: number
  clYawRate: number
  clAileron: number
  /** Roll moment that drops the left wing at the stall, as engine torque does. */
  stallRollBias: number

  // Yaw moment
  cnBeta: number
  cnYawRate: number
  cnRollRate: number
  cnRudder: number
  cnAileron: number

  engine: PistonEngine | JetEngine
  engineCount: number
  /** Seconds for the engines to follow the throttle, and for each one to start. */
  spoolSeconds: number
  starterSeconds: number
  /** Fuel in kg, and burn in kg/s at idle and at full power. */
  fuelCapacity: number
  /** True for aircraft that can pump fuel overboard to land lighter. */
  fuelDump: boolean
  /** Bombs carried in free flight, for bombers. */
  bombBay?: number
  fuelBurnIdle: number
  fuelBurnFull: number
  /** Unit shown on the fuel gauge, and how many of them make one kilogram. */
  fuelUnit: { label: string; perKg: number }

  /** Names of the flap lever positions, starting with flaps up. One entry means no flaps. */
  flapLabels: string[]
  /** What the flap lever moves: the flaps, or Concorde's drooping nose. */
  flapName: 'Flaps' | 'Nose'
  /**
   * Highest indicated airspeed in knots for each flap position after Up, and with the gear
   * down (null for fixed gear). Flying faster for long damages the flaps or gear.
   */
  flapSpeeds: number[]
  gearSpeed: number | null
  flapSecondsPerNotch: number
  retractableGear: boolean
  gearSeconds: number
  /** Share of forward thrust available in reverse. */
  reverseThrust: number
  /**
   * Fly-by-wire: the computers trim for level flight, stop the wing short of the stall by
   * `alphaMargin` radians, and stop the bank at `maxBank` radians. With `maxPitch`, they
   * also stop the nose above that many radians, so a long pull cannot loop the aircraft.
   */
  flyByWire: { alphaMargin: number; maxBank: number; maxPitch?: number } | null
  /** Spoilers and brakes come on by themselves after touchdown. */
  autobrake: boolean

  /** Indicated airspeed in m/s where a full pull reaches the stall and the g limit together. */
  maneuverSpeed: number
  /** Indicated airspeed in m/s the airframe must never exceed. It breaks up 12% above this. */
  neverExceedSpeed: number
  /** Highest Mach number allowed, which limits jets high up. Warns only; nothing breaks. */
  maxMach?: number
  /** Fighters: the flight computer lowers the flaps with the gear, so there is no flap lever. */
  autoFlaps?: boolean
  maxTouchdownSink: number
  gearTravel: number
  brakeFriction: number
  sideFriction: number
  maxSteerAngle: number

  /** Nose wheel, left main, right main, then the tail skid. */
  contactPoints: ContactPoint[]
  /** Touching the ground with any of these ends the flight. */
  hullPoints: { position: Vector3; underside: boolean }[]
  /** Height of the centre of gravity above the ground when parked. */
  restHeight: number
  wingtips: [Vector3, Vector3]
  /** Centres of the five parts the aircraft breaks into: fuselage, nose, left wing, right wing, tail. */
  breakup: { rest: Vector3; radius: number }[]

  /** Speeds in knots for the checklists, and in m/s for a start in the air. */
  rotateSpeed: number
  climbSpeed: number
  approachSpeed: number
  cruiseSpeed: number
  /** Shortest runway in metres this aircraft can use with a margin. */
  runwayNeeded: number
  gauges: GaugeSpec
  /** Instrument style: round dials, an airliner's flight display, or a fighter's head-up display. */
  panel: 'dials' | 'glass' | 'hud'
  camera: { distance: number; height: number; eye: Vector3 }
  shape: Shape
}

const wheel = (
  x: number,
  y: number,
  z: number,
  stiffness: number,
  damping: number,
  role: 'nose' | 'main'
): ContactPoint => ({
  position: new Vector3(x, y, z),
  stiffness,
  damping,
  gear: true,
  braked: role === 'main',
  steered: role === 'nose',
  scrape: 0
})

/** Tail skid: survives a tail strike on rotation. */
const skid = (y: number, z: number, stiffness: number): ContactPoint => ({
  position: new Vector3(0, y, z),
  stiffness,
  damping: stiffness / 10,
  gear: false,
  braked: false,
  steered: false,
  scrape: 0.4
})

const hull = (x: number, y: number, z: number, underside = false) => ({
  position: new Vector3(x, y, z),
  underside
})

/**
 * Nose-up pitch in radians, with the main wheels on the ground, at which the first part of
 * the airframe behind them touches the runway: the tail, or the engine pods.
 */
export function tailStrikePitch(spec: AircraftSpec) {
  const main = spec.contactPoints.find(point => point.braked)
  if (!main) return Math.PI / 4
  let lowest = Math.PI / 4
  for (const { position } of spec.hullPoints) {
    const behind = position.z - main.position.z
    if (behind <= 0) continue
    lowest = Math.min(lowest, Math.atan2(position.y - main.position.y, behind))
  }
  return lowest
}

/** Stiffness and damping of a gear leg that sags `sag` metres under `load` newtons. */
function spring(load: number, sag: number) {
  const stiffness = load / sag
  return [stiffness, 1.1 * Math.sqrt((stiffness * load) / GRAVITY)] as const
}

const part = (x: number, y: number, z: number, radius: number) => ({
  rest: new Vector3(x, y, z),
  radius
})

const CESSNA: AircraftSpec = {
  id: 'c172',
  name: 'Cessna 172S Skyhawk',
  label: 'Cessna 172',
  role: 'Four-seat piston single',
  description:
    'The aircraft most pilots learn on. Slow and steady, with cables to the controls and nothing to save you from a stall.',
  stats: { power: '180 hp', topSpeed: 123, stallSpeed: 48, climb: 730 },

  // With 30% fuel, so full tanks bring it to the 1,157 kg maximum takeoff weight
  mass: 1030,
  inertiaPitch: 1825,
  inertiaYaw: 2667,
  inertiaRoll: 1285,
  wingArea: 16.2,
  wingSpan: 11,
  chord: 1.5,

  cl0: 0.3,
  clAlpha: 5.1,
  flapLift: 0.55,
  stallAlpha: 0.279,
  negativeStallAlpha: 0.21,
  flapStallShift: 0.035,
  stallSharpness: 50,
  stallHysteresis: 0.09,
  stallWarningMargin: 0.07,

  cd0: 0.033,
  gearDrag: 0,
  flapDrag: 0.05,
  inducedDrag: 0.0533,
  sideDrag: 0.6,
  sideForce: -0.5,
  waveDrag: 0,
  speedBrakeDrag: 0,
  liftDump: 0,

  cm0: 0.05,
  cmAlpha: -0.89,
  cmPitchRate: -12,
  cmElevator: 0.28,
  cmTrim: 0.14,
  cmStall: -0.06,

  clBeta: -0.08,
  clRollRate: -0.47,
  clYawRate: 0.05,
  clAileron: 0.05,
  stallRollBias: 0.016,

  cnBeta: 0.12,
  cnYawRate: -0.12,
  cnRollRate: -0.02,
  cnRudder: 0.024,
  cnAileron: -0.008,

  engine: {
    type: 'piston',
    shaftPower: 134_000,
    propEfficiency: 0.8,
    staticThrustSpeed: 35,
    idlePower: 0.05,
    propYawArm: 0.04,
    propYawFadeSpeed: 50,
    idleRpm: 600,
    maxRpm: 2700
  },
  engineCount: 1,
  spoolSeconds: 0.4,
  starterSeconds: 2,
  fuelCapacity: 150,
  fuelDump: false,
  fuelBurnIdle: 0.0012,
  fuelBurnFull: 0.008,
  fuelUnit: { label: 'L', perKg: 1 / 0.72 },

  flapLabels: ['Up', '10°', '20°', '30°'],
  flapName: 'Flaps',
  flapSpeeds: [110, 85, 85],
  gearSpeed: null,
  flapSecondsPerNotch: 1.5,
  retractableGear: false,
  gearSeconds: 3,
  reverseThrust: 0.45,
  flyByWire: null,
  autobrake: false,

  maneuverSpeed: 52.5,
  neverExceedSpeed: 163 * KNOT,
  maxTouchdownSink: 5,
  gearTravel: 0.45,
  brakeFriction: 0.6,
  sideFriction: 0.8,
  maxSteerAngle: 0.45,

  contactPoints: [
    wheel(0, -1.25, -1.45, 90_000, 6000, 'nose'),
    wheel(-1.25, -1.25, 0.4, 60_000, 6000, 'main'),
    wheel(1.25, -1.25, 0.4, 60_000, 6000, 'main'),
    skid(-0.3, 5, 40_000)
  ],
  hullPoints: [
    hull(0, -0.95, -2.45, true),
    hull(0, -0.7, 0, true),
    hull(-5.55, 0.8, 0.1),
    hull(5.55, 0.8, 0.1),
    hull(0, 1.75, 5),
    hull(0, 1.1, -0.2)
  ],
  restHeight: 1.19,
  wingtips: [new Vector3(-5.5, 0.82, 0.4), new Vector3(5.5, 0.82, 0.4)],
  breakup: [
    part(0, 0, 0.4, 0.75),
    part(0, 0, -2.4, 0.35),
    part(-2.9, 0.8, 0.1, 0.3),
    part(2.9, 0.8, 0.1, 0.3),
    part(0, 0.45, 4.7, 0.5)
  ],

  rotateSpeed: 55,
  climbSpeed: 75,
  approachSpeed: 65,
  cruiseSpeed: 48,
  runwayNeeded: 500,
  gauges: {
    airspeed: {
      min: 20,
      max: 180,
      labelEvery: 20,
      tickEvery: 10,
      flapRange: [40, 85],
      normalRange: [48, 129],
      cautionRange: [129, 163]
    },
    climb: 2000,
    power: {
      caption: 'RPM × 100',
      max: 3000,
      labelEvery: 500,
      tickEvery: 100,
      labelScale: 100,
      normalRange: [2100, 2700],
      redline: 2700
    }
  },
  panel: 'dials',
  camera: { distance: 16, height: 4.8, eye: new Vector3(-0.25, 0.55, -0.5) },
  shape: {
    type: 'propeller',
    noseZ: -2.45,
    tailZ: 5.2,
    cabinRadius: 0.62,
    wingY: 0.8,
    dihedral: 0.03,
    highWing: true,
    tailSpan: 3.4,
    finHeight: 1.4,
    propRadius: 0.95,
    paint: '#f3f2ee',
    accent: '#1f4f8f'
  }
}

/** The numbers that differ between airliners. Everything else is derived or shared. */
type AirlinerPlan = {
  id: string
  name: string
  label: string
  role: string
  description: string
  mass: number
  /** Thrust in newtons per engine. */
  thrust: number
  thrustLabel: string
  wingArea: number
  chord: number
  inertia: [pitch: number, yaw: number, roll: number]
  flyByWire: boolean
  /** Airbus fly-by-wire also stops the nose at 30° up. */
  pitchLimit?: boolean
  fuelDump: boolean
  /** Share of forward thrust in reverse. The A380 reverses only its inner engines. */
  reverseThrust?: number
  /** Extra lift coefficient at full flap. Big wings with simpler flaps get less. */
  flapLift?: number
  /** Maximum operating speed in knots, and Mach number. */
  vmo: number
  mmo: number
  flapLabels: string[]
  flapSpeeds: number[]
  gearSpeed: number
  fuelCapacity: number
  /** Height of the wheels below the centreline, and where the gear legs stand. */
  gear: { y: number; noseZ: number; mainX: number; mainZ: number }
  stallSpeed: number
  climb: number
  shape: AirlinerShape
}

/** Builds a jet airliner. They share one wing design scaled to each airframe. */
function airliner(plan: AirlinerPlan): AircraftSpec {
  const { shape, gear } = plan
  const weight = plan.mass * GRAVITY
  const engines = shape.engines.length * 2
  const { halfSpan } = shape.wing
  const tipY = shape.wing.y + halfSpan * Math.sin(shape.wing.dihedral)
  // Share of the weight on the nose wheel when parked
  const noseShare = gear.mainZ / (gear.mainZ - gear.noseZ)
  // The nose strut is stiff enough to take the extra load of full braking and the nose
  // coming down after touchdown
  const [noseSpring, noseDamper] = spring(weight * noseShare, 0.08)
  const [mainSpring, mainDamper] = spring((weight * (1 - noseShare)) / 2, 0.22)
  const top = shape.radius * shape.tall
  const length = shape.tailZ - shape.noseZ
  // Induced drag from the wing's aspect ratio, with a span efficiency of 0.75
  const aspectRatio = (halfSpan * 2) ** 2 / plan.wingArea
  return {
    id: plan.id,
    name: plan.name,
    label: plan.label,
    role: plan.role,
    description: plan.description,
    stats: {
      power: plan.thrustLabel,
      topSpeed: plan.vmo,
      stallSpeed: plan.stallSpeed,
      climb: plan.climb
    },

    mass: plan.mass,
    inertiaPitch: plan.inertia[0],
    inertiaYaw: plan.inertia[1],
    inertiaRoll: plan.inertia[2],
    wingArea: plan.wingArea,
    wingSpan: halfSpan * 2,
    chord: plan.chord,

    cl0: 0.2,
    clAlpha: 5.2,
    flapLift: plan.flapLift ?? 1.05,
    // Flaps up the wing stalls near a lift coefficient of 1.45
    stallAlpha: 0.3,
    negativeStallAlpha: 0.2,
    flapStallShift: -0.06,
    stallSharpness: 40,
    stallHysteresis: 0.07,
    stallWarningMargin: 0.06,

    cd0: 0.019,
    gearDrag: 0.018,
    flapDrag: 0.075,
    inducedDrag: 1 / (Math.PI * aspectRatio * 0.75),
    sideDrag: 0.5,
    sideForce: -0.7,
    // Drag climbs steeply just past the maximum operating Mach number
    dragRiseMach: plan.mmo - 0.02,
    waveDrag: 0.06,
    speedBrakeDrag: 0.05,
    liftDump: 0.45,

    cm0: plan.flyByWire ? 0.03 : 0.07,
    cmAlpha: -1.2,
    cmPitchRate: -28,
    cmElevator: 0.45,
    cmTrim: 0.3,
    cmStall: -0.1,

    clBeta: -0.08,
    clRollRate: -0.5,
    clYawRate: 0.06,
    clAileron: 0.035,
    stallRollBias: 0.01,

    cnBeta: 0.15,
    cnYawRate: -0.35,
    cnRollRate: -0.01,
    cnRudder: 0.04,
    cnAileron: -0.002,

    engine: {
      type: 'jet',
      idleThrust: plan.thrust * engines * 0.05,
      militaryThrust: plan.thrust * engines,
      afterburnerThrust: plan.thrust * engines,
      afterburnerFrom: 1,
      speedLapse: 0.45
    },
    engineCount: engines,
    spoolSeconds: 3.5,
    starterSeconds: 5,
    fuelCapacity: plan.fuelCapacity,
    fuelDump: plan.fuelDump,
    fuelBurnIdle: (plan.thrust * engines) / 1_000_000,
    fuelBurnFull: (plan.thrust * engines) / 92_000,
    fuelUnit: { label: 'kg', perKg: 1 },

    flapLabels: plan.flapLabels,
    flapName: 'Flaps',
    flapSpeeds: plan.flapSpeeds,
    gearSpeed: plan.gearSpeed,
    flapSecondsPerNotch: 2.5,
    retractableGear: true,
    gearSeconds: 6,
    reverseThrust: plan.reverseThrust ?? 0.4,
    flyByWire: plan.flyByWire
      ? { alphaMargin: 0.07, maxBank: 1.15, maxPitch: plan.pitchLimit ? 0.52 : undefined }
      : null,
    autobrake: true,

    maneuverSpeed: plan.stallSpeed * 1.48 * KNOT * 1.58,
    neverExceedSpeed: plan.vmo * KNOT,
    maxMach: plan.mmo,
    maxTouchdownSink: 5,
    gearTravel: 0.5,
    brakeFriction: 0.5,
    sideFriction: 0.8,
    maxSteerAngle: 0.6,

    contactPoints: [
      wheel(0, -gear.y, gear.noseZ, noseSpring, noseDamper, 'nose'),
      wheel(-gear.mainX, -gear.y, gear.mainZ, mainSpring, mainDamper, 'main'),
      wheel(gear.mainX, -gear.y, gear.mainZ, mainSpring, mainDamper, 'main'),
      skid(-shape.radius * 0.35, shape.tailZ - length * 0.12, mainSpring)
    ],
    hullPoints: [
      hull(0, -shape.radius * 0.6, shape.noseZ + 1, true),
      hull(0, -shape.radius, 0, true),
      hull(-halfSpan, tipY, shape.wing.tipZ + 1),
      hull(halfSpan, tipY, shape.wing.tipZ + 1),
      hull(0, top + shape.finHeight, shape.tailZ - 2),
      hull(0, top, shape.noseZ + length * 0.12),
      // Engine pods hang low enough to scrape in a steep bank near the ground
      ...shape.engines.flatMap(([x, z]) => [
        hull(-x, shape.engineY - shape.engineRadius * 0.85, z + 1, true),
        hull(x, shape.engineY - shape.engineRadius * 0.85, z + 1, true)
      ])
    ],
    restHeight: gear.y - 0.2,
    wingtips: [
      new Vector3(-halfSpan, tipY, shape.wing.tipZ + 1),
      new Vector3(halfSpan, tipY, shape.wing.tipZ + 1)
    ],
    breakup: [
      part(0, 0, length * 0.08, shape.radius),
      part(0, 0, shape.noseZ + length * 0.14, shape.radius),
      part(-halfSpan * 0.5, shape.wing.y, (shape.wing.rootZ + shape.wing.tipZ) / 2 + 2, 0.8),
      part(halfSpan * 0.5, shape.wing.y, (shape.wing.rootZ + shape.wing.tipZ) / 2 + 2, 0.8),
      part(0, top * 0.6, shape.tailZ - length * 0.08, shape.radius * 0.7)
    ],

    rotateSpeed: Math.round(plan.stallSpeed * 1.38),
    climbSpeed: 250,
    approachSpeed: Math.round(plan.stallSpeed * 1.33),
    cruiseSpeed: 115,
    runwayNeeded: plan.mass > 300_000 ? 2800 : plan.mass > 120_000 ? 2600 : 1700,
    gauges: {
      airspeed: {
        min: 0,
        max: 400,
        labelEvery: 50,
        tickEvery: 10,
        flapRange: [plan.stallSpeed, 215],
        normalRange: [Math.round(plan.stallSpeed * 1.45), 320],
        cautionRange: [320, 350]
      },
      climb: 6000,
      power: {
        caption: 'N1 %',
        max: 110,
        labelEvery: 20,
        tickEvery: 5,
        labelScale: 1,
        normalRange: [20, 100],
        redline: 104
      }
    },
    panel: 'glass',
    camera: {
      distance: length * 1.75,
      height: length * 0.42,
      eye: new Vector3(-0.55, shape.radius * 0.38, shape.noseZ + length * 0.07)
    },
    shape
  }
}

const A320 = airliner({
  id: 'a320',
  name: 'Airbus A320',
  label: 'A320',
  role: 'Short-haul airliner',
  description:
    'Fly-by-wire: the computers trim for you, stop the bank at 66°, and refuse to stall. The friendliest jet here.',
  mass: 62_000,
  thrust: 120_000,
  thrustLabel: '2 × 27,000 lbf',
  wingArea: 122.6,
  chord: 4.19,
  inertia: [3_800_000, 4_900_000, 1_280_000],
  flyByWire: true,
  pitchLimit: true,
  flapLabels: ['0', '1', '2', '3', 'FULL'],
  fuelCapacity: 19_000,
  fuelDump: false,
  gear: { y: 3.7, noseZ: -11.5, mainX: 3.8, mainZ: 1.1 },
  stallSpeed: 104,
  flapSpeeds: [230, 200, 185, 177],
  gearSpeed: 280,
  vmo: 350,
  mmo: 0.82,
  climb: 2500,
  shape: {
    type: 'airliner',
    radius: 1.98,
    tall: 1,
    noseZ: -16.6,
    tailZ: 21,
    decks: 1,
    wing: {
      halfSpan: 17.9,
      y: -1.1,
      dihedral: 0.09,
      rootZ: -3.6,
      tipZ: 3.9,
      rootChord: 7,
      tipChord: 1.6,
      tip: 'sharklet'
    },
    engines: [[5.75, -5.2]],
    engineRadius: 1.1,
    engineLength: 4.4,
    engineY: -2.2,
    tailSpan: 12.45,
    finHeight: 6,
    paint: '#f4f4f2',
    accent: '#1c3f7a'
  }
})

const B737 = airliner({
  id: 'b737',
  name: 'Boeing 737 MAX 8',
  label: '737 MAX 8',
  role: 'Short-haul airliner',
  description:
    'Cables and hydraulics, no computer between you and the wing. It will stall if you let it, and the engines sit close to the ground.',
  mass: 66_000,
  thrust: 127_600,
  thrustLabel: '2 × 28,690 lbf',
  wingArea: 127,
  chord: 4.1,
  inertia: [4_100_000, 5_300_000, 1_350_000],
  flyByWire: false,
  flapLabels: ['Up', '5', '15', '30', '40'],
  fuelCapacity: 20_700,
  fuelDump: false,
  gear: { y: 3.1, noseZ: -14.2, mainX: 2.86, mainZ: 1.2 },
  stallSpeed: 106,
  flapSpeeds: [250, 200, 175, 162],
  gearSpeed: 270,
  vmo: 340,
  mmo: 0.82,
  climb: 2500,
  shape: {
    type: 'airliner',
    radius: 1.88,
    tall: 1,
    noseZ: -17.4,
    tailZ: 22.1,
    decks: 1,
    wing: {
      halfSpan: 17.95,
      y: -1,
      dihedral: 0.1,
      rootZ: -4,
      tipZ: 4,
      rootChord: 7.3,
      tipChord: 1.5,
      tip: 'split'
    },
    engines: [[4.85, -6]],
    engineRadius: 1.05,
    engineLength: 4.2,
    engineY: -1.7,
    tailSpan: 14.3,
    finHeight: 6.4,
    paint: '#f4f4f2',
    accent: '#0b6e75'
  }
})

const B787 = airliner({
  id: 'b787',
  name: 'Boeing 787-9 Dreamliner',
  label: '787-9',
  role: 'Long-haul airliner',
  description:
    'A long, flexible wing and two huge engines. Fly-by-wire with protections, and far more momentum than the narrow-bodies.',
  mass: 180_000,
  thrust: 316_000,
  thrustLabel: '2 × 71,000 lbf',
  wingArea: 360.5,
  chord: 6.27,
  inertia: [32_000_000, 44_000_000, 14_000_000],
  flyByWire: true,
  flapLabels: ['Up', '5', '15', '20', '30'],
  fuelCapacity: 101_500,
  fuelDump: true,
  gear: { y: 5, noseZ: -24, mainX: 4.9, mainZ: 1.6 },
  stallSpeed: 111,
  flapSpeeds: [240, 220, 210, 180],
  gearSpeed: 270,
  vmo: 350,
  mmo: 0.9,
  // Boeing's published approach speed, 153 kt at maximum landing weight, needs less lift
  // from the flaps than the narrow-bodies get
  flapLift: 0.8,
  climb: 2700,
  shape: {
    type: 'airliner',
    radius: 2.95,
    tall: 1,
    noseZ: -27.5,
    tailZ: 35.3,
    decks: 1,
    wing: {
      halfSpan: 30,
      y: -1.6,
      dihedral: 0.12,
      rootZ: -6.5,
      tipZ: 10.5,
      rootChord: 11.5,
      tipChord: 2.2,
      tip: 'raked'
    },
    engines: [[9.7, -9.5]],
    engineRadius: 1.75,
    engineLength: 6.5,
    engineY: -2.6,
    tailSpan: 19,
    finHeight: 9,
    paint: '#f4f4f2',
    accent: '#1d3a8f'
  }
})

const A380 = airliner({
  id: 'a380',
  name: 'Airbus A380',
  label: 'A380',
  role: 'Double-deck airliner',
  description:
    'Four engines and 390 tonnes on an 80-metre wing. Everything takes time: plan your turns and your stop well ahead.',
  mass: 390_000,
  thrust: 334_000,
  thrustLabel: '4 × 75,000 lbf',
  wingArea: 845,
  chord: 11,
  inertia: [130_000_000, 200_000_000, 80_000_000],
  flyByWire: true,
  pitchLimit: true,
  flapLabels: ['0', '1', '2', '3', 'FULL'],
  fuelCapacity: 254_000,
  fuelDump: true,
  gear: { y: 6.6, noseZ: -28, mainX: 6.2, mainZ: 2 },
  stallSpeed: 100,
  flapSpeeds: [263, 220, 196, 182],
  gearSpeed: 250,
  vmo: 340,
  mmo: 0.89,
  // Only the two inner engines have reversers
  reverseThrust: 0.2,
  climb: 2000,
  shape: {
    type: 'airliner',
    radius: 3.57,
    tall: 1.18,
    noseZ: -31,
    tailZ: 41.7,
    decks: 2,
    wing: {
      halfSpan: 39.9,
      y: -2.2,
      dihedral: 0.1,
      rootZ: -9,
      tipZ: 14.8,
      rootChord: 17.5,
      tipChord: 4,
      tip: 'fence'
    },
    engines: [
      [14.9, -9.5],
      [25.7, -1.5]
    ],
    engineRadius: 1.9,
    engineLength: 6,
    engineY: -4.3,
    tailSpan: 30.4,
    finHeight: 13,
    paint: '#f4f4f2',
    accent: '#16406e'
  }
})

/**
 * Concorde: four Olympus engines with reheat, an ogival delta wing, and a nose that droops
 * for takeoff and landing. Its analog fly-by-wire trims the aircraft and limits the angle of
 * attack, but nothing limits the bank.
 */
function concorde(): AircraftSpec {
  // Full tanks bring it to its 185 t maximum takeoff weight
  const mass = 118_000
  const weight = mass * GRAVITY
  const gear = { y: 5.4, noseZ: -16, mainX: 3.85, mainZ: 8 }
  const noseShare = gear.mainZ / (gear.mainZ - gear.noseZ)
  // The nose strut is stiff enough to take the extra load of full braking and the nose
  // coming down after touchdown
  const [noseSpring, noseDamper] = spring(weight * noseShare, 0.08)
  const [mainSpring, mainDamper] = spring((weight * (1 - noseShare)) / 2, 0.22)
  const shape: AirlinerShape = {
    type: 'airliner',
    variant: 'concorde',
    radius: 1.45,
    tall: 1.05,
    noseZ: -32,
    tailZ: 29.7,
    decks: 1,
    wing: {
      halfSpan: 12.8,
      y: -0.9,
      dihedral: -0.02,
      rootZ: -14,
      tipZ: 21.5,
      rootChord: 40.5,
      tipChord: 3.5,
      tip: 'raked'
    },
    // Two engines side by side in each nacelle under the wing
    engines: [
      [2.55, 7],
      [4.15, 7]
    ],
    engineRadius: 0.75,
    engineLength: 19,
    engineY: -2,
    tailSpan: 0,
    finHeight: 8.6,
    paint: '#f6f6f4',
    accent: '#1d3566'
  }
  return {
    id: 'concorde',
    name: 'Concorde',
    label: 'Concorde',
    role: 'Supersonic airliner',
    description:
      'Mach 2 above 55,000 ft on four reheated engines. Droop the nose with F to see the runway, and land fast and nose-high.',
    stats: { power: '4 × 38,050 lbf', topSpeed: 1180, stallSpeed: 135, climb: 5000 },

    mass,
    inertiaPitch: 20_000_000,
    inertiaYaw: 23_000_000,
    inertiaRoll: 2_500_000,
    wingArea: 358,
    wingSpan: 25.6,
    chord: 18,

    // A slender delta: a shallow lift slope, but vortex lift carries it to steep angles
    cl0: 0.02,
    clAlpha: 3,
    flapLift: 0,
    stallAlpha: 0.4,
    negativeStallAlpha: 0.25,
    flapStallShift: 0,
    stallSharpness: 22,
    stallHysteresis: 0.06,
    stallWarningMargin: 0.05,

    cd0: 0.0085,
    gearDrag: 0.012,
    flapDrag: 0.002,
    inducedDrag: 0.217,
    sideDrag: 0.4,
    sideForce: -0.5,
    waveDrag: 0.004,
    speedBrakeDrag: 0,
    liftDump: 0,

    cm0: 0.07,
    cmAlpha: -0.6,
    cmPitchRate: -3,
    cmElevator: 0.25,
    cmTrim: 0.3,
    cmStall: -0.05,

    clBeta: -0.07,
    clRollRate: -0.5,
    clYawRate: 0.05,
    clAileron: 0.035,
    stallRollBias: 0.008,

    cnBeta: 0.3,
    cnYawRate: -0.38,
    cnRollRate: -0.01,
    cnRudder: 0.09,
    cnAileron: -0.002,

    // Ram air in the intakes raises thrust with speed, enough to cruise at Mach 2.02
    // without reheat, as the real aircraft did
    engine: {
      type: 'jet',
      idleThrust: 20_000,
      militaryThrust: 557_000,
      afterburnerThrust: 677_000,
      afterburnerFrom: 0.85,
      speedLapse: -0.08
    },
    engineCount: 4,
    spoolSeconds: 3,
    starterSeconds: 5,
    fuelCapacity: 95_000,
    fuelDump: true,
    // Reheat burns about 1.4 kg of fuel per newton each hour
    fuelBurnIdle: 0.5,
    fuelBurnFull: 27,
    fuelUnit: { label: 'kg', perKg: 1 },

    flapLabels: ['Up', '5°', '12.5°'],
    flapName: 'Nose',
    flapSpeeds: [325, 270],
    gearSpeed: 270,
    flapSecondsPerNotch: 3,
    retractableGear: true,
    gearSeconds: 7,
    reverseThrust: 0.3,
    // Stops the nose at 25° up, well past a normal 13° rotation, so a long pull cannot loop it
    flyByWire: { alphaMargin: 0.05, maxBank: Number.POSITIVE_INFINITY, maxPitch: 0.44 },
    autobrake: true,

    maneuverSpeed: 165,
    neverExceedSpeed: 530 * KNOT,
    maxMach: 2.04,
    maxTouchdownSink: 4.5,
    gearTravel: 0.6,
    brakeFriction: 0.5,
    sideFriction: 0.8,
    maxSteerAngle: 0.6,

    contactPoints: [
      wheel(0, -gear.y, gear.noseZ, noseSpring, noseDamper, 'nose'),
      wheel(-gear.mainX, -gear.y, gear.mainZ, mainSpring, mainDamper, 'main'),
      wheel(gear.mainX, -gear.y, gear.mainZ, mainSpring, mainDamper, 'main'),
      // Retractable tail bumper wheel, for an over-rotation on takeoff
      skid(0.2, 26, mainSpring)
    ],
    hullPoints: [
      hull(0, -0.3, -31.5, true),
      hull(0, -1.45, 0, true),
      hull(-12.8, -1.4, 22.5),
      hull(12.8, -1.4, 22.5),
      hull(0, 1.5 + 8.6, 27.5),
      hull(0, 1.5, -20),
      hull(-3.3, -2.8, 12, true),
      hull(3.3, -2.8, 12, true)
    ],
    restHeight: gear.y - 0.2,
    wingtips: [new Vector3(-12.8, -1.4, 22.5), new Vector3(12.8, -1.4, 22.5)],
    breakup: [
      part(0, 0, 4, 1.45),
      part(0, 0, -22, 1.3),
      part(-6.5, -1, 14, 1.2),
      part(6.5, -1, 14, 1.2),
      part(0, 3, 25, 1)
    ],

    rotateSpeed: 195,
    climbSpeed: 250,
    approachSpeed: 165,
    cruiseSpeed: 150,
    runwayNeeded: 3000,
    gauges: {
      airspeed: {
        min: 0,
        max: 600,
        labelEvery: 100,
        tickEvery: 20,
        flapRange: [135, 270],
        normalRange: [180, 500],
        cautionRange: [500, 530]
      },
      climb: 6000,
      power: {
        caption: 'N2 %',
        max: 110,
        labelEvery: 20,
        tickEvery: 5,
        labelScale: 1,
        normalRange: [20, 100],
        redline: 104
      }
    },
    panel: 'glass',
    camera: { distance: 95, height: 24, eye: new Vector3(-0.5, 0.7, -24.3) },
    shape
  }
}

const CONCORDE = concorde()

/**
 * The B-2 Spirit, from its published figures: 52.4 m span, 21 m long, 478 m² of wing,
 * 71,700 kg empty, 75,750 kg of fuel, four 77 kN F118 turbofans with no afterburner,
 * 550 kt at 40,000 ft, and a 50,000 ft ceiling. The aerodynamics follow from that shape:
 * a flying wing of aspect ratio 5.7, swept 33°, with no flaps, no fin, and no reversers.
 */
function b2(): AircraftSpec {
  // Empty, plus crew, a light load, and the 30% of the tanks every listed mass includes
  const mass = 104_000
  const weight = mass * GRAVITY
  const gear = { y: 3.2, noseZ: -6, mainX: 6, mainZ: 1 }
  const noseShare = gear.mainZ / (gear.mainZ - gear.noseZ)
  const [noseSpring, noseDamper] = spring(weight * noseShare, 0.08)
  const [mainSpring, mainDamper] = spring((weight * (1 - noseShare)) / 2, 0.22)
  const halfSpan = 26.2
  // Leading edge swept 33° from the nose; the trailing edge zigzags back to the centre
  const shape: BomberShape = {
    type: 'bomber',
    outline: [
      [0, -10.5],
      [halfSpan, 6.5],
      [halfSpan, 7.6],
      [13.5, 8.3],
      [8.5, 5],
      [0, 10.5]
    ],
    engines: [
      [3.6, 0],
      [5.8, 0]
    ],
    paint: '#3d4147',
    accent: '#2a2d32'
  }
  return {
    id: 'b2',
    name: 'B-2 Spirit',
    label: 'B-2',
    role: 'Stealth strategic bomber',
    description:
      'A flying wing with no tail. The computers keep it pointing straight. It has no flaps, so it lands fast and floats a long way.',
    stats: { power: '4 × 17,300 lbf', topSpeed: 550, stallSpeed: 108, climb: 3000 },

    mass,
    // Mass spread along the span: hard to roll, easy to pitch, as the whole aircraft is
    // only 21 m long
    inertiaPitch: 1_900_000,
    inertiaYaw: 7_000_000,
    inertiaRoll: 5_200_000,
    wingArea: 478,
    wingSpan: halfSpan * 2,
    chord: 12,

    // Lift slope of a wing of aspect ratio 5.7 swept about 20° at mid-chord. Without flaps
    // it stalls near CL 1.1, about 108 kt at landing weight.
    cl0: 0.05,
    clAlpha: 4.28,
    flapLift: 0,
    stallAlpha: 0.255,
    negativeStallAlpha: 0.2,
    flapStallShift: 0,
    stallSharpness: 30,
    stallHysteresis: 0.07,
    stallWarningMargin: 0.06,

    // A clean flying wing: with an efficiency of 0.8, this drag gives the reported best
    // lift-to-drag ratio of about 19
    cd0: 0.0095,
    // Two big four-wheel bogies and their doors: the only drag it has to slow down on final
    gearDrag: 0.02,
    flapDrag: 0,
    inducedDrag: 0.069,
    sideDrag: 0.4,
    sideForce: -0.3,
    // Drag rises toward Mach 0.95, the published top speed
    dragRiseMach: 0.95,
    waveDrag: 0.03,
    // The split drag rudders at the wingtips open together as an airbrake
    speedBrakeDrag: 0.04,
    liftDump: 0.1,

    // Relaxed stability: the centre of gravity sits a few per cent of the chord ahead of
    // the neutral point, and the fly-by-wire does the rest. The elevons pitch and roll it.
    cm0: 0.015,
    cmAlpha: -0.25,
    cmPitchRate: -4,
    cmElevator: 0.15,
    cmTrim: 0.25,
    cmStall: -0.05,

    // Roll damping of a pointed, untapered wing, and the dihedral effect of its sweep
    clBeta: -0.05,
    clRollRate: -0.36,
    clYawRate: 0.06,
    clAileron: 0.045,
    stallRollBias: 0.006,

    // With no fin the bare airframe barely points into the wind. The flight computers
    // work the split drag rudders to make it behave as if it had one.
    cnBeta: 0.05,
    cnYawRate: -0.15,
    cnRollRate: -0.01,
    cnRudder: 0.02,
    cnAileron: -0.002,

    // Thrust falls off with speed so that full power gives the published 550 kt at
    // 40,000 ft, and about 520 kt low down
    engine: {
      type: 'jet',
      idleThrust: 12_300,
      militaryThrust: 308_000,
      afterburnerThrust: 308_000,
      afterburnerFrom: 1,
      speedLapse: 0.45
    },
    engineCount: 4,
    spoolSeconds: 4,
    starterSeconds: 5,
    fuelCapacity: 75_750,
    fuelDump: false,
    // Eighty 500 lb bombs, the B-2's full load of the smallest kind
    bombBay: 80,
    // About 0.6 kg of fuel per newton of thrust each hour at full power
    fuelBurnIdle: 0.3,
    fuelBurnFull: 5.2,
    fuelUnit: { label: 'kg', perKg: 1 },

    flapLabels: ['Up'],
    flapName: 'Flaps',
    flapSpeeds: [],
    gearSpeed: 230,
    flapSecondsPerNotch: 1,
    retractableGear: true,
    gearSeconds: 8,
    reverseThrust: 0,
    flyByWire: { alphaMargin: 0.05, maxBank: 1.15, maxPitch: 0.44 },
    autobrake: true,

    // Where a full pull reaches the stall and a bomber's +2.5 g together
    maneuverSpeed: 88,
    // Mach 0.95 at sea level
    neverExceedSpeed: 600 * KNOT,
    maxMach: 0.95,
    maxTouchdownSink: 4.5,
    gearTravel: 0.55,
    brakeFriction: 0.5,
    sideFriction: 0.8,
    maxSteerAngle: 0.6,

    contactPoints: [
      wheel(0, -gear.y, gear.noseZ, noseSpring, noseDamper, 'nose'),
      wheel(-gear.mainX, -gear.y, gear.mainZ, mainSpring, mainDamper, 'main'),
      wheel(gear.mainX, -gear.y, gear.mainZ, mainSpring, mainDamper, 'main'),
      // The centre trailing edge scrapes before the wing breaks on an over-rotation
      skid(-0.45, 10, mainSpring)
    ],
    hullPoints: [
      hull(0, -0.2, -10.3, true),
      hull(0, -1.3, 0, true),
      hull(-halfSpan, 0.4, 7),
      hull(halfSpan, 0.4, 7),
      hull(0, 2.1, -4),
      hull(0, -0.1, 10.3, true),
      hull(-13.5, -0.3, 8.2, true),
      hull(13.5, -0.3, 8.2, true)
    ],
    restHeight: gear.y - 0.2,
    wingtips: [new Vector3(-halfSpan, 0.4, 7), new Vector3(halfSpan, 0.4, 7)],
    breakup: [
      part(0, 0, 0, 2.5),
      part(0, 0.5, -6.5, 1.5),
      part(-15, 0, 4, 2),
      part(15, 0, 4, 2),
      part(0, 0, 8, 1.5)
    ],

    // Lifts off near 150 kt and lands near 140 kt with no flaps to slow it
    rotateSpeed: 150,
    climbSpeed: 250,
    approachSpeed: 140,
    cruiseSpeed: 125,
    // Published takeoff run 2,040 m at full weight
    runwayNeeded: 2600,
    gauges: {
      airspeed: {
        min: 0,
        max: 650,
        labelEvery: 100,
        tickEvery: 20,
        flapRange: null,
        normalRange: [150, 560],
        cautionRange: [560, 600]
      },
      climb: 6000,
      power: {
        caption: 'N2 %',
        max: 110,
        labelEvery: 20,
        tickEvery: 5,
        labelScale: 1,
        normalRange: [20, 100],
        redline: 104
      }
    },
    panel: 'glass',
    camera: { distance: 85, height: 22, eye: new Vector3(-0.6, 1.5, -6.8) },
    shape
  }
}

const B2 = b2()

/** Values the two fighters share. */
const FIGHTER = {
  flapSecondsPerNotch: 1,
  retractableGear: true,
  gearSeconds: 4,
  // No thrust reversers, and the flight computer lowers the flaps with the gear
  reverseThrust: 0,
  autobrake: false,
  flapLabels: ['Up', 'Down'],
  flapName: 'Flaps' as const,
  flapSpeeds: [300],
  autoFlaps: true,
  gearSpeed: 300,
  engineCount: 1,
  spoolSeconds: 2,
  starterSeconds: 4,
  fuelUnit: { label: 'kg', perKg: 1 },
  stallSharpness: 28,
  stallHysteresis: 0.12,
  stallWarningMargin: 0.1,
  flapStallShift: 0.03,
  sideDrag: 0.5,
  sideForce: -0.9,
  waveDrag: 0.03,
  speedBrakeDrag: 0.06,
  liftDump: 0.1,
  maxTouchdownSink: 6,
  gearTravel: 0.45,
  brakeFriction: 0.55,
  sideFriction: 0.8,
  maxSteerAngle: 0.35,
  panel: 'hud' as const,
  climb: 6000
}

const fighterGauges = (maxPower: string): GaugeSpec => ({
  airspeed: {
    min: 0,
    max: 900,
    labelEvery: 100,
    tickEvery: 50,
    flapRange: [130, 300],
    normalRange: [140, 700],
    cautionRange: [700, 800]
  },
  climb: 6000,
  power: {
    caption: maxPower,
    max: 110,
    labelEvery: 20,
    tickEvery: 5,
    labelScale: 1,
    normalRange: [60, 100],
    redline: 104
  }
})

const F16: AircraftSpec = {
  ...FIGHTER,
  id: 'f16',
  name: 'F-16 Fighting Falcon',
  label: 'F-16',
  role: 'Single-engine jet fighter',
  description:
    'Twenty-nine thousand pounds of thrust with the afterburner lit. Fly-by-wire holds it short of the stall. Everything happens fast.',
  stats: { power: '29,000 lbf', topSpeed: 1176, stallSpeed: 128, climb: 50_000 },

  mass: 11_000,
  inertiaPitch: 75_674,
  inertiaYaw: 85_552,
  inertiaRoll: 12_875,
  wingArea: 27.87,
  wingSpan: 9.96,
  chord: 3.45,

  cl0: 0.04,
  clAlpha: 3.5,
  flapLift: 0.35,
  stallAlpha: 0.52,
  negativeStallAlpha: 0.35,

  cd0: 0.021,
  gearDrag: 0.03,
  flapDrag: 0.04,
  inducedDrag: 0.141,

  cm0: 0.02,
  cmAlpha: -0.35,
  cmPitchRate: -14,
  cmElevator: 0.2,
  cmTrim: 0.25,
  cmStall: -0.01,

  clBeta: -0.05,
  clRollRate: -0.35,
  clYawRate: 0.03,
  clAileron: 0.045,
  stallRollBias: 0.004,

  cnBeta: 0.15,
  cnYawRate: -0.3,
  cnRollRate: 0,
  cnRudder: 0.03,
  cnAileron: -0.002,

  engine: {
    type: 'jet',
    idleThrust: 4000,
    militaryThrust: 76_000,
    afterburnerThrust: 127_000,
    afterburnerFrom: 0.85,
    // Ram air lifts the thrust with speed: about 800 kt low down, Mach 1.85 high up
    speedLapse: -0.2
  },
  fuelCapacity: 3200,
  fuelDump: false,
  fuelBurnIdle: 0.12,
  fuelBurnFull: 7,
  flyByWire: { alphaMargin: 0.08, maxBank: Number.POSITIVE_INFINITY },

  maneuverSpeed: 170,
  neverExceedSpeed: 800 * KNOT,
  maxMach: 2.05,

  contactPoints: [
    wheel(0, -1.6, -3.5, 160_000, 22_000, 'nose'),
    wheel(-1.2, -1.6, 0.55, 350_000, 45_000, 'main'),
    wheel(1.2, -1.6, 0.55, 350_000, 45_000, 'main'),
    skid(-0.55, 6.9, 300_000)
  ],
  hullPoints: [
    hull(0, -0.35, -7.5, true),
    hull(0, -1, -1, true),
    hull(-4.7, -0.1, 2),
    hull(4.7, -0.1, 2),
    hull(0, 3.4, 6.4),
    hull(0, 1.25, -3.3)
  ],
  restHeight: 1.49,
  wingtips: [new Vector3(-4.7, 0, 2.6), new Vector3(4.7, 0, 2.6)],
  breakup: [
    part(0, 0, 1, 1.1),
    part(0, 0.1, -5.5, 0.6),
    part(-2.9, 0, 1.6, 0.35),
    part(2.9, 0, 1.6, 0.35),
    part(0, 1.2, 6, 0.7)
  ],

  rotateSpeed: 150,
  climbSpeed: 300,
  approachSpeed: 150,
  cruiseSpeed: 180,
  runwayNeeded: 1400,
  gauges: fighterGauges('RPM %'),
  camera: { distance: 27, height: 7.5, eye: new Vector3(0, 1.15, -3.6) },
  shape: { type: 'fighter', variant: 'f16', paint: '#8d959c', accent: '#5d666e' }
}

const F35: AircraftSpec = {
  ...FIGHTER,
  id: 'f35',
  name: 'F-35A Lightning II',
  label: 'F-35A',
  role: 'Stealth strike fighter',
  description:
    'Heavier and wider than the F-16, with the most powerful fighter engine ever built. It flies at angles of attack that would stall anything else here.',
  stats: { power: '43,000 lbf', topSpeed: 1040, stallSpeed: 120, climb: 45_000 },

  // Empty, with internal weapons and 30% fuel
  mass: 18_000,
  inertiaPitch: 160_000,
  inertiaYaw: 190_000,
  inertiaRoll: 40_000,
  wingArea: 42.7,
  wingSpan: 10.7,
  chord: 4.3,

  cl0: 0.05,
  clAlpha: 3.3,
  flapLift: 0.4,
  stallAlpha: 0.65,
  negativeStallAlpha: 0.4,

  cd0: 0.022,
  gearDrag: 0.03,
  flapDrag: 0.04,
  inducedDrag: 0.15,

  cm0: 0.02,
  cmAlpha: -0.35,
  cmPitchRate: -16,
  cmElevator: 0.25,
  cmTrim: 0.3,
  cmStall: -0.01,

  clBeta: -0.05,
  clRollRate: -0.35,
  clYawRate: 0.03,
  clAileron: 0.04,
  stallRollBias: 0.004,

  cnBeta: 0.16,
  cnYawRate: -0.32,
  cnRollRate: 0,
  cnRudder: 0.03,
  cnAileron: -0.002,

  engine: {
    type: 'jet',
    idleThrust: 6000,
    militaryThrust: 125_000,
    afterburnerThrust: 191_000,
    afterburnerFrom: 0.85,
    // Ram air lifts the thrust a little: 700 kt low down, Mach 1.6 high up
    speedLapse: -0.05
  },
  fuelCapacity: 8300,
  fuelDump: true,
  fuelBurnIdle: 0.2,
  fuelBurnFull: 9.5,
  flyByWire: { alphaMargin: 0.1, maxBank: Number.POSITIVE_INFINITY },

  maneuverSpeed: 175,
  neverExceedSpeed: 700 * KNOT,
  maxMach: 1.6,

  contactPoints: [
    wheel(0, -1.9, -4, 260_000, 40_000, 'nose'),
    wheel(-2, -1.9, 0.6, 620_000, 85_000, 'main'),
    wheel(2, -1.9, 0.6, 620_000, 85_000, 'main'),
    skid(-0.6, 7, 500_000)
  ],
  hullPoints: [
    hull(0, -0.4, -7.6, true),
    hull(0, -1.1, -1, true),
    hull(-5.3, -0.1, 2.6),
    hull(5.3, -0.1, 2.6),
    hull(0, 2.7, 6.6),
    hull(0, 1.3, -4)
  ],
  restHeight: 1.78,
  wingtips: [new Vector3(-5.3, 0, 3), new Vector3(5.3, 0, 3)],
  breakup: [
    part(0, 0, 1.2, 1.3),
    part(0, 0.1, -5.6, 0.7),
    part(-3.3, 0, 1.8, 0.4),
    part(3.3, 0, 1.8, 0.4),
    part(0, 1.2, 6.2, 0.8)
  ],

  rotateSpeed: 150,
  climbSpeed: 300,
  approachSpeed: 150,
  cruiseSpeed: 180,
  runwayNeeded: 1400,
  gauges: fighterGauges('RPM %'),
  camera: { distance: 28, height: 7.5, eye: new Vector3(0, 1.2, -4.4) },
  shape: { type: 'fighter', variant: 'f35', paint: '#6f767d', accent: '#4c5359' }
}

/**
 * P-51D Mustang, from its published figures: 11.28 m span, 21.65 m² of wing, 9.83 m long,
 * 4,173 kg loaded with 269 US gal of fuel, a 1,490 hp Packard Merlin V-1650-7 at 3,000 rpm
 * turning a 3.4 m four-blade propeller, stalling at 102 mph clean and 95 mph with gear and
 * flaps down at 9,000 lb. NASA SP-468 gives a zero-lift drag coefficient of 0.0163 and a
 * best lift-to-drag ratio of 14.6. A tail-dragger: it sits nose-high on its tail wheel.
 */
function mustang(): AircraftSpec {
  // 269 US gal of avgas weighs 733 kg; the listed mass keeps 30% of it
  const fuelCapacity = 733
  const mass = 4173 - fuelCapacity * 0.7
  const weight = mass * GRAVITY
  // The tail wheel sits high enough in body axes that the aircraft parks 11.5° nose-up
  const main = { x: 1.8, y: -1.95, z: -0.55 }
  const tail = { y: -0.82, z: 5.05 }
  // At that attitude the centre of gravity is 0.93 m behind the main wheels and the tail
  // wheel 5.7 m behind them, so the tail wheel carries 16% of the weight
  const tailShare = 0.16
  const [mainSpring, mainDamper] = spring((weight * (1 - tailShare)) / 2, 0.1)
  const [tailSpring, tailDamper] = spring(weight * tailShare, 0.06)
  const halfSpan = 5.64
  const tipY = -0.55 + halfSpan * Math.sin(0.087)
  return {
    id: 'p51',
    name: 'P-51D Mustang',
    label: 'P-51D',
    role: 'Piston fighter',
    description:
      'A 1,490 hp Merlin on a tail-dragger. Hold right rudder as the power comes up, raise the tail before it flies, and go easy on the brakes.',
    stats: { power: '1,490 hp', topSpeed: 380, stallSpeed: 87, climb: 3200 },

    mass,
    // From the parts' masses and distances: the engine and propeller far forward, the guns
    // and their ammunition out in the wings
    inertiaPitch: 12_000,
    inertiaYaw: 16_500,
    inertiaRoll: 5500,
    wingArea: 21.65,
    wingSpan: halfSpan * 2,
    // Mean aerodynamic chord of a 2.6 m root tapering to a 1.25 m tip
    chord: 2,

    // Lift slope of an unswept wing of aspect ratio 5.9 with the fuselage. The wing sits
    // about 1° up on the thrust line. Clean it stalls near CL 1.45, which is the manual's
    // 102 mph at 9,000 lb; the flaps add the little the manual shows for 95 mph.
    cl0: 0.15,
    clAlpha: 4.5,
    flapLift: 0.35,
    stallAlpha: 0.29,
    negativeStallAlpha: 0.2,
    flapStallShift: 0.03,
    // The laminar-flow wing stalls abruptly, with little buffet first
    stallSharpness: 45,
    stallHysteresis: 0.08,
    stallWarningMargin: 0.05,

    // With an efficiency of 0.75, this drag gives NASA's best lift-to-drag ratio of 14.6
    cd0: 0.0163,
    gearDrag: 0.016,
    flapDrag: 0.07,
    inducedDrag: 0.072,
    sideDrag: 0.6,
    sideForce: -0.6,
    // The thin laminar wing meets shock waves from about Mach 0.7
    dragRiseMach: 0.7,
    waveDrag: 0.05,
    speedBrakeDrag: 0,
    liftDump: 0,

    // About 10% static margin with the fuselage tank low, trimmed hands-off near 250 kt.
    // The elevator and the 3.8 m² tail, 5.3 m behind the wing, give the pitch damping and
    // authority.
    cm0: 0.01,
    cmAlpha: -0.6,
    cmPitchRate: -11,
    cmElevator: 0.3,
    cmTrim: 0.12,
    cmStall: -0.05,

    // A full aileron roll of about 100°/s at 300 mph, from NACA's measured pb/2V of 0.075
    clBeta: -0.06,
    clRollRate: -0.45,
    clYawRate: 0.05,
    clAileron: 0.034,
    // Engine torque drops the left wing hard at the stall
    stallRollBias: 0.02,

    cnBeta: 0.1,
    cnYawRate: -0.14,
    cnRollRate: -0.02,
    cnRudder: 0.04,
    cnAileron: -0.006,

    // Military power at sea level. Ideal momentum theory gives the 3.4 m propeller about
    // 21 kN of static thrust at 85% efficiency, hence the 45 m/s cap. Torque and P-factor
    // swing the nose left: on the takeoff roll at 50 kt they take two thirds of the rudder.
    engine: {
      type: 'piston',
      shaftPower: 1_111_000,
      propEfficiency: 0.85,
      staticThrustSpeed: 45,
      idlePower: 0.05,
      propYawArm: 0.34,
      propYawFadeSpeed: 70,
      idleRpm: 650,
      maxRpm: 3000,
      // The Merlin's two-stage supercharger holds full power to about 20,700 ft in high
      // blower, which is why the top speed comes up high
      criticalAltitude: 6300
    },
    engineCount: 1,
    spoolSeconds: 0.5,
    starterSeconds: 3,
    fuelCapacity,
    fuelDump: false,
    // The Merlin burns about 150 US gal an hour at military power and 8 at idle
    fuelBurnIdle: 0.006,
    fuelBurnFull: 0.113,
    fuelUnit: { label: 'gal', perKg: 1 / (3.785 * 0.72) },

    flapLabels: ['Up', '15°', '30°', '50°'],
    flapName: 'Flaps',
    // Flaps 165 mph and gear 170 mph, from the pilot's manual
    flapSpeeds: [143, 143, 143],
    gearSpeed: 148,
    flapSecondsPerNotch: 3,
    retractableGear: true,
    gearSeconds: 8,
    reverseThrust: 0,
    flyByWire: null,
    autobrake: false,

    // Where a full pull reaches the stall and the +8 g limit together
    maneuverSpeed: 122,
    // The 505 mph dive limit, and the Mach 0.8 where compressibility takes the controls away
    neverExceedSpeed: 439 * KNOT,
    maxMach: 0.8,
    maxTouchdownSink: 5,
    gearTravel: 0.4,
    // Hard braking with the tail up stands it on its nose
    brakeFriction: 0.45,
    sideFriction: 0.8,
    maxSteerAngle: 0,

    contactPoints: [
      // The tail wheel locks straight; differential brakes and the rudder steer
      {
        position: new Vector3(0, tail.y, tail.z),
        stiffness: tailSpring,
        damping: tailDamper,
        gear: true,
        braked: false,
        steered: false,
        scrape: 0
      },
      wheel(-main.x, main.y, main.z, mainSpring, mainDamper, 'main'),
      wheel(main.x, main.y, main.z, mainSpring, mainDamper, 'main')
    ],
    hullPoints: [
      // The lower propeller tip clears the runway by about 30 cm with the tail up
      hull(0, -1.65, -3.45, true),
      hull(0, -1.1, 0.8, true),
      hull(-halfSpan, tipY, 0.45),
      hull(halfSpan, tipY, 0.45),
      hull(0, 1.55, 5.6),
      hull(0, 1.05, 0.4),
      hull(0, -0.35, 5.8, true)
    ],
    restHeight: 1.7,
    wingtips: [new Vector3(-halfSpan, tipY, 0.45), new Vector3(halfSpan, tipY, 0.45)],
    breakup: [
      part(0, -0.1, 0.8, 0.7),
      part(0, 0, -2.6, 0.5),
      part(-2.9, -0.35, 0.4, 0.4),
      part(2.9, -0.35, 0.4, 0.4),
      part(0, 0.3, 5.2, 0.5)
    ],

    // Lifts off near 110 mph, climbs at 170 mph, and flies its final turn at 120 mph
    rotateSpeed: 95,
    climbSpeed: 150,
    approachSpeed: 105,
    cruiseSpeed: 130,
    runwayNeeded: 900,
    gauges: {
      airspeed: {
        min: 40,
        max: 500,
        labelEvery: 50,
        tickEvery: 10,
        flapRange: [80, 143],
        normalRange: [87, 350],
        cautionRange: [350, 439]
      },
      climb: 4000,
      power: {
        caption: 'RPM × 100',
        max: 3500,
        labelEvery: 500,
        tickEvery: 100,
        labelScale: 100,
        normalRange: [1600, 2700],
        redline: 3000
      }
    },
    panel: 'dials',
    camera: { distance: 16, height: 4.2, eye: new Vector3(0, 0.82, 0.55) },
    shape: {
      type: 'propeller',
      variant: 'mustang',
      noseZ: -3.85,
      tailZ: 5.98,
      cabinRadius: 0.5,
      wingY: -0.55,
      dihedral: 0.087,
      highWing: false,
      tailSpan: 4.1,
      finHeight: 1.5,
      propRadius: 1.7,
      // Natural metal with a red spinner
      paint: '#c9ced3',
      accent: '#b5262b'
    }
  }
}

const P51 = mustang()

/**
 * The Space Shuttle orbiter on its return, from NASA's figures: 37.24 m long, 23.79 m span,
 * 249.9 m² of wing with a 12.06 m mean chord, about 100 t at landing, and a subsonic
 * lift-to-drag ratio of 4.5. It glides all the way down: an outer glideslope of 18-20° at
 * 300 KEAS, a preflare at 2,000 ft onto a 1.5° inner glideslope, the gear at 300 ft, and
 * touchdown near 195 KEAS. Its "engine" stands for the three hydrazine APUs that power
 * the hydraulics: they start, run, and use fuel, but give no thrust.
 */
function shuttle(): AircraftSpec {
  const mass = 100_000
  const weight = mass * GRAVITY
  const gear = { y: 4, noseZ: -16.5, mainX: 3.45, mainZ: 6 }
  const noseShare = gear.mainZ / (gear.mainZ - gear.noseZ)
  const [noseSpring, noseDamper] = spring(weight * noseShare, 0.08)
  const [mainSpring, mainDamper] = spring((weight * (1 - noseShare)) / 2, 0.2)
  const halfSpan = 11.9
  // The 81° glove meets the 45° main wing a third of the way out; the trailing edge is
  // nearly straight across the elevons
  const shape: ShuttleShape = {
    type: 'shuttle',
    outline: [
      [0, -21.6],
      [1.6, -19.8],
      [2.5, -16.5],
      [2.6, -7.9],
      [4.5, 4.1],
      [halfSpan, 11.5],
      [halfSpan, 13.9],
      [2.9, 14.8],
      [2.9, 15.6],
      [0, 15.6]
    ],
    paint: '#f1f0ec',
    accent: '#22262b'
  }
  return {
    id: 'shuttle',
    name: 'Space Shuttle Orbiter',
    label: 'Shuttle',
    role: 'Unpowered orbital glider',
    description:
      'No engines on the way home: one try at the runway. Dive steeply at 300 kt with the speed brake, flare at 2,000 ft, and drop the gear at 300 ft.',
    stats: { power: 'None: a glider', topSpeed: 333, stallSpeed: 147, climb: 0 },

    mass,
    // About 0.9, 6.5, and 6.8 million slug ft² near landing weight: long and heavy at both
    // ends, so slow to pitch and yaw, quick to roll
    inertiaPitch: 8_700_000,
    inertiaYaw: 9_100_000,
    inertiaRoll: 1_200_000,
    wingArea: 249.9,
    wingSpan: halfSpan * 2,
    chord: 12.06,

    // A delta of aspect ratio 2.27 has a lift slope near 2.9 per radian. That puts the
    // 195 KEAS touchdown at 11° angle of attack, below the 14° that scrapes the body flap.
    // Vortex lift carries it to about CL 1.1 at 20°.
    cl0: 0.08,
    clAlpha: 2.9,
    flapLift: 0,
    stallAlpha: 0.35,
    negativeStallAlpha: 0.25,
    flapStallShift: 0,
    stallSharpness: 25,
    stallHysteresis: 0.06,
    stallWarningMargin: 0.06,

    // A blunt base and a delta that keeps little leading-edge suction: these give the best
    // lift-to-drag ratio of 4.5 near 250 KEAS, and a 14° glide at 300 KEAS
    cd0: 0.044,
    gearDrag: 0.018,
    flapDrag: 0,
    inducedDrag: 0.28,
    sideDrag: 0.4,
    sideForce: -0.5,
    // Transonic drag rise halves the lift-to-drag ratio by Mach 1
    dragRiseMach: 0.8,
    waveDrag: 0.06,
    // The split rudder opens as a speed brake: fully open it steepens the 300 KEAS glide to
    // 23°. The real one was held part open to stay on the 18-20° outer glideslope.
    speedBrakeDrag: 0.045,
    liftDump: 0,

    // Barely stable in pitch, with the digital fly-by-wire flying the elevons and body flap
    cm0: 0.02,
    cmAlpha: -0.2,
    cmPitchRate: -4,
    cmElevator: 0.16,
    cmTrim: 0.2,
    cmStall: -0.04,

    // The elevons roll it at about 35°/s at approach speed
    clBeta: -0.06,
    clRollRate: -0.3,
    clYawRate: 0.05,
    clAileron: 0.015,
    stallRollBias: 0.004,

    cnBeta: 0.1,
    cnYawRate: -0.2,
    cnRollRate: -0.01,
    cnRudder: 0.03,
    cnAileron: -0.004,

    // No thrust at any throttle setting. Idle sits 1 N below zero so the sim's throttle
    // solver, which divides by the span from idle to full thrust, never divides by zero.
    engine: {
      type: 'jet',
      idleThrust: -1,
      militaryThrust: 0,
      afterburnerThrust: 0,
      afterburnerFrom: 1,
      speedLapse: 0
    },
    engineCount: 1,
    spoolSeconds: 1,
    starterSeconds: 5,
    // Three APUs with 159 kg of hydrazine each, burning about 1 kg a minute each, shown
    // in percent of full tanks
    fuelCapacity: 477,
    fuelDump: false,
    fuelBurnIdle: 0.05,
    fuelBurnFull: 0.05,
    fuelUnit: { label: '%', perKg: 100 / 477 },

    flapLabels: ['Up'],
    flapName: 'Flaps',
    flapSpeeds: [],
    gearSpeed: 300,
    flapSecondsPerNotch: 1,
    retractableGear: true,
    gearSeconds: 6,
    reverseThrust: 0,
    flyByWire: { alphaMargin: 0.08, maxBank: Number.POSITIVE_INFINITY },
    // The speed brake opens by itself at touchdown, then the brakes come on. The real
    // orbiter also streamed a drag chute, which this cannot model.
    autobrake: true,

    // Where a full pull reaches the stall and the +2.5 g limit together
    maneuverSpeed: 120,
    // About the 375 lb/ft² dynamic pressure limit for the approach
    neverExceedSpeed: 333 * KNOT,
    maxTouchdownSink: 3,
    gearTravel: 0.45,
    brakeFriction: 0.4,
    sideFriction: 0.8,
    maxSteerAngle: 0.17,

    contactPoints: [
      wheel(0, -gear.y, gear.noseZ, noseSpring, noseDamper, 'nose'),
      wheel(-gear.mainX, -gear.y, gear.mainZ, mainSpring, mainDamper, 'main'),
      wheel(gear.mainX, -gear.y, gear.mainZ, mainSpring, mainDamper, 'main'),
      // The body flap scrapes first on an over-rotation
      skid(-1.6, 15.6, mainSpring)
    ],
    hullPoints: [
      hull(0, -1, -21.2, true),
      hull(0, -1.95, 0, true),
      hull(-halfSpan, -1.55, 12.7),
      hull(halfSpan, -1.55, 12.7),
      hull(0, 13.5, 14.5),
      hull(0, 2.6, -14),
      hull(-6, -1.6, 14.5, true),
      hull(6, -1.6, 14.5, true)
    ],
    restHeight: gear.y - 0.2,
    wingtips: [new Vector3(-halfSpan, -1.55, 12.7), new Vector3(halfSpan, -1.55, 12.7)],
    breakup: [
      part(0, 0, 2, 2.5),
      part(0, 0.5, -17, 2),
      part(-7, -1.6, 8, 2),
      part(7, -1.6, 8, 2),
      part(0, 7, 12, 2)
    ],

    // Touchdown speed, the outer glideslope speed, and a start in the air at 290 KEAS low down
    rotateSpeed: 195,
    climbSpeed: 300,
    approachSpeed: 290,
    cruiseSpeed: 150,
    // Rollouts ran 2,400-3,000 m
    runwayNeeded: 3500,
    gauges: {
      airspeed: {
        min: 0,
        max: 400,
        labelEvery: 50,
        tickEvery: 10,
        flapRange: null,
        normalRange: [185, 300],
        cautionRange: [300, 333]
      },
      climb: 12_000,
      power: {
        caption: 'APU %',
        max: 110,
        labelEvery: 20,
        tickEvery: 5,
        labelScale: 1,
        normalRange: [60, 100],
        redline: 104
      }
    },
    // The commander flew the approach on the head-up display
    panel: 'hud',
    camera: { distance: 70, height: 18, eye: new Vector3(-0.6, 1.9, -16.3) },
    shape
  }
}

const SHUTTLE = shuttle()

/** Every aircraft the player can fly, in picker order. */
export const HANGAR: AircraftSpec[] = [
  CESSNA,
  P51,
  A320,
  B737,
  B787,
  A380,
  CONCORDE,
  F16,
  F35,
  B2,
  SHUTTLE
]
export const DEFAULT_AIRCRAFT = CESSNA

/** True for aircraft with no thrust at all, such as the Shuttle orbiter, which only glide. */
export const isGlider = (spec: AircraftSpec) =>
  spec.engine.type === 'jet' && spec.engine.militaryThrust <= 0

/** Distance of each engine from the centreline, numbered from the left wingtip. */
export function engineArms(spec: AircraftSpec) {
  const { shape } = spec
  if (shape.type !== 'airliner' && shape.type !== 'bomber') return [0]
  const right = shape.engines.map(([x]) => x).sort((a, b) => a - b)
  return [...right.map(x => -x).reverse(), ...right]
}
