import { expect, test } from 'bun:test'
import { Sound } from './audio'

// Bun has no Web Audio, so the flight starts without opening the sound
Sound.prototype.start = () => {}
const { game } = await import('./game')

test('photo mode holds the flight still and it carries on from the same spot', () => {
  game.startInAir()
  game.frame(1 / 60)
  game.togglePhoto()
  expect(game.getState().photo).toBe(true)
  const position = game.sim.position.clone()
  const scenery = game.sceneryTime
  for (let i = 0; i < 120; i++) game.frame(1 / 60)
  expect(game.sim.position.distanceTo(position)).toBe(0)
  expect(game.sceneryTime).toBe(scenery)

  game.togglePhoto()
  expect(game.getState()).toMatchObject({ photo: false, status: 'flying' })
  game.frame(1 / 60)
  // One frame at cruise speed, not the two seconds spent in photo mode
  const moved = game.sim.position.distanceTo(position)
  expect(moved).toBeGreaterThan(0)
  expect(moved).toBeLessThan(game.sim.spec.cruiseSpeed / 30)
})
