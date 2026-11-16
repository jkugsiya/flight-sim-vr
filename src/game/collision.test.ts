import { expect, test } from 'bun:test'
import { DEFAULT_AIRCRAFT } from '../sim/aircraft'
import { FlightSim } from '../sim/flight-sim'
import { ISLAND_GROUND } from '../world/island'
import { balloonPosition, OBSTACLES, TREES } from '../world/scenery'
import { findCollision } from './collision'
import { Ruins } from './ruins'
import { Traffic } from './traffic'

const traffic = new Traffic()

/** Aircraft in level flight at a point in the world. */
function flyingAt(x: number, y: number, z: number) {
  const sim = new FlightSim(ISLAND_GROUND, DEFAULT_AIRCRAFT)
  sim.placeInAir(x, y, z, 0, 50)
  sim.altitudeAgl = y - Math.max(ISLAND_GROUND.heightAt(x, z), 0)
  return sim
}

test('flying through a tree, a building, or a balloon is a collision', () => {
  const tree = TREES[0]
  expect(findCollision(flyingAt(tree.x, tree.y + tree.tall * 0.6, tree.z), 0, traffic)).toBe('tree')

  const building = OBSTACLES.find(obstacle => obstacle.kind === 'building')
  if (!building) throw new Error('The island has no buildings to test against')
  const middle = (building.base + building.top) / 2
  expect(findCollision(flyingAt(building.x, middle, building.z), 0, traffic)).toBe('building')

  const balloon = { x: 0, y: 0, z: 0 }
  balloonPosition(0, 120, balloon)
  expect(findCollision(flyingAt(balloon.x, balloon.y, balloon.z), 120, traffic)).toBe('balloon')
  // The balloon has drifted away from that spot ten minutes later
  expect(findCollision(flyingAt(balloon.x, balloon.y, balloon.z), 720, traffic)).toBeNull()
})

test('flying above the treetops is clear', () => {
  const tree = TREES[0]
  expect(findCollision(flyingAt(tree.x, tree.y + tree.tall + 15, tree.z), 0, traffic)).toBeNull()
})

test('a building a bomb brought down is no longer solid', () => {
  const building = OBSTACLES.find(obstacle => obstacle.kind === 'building')
  if (!building) throw new Error('The island has no buildings to test against')
  const middle = (building.base + building.top) / 2
  const ruins = new Ruins()
  expect(ruins.blast(building.x + 30, building.z)).toBeGreaterThan(0)
  expect(findCollision(flyingAt(building.x, middle, building.z), 0, traffic, ruins)).toBeNull()
  // A fresh flight puts it back
  ruins.clear()
  expect(findCollision(flyingAt(building.x, middle, building.z), 0, traffic, ruins)).toBe(
    'building'
  )
})
