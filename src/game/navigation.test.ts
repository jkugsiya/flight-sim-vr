import { expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { HANGAR, KNOT } from '../sim/aircraft'
import { FlightSim } from '../sim/flight-sim'
import { APPROACHES, onCentreline } from '../world/approaches'
import { AIRPORTS, ISLAND_GROUND, isPaved } from '../world/island'
import { Gpws } from './gpws'
import { Navigator, planRoute } from './navigation'
import { Pilot } from './pilot'

const STEP = 1 / 120

/** True at 50 ft over the runway, where the autopilot starts its flare. */
const atMinimums = (sim: FlightSim, nav: Navigator) =>
  nav.onFinal && nav.guidance.along < 2000 && sim.altitudeAgl < 15
const CALM = new Vector3()

test.each([
  ['a320', 'ILS 05 NGT'],
  ['b737', 'ILS 05 NGT'],
  ['b787', 'ILS 05 NGT'],
  ['a380', 'ILS 05 NGT'],
  ['concorde', 'ILS 05 NGT'],
  ['b2', 'ILS 05 NGT'],
  ['c172', 'RNAV 28 MGC']
])('the %s autopilot flies the %s from off to the side down to 50 ft', (id, name) => {
  const spec = HANGAR.find(candidate => candidate.id === id)
  const approach = APPROACHES.find(candidate => candidate.id === name)
  if (!spec || !approach) throw new Error(`Missing ${id} or ${name}`)
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const pilot = new Pilot()
  const nav = new Navigator()
  // Start 6 km left of the centreline, beyond the first waypoint, flying parallel to it
  const start = onCentreline(approach.end, 26_000, -6000)
  const heading = (approach.end.heading * Math.PI) / 180
  sim.placeInAir(start.x, approach.fixes[0].altitude + 300, start.z, heading, spec.cruiseSpeed)
  pilot.resetForAir(spec)
  nav.select(approach, sim)
  pilot.flyApproach(true, sim, nav)
  pilot.press('KeyX', false, sim)
  pilot.autothrottle.speed = spec.approachSpeed * KNOT * 1.3

  let lowest = Number.POSITIVE_INFINITY
  let offPath = 0
  // A flown-by-the-book approach gets height callouts and no ground proximity alerts
  const spoken: string[] = []
  const gpws = new Gpws(phrase => spoken.push(phrase))
  gpws.reset(sim)
  for (let time = 0; time < 900 && !atMinimums(sim, nav) && !sim.crash; time += STEP) {
    // The pilot sets flaps and gear on the way in
    if (nav.active >= 2) pilot.controls.flapNotch = spec.flapLabels.length - 1
    if (nav.active >= 3) pilot.controls.gearDown = true
    nav.update(sim)
    pilot.update(STEP, sim, nav)
    sim.step(STEP, pilot.controls, CALM)
    gpws.update(STEP, sim, pilot.controls, nav)
    const { along, pathAltitude } = nav.guidance
    if (nav.onFinal && along < 6000) lowest = Math.min(lowest, sim.altitudeAgl)
    // Inside the final waypoint the aircraft rides the glide path
    if (along < 7000 && along > 300)
      offPath = Math.max(offPath, Math.abs(sim.position.y - pathAltitude))
  }
  expect(sim.crash).toBeNull()
  expect(atMinimums(sim, nav)).toBe(true)
  expect(Math.abs(nav.guidance.across)).toBeLessThan(25)
  expect(nav.guidance.along).toBeGreaterThan(-300)
  expect(nav.guidance.along).toBeLessThan(700)
  expect(lowest).toBeGreaterThan(10)
  expect(offPath).toBeLessThan(12)
  expect(spoken.filter(phrase => !/^\d+$|^Five hundred$/.test(phrase))).toEqual([])
  expect(spoken).toContain('100')
})

test.each(['a320', 'b787', 'b2'])(
  'the %s autopilot lands itself and brakes on the centreline',
  id => {
    const spec = HANGAR.find(candidate => candidate.id === id)
    const approach = APPROACHES.find(candidate => candidate.id === 'ILS 05 NGT')
    if (!spec || !approach) throw new Error(`Missing ${id}`)
    const sim = new FlightSim(ISLAND_GROUND, spec)
    const pilot = new Pilot()
    const nav = new Navigator()
    const start = onCentreline(approach.end, 20_000)
    const heading = (approach.end.heading * Math.PI) / 180
    sim.placeInAir(
      start.x,
      approach.fixes[1].altitude,
      start.z,
      heading,
      spec.approachSpeed * KNOT * 1.3
    )
    pilot.resetForAir(spec)
    nav.select(approach, sim)
    pilot.flyApproach(true, sim, nav)
    pilot.press('KeyX', false, sim)
    pilot.controls.flapNotch = spec.flapLabels.length - 1
    pilot.controls.gearDown = true
    let sink = 0
    let touchdown = -1
    // The autopilot hands back once slowed to 30 knots on the runway
    for (let time = 0; time < 600 && !sim.crash && pilot.autopilot.on; time += STEP) {
      nav.update(sim)
      pilot.update(STEP, sim, nav)
      sim.step(STEP, pilot.controls, CALM)
      if (!sim.onGround) sink = -sim.verticalSpeed
      else if (touchdown < 0) touchdown = sink
    }
    expect(sim.crash).toBeNull()
    expect(sim.onGround).toBe(true)
    // Under 400 ft/min, on the centreline, and still on the runway
    expect(touchdown).toBeGreaterThan(-0.5)
    expect(touchdown).toBeLessThan(2)
    expect(Math.abs(nav.guidance.across)).toBeLessThan(5)
    expect(isPaved(sim.position.x, sim.position.z)).toBe(true)
    expect(sim.groundSpeed).toBeLessThan(16)
  }
)

test('level change climbs to the altitude knob at the speed knob, then holds it', () => {
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  if (!spec) throw new Error('Missing a320')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  sim.placeInAir(0, 3000, 40_000, 0, spec.cruiseSpeed)
  const pilot = new Pilot()
  pilot.resetForAir(spec, sim)
  pilot.press('KeyX', false, sim)
  pilot.autopilot.altitude = 4000
  pilot.press('KeyY', false, sim)
  pilot.releaseAll()
  for (let time = 0; time < 240 && !sim.crash; time += STEP) {
    pilot.update(STEP, sim)
    sim.step(STEP, pilot.controls, CALM)
  }
  expect(sim.crash).toBeNull()
  expect(pilot.autopilot.vertical).toBe('ALT')
  expect(Math.abs(sim.position.y - 4000)).toBeLessThan(30)
  expect(Math.abs(sim.indicatedAirspeed / pilot.autothrottle.speed - 1)).toBeLessThan(0.1)
})

// A long trip, a short hop that ends past the destination, and one into a mountain valley
test.each([
  ['NGT', 'EMK'],
  ['PAZ', 'CBI'],
  ['CBI', 'RDG']
])('the autopilot flies a flight plan from %s to %s and down its approach', (fromCode, toCode) => {
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  const from = AIRPORTS.find(airport => airport.code === fromCode)
  const to = AIRPORTS.find(airport => airport.code === toCode)
  if (!spec || !from || !to) throw new Error('Missing aircraft or airports')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  const runway = from.runways[0]
  const heading = (runway.heading * Math.PI) / 180
  // Just after takeoff, over the far end of the runway
  const start = {
    x: from.x + Math.sin(heading) * runway.length * 0.5,
    z: from.z - Math.cos(heading) * runway.length * 0.5
  }
  sim.placeInAir(start.x, from.elevation + 300, start.z, heading, 90)
  const pilot = new Pilot()
  const nav = new Navigator()
  pilot.resetForAir(spec, sim)
  nav.load(planRoute({ ...start, heading }, to, spec, 60), sim)
  expect(nav.plan?.fixes.length).toBeGreaterThan(0)
  pilot.press('KeyX', false, sim)
  pilot.autothrottle.speed = 220 * KNOT
  pilot.press('KeyJ', false, sim, nav)
  expect(pilot.autopilot.vertical).toBe('VNAV')
  pilot.releaseAll()

  let reachedCruise = false
  for (let time = 0; time < 1500 && !atMinimums(sim, nav) && !sim.crash; time += STEP) {
    if (nav.plan && Math.abs(sim.position.y - nav.plan.cruise) < 60) reachedCruise = true
    if (!nav.enroute && nav.active >= 2) pilot.controls.flapNotch = spec.flapLabels.length - 1
    if (!nav.enroute && nav.active >= 3) pilot.controls.gearDown = true
    nav.update(sim)
    pilot.update(STEP, sim, nav)
    sim.step(STEP, pilot.controls, CALM)
  }
  expect(sim.crash).toBeNull()
  // Short hops end their route before reaching the cruise altitude
  if (fromCode === 'NGT') expect(reachedCruise).toBe(true)
  // Lined up and slowed to near the approach speed for the flare
  // Down to 50 ft over the runway's near end, not past it
  expect(nav.guidance.along).toBeGreaterThan(-300)
  expect(nav.guidance.along).toBeLessThan(700)
  expect(sim.indicatedAirspeed / KNOT).toBeLessThan(spec.approachSpeed * 1.2)
  expect(atMinimums(sim, nav)).toBe(true)
  expect(nav.approach?.end.airport).toBe(to)
  expect(Math.abs(nav.guidance.across)).toBeLessThan(25)
})

test('flying level at a mountain gives a terrain warning, then pull up', () => {
  const spec = HANGAR.find(candidate => candidate.id === 'a320')
  if (!spec) throw new Error('Missing a320')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  // Over low ground 4.5 km east of a 715 m peak, heading west below its top
  sim.placeInAir(39_700, 500, 7200, (3 * Math.PI) / 2, 120)
  const alerts = new Set<string>()
  const gpws = new Gpws(() => {})
  gpws.reset(sim)
  const nav = new Navigator()
  const controls = new Pilot().controls
  Object.assign(controls, { battery: true, fuelPumps: true, throttle: 0.6, gearDown: false })
  controls.engineSwitches.fill(true)
  for (let time = 0; time < 20 && !sim.crash; time += STEP) {
    sim.step(STEP, controls, CALM)
    gpws.update(STEP, sim, controls, nav)
    if (gpws.alert) alerts.add(gpws.alert)
  }
  expect(alerts).toContain('TERRAIN AHEAD')
  expect(alerts).toContain('PULL UP')
})
