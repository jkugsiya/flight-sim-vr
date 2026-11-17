import type { Weather } from '../game/game'

/**
 * What each weather setting means for the flight and the scene.
 * `deck` is the overcast layer in metres above sea level, `visibility` is in metres,
 * `rain` is 0 to 1, and `turbulence` scales the bumps, strongest inside cloud.
 */
export type Conditions = {
  deck: { base: number; top: number } | null
  visibility: number
  rain: number
  turbulence: number
}

export const WEATHER: Record<Weather, Conditions> = {
  clear: { deck: null, visibility: 40_000, rain: 0, turbulence: 0 },
  cloudy: { deck: { base: 700, top: 1300 }, visibility: 22_000, rain: 0, turbulence: 0.5 },
  rain: { deck: { base: 450, top: 1700 }, visibility: 6000, rain: 1, turbulence: 0.9 },
  fog: { deck: null, visibility: 900, rain: 0, turbulence: 0.1 },
  // Thunderstorms: a dark, heavy deck, downpours, and storm cells towering through it
  storm: { deck: { base: 420, top: 1900 }, visibility: 12_000, rain: 1.7, turbulence: 1 }
}
