import { expect, test } from 'bun:test'
import { HANGAR } from '../sim/aircraft'
import { FlightSim } from '../sim/flight-sim'
import { ISLAND_GROUND } from '../world/island'
import { Gpws } from './gpws'
import { Navigator } from './navigation'
import { Pilot } from './pilot'

const STEP = 1 / 60
const FEET = 0.3048

/**
 * Moves a Cessna over open sea from one height to another at a steady climb rate, without the
 * flight model, and returns what the GPWS said on the way.
 */
function fly(
  gpws: Gpws,
  sim: FlightSim,
  flapNotch: number,
  from: number,
  to: number,
  rate: number
) {
  const controls = new Pilot().controls
  controls.flapNotch = flapNotch
  const nav = new Navigator()
  sim.onGround = false
  sim.verticalSpeed = rate
  for (let feet = from; rate > 0 ? feet < to : feet > to; feet += (rate * STEP) / FEET) {
    sim.altitudeAgl = feet * FEET + sim.spec.restHeight
    sim.position.y = sim.altitudeAgl
    gpws.update(STEP, sim, controls, nav)
  }
}

function setup() {
  const spec = HANGAR.find(candidate => candidate.id === 'c172')
  if (!spec) throw new Error('Missing c172')
  const sim = new FlightSim(ISLAND_GROUND, spec)
  sim.placeInAir(0, 300, -42_000, 0, 40)
  sim.velocity.set(0, 0, -40)
  const spoken: string[] = []
  const gpws = new Gpws(phrase => spoken.push(phrase))
  gpws.reset(sim)
  return { sim, gpws, spoken }
}

test('each height is called once on the way down, and a bounce calls nothing more', () => {
  const { sim, gpws, spoken } = setup()
  fly(gpws, sim, 3, 900, 0, -3)
  expect(spoken).toEqual(['Five hundred', '100', '50', '40', '30', '20', '10'])
  sim.onGround = true
  gpws.update(STEP, sim, new Pilot().controls, new Navigator())
  fly(gpws, sim, 3, 8, 0, -1)
  expect(spoken).toHaveLength(7)
})

test('a circuit below 1500 ft ends with a normal landing, not a sink warning', () => {
  const { sim, gpws, spoken } = setup()
  sim.onGround = true
  sim.altitudeAgl = sim.spec.restHeight
  gpws.reset(sim)
  gpws.update(STEP, sim, new Pilot().controls, new Navigator())
  fly(gpws, sim, 0, 200, 1000, 3)
  fly(gpws, sim, 3, 1000, 0, -2.5)
  expect(spoken.filter(phrase => !/^\d+$|^Five hundred$/.test(phrase))).toEqual([])
  expect(spoken).toContain('50')
})
