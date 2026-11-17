import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  ShaderMaterial
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { game, useGame, WIND_FROM } from '../game/game'
import { BOLT_SEGMENTS, STORM_CELLS } from '../game/storm'
import { seededRandom } from '../world/noise'
import { WEATHER } from '../world/weather'
import { cloudLight, fogUniform, horizon } from './atmosphere'
import { billboardMaterial, makeBillboards } from './billboards'
import { useDisposal } from './dispose'
import {
  LOG_DEPTH_FRAGMENT,
  LOG_DEPTH_FRAGMENT_PARS,
  LOG_DEPTH_VERTEX,
  LOG_DEPTH_VERTEX_PARS
} from './logDepth'
import { detailTexture } from './textures'

const DECK = WEATHER.storm.deck ?? { base: 420, top: 1900 }
// Towers and rain shafts see through the haze this much farther than other things, as a
// cumulonimbus stands out on the horizon from tens of kilometres away
const CLEARER = 0.35
// The anvil streams out downwind, the way the wind blows toward
const DOWNWIND = ((WIND_FROM + 180) * Math.PI) / 180
const DRIFT_X = Math.sin(DOWNWIND)
const DRIFT_Z = -Math.cos(DOWNWIND)

type Puff = { x: number; y: number; z: number; size: number; shade: number }

/**
 * Cumulonimbus towers as soft sprites: a dark lowered base under the deck, a column rising
 * through it, an anvil spreading downwind at the top, and a dome punching through the anvil.
 * Full clouds use more sprites.
 */
function buildTowers(full: boolean) {
  const random = seededRandom(31)
  const puffs: Puff[] = []
  const share = full ? 1 : 0.6
  for (const cell of STORM_CELLS) {
    const parts: Puff[] = []
    const { radius, top } = cell
    // Ragged dark cloud hanging below the deck over the core
    for (let i = 0; i < 26 * share; i++) {
      const angle = random() * Math.PI * 2
      const reach = Math.sqrt(random()) * radius * 0.65
      parts.push({
        x: cell.x + Math.cos(angle) * reach,
        y: DECK.base - 170 + random() * 200,
        z: cell.z + Math.sin(angle) * reach,
        size: 450 + random() * 400,
        shade: 0.12 + random() * 0.08
      })
    }
    // The tower, leaning a little downwind as it climbs
    for (let i = 0; i < 170 * share; i++) {
      const rise = random() ** 0.85
      const y = DECK.top - 300 + rise * (top - 1100 - DECK.top)
      const lean = rise * rise * 1400
      const angle = random() * Math.PI * 2
      const reach = Math.sqrt(random()) * radius * (0.7 + 0.2 * rise)
      parts.push({
        x: cell.x + DRIFT_X * lean + Math.cos(angle) * reach,
        y,
        z: cell.z + DRIFT_Z * lean + Math.sin(angle) * reach,
        size: 1000 + random() * 900,
        shade: 0.3 + 0.55 * rise + random() * 0.1
      })
    }
    // The anvil: a wide, flat sheet, thinner toward its edges
    const anvilX = cell.x + DRIFT_X * radius * 1.4
    const anvilZ = cell.z + DRIFT_Z * radius * 1.4
    for (let i = 0; i < 120 * share; i++) {
      const angle = random() * Math.PI * 2
      const reach = Math.sqrt(random())
      const along = Math.cos(angle) * reach * radius * 3.2
      const across = Math.sin(angle) * reach * radius * 2.1
      parts.push({
        x: anvilX + DRIFT_X * along - DRIFT_Z * across,
        y: top - 900 + random() * 650 - reach * reach * 350,
        z: anvilZ + DRIFT_Z * along + DRIFT_X * across,
        size: 1500 + random() * 1100,
        shade: 0.85 + random() * 0.2
      })
    }
    // The overshooting top, a dome above the anvil over the strongest updraft
    for (let i = 0; i < 14 * share; i++) {
      const angle = random() * Math.PI * 2
      const reach = Math.sqrt(random()) * radius * 0.45
      parts.push({
        x: cell.x + DRIFT_X * 1400 + Math.cos(angle) * reach,
        y: top - 350 + random() * 450 * (1 - reach / radius),
        z: cell.z + DRIFT_Z * 1400 + Math.sin(angle) * reach,
        size: 900 + random() * 500,
        shade: 1
      })
    }
    // Lower, darker puffs draw first so the bright tops sit on them
    puffs.push(...parts.sort((a, b) => a.y - b.y))
  }
  const sprites = makeBillboards(puffs.length, false)
  puffs.forEach((puff, i) => {
    const brightness = 0.35 + 0.75 * puff.shade
    sprites.center.setXYZ(i, puff.x, puff.y, puff.z)
    sprites.info.setXYZW(i, puff.size, random() * Math.PI * 2, 0.92, 0)
    sprites.tint.setXYZ(i, brightness * 0.93, brightness * 0.97, brightness)
  })
  // Sprites fade out close up, where the dark haze inside the cell takes over
  const material = billboardMaterial(250, 900, full)
  material.uniforms.fogDensity = { value: fogUniform.value * CLEARER }
  const mesh = new Mesh(sprites.geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 2
  return mesh
}

const SHAFT_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  ${LOG_DEPTH_VERTEX_PARS}
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normal;
    gl_Position = projectionMatrix * viewMatrix * world;
    ${LOG_DEPTH_VERTEX}
  }
`

const SHAFT_FRAGMENT = /* glsl */ `
  uniform sampler2D detailMap;
  uniform float time;
  uniform float base;
  uniform vec3 daylight;
  uniform vec3 horizonColor;
  uniform float fogDensity;
  varying vec3 vWorld;
  varying vec3 vNormal;
  ${LOG_DEPTH_FRAGMENT_PARS}
  void main() {
    ${LOG_DEPTH_FRAGMENT}
    vec3 toCamera = cameraPosition - vWorld;
    float distance = length(toCamera);
    // Densest through the middle of a shaft, thin at its sides
    float through = abs(dot(normalize(vNormal), toCamera / distance));
    // Streaks of heavier rain falling down the curtain
    vec2 streak = vec2((vWorld.x + vWorld.z) * 0.006, vWorld.y * 0.0007 + time * 0.12);
    float heavy = texture2D(detailMap, streak).a * 0.7 + texture2D(detailMap, streak * 3.1).b * 0.5;
    float height = clamp(vWorld.y / base, 0.0, 1.0);
    float alpha = 0.9 * sqrt(through) * (0.5 + 0.7 * heavy) * (1.0 - smoothstep(0.75, 1.0, height));
    // Fade out close up, where the falling drops around the camera take over
    alpha *= smoothstep(250.0, 1200.0, distance);
    // Dark curtains stand out against the horizon farther than the general haze reaches
    float haze = 1.0 - exp(-pow(fogDensity * distance, 2.0));
    vec3 color = mix(daylight * 0.3, horizonColor, haze);
    gl_FragColor = vec4(color, min(1.0, alpha) * (1.0 - haze * 0.6));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** Grey curtains of heavy rain from each cell's base down to the ground or sea. */
function buildShafts() {
  const random = seededRandom(47)
  const shafts: CylinderGeometry[] = []
  for (const cell of STORM_CELLS) {
    for (let i = 0; i < 4; i++) {
      const angle = random() * Math.PI * 2
      const reach = random() * cell.radius * 0.35
      const radius = cell.radius * (0.3 + random() * 0.25)
      // A little wider at the bottom, where the rain spreads in the outflow
      const shaft = new CylinderGeometry(radius, radius * 1.2, DECK.base + 40, 24, 1, true)
      shaft.translate(
        cell.x + Math.cos(angle) * reach,
        (DECK.base + 40) / 2 - 40,
        cell.z + Math.sin(angle) * reach
      )
      shafts.push(shaft)
    }
  }
  const geometry = mergeGeometries(shafts)
  for (const shaft of shafts) shaft.dispose()
  const material = new ShaderMaterial({
    uniforms: {
      detailMap: { value: detailTexture },
      time: { value: 0 },
      base: { value: DECK.base },
      daylight: cloudLight,
      horizonColor: { value: horizon },
      fogDensity: { value: fogUniform.value * CLEARER }
    },
    vertexShader: SHAFT_VERTEX,
    fragmentShader: SHAFT_FRAGMENT,
    transparent: true,
    depthWrite: false
  })
  const mesh = new Mesh(geometry, material)
  mesh.renderOrder = 2
  return mesh
}

const BOLT_VERTEX = /* glsl */ `
  attribute vec3 tip;
  // x: 0 at the segment's start, 1 at its end. y: -1 or 1 across. z: width share.
  attribute vec3 corner;
  varying float vAcross;
  varying float vWidth;
  ${LOG_DEPTH_VERTEX_PARS}
  void main() {
    vec3 point = mix(position, tip, corner.x);
    vec3 toCamera = cameraPosition - point;
    // A ribbon that always faces the camera, never thinner than about two pixels
    vec3 side = normalize(cross(tip - position, toCamera));
    float width = max(4.0, length(toCamera) * 0.0022) * corner.z;
    point += side * corner.y * width * 3.0;
    vAcross = corner.y;
    vWidth = corner.z;
    gl_Position = projectionMatrix * viewMatrix * vec4(point, 1.0);
    ${LOG_DEPTH_VERTEX}
  }
`

const BOLT_FRAGMENT = /* glsl */ `
  uniform float glow;
  varying float vAcross;
  varying float vWidth;
  ${LOG_DEPTH_FRAGMENT_PARS}
  void main() {
    ${LOG_DEPTH_FRAGMENT}
    float across = abs(vAcross);
    // A white-hot core inside a violet halo
    float core = 1.0 - smoothstep(0.12, 0.34, across);
    float halo = (1.0 - across) * (1.0 - across) * 0.35;
    vec3 color = vec3(0.92, 0.9, 1.0) * core * 2.4 + vec3(0.55, 0.5, 1.0) * halo;
    gl_FragColor = vec4(color * glow * (0.4 + 0.6 * vWidth), 1.0);
  }
`

/** The visible bolt of the latest cloud-to-ground strike, flickering with its strokes. */
function Bolt() {
  const bolt = useMemo(() => {
    const vertices = BOLT_SEGMENTS * 4
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3))
    geometry.setAttribute('tip', new BufferAttribute(new Float32Array(vertices * 3), 3))
    geometry.setAttribute('corner', new BufferAttribute(new Float32Array(vertices * 3), 3))
    const index = new Uint16Array(BOLT_SEGMENTS * 6)
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      const v = i * 4
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6)
    }
    geometry.setIndex(new BufferAttribute(index, 1))
    geometry.setDrawRange(0, 0)
    const material = new ShaderMaterial({
      uniforms: { glow: { value: 0 } },
      vertexShader: BOLT_VERTEX,
      fragmentShader: BOLT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      // The ribbon turns to face the camera, so either side may be in front
      side: DoubleSide
    })
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 3
    mesh.userData.version = -1
    return mesh
  }, [])
  useDisposal(bolt)
  useFrame(() => {
    const { lightning } = game.storm
    const material = bolt.material as ShaderMaterial
    material.uniforms.glow.value = lightning.glow
    bolt.visible = lightning.segments > 0 && lightning.glow > 0.02
    if (lightning.version === bolt.userData.version) return
    bolt.userData.version = lightning.version
    // A new strike: copy its segments into the ribbon, four corners each
    const geometry = bolt.geometry
    const start = geometry.getAttribute('position') as BufferAttribute
    const tip = geometry.getAttribute('tip') as BufferAttribute
    const corner = geometry.getAttribute('corner') as BufferAttribute
    const data = lightning.bolt
    for (let i = 0; i < lightning.segments; i++) {
      const o = i * 7
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k
        start.setXYZ(v, data[o], data[o + 1], data[o + 2])
        tip.setXYZ(v, data[o + 3], data[o + 4], data[o + 5])
        corner.setXYZ(v, k >> 1, k & 1 ? 1 : -1, data[o + 6])
      }
    }
    start.needsUpdate = true
    tip.needsUpdate = true
    corner.needsUpdate = true
    geometry.setDrawRange(0, lightning.segments * 6)
  })
  return <primitive object={bolt} />
}

/** Storm cells and lightning, shown in Storm weather. */
export function Storm() {
  const storm = useGame(state => state.weather === 'storm')
  return storm ? <StormCells /> : null
}

function StormCells() {
  const full = useGame(state => state.graphics.clouds === 'full')
  const towers = useMemo(() => buildTowers(full), [full])
  // The puff texture is shared with the other clouds and smoke, so only the towers' own buffers go
  useEffect(
    () => () => {
      towers.geometry.dispose()
      ;(towers.material as ShaderMaterial).dispose()
    },
    [towers]
  )
  const shafts = useMemo(buildShafts, [])
  useDisposal(shafts)
  useFrame(({ clock }) => {
    const rain = (shafts.material as ShaderMaterial).uniforms
    rain.time.value = clock.elapsedTime
    rain.fogDensity.value = fogUniform.value * CLEARER
    ;(towers.material as ShaderMaterial).uniforms.fogDensity.value = fogUniform.value * CLEARER
  })
  return (
    <>
      <primitive object={towers} />
      <primitive object={shafts} />
      <Bolt />
    </>
  )
}
