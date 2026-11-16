import { Color, Vector3 } from 'three'
import type { TimeOfDay, Weather } from '../game/game'
import { WEATHER } from '../world/weather'
import {
  clearSkyUniform,
  cloudLight,
  FOG_DENSITY,
  fogUniform,
  horizon,
  lightLevel,
  nightUniform,
  SUN_DIRECTION,
  sunColor,
  sunGlow,
  zenith
} from './atmosphere'

/** Light and sky colours for one time of day, in clear weather. */
type Palette = {
  /** Toward the sun, or the moon at night. x east, y up, z south. */
  sun: Vector3
  sunColor: Color
  sunIntensity: number
  sky: Color
  ground: Color
  ambient: number
  horizon: Color
  zenith: Color
  glow: Color
  /** Brightness of unlit sprites and water. */
  light: number
  night: number
}

const palette = (p: {
  sun: [number, number, number]
  sunColor: string
  sunIntensity: number
  sky: string
  ground: string
  ambient: number
  horizon: string
  zenith: string
  glow: string
  light: number
  night: number
}): Palette => ({
  ...p,
  sun: new Vector3(...p.sun).normalize(),
  sunColor: new Color(p.sunColor),
  sky: new Color(p.sky),
  ground: new Color(p.ground),
  horizon: new Color(p.horizon),
  zenith: new Color(p.zenith),
  glow: new Color(p.glow)
})

const PALETTES: Record<TimeOfDay, Palette> = {
  morning: palette({
    sun: [0.95, 0.24, 0.2],
    sunColor: '#ffd2a0',
    sunIntensity: 2.4,
    sky: '#c8c9da',
    ground: '#5d5546',
    ambient: 0.9,
    horizon: '#e3d2c4',
    zenith: '#5a84c2',
    glow: '#7a4422',
    light: 0.88,
    night: 0
  }),
  noon: palette({
    sun: [0.45, 0.62, 0.43],
    sunColor: '#fff1d6',
    sunIntensity: 3,
    sky: '#c3d8f2',
    ground: '#6a6450',
    ambient: 1.05,
    horizon: '#bfd3e2',
    zenith: '#2f6fc0',
    glow: '#000000',
    light: 1,
    night: 0
  }),
  evening: palette({
    sun: [-0.95, 0.1, -0.22],
    sunColor: '#ffa868',
    sunIntensity: 2,
    sky: '#b6a4b8',
    ground: '#4e4239',
    ambient: 0.75,
    horizon: '#e8b48e',
    zenith: '#3d5a97',
    glow: '#a3461c',
    light: 0.72,
    night: 0
  }),
  night: palette({
    sun: [-0.35, 0.62, 0.55],
    sunColor: '#a8bde6',
    sunIntensity: 0.32,
    sky: '#2a3a5e',
    ground: '#0d0e14',
    ambient: 0.55,
    horizon: '#121c30',
    zenith: '#03060f',
    glow: '#000000',
    light: 0.13,
    night: 1
  })
}

/** Live lighting values the light components read every frame. */
export const environment = {
  sunIntensity: 3,
  sky: new Color('#c3d8f2'),
  ground: new Color('#6a6450'),
  ambient: 1.05,
  /** 0 in clear air, 1 under or inside an overcast deck. */
  overcast: 0,
  /** 1 inside the cloud deck. */
  inCloud: 0,
  rain: 0,
  /** Rain falls only below the cloud base. */
  raining: false
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Haze density that hides things at about `metres`, for exponential-squared fog. */
const densityFor = (metres: number) => 1.9 / metres

const grey = new Color()
const cloud = new Color()
const luminance = (color: Color) => color.r * 0.3 + color.g * 0.55 + color.b * 0.15

/**
 * Sets the shared sky, haze, and light values for the time of day, the weather, and the
 * camera height: under an overcast deck the light goes dull, inside it the view whites out,
 * and above it the sun shines again.
 */
export function updateEnvironment(time: TimeOfDay, weather: Weather, eyeHeight: number) {
  const day = PALETTES[time]
  const conditions = WEATHER[weather]
  const deck = conditions.deck
  // How far into or under the deck the camera is, with soft edges so nothing pops
  const under = deck ? 1 - smoothstep(deck.top - 40, deck.top + 40, eyeHeight) : 0
  const inside = deck
    ? smoothstep(deck.base - 40, deck.base + 40, eyeHeight) *
      (1 - smoothstep(deck.top - 40, deck.top + 40, eyeHeight))
    : 0
  const misty = weather === 'fog' ? 1 : 0
  const dull = Math.max(under, misty)

  SUN_DIRECTION.copy(day.sun)
  sunColor.copy(day.sunColor)
  sunGlow.copy(day.glow).multiplyScalar(1 - dull)
  nightUniform.value = day.night
  clearSkyUniform.value = 1 - misty

  // Overcast skies turn grey at the brightness of the clear sky, darker in rain
  const gloom = weather === 'rain' ? 0.62 : weather === 'fog' ? 0.95 : 0.8
  grey.setScalar(luminance(day.horizon) * gloom)
  horizon.copy(day.horizon).lerp(grey, dull)
  grey.setScalar(luminance(day.zenith) * gloom * 1.1)
  zenith.copy(day.zenith).lerp(grey, dull)
  // Inside the cloud everything fades to the cloud's own colour
  cloud.setScalar(Math.min(0.92, luminance(day.horizon) * 1.05))
  horizon.lerp(cloud, inside)

  let density = FOG_DENSITY
  if (weather === 'fog') density = densityFor(conditions.visibility)
  else if (deck) {
    const below = densityFor(conditions.visibility)
    density = below * under + FOG_DENSITY * (1 - under)
    density += (densityFor(70) - density) * inside
  }
  fogUniform.value = density

  const shade = 1 - 0.85 * dull
  environment.sunIntensity = day.sunIntensity * shade
  environment.sky.copy(day.sky).lerp(grey.setScalar(luminance(day.sky)), dull)
  environment.ground.copy(day.ground)
  environment.ambient = day.ambient * (1 - 0.25 * dull)
  environment.overcast = dull
  environment.inCloud = inside
  environment.rain = conditions.rain
  environment.raining = conditions.rain > 0 && (!deck || eyeHeight < deck.top)

  lightLevel.value = day.light * (1 - 0.3 * dull)
  cloudLight.value.copy(day.sunColor).lerp(grey.setScalar(1), 0.55 + 0.35 * dull)
  cloudLight.value.multiplyScalar(day.light * (1 - 0.25 * dull))
}
