import type { Controls, FlightSim } from '../sim/flight-sim'
import { APPROACHES } from '../world/approaches'
import {
  AIRPORTS,
  type Airport,
  CITIES,
  fromStrip,
  heightAt,
  isPaved,
  outside,
  RANGE
} from '../world/island'
import type { Bombs, Target } from './bombs'
import type { TimeOfDay, Weather, WindLevel } from './game'
import type { Navigator } from './navigation'
import type { Pilot } from './pilot'

export type MissionCategory =
  | 'Tutorial'
  | 'Speed Run'
  | 'Airline'
  | 'Challenge'
  | 'Bombing'
  | 'Strike'
export const MISSION_CATEGORIES: MissionCategory[] = [
  'Tutorial',
  'Speed Run',
  'Airline',
  'Challenge',
  'Bombing',
  'Strike'
]

/** A ring to fly through, in order. Heading is in radians. */
export type Gate = { x: number; y: number; z: number; heading: number; radius: number }

/** What a mission can see while it runs. */
export type MissionContext = {
  sim: FlightSim
  controls: Controls
  pilot: Pilot
  nav: Navigator
  /** Seconds since the mission started. */
  time: number
  /** Gates flown through so far. */
  gates: number
  /** The latest touchdown: sink rate in m/s, and whether it was on a runway or taxiway. */
  touchdown: { rate: number; paved: boolean } | null
  /** The airport the aircraft is parked at, engines off and brake set, if any. */
  parkedAt: Airport | null
  /** The bomb bay and its targets, on bombing missions. */
  bombs?: Bombs
  /** True while the player looks through the bombsight. */
  bombsight?: boolean
}

/**
 * A way to fail a mission. With `grace`, the mission fails only once the condition has held
 * that many seconds in total, and the time counts back down while it does not hold. Until
 * then `warning` says what to fix; it marks keys in square brackets.
 */
export type Failure = {
  reason: string | ((context: MissionContext) => string)
  failed: (context: MissionContext) => boolean
  grace?: number
  warning?: (context: MissionContext) => string
}

/** One step. Text marks keys in square brackets, such as [W]. */
export type Objective = {
  text: string
  done: (context: MissionContext) => boolean
  /** Seconds the condition must hold before the step counts. */
  hold?: number
}

/** Where the mission begins. Headings are in degrees, speeds in knots, altitudes in metres. */
export type MissionStart =
  | { kind: 'stand' | 'runway'; airport: string }
  | {
      kind: 'air'
      x: number
      z: number
      altitude: number
      heading: number
      speed: number
      /** Degrees below the horizon to start gliding down, instead of level. */
      glide?: number
      speedBrake?: boolean
    }
  | {
      kind: 'approach'
      approach: string
      distance: number
      speed: number
      flapNotch?: number
      gearDown?: boolean
      /** Level flight at the start instead of descending along the glide path. */
      level?: boolean
    }

export type Mission = {
  id: string
  title: string
  category: MissionCategory
  aircraft: string
  /** One line for the mission list. */
  summary: string
  /** A short paragraph for the briefing. */
  briefing: string
  start: MissionStart
  weather?: Weather
  time?: TimeOfDay
  wind?: WindLevel
  /** Airport code for a flight plan, and an approach to tune in. */
  destination?: string
  approach?: string
  gates?: Gate[]
  /** Seconds allowed, or none. */
  timeLimit?: number
  /** Bombs loaded at the start, and the targets on the range they are for. */
  bombs?: number
  targets?: Target[]
  /** GPS-guided bombs, which steer themselves from the launch zone around a target. */
  guided?: boolean
  /** Guided missiles on the rails, for fighters. */
  missiles?: number
  /** A city to bring down, and how many of its buildings must fall. */
  demolish?: { city: string; goal: number }
  objectives: Objective[]
  /** Ways to fail. The reason can read the context, to quote a figure such as the sink rate. */
  failures?: Failure[]
  /** Runs every frame, for scripted events such as an engine failure. */
  script?: (context: MissionContext) => void
}

const FEET = 0.3048
const FPM = 0.00508
const DEGREES = Math.PI / 180

const airport = (code: string) => {
  const found = AIRPORTS.find(candidate => candidate.code === code)
  if (!found) throw new Error(`Mission airport ${code} does not exist`)
  return found
}

/** True on the ground on one of an airport's runways. */
const onRunwayOf = (code: string) => (context: MissionContext) => {
  const { sim } = context
  const { x, z } = sim.position
  return sim.onGround && airport(code).runways.some(runway => outside(runway, x, z) === 0)
}

const stopped = (context: MissionContext) => context.sim.onGround && context.sim.groundSpeed < 1.5

/** True once the wheels are below `feet` above the tuned runway, or the ground beneath. */
const below = (feet: number) => (context: MissionContext) => {
  const { sim, nav } = context
  const runway = nav.approach ? sim.position.y - nav.approach.end.elevation : sim.altitudeAgl
  return Math.min(runway, sim.altitudeAgl) - sim.spec.restHeight < feet * FEET
}

const airborne = (height: number) => (context: MissionContext) =>
  !context.sim.onGround && context.sim.altitudeAgl > height

/** Lined up on a runway at the airport, pointing along it either way. */
const linedUp = (code: string) => (context: MissionContext) => {
  const { sim } = context
  const { x, z } = sim.position
  return airport(code).runways.some(runway => {
    if (outside(runway, x, z) > 0) return false
    const off = Math.abs(Math.cos(sim.heading - runway.heading * DEGREES))
    return off > Math.cos(15 * DEGREES)
  })
}

/** Highest ground within `reach` metres of a point. */
function highestNear(x: number, z: number, reach: number) {
  let highest = 0
  for (let dx = -reach; dx <= reach; dx += reach / 2) {
    for (let dz = -reach; dz <= reach; dz += reach / 2) {
      highest = Math.max(highest, heightAt(x + dx, z + dz))
    }
  }
  return highest
}

/** Gates through a list of points, each set `clearance` metres above the ground around it. */
function gatesThrough(points: [number, number][], clearance: number, radius: number): Gate[] {
  return points.map(([x, z], i) => {
    const [nextX, nextZ] = points[Math.min(i + 1, points.length - 1)]
    const [lastX, lastZ] = points[Math.max(i - 1, 0)]
    const toX = i + 1 < points.length ? nextX - x : x - lastX
    const toZ = i + 1 < points.length ? nextZ - z : z - lastZ
    return {
      x,
      z,
      y: highestNear(x, z, 600) + clearance,
      heading: Math.atan2(toX, -toZ),
      radius
    }
  })
}

/** Points on a circle, starting due north and going clockwise. */
const circle = (x: number, z: number, radius: number, count: number): [number, number][] =>
  Array.from({ length: count + 1 }, (_, i) => {
    const angle = (i / count) * Math.PI * 2
    return [x + Math.sin(angle) * radius, z - Math.cos(angle) * radius]
  })

/** Points along a straight line, not counting the start. */
const line = (from: Airport, to: Airport, count: number): [number, number][] =>
  Array.from({ length: count }, (_, i) => {
    const t = (i + 1) / count
    return [from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t]
  })

/** Feet per minute, rounded to the nearest 10, from m/s. */
const fpm = (rate: number) => Math.round(rate / FPM / 10) * 10

const tooHard = (limit: number) => ({
  reason: (context: MissionContext) =>
    `The touchdown was too hard at ${fpm(context.touchdown?.rate ?? 0)} ft/min. Keep it under ${fpm(limit)} ft/min: hold Shift and ↓ to raise the nose gently in the last few feet.`,
  failed: (context: MissionContext) => (context.touchdown?.rate ?? 0) > limit
})

const offRunway = {
  reason: 'The aircraft touched down off the runway.',
  failed: (context: MissionContext) => context.touchdown !== null && !context.touchdown.paved
}

const steepBank = (context: MissionContext) => Math.abs(context.sim.bank) > 40 * DEGREES

/**
 * Passengers notice steep banks and hard pulls. A moment of either only worries them; it
 * takes 4 seconds of it before they are frightened.
 */
const comfort: Failure = {
  reason:
    'The passengers were frightened by steep banks or hard pulls. Keep the bank under 35° and the pull gentle.',
  failed: context =>
    !context.sim.onGround &&
    (steepBank(context) || context.sim.gLoad > 1.8 || context.sim.gLoad < 0.3),
  grace: 4,
  warning: context => {
    if (steepBank(context)) {
      return `Passengers uneasy: bank under 35°. Roll level with [${context.sim.bank > 0 ? '←' : '→'}].`
    }
    return context.sim.gLoad > 1.8
      ? 'Passengers uneasy: pull more gently. Ease off [↓].'
      : 'Passengers uneasy: push more gently. Ease off [↑].'
  }
}

const startup = (engines: number): Objective[] => [
  { text: 'Press [O] for battery power.', done: c => c.controls.battery },
  { text: 'Press [U] for the fuel pumps.', done: c => c.controls.fuelPumps },
  {
    text:
      engines > 1
        ? `Press [I] to start all ${engines} engines. They start one after another.`
        : 'Press [I] to start the engine.',
    done: c => c.sim.enginesRunning === c.sim.engines.length
  }
]

const ISLAND_RING = gatesThrough(circle(500, 500, 12_500, 8), 140, 90)

/** A target on the bombing range, by its distance east and south of the range's centre. */
const rangeTarget = (
  east: number,
  south: number,
  radius: number,
  label: string,
  height?: number
): Target => ({ x: RANGE.x + east, z: RANGE.z + south, radius, label, height })

/** Missiles left and in flight, and targets hit, on the strike missions. */
const missilesOf = (c: MissionContext) => ({
  hits: c.bombs?.hits ?? 0,
  left: c.bombs?.missiles ?? 0,
  flying: c.bombs?.flying.length ?? 0
})

/** Fails once every missile has flown with targets still standing. */
const outOfMissiles = (needed: number): Failure => ({
  reason:
    'Every missile is gone and a target still stands. Wait for the box to turn red before you fire.',
  failed: c => {
    const { hits, left, flying } = missilesOf(c)
    return hits < needed && left === 0 && flying === 0
  }
})

/** Targets destroyed so far, and the bombs left and still falling. */
const bombsOf = (c: MissionContext) => ({
  hits: c.bombs?.hits ?? 0,
  left: c.bombs?.loaded ?? 0,
  falling: c.bombs?.falling.length ?? 0
})

/** Fails once every bomb has landed with targets still standing. */
const outOfBombs = (needed: number): Failure => ({
  reason:
    'The bomb bay is empty and a target still stands. Steer until the card says you are on target, then drop.',
  failed: c => {
    const { hits, left, falling } = bombsOf(c)
    return hits < needed && left === 0 && falling === 0
  }
})

// Low-level run in from the sea to the range, 160 m above the ground
const RANGE_RUN = gatesThrough(
  [
    [RANGE.x - 17_000, RANGE.z + 3500],
    [RANGE.x - 13_500, RANGE.z + 1600],
    [RANGE.x - 10_000, RANGE.z + 400],
    [RANGE.x - 6500, RANGE.z],
    [RANGE.x - 3500, RANGE.z]
  ],
  160,
  150
)
// The fire mission starts 6 km past the end of Coral Bay's runway 09, climbing out over the
// sea, and both engines catch fire a few seconds in
const FIRE_RUNWAY =
  AIRPORTS.find(airport => airport.code === 'CBI')?.runways[0] ?? AIRPORTS[0].runways[0]
const FIRE_START = fromStrip(FIRE_RUNWAY, FIRE_RUNWAY.length / 2 + 6000, 0)
const FIRE_AT = 6
// The demolition run: Verity, approached along its length from 9 km out over the sea to its
// east, at a height that clears the hills to its west
const VERITY = CITIES.find(city => city.name === 'Verity') ?? CITIES[0]
const DEMOLITION_START = fromStrip(VERITY, VERITY.length / 2 + 9000, 0)
const DEMOLITION_ALTITUDE = 1100
const DEMOLITION_GOAL = 300
// A low lap around the island north-west of the main one, all over open sea
const MUSTANG_LAP = gatesThrough(circle(-9500, 12_000, 6000, 10), 100, 80)

// The Shuttle glides onto Port Azure's runway 36 from the south. Its steep outer glideslope
// aims 1.5 km short of the runway, so the round-out from 2,000 ft ends early on the runway and
// leaves room to stop. The start is 10.5 km out along it.
const SHUTTLE_RUNWAY = AIRPORTS.find(airport => airport.code === 'PAZ')?.runways[0] ?? FIRE_RUNWAY
const SHUTTLE_SLOPE = 19 * DEGREES
const SHUTTLE_AIM = SHUTTLE_RUNWAY.length / 2 + 1500
const SHUTTLE_ELEVATION = heightAt(SHUTTLE_RUNWAY.x, SHUTTLE_RUNWAY.z)
const shuttlePath = (distance: number) => ({
  ...fromStrip(SHUTTLE_RUNWAY, -(SHUTTLE_AIM + distance), 0),
  y: SHUTTLE_ELEVATION + distance * Math.tan(SHUTTLE_SLOPE)
})
const SHUTTLE_START = shuttlePath(10_500)
const SHUTTLE_GATES: Gate[] = [8000, 5000, 2500].map(distance => ({
  ...shuttlePath(distance),
  heading: (SHUTTLE_RUNWAY.heading * Math.PI) / 180,
  radius: 160
}))

const NORTH_TO_EAST = gatesThrough(line(airport('NGT'), airport('EMK'), 6), 180, 110)

export const MISSIONS: Mission[] = [
  {
    id: 'basics',
    title: 'Flying Basics',
    category: 'Tutorial',
    aircraft: 'c172',
    summary: 'Learn the stick, the throttle, the rudder, and the trim.',
    briefing:
      'You start in the air over the sea in a Cessna 172. Each step teaches one control. Watch the bank arc at the top of the screen and the climb figure in the top bar.',
    start: { kind: 'air', x: -4000, z: -16_000, altitude: 700, heading: 90, speed: 95 },
    objectives: [
      {
        text: 'Hold [↓] to raise the nose until you climb at 500 ft/min.',
        done: c => c.sim.verticalSpeed > 500 * FPM && c.controls.pitch > 0.05,
        hold: 1
      },
      {
        text: 'Hold [↑] to lower the nose until you descend at 500 ft/min.',
        done: c => c.sim.verticalSpeed < -500 * FPM && c.controls.pitch < -0.02,
        hold: 1
      },
      {
        text: 'Level off: keep the climb within 200 ft/min of zero.',
        done: c => Math.abs(c.sim.verticalSpeed) < 200 * FPM,
        hold: 3
      },
      {
        text: 'Hold [←] to bank left to 20°. The arc at the top shows the bank.',
        done: c => c.sim.bank < -18 * DEGREES && c.controls.roll < -0.05,
        hold: 1
      },
      {
        text: 'Hold [→] to bank right to 20°.',
        done: c => c.sim.bank > 18 * DEGREES && c.controls.roll > 0.05,
        hold: 1
      },
      {
        text: 'Level the wings and keep them level.',
        done: c => Math.abs(c.sim.bank) < 3 * DEGREES,
        hold: 3
      },
      {
        text: 'Turn to heading 180, due south, then roll the wings level.',
        done: c =>
          Math.abs(Math.cos(c.sim.heading - Math.PI)) > Math.cos(8 * DEGREES) &&
          Math.sin(c.sim.heading - Math.PI) < 0.2 &&
          Math.abs(c.sim.bank) < 8 * DEGREES,
        hold: 2
      },
      { text: 'Hold [S] to bring the throttle below 50%.', done: c => c.controls.throttle < 0.5 },
      { text: 'Hold [W] for full throttle.', done: c => c.controls.throttle > 0.97 },
      {
        text: 'Hold [A] or [D] to press the rudder and swing the nose.',
        done: c => Math.abs(c.controls.yaw) > 0.8,
        hold: 0.5
      },
      {
        text: 'Tap [E] or [Q] to trim, so the nose holds up or down by itself.',
        done: c => Math.abs(c.controls.trim) > 0.05
      }
    ],
    failures: [
      {
        reason: 'The aircraft got too close to the water. Keep above 300 ft.',
        failed: c => c.sim.altitudeAgl < 90,
        grace: 3,
        warning: () => 'Too low: climb back above 300 ft. Hold [↓].'
      }
    ]
  },
  {
    id: 'takeoff',
    title: 'Takeoff',
    category: 'Tutorial',
    aircraft: 'c172',
    summary: 'Start the engine, roll down the runway, and climb away.',
    briefing:
      'You are lined up on the main runway at Coral Bay with the battery and fuel on. Start the engine, run up to full power, lift off at 55 knots, and climb.',
    start: { kind: 'runway', airport: 'CBI' },
    objectives: [
      { text: 'Press [I] to start the engine.', done: c => c.sim.enginesRunning === 1 },
      { text: 'Press [P] to release the parking brake.', done: c => !c.controls.parkingBrake },
      { text: 'Hold [W] for full throttle.', done: c => c.controls.throttle > 0.95 },
      {
        text: 'Keep straight with [A] and [D]. At 55 knots, hold [↓] until the wheels lift.',
        done: airborne(8)
      },
      {
        text: 'Climb at about 75 knots to 1,000 ft above the ground.',
        done: airborne(1000 * FEET)
      }
    ]
  },
  {
    id: 'landing',
    title: 'Landing',
    category: 'Tutorial',
    aircraft: 'c172',
    summary: 'Follow the glide path down and touch down gently.',
    briefing:
      'You are 3 NM out on the approach to runway 09 at Coral Bay. The flaps are down and the trim holds 70 knots, so the aircraft descends on its own. The coach under the steps tells you which key to press, and how, all the way to a stop.',
    start: { kind: 'approach', approach: 'ILS 09 CBI', distance: 5500, speed: 70, flapNotch: 3 },
    approach: 'ILS 09 CBI',
    objectives: [
      {
        text: 'Let go of the keys. The aircraft follows the glide path by itself.',
        done: c => c.time > 6
      },
      {
        text: 'Fly through the magenta rings. Tap [←] or [→] to stay lined up with the runway.',
        done: below(500)
      },
      {
        text: 'The throttle sets the descent. Tap [W] if you sink below the rings, [S] if you float above.',
        done: below(200)
      },
      {
        text: 'Aim at the runway numbers. Two white and two red lights beside the runway mean you are on the glide path.',
        done: below(20)
      },
      {
        text: 'Close the throttle with [S]. Hold [Shift] and [↓] to raise the nose gently until the wheels touch.',
        done: c => c.sim.onGround
      },
      {
        text: 'Let it slow, then hold [Space] and [↓] to brake to a stop.',
        done: stopped
      }
    ],
    failures: [tooHard(600 * FPM), offRunway]
  },
  {
    id: 'airliner-start',
    title: 'Airliner Startup and Taxi',
    category: 'Tutorial',
    aircraft: 'a320',
    summary: 'Bring an A320 to life at the gate, taxi out, and take off.',
    briefing:
      'Your A320 is cold and dark at a Coral Bay gate. Power it up, start both engines, push back, follow the yellow lines to the runway, and take off.',
    start: { kind: 'stand', airport: 'CBI' },
    objectives: [
      ...startup(2),
      { text: 'Press [F] twice for takeoff flaps.', done: c => c.controls.flapNotch >= 2 },
      { text: 'Press [P] to release the parking brake.', done: c => !c.controls.parkingBrake },
      {
        text: 'Press [R] and add a little throttle with [W] to push back. Press [R] again when clear.',
        done: c => !c.controls.reverse && movedFromStart(c) > 40
      },
      {
        text: 'Taxi along the yellow lines with [A] and [D], and line up on the runway.',
        done: linedUp('CBI')
      },
      {
        text: 'Hold [W] for full throttle. At 144 knots, hold [↓] to lift off, then press [G].',
        done: c => airborne(150)(c) && !c.controls.gearDown
      }
    ]
  },
  {
    id: 'autopilot-ils',
    title: 'Autopilot and ILS',
    category: 'Tutorial',
    aircraft: 'a320',
    summary: 'Let the autopilot fly an instrument approach and land.',
    briefing:
      'Your A320 is south-west of Northgate with the ILS for runway 05 tuned in. Engage the autopilot and let it fly the approach. You set the gear and flaps, and the autopilot lands the aircraft. The coach under the steps says what to do next.',
    start: { kind: 'approach', approach: 'ILS 05 NGT', distance: 24_000, speed: 220, level: true },
    approach: 'ILS 05 NGT',
    objectives: [
      { text: 'Press [Z] to engage the autopilot.', done: c => c.pilot.autopilot.on },
      {
        text: 'Press [X] for the autothrottle. It slows down by itself.',
        done: c => c.pilot.autothrottle.on
      },
      {
        text: 'Press [T]: the autopilot flies the approach course and glide path, then lands.',
        done: c => c.pilot.flyingApproach
      },
      {
        text: 'Press [G] for gear down and [F] until the flaps are full.',
        done: c => c.controls.gearDown && c.controls.flapNotch >= 4
      },
      {
        text: 'Watch the autopilot flare and touch down. Press [Z] at any time to land by hand instead.',
        done: c => c.sim.onGround
      },
      {
        text: 'The autopilot brakes and steers down to 30 knots. Then hold [Space] to stop.',
        done: stopped
      }
    ],
    failures: [tooHard(600 * FPM), offRunway]
  },
  {
    id: 'island-ring',
    title: 'Island Ring',
    category: 'Speed Run',
    aircraft: 'f16',
    summary: `Race an F-16 through ${ISLAND_RING.length} gates around the main island.`,
    briefing:
      'Fly through every gate in order around Coral Bay island, low over the coast. Full throttle lights the afterburner. You have 4 minutes.',
    start: {
      kind: 'air',
      x: 500 - 3000,
      z: 500 - 12_500,
      altitude: ISLAND_RING[0].y,
      heading: 90,
      speed: 420
    },
    gates: ISLAND_RING,
    timeLimit: 240,
    objectives: [
      {
        text: `Fly through all ${ISLAND_RING.length} gates in order. The next one glows green.`,
        done: c => c.gates >= ISLAND_RING.length
      }
    ]
  },
  {
    id: 'northern-dash',
    title: 'Northern Dash',
    category: 'Speed Run',
    aircraft: 'f35',
    summary: 'Cross the whole map from Northgate to Eastmark in an F-35.',
    briefing:
      'Take off from Northgate and race 40 nautical miles to Eastmark through six gates. Use the afterburner, but watch the hills. You have 6 minutes.',
    start: { kind: 'runway', airport: 'NGT' },
    gates: NORTH_TO_EAST,
    timeLimit: 360,
    objectives: [
      {
        text: 'Press [I] to start the engine, then [P] to release the brake.',
        done: c => c.sim.engineRunning && !c.controls.parkingBrake
      },
      {
        text: 'Take off with full throttle and raise the gear with [G].',
        done: c => airborne(30)(c) && !c.controls.gearDown
      },
      {
        text: `Fly through all ${NORTH_TO_EAST.length} gates to Eastmark.`,
        done: c => c.gates >= NORTH_TO_EAST.length
      }
    ]
  },
  {
    id: 'morning-shuttle',
    title: 'Morning Shuttle',
    category: 'Airline',
    aircraft: 'a320',
    summary: 'Fly passengers from Coral Bay to Eastmark, gate to gate.',
    briefing:
      'A full A320 waits at a Coral Bay gate with a flight plan to Eastmark loaded. Start up, take off, let the autopilot follow the route, land gently, and park at an Eastmark gate.',
    start: { kind: 'stand', airport: 'CBI' },
    destination: 'EMK',
    objectives: [
      ...startup(2),
      { text: 'Push back, taxi out, and take off.', done: airborne(150) },
      {
        text: 'Press [J] and [X]: the autopilot flies the route and the approach.',
        done: c => c.nav.plan !== null && !c.nav.enroute
      },
      {
        text: 'The autopilot lands at Eastmark and brakes to 30 knots. Then hold [Space] to slow down.',
        done: c => onRunwayOf('EMK')(c) && c.sim.groundSpeed < 25
      },
      {
        text: 'Taxi to a gate, set the parking brake with [P], and stop the engines with [I].',
        done: c => c.parkedAt?.code === 'EMK'
      }
    ],
    failures: [tooHard(600 * FPM), offRunway, comfort]
  },
  {
    id: 'island-hopper',
    title: 'Island Hopper',
    category: 'Airline',
    aircraft: 'b737',
    summary: 'A short 737 hop from Northgate to Port Azure.',
    briefing:
      'Your 737 MAX is at a Northgate gate with a flight plan to Port Azure. The 737 has no flight envelope protection, so fly it smoothly. Land softly and park at a gate.',
    start: { kind: 'stand', airport: 'NGT' },
    destination: 'PAZ',
    objectives: [
      ...startup(2),
      { text: 'Push back, taxi out, and take off.', done: airborne(150) },
      {
        text: 'Press [J] and [X]: the autopilot flies the route and the approach.',
        done: c => c.nav.plan !== null && !c.nav.enroute
      },
      {
        text: 'The autopilot lands at Port Azure and brakes to 30 knots. Then hold [Space] to slow down.',
        done: c => onRunwayOf('PAZ')(c) && c.sim.groundSpeed < 25
      },
      {
        text: 'Taxi to a gate, set the parking brake with [P], and stop the engines with [I].',
        done: c => c.parkedAt?.code === 'PAZ'
      }
    ],
    failures: [tooHard(600 * FPM), offRunway, comfort]
  },
  {
    id: 'engine-out',
    title: 'Engine Failure',
    category: 'Challenge',
    aircraft: 'b737',
    summary: 'Lose an engine on approach and land anyway.',
    briefing:
      'You are on the ILS to runway 33 at Eastmark in a 737 MAX, gear and flaps down. Something is about to go wrong. Keep the aircraft straight with the rudder and land it.',
    start: {
      kind: 'approach',
      approach: 'ILS 33 EMK',
      distance: 12_000,
      speed: 150,
      flapNotch: 4,
      gearDown: true
    },
    approach: 'ILS 33 EMK',
    script: c => {
      if (c.time > 8 && !c.sim.engines[0].failed) c.sim.engines[0].failed = true
    },
    objectives: [
      {
        text: 'Engine 1 is about to fail. Be ready with [D] rudder to keep the nose straight.',
        done: c => c.sim.engines[0].failed && c.time > 14
      },
      {
        text: 'Keep holding [D] while the slip ball is off centre, and add power with [W] to stay on the glide path.',
        done: below(1000)
      },
      {
        text: 'Follow the coach down the glide path, or press [T] for the autopilot, and land on runway 33.',
        done: c => onRunwayOf('EMK')(c)
      },
      { text: 'Hold [Space] to stop on the runway.', done: stopped }
    ],
    failures: [tooHard(700 * FPM), offRunway]
  },
  {
    id: 'dual-fire',
    title: 'Double Engine Fire',
    category: 'Challenge',
    aircraft: 'a320',
    summary: 'Both engines burn after takeoff. Put out the fires and glide to safety.',
    briefing:
      'Your A320 has just left Coral Bay, climbing through 4,500 ft over the sea. Both engines are about to catch fire. Shut them down, fire the extinguishers, then glide with no power to a runway. Coral Bay is 8 km behind you, and two smaller fields are closer. If none is in reach, ditch gently in the sea.',
    start: { kind: 'air', ...FIRE_START, altitude: 1370, heading: 90, speed: 220 },
    script: c => {
      if (c.time < FIRE_AT || c.sim.engines.every(engine => engine.failed)) return
      for (const engine of c.sim.engines) {
        engine.fire = true
        engine.failed = true
      }
    },
    timeLimit: 600,
    objectives: [
      {
        text: 'Fire in both engines! Press [1] and [2] to shut them down.',
        done: c =>
          c.time > FIRE_AT && !c.controls.engineSwitches[0] && !c.controls.engineSwitches[1]
      },
      {
        text: 'Press [Shift] with [1], then [Shift] with [2], to fire the extinguishers.',
        done: c => c.time > FIRE_AT && c.sim.engines.every(engine => !engine.fire)
      },
      {
        text: 'Glide at about 210 knots with no power. Press [N] for the nearest runway and turn toward it.',
        done: c => c.nav.approach !== null
      },
      {
        text: 'Lower the gear and flaps late, and land. Out of reach? Ditch in the sea: gear up, wings level, nose a little up.',
        done: c => c.touchdown?.paved === true || c.sim.ditched
      },
      { text: 'Bring the aircraft to a stop.', done: stopped }
    ],
    failures: [
      {
        reason: 'The fire spread to the wings. Shut each engine down, then fire its extinguisher.',
        failed: c => c.sim.engines.some(engine => engine.fire),
        grace: 45,
        warning: c =>
          c.sim.engines.some((engine, i) => engine.fire && c.controls.engineSwitches[i])
            ? 'The fire is spreading: shut the burning engines down with [1] and [2].'
            : 'The fire is spreading: fire the extinguishers with [Shift] and [1], [Shift] and [2].'
      },
      tooHard(700 * FPM),
      {
        reason: 'The aircraft touched down off the runway. Land on a runway, or ditch in the sea.',
        failed: c => c.touchdown !== null && !c.touchdown.paved && !c.sim.ditched
      }
    ]
  },
  {
    id: 'shuttle-landing',
    title: 'Shuttle Landing',
    category: 'Challenge',
    aircraft: 'shuttle',
    summary: 'Glide the Space Shuttle down a 19° slope with no engines, and land it once.',
    briefing:
      'The orbiter is back from space, 12,000 ft up and 13 km from Port Azure, falling like a brick. It has no engines: one approach, one landing. Ride the steep slope through the rings at about 290 knots, using the speed brake [B] to hold the speed. At 2,000 ft pull the nose up gently into a shallow glide, lower the gear at 300 ft, and touch down near 200 knots.',
    start: {
      kind: 'air',
      x: SHUTTLE_START.x,
      z: SHUTTLE_START.z,
      altitude: SHUTTLE_START.y,
      heading: SHUTTLE_RUNWAY.heading,
      speed: 300 / Math.sqrt(Math.exp(-SHUTTLE_START.y / 9000)),
      glide: 19,
      speedBrake: true
    },
    gates: SHUTTLE_GATES,
    timeLimit: 300,
    objectives: [
      {
        text: `Dive through the ${SHUTTLE_GATES.length} rings at about 290 knots. Press [B] to close the speed brake if you slow below 280.`,
        done: c => c.gates >= SHUTTLE_GATES.length || below(2000)(c)
      },
      {
        text: 'At 2,000 ft, raise the nose gently with [↓] into a shallow glide.',
        done: below(300)
      },
      { text: 'Press [G] to lower the gear.', done: c => c.controls.gearDown },
      {
        text: 'Flare and touch down on the runway near 200 knots.',
        done: c => c.touchdown?.paved === true
      },
      {
        text: 'Lower the nose gently, then hold [Space] to stop.',
        done: stopped
      }
    ],
    failures: [tooHard(500 * FPM), offRunway]
  },
  {
    id: 'mustang-takeoff',
    title: 'Mustang Takeoff',
    category: 'Challenge',
    aircraft: 'p51',
    summary: 'Tame the propeller swing of a P-51 on its takeoff roll.',
    briefing:
      "The P-51 Mustang sits nose-high on its tail wheel at Coral Bay. Its 1,490 hp Merlin and big propeller swing the nose hard left as the power comes in, and the tail wheel doesn't steer. Hold right rudder with D, keep it straight on the runway, and climb away.",
    start: { kind: 'runway', airport: 'CBI' },
    objectives: [
      { text: 'Press [I] to start the engine.', done: c => c.sim.enginesRunning === 1 },
      { text: 'Press [P] to release the parking brake.', done: c => !c.controls.parkingBrake },
      {
        text: 'Add full power with [W]. Hold [D] for right rudder to keep the nose straight.',
        done: c => c.sim.groundSpeed > 30
      },
      {
        text: 'Ease back with [↓] and lift off near 110 knots.',
        done: c => !c.sim.onGround && c.sim.altitudeAgl > 15
      },
      {
        text: 'Raise the gear with [G] and climb to 1,000 ft.',
        done: c => !c.controls.gearDown && c.sim.altitudeAgl > 1000 * FEET
      }
    ],
    failures: [
      {
        reason:
          'The Mustang swung off the runway. Hold right rudder [D] as the power comes in, more as it speeds up.',
        failed: c =>
          c.sim.onGround && c.sim.groundSpeed > 3 && !isPaved(c.sim.position.x, c.sim.position.z)
      }
    ]
  },
  {
    id: 'mustang-race',
    title: 'Mustang Race',
    category: 'Speed Run',
    aircraft: 'p51',
    summary: `Race a P-51 low around an island through ${MUSTANG_LAP.length} gates.`,
    briefing:
      'Wave-top racing in a P-51 Mustang: one lap around the island north-west of Coral Bay, about 330 ft over the sea. Full power, steep turns, and watch the water. You have 5 minutes.',
    start: {
      kind: 'air',
      x: MUSTANG_LAP[0].x - 2500,
      z: MUSTANG_LAP[0].z,
      altitude: MUSTANG_LAP[0].y,
      heading: 90,
      speed: 300
    },
    gates: MUSTANG_LAP,
    timeLimit: 300,
    objectives: [
      {
        text: `Fly through all ${MUSTANG_LAP.length} gates in order. The next one glows green.`,
        done: c => c.gates >= MUSTANG_LAP.length
      }
    ]
  },
  {
    id: 'night-fog',
    title: 'Night Fog',
    category: 'Challenge',
    aircraft: 'a320',
    summary: 'Land at night in thick fog with the ILS.',
    briefing:
      'Visibility is under 1 km at Northgate and it is dark. Fly the ILS to runway 23 by the needles, by hand or with the autopilot. The runway lights appear late.',
    start: { kind: 'approach', approach: 'ILS 23 NGT', distance: 14_000, speed: 180, flapNotch: 2 },
    approach: 'ILS 23 NGT',
    weather: 'fog',
    time: 'night',
    objectives: [
      {
        text: 'Lower the gear [G] and set full flaps [F]. Press [L] for the landing light.',
        done: c => c.controls.gearDown && c.controls.flapNotch >= 4 && c.pilot.landingLights
      },
      {
        text: 'Press [T] and the autopilot lands in the fog, or follow the coach by hand. Land on runway 23.',
        done: onRunwayOf('NGT')
      },
      {
        text: 'Hold [Space] to stop on the runway once the autopilot hands back at 30 knots.',
        done: stopped
      }
    ],
    failures: [tooHard(600 * FPM), offRunway]
  },
  {
    id: 'short-strip',
    title: 'Short Strip',
    category: 'Challenge',
    aircraft: 'c172',
    summary: 'Land a Cessna on the 1,100 m strip at Lantern Rock and stop on it.',
    briefing:
      'Lantern Rock has one short, narrow runway and a crosswind. You are on final at 68 knots with full flaps. Touch down near the start of the strip and brake firmly with the stick held back.',
    start: { kind: 'approach', approach: 'RNAV 14 LRK', distance: 5000, speed: 68, flapNotch: 3 },
    approach: 'RNAV 14 LRK',
    wind: 'light',
    objectives: [
      {
        text: 'Follow the coach down. The crosswind pushes you sideways, so keep turning back to the line.',
        done: below(50)
      },
      { text: 'Touch down on the strip.', done: onRunwayOf('LRK') },
      {
        text: 'Hold [Space] and [↓] together, and stop before the end.',
        done: stopped
      }
    ],
    failures: [
      tooHard(500 * FPM),
      offRunway,
      {
        reason: 'The aircraft ran off the strip.',
        failed: c =>
          c.sim.onGround && c.touchdown !== null && !isPaved(c.sim.position.x, c.sim.position.z)
      }
    ]
  },
  {
    id: 'supersonic',
    title: 'Supersonic Dash',
    category: 'Challenge',
    aircraft: 'concorde',
    summary: 'Take Concorde through the sound barrier to Mach 1.7.',
    briefing:
      'Concorde waits on the runway at Coral Bay with power on. Take off with the afterburners and climb high before going fast: low down, the air is too thick and the airframe overspeeds. You have 15 minutes.',
    start: { kind: 'runway', airport: 'CBI' },
    timeLimit: 900,
    objectives: [
      ...startup(4).slice(2),
      {
        text: 'Press [F] once to droop the nose to 5° for takeoff.',
        done: c => c.controls.flapNotch >= 1
      },
      {
        text: 'Release the brake [P], full throttle [W], and lift off at 195 knots.',
        done: airborne(30)
      },
      {
        text: 'Raise the gear [G] and the nose [V] before 250 knots.',
        done: c => !c.controls.gearDown && c.controls.flapNotch === 0
      },
      {
        text: 'Climb at full throttle. Keep the speed below the red-and-black band on the speed scale.',
        done: c => c.sim.position.y > 20_000 * FEET
      },
      { text: 'Break the sound barrier: pass Mach 1.', done: c => c.sim.mach > 1 },
      { text: 'Climb above 50,000 ft.', done: c => c.sim.position.y > 50_000 * FEET },
      { text: 'Accelerate past Mach 1.7.', done: c => c.sim.mach > 1.7 }
    ]
  },
  {
    id: 'first-drop',
    title: 'First Drop',
    category: 'Bombing',
    aircraft: 'b2',
    summary: 'Learn to aim and drop on a bunker at Gull Point Range.',
    briefing:
      'Your B-2 is 14 km west of Gull Point Range at 5,000 ft with four practice bombs. A cross on the ground shows where a bomb dropped now would land. Steer until it runs straight at the bunker and turns green, then press Enter. The bomb drops as the cross reaches the bunker.',
    start: {
      kind: 'air',
      x: RANGE.x - 14_000,
      z: RANGE.z,
      altitude: 1524,
      heading: 90,
      speed: 250
    },
    bombs: 4,
    targets: [rangeTarget(0, 0, 45, 'bunker')],
    timeLimit: 600,
    objectives: [
      {
        text: 'Press [Tab] to open the bombsight. The cross on the ground shows where a bomb would land.',
        done: c => c.bombsight === true
      },
      {
        text: 'Steer gently until the cross turns green and the card says lined up, then press [Enter].',
        done: c => bombsOf(c).left < 4
      },
      { text: 'Hit the bunker.', done: c => bombsOf(c).hits >= 1 }
    ],
    failures: [outOfBombs(1)]
  },
  {
    id: 'night-run',
    title: 'Night Run',
    category: 'Bombing',
    aircraft: 'b2',
    summary: 'Low over the sea at night, through the gates, then two targets.',
    briefing:
      'Come in low over the sea in the dark, under the radar, through every gate to Gull Point Range. The last gates line up with the fuel depot and the radar, so one steady pass can destroy both. Climb after the drop: hills rise past the range. Six bombs, 8 minutes.',
    start: {
      kind: 'air',
      x: RANGE.x - 21_000,
      z: RANGE.z + 5700,
      altitude: RANGE_RUN[0].y,
      heading: 61,
      speed: 300
    },
    time: 'night',
    gates: RANGE_RUN,
    bombs: 6,
    // Both on the line of the last gates, so one straight pass can destroy them
    targets: [rangeTarget(-180, 0, 45, 'fuel depot'), rangeTarget(220, 30, 45, 'radar')],
    timeLimit: 480,
    objectives: [
      {
        text: `Fly through all ${RANGE_RUN.length} gates. The next one glows green.`,
        done: c => c.gates >= RANGE_RUN.length
      },
      {
        text: 'Press [Tab] for the bombsight. Destroy the fuel depot: press [Enter] once the cross turns green.',
        done: c => bombsOf(c).hits >= 1
      },
      { text: 'Destroy the radar just past it.', done: c => bombsOf(c).hits >= 2 }
    ],
    failures: [outOfBombs(2)]
  },
  {
    id: 'stealth-strike',
    title: 'Stealth Strike',
    category: 'Bombing',
    aircraft: 'b2',
    summary: 'A guided bomb from 25,000 ft onto a bunker the size of a house.',
    briefing:
      'The way the B-2 really fights: high, far, and precise. From 25,000 ft, bring the aiming cross into the launch zone around the command bunker and release. The GPS-guided bomb steers itself the rest of the way down. Two bombs, 9 minutes.',
    start: {
      kind: 'air',
      x: RANGE.x - 38_000,
      z: RANGE.z - 4000,
      altitude: 7620,
      heading: 84,
      speed: 400
    },
    bombs: 2,
    guided: true,
    targets: [rangeTarget(-90, 120, 12, 'command bunker')],
    timeLimit: 540,
    objectives: [
      {
        text: 'Press [Tab] for the bombsight, then head for Gull Point Range. The card steers you there.',
        done: c => Math.hypot(c.sim.position.x - RANGE.x, c.sim.position.z - RANGE.z) < 15_000
      },
      {
        text: 'Hold the cross in the launch zone and press [Enter] to release.',
        done: c => bombsOf(c).left < 2
      },
      { text: 'Watch it fall: the bunker must go.', done: c => bombsOf(c).hits >= 1 }
    ],
    failures: [outOfBombs(1)]
  },
  {
    id: 'demolition',
    title: 'Demolition',
    category: 'Bombing',
    aircraft: 'b2',
    summary: `Bring down ${DEMOLITION_GOAL} of the empty city of Verity's buildings.`,
    briefing: `Verity's old city stands empty, waiting to be cleared for a new one. The demolition crews asked for the fast way. Open the bombsight with Tab, then hold Enter as you cross the city to drop a string of bombs. Bring down ${DEMOLITION_GOAL} buildings with 80 bombs in 20 minutes. Hills rise to 2,600 ft west of the city, so stay at 3,600 ft and turn back over them or the sea.`,
    start: {
      kind: 'air',
      ...DEMOLITION_START,
      altitude: DEMOLITION_ALTITUDE,
      heading: (VERITY.heading + 180) % 360,
      speed: 300
    },
    bombs: 80,
    demolish: { city: VERITY.name, goal: DEMOLITION_GOAL },
    timeLimit: 1200,
    objectives: [
      { text: 'Press [Tab] to open the bombsight.', done: c => c.bombsight === true },
      {
        text: 'Fly along the city and hold [Enter] over it for a string of bombs.',
        done: c => (c.bombs?.ruins.fallenInCity(VERITY.name) ?? 0) > 0
      },
      {
        text: `Bring down ${DEMOLITION_GOAL} buildings. Turn back for more runs.`,
        done: c => (c.bombs?.ruins.fallenInCity(VERITY.name) ?? 0) >= DEMOLITION_GOAL
      }
    ],
    failures: [
      {
        reason:
          'The bomb bay is empty and the city still stands. Fly straight along it while you hold Enter.',
        failed: c => {
          const { left, falling } = bombsOf(c)
          const fallen = c.bombs?.ruins.fallenInCity(VERITY.name) ?? 0
          return left === 0 && falling === 0 && fallen < DEMOLITION_GOAL
        }
      }
    ]
  },
  {
    id: 'missile-run',
    title: 'Missile Run',
    category: 'Strike',
    aircraft: 'f16',
    summary: 'An F-16 with four missiles against a radar, a fuel depot, and a target tower.',
    briefing:
      'Your F-16 is 22 km west of Gull Point Range at 3,000 ft with four guided missiles. A white box marks each target. Point the nose at one until its box turns red, then press Enter. The missile does the rest. You have 7 minutes.',
    start: { kind: 'air', x: RANGE.x - 22_000, z: RANGE.z, altitude: 900, heading: 90, speed: 400 },
    missiles: 4,
    targets: [
      rangeTarget(0, 0, 15, 'target tower', 70),
      rangeTarget(320, -260, 20, 'radar'),
      rangeTarget(-280, 240, 25, 'fuel depot')
    ],
    timeLimit: 420,
    objectives: [
      {
        text: 'Fly toward the range. Point the nose at a white box until it turns red.',
        done: c => (c.bombs?.lock ?? -1) >= 0
      },
      { text: 'Press [Enter] to fire. Hit your first target.', done: c => missilesOf(c).hits >= 1 },
      { text: 'Destroy all three targets.', done: c => missilesOf(c).hits >= 3 }
    ],
    failures: [outOfMissiles(3)]
  },
  {
    id: 'tower-strike',
    title: 'Tower Strike',
    category: 'Strike',
    aircraft: 'f35',
    summary: 'Dive an F-35 from 20,000 ft and bring down a 90 m tower with one shot.',
    briefing:
      'The F-35 starts high and fast, 40 km out. Dive toward Gull Point Range, put the box on the 90 m target tower, and fire. You carry two missiles, so a miss leaves you one more try. You have 8 minutes.',
    start: {
      kind: 'air',
      x: RANGE.x - 40_000,
      z: RANGE.z + 3000,
      altitude: 6100,
      heading: 86,
      speed: 450
    },
    missiles: 2,
    targets: [rangeTarget(0, 0, 18, 'target tower', 90)],
    timeLimit: 480,
    objectives: [
      {
        text: 'Head for Gull Point Range and dive. The card tells you where to turn.',
        done: c => Math.hypot(c.sim.position.x - RANGE.x, c.sim.position.z - RANGE.z) < 12_000
      },
      {
        text: 'Lock on the tower: the box turns red. Press [Enter] to fire.',
        done: c => missilesOf(c).left < 2
      },
      { text: 'Bring the tower down.', done: c => missilesOf(c).hits >= 1 }
    ],
    failures: [outOfMissiles(1)]
  }
]

/** Metres from where the mission started, for steps such as pushing back. */
let origin = { x: 0, z: 0 }
function movedFromStart(context: MissionContext) {
  const { x, z } = context.sim.position
  return Math.hypot(x - origin.x, z - origin.z)
}

/** Every mission's approach and destination must exist, or the list fails to load. */
for (const mission of MISSIONS) {
  if (mission.approach && !APPROACHES.some(approach => approach.id === mission.approach)) {
    throw new Error(
      `Mission ${mission.id} needs approach ${mission.approach}, which does not exist`
    )
  }
  if (mission.destination) airport(mission.destination)
}

/** Pass or fail. A pass that ended with a landing notes the touchdown sink rate in ft/min. */
export type MissionResult = { passed: true; touchdown?: number } | { passed: false; reason: string }

/** Steps a mission's objectives in order, counts its gates, and decides pass or fail. */
export class MissionRunner {
  mission: Mission | null = null
  /** Index of the objective being worked on; equals the count once all are done. */
  step = 0
  time = 0
  gates = 0
  /** What to fix before a failure with a grace period runs out, and the seconds left. */
  warning: { text: string; left: number } | null = null
  private held = 0
  /** Seconds each failure's condition has held, net of the time it has not. */
  private strain: number[] = []
  private touchdown: MissionContext['touchdown'] = null
  private wasOnGround = true
  private lastSink = 0

  start(mission: Mission, sim: FlightSim) {
    this.mission = mission
    this.step = 0
    this.time = 0
    this.gates = 0
    this.held = 0
    this.strain = mission.failures?.map(() => 0) ?? []
    this.warning = null
    this.touchdown = null
    this.wasOnGround = sim.onGround || sim.altitudeAgl < 3
    this.lastSink = 0
    origin = { x: sim.position.x, z: sim.position.z }
  }

  stop() {
    this.mission = null
  }

  private pass(): MissionResult {
    return this.touchdown ? { passed: true, touchdown: fpm(this.touchdown.rate) } : { passed: true }
  }

  /** Advances by `dt` seconds. Returns the result once the mission is decided. */
  update(
    dt: number,
    context: Omit<MissionContext, 'time' | 'gates' | 'touchdown'>
  ): MissionResult | null {
    const { mission } = this
    if (!mission) return null
    this.time += dt
    const { sim } = context
    // Note each touchdown: how hard, and on what surface
    if (sim.onGround && !this.wasOnGround) {
      this.touchdown = { rate: this.lastSink, paved: isPaved(sim.position.x, sim.position.z) }
    }
    this.wasOnGround = sim.onGround
    if (!sim.onGround) this.lastSink = Math.max(0, -sim.verticalSpeed)
    const gate = mission.gates?.[this.gates]
    if (gate) {
      const distance = Math.hypot(
        sim.position.x - gate.x,
        sim.position.y - gate.y,
        sim.position.z - gate.z
      )
      if (distance < gate.radius) this.gates++
    }
    const full: MissionContext = {
      ...context,
      time: this.time,
      gates: this.gates,
      touchdown: this.touchdown
    }
    mission.script?.(full)
    this.warning = null
    const failures = mission.failures ?? []
    for (let i = 0; i < failures.length; i++) {
      const failure = failures[i]
      const failing = failure.failed(full)
      const grace = failure.grace ?? 0
      this.strain[i] = failing ? this.strain[i] + dt : Math.max(0, this.strain[i] - dt)
      if (failing && this.strain[i] >= grace) {
        const { reason } = failure
        return { passed: false, reason: typeof reason === 'string' ? reason : reason(full) }
      }
      if (failing && failure.warning && !this.warning) {
        this.warning = { text: failure.warning(full), left: grace - this.strain[i] }
      }
    }
    if (mission.timeLimit && this.time > mission.timeLimit) {
      return { passed: false, reason: 'Time ran out.' }
    }
    const objective = mission.objectives[this.step]
    if (!objective) return this.pass()
    this.held = objective.done(full) ? this.held + dt : 0
    if (this.held >= (objective.hold ?? 0) && this.held > 0) {
      this.step++
      this.held = 0
      if (this.step >= mission.objectives.length) return this.pass()
    }
    return null
  }
}

const STORAGE_KEY = 'island-flyer-missions-passed'

/** Ids of the missions passed in this browser. Storage can be blocked, so failures read as none. */
export function passedMissions(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function rememberPassed(id: string) {
  try {
    const passed = passedMissions()
    passed.add(id)
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...passed]))
  } catch {
    // Without storage the result simply is not remembered
  }
}
