import { expect, test } from 'bun:test'
import { shape } from './controls'

test('the stick response hides tremor at centre, is fine near it, and still reaches full', () => {
  expect(shape(0.02)).toBe(0)
  expect(shape(-0.02)).toBe(0)
  expect(shape(1)).toBeCloseTo(1, 6)
  expect(shape(-1)).toBeCloseTo(-1, 6)
  // A third of the travel asks for well under a third of the control surface
  expect(shape(0.33)).toBeLessThan(0.25)
  // Always more stick, more control
  for (let x = 0; x < 1; x += 0.05) expect(shape(x + 0.05)).toBeGreaterThanOrEqual(shape(x))
})
