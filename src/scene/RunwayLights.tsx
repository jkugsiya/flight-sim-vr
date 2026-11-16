import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import {
  type BufferAttribute,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  TorusGeometry,
  Vector2,
  Vector3
} from 'three'
import { game } from '../game/game'
import type { AircraftSpec } from '../sim/aircraft'
import {
  APPROACHES,
  type Approach,
  onCentreline,
  pathAltitude,
  RUNWAY_ENDS,
  type RunwayEnd
} from '../world/approaches'
import { AIRPORTS, fromStrip, heightAt } from '../world/island'
import { eye } from './eye'
import { type Light, lightMaterial, pointScale, pointsGeometry, type Rgb } from './lightPoints'

const WHITE: Rgb = [1, 0.96, 0.86]
const GREEN: Rgb = [0.35, 1, 0.45]
const RED: Rgb = [1, 0.18, 0.12]
const BLUE: Rgb = [0.3, 0.45, 1]
const DEGREES = 180 / Math.PI

/** Light standing on the ground, or a little above the sea on a pier. */
function lightAt(x: number, z: number, color: Rgb, lift = 0.8): Light {
  return { x, y: Math.max(heightAt(x, z), 0) + lift, z, color }
}

/** Fastest glide angle any approach to this runway end uses, or 3° without one. */
function glideOf(end: RunwayEnd) {
  return APPROACHES.find(approach => approach.end === end)?.glide ?? 3 / DEGREES
}

/**
 * Edge lights along every runway, a green bar across each threshold, and approach light rows:
 * 900 m long with a crossbar where an ILS serves the runway, 420 m for a GPS approach.
 */
function staticLights() {
  const lights: Light[] = []
  for (const end of RUNWAY_ENDS) {
    const { runway } = end
    const halfWidth = runway.width / 2
    // Edge lights: only from one end, so each runway gets one set
    if (end.sense === 1) {
      for (let along = -runway.length / 2; along <= runway.length / 2; along += 60) {
        for (const side of [-1, 1]) {
          const { x, z } = fromStrip(runway, along, side * (halfWidth + 2))
          lights.push(lightAt(x, z, WHITE, 0.5))
        }
      }
    }
    for (let across = -halfWidth; across <= halfWidth; across += 3) {
      const { x, z } = onCentreline(end, 1, across)
      lights.push(lightAt(x, z, GREEN, 0.4))
    }
    const kinds = APPROACHES.filter(approach => approach.end === end).map(approach => approach.kind)
    if (kinds.length === 0) continue
    const length = kinds.includes('ILS') ? 900 : 420
    for (let distance = 60; distance <= length; distance += 30) {
      const bar = distance === 300 ? 15 : 3
      for (let across = -bar; across <= bar; across += distance === 300 ? 2.5 : 1.5) {
        const { x, z } = onCentreline(end, distance, across)
        lights.push(lightAt(x, z, WHITE, 1.2))
      }
    }
  }
  return lights
}

/** `facingX` and `facingZ` point from the unit back along the approach toward arriving aircraft. */
/** Blue lights along both edges of every taxiway, lit only at night. */
function taxiLights() {
  const lights: Light[] = []
  for (const taxiway of AIRPORTS.flatMap(airport => airport.taxiways)) {
    for (let along = -taxiway.length / 2; along <= taxiway.length / 2; along += 40) {
      for (const side of [-1, 1]) {
        const { x, z } = fromStrip(taxiway, along, side * (taxiway.width / 2 + 1))
        lights.push(lightAt(x, z, BLUE, 0.4))
      }
    }
  }
  return lights
}

type Papi = { x: number; y: number; z: number; from: number; facingX: number; facingZ: number }
const DARK: Rgb = [0, 0, 0]

/**
 * Four glide path lights left of each touchdown zone. Each turns white when seen from above
 * its angle and red from below, so two of each means the approach is on the glide path.
 */
function papiUnits() {
  const units: Papi[] = []
  for (const end of RUNWAY_ENDS) {
    const glide = glideOf(end) * DEGREES
    for (let unit = 0; unit < 4; unit++) {
      const { x, z } = onCentreline(end, -300, -(end.runway.width / 2 + 15 + unit * 9))
      // The unit nearest the runway needs the highest angle to show white
      const course = end.heading / DEGREES
      units.push({
        ...lightAt(x, z, RED, 1),
        from: (glide + 0.5 - unit / 3) / DEGREES,
        facingX: -Math.sin(course),
        facingZ: Math.cos(course)
      })
    }
  }
  return units
}

const drawingSize = new Vector2()

/** Runway, approach, and glide path lights at every airport. */
export function RunwayLights() {
  const material = useMemo(() => lightMaterial(0.9), [])
  const nightMaterial = useMemo(() => lightMaterial(0.7, true), [])
  const fixed = useMemo(() => pointsGeometry(staticLights()), [])
  const taxi = useMemo(() => pointsGeometry(taxiLights()), [])
  const units = useMemo(papiUnits, [])
  const papi = useMemo(() => {
    const geometry = pointsGeometry(units.map(unit => ({ ...unit, color: RED })))
    ;(geometry.getAttribute('color') as BufferAttribute).setUsage(DynamicDrawUsage)
    return geometry
  }, [units])
  useFrame(({ gl, camera }) => {
    // In VR each eye draws its own view, so its height and lens set the size
    const view = gl.xr.isPresenting ? gl.xr.getCamera().cameras[0] : undefined
    if (view) pointScale.value = (view.viewport.w * view.projectionMatrix.elements[5]) / 2
    else {
      gl.getDrawingBufferSize(drawingSize)
      pointScale.value = (drawingSize.y * camera.projectionMatrix.elements[5]) / 2
    }
    const colors = papi.getAttribute('color') as BufferAttribute
    units.forEach((unit, i) => {
      const dx = eye.x - unit.x
      const dz = eye.z - unit.z
      // The lights shine only back along the approach
      const facing = dx * unit.facingX + dz * unit.facingZ > 0
      const angle = Math.atan2(eye.y - unit.y, Math.hypot(dx, dz))
      colors.setXYZ(i, ...(!facing ? DARK : angle > unit.from ? WHITE : RED))
    })
    colors.needsUpdate = true
  })
  return (
    <>
      <points geometry={fixed} material={material} frustumCulled={false} />
      <points geometry={papi} material={material} frustumCulled={false} />
      <points geometry={taxi} material={nightMaterial} frustumCulled={false} />
    </>
  )
}

// Rings along the selected approach, every this many metres
const RING_SPACING = 1000
const RING_COUNT = 20
// Rings closer than this to the camera, in metres, are hidden
const NEAR_RING = 260
const ringMatrix = new Matrix4()
const ringTurn = new Quaternion()
const ringScale = new Vector3()
const Y_AXIS = new Vector3(0, 1, 0)

/** Magenta rings down the glide path of the selected approach, to fly through. */
export function ApproachPath() {
  const mesh = useMemo(() => {
    const rings = new InstancedMesh(
      new TorusGeometry(1, 0.025, 4, 32),
      new MeshBasicMaterial({
        color: '#e06bf0',
        transparent: true,
        opacity: 0.55,
        depthWrite: false
      }),
      RING_COUNT
    )
    rings.frustumCulled = false
    rings.visible = false
    return rings
  }, [])
  const shown = useRef<{ approach: Approach | null; spec: AircraftSpec | null }>({
    approach: null,
    spec: null
  })
  const centres = useMemo(() => Array.from({ length: RING_COUNT }, () => new Vector3()), [])
  const hidden = useRef(-1)
  useFrame(() => {
    const { approach } = game.nav
    const spec = game.sim.spec
    if (approach !== shown.current.approach || spec !== shown.current.spec) {
      shown.current = { approach, spec }
      // No ring index matches this, so the rings are placed on this frame
      hidden.current = -2
      mesh.visible = approach !== null
      if (!approach) return
      const { end, glide } = approach
      for (let i = 0; i < RING_COUNT; i++) {
        const distance = (i + 1) * RING_SPACING
        const { x, z } = onCentreline(end, distance)
        centres[i].set(x, pathAltitude(end, glide, distance), z)
      }
    }
    if (!approach) return
    // A ring close to the camera would fill the view, so it hides while the aircraft passes
    let near = -1
    for (let i = 0; i < RING_COUNT; i++) {
      if (centres[i].distanceTo(eye) < NEAR_RING) near = i
    }
    if (near === hidden.current) return
    hidden.current = near
    // Rings are bigger for bigger aircraft, so the path stays flyable
    const radius = Math.max(20, game.sim.spec.wingSpan * 0.9)
    ringTurn.setFromAxisAngle(Y_AXIS, -approach.end.heading / DEGREES)
    for (let i = 0; i < RING_COUNT; i++) {
      ringScale.setScalar(i === near ? 0 : radius)
      mesh.setMatrixAt(i, ringMatrix.compose(centres[i], ringTurn, ringScale))
    }
    mesh.instanceMatrix.needsUpdate = true
  })
  return <primitive object={mesh} />
}
