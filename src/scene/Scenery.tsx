import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  type Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  Vector3
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { game } from '../game/game'
import { BLAST_REACH } from '../game/ruins'
import { heightAt } from '../world/island'
import { seededRandom } from '../world/noise'
import {
  BALLOONS,
  balloonPosition,
  CITY_PLANS,
  CROWNS,
  FLOCKS,
  HOUSES,
  LIGHTHOUSE,
  type Orbit,
  orbitPosition,
  PARK_TREES,
  ROADS,
  SAILBOATS,
  SHIP,
  SPIRES,
  TOWERS,
  type Tower
} from '../world/scenery'
import { lightLevel, nightUniform } from './atmosphere'
import { depthBias } from './logDepth'

const UP = new Vector3(0, 1, 0)
const placer = new Object3D()

/** Moves `object` to its place on an orbit at `time`, facing the way it travels along -Z. */
function followOrbit(object: Object3D, orbit: Orbit, time: number) {
  const angle = orbitPosition(orbit, time, object.position)
  object.rotation.y = (orbit.rate > 0 ? Math.PI : 0) - angle
}

/** Non-indexed geometry with every vertex painted one colour. */
export function painted(geometry: BufferGeometry, color: string) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry
  if (!flat.getAttribute('normal')) flat.computeVertexNormals()
  if (!flat.getAttribute('uv')) {
    flat.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array(flat.getAttribute('position').count * 2), 2)
    )
  }
  const { r, g, b } = new Color(color)
  const colors = new Float32Array(flat.getAttribute('position').count * 3)
  for (let i = 0; i < colors.length; i += 3) colors.set([r, g, b], i)
  flat.setAttribute('color', new BufferAttribute(colors, 3))
  return flat
}

function triangles(points: number[]) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3))
  return geometry
}

/** Gable roof one unit wide, long, and tall, with the ridge running along Z. */
function roofGeometry() {
  // biome-ignore format: one triangle per line
  const roof = triangles([
    -0.5, 0, 0.5,   0.5, 0, 0.5,   0, 1, 0.5,
    0.5, 0, -0.5,   -0.5, 0, -0.5,   0, 1, -0.5,
    -0.5, 0, -0.5,   -0.5, 0, 0.5,   0, 1, 0.5,
    -0.5, 0, -0.5,   0, 1, 0.5,   0, 1, -0.5,
    0.5, 0, 0.5,   0.5, 0, -0.5,   0, 1, -0.5,
    0.5, 0, 0.5,   0, 1, -0.5,   0, 1, 0.5
  ])
  roof.computeVertexNormals()
  return roof
}

const WALLS = ['#e6e0d1', '#d6cab2', '#efece5', '#c8b89c', '#dad6cd']
const ROOFS = ['#84493a', '#733d33', '#5a5c63', '#96573f', '#696d74']

/** Clusters of houses, each with a church tower. */
export function Villages() {
  const [walls, roofs] = useMemo(() => {
    const random = seededRandom(606)
    const material = new MeshStandardMaterial({ roughness: 0.9 })
    const wallMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      material,
      HOUSES.length
    )
    const roofMesh = new InstancedMesh(roofGeometry(), material, HOUSES.length)
    const matrix = new Matrix4()
    const position = new Vector3()
    const scale = new Vector3()
    const turn = new Quaternion()
    const color = new Color()
    HOUSES.forEach((house, i) => {
      turn.setFromAxisAngle(UP, house.turn)
      position.set(house.x, house.y, house.z)
      wallMesh.setMatrixAt(
        i,
        matrix.compose(position, turn, scale.set(house.width, house.wallHeight, house.depth))
      )
      wallMesh.setColorAt(i, color.set(WALLS[Math.floor(random() * WALLS.length)]))
      position.y += house.wallHeight
      roofMesh.setMatrixAt(
        i,
        matrix.compose(
          position,
          turn,
          scale.set(house.width * 1.12, house.roofHeight, house.depth * 1.08)
        )
      )
      roofMesh.setColorAt(i, color.set(ROOFS[Math.floor(random() * ROOFS.length)]))
    })
    wallMesh.frustumCulled = false
    roofMesh.frustumCulled = false
    return [wallMesh, roofMesh]
  }, [])
  const placed = useMemo(
    () => [[walls, HOUSES, true] as const, [roofs, HOUSES, false] as const],
    [walls, roofs]
  )
  useRuined(placed)
  return (
    <>
      <primitive object={walls} />
      <primitive object={roofs} />
    </>
  )
}

/** White tower with red bands and a glowing lantern on the island's farthest headland. */
export function Lighthouse() {
  return (
    <group position={[LIGHTHOUSE.x, LIGHTHOUSE.y - 0.5, LIGHTHOUSE.z]}>
      {[0, 1, 2, 3].map(band => (
        <mesh key={band} position-y={3.5 + band * 7}>
          <cylinderGeometry args={[3.4 - band * 0.45, 3.85 - band * 0.45, 7, 16]} />
          <meshStandardMaterial color={band % 2 ? '#b3261e' : '#f2efe8'} roughness={0.7} />
        </mesh>
      ))}
      <mesh position-y={28.4}>
        <cylinderGeometry args={[3.2, 3.2, 0.8, 16]} />
        <meshStandardMaterial color="#2a2d30" roughness={0.6} />
      </mesh>
      <mesh position-y={30.3}>
        <cylinderGeometry args={[1.7, 1.7, 3, 12]} />
        <meshStandardMaterial color="#fff3c4" emissive="#ffd866" emissiveIntensity={2.5} />
      </mesh>
      <mesh position-y={32.8}>
        <coneGeometry args={[2.3, 2, 12]} />
        <meshStandardMaterial color="#2a2d30" roughness={0.6} />
      </mesh>
      <mesh position={[9, 2.2, 3]}>
        <boxGeometry args={[9, 4.4, 7]} />
        <meshStandardMaterial color="#ece8de" roughness={0.9} />
      </mesh>
    </group>
  )
}

/** Hull, mast, and two sails. The bow points along -Z. */
function sailboatGeometry() {
  const hull = new BoxGeometry(2.8, 1.3, 9, 1, 1, 6)
  const position = hull.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const along = position.getZ(i) / 4.5
    // Pointed bow, slightly narrower stern, and a hull that tucks in below the waterline
    const beam = along < 0 ? 1 - along * along : 1 - along * 0.2
    position.setX(i, position.getX(i) * beam * (position.getY(i) < 0 ? 0.6 : 1))
  }
  hull.computeVertexNormals()
  return mergeGeometries([
    painted(hull.translate(0, 0.35, 0), '#eeece6'),
    painted(new CylinderGeometry(0.08, 0.1, 12, 6).translate(0, 7, -0.4), '#8f8f8f'),
    painted(triangles([0, 2, -0.1, 0, 12.6, -0.3, 0, 2, 4.2]), '#f6f3ea'),
    painted(triangles([0, 1.6, -0.7, 0, 10.5, -0.5, 0, 1.6, -4.3]), '#f6f3ea')
  ])
}

/** White streak that widens and fades behind a moving boat. */
function wakeMaterial() {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Boat wakes need a 2D canvas, which this browser refused')
  const fade = ctx.createLinearGradient(0, 0, 0, 64)
  fade.addColorStop(0, 'rgba(255,255,255,0.75)')
  fade.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = fade
  ctx.fillRect(0, 0, 4, 64)
  // Lit, so the foam darkens with the sea at night
  return new MeshLambertMaterial({
    map: new CanvasTexture(canvas),
    transparent: true,
    depthWrite: false
  })
}

/** Flat strip one unit long that starts narrow at the stern and spreads out behind it. */
function wakeGeometry() {
  const wake = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5)
  const position = wake.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    if (position.getZ(i) < 0.5) position.setX(i, position.getX(i) * 0.25)
  }
  return wake
}

/** Sailing boats and one cargo ship circling the island. */
export function Boats() {
  const ship = useRef<Group>(null)
  const { boats, wakes } = useMemo(() => {
    const boatMesh = new InstancedMesh(
      sailboatGeometry(),
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: DoubleSide }),
      SAILBOATS.length
    )
    // One extra wake for the ship
    const wakeMesh = new InstancedMesh(wakeGeometry(), wakeMaterial(), SAILBOATS.length + 1)
    boatMesh.frustumCulled = false
    wakeMesh.frustumCulled = false
    wakeMesh.renderOrder = 1.5
    return { boats: boatMesh, wakes: wakeMesh }
  }, [])

  useFrame(() => {
    const time = game.sceneryTime
    SAILBOATS.forEach((orbit, i) => {
      followOrbit(placer, orbit, time)
      // Boats heel in the wind and rock on the swell
      placer.rotation.z = 0.12 + Math.sin(time * 0.9 + i) * 0.05
      placer.position.y = Math.sin(time * 1.1 + i * 2) * 0.15
      placer.scale.setScalar(1)
      placer.updateMatrix()
      boats.setMatrixAt(i, placer.matrix)
      placer.rotation.z = 0
      placer.position.y = 0.12
      placer.translateZ(4)
      placer.scale.set(7, 1, 45)
      placer.updateMatrix()
      wakes.setMatrixAt(i, placer.matrix)
    })
    followOrbit(placer, SHIP, time)
    placer.rotation.z = 0
    placer.position.y = 0.14
    placer.translateZ(34)
    placer.scale.set(42, 1, 420)
    placer.updateMatrix()
    wakes.setMatrixAt(SAILBOATS.length, placer.matrix)
    boats.instanceMatrix.needsUpdate = true
    wakes.instanceMatrix.needsUpdate = true
    if (ship.current) followOrbit(ship.current, SHIP, time)
  })

  return (
    <>
      <primitive object={boats} />
      <primitive object={wakes} />
      <group ref={ship}>
        <mesh position-y={1.5}>
          <boxGeometry args={[12, 7, 72]} />
          <meshStandardMaterial color="#27313d" roughness={0.7} />
        </mesh>
        <mesh position={[0, 4.2, -40]} rotation-y={Math.PI / 4} scale={[1, 1, 1]}>
          <boxGeometry args={[8.5, 1.6, 8.5]} />
          <meshStandardMaterial color="#27313d" roughness={0.7} />
        </mesh>
        <mesh position={[0, 11, 27]}>
          <boxGeometry args={[11, 12, 10]} />
          <meshStandardMaterial color="#ecebe6" roughness={0.8} />
        </mesh>
        <mesh position={[0, 19.5, 29]}>
          <cylinderGeometry args={[1.3, 1.6, 5, 10]} />
          <meshStandardMaterial color="#b3261e" roughness={0.7} />
        </mesh>
        {[-22, -9, 4].map((z, row) => (
          <mesh key={z} position={[0, 7.6, z]}>
            <boxGeometry args={[10.5, 5.2, 11.5]} />
            <meshStandardMaterial color={['#a1482f', '#2f6a8a', '#b9902f'][row]} roughness={0.85} />
          </mesh>
        ))}
      </group>
    </>
  )
}

const BALLOON_COLORS = [
  ['#c8322b', '#f3efe4'],
  ['#e9b52c', '#2c5fa8'],
  ['#e0762a', '#5b3a8c'],
  ['#2f8f5b', '#f3efe4'],
  ['#1f8a94', '#f0c63a']
]

/** Teardrop envelope one unit in radius with twelve vertical stripes in two colours. */
function envelopeGeometry(first: string, second: string) {
  const envelope = new SphereGeometry(1, 24, 16).toNonIndexed()
  const position = envelope.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i)
    if (y >= 0) continue
    // Below the middle the envelope narrows toward the burner
    const taper = 1 - 0.6 * (-y) ** 1.7
    position.setXYZ(i, position.getX(i) * taper, y * 1.35, position.getZ(i) * taper)
  }
  envelope.computeVertexNormals()
  const colors = new Float32Array(position.count * 3)
  const a = new Color(first)
  const b = new Color(second)
  for (let face = 0; face < position.count; face += 3) {
    const x = position.getX(face) + position.getX(face + 1) + position.getX(face + 2)
    const z = position.getZ(face) + position.getZ(face + 1) + position.getZ(face + 2)
    const gore = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 12)
    const { r, g, b: blue } = gore % 2 ? a : b
    for (let corner = 0; corner < 3; corner++) colors.set([r, g, blue], (face + corner) * 3)
  }
  envelope.setAttribute('color', new BufferAttribute(colors, 3))
  return envelope
}

/** Hot-air balloons drifting in slow circles above the lowlands. */
export function Balloons() {
  const groups = useRef<(Group | null)[]>([])
  const envelopes = useMemo(() => BALLOON_COLORS.map(([a, b]) => envelopeGeometry(a, b)), [])
  useFrame(() => {
    const time = game.sceneryTime
    BALLOONS.forEach((_, i) => {
      const balloon = groups.current[i]
      if (!balloon) return
      balloonPosition(i, time, balloon.position)
      balloon.rotation.y = i
    })
  })
  return BALLOONS.map((orbit, i) => (
    <group
      key={orbit.centerX}
      ref={group => {
        groups.current[i] = group
      }}
    >
      <mesh geometry={envelopes[i % envelopes.length]} scale={9}>
        <meshStandardMaterial vertexColors roughness={0.75} />
      </mesh>
      <mesh position-y={-12.6}>
        <cylinderGeometry args={[2.1, 1.4, 1.2, 12, 1, true]} />
        <meshStandardMaterial color="#2a2a2a" side={DoubleSide} />
      </mesh>
      <mesh position-y={-16}>
        <boxGeometry args={[1.7, 1.3, 1.7]} />
        <meshStandardMaterial color="#7a5a36" roughness={0.9} />
      </mesh>
    </group>
  ))
}

/** Seabirds circling the shoreline in flocks. Their wings flap in the vertex shader. */
export function Birds() {
  const flapTime = useMemo(() => ({ value: 0 }), [])
  const birds = useMemo(() => {
    const all = FLOCKS.flat()
    // biome-ignore format: one triangle per line
    const geometry = triangles([
      0, 0, -0.3,   0, 0, 0.3,   -1.2, 0, 0.12,
      0, 0, 0.3,   0, 0, -0.3,   1.2, 0, 0.12
    ])
    geometry.computeVertexNormals()
    const phases = Float32Array.from(all, (_, i) => i * 1.7)
    geometry.setAttribute('phase', new InstancedBufferAttribute(phases, 1))
    const material = new MeshLambertMaterial({ color: '#e9e9e6', side: DoubleSide })
    material.onBeforeCompile = shader => {
      shader.uniforms.flapTime = flapTime
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float flapTime;\nattribute float phase;'
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\ntransformed.y += abs(position.x) * sin(flapTime * 7.0 + phase) * 0.5;'
        )
    }
    const mesh = new InstancedMesh(geometry, material, all.length)
    mesh.frustumCulled = false
    return mesh
  }, [flapTime])

  useFrame(() => {
    const time = game.sceneryTime
    flapTime.value = time
    let index = 0
    for (const flock of FLOCKS) {
      for (const orbit of flock) {
        followOrbit(placer, orbit, time)
        placer.position.y += Math.sin(time * 0.4 + index) * 6
        // Birds bank into their turn
        placer.rotation.z = orbit.rate > 0 ? -0.35 : 0.35
        placer.scale.setScalar(1)
        placer.updateMatrix()
        birds.setMatrixAt(index++, placer.matrix)
      }
    }
    birds.instanceMatrix.needsUpdate = true
  })
  return <primitive object={birds} />
}

// Concrete tints and glass tints. The last of each is the plain grey of rooftop plant rooms.
const FACADES = ['#d8d4c8', '#c4c9cc', '#b9b2a4', '#e6e3da', '#aab4bd', '#c9bfae', '#9a9c9e']
const GLASS = ['#8fb3d1', '#9cc0b8', '#b8a88a', '#c3cbd3', '#7d95b0', '#a9b9c9', '#9a9c9e']
// One facade texture covers four window bays across and four floors up
const BAY = 3.5
const FLOOR = 3.6

/** Draws one 128-pixel facade tile, four bays by four floors, white where the tint shows. */
function facadeTexture(glass: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('City facades need a 2D canvas, which this browser refused')
  const pick = seededRandom(glass ? 31 : 37)
  ctx.fillStyle = glass ? '#8a96a3' : '#ffffff'
  ctx.fillRect(0, 0, 128, 128)
  for (let floor = 0; floor < 4; floor++) {
    for (let bay = 0; bay < 4; bay++) {
      const shade = Math.floor(pick() * 30)
      if (glass) {
        // Panes catch the sky unevenly, between light mullions and spandrel bands
        ctx.fillStyle = `rgb(${120 + shade}, ${134 + shade}, ${150 + shade})`
        ctx.fillRect(bay * 32 + 2, floor * 32 + 5, 29, 26)
      } else {
        ctx.fillStyle = `rgb(${46 + shade}, ${58 + shade}, ${72 + shade})`
        ctx.fillRect(bay * 32 + 6, floor * 32 + 8, 20, 17)
      }
    }
  }
  if (glass) {
    ctx.fillStyle = '#dfe4e8'
    for (let line = 0; line < 4; line++) {
      ctx.fillRect(line * 32, 0, 2, 128)
      ctx.fillRect(0, line * 32, 128, 4)
    }
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.anisotropy = 8
  return texture
}

const FACADE_VERTEX = /* glsl */ `
  #include <begin_vertex>
  {
    // Map the facade texture by real size, so every building has floors 3.6 m apart
    vec3 size = vec3(
      length(instanceMatrix[0].xyz),
      length(instanceMatrix[1].xyz),
      length(instanceMatrix[2].xyz)
    );
    #ifdef ROUND
      float around = atan(position.z, position.x) * 0.5 * size.x;
    #else
      float around = abs(normal.x) > 0.5 ? position.z * size.z : position.x * size.x;
    #endif
    // Shift the pattern per building so neighbours do not line up
    float shift = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    vFacade = vec2(around / ${BAY.toFixed(1)} + floor(shift * 8.0) * 0.25, position.y * size.y / ${(FLOOR * 4).toFixed(1)});
    vRise = position.y * size.y;
    vShift = shift;
  }
`

const FACADE_FRAGMENT = /* glsl */ `
  vec4 facade = texture2D(map, vFacade);
  diffuseColor *= facade;
  // Street level sits in the shade of the buildings across the road
  diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.0, 20.0, vRise));
`

const GLASS_SHEEN = /* glsl */ `
  // Glass reflects more of the bright sky the more steeply you look across it
  float facing = abs(dot(normalize(vViewPosition), normal));
  totalEmissiveRadiance += vec3(0.5, 0.6, 0.72) * (0.12 + 0.5 * pow(1.0 - facing, 3.0)) * daylight;
`

/** At night about two windows in five glow, a different set on every building. */
function windowGlow(glass: boolean) {
  return /* glsl */ `
  #include <emissivemap_fragment>
  {
    vec4 pane = texture2D(map, vFacade);
    float brightness = dot(pane.rgb, vec3(0.33));
    // Windows are the darker parts of the facade tile; mullions and walls are pale
    float window = ${glass ? '1.0 - smoothstep(0.72, 0.82, brightness)' : '1.0 - smoothstep(0.45, 0.6, brightness)'};
    vec2 cell = floor(vFacade * 4.0) + vShift * 97.0;
    float lit = step(0.6, fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453));
    vec3 warm = mix(vec3(1.0, 0.78, 0.48), vec3(0.85, 0.9, 1.0), step(0.8, fract(cell.x * 0.37 + cell.y * 0.71)));
    totalEmissiveRadiance += warm * window * lit * night * 1.4;
  }
  ${glass ? 'GLASS_SHEEN_HERE' : ''}
`
}

/** Lit wall material whose windows keep their real size on any building. */
function facadeMaterial(glass: boolean, round: boolean) {
  const material = new MeshStandardMaterial({
    map: facadeTexture(glass),
    roughness: glass ? 0.35 : 0.85,
    metalness: glass ? 0.25 : 0
  })
  material.defines = round ? { ROUND: '' } : {}
  material.onBeforeCompile = shader => {
    const varyings = 'varying vec2 vFacade;\nvarying float vRise;\nvarying float vShift;'
    shader.uniforms.night = nightUniform
    shader.uniforms.daylight = lightLevel
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${varyings}`)
      .replace('#include <begin_vertex>', FACADE_VERTEX)
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${varyings}\nuniform float night;\nuniform float daylight;`
      )
      .replace('#include <map_fragment>', FACADE_FRAGMENT)
      .replace(
        '#include <emissivemap_fragment>',
        windowGlow(glass).replace('GLASS_SHEEN_HERE', GLASS_SHEEN)
      )
  }
  material.customProgramCacheKey = () => `facade-${glass}-${round}`
  return material
}

/** Flat roof material that ignores the wall tint of its building. */
function roofMaterial() {
  const material = new MeshStandardMaterial({ color: '#85878a', roughness: 0.9 })
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '')
  }
  material.customProgramCacheKey = () => 'city-roof'
  return material
}

/** Unit box standing on its base, with walls in group 0 and the roof in group 1. */
function buildingBox() {
  const box = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
  const index = box.index?.array
  if (!index) throw new Error('Building boxes need indexed geometry')
  // Faces come in the order right, left, top, bottom, front, back, six indices each
  const face = (n: number) => Array.from(index.slice(n * 6, n * 6 + 6))
  box.setIndex([...face(0), ...face(1), ...face(4), ...face(5), ...face(2)])
  box.clearGroups()
  box.addGroup(0, 24, 0)
  box.addGroup(24, 6, 1)
  return box
}

/** Unit cylinder standing on its base, with the wall in group 0 and the roof in group 1. */
function buildingCylinder() {
  const cylinder = new CylinderGeometry(0.5, 0.5, 1, 20).translate(0, 0.5, 0)
  // Drop the bottom cap, which is never seen
  cylinder.groups.length = 2
  return cylinder
}

const placeMatrix = new Matrix4()
const placePosition = new Vector3()
const placeVector = new Vector3()
const placeScale = new Vector3()
const placeTurn = new Quaternion()

/** One instanced mesh holding `items`, each placed by `place` and tinted by `tint`. */
function instances<T>(
  geometry: BufferGeometry,
  material:
    | MeshStandardMaterial
    | MeshLambertMaterial
    | (MeshStandardMaterial | MeshLambertMaterial)[],
  items: T[],
  place: (item: T, position: Vector3, scale: Vector3) => number,
  tint: (item: T) => string
) {
  const mesh = new InstancedMesh(geometry, material, Math.max(items.length, 1))
  mesh.count = items.length
  const color = new Color()
  items.forEach((item, i) => {
    const turn = place(item, placePosition, placeScale)
    placeTurn.setFromAxisAngle(UP, turn)
    mesh.setMatrixAt(i, placeMatrix.compose(placePosition, placeTurn, placeScale))
    mesh.setColorAt(i, color.set(tint(item)))
  })
  // Instances spread over the whole map, so the default bounds would cull them wrongly
  mesh.frustumCulled = false
  return [mesh, items] as const
}

/**
 * Instances, each with the spot of the thing it draws, and whether a falling one throws up
 * a cloud of dust.
 */
type Placed = readonly (readonly [InstancedMesh, readonly { x: number; z: number }[], boolean])[]

// Seconds a building takes to sink into its rubble, and the longest wait before it starts
const COLLAPSE = 1.6
const COLLAPSE_DELAY = 0.5

/** One instance on its way down: which part and instance, when it started, and its lean. */
type Falling = { part: number; index: number; age: number; ground: number; lean: number }

/**
 * Brings down every instance a bomb blast reached: each sinks into the ground and leans as
 * it goes, then disappears. All come back when the ruins clear for a new flight.
 */
function useRuined(parts: Placed) {
  const seen = useRef({ generation: -1, craters: 0 })
  const falling = useRef<Falling[]>([])
  const saved = useMemo(() => parts.map(([mesh]) => mesh.instanceMatrix.array.slice()), [parts])
  useFrame((_, delta) => {
    const { effects } = game
    const { ruins } = game.bombs
    const { craters } = ruins
    const last = seen.current
    if (last.generation !== ruins.generation) {
      if (last.craters > 0) {
        parts.forEach(([mesh], i) => {
          mesh.instanceMatrix.array.set(saved[i])
          mesh.instanceMatrix.needsUpdate = true
        })
      }
      falling.current = []
      seen.current = { generation: ruins.generation, craters: 0 }
    }
    const reach = BLAST_REACH * BLAST_REACH
    for (let c = seen.current.craters; c < craters.length; c++) {
      const { x, z } = craters[c]
      parts.forEach(([, items, dust], part) => {
        items.forEach((item, index) => {
          if ((item.x - x) ** 2 + (item.z - z) ** 2 > reach) return
          const ground = heightAt(item.x, item.z)
          // Nearer the blast, the sooner it goes
          const near = Math.sqrt(((item.x - x) ** 2 + (item.z - z) ** 2) / reach)
          const age = -near * COLLAPSE_DELAY
          falling.current.push({ part, index, age, ground, lean: Math.random() - 0.5 })
          if (dust) effects.collapse(placeVector.set(item.x, ground, item.z))
        })
      })
    }
    seen.current.craters = craters.length
    if (falling.current.length === 0) return
    falling.current = falling.current.filter(fall => {
      fall.age += delta
      const [mesh] = parts[fall.part]
      const matrices = mesh.instanceMatrix.array
      const o = fall.index * 16
      mesh.instanceMatrix.needsUpdate = true
      const t = Math.min(1, Math.max(0, fall.age / COLLAPSE))
      if (t >= 1) {
        // A matrix of zeros draws nothing
        matrices.fill(0, o, o + 16)
        return false
      }
      // Falls slowly at first, then faster. The height and the lift off the ground shrink
      // together, and the top leans over to one side as it goes.
      const k = 1 - t * t
      const original = saved[fall.part]
      for (let n = 0; n < 16; n++) matrices[o + n] = original[o + n]
      matrices[o + 4] = original[o + 4] * k + fall.lean * (1 - k) * original[o + 5] * 0.4
      matrices[o + 5] = original[o + 5] * k
      matrices[o + 6] = original[o + 6] * k + fall.lean * (1 - k) * original[o + 5] * 0.3
      matrices[o + 13] = fall.ground + (original[o + 13] - fall.ground) * k
      return true
    })
  })
}

/** Streets, pavements, parks, and the central plaza of one city, seen from above. */
function streetTexture(plan: (typeof CITY_PLANS)[number]) {
  const { city, blocks } = plan
  const canvas = document.createElement('canvas')
  const scale = 1024 / Math.max(city.length, city.width)
  canvas.width = Math.round(city.width * scale)
  canvas.height = Math.round(city.length * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('City streets need a 2D canvas, which this browser refused')
  // Canvas x runs across the city, and up the canvas runs along its heading
  const rect = (along: number, across: number, length: number, width: number) =>
    [
      canvas.width / 2 + (across - width / 2) * scale,
      canvas.height / 2 - (along + length / 2) * scale,
      width * scale,
      length * scale
    ] as const
  ctx.fillStyle = '#3d4044'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Dashed centre lines down the avenues
  ctx.strokeStyle = '#cfc69a'
  ctx.lineWidth = Math.max(1, scale * 0.6)
  ctx.setLineDash([6, 6])
  const lines = (spans: number[][], vertical: boolean) => {
    for (let i = 1; i < spans.length; i++) {
      const gap = spans[i][0] - spans[i - 1][1]
      if (gap < 20) continue
      const middle = (spans[i][0] + spans[i - 1][1]) / 2
      ctx.beginPath()
      if (vertical) {
        const x = canvas.width / 2 + middle * scale
        ctx.moveTo(x, 0)
        ctx.lineTo(x, canvas.height)
      } else {
        const y = canvas.height / 2 - middle * scale
        ctx.moveTo(0, y)
        ctx.lineTo(canvas.width, y)
      }
      ctx.stroke()
    }
  }
  const spansOf = (key: 'along' | 'across', size: 'length' | 'width') =>
    [...new Map(blocks.map(block => [block[key], block[size]])).entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([middle, extent]) => [middle - extent / 2, middle + extent / 2])
  lines(spansOf('across', 'width'), true)
  lines(spansOf('along', 'length'), false)
  ctx.setLineDash([])

  const INNER = {
    buildings: '#85867f',
    houses: '#6b7a4c',
    park: '#557a38',
    plaza: '#c2b9a6',
    hospital: '#a9aba4'
  }
  for (const block of blocks) {
    ctx.fillStyle = '#9d9d95'
    ctx.fillRect(...rect(block.along, block.across, block.length, block.width))
    ctx.fillStyle = INNER[block.use]
    ctx.fillRect(...rect(block.along, block.across, block.length - 6, block.width - 6))
    const [x, y, w, h] = rect(block.along, block.across, block.length - 6, block.width - 6)
    if (block.use === 'park') {
      // Footpaths crossing the park
      ctx.strokeStyle = '#bdb59c'
      ctx.lineWidth = Math.max(1, scale * 2.5)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + w, y + h)
      ctx.moveTo(x + w, y)
      ctx.lineTo(x, y + h)
      ctx.stroke()
    } else if (block.use === 'plaza') {
      ctx.strokeStyle = '#a99f8a'
      ctx.lineWidth = 1
      for (let step = 0; step <= 1; step += 0.125) {
        ctx.beginPath()
        ctx.moveTo(x + w * step, y)
        ctx.lineTo(x + w * step, y + h)
        ctx.moveTo(x, y + h * step)
        ctx.lineTo(x + w, y + h * step)
        ctx.stroke()
      }
      ctx.fillStyle = '#6f9fb8'
      ctx.beginPath()
      ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.14, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

/**
 * Every city: concrete and glass towers, glass cylinders, spires and crowns,
 * park trees, and the street plan under them. Each kind is one instanced mesh.
 */
export function Cities() {
  const meshes = useMemo(() => {
    const roof = roofMaterial()
    const box = buildingBox()
    const placeTower = (tower: Tower, position: Vector3, scale: Vector3) => {
      position.set(tower.x, tower.y, tower.z)
      scale.set(tower.width, tower.height, tower.round ? tower.width : tower.depth)
      return tower.turn
    }
    const tintOf = (tower: Tower) => (tower.glass ? GLASS : FACADES)[tower.tint]
    const concrete = instances(
      box,
      [facadeMaterial(false, false), roof],
      TOWERS.filter(tower => !tower.glass && !tower.round),
      placeTower,
      tintOf
    )
    const glass = instances(
      box,
      [facadeMaterial(true, false), roof],
      TOWERS.filter(tower => tower.glass && !tower.round),
      placeTower,
      tintOf
    )
    const round = instances(
      buildingCylinder(),
      [facadeMaterial(true, true), roof],
      TOWERS.filter(tower => tower.round),
      placeTower,
      tintOf
    )
    const spires = instances(
      new CylinderGeometry(0.1, 0.5, 1, 8).translate(0, 0.5, 0),
      new MeshStandardMaterial({ roughness: 0.4, metalness: 0.6 }),
      SPIRES,
      (spire, position, scale) => {
        position.set(spire.x, spire.y, spire.z)
        scale.set(spire.radius * 2, spire.height, spire.radius * 2)
        return 0
      },
      () => '#c9ced3'
    )
    const crowns = instances(
      new ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0),
      new MeshStandardMaterial({ roughness: 0.4, metalness: 0.4, flatShading: true }),
      CROWNS,
      (crown, position, scale) => {
        position.set(crown.x, crown.y, crown.z)
        scale.set(crown.width, crown.height, crown.depth)
        return crown.turn
      },
      tintOf
    )
    const random = seededRandom(909)
    const trees = instances(
      new IcosahedronGeometry(1, 0),
      new MeshLambertMaterial({ flatShading: true }),
      PARK_TREES,
      (tree, position, scale) => {
        position.set(tree.x, tree.y + tree.size * 1.3, tree.z)
        scale.set(tree.size, tree.size * 1.2, tree.size)
        return random() * Math.PI
      },
      () => PARK_GREENS[Math.floor(random() * PARK_GREENS.length)]
    )
    // Buildings throw up dust as they fall. Spires, crowns, and trees go down with them.
    return [
      [...concrete, true],
      [...glass, true],
      [...round, true],
      [...spires, false],
      [...crowns, false],
      [...trees, false]
    ] as const
  }, [])
  useRuined(meshes)
  const streets = useMemo(() => CITY_PLANS.map(streetTexture), [])
  return (
    <>
      {meshes.map(([mesh]) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
      {CITY_PLANS.map(({ city }, i) => (
        <mesh
          key={city.name}
          position={[city.x, city.elevation + 0.25, city.z]}
          rotation={[-Math.PI / 2, 0, (-city.heading * Math.PI) / 180]}
          receiveShadow
        >
          <planeGeometry args={[city.width, city.length]} />
          <meshStandardMaterial map={streets[i]} roughness={0.95} {...depthBias(0.0005)} />
        </mesh>
      ))}
    </>
  )
}

const PARK_GREENS = ['#3f5f2c', '#4a6b31', '#365428', '#56743a']

const ROAD_WIDTH = 12

/** Roads laid over the terrain between each city, its airport, and the nearest village. */
export function Roads() {
  const geometry = useMemo(() => {
    const positions: number[] = []
    const index: number[] = []
    for (const road of ROADS) {
      for (let leg = 0; leg < road.length - 1; leg++) {
        const [fromX, fromZ] = road[leg]
        const [toX, toZ] = road[leg + 1]
        const distance = Math.hypot(toX - fromX, toZ - fromZ)
        const steps = Math.max(1, Math.ceil(distance / 30))
        // Unit vector to the right of the direction of travel
        const sideX = (-(toZ - fromZ) / distance) * (ROAD_WIDTH / 2)
        const sideZ = ((toX - fromX) / distance) * (ROAD_WIDTH / 2)
        for (let step = 0; step <= steps; step++) {
          const x = fromX + ((toX - fromX) * step) / steps
          const z = fromZ + ((toZ - fromZ) * step) / steps
          const vertex = positions.length / 3
          for (const edge of [-1, 1]) {
            const edgeX = x + sideX * edge
            const edgeZ = z + sideZ * edge
            positions.push(edgeX, Math.max(heightAt(edgeX, edgeZ), 0) + 0.45, edgeZ)
          }
          if (step < steps)
            index.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2)
        }
      }
    }
    const roads = new BufferGeometry()
    roads.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    roads.setIndex(index)
    roads.computeVertexNormals()
    return roads
  }, [])
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial
        color="#44474b"
        roughness={0.95}
        side={DoubleSide}
        {...depthBias(0.001)}
      />
    </mesh>
  )
}
