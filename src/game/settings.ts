/** Graphics choices. A preset sets them all; changing one by hand makes the preset Custom. */
export type Graphics = {
  preset: GraphicsPreset
  shadows: 'off' | 'on' | 'sharp'
  trees: 'fewer' | 'normal' | 'more'
  /** Detailed ground: sand, grass, rock, and snow textures that change with the terrain. */
  ground: boolean
  /** Fuller clouds lit by the sun's colour, or the plain ones. */
  clouds: 'simple' | 'full'
  /** Soft glow around the sun, lights, and fire. */
  glow: boolean
  /** Draws at the screen's full resolution on high-density displays. */
  sharp: boolean
}
export type GraphicsPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom'

export const GRAPHICS_PRESETS: Record<Exclude<GraphicsPreset, 'custom'>, Graphics> = {
  low: {
    preset: 'low',
    shadows: 'off',
    trees: 'fewer',
    ground: false,
    clouds: 'simple',
    glow: false,
    sharp: false
  },
  medium: {
    preset: 'medium',
    shadows: 'on',
    trees: 'normal',
    ground: true,
    clouds: 'simple',
    glow: false,
    sharp: false
  },
  high: {
    preset: 'high',
    shadows: 'on',
    trees: 'normal',
    ground: true,
    clouds: 'full',
    glow: true,
    sharp: true
  },
  ultra: {
    preset: 'ultra',
    shadows: 'sharp',
    trees: 'more',
    ground: true,
    clouds: 'full',
    glow: true,
    sharp: true
  }
}

/** Everything the player chooses that the game remembers between visits. */
export type Settings = {
  wind: 'calm' | 'light' | 'strong'
  weather: 'clear' | 'cloudy' | 'rain' | 'fog' | 'storm'
  time: 'morning' | 'noon' | 'evening' | 'night'
  muted: boolean
  coach: boolean
  map: 'small' | 'large' | 'hidden'
  camera: 'chase' | 'cockpit' | 'seat'
  graphics: Graphics
  /** Free flight choices: aircraft id and airport codes. */
  aircraft: string
  departure: string
  destination: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  wind: 'calm',
  weather: 'clear',
  time: 'noon',
  muted: false,
  coach: true,
  map: 'small',
  camera: 'chase',
  graphics: GRAPHICS_PRESETS.high,
  aircraft: 'c172',
  departure: 'CBI',
  destination: null
}

const STORAGE_KEY = 'island-flyer-settings'
// The landing coach choice was saved on its own before all settings were
const OLD_COACH_KEY = 'island-flyer-coach'

/** A stored value if it is one of the allowed ones, otherwise the fallback. */
function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function readGraphics(stored: unknown): Graphics {
  const value = (stored ?? {}) as Partial<Graphics>
  const fallback = DEFAULT_SETTINGS.graphics
  return {
    preset: oneOf(value.preset, ['low', 'medium', 'high', 'ultra', 'custom'], fallback.preset),
    shadows: oneOf(value.shadows, ['off', 'on', 'sharp'], fallback.shadows),
    trees: oneOf(value.trees, ['fewer', 'normal', 'more'], fallback.trees),
    ground: oneOf(value.ground, [true, false], fallback.ground),
    clouds: oneOf(value.clouds, ['simple', 'full'], fallback.clouds),
    glow: oneOf(value.glow, [true, false], fallback.glow),
    sharp: oneOf(value.sharp, [true, false], fallback.sharp)
  }
}

/**
 * The saved settings, checked value by value so a damaged or older save falls back to the
 * defaults. Storage can be blocked, so a failure reads as no save.
 */
export function loadSettings(): Settings {
  const defaults = DEFAULT_SETTINGS
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Settings>
    const oldCoach = localStorage.getItem(OLD_COACH_KEY)
    return {
      wind: oneOf(stored.wind, ['calm', 'light', 'strong'], defaults.wind),
      weather: oneOf(stored.weather, ['clear', 'cloudy', 'rain', 'fog', 'storm'], defaults.weather),
      time: oneOf(stored.time, ['morning', 'noon', 'evening', 'night'], defaults.time),
      muted: oneOf(stored.muted, [true, false], defaults.muted),
      coach: oneOf(stored.coach, [true, false], oldCoach ? oldCoach !== 'off' : defaults.coach),
      map: oneOf(stored.map, ['small', 'large', 'hidden'], defaults.map),
      camera: oneOf(stored.camera, ['chase', 'cockpit', 'seat'], defaults.camera),
      graphics: readGraphics(stored.graphics),
      aircraft: typeof stored.aircraft === 'string' ? stored.aircraft : defaults.aircraft,
      departure: typeof stored.departure === 'string' ? stored.departure : defaults.departure,
      destination: typeof stored.destination === 'string' ? stored.destination : null
    }
  } catch {
    return defaults
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Without storage the settings last until the page closes
  }
}
