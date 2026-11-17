import { expect, test } from 'bun:test'
import { Quaternion, Vector3 } from 'three'
import { HANGAR, KNOT } from '../sim/aircraft'
import { FlightSim } from '../sim/flight-sim'
import { APPROACHES, onCentreline, pathAltitude } from '../world/approaches'
import {
  AIRPORTS,
  fromStrip,
  heightAt,
  helipad as helipadOf,
  ISLAND_GROUND,
  RANGE
} from '../world/island'
import { Bombs, bombAdvice } from './bombs'
import { landingAdvice } from './coach'
import { AirCombat } from './combat'
import { Effects } from './effects'
import { combatSetup, MISSIONS, MissionRunner } from './missions'
import { Navigator } from './navigation'
import { Pilot } from './pilot'
import { Storm } from './storm'

const STEP = 1 / 120
const CALM = new Vector3()
const DEGREE = Math.PI / 180

test('every gate stands clear of the ground and close enough to the next to fly', () => {
  for (const mission of MISSIONS) {
    const gates = mission.gates ?? []
    gates.forEach((gate, i) => {
      expect(gate.y - gate.radius).toBeGreaterThan(Math.max(heightAt(gate.x, gate.z), 0))
      const next = gates[i + 1]
      if (next) expect(Math.hypot(next.x - gate.x, next.z - gate.z)).toBeLessThan(20_000)
    })
  }
})

test('a scripted pilot passes the takeoff tutorial', () => {
  const mission = MISSIONS.find(candidate => candidate.id === 'takeoff')
  const spec = HANGAR.find(candidate => candidate.id === 'c172')
  if (!mission || !spec || mission.start.kind !== 'runway') throw new Error('Missing mission')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  // Line up as the game does: 150 m in from the start of the main runway
  const runway = AIRPORTS.find(airport => airport.code === 'CBI')?.runways[0]
  if (!runway) throw new Error('Missing runway')
  const start = fromStrip(runway, -runway.length / 2 + 150, 0)
  sim.placeOnGround(start.x, start.z, (runway.heading * Math.PI) / 180)
  const pilot = new Pilot()
  pilot.resetForGround(sim, false)
  const nav = new Navigator()
  const runner = new MissionRunner()
  runner.start(mission, sim)
  let result = null
  const press = (code: string) => {
    pilot.press(code, false, sim)
    pilot.release(code)
  }
  for (let time = 0; time < 200 && !result && !sim.crash; time += STEP) {
    if (time > 0.5 && pilot.controls.engineSwitches[0] === false) press('KeyI')
    if (sim.engineRunning && pilot.controls.parkingBrake) press('KeyP')
    pilot.controls.throttle = sim.engineRunning ? 1 : 0
    // Rotate at 55 knots, then hold a gentle climb
    const knots = sim.indicatedAirspeed / 0.5144
    pilot.controls.pitch = knots > 55 ? Math.max(-1, Math.min(1, (0.12 - sim.pitch) * 4)) : 0
    pilot.controls.roll = Math.max(-1, Math.min(1, -sim.bank * 2))
    sim.step(STEP, pilot.controls, CALM)
    result = runner.update(STEP, { sim, controls: pilot.controls, pilot, nav, parkedAt: null })
  }
  expect(sim.crash).toBeNull()
  expect(result).toEqual({ passed: true })
})

const KEY_CODES: Record<string, string> = {
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  W: 'KeyW',
  S: 'KeyS',
  A: 'KeyA',
  D: 'KeyD',
  E: 'KeyE',
  Q: 'KeyQ',
  Space: 'Space'
}

test('a pilot who only follows the coach passes the landing tutorial', () => {
  const mission = MISSIONS.find(candidate => candidate.id === 'landing')
  const spec = HANGAR.find(candidate => candidate.id === 'c172')
  if (!mission || !spec || mission.start.kind !== 'approach') throw new Error('Missing mission')
  const { start } = mission
  const approach = APPROACHES.find(candidate => candidate.id === start.approach)
  if (!approach) throw new Error('Missing approach')
  // Start as the game does: on the glide path, trimmed, with full flaps
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const { x, z } = onCentreline(approach.end, start.distance)
  const heading = (approach.end.heading * Math.PI) / 180
  sim.placeInAir(
    x,
    pathAltitude(approach.end, approach.glide, start.distance),
    z,
    heading,
    start.speed * KNOT
  )
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  const flapNotch = start.flapNotch ?? 0
  Object.assign(pilot.controls, {
    flapNotch,
    ...sim.settleOnPath(approach.glide, flapNotch, true, CALM)
  })
  const nav = new Navigator()
  nav.select(approach, sim)
  const runner = new MissionRunner()
  runner.start(mission, sim)
  // Every 0.3 s, like a pilot reading the coach: hold the keys it says to hold, tap the others
  const held = new Set<string>()
  let result = null
  for (let time = 0; time < 400 && !result && !sim.crash; time += STEP) {
    if (Math.round(time / STEP) % 36 === 0) {
      const text = landingAdvice(sim, nav, pilot)?.text ?? ''
      const fine = text.includes('hold [Shift] and [↓]')
      const hold = new Set<string>(fine ? ['ArrowDown'] : [])
      for (const [, verb, key] of text.matchAll(/(tap|hold) \[([^\]]+)\]/gi)) {
        const code = KEY_CODES[key]
        if (!code) continue
        if (verb.toLowerCase() === 'hold') hold.add(code)
        else {
          pilot.press(code, false, sim, nav)
          pilot.update(0.15, sim, nav)
          pilot.release(code)
        }
      }
      for (const code of held) if (!hold.has(code)) pilot.release(code)
      for (const code of hold) pilot.press(code, held.has(code), sim, nav, fine)
      if (!fine) pilot.release('ShiftLeft')
      held.clear()
      for (const code of hold) held.add(code)
    }
    nav.update(sim)
    pilot.update(STEP, sim, nav)
    sim.step(STEP, pilot.controls, CALM)
    result = runner.update(STEP, { sim, controls: pilot.controls, pilot, nav, parkedAt: null })
  }
  expect(sim.crash).toBeNull()
  expect(result).toMatchObject({ passed: true })
})

test('passengers forgive a brief steep bank but not a long one', () => {
  const mission = MISSIONS.find(candidate => candidate.id === 'morning-shuttle')
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  if (!mission || !spec) throw new Error('Missing mission')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  sim.placeInAir(0, 1500, 0, 0, 120)
  const pilot = new Pilot()
  const nav = new Navigator()
  const runner = new MissionRunner()
  runner.start(mission, sim)
  const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null }
  const fly = (seconds: number, bank: number) => {
    sim.bank = bank
    let result = null
    for (let time = 0; time < seconds && !result; time += STEP)
      result = runner.update(STEP, context)
    return result
  }
  // A second and a half at 50° only warns, and the warning clears once level again
  expect(fly(1.5, 0.87)).toBeNull()
  expect(runner.warning?.text).toContain('Roll level')
  expect(fly(3, 0)).toBeNull()
  expect(runner.warning).toBeNull()
  // Four seconds at 50° frightens them
  expect(fly(5, 0.87)).toMatchObject({ passed: false })
})

const turnTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))

test('a scripted B-2 crew passes every bombing mission with targets', () => {
  // Bombing missions with targets to aim at. Demolition, over a whole city, has none.
  const aimed = MISSIONS.filter(candidate => candidate.bombs && candidate.targets?.length)
  for (const mission of aimed) {
    const spec = HANGAR.find(candidate => candidate.id === mission.aircraft)
    const start = mission.start
    if (!spec || start.kind !== 'air') throw new Error('Missing mission')
    const sim = new FlightSim(ISLAND_GROUND, spec)
    sim.placeInAir(
      start.x,
      start.altitude,
      start.z,
      (start.heading * Math.PI) / 180,
      start.speed * KNOT
    )
    const pilot = new Pilot()
    pilot.resetForAir(spec, sim)
    Object.assign(pilot.controls, sim.settleOnPath(0, 0, false, CALM))
    pilot.engage(true, sim)
    pilot.autothrottle.speed = start.speed * KNOT
    pilot.toggleAutothrottle(sim)
    const nav = new Navigator()
    const runner = new MissionRunner()
    runner.start(mission, sim)
    const bombs = new Bombs()
    bombs.load(mission.bombs ?? 0, mission.targets ?? [], mission.guided)
    const context = {
      sim,
      controls: pilot.controls,
      pilot,
      nav,
      parkedAt: null,
      bombs,
      bombsight: true
    }
    let result = null
    let pressed = Number.NEGATIVE_INFINITY
    for (let time = 0; time < mission.timeLimit && !result && !sim.crash; time += STEP) {
      // Through the gates first, then point the ground track at the target, as the card says
      const gate = mission.gates?.[runner.gates]
      const target = bombs.targets[bombs.nearestStanding(bombs.aim.x, bombs.aim.z)]
      const aim = gate ?? target
      if (aim) {
        const bearing = Math.atan2(aim.x - sim.position.x, -(aim.z - sim.position.z))
        const off = turnTo(Math.atan2(sim.velocity.x, -sim.velocity.z), bearing)
        pilot.autopilot.heading = gate
          ? bearing
          : sim.heading + Math.max(-0.4, Math.min(0.4, off * 2.5))
      }
      pilot.autopilot.hold = gate ? gate.y : mission.gates ? RANGE.elevation + 250 : start.altitude
      const advice = bombAdvice(bombs, sim) ?? ''
      // One press a second at most, as a player would
      if (/^(On target|Lined up|In the launch zone)/.test(advice) && time - pressed > 1) {
        bombs.release(sim)
        pressed = time
      }
      pilot.update(STEP, sim, nav)
      sim.step(STEP, pilot.controls, CALM)
      bombs.update(STEP, sim, ISLAND_GROUND)
      result = runner.update(STEP, context)
    }
    expect(sim.crash).toBeNull()
    expect(result).toMatchObject({ passed: true })
  }
})

/** An A320 just above the sea, sinking at `sink` m/s with the gear up or down. */
function overSea(sink: number, gearDown: boolean) {
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  if (!spec) throw new Error('Missing a320')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  // Open sea east of Coral Bay, the engine pods half a metre above the water
  sim.placeInAir(9000, 3.6, -4900, Math.PI / 2, 70)
  sim.velocity.y = -sink
  sim.gearPosition = gearDown ? 1 : 0
  const controls = { ...new Pilot().controls, throttle: 0, gearDown }
  for (let time = 0; time < 40 && !sim.crash; time += STEP) sim.step(STEP, controls, CALM)
  return sim
}

test('a gentle touch on the sea with the gear up is a ditching that floats to a stop', () => {
  const sim = overSea(1, false)
  expect(sim.crash).toBeNull()
  expect(sim.ditched).toBe(true)
  expect(sim.groundSpeed).toBeLessThan(1.5)
  // Gear down the wheels dig in, and sinking fast the hull breaks up
  expect(overSea(1, true).crash).toBe('water')
  expect(overSea(6, false).crash).toBe('water')
})

test('an engine fire goes out only once the engine is shut down', () => {
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  if (!spec) throw new Error('Missing a320')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  sim.placeInAir(9000, 1500, -4900, Math.PI / 2, 110)
  sim.engines[0].fire = true
  expect(sim.extinguish(0, true)).toBe(false)
  expect(sim.engines[0].fire).toBe(true)
  expect(sim.extinguish(0, false)).toBe(true)
  expect(sim.engines[0].fire).toBe(false)
})

test('a crew that puts out both fires and ditches gently passes Double Engine Fire', () => {
  const mission = MISSIONS.find(candidate => candidate.id === 'dual-fire')
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  const start = mission?.start
  if (!mission || !spec || start?.kind !== 'air') throw new Error('Missing mission')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  sim.placeInAir(
    start.x,
    start.altitude,
    start.z,
    (start.heading * Math.PI) / 180,
    start.speed * KNOT
  )
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  Object.assign(pilot.controls, sim.settleOnPath(0, 0, false, CALM))
  pilot.engage(true, sim)
  const nav = new Navigator()
  const runner = new MissionRunner()
  runner.start(mission, sim)
  const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null }
  const tap = (code: string, shift = false) => {
    pilot.press(code, false, sim, nav, shift)
    pilot.release(code)
  }
  let result = null
  for (let time = 0; time < mission.timeLimit && !result && !sim.crash; time += STEP) {
    const burning = sim.engines.some(engine => engine.fire)
    if (burning && pilot.controls.engineSwitches[0])
      for (const key of ['Digit1', 'Digit2']) tap(key)
    else if (burning) for (const key of ['Digit1', 'Digit2']) tap(key, true)
    if (time > 10 && !nav.approach) nav.cycle(sim, 0)
    // Glide north over open sea, level off just above the water until slow, then settle
    pilot.autopilot.heading = 0
    const slow = sim.indicatedAirspeed / KNOT < 160
    const height = sim.position.y - (slow ? 0 : 12)
    const sink = sim.position.y < 15 && !slow ? 0 : Math.min(6, Math.max(1, height / 7))
    pilot.autopilot.hold = sim.position.y - sink / 0.12
    pilot.update(STEP, sim, nav)
    sim.step(STEP, pilot.controls, CALM)
    result = runner.update(STEP, context)
  }
  expect(sim.crash).toBeNull()
  expect(sim.ditched).toBe(true)
  expect(result).toMatchObject({ passed: true })
})

/** An A320 with the gear up just above Coral Bay's runway, sinking at `sink` m/s and banked. */
function overRunway(sink: number, bank: number) {
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  const runway = AIRPORTS.find(airport => airport.code === 'CBI')?.runways[0]
  if (!spec || !runway) throw new Error('Missing a320 or runway')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const { x, z } = fromStrip(runway, -runway.length / 2 + 400, 0)
  // The lowest part of the underside half a metre above the runway
  const belly = Math.max(...spec.hullPoints.map(point => (point.underside ? -point.position.y : 0)))
  sim.placeInAir(x, heightAt(x, z) + belly + 0.5, z, (runway.heading * Math.PI) / 180, 70)
  sim.orientation.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -bank))
  sim.velocity.y = -sink
  const controls = { ...new Pilot().controls, throttle: 0, gearDown: false }
  for (let time = 0; time < 40 && !sim.crash; time += STEP) sim.step(STEP, controls, CALM)
  return sim
}

test('a gentle wheels-up touchdown is a belly landing that slides to a stop', () => {
  const sim = overRunway(1, 0)
  expect(sim.crash).toBeNull()
  expect(sim.bellied).toBe(true)
  expect(sim.groundSpeed).toBeLessThan(1.5)
  expect(sim.enginesRunning).toBe(0)
  // Sinking fast or banked steeply, the airframe breaks up
  expect(overRunway(5, 0).crash).toBe('gear-up')
  expect(overRunway(1, 0.35).crash).not.toBeNull()
})

/**
 * A mission's aircraft placed at its approach start the way the game does it, with the
 * approach tuned in and the autopilot, autothrottle, and approach mode flying it.
 */
function onAutoland(id: string) {
  const mission = MISSIONS.find(candidate => candidate.id === id)
  const spec = HANGAR.find(candidate => candidate.id === mission?.aircraft)
  const start = mission?.start
  const approach = APPROACHES.find(candidate => candidate.id === mission?.approach)
  if (!mission || !spec || start?.kind !== 'approach' || !approach) {
    throw new Error(`Missing mission ${id}`)
  }
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const { x, z } = onCentreline(approach.end, start.distance)
  const altitude = pathAltitude(approach.end, approach.glide, start.distance)
  sim.placeInAir(x, altitude, z, (approach.end.heading * Math.PI) / 180, start.speed * KNOT)
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  const flapNotch = start.flapNotch ?? 0
  Object.assign(pilot.controls, {
    flapNotch,
    ...sim.settleOnPath(approach.glide, flapNotch, start.gearDown ?? false, CALM)
  })
  const nav = new Navigator()
  nav.select(approach, sim)
  const tap = (code: string) => {
    pilot.press(code, false, sim, nav)
    pilot.release(code)
  }
  for (const code of ['KeyZ', 'KeyX']) tap(code)
  pilot.flyApproach(true, sim, nav)
  return { mission, sim, pilot, nav, tap }
}

/** Steps an autoland mission to its end; `act` presses keys along the way. */
function land(
  { mission, sim, pilot, nav }: ReturnType<typeof onAutoland>,
  act: (time: number) => void
) {
  const runner = new MissionRunner()
  runner.start(mission, sim)
  const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null }
  let result = null
  for (let time = 0; time < 600 && !result && !sim.crash; time += STEP) {
    nav.update(sim)
    pilot.update(STEP, sim, nav)
    act(time)
    sim.step(STEP, pilot.controls, CALM)
    result = runner.update(STEP, context)
  }
  return result
}

test('a crew that sets full flap and lands on the belly passes Gear Won’t Come Down', () => {
  const flight = onAutoland('gear-stuck')
  const { sim, pilot, tap } = flight
  tap('KeyG')
  const result = land(flight, time => {
    // One more notch of flap every 3 seconds, up to full
    if (pilot.controls.flapNotch < 4 && Math.round(time / STEP) % 360 === 0) tap('KeyF')
  })
  expect(sim.crash).toBeNull()
  expect(sim.bellied).toBe(true)
  expect(sim.gearPosition).toBe(0)
  expect(result).toMatchObject({ passed: true })
})

test('a crew that flies a fast flapless approach and brakes hard passes Hydraulic Failure', () => {
  const flight = onAutoland('hydraulics')
  const { sim, pilot, tap } = flight
  const result = land(flight, () => {
    if (sim.hydraulicsFailed && !pilot.controls.gearDown) tap('KeyG')
    if (sim.hydraulicsFailed && pilot.controls.flapNotch === 0) tap('KeyF')
    if (!sim.onGround) return
    pilot.controls.brake = 1
    pilot.controls.reverse = true
  })
  expect(sim.crash).toBeNull()
  expect(sim.flapPosition).toBe(0)
  expect(result).toMatchObject({ passed: true })
})

test('a crew that shuts down the leaking engine and diverts passes Fuel Leak', () => {
  const { mission, sim, pilot } = airStart('fuel-leak')
  const nav = new Navigator()
  const tap = (code: string) => {
    pilot.press(code, false, sim, nav)
    pilot.release(code)
  }
  const runner = new MissionRunner()
  runner.start(mission, sim)
  const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null }
  pilot.engage(true, sim)
  pilot.autothrottle.speed = 230 * KNOT
  pilot.toggleAutothrottle(sim)
  // Down to 3,600 ft at a point 20 km out on the centreline, then the approach mode takes over
  const runway = APPROACHES.find(candidate => candidate.id === 'ILS 33 EMK')
  if (!runway) throw new Error('Missing approach')
  const join = onCentreline(runway.end, 20_000)
  let result = null
  for (let time = 0; time < (mission.timeLimit ?? 900) && !result && !sim.crash; time += STEP) {
    if (sim.fuelLeak > 0 && pilot.controls.engineSwitches[1]) tap('Digit2')
    // Cycle the nearest runways until Eastmark's runway 33 comes up
    if (time > 15 && nav.approach?.id !== runway.id) nav.cycle(sim, 0)
    const toJoin = Math.hypot(join.x - sim.position.x, join.z - sim.position.z)
    if (pilot.autopilot.lateral !== 'APP' && toJoin > 3000) {
      pilot.autopilot.heading = Math.atan2(join.x - sim.position.x, sim.position.z - join.z)
      pilot.autopilot.hold = 1100
    } else if (nav.approach) pilot.flyApproach(true, sim, nav)
    if (nav.onFinal && pilot.controls.flapNotch < 4 && Math.round(time / STEP) % 360 === 0) {
      tap('KeyF')
    }
    if (nav.onFinal && !pilot.controls.gearDown) tap('KeyG')
    nav.update(sim)
    pilot.update(STEP, sim, nav)
    sim.step(STEP, pilot.controls, CALM)
    result = runner.update(STEP, context)
  }
  expect(sim.crash).toBeNull()
  // One engine still running on the trickle of fuel left
  expect(sim.enginesRunning).toBe(1)
  expect(result).toMatchObject({ passed: true })
})

test('a scripted crew passes every missile strike mission', () => {
  // Missiles at ground targets; the air combat missions have their own test
  const strikes = MISSIONS.filter(candidate => candidate.missiles && !combatSetup(candidate))
  for (const mission of strikes) {
    const spec = HANGAR.find(candidate => candidate.id === mission.aircraft)
    const start = mission.start
    if (!spec || start.kind !== 'air') throw new Error('Missing mission')
    const sim = new FlightSim(ISLAND_GROUND, spec)
    sim.placeInAir(
      start.x,
      start.altitude,
      start.z,
      (start.heading * Math.PI) / 180,
      start.speed * KNOT
    )
    const pilot = new Pilot()
    pilot.resetForAir(spec, sim)
    Object.assign(pilot.controls, sim.settleOnPath(0, 0, false, CALM))
    pilot.engage(true, sim)
    const nav = new Navigator()
    const runner = new MissionRunner()
    runner.start(mission, sim)
    const bombs = new Bombs()
    bombs.load(0, mission.targets ?? [], false, mission.missiles)
    const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null, bombs }
    let result = null
    for (let time = 0; time < mission.timeLimit && !result && !sim.crash; time += STEP) {
      // Fly at the nearest target, coming down to about 2,600 ft above the range. Under the
      // radar, skim 60 m above the highest ground ahead until the radar is down.
      const target = bombs.targets[bombs.nearestStanding(sim.position.x, sim.position.z)]
      if (target) {
        pilot.autopilot.heading = Math.atan2(target.x - sim.position.x, sim.position.z - target.z)
      }
      pilot.autopilot.hold = RANGE.elevation + 800
      if (mission.id === 'under-the-radar' && !bombs.destroyed[0]) {
        let ground = 0
        for (let ahead = 0; ahead <= 2500; ahead += 250) {
          const x = sim.position.x + Math.sin(sim.heading) * ahead
          const z = sim.position.z - Math.cos(sim.heading) * ahead
          ground = Math.max(ground, heightAt(x, z))
        }
        pilot.autopilot.hold = ground + 60
      }
      if (bombs.lock >= 0) bombs.fire(sim)
      pilot.update(STEP, sim, nav)
      sim.step(STEP, pilot.controls, CALM)
      bombs.update(STEP, sim, ISLAND_GROUND)
      result = runner.update(STEP, context)
    }
    expect(sim.crash).toBeNull()
    expect(result).toMatchObject({ passed: true })
  }
})

/** Steps a mission until it ends or the aircraft crashes, letting `fly` work the controls. */
function runMission(
  mission: (typeof MISSIONS)[number],
  sim: FlightSim,
  pilot: Pilot,
  fly: (time: number) => void
) {
  const nav = new Navigator()
  const runner = new MissionRunner()
  runner.start(mission, sim)
  const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null }
  let result = null
  // Missions without a time limit get five minutes
  const seconds = mission.timeLimit ?? 300
  for (let time = 0; time < seconds && !result && !sim.crash; time += STEP) {
    fly(time)
    sim.step(STEP, pilot.controls, CALM)
    result = runner.update(STEP, context)
  }
  return result
}

/** A mission's aircraft placed at its air start, the way the game does it. */
function airStart(id: string) {
  const mission = MISSIONS.find(candidate => candidate.id === id)
  const spec = HANGAR.find(candidate => candidate.id === mission?.aircraft)
  const start = mission?.start
  if (!mission || !spec || start?.kind !== 'air') throw new Error(`Missing mission ${id}`)
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const heading = (start.heading * Math.PI) / 180
  sim.placeInAir(start.x, start.altitude, start.z, heading, start.speed * KNOT)
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  const glide = ((start.glide ?? 0) * Math.PI) / 180
  Object.assign(pilot.controls, sim.settleOnPath(glide, 0, false, CALM))
  pilot.controls.speedBrake = start.speedBrake ?? false
  return { mission, spec, sim, pilot, heading }
}

const turnFrom = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))
const limit = (value: number) => Math.max(-1, Math.min(1, value))

test('a scripted crew rides the steep glide and lands the Shuttle', () => {
  const { mission, spec, sim, pilot, heading } = airStart('shuttle-landing')
  const runway = AIRPORTS.find(airport => airport.code === 'PAZ')?.runways[0]
  if (!runway) throw new Error('Missing runway')
  const elevation = heightAt(runway.x, runway.z)
  const c = pilot.controls
  let attitude = sim.pitch
  const result = runMission(mission, sim, pilot, () => {
    const height = Math.min(sim.altitudeAgl, sim.position.y - elevation) - spec.restHeight
    const knots = sim.indicatedAirspeed / KNOT
    if (sim.onGround) {
      // Lower the nose at 1.5°/s and brake
      attitude = Math.max(-0.02, attitude - 1.5 * DEGREE * STEP)
      c.pitch = limit((attitude - sim.pitch) * 8 - sim.angularVelocity.x * 4)
      c.brake = 1
      return
    }
    // 19° down the outer glideslope, a preflare from 2,000 ft onto 1.5°, then the flare
    let glide = 19
    if (height < 610) glide = 1.5 + 17.5 * Math.sqrt(Math.max(0, (height - 50) / 560))
    if (height < 25) glide = 0.25 + (height / 25) * 1.25
    const error = -sim.trueAirspeed * Math.sin(glide * DEGREE) - sim.verticalSpeed
    attitude += error * 0.01 * STEP
    c.pitch = limit((attitude + error * 0.012 - sim.pitch) * 4 - sim.angularVelocity.x * 2)
    const track = Math.atan2(sim.velocity.x, -sim.velocity.z)
    c.roll = limit((turnFrom(track, heading) * 2 - sim.bank) * 3)
    c.speedBrake = height > 610 && (knots > 300 || (c.speedBrake && knots > 290))
    c.gearDown = height < 91
  })
  expect(sim.crash).toBeNull()
  expect(result).toMatchObject({ passed: true })
})

test('a pilot holding right rudder keeps the Mustang straight and climbs away', () => {
  const mission = MISSIONS.find(candidate => candidate.id === 'mustang-takeoff')
  const spec = HANGAR.find(candidate => candidate.id === 'p51')
  const runway = AIRPORTS.find(airport => airport.code === 'CBI')?.runways[0]
  if (!mission || !spec || !runway) throw new Error('Missing mission')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const start = fromStrip(runway, -runway.length / 2 + 150, 0)
  const course = (runway.heading * Math.PI) / 180
  sim.placeOnGround(start.x, start.z, course)
  const pilot = new Pilot()
  pilot.resetForGround(sim, false)
  const c = pilot.controls
  const tap = (code: string) => {
    pilot.press(code, false, sim)
    pilot.release(code)
  }
  const result = runMission(mission, sim, pilot, time => {
    if (time > 0.5 && !c.engineSwitches[0]) tap('KeyI')
    if (sim.enginesRunning && c.parkingBrake) tap('KeyP')
    pilot.update(STEP, sim)
    if (sim.enginesRunning) c.throttle = 1
    // Rudder holds the runway heading; the stick keeps the tail down, then lifts off
    c.yaw = limit(turnFrom(sim.heading, course) * 6 - sim.turnRate * 2)
    const wanted = sim.onGround ? (sim.indicatedAirspeed / KNOT > 105 ? 0.2 : sim.pitch) : 0.15
    c.pitch = limit((wanted - sim.pitch) * 3 - sim.angularVelocity.x)
    c.roll = limit(-sim.bank * 2)
    if (!sim.onGround && sim.altitudeAgl > 30) c.gearDown = false
  })
  expect(sim.crash).toBeNull()
  expect(result).toMatchObject({ passed: true })
})

test('a racing pilot banking steeply flies the Mustang lap in time', () => {
  const { mission, sim, pilot } = airStart('mustang-race')
  pilot.engage(true, sim)
  const runner = { gates: 0 }
  const result = runMission(mission, sim, pilot, () => {
    const gate = mission.gates?.[runner.gates]
    if (gate) {
      // Count gates as the mission does, to steer for the next
      const near = Math.hypot(
        gate.x - sim.position.x,
        gate.y - sim.position.y,
        gate.z - sim.position.z
      )
      if (near < gate.radius) runner.gates++
      pilot.autopilot.heading = Math.atan2(gate.x - sim.position.x, sim.position.z - gate.z)
      pilot.autopilot.hold = gate.y
    }
    pilot.update(STEP, sim)
    pilot.controls.throttle = 1
    // Up to 40° of bank toward the next gate; the autopilot holds the height
    const track = Math.atan2(sim.velocity.x, -sim.velocity.z)
    const bank = Math.max(-0.7, Math.min(0.7, turnFrom(track, pilot.autopilot.heading) * 4))
    pilot.controls.roll = limit((bank - sim.bank) * 1.5 + sim.angularVelocity.z * 0.3)
  })
  expect(sim.crash).toBeNull()
  expect(result).toMatchObject({ passed: true })
})

/** A repeatable stand-in for Math.random, so a fight with random flares plays the same way. */
function seeded(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mix = Math.imul(state ^ (state >>> 15), 1 | state)
    mix = (mix + Math.imul(mix ^ (mix >>> 7), 61 | mix)) ^ mix
    return ((mix ^ (mix >>> 14)) >>> 0) / 4294967296
  }
}

/** The lowest any live enemy has flown above the ground or sea, in metres. */
function lowestEnemy(combat: AirCombat, lowest: number) {
  for (const enemy of combat.enemies) {
    if (!enemy.alive) continue
    const { x, y, z } = enemy.position
    lowest = Math.min(lowest, y - Math.max(heightAt(x, z), 0))
  }
  return lowest
}

/**
 * A fighter pilot for the air combat tests. Each step drops flares and breaks hard when a
 * missile comes, otherwise chases the nearest enemy with no missile on its way yet, those
 * hunting the escort first, and fires on a lock. Call `fly` before stepping the aircraft.
 */
function fighterPilot(sim: FlightSim, pilot: Pilot, combat: AirCombat, nav: Navigator) {
  let breakUntil = -1
  let lastFlare = -9
  let side = 1
  return (time: number) => {
    if (combat.warning && time - lastFlare > 1.2) {
      combat.dropFlares(sim)
      lastFlare = time
      breakUntil = time + 3
      side = -side
    }
    const free = combat.enemies.filter(
      enemy => enemy.alive && !combat.missiles.some(missile => missile.target === enemy)
    )
    const distance = (enemy: (typeof free)[number]) =>
      enemy.position.distanceTo(sim.position) - (enemy.prey === 'escort' ? 20_000 : 0)
    const nearest = free.sort((a, b) => distance(a) - distance(b))[0]
    if (time < breakUntil) pilot.autopilot.heading = sim.heading + side * 1.2
    else if (nearest) {
      const lead = nearest.position.clone().addScaledVector(nearest.velocity, 2)
      pilot.autopilot.heading = Math.atan2(lead.x - sim.position.x, sim.position.z - lead.z)
      pilot.autopilot.hold = Math.max(1200, nearest.position.y)
    }
    // Stay 700 m above the highest ground in the next 20 seconds of flight
    let ground = 0
    for (let seconds = 0; seconds <= 20; seconds += 2) {
      const x = sim.position.x + sim.velocity.x * seconds
      const z = sim.position.z + sim.velocity.z * seconds
      ground = Math.max(ground, heightAt(x, z))
    }
    pilot.autopilot.hold = Math.max(pilot.autopilot.hold, ground + 700)
    if (combat.lock >= 0) combat.fire(sim)
    pilot.update(STEP, sim, nav)
    // Bank up to 77° toward the chosen heading and slow toward 380 kt in a hard turn.
    // Low, or under 1,000 m above the ground ahead, bank no more than 45° so it can climb.
    const track = Math.atan2(sim.velocity.x, -sim.velocity.z)
    const error = turnFrom(track, pilot.autopilot.heading)
    const low = sim.altitudeAgl < 460 || sim.position.y < Math.max(ground, 0) + 1000
    const most = low ? 0.8 : 1.35
    const bank = Math.max(-most, Math.min(most, error * 3))
    pilot.controls.roll = limit((bank - sim.bank) * 1.5 + sim.angularVelocity.z * 0.3)
    const slow = sim.indicatedAirspeed / KNOT > 380 ? 0 : 0.9
    pilot.controls.throttle = Math.abs(error) > 0.5 ? slow : 1
  }
}

test('a fighter pilot who turns hard and uses flares wins every air combat mission in the air', () => {
  const random = Math.random
  Math.random = seeded(7)
  try {
    const fights = MISSIONS.filter(
      candidate => combatSetup(candidate) && candidate.start.kind === 'air'
    )
    expect(fights.map(mission => mission.id)).toContain('escort')
    for (const mission of fights) {
      const { sim, pilot } = airStart(mission.id)
      pilot.engage(true, sim)
      const combat = new AirCombat()
      const setup = combatSetup(mission)
      if (setup) combat.load(setup)
      const effects = new Effects()
      const nav = new Navigator()
      const fly = fighterPilot(sim, pilot, combat, nav)
      const runner = new MissionRunner()
      runner.start(mission, sim)
      const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null, combat }
      let result = null
      let lowest = Number.POSITIVE_INFINITY
      for (let time = 0; time < mission.timeLimit && !result && !sim.crash; time += STEP) {
        fly(time)
        sim.step(STEP, pilot.controls, CALM)
        for (const event of combat.update(STEP, sim, ISLAND_GROUND, effects)) {
          if (event.kind === 'hit') sim.crash = 'missile'
        }
        result = runner.update(STEP, context)
        lowest = lowestEnemy(combat, lowest)
      }
      // Enemies never fly into the ground or the sea
      expect(lowest).toBeGreaterThan(30)
      expect(sim.crash).toBeNull()
      expect(result).toMatchObject({ passed: true })
    }
  } finally {
    Math.random = random
  }
})

test('enemies wait within reach of the base while the player is down rearming', () => {
  const mission = MISSIONS.find(candidate => candidate.id === 'ace-in-a-day')
  const spec = HANGAR.find(candidate => candidate.id === 'f16')
  const setup = mission && combatSetup(mission)
  const runway = AIRPORTS.find(airport => airport.code === 'EMK')?.runways[0]
  if (!spec || !setup || !runway) throw new Error('Missing mission')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const course = (runway.heading * Math.PI) / 180
  const combat = new AirCombat()
  combat.load(setup)
  const effects = new Effects()
  // Climb out to call the first wave, then sit on the runway for three minutes
  sim.placeInAir(runway.x, heightAt(runway.x, runway.z) + 2500, runway.z, course, 200)
  combat.update(STEP, sim, ISLAND_GROUND, effects)
  expect(combat.alive).toBe(2)
  sim.placeOnGround(runway.x, runway.z, course)
  const controls = { ...new Pilot().controls, throttle: 0, parkingBrake: true }
  let fired = false
  for (let time = 0; time < 180; time += STEP) {
    sim.step(STEP, controls, CALM)
    combat.update(STEP, sim, ISLAND_GROUND, effects)
    fired ||= combat.missiles.length > 0
  }
  expect(fired).toBe(false)
  for (const enemy of combat.enemies) {
    expect(enemy.position.distanceTo(sim.position)).toBeLessThan(10_000)
  }
})

test('a pilot who lands to rearm between waves shoots down all three in Ace in a Day', () => {
  const random = Math.random
  Math.random = seeded(11)
  try {
    const mission = MISSIONS.find(candidate => candidate.id === 'ace-in-a-day')
    const spec = HANGAR.find(candidate => candidate.id === 'f16')
    const setup = mission && combatSetup(mission)
    const runway = AIRPORTS.find(airport => airport.code === 'EMK')?.runways[0]
    if (!mission || !spec || !setup || !runway) throw new Error('Missing mission')
    const course = (runway.heading * Math.PI) / 180
    const elevation = heightAt(runway.x, runway.z)
    const sim = new FlightSim(ISLAND_GROUND, spec)
    const start = fromStrip(runway, -runway.length / 2 + 150, 0)
    sim.placeOnGround(start.x, start.z, course)
    const pilot = new Pilot()
    pilot.resetForGround(sim, false)
    const combat = new AirCombat()
    combat.load(setup)
    const effects = new Effects()
    const nav = new Navigator()
    const fly = fighterPilot(sim, pilot, combat, nav)
    const runner = new MissionRunner()
    runner.start(mission, sim)
    const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null, combat }
    const enemies = setup.waves?.flat().length ?? 0
    // Takeoffs and approaches are not what this tests: the pilot appears 8,000 ft over the
    // base, or 3 m above the runway on short final, sinking gently with the gear down
    const climbOut = () => {
      sim.placeInAir(runway.x, elevation + 2500, runway.z, course, 420 * KNOT)
      pilot.resetForAir(spec, sim)
      Object.assign(pilot.controls, sim.settleOnPath(0, 0, false, CALM))
      pilot.engage(true, sim)
    }
    const shortFinal = () => {
      const { x, z } = fromStrip(runway, -runway.length / 2 + 300, 0)
      const height = elevation + spec.restHeight + 3
      sim.placeInAir(x, height, z, course, spec.approachSpeed * KNOT)
      pilot.resetForAir(spec, sim)
      Object.assign(pilot.controls, sim.settleOnPath(1 * DEGREE, 0, true, CALM))
      pilot.controls.gearDown = true
      pilot.controls.throttle = 0
    }
    let result = null
    let landings = 0
    let lowest = Number.POSITIVE_INFINITY
    for (let time = 0; time < mission.timeLimit && !result && !sim.crash; time += STEP) {
      const waveDown = combat.alive === 0 && (combat.awaitingRearm || combat.downed === enemies)
      const empty = combat.ammo === 0 && !combat.missiles.some(missile => missile.fromPlayer)
      if (sim.onGround) {
        // Brake to a stop and wait for the ground crew, then go again
        pilot.controls.brake = 1
        pilot.controls.throttle = 0
        if (combat.rearm === 0 && !combat.awaitingRearm && combat.downed < enemies) {
          if (combat.ammo > 0 && sim.groundSpeed < 1.5) climbOut()
        }
      } else if (pilot.autopilot.on && (waveDown || (empty && combat.alive > 0))) {
        shortFinal()
        landings++
      } else if (pilot.autopilot.on) fly(time)
      sim.step(STEP, pilot.controls, CALM)
      for (const event of combat.update(STEP, sim, ISLAND_GROUND, effects)) {
        if (event.kind === 'hit') sim.crash = 'missile'
      }
      result = runner.update(STEP, context)
      lowest = lowestEnemy(combat, lowest)
    }
    expect(lowest).toBeGreaterThan(30)
    expect(sim.crash).toBeNull()
    expect(result).toMatchObject({ passed: true })
    expect(combat.downed).toBe(9)
    expect(landings).toBeGreaterThanOrEqual(3)
  } finally {
    Math.random = random
  }
})

test('a crew on the autopilot who adds full power at the WINDSHEAR call passes Storm Approach', () => {
  const mission = MISSIONS.find(candidate => candidate.id === 'storm-approach')
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  const start = mission?.start
  const approach = APPROACHES.find(candidate => candidate.id === mission?.approach)
  if (!mission || !spec || start?.kind !== 'approach' || !approach)
    throw new Error('Missing mission')
  // Start as the game does: on the glide path with flaps 2
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const { x, z } = onCentreline(approach.end, start.distance)
  const altitude = pathAltitude(approach.end, approach.glide, start.distance)
  const course = (approach.end.heading * Math.PI) / 180
  sim.placeInAir(x, altitude, z, course, start.speed * KNOT)
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  // The game's light wind from 060°, plus the storm's gusts and the mission's microburst
  const storm = new Storm()
  storm.reset()
  const wind = new Vector3()
  const blow = (dt: number) => {
    wind.set(-Math.sin(60 * DEGREE) * 4, 0, Math.cos(60 * DEGREE) * 4)
    storm.addWind(dt, sim, true, mission.microburst ?? null, wind)
  }
  blow(0)
  const flapNotch = start.flapNotch ?? 0
  Object.assign(pilot.controls, {
    flapNotch,
    ...sim.settleOnPath(approach.glide, flapNotch, false, wind)
  })
  const nav = new Navigator()
  nav.select(approach, sim)
  const runner = new MissionRunner()
  runner.start(mission, sim)
  const context = { sim, controls: pilot.controls, pilot, nav, parkedAt: null }
  const tap = (code: string) => {
    pilot.press(code, false, sim, nav)
    pilot.release(code)
  }
  // As the first step says: gear, autopilot, autothrottle, and the approach mode of [T]
  for (const code of ['KeyG', 'KeyZ', 'KeyX']) tap(code)
  pilot.flyApproach(true, sim, nav)
  let warned = false
  let result = null
  for (let time = 0; time < 400 && !result && !sim.crash; time += STEP) {
    // One more notch of flap every 2 seconds, up to full
    if (pilot.controls.flapNotch < 4 && Math.round(time / STEP) % 240 === 0) tap('KeyF')
    nav.update(sim)
    pilot.update(STEP, sim, nav)
    // At the WINDSHEAR call, full power until the speed is back above the approach speed
    const shear = storm.detectShear(STEP, sim)
    warned ||= shear
    if (shear && sim.indicatedAirspeed < (spec.approachSpeed + 15) * KNOT) {
      pilot.controls.throttle = 1
    }
    blow(STEP)
    sim.step(STEP, pilot.controls, wind)
    result = runner.update(STEP, context)
  }
  expect(warned).toBe(true)
  expect(sim.crash).toBeNull()
  expect(result).toMatchObject({ passed: true })
})

/**
 * Starts a helicopter mission the way the game does, or in a hover over (`x`, `z`) with the
 * wheels `above` metres up, and flies it with real key presses from `fly`.
 */
function helicopterMission(id: string, hover?: { x: number; z: number; above: number }) {
  const mission = MISSIONS.find(candidate => candidate.id === id)
  const spec = HANGAR.find(candidate => candidate.id === 'uh60')
  if (!mission || !spec || mission.start.kind !== 'air') throw new Error('Missing mission')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const { start } = mission
  if (hover) {
    const ground = Math.max(ISLAND_GROUND.heightAt(hover.x, hover.z), 0)
    sim.placeInAir(hover.x, ground + spec.restHeight + hover.above, hover.z, 0, 0.01)
  } else {
    sim.placeInAir(start.x, start.altitude, start.z, start.heading * DEGREE, start.speed * KNOT)
  }
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  Object.assign(pilot.controls, sim.settleOnPath(0, 0, true, CALM))
  const nav = new Navigator()
  const runner = new MissionRunner()
  runner.start(mission, sim)
  const hold = (code: string, down: boolean) =>
    down ? pilot.press(code, true, sim) : pilot.release(code)
  /** Flies until the mission ends, `seconds` pass, or `until` holds. */
  const fly = (seconds: number, each?: () => void, until?: () => boolean) => {
    let result = null
    for (let time = 0; time < seconds && !result && !sim.crash && !until?.(); time += STEP) {
      each?.()
      pilot.update(STEP, sim)
      sim.step(STEP, pilot.controls, CALM)
      result = runner.update(STEP, { sim, controls: pilot.controls, pilot, nav, parkedAt: null })
    }
    return result
  }
  return { mission, sim, pilot, runner, hold, fly }
}

test('the rescue boat sits on open sea, and the helicopter mission starts are clear of the ground', () => {
  const rescue = MISSIONS.find(candidate => candidate.id === 'sea-rescue')?.rescue
  if (!rescue) throw new Error('Missing rescue')
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
    const x = rescue.x + Math.cos(angle) * 60
    const z = rescue.z + Math.sin(angle) * 60
    expect(ISLAND_GROUND.heightAt(x, z)).toBeLessThan(-5)
  }
  for (const id of ['rooftop-landing', 'sea-rescue', 'autorotation']) {
    const { start } = MISSIONS.find(candidate => candidate.id === id) ?? {}
    if (start?.kind !== 'air') throw new Error(`Missing ${id}`)
    expect(start.altitude - Math.max(ISLAND_GROUND.heightAt(start.x, start.z), 0)).toBeGreaterThan(
      100
    )
  }
})

test('a steady hover over the boat winches all three sailors up, then the roof pad lands them', () => {
  const rescue = MISSIONS.find(candidate => candidate.id === 'sea-rescue')?.rescue
  if (!rescue) throw new Error('Missing rescue')
  const out = helicopterMission('sea-rescue', { x: rescue.x, z: rescue.z, above: 15 })
  out.fly(45, undefined, () => out.runner.aboard >= 3)
  expect(out.sim.crash).toBeNull()
  expect(out.runner.aboard).toBe(3)
  expect(out.runner.step).toBe(3)
  // Fly home in a moment: lift the helicopter to a hover over the hospital roof
  const pad = helipadOf('hospital')
  out.sim.placeInAir(pad.x, pad.elevation + 1.9 + 20, pad.z, 0, 0.01)
  Object.assign(out.pilot.controls, out.sim.settleOnPath(0, 0, true, CALM))
  const result = out.fly(60, () => out.hold('KeyS', true))
  expect(out.sim.crash).toBeNull()
  expect(result).toEqual({ passed: true, touchdown: expect.any(Number) })
})

test('a pilot who drops the collective, glides, flares, and cushions survives the engine failure', () => {
  const { sim, pilot, hold, fly } = helicopterMission('autorotation')
  let phase = 'cruise'
  const result = fly(300, () => {
    const wheels = sim.altitudeAgl - sim.spec.restHeight
    if (phase === 'cruise' && !sim.engineRunning) phase = 'lower'
    if (phase === 'lower') {
      hold('KeyS', pilot.controls.throttle > 0.02)
      if (pilot.controls.throttle <= 0.02) phase = 'glide'
    }
    if (phase === 'glide' && wheels < 30) phase = 'flare'
    if (phase === 'flare') {
      hold('ArrowDown', wheels > 8)
      if (wheels <= 8) phase = 'cushion'
    }
    // Raise the collective only in the last few metres, so the stored spin lasts to the
    // ground, and ease it off again if the helicopter starts to climb
    if (phase === 'cushion') {
      hold('KeyW', !sim.onGround && wheels < 4 && sim.verticalSpeed < -1)
      hold('KeyS', !sim.onGround && sim.verticalSpeed > 0)
      if (sim.onGround) phase = 'stop'
    }
    if (phase === 'stop') {
      hold('KeyW', false)
      hold('KeyS', true)
      hold('Space', true)
    }
  })
  expect(sim.crash).toBeNull()
  expect(result).toEqual({ passed: true, touchdown: expect.any(Number) })
})
