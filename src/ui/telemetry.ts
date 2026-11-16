import { useEffect } from 'react'
import { game } from '../game/game'
import type { Controls, FlightSim } from '../sim/flight-sim'

export const KNOTS_PER_MS = 1.94384
export const FEET_PER_METRE = 3.28084
export const FPM_PER_MS = 196.85
export const DEGREES = 180 / Math.PI

/**
 * Runs `update` after every simulation frame.
 * Instruments use it to move needles directly, without re-rendering React.
 */
export function useTelemetry(update: (sim: FlightSim, controls: Controls) => void) {
  useEffect(() => game.onFrame(() => update(game.sim, game.pilot.controls)), [update])
}

/** Writes text into an element only when it changes. */
export function setText(element: Element | null, text: string) {
  if (element && element.textContent !== text) element.textContent = text
}

export function rotate(element: Element | null, degrees: number) {
  element?.setAttribute('transform', `rotate(${degrees.toFixed(2)})`)
}

/** A whole number with comma thousands separators, the same in every browser language. */
export function thousands(value: number) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
