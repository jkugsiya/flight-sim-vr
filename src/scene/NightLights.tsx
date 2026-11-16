import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { type BufferAttribute, DynamicDrawUsage, Object3D, type SpotLight, Vector3 } from 'three'
import { game, useGame } from '../game/game'
import type { AircraftSpec } from '../sim/aircraft'
import { fromStrip, heightAt } from '../world/island'
import { seededRandom } from '../world/noise'
import { CITY_PLANS, HOUSES, ROADS } from '../world/scenery'
import { nightUniform } from './atmosphere'
import { type Light, lightMaterial, pointsGeometry, type Rgb } from './lightPoints'

const SODIUM: Rgb = [1, 0.66, 0.3]
const WINDOW: Rgb = [1, 0.84, 0.58]
const RED: Rgb = [1, 0.15, 0.1]
const GREEN: Rgb = [0.25, 1, 0.4]
const WHITE: Rgb = [1, 1, 1]
const OFF: Rgb = [0, 0, 0]

/**
 * Street lights round every city block, lamps along the roads between towns,
 * and lit windows in about half the houses.
 */
function townLights() {
  const lights: Light[] = []
  for (const { city, blocks } of CITY_PLANS) {
    const y = city.elevation + 7
    for (const block of blocks) {
      // Lamps stand on the pavement just outside the block, every 40 m along its sides
      const halfLength = block.length / 2 + 5
      const halfWidth = block.width / 2 + 5
      for (let along = -halfLength; along <= halfLength; along += 40) {
        for (const side of [-1, 1]) {
          const spot = fromStrip(city, block.along + along, block.across + side * halfWidth)
          lights.push({ x: spot.x, y, z: spot.z, color: SODIUM })
        }
      }
    }
  }
  for (const road of ROADS) {
    for (let leg = 0; leg < road.length - 1; leg++) {
      const [fromX, fromZ] = road[leg]
      const [toX, toZ] = road[leg + 1]
      const steps = Math.ceil(Math.hypot(toX - fromX, toZ - fromZ) / 70)
      for (let step = 0; step < steps; step++) {
        const x = fromX + ((toX - fromX) * step) / steps
        const z = fromZ + ((toZ - fromZ) * step) / steps
        lights.push({ x, y: Math.max(heightAt(x, z), 0) + 7, z, color: SODIUM })
      }
    }
  }
  const random = seededRandom(404)
  for (const house of HOUSES) {
    if (random() < 0.5) continue
    lights.push({ x: house.x, y: house.y + house.wallHeight * 0.5, z: house.z, color: WINDOW })
  }
  return lights
}

/** City, road, and house lights. They fade in at dusk and are hidden by day. */
export function TownLights() {
  const geometry = useMemo(() => pointsGeometry(townLights()), [])
  const material = useMemo(() => lightMaterial(1.1, true), [])
  useFrame(() => {
    material.visible = nightUniform.value > 0.01
  })
  return <points geometry={geometry} material={material} frustumCulled={false} />
}

/** Where an aircraft's lights sit, in its own axes: left tip, right tip, tail, and top. */
type LightLayout = { left: Vector3; right: Vector3; tail: Vector3; top: Vector3 }

function playerLayout(spec: AircraftSpec): LightLayout {
  const [left, right] = spec.wingtips
  const tailZ = Math.max(...spec.hullPoints.map(point => point.position.z))
  const topY = Math.max(...spec.hullPoints.map(point => point.position.y))
  return {
    left,
    right,
    tail: new Vector3(0, topY * 0.5, tailZ),
    top: new Vector3(0, topY, 0)
  }
}

// Lights per aircraft: two tips, the tail, two strobes, and the beacon
const PER_AIRCRAFT = 6
const spot = new Vector3()

/**
 * Navigation lights (red left, green right, white tail), flashing white strobes on the
 * wingtips, and a red beacon, on your aircraft and on the other traffic in flight.
 */
export function AircraftLights() {
  const spec = useGame(state => state.flown)
  const layout = useMemo(() => playerLayout(spec), [spec])
  const traffic = useMemo(
    () =>
      game.traffic.flying.map(craft => {
        const { shape } = craft
        const tipY = shape.wing.y + shape.wing.halfSpan * Math.sin(shape.wing.dihedral)
        const tipZ = shape.wing.tipZ + shape.wing.tipChord * 0.5
        return {
          craft,
          layout: {
            left: new Vector3(-shape.wing.halfSpan, tipY, tipZ),
            right: new Vector3(shape.wing.halfSpan, tipY, tipZ),
            tail: new Vector3(0, shape.radius * 0.6, shape.tailZ),
            top: new Vector3(0, shape.radius * shape.tall, 0)
          }
        }
      }),
    []
  )
  const geometry = useMemo(() => {
    const count = (1 + traffic.length) * PER_AIRCRAFT
    const empty: Light[] = Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0, color: OFF }))
    const points = pointsGeometry(empty)
    ;(points.getAttribute('position') as BufferAttribute).setUsage(DynamicDrawUsage)
    ;(points.getAttribute('color') as BufferAttribute).setUsage(DynamicDrawUsage)
    return points
  }, [traffic])
  const material = useMemo(() => lightMaterial(0.8), [])

  useFrame(({ clock }) => {
    const positions = geometry.getAttribute('position') as BufferAttribute
    const colors = geometry.getAttribute('color') as BufferAttribute
    const t = clock.elapsedTime
    const { sim, wreck } = game
    const flying = game.getState().status !== 'menu' || sim.engineRunning
    const lightsFor = (
      slot: number,
      lights: LightLayout,
      origin: Vector3,
      turn: Object3D['quaternion'],
      on: boolean,
      offset: number
    ) => {
      const base = slot * PER_AIRCRAFT
      const set = (i: number, local: Vector3, color: Rgb) => {
        spot.copy(local).applyQuaternion(turn).add(origin)
        positions.setXYZ(base + i, spot.x, spot.y, spot.z)
        colors.setXYZ(base + i, ...(on ? color : OFF))
      }
      // Strobes double-flash every 1.2 s, the beacon once a second
      const phase = (t + offset) % 1.2
      const strobe = phase < 0.05 || (phase > 0.15 && phase < 0.2)
      const beacon = (t + offset) % 1 < 0.12
      set(0, lights.left, RED)
      set(1, lights.right, GREEN)
      set(2, lights.tail, WHITE)
      set(3, lights.left, strobe ? WHITE : OFF)
      set(4, lights.right, strobe ? WHITE : OFF)
      set(5, lights.top, beacon ? RED : OFF)
    }
    lightsFor(0, layout, sim.position, sim.orientation, flying && !wreck.active, 0)
    traffic.forEach(({ craft, layout: lights }, i) => {
      lightsFor(i + 1, lights, craft.position, craft.orientation, craft.visible, i * 0.37)
    })
    positions.needsUpdate = true
    colors.needsUpdate = true
  })
  return <points geometry={geometry} material={material} frustumCulled={false} />
}

const NOSE = new Vector3()
const AHEAD = new Vector3()

/**
 * A real landing light: a spotlight from the nose that lights the runway ahead.
 * It stays in the scene while off, so switching it never rebuilds the materials.
 */
export function LandingLight() {
  const spec = useGame(state => state.flown)
  const light = useRef<SpotLight>(null)
  const target = useMemo(() => new Object3D(), [])
  const noseZ = useMemo(() => Math.min(...spec.hullPoints.map(point => point.position.z)), [spec])
  useFrame(() => {
    const lamp = light.current
    if (!lamp) return
    const { sim, pilot, wreck } = game
    const on = pilot.landingLights && !wreck.active
    // Faint by day, strong at night
    lamp.intensity = on ? 40 + 560 * nightUniform.value : 0
    NOSE.set(0, -0.5, noseZ).applyQuaternion(sim.orientation).add(sim.position)
    // Aimed a little below the nose, so it reaches about 200 m down the runway
    AHEAD.set(0, -12, noseZ - 300)
      .applyQuaternion(sim.orientation)
      .add(sim.position)
    lamp.position.copy(NOSE)
    target.position.copy(AHEAD)
    target.updateMatrixWorld()
  })
  return (
    <>
      <primitive object={target} />
      <spotLight
        ref={light}
        target={target}
        color="#fff4dc"
        intensity={0}
        distance={1500}
        decay={1}
        angle={0.2}
        penumbra={0.6}
      />
    </>
  )
}
