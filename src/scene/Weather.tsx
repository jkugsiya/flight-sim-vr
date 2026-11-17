import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  type Fog,
  type FogExp2,
  LineSegments,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { game, useGame } from '../game/game'
import { insideCell, STORM_CELLS } from '../game/storm'
import { seededRandom } from '../world/noise'
import { WEATHER } from '../world/weather'
import { cloudLight, fogUniform, HAZE_GLSL, horizon, SUN_DIRECTION, sunColor } from './atmosphere'
import { useDisposal } from './dispose'
import { environment, updateEnvironment } from './environment'
import { eye } from './eye'
import {
  LOG_DEPTH_FRAGMENT,
  LOG_DEPTH_FRAGMENT_PARS,
  LOG_DEPTH_VERTEX,
  LOG_DEPTH_VERTEX_PARS
} from './logDepth'
import { detailTexture } from './textures'

/** Sets the sky, haze, and light for the time of day, the weather, and the camera height. */
export function Environment() {
  useFrame(({ scene }) => {
    const { time, weather } = game.getState()
    const { x, y, z } = eye
    const storm = weather === 'storm'
    updateEnvironment(
      time,
      weather,
      y,
      storm ? game.storm.lightning.flash : 0,
      storm ? insideCell(x, y, z) : 0
    )
    const fog = scene.fog as FogExp2 | Fog | null
    if (fog && 'density' in fog) {
      fog.color.copy(horizon)
      fog.density = fogUniform.value
    }
    if (scene.background instanceof Color) scene.background.copy(horizon)
  }, -1)
  return null
}

// Side of the square cloud deck, which follows the camera across the map
const DECK_SIZE = 140_000

const DECK_VERTEX = /* glsl */ `
  attribute float side;
  varying vec3 vWorld;
  varying float vSide;
  ${LOG_DEPTH_VERTEX_PARS}
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vSide = side;
    gl_Position = projectionMatrix * viewMatrix * world;
    ${LOG_DEPTH_VERTEX}
  }
`

const DECK_FRAGMENT = /* glsl */ `
  uniform sampler2D detailMap;
  uniform vec3 horizonColor;
  uniform vec3 sunColor;
  uniform vec3 sunDirection;
  uniform vec3 daylight;
  uniform float fogDensity;
  uniform float darkness;
  // Storm cells: x, z, and radius. The deck darkens over each one.
  uniform vec3 cells[${STORM_CELLS.length}];
  uniform float stormy;
  varying vec3 vWorld;
  varying float vSide;
  ${HAZE_GLSL}
  ${LOG_DEPTH_FRAGMENT_PARS}
  void main() {
    ${LOG_DEPTH_FRAGMENT}
    vec2 p = vWorld.xz;
    // Billows at two scales, so the deck is lumpy from far and near
    float lumps = texture2D(detailMap, p * 0.00011).a * 0.6 + texture2D(detailMap, p * 0.0007).a * 0.4;
    vec3 color;
    if (vSide > 0.5) {
      // Tops in sunshine, with shaded hollows facing away from the sun
      float billow = smoothstep(0.25, 0.85, lumps);
      vec3 hollow = daylight * vec3(0.66, 0.71, 0.8);
      color = mix(hollow, daylight * 1.22 + sunColor * 0.06, billow);
    } else {
      // The underside is grey, darker where the cloud is thickest
      color = daylight * (0.62 - 0.3 * lumps) * (1.0 - darkness);
      // A storm cell's base hangs dark and heavy, wider than its core
      float under = 0.0;
      for (int i = 0; i < ${STORM_CELLS.length}; i++) {
        float reach = distance(p, cells[i].xy) / cells[i].z;
        under = max(under, 1.0 - smoothstep(0.4, 3.2, reach + (lumps - 0.5) * 0.6));
      }
      color *= 1.0 - 0.75 * under * stormy;
    }
    float distance = length(cameraPosition - vWorld);
    gl_FragColor = vec4(applyHaze(color, distance), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** Underside and tops of the overcast deck, one flat sheet each. */
function deckGeometry(base: number, top: number) {
  const sheet = (height: number, side: number) => {
    const plane = new PlaneGeometry(DECK_SIZE, DECK_SIZE)
      .rotateX(-Math.PI / 2)
      .translate(0, height, 0)
    const count = plane.getAttribute('position').count
    plane.setAttribute('side', new BufferAttribute(new Float32Array(count).fill(side), 1))
    return plane
  }
  return mergeGeometries([sheet(base, 0), sheet(top, 1)])
}

/** The overcast deck for low cloud, rain, and storms: grey from below, bright tops from above. */
export function CloudDeck() {
  const weather = useGame(state => state.weather)
  const deck = WEATHER[weather].deck
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          detailMap: { value: detailTexture },
          horizonColor: { value: horizon },
          sunColor: { value: sunColor },
          sunDirection: { value: SUN_DIRECTION },
          daylight: cloudLight,
          fogDensity: fogUniform,
          darkness: { value: 0 },
          cells: { value: STORM_CELLS.map(cell => new Vector3(cell.x, cell.z, cell.radius)) },
          stormy: { value: 0 }
        },
        vertexShader: DECK_VERTEX,
        fragmentShader: DECK_FRAGMENT,
        side: DoubleSide,
        fog: false
      }),
    []
  )
  const mesh = useMemo(() => {
    if (!deck) return null
    const sheets = new Mesh(deckGeometry(deck.base, deck.top), material)
    sheets.frustumCulled = false
    return sheets
  }, [deck, material])
  useDisposal(mesh?.geometry)
  useFrame(() => {
    if (!mesh) return
    // Keep the deck under the camera, snapped so its texture does not slide
    mesh.position.set(Math.round(eye.x / 500) * 500, 0, Math.round(eye.z / 500) * 500)
    material.uniforms.darkness.value = weather === 'storm' ? 0.42 : weather === 'rain' ? 0.25 : 0
    material.uniforms.stormy.value = weather === 'storm' ? 1 : 0
  })
  return mesh && <primitive object={mesh} />
}

// Raindrops fill a box this many metres wide around the camera
const RAIN_BOX = 70
const RAIN_DROPS = { high: 5000, low: 1800 }
// A storm's downpour: more drops, falling faster
const STORM_DROPS = { high: 9000, low: 3200 }
const FALL_SPEED = { rain: 9, storm: 12 }

const RAIN_VERTEX = /* glsl */ `
  attribute float tail;
  uniform float time;
  uniform vec3 eye;
  uniform vec3 streak;
  uniform float box;
  uniform float fall;
  varying float vTail;
  ${LOG_DEPTH_VERTEX_PARS}
  void main() {
    // Each drop falls through the box and wraps around, so the box always stays full
    vec3 drop = position - vec3(0.0, time * fall, 0.0) - eye;
    drop = mod(drop, box) - box * 0.5 + eye;
    // The streak points along the air rushing past, longer the faster you fly
    drop += streak * tail;
    vTail = tail;
    gl_Position = projectionMatrix * viewMatrix * vec4(drop, 1.0);
    ${LOG_DEPTH_VERTEX}
  }
`

const RAIN_FRAGMENT = /* glsl */ `
  uniform vec3 daylight;
  uniform float opacity;
  varying float vTail;
  ${LOG_DEPTH_FRAGMENT_PARS}
  void main() {
    ${LOG_DEPTH_FRAGMENT}
    gl_FragColor = vec4(daylight * 0.9 + 0.08, opacity * (1.0 - vTail * 0.7));
  }
`

const airflow = new Vector3()

/** Rain streaks around the camera while it is below the cloud base in rain or a storm. */
export function Rain() {
  const weather = useGame(state => state.weather)
  const detailed = useGame(state => state.graphics.ground)
  const storm = weather === 'storm'
  const rain = useMemo(() => {
    const drops = storm ? STORM_DROPS : RAIN_DROPS
    const count = detailed ? drops.high : drops.low
    const random = seededRandom(77)
    const positions = new Float32Array(count * 6)
    const tails = new Float32Array(count * 2)
    for (let i = 0; i < count; i++) {
      const x = random() * RAIN_BOX
      const y = random() * RAIN_BOX
      const z = random() * RAIN_BOX
      positions.set([x, y, z, x, y, z], i * 6)
      tails[i * 2 + 1] = 1
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('tail', new BufferAttribute(tails, 1))
    const material = new ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        eye: { value: new Vector3() },
        streak: { value: new Vector3() },
        box: { value: RAIN_BOX },
        fall: { value: storm ? FALL_SPEED.storm : FALL_SPEED.rain },
        opacity: { value: storm ? 0.42 : 0.32 },
        daylight: cloudLight
      },
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      transparent: true,
      depthWrite: false
    })
    const lines = new LineSegments(geometry, material)
    lines.frustumCulled = false
    return lines
  }, [detailed, storm])
  useDisposal(rain)
  useFrame(({ clock }) => {
    const falling = (weather === 'rain' || storm) && environment.raining
    rain.visible = falling
    if (!falling) return
    const uniforms = (rain.material as ShaderMaterial).uniforms
    uniforms.time.value = clock.elapsedTime
    uniforms.eye.value.copy(eye)
    // Drops fall straight down; the aircraft's own speed sweeps them back past the camera
    const { sim } = game
    airflow.set(0, -uniforms.fall.value, 0).sub(sim.velocity).multiplyScalar(0.035)
    uniforms.streak.value.copy(airflow)
  })
  return <primitive object={rain} />
}
