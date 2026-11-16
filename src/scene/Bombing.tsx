import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  type Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3
} from 'three'
import { GUIDED_REACH, type Target } from '../game/bombs'
import { game, useGame } from '../game/game'
import { BLAST_REACH, SITE_COUNT } from '../game/ruins'
import { heightAt } from '../world/island'
import { depthBias } from './logDepth'

const QUARTER_TURN = Math.PI / 2
// The aiming cross keeps about this share of its distance from the camera as its size
const CROSS_SCALE = 0.02
// Most bombs drawn in the air at once, and missiles
const MAX_FALLING = 32
const MAX_MISSILES = 8
// Seconds a destroyed target takes to collapse
const COLLAPSE = 1.5
// The lock box keeps about this share of its distance from the camera as its size
const BOX_SCALE = 0.03
// Scorch marks drawn at once, oldest dropped first, and the grid that lays each on the ground
const MAX_SCORCH = 240
const SCORCH_GRID = 12

/** One target: what stands there, a painted bullseye, a marker beam, and a crater once hit. */
function TargetModel({ target, index }: { target: Target; index: number }) {
  const standing = useRef<Group>(null)
  const beam = useRef<Group>(null)
  const crater = useRef<Group>(null)
  // Seconds since the target was destroyed, for its collapse
  const down = useRef(-1)
  const y = heightAt(target.x, target.z)
  useFrame((_, delta) => {
    const destroyed = game.bombs.destroyed[index] ?? false
    down.current = destroyed ? Math.max(0, down.current) + delta : -1
    if (beam.current) beam.current.visible = !destroyed
    if (crater.current) crater.current.visible = destroyed
    const group = standing.current
    if (!group) return
    // It sinks and topples over a second and a half, faster as it goes
    const t = Math.min(1, Math.max(0, down.current) / COLLAPSE)
    const k = destroyed ? 1 - t * t : 1
    group.visible = k > 0.02
    group.scale.set(1, k, 1)
    group.rotation.z = (1 - k) * 0.35
  })
  const { radius, label } = target
  const tall = target.height ?? 0
  return (
    <group position={[target.x, y, target.z]}>
      {/* Bullseye rings painted around the target */}
      {[radius, radius * 0.55].map(ring => (
        <mesh key={ring} rotation-x={-QUARTER_TURN} position-y={0.3}>
          <ringGeometry args={[ring - 1.5, ring, 48]} />
          <meshBasicMaterial color="#f2efe6" side={DoubleSide} {...depthBias(0.001)} />
        </mesh>
      ))}
      <group ref={standing}>
        {label === 'radar' ? (
          <>
            <mesh castShadow position-y={6}>
              <cylinderGeometry args={[0.6, 0.9, 12, 8]} />
              <meshStandardMaterial color="#8a9096" />
            </mesh>
            <mesh castShadow position-y={13} rotation-x={-0.6}>
              <cylinderGeometry args={[6, 6, 0.6, 20]} />
              <meshStandardMaterial color="#d9dcdf" />
            </mesh>
          </>
        ) : tall > 0 ? (
          <>
            <mesh castShadow position-y={tall / 2}>
              <boxGeometry args={[radius * 1.2, tall, radius * 1.2]} />
              <meshStandardMaterial color="#6f7378" roughness={0.8} />
            </mesh>
            {/* Dark bands where the floors of the tower meet */}
            {Array.from({ length: Math.floor(tall / 12) }, (_, floor) => (floor + 1) * 12).map(
              y => (
                <mesh key={y} position-y={y}>
                  <boxGeometry args={[radius * 1.22, 1.2, radius * 1.22]} />
                  <meshStandardMaterial color="#3c3f43" roughness={0.9} />
                </mesh>
              )
            )}
            <mesh position-y={tall + 8}>
              <cylinderGeometry args={[0.3, 0.5, 16, 6]} />
              <meshStandardMaterial color="#c43c2c" />
            </mesh>
          </>
        ) : label === 'fuel depot' ? (
          [-9, 0, 9].map(x => (
            <mesh key={x} castShadow position={[x, 4, 0]}>
              <cylinderGeometry args={[4, 4, 8, 16]} />
              <meshStandardMaterial color="#9c8f74" roughness={0.6} />
            </mesh>
          ))
        ) : (
          <mesh castShadow position-y={3}>
            <boxGeometry args={[radius * 0.5, 6, radius * 0.35]} />
            <meshStandardMaterial color="#77736b" roughness={0.9} />
          </mesh>
        )}
      </group>
      <group ref={beam}>
        {/* Orange marker beam, seen from far off and in the dark */}
        <mesh position-y={250}>
          <cylinderGeometry args={[5, 5, 500, 12, 1, true]} />
          <meshBasicMaterial
            color="#ff8a2a"
            transparent
            opacity={0.32}
            blending={AdditiveBlending}
            depthWrite={false}
            side={DoubleSide}
            toneMapped={false}
          />
        </mesh>
      </group>
      <group ref={crater} visible={false}>
        <mesh rotation-x={-QUARTER_TURN} position-y={0.35}>
          <circleGeometry args={[radius * 0.7, 32]} />
          <meshStandardMaterial color="#1d1a17" roughness={1} {...depthBias(0.0015)} />
        </mesh>
      </group>
    </group>
  )
}

/** Where a bomb released now would land: a cross in a ring, green when it will hit. */
function AimCross() {
  const cross = useRef<Group>(null)
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        color: '#ffffff',
        depthTest: false,
        transparent: true,
        opacity: 0.9,
        toneMapped: false
      }),
    []
  )
  useFrame(({ camera }) => {
    const { bombs } = game
    const group = cross.current
    if (!group) return
    // Only the bombsight shows the cross, so normal flying stays uncluttered
    group.visible = bombs.aiming && game.getState().bombsight
    if (!group.visible) return
    group.position.copy(bombs.aim).setY(bombs.aim.y + 1)
    group.scale.setScalar(Math.max(4, bombs.aim.distanceTo(camera.position) * CROSS_SCALE))
    const index = bombs.nearestStanding(bombs.aim.x, bombs.aim.z)
    const nearest = bombs.targets[index]
    const zone = bombs.guided ? GUIDED_REACH : (nearest?.radius ?? 0)
    // Green while a release now, or an armed one, puts the bomb on the target
    const onTarget =
      bombs.armed >= 0 ||
      (nearest !== undefined &&
        (Math.hypot(nearest.x - bombs.aim.x, nearest.z - bombs.aim.z) <= zone ||
          (!bombs.guided && bombs.linedUp(game.sim, index))))
    material.color.set(onTarget ? '#4be36f' : '#ffffff')
  })
  return (
    // Drawn over everything, so a hill or a cloud never hides it
    <group ref={cross} visible={false} renderOrder={10}>
      <mesh rotation-x={-QUARTER_TURN} material={material} renderOrder={10}>
        <ringGeometry args={[0.85, 1, 40]} />
      </mesh>
      {[0, QUARTER_TURN].map(turn => (
        <mesh key={turn} rotation={[-QUARTER_TURN, 0, turn]} material={material} renderOrder={10}>
          <planeGeometry args={[2.6, 0.08]} />
        </mesh>
      ))}
    </group>
  )
}

const matrix = new Matrix4()
const turn = new Quaternion()
const scale = new Vector3(1, 1, 1)
const DOWN = new Vector3(0, -1, 0)
const heading = new Vector3()

/** Bombs on their way down, nose first along their path. */
function FallingBombs() {
  const mesh = useMemo(() => {
    const bombs = new InstancedMesh(
      new CylinderGeometry(0.18, 0.28, 2.2, 10),
      new MeshStandardMaterial({ color: '#4d5257', roughness: 0.5 }),
      MAX_FALLING
    )
    bombs.frustumCulled = false
    bombs.count = 0
    return bombs
  }, [])
  useFrame(() => {
    const { falling } = game.bombs
    mesh.count = Math.min(falling.length, MAX_FALLING)
    for (let i = 0; i < mesh.count; i++) {
      const bomb = falling[i]
      // The cylinder's long axis points along the bomb's flight
      turn.setFromUnitVectors(DOWN, heading.copy(bomb.velocity).normalize().negate())
      mesh.setMatrixAt(i, matrix.compose(bomb.position, turn, scale))
    }
    mesh.instanceMatrix.needsUpdate = true
  })
  return <primitive object={mesh} />
}

/** Missiles in flight, nose first along their path. */
function Missiles() {
  const mesh = useMemo(() => {
    const missiles = new InstancedMesh(
      new CylinderGeometry(0.12, 0.14, 3, 8),
      new MeshStandardMaterial({ color: '#e8e9ea', roughness: 0.4 }),
      MAX_MISSILES
    )
    missiles.frustumCulled = false
    missiles.count = 0
    return missiles
  }, [])
  useEffect(() => () => mesh.geometry.dispose(), [mesh])
  useFrame(() => {
    const { flying } = game.bombs
    mesh.count = Math.min(flying.length, MAX_MISSILES)
    for (let i = 0; i < mesh.count; i++) {
      const missile = flying[i]
      turn.setFromUnitVectors(DOWN, heading.copy(missile.velocity).normalize().negate())
      mesh.setMatrixAt(i, matrix.compose(missile.position, turn, scale))
    }
    mesh.instanceMatrix.needsUpdate = true
  })
  return <primitive object={mesh} />
}

/**
 * A square box around every standing target while missiles are aboard: white when in view,
 * red on the one a missile fired now would hit. Drawn over everything, facing the camera.
 */
function LockBoxes({ targets }: { targets: Target[] }) {
  const boxes = useRef<(Group | null)[]>([])
  const materials = useMemo(
    () =>
      targets.map(
        () => new MeshBasicMaterial({ depthTest: false, transparent: true, toneMapped: false })
      ),
    [targets]
  )
  useFrame(({ camera }) => {
    const { bombs } = game
    const armed = bombs.missiles > 0 || bombs.flying.length > 0
    targets.forEach((target, i) => {
      const box = boxes.current[i]
      if (!box) return
      box.visible = armed && !bombs.destroyed[i]
      if (!box.visible) return
      const middle = heightAt(target.x, target.z) + (target.height ?? 8) / 2
      box.position.set(target.x, middle, target.z)
      box.quaternion.copy(camera.quaternion)
      box.scale.setScalar(
        Math.max(target.radius * 2.4, box.position.distanceTo(camera.position) * BOX_SCALE)
      )
      const locked = bombs.lock === i
      materials[i].color.set(locked ? '#ff3b30' : '#ffffff')
      materials[i].opacity = locked ? 1 : 0.7
    })
  })
  return (
    <>
      {targets.map((target, i) => (
        <group
          key={`${target.x} ${target.z}`}
          ref={box => {
            boxes.current[i] = box
          }}
          visible={false}
          renderOrder={10}
        >
          {/* Four bars make a square outline one unit across */}
          {[
            [0, 0.5, 1, 0.05],
            [0, -0.5, 1, 0.05],
            [0.5, 0, 0.05, 1],
            [-0.5, 0, 0.05, 1]
          ].map(([x, y, w, h]) => (
            <mesh key={`${x} ${y}`} position={[x, y, 0]} material={materials[i]} renderOrder={10}>
              <planeGeometry args={[w, h]} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  )
}

/** A pile of rubble on every building a bomb brought down. */
function Rubble() {
  const mesh = useMemo(() => {
    const piles = new InstancedMesh(
      new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      new MeshStandardMaterial({ roughness: 1, flatShading: true }),
      SITE_COUNT
    )
    piles.count = 0
    piles.frustumCulled = false
    piles.castShadow = true
    piles.receiveShadow = true
    return piles
  }, [])
  useEffect(() => () => mesh.geometry.dispose(), [mesh])
  const drawn = useRef({ generation: -1, count: 0 })
  useFrame(() => {
    const { ruins } = game.bombs
    if (drawn.current.generation !== ruins.generation) {
      drawn.current = { generation: ruins.generation, count: 0 }
      mesh.count = 0
    }
    const { fallen } = ruins
    if (drawn.current.count === fallen.length) return
    for (let i = drawn.current.count; i < fallen.length; i++) {
      const site = fallen[i]
      // A fixed pseudo-random pile per building, from its spot
      const seed = Math.abs(Math.sin(site.x * 12.9898 + site.z * 78.233) * 43758.5453) % 1
      const big = Math.max(site.width, site.depth) > 16
      const height = big ? 5 + seed * 9 : 1.2 + seed * 1.6
      position.set(site.x, heightAt(site.x, site.z) - 0.3, site.z)
      tilt.set((seed - 0.5) * 0.25, site.turn, (0.5 - seed) * 0.2)
      turn.setFromEuler(tilt)
      size.set(site.width * 0.95, height, site.depth * 0.95)
      mesh.setMatrixAt(i, matrix.compose(position, turn, size))
      mesh.setColorAt(i, shade.setHSL(0.06, 0.12, 0.06 + seed * 0.1))
    }
    mesh.count = fallen.length
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    drawn.current.count = fallen.length
  })
  return <primitive object={mesh} />
}

/**
 * Blackened ground around each blast on land. Each mark is a small grid that follows the
 * terrain, dark in the middle and fading at the edge.
 */
function Scorch() {
  const mesh = useMemo(() => {
    const side = SCORCH_GRID + 1
    const perMark = side * side
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(MAX_SCORCH * perMark * 3), 3)
    )
    geometry.setAttribute(
      'color',
      new BufferAttribute(new Float32Array(MAX_SCORCH * perMark * 4), 4)
    )
    const index: number[] = []
    for (let m = 0; m < MAX_SCORCH; m++) {
      for (let i = 0; i < SCORCH_GRID; i++) {
        for (let j = 0; j < SCORCH_GRID; j++) {
          const a = m * perMark + i * side + j
          index.push(a, a + side, a + 1, a + 1, a + side, a + side + 1)
        }
      }
    }
    geometry.setIndex(index)
    geometry.setDrawRange(0, 0)
    const marks = new Mesh(
      geometry,
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        ...depthBias(0.002)
      })
    )
    marks.frustumCulled = false
    return marks
  }, [])
  useEffect(() => () => mesh.geometry.dispose(), [mesh])
  const drawn = useRef({ generation: -1, count: 0 })
  useFrame(() => {
    const { ruins } = game.bombs
    if (drawn.current.generation !== ruins.generation) {
      drawn.current = { generation: ruins.generation, count: 0 }
      mesh.geometry.setDrawRange(0, 0)
    }
    const { craters } = ruins
    if (drawn.current.count === craters.length) return
    const positions = mesh.geometry.getAttribute('position') as BufferAttribute
    const colors = mesh.geometry.getAttribute('color') as BufferAttribute
    const side = SCORCH_GRID + 1
    const radius = BLAST_REACH * 0.8
    for (let c = drawn.current.count; c < craters.length; c++) {
      const { x, z } = craters[c]
      // Past the limit, the newest mark replaces the oldest
      const base = (c % MAX_SCORCH) * side * side
      for (let i = 0; i < side; i++) {
        for (let j = 0; j < side; j++) {
          const u = (i / SCORCH_GRID) * 2 - 1
          const v = (j / SCORCH_GRID) * 2 - 1
          const px = x + u * radius
          const pz = z + v * radius
          const k = base + i * side + j
          positions.setXYZ(k, px, Math.max(heightAt(px, pz), 0) + 0.3, pz)
          const edge = Math.min(1, Math.hypot(u, v))
          colors.setXYZW(k, 0.06, 0.05, 0.04, 0.85 * (1 - edge * edge))
        }
      }
    }
    positions.needsUpdate = true
    colors.needsUpdate = true
    const marks = Math.min(craters.length, MAX_SCORCH)
    mesh.geometry.setDrawRange(0, marks * SCORCH_GRID * SCORCH_GRID * 6)
    drawn.current.count = craters.length
  })
  return <primitive object={mesh} />
}

const position = new Vector3()
const size = new Vector3()
const tilt = new Euler()
const shade = new Color()

/** The bombing range's targets, the aiming cross, falling bombs, and what they left behind. */
export function Bombing() {
  const mission = useGame(state => state.mission)
  const targets = mission?.targets ?? []
  return (
    <>
      {targets.map((target, i) => (
        <TargetModel key={`${target.x} ${target.z}`} target={target} index={i} />
      ))}
      <AimCross />
      <FallingBombs />
      <Missiles />
      <LockBoxes targets={targets} />
      <Rubble />
      <Scorch />
    </>
  )
}
