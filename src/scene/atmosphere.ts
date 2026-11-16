import { Color, Vector3 } from 'three'

/**
 * Sky, haze, and light shared by every shader so they agree at the horizon.
 * The environment updates these objects in place each frame for the time of day and the
 * weather, so every material that holds them follows without rebuilding.
 */
export const HORIZON_COLOR = '#bfd3e2'
export const ZENITH_COLOR = '#2f6fc0'
export const SUN_COLOR = '#fff1d6'
/** Clear-day haze. Weather and cloud raise it. */
export const FOG_DENSITY = 0.00006

export const horizon = new Color(HORIZON_COLOR)
export const zenith = new Color(ZENITH_COLOR)
/** Light from the sun, or from the moon at night. */
export const sunColor = new Color(SUN_COLOR)
/** Direction toward the sun, or toward the moon at night. */
export const SUN_DIRECTION = new Vector3(0.45, 0.62, 0.43).normalize()
/** Warm glow low in the sky around the sun at sunrise and sunset. */
export const sunGlow = new Color(0, 0, 0)

/** Shared uniforms: pass these objects straight into a material's uniforms. */
export const fogUniform = { value: FOG_DENSITY }
/** 1 at night, 0 by day. Lights grow and windows glow with it. */
export const nightUniform = { value: 0 }
/** 1 under a clear sky, 0 in fog where the sun, moon, and stars are hidden. */
export const clearSkyUniform = { value: 1 }
/** Brightness of unlit sprites and water, 1 at midday. */
export const lightLevel = { value: 1 }
/** Colour of daylight on clouds and smoke: white at midday, warm at sunset, dim at night. */
export const cloudLight = { value: new Color(1, 1, 1) }

/** GLSL: sky colour for a view direction. Needs `horizonColor` and `zenithColor` uniforms. */
export const SKY_GLSL = /* glsl */ `
  vec3 skyColor(vec3 direction) {
    float up = clamp(direction.y, 0.0, 1.0);
    // A pale band of haze sits on the horizon and thins quickly with height
    vec3 color = mix(horizonColor, zenithColor, pow(up, 0.42));
    return mix(color, horizonColor * 1.04, exp(-up * 9.0) * 0.6);
  }
`

/** GLSL: blends a colour into the haze by distance, matching the scene fog. */
export const HAZE_GLSL = /* glsl */ `
  vec3 applyHaze(vec3 color, float distance) {
    float haze = 1.0 - exp(-fogDensity * fogDensity * distance * distance);
    return mix(color, horizonColor, haze);
  }
`
