import { BufferAttribute, BufferGeometry, ShaderMaterial } from 'three'
import { fogUniform, nightUniform } from './atmosphere'
import {
  LOG_DEPTH_FRAGMENT,
  LOG_DEPTH_FRAGMENT_PARS,
  LOG_DEPTH_VERTEX,
  LOG_DEPTH_VERTEX_PARS
} from './logDepth'

/** Pixels per metre at 1 m from the camera. The scene updates it every frame. */
export const pointScale = { value: 800 }

const VERTEX = /* glsl */ `
  attribute vec3 color;
  uniform float scale;
  uniform float size;
  uniform float night;
  uniform float fogDensity;
  varying vec3 vColor;
  varying float vFade;
  ${LOG_DEPTH_VERTEX_PARS}
  void main() {
    vec4 eye = modelViewMatrix * vec4(position, 1.0);
    float distance = -eye.z;
    vColor = color;
    // Lights stay a few pixels wide far away, and glare bigger in the dark
    float glare = 1.0 + night * 0.9;
    float natural = size * glare * scale / max(distance, 1.0);
    gl_PointSize = clamp(natural, 3.0 + night, 14.0 + night * 10.0);
    // Lights shine through haze further than the ground they stand on
    float haze = exp(-fogDensity * fogDensity * distance * distance * 0.35);
    vFade = (1.0 - smoothstep(16000.0, 24000.0, distance)) * haze;
    // By day a light smaller than its dot fades instead of being drawn oversized, so rows of
    // distant lights do not sparkle as the view moves. At night they stay bright points.
    float coverage = clamp(natural / gl_PointSize, 0.0, 1.0);
    vFade *= mix(coverage * coverage, 1.0, night);
    #ifdef NIGHT_ONLY
      vFade *= night;
    #endif
    gl_Position = projectionMatrix * eye;
    ${LOG_DEPTH_VERTEX}
  }
`

const FRAGMENT = /* glsl */ `
  uniform float night;
  varying vec3 vColor;
  varying float vFade;
  ${LOG_DEPTH_FRAGMENT_PARS}
  void main() {
    ${LOG_DEPTH_FRAGMENT}
    float d = length(gl_PointCoord - 0.5);
    // A bright core, and at night a soft halo around it
    float core = smoothstep(0.5, 0.1, d);
    float halo = smoothstep(0.5, 0.0, d) * 0.55;
    // Black marks a light that is off, so it is not drawn
    float alpha = mix(core, max(smoothstep(0.22, 0.08, d), halo), night) * vFade * step(0.01, vColor.r + vColor.g + vColor.b);
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), smoothstep(0.25, 0.0, d) * 0.6), alpha);
  }
`

/**
 * Point sprite material for small lights that keep a minimum size on screen.
 * `size` is the light's glare in metres. Night-only lights fade out by day.
 */
export function lightMaterial(size = 0.9, nightOnly = false) {
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      scale: pointScale,
      size: { value: size },
      night: nightUniform,
      fogDensity: fogUniform
    },
    defines: nightOnly ? { NIGHT_ONLY: '' } : {},
    transparent: true,
    depthWrite: false
  })
}

export type Rgb = [number, number, number]
export type Light = { x: number; y: number; z: number; color: Rgb }

/** Geometry holding one point per light, with its colour. */
export function pointsGeometry(lights: Light[]) {
  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(lights.flatMap(light => [light.x, light.y, light.z])), 3)
  )
  geometry.setAttribute(
    'color',
    new BufferAttribute(new Float32Array(lights.flatMap(light => light.color)), 3)
  )
  return geometry
}
