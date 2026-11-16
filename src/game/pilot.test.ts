import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { HANGAR } from '../sim/aircraft'
import { FlightSim } from '../sim/flight-sim'
import { ISLAND_GROUND } from '../world/island'
import { Pilot } from './pilot'

const STEP = 1 / 60

/** Holds a key for `seconds` without moving the aircraft, and returns the stick pitch. */
function hold(pilot: Pilot, sim: FlightSim, code: string, seconds: number, shift = false) {
  pilot.press(code, false, sim, undefined, shift)
  for (let time = 0; time < seconds; time += STEP) pilot.update(STEP, sim)
  return pilot.controls.pitch
}

test('a tap moves the stick a little, holding builds to full travel, Shift keeps it fine', () => {
  const spec = HANGAR.find(candidate => candidate.id === 'c172')
  if (!spec) throw new Error('Missing c172')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  sim.placeOnGround(0, 0, 0)
  const pilot = new Pilot()
  pilot.resetForGround(sim, true)

  expect(hold(pilot, sim, 'ArrowDown', 0.1)).toBeLessThan(0.05)
  pilot.releaseAll()
  pilot.controls.pitch = 0
  expect(hold(pilot, sim, 'ArrowDown', 2)).toBeCloseTo(1, 2)
  pilot.releaseAll()
  pilot.controls.pitch = 0
  expect(hold(pilot, sim, 'ArrowDown', 2, true)).toBeLessThan(0.4)
})

test('Concorde holds a steady Mach 2 cruise at 55,000 ft on the autopilot', () => {
  const spec = HANGAR.find(candidate => candidate.id === 'concorde')
  if (!spec) throw new Error('Missing concorde')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const height = 16_800
  sim.placeInAir(-80_000, height, 60_000, Math.PI / 2, 2 * 295)
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  Object.assign(pilot.controls, sim.settleOnPath(0, 0, false, new Vector3()))
  pilot.engage(true, sim)
  let slip = 0
  for (let time = 0; time < 120 && !sim.crash; time += STEP) {
    pilot.update(STEP, sim)
    pilot.controls.throttle = 0.85
    sim.step(STEP, pilot.controls, new Vector3())
    slip = Math.max(slip, Math.abs(sim.slip))
  }
  // A yaw damper tuned for low speed would swing the tail and bleed the speed away
  expect(sim.crash).toBeNull()
  expect(slip).toBeLessThan(0.02)
  expect(sim.mach).toBeGreaterThan(1.9)
})

test("the Mustang's supercharger carries it past 430 mph at 25,000 ft", () => {
  const spec = HANGAR.find(candidate => candidate.id === 'p51')
  if (!spec) throw new Error('Missing p51')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const height = 25_000 * 0.3048
  sim.placeInAir(-80_000, height, 60_000, Math.PI / 2, 180)
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  Object.assign(pilot.controls, sim.settleOnPath(0, 0, false, new Vector3()))
  pilot.engage(true, sim)
  for (let time = 0; time < 400; time += STEP) {
    pilot.update(STEP, sim)
    pilot.controls.throttle = 1
    sim.step(STEP, pilot.controls, new Vector3())
  }
  // 437 mph (190 m/s) in the flight tests, against 355 mph near sea level
  expect(sim.crash).toBeNull()
  expect(sim.trueAirspeed).toBeGreaterThan(192)
})

/** An A320 trimmed for level flight at 5,000 ft with the autopilot and autothrottle on. */
function cruisingA320() {
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  if (!spec) throw new Error('Missing a320')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  sim.placeInAir(-80_000, 1500, 60_000, Math.PI / 2, 120)
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  Object.assign(pilot.controls, sim.settleOnPath(0, 0, false, new Vector3()))
  pilot.engage(true, sim)
  pilot.toggleAutothrottle(sim)
  return { sim, pilot }
}

test('a light touch on a VR stick leaves the autopilot on, a firm pull takes over', () => {
  const { sim, pilot } = cruisingA320()
  pilot.analog.stick = { pitch: 0.1, roll: 0 }
  pilot.update(STEP, sim)
  expect(pilot.autopilot.on).toBe(true)

  pilot.analog.stick = { pitch: 0.6, roll: 0 }
  pilot.update(STEP, sim)
  expect(pilot.autopilot.on).toBe(false)
  // The autothrottle keeps the speed while the pilot hand-flies
  expect(pilot.autothrottle.on).toBe(true)
  expect(pilot.controls.pitch).toBeGreaterThan(0)
})

test('grabbing the VR throttle lever takes over from the autothrottle', () => {
  const { sim, pilot } = cruisingA320()
  pilot.analog.throttle = 0.2
  pilot.update(STEP, sim)
  expect(pilot.autothrottle.on).toBe(false)
  expect(pilot.controls.throttle).toBe(0.2)
})

test('without pedals, the VR stick steers on the ground and a thumbstick rudder wins', () => {
  const spec = HANGAR.find(candidate => candidate.id === 'c172')
  if (!spec) throw new Error('Missing c172')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  sim.placeOnGround(0, 0, 0)
  sim.onGround = true
  const pilot = new Pilot()
  pilot.resetForGround(sim, false)
  pilot.analog.noPedals = true
  pilot.analog.stick = { pitch: 0, roll: 0.5 }
  pilot.update(STEP, sim)
  expect(pilot.controls.yaw).toBe(0.5)

  pilot.analog.yaw = -0.4
  pilot.update(STEP, sim)
  expect(pilot.controls.yaw).toBe(-0.4)
})
