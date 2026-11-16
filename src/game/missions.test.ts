import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { HANGAR, KNOT } from '../sim/aircraft'
import { FlightSim } from '../sim/flight-sim'
import { APPROACHES, onCentreline, pathAltitude } from '../world/approaches'
import { AIRPORTS, fromStrip, heightAt, ISLAND_GROUND, RANGE } from '../world/island'
import { Bombs, bombAdvice } from './bombs'
import { landingAdvice } from './coach'
import { MISSIONS, MissionRunner } from './missions'
import { Navigator } from './navigation'
import { Pilot } from './pilot'

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

test('a scripted crew passes every missile strike mission', () => {
  for (const mission of MISSIONS.filter(candidate => candidate.missiles)) {
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
      // Fly at the nearest target, coming down to about 2,600 ft above the range
      const target = bombs.targets[bombs.nearestStanding(sim.position.x, sim.position.z)]
      if (target) {
        pilot.autopilot.heading = Math.atan2(target.x - sim.position.x, sim.position.z - target.z)
        pilot.autopilot.hold = RANGE.elevation + 800
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
