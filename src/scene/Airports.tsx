import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  DataTexture,
  DoubleSide,
  type Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Quaternion,
  SRGBColorSpace,
  Vector3
} from 'three'
import { game, useGame } from '../game/game'
import type { AirlinerShape } from '../sim/aircraft'
import {
  AIRPORTS,
  type Airport,
  type Building,
  fromStrip,
  outside,
  type Stand,
  type Strip
} from '../world/island'
import { depthBias } from './logDepth'

const QUARTER_TURN = Math.PI / 2
type Patch = Strip & { y: number }

/** One flat mesh made of many rectangles lying on the ground. */
function patchGeometry(patches: Patch[]) {
  const positions = new Float32Array(patches.length * 12)
  const index: number[] = []
  patches.forEach((patch, i) => {
    const corners = [
      fromStrip(patch, -patch.length / 2, -patch.width / 2),
      fromStrip(patch, -patch.length / 2, patch.width / 2),
      fromStrip(patch, patch.length / 2, patch.width / 2),
      fromStrip(patch, patch.length / 2, -patch.width / 2)
    ]
    corners.forEach((corner, n) => {
      positions.set([corner.x, patch.y, corner.z], i * 12 + n * 3)
    })
    index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3)
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  return geometry
}

/** A long painted line running the full length of a strip, by its distance from the centre. */
type Line = { offset: number; width: number; color: string }

/**
 * Long lines running the length of strips, such as runway edge lines or taxiway
 * centrelines, drawn as one see-through texture over each group of strips of a width. The
 * texture fades a thin line smoothly with distance, where a separate thin shape would break
 * up and shimmer once it covers less than a pixel.
 */
function lineOverlays(patches: Patch[], lines: (width: number) => Line[]) {
  const widths = [...new Set(patches.map(patch => patch.width))]
  return widths.map(width => {
    const group = patches.filter(patch => patch.width === width)
    const geometry = patchGeometry(group)
    // Across the strip from one edge to the other; the lines run unchanged along it
    const uv = new Float32Array(group.length * 8)
    group.forEach((_, i) => uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8))
    geometry.setAttribute('uv', new BufferAttribute(uv, 2))
    // Every texel carries the line colour, so faded edges stay that colour in the distance;
    // only the opacity marks where a line is
    const data = new Uint8Array(LINE_TEXTURE_SIZE * 4)
    const pixels = LINE_TEXTURE_SIZE / width
    for (const line of lines(width)) {
      // The colour's sRGB bytes, as the texture stores them
      const hex = Number.parseInt(line.color.slice(1), 16)
      const rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
      const from = Math.round((width / 2 + line.offset - line.width / 2) * pixels)
      const to = Math.round((width / 2 + line.offset + line.width / 2) * pixels)
      for (let x = 0; x < LINE_TEXTURE_SIZE; x++) {
        const inside = x >= from && x < to
        if (!inside && data[x * 4 + 3] > 0) continue
        data.set([...rgb, inside ? 255 : 0], x * 4)
      }
    }
    const texture = new DataTexture(data, LINE_TEXTURE_SIZE, 1)
    texture.colorSpace = SRGBColorSpace
    texture.generateMipmaps = true
    texture.minFilter = LinearMipmapLinearFilter
    texture.magFilter = LinearFilter
    texture.anisotropy = 16
    texture.needsUpdate = true
    return { geometry, texture, width }
  })
}

const LINE_TEXTURE_SIZE = 512
const WHITE_PAINT = '#e2dfd5'
const YELLOW_PAINT = '#e3b321'

/** Rectangle placed by distances along and across another strip. */
function mark(
  base: Strip,
  y: number,
  along: number,
  across: number,
  length: number,
  width: number
): Patch {
  return { ...fromStrip(base, along, across), heading: base.heading, length, width, y }
}

/** White edge lines along both sides of a runway, painted into its surface. */
const runwayEdges = (width: number): Line[] =>
  [-1, 1].map(side => ({ offset: side * (width / 2 - 1.5), width: 0.9, color: WHITE_PAINT }))

/** White paint on a runway: centreline dashes, threshold bars, and aiming points. */
function runwayPaint(runway: Strip, y: number) {
  const paint: Patch[] = []
  const half = runway.length / 2
  for (let along = -half + 125; along < half - 110; along += 50) {
    paint.push(mark(runway, y, along, 0, 30, 0.9))
  }
  const bars = Math.floor((runway.width / 2 - 3) / 3.6)
  for (const end of [-1, 1]) {
    for (let bar = 0; bar < bars; bar++) {
      for (const side of [-1, 1]) {
        paint.push(mark(runway, y, end * (half - 21), side * (3.9 + bar * 3.6), 30, 1.8))
      }
    }
    if (runway.length > 1400) {
      for (const side of [-1, 1])
        paint.push(mark(runway, y, end * (half - 320), side * 6.5, 45, 4.5))
    }
  }
  return paint
}

/** Yellow centreline along a taxiway, painted into its surface. */
const taxiCentreline = (): Line[] => [{ offset: 0, width: 0.5, color: YELLOW_PAINT }]

/** Yellow taxi lines from the taxiway out to each parking stand, and the stop bars there. */
function taxiPaint(airport: Airport, y: number) {
  const paint: Patch[] = []
  for (const stand of [...airport.gates, ...airport.ramps]) {
    const lane: Strip = { ...stand, heading: (stand.heading * 180) / Math.PI, length: 1, width: 1 }
    paint.push(mark(lane, y, -45, 0, 150, 0.5))
    // Stop bar where the nose wheel parks
    paint.push({ ...mark(lane, y, 0, 0, 0.6, 9), heading: lane.heading })
  }
  return paint
}

/** Two-digit runway number for a heading in degrees, such as 09 or 27. */
function runwayNumber(heading: number) {
  const number = Math.round((((heading % 360) + 360) % 360) / 10) || 36
  return String(number).padStart(2, '0')
}

function numberTexture(label: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Runway numbers need a 2D canvas, which this browser refused')
  ctx.fillStyle = '#e9e6dc'
  ctx.font = 'bold 104px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 64, 70)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** The number painted at each end of a runway, readable on the approach to that end. */
function RunwayNumbers({ runway, y }: { runway: Strip; y: number }) {
  const textures = useMemo(
    () => [
      numberTexture(runwayNumber(runway.heading)),
      numberTexture(runwayNumber(runway.heading + 180))
    ],
    [runway.heading]
  )
  return [0, 1].map(end => {
    const spot = fromStrip(runway, (end ? 1 : -1) * (runway.length / 2 - 62), 0)
    const size = runway.width * 0.5
    return (
      <mesh
        key={end}
        position={[spot.x, y, spot.z]}
        rotation={[-QUARTER_TURN, 0, -((runway.heading + end * 180) * Math.PI) / 180]}
      >
        <planeGeometry args={[size, size]} />
        <meshLambertMaterial
          map={textures[end]}
          transparent
          depthWrite={false}
          {...depthBias(LAYER.numbers)}
        />
      </mesh>
    )
  })
}

// Sock with its mouth at the origin, pointing along +X
const SOCK = new ConeGeometry(0.7, 4.5, 8, 1, true).rotateZ(-QUARTER_TURN).translate(2.25, 0, 0)

/** Windsock that swings downwind and droops when the air is calm. */
function Windsock({ airport }: { airport: Airport }) {
  const swing = useRef<Group>(null)
  const droop = useRef<Group>(null)
  const runway = airport.runways[0]
  const spot = fromStrip(runway, -runway.length / 2 + 120, runway.width / 2 + 30)
  useFrame(() => {
    if (!swing.current || !droop.current) return
    const { x, z } = game.wind
    const speed = Math.hypot(x, z)
    if (speed > 0.1) swing.current.rotation.y = Math.atan2(-z, x)
    droop.current.rotation.z = -1.35 * (1 - Math.min(1, speed / 8))
  })
  return (
    <group position={[spot.x, airport.elevation, spot.z]}>
      <mesh position-y={3.5}>
        <cylinderGeometry args={[0.08, 0.1, 7, 6]} />
        <meshStandardMaterial color="#d8d8d8" />
      </mesh>
      <group ref={swing} position-y={7}>
        <group ref={droop}>
          <mesh geometry={SOCK}>
            <meshStandardMaterial color="#f07a1c" side={DoubleSide} />
          </mesh>
        </group>
      </group>
    </group>
  )
}

/** Terminal, hangar, or control tower. Its long side runs along local Z. */
function BuildingModel({ building, base }: { building: Building; base: number }) {
  const { length, width, height, kind } = building
  return (
    <group
      position={[building.x, base, building.z]}
      rotation-y={(-building.heading * Math.PI) / 180}
    >
      {kind === 'terminal' && (
        <>
          <mesh position-y={height / 2}>
            <boxGeometry args={[width, height, length]} />
            <meshStandardMaterial color="#d9d6cc" roughness={0.85} />
          </mesh>
          {/* Band of glass around the departure hall, and a roof that overhangs it */}
          <mesh position-y={height * 0.55}>
            <boxGeometry args={[width + 0.6, height * 0.45, length + 0.6]} />
            <meshStandardMaterial color="#27404f" roughness={0.15} metalness={0.5} />
          </mesh>
          <mesh position-y={height + 0.6}>
            <boxGeometry args={[width + 6, 1.2, length + 6]} />
            <meshStandardMaterial color="#8c9399" roughness={0.6} />
          </mesh>
        </>
      )}
      {kind === 'hangar' && (
        <>
          <mesh position-y={height * 0.35}>
            <boxGeometry args={[width, height * 0.7, length]} />
            <meshStandardMaterial color="#b9c0c4" roughness={0.8} />
          </mesh>
          {/* Arched roof: half a cylinder lying along the hangar's depth */}
          <mesh
            position-y={height * 0.7}
            rotation-z={QUARTER_TURN}
            scale={[0.3 * (height / (length / 2)), 1, 1]}
          >
            <cylinderGeometry args={[length / 2, length / 2, width, 20, 1, false, 0, Math.PI]} />
            <meshStandardMaterial color="#8f989e" roughness={0.6} side={DoubleSide} />
          </mesh>
        </>
      )}
      {kind === 'tower' && (
        <>
          <mesh position-y={height * 0.42}>
            <cylinderGeometry args={[width * 0.32, width * 0.42, height * 0.84, 12]} />
            <meshStandardMaterial color="#e3ded2" roughness={0.9} />
          </mesh>
          <mesh position-y={height * 0.9}>
            <cylinderGeometry args={[width * 0.75, width * 0.55, height * 0.12, 12]} />
            <meshStandardMaterial color="#1f2f3a" roughness={0.15} metalness={0.5} />
          </mesh>
          <mesh position-y={height * 0.98}>
            <cylinderGeometry args={[width * 0.8, width * 0.8, height * 0.04, 12]} />
            <meshStandardMaterial color="#8c9399" roughness={0.6} />
          </mesh>
        </>
      )}
    </group>
  )
}

const BRIDGE_HEIGHT = 4.4
const door = new Vector3()

/** World position of the forward left door of an airliner, written into `out`. */
function doorOf(shape: AirlinerShape, position: Vector3, orientation: Quaternion, out: Vector3) {
  const along = shape.noseZ + (shape.tailZ - shape.noseZ) * 0.16
  return out
    .set(-shape.radius * 0.97, -shape.radius * 0.2, along)
    .applyQuaternion(orientation)
    .add(position)
}

/**
 * Passenger bridge at one gate. It swings out to the door of an airliner parked on the
 * stand with its parking brake set, and folds back against the terminal otherwise.
 */
function JetBridge({ stand, base, terminal }: { stand: Stand; base: number; terminal: Strip }) {
  const arm = useRef<Group>(null)
  const cab = useRef<Group>(null)
  const { pivot, folded, tip, docked } = useMemo(() => {
    const forward = new Vector3(Math.sin(stand.heading), 0, -Math.cos(stand.heading))
    const left = new Vector3(-Math.cos(stand.heading), 0, -Math.sin(stand.heading))
    const wall = outside(terminal, stand.x, stand.z)
    const at = (ahead: number, aside: number) =>
      new Vector3(stand.x, base + BRIDGE_HEIGHT, stand.z)
        .addScaledVector(forward, ahead)
        .addScaledVector(left, aside)
    const rest = at(wall - 15, 7)
    // An airliner that is always parked here keeps its bridge attached
    const resident = game.traffic.parked.find(craft => craft.stand === stand)
    return {
      pivot: at(wall - 1, 11),
      folded: rest,
      tip: rest.clone(),
      docked: resident
        ? doorOf(resident.shape, resident.position, resident.orientation, new Vector3())
        : null
    }
  }, [stand, base, terminal])

  useFrame((_, delta) => {
    const { sim, pilot } = game
    let target = docked ?? folded
    const { shape } = sim.spec
    const here = Math.hypot(sim.position.x - stand.x, sim.position.z - stand.z) < 9
    if (shape.type === 'airliner' && here && sim.groundSpeed < 0.2 && pilot.controls.parkingBrake) {
      target = doorOf(shape, sim.position, sim.orientation, door)
    }
    tip.lerp(target, 1 - Math.exp(-delta * 1.1))
    if (!arm.current || !cab.current) return
    arm.current.lookAt(tip)
    arm.current.scale.z = pivot.distanceTo(tip)
    cab.current.position.copy(tip)
  })

  return (
    <>
      <group ref={arm} position={pivot}>
        <mesh position={[0, 0, 0.5]}>
          <boxGeometry args={[2.4, 2.5, 1]} />
          <meshStandardMaterial color="#c9ced1" roughness={0.6} />
        </mesh>
      </group>
      <mesh position={pivot}>
        <cylinderGeometry args={[2.3, 2.3, 3, 12]} />
        <meshStandardMaterial color="#aab1b5" roughness={0.6} />
      </mesh>
      <group ref={cab}>
        <mesh>
          <boxGeometry args={[3.2, 2.7, 3.2]} />
          <meshStandardMaterial color="#aab1b5" roughness={0.6} />
        </mesh>
        <mesh position-y={-BRIDGE_HEIGHT / 2 - 0.6}>
          <cylinderGeometry args={[0.25, 0.25, BRIDGE_HEIGHT - 1, 6]} />
          <meshStandardMaterial color="#5c6367" roughness={0.7} />
        </mesh>
      </group>
    </>
  )
}

// Each flat layer is drawn this share of its distance nearer than the one below, so taxiways
// sit on the ground, runways on taxiways, and paint on runways, without flickering
const LAYER = { aprons: 0.0005, runways: 0.001, paint: 0.0015, numbers: 0.002 }

/** Runways, taxiways, aprons, paint, and buildings for every airport on the map. */
export function Airports() {
  // Rain darkens the pavement and gives it a sheen
  const wet = useGame(state => state.weather === 'rain')
  const surfaces = useMemo(() => {
    const runways: Patch[] = []
    const taxiLines: Patch[] = []
    const edgeLines: Patch[] = []
    const aprons: Patch[] = []
    const white: Patch[] = []
    const yellow: Patch[] = []
    for (const airport of AIRPORTS) {
      const y = airport.elevation
      for (const strip of [...airport.taxiways, ...airport.aprons])
        aprons.push({ ...strip, y: y + 0.07 })
      for (const strip of airport.taxiways) taxiLines.push({ ...strip, y: y + 0.12 })
      for (const runway of airport.runways) {
        runways.push({ ...runway, y: y + 0.1 })
        edgeLines.push({ ...runway, y: y + 0.13 })
        white.push(...runwayPaint(runway, y + 0.13))
      }
      yellow.push(...taxiPaint(airport, y + 0.12))
    }
    return {
      runways: patchGeometry(runways),
      lines: [...lineOverlays(edgeLines, runwayEdges), ...lineOverlays(taxiLines, taxiCentreline)],
      aprons: patchGeometry(aprons),
      white: patchGeometry(white),
      yellow: patchGeometry(yellow)
    }
  }, [])
  return (
    <>
      <mesh geometry={surfaces.aprons} receiveShadow>
        <meshStandardMaterial
          color={wet ? '#3f4245' : '#565a5e'}
          roughness={wet ? 0.55 : 0.95}
          {...depthBias(LAYER.aprons)}
        />
      </mesh>
      <mesh geometry={surfaces.runways} receiveShadow>
        <meshStandardMaterial
          color={wet ? '#26282b' : '#35383c'}
          roughness={wet ? 0.5 : 0.95}
          {...depthBias(LAYER.runways)}
        />
      </mesh>
      {/* See-through and never hiding anything, so crossing lines simply overlap */}
      {surfaces.lines.map(group => (
        <mesh key={group.texture.uuid} geometry={group.geometry}>
          <meshLambertMaterial
            map={group.texture}
            transparent
            depthWrite={false}
            {...depthBias(LAYER.paint)}
          />
        </mesh>
      ))}
      <mesh geometry={surfaces.yellow}>
        <meshLambertMaterial color={YELLOW_PAINT} {...depthBias(LAYER.paint)} />
      </mesh>
      <mesh geometry={surfaces.white}>
        <meshLambertMaterial color={WHITE_PAINT} {...depthBias(LAYER.paint)} />
      </mesh>
      {AIRPORTS.map(airport => (
        <group key={airport.name}>
          {airport.runways.map(runway => (
            <RunwayNumbers key={runway.heading} runway={runway} y={airport.elevation + 0.14} />
          ))}
          {airport.buildings.map(building => (
            <BuildingModel
              key={`${building.x} ${building.z}`}
              building={building}
              base={airport.elevation}
            />
          ))}
          {airport.kind !== 'airstrip' &&
            airport.gates.map(stand => (
              <JetBridge
                key={`${stand.x} ${stand.z}`}
                stand={stand}
                base={airport.elevation}
                terminal={airport.buildings[0]}
              />
            ))}
          <Windsock airport={airport} />
        </group>
      ))}
    </>
  )
}
