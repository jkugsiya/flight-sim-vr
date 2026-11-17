import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  type Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3
} from 'three'
import type { EnemyKind } from '../game/combat'
import { game, useGame } from '../game/game'
import { HANGAR } from '../sim/aircraft'
import { flyingWingGeometry } from './Aircraft'
import { eye, eyeQuaternion } from './eye'

// Lock boxes keep about this share of their distance from the camera as their size
const BOX_SCALE = 0.03
const MAX_MISSILES = 16
const QUARTER_TURN = Math.PI / 2

/** A flat triangle fan from (x, z) points, both sides drawn, for wings and fins. */
function plate(points: [number, number, number][]) {
  const geometry = new BufferGeometry()
  const corners: number[] = []
  for (let i = 1; i < points.length - 1; i++)
    corners.push(...points[0], ...points[i], ...points[i + 1])
  geometry.setAttribute('position', new Float32BufferAttribute(corners, 3))
  geometry.computeVertexNormals()
  return geometry
}

/**
 * A plain enemy airframe pointing along +Z: a fighter with a delta wing and twin red fins,
 * or a long swept-wing bomber with four engines.
 */
function EnemyModel({ kind }: { kind: EnemyKind }) {
  const parts = useMemo(() => {
    const fighter = kind === 'fighter'
    const length = fighter ? 15 : 44
    const radius = fighter ? 0.8 : 2.1
    const span = fighter ? 5 : 24
    const sweep = fighter ? 5 : 9
    const root = fighter ? 1 : 6
    return {
      fighter,
      length,
      radius,
      wing: plate([
        [0, 0, root],
        [span, 0, root - sweep],
        [span, 0, root - sweep - (fighter ? 1.2 : 3)],
        [0, 0, root - (fighter ? 7 : 9)],
        [-span, 0, root - sweep - (fighter ? 1.2 : 3)],
        [-span, 0, root - sweep]
      ]),
      fin: plate([
        [0, 0, -length / 2 + (fighter ? 4 : 7)],
        [0, fighter ? 3.2 : 9, -length / 2 + 0.5],
        [0, fighter ? 3.2 : 9, -length / 2 - 1.5],
        [0, 0, -length / 2]
      ]),
      tail: plate([
        [0, 0, -length / 2 + (fighter ? 3 : 5)],
        [fighter ? 2.8 : 8, 0, -length / 2 + 0.5],
        [fighter ? 2.8 : 8, 0, -length / 2 - 1],
        [-(fighter ? 2.8 : 8), 0, -length / 2 - 1],
        [-(fighter ? 2.8 : 8), 0, -length / 2 + 0.5]
      ])
    }
  }, [kind])
  useEffect(
    () => () => {
      parts.wing.dispose()
      parts.fin.dispose()
      parts.tail.dispose()
    },
    [parts]
  )
  const { fighter, length, radius } = parts
  const body = fighter ? '#3d4248' : '#5a5f55'
  return (
    <>
      <mesh rotation-x={QUARTER_TURN} castShadow>
        <cylinderGeometry args={[radius * 0.7, radius, length, 12]} />
        <meshStandardMaterial color={body} roughness={0.6} metalness={0.2} />
      </mesh>
      <mesh position-z={length / 2 + (fighter ? 1.6 : 3)} rotation-x={QUARTER_TURN}>
        <coneGeometry args={[radius * 0.7, fighter ? 3.2 : 6, 12]} />
        <meshStandardMaterial color={body} roughness={0.6} metalness={0.2} />
      </mesh>
      <mesh geometry={parts.wing} castShadow position-y={fighter ? -0.2 : 0.4}>
        <meshStandardMaterial color={body} roughness={0.7} side={DoubleSide} />
      </mesh>
      <mesh geometry={parts.tail} position-y={fighter ? 0 : 0.8}>
        <meshStandardMaterial color={body} roughness={0.7} side={DoubleSide} />
      </mesh>
      {(fighter ? [-0.7, 0.7] : [0]).map(x => (
        <mesh key={x} geometry={parts.fin} position={[x, radius * 0.6, 0]}>
          <meshStandardMaterial color="#b3261e" roughness={0.6} side={DoubleSide} />
        </mesh>
      ))}
      {!fighter &&
        [-14, -7, 7, 14].map(x => (
          <mesh key={x} position={[x, -0.6, 2]} rotation-x={QUARTER_TURN}>
            <cylinderGeometry args={[0.9, 1, 5, 10]} />
            <meshStandardMaterial color="#3a3d38" roughness={0.6} />
          </mesh>
        ))}
    </>
  )
}

const ahead = new Vector3()
const B2 = HANGAR.find(spec => spec.id === 'b2')?.shape

/** The friendly B-2 on escort missions, its flying wing built like the player's. */
function Escort() {
  const group = useRef<Group>(null)
  const parts = useMemo(() => {
    if (B2?.type !== 'bomber') return null
    return {
      wing: [flyingWingGeometry(B2, 0, 26.2, -1), flyingWingGeometry(B2, 0, 26.2, 1)],
      skin: new MeshStandardMaterial({
        color: B2.paint,
        roughness: 0.75,
        metalness: 0.05,
        side: DoubleSide
      })
    }
  }, [])
  useEffect(
    () => () => {
      for (const geometry of parts?.wing ?? []) geometry.dispose()
      parts?.skin.dispose()
    },
    [parts]
  )
  useFrame(() => {
    const escort = game.combat.escort
    const model = group.current
    if (!model) return
    model.visible = escort !== null && (escort.alive || escort.falling)
    if (!escort || !model.visible) return
    model.position.copy(escort.position)
    model.lookAt(ahead.copy(escort.position).add(escort.velocity))
    model.rotateZ(escort.bank)
  })
  if (!parts) return null
  // The wing's nose points along -Z, and lookAt turns +Z to the flight path
  return (
    <group ref={group}>
      <group rotation-y={Math.PI}>
        {parts.wing.map(geometry => (
          <mesh key={geometry.uuid} geometry={geometry} material={parts.skin} castShadow />
        ))}
      </group>
    </group>
  )
}

/** Every enemy aircraft, turned along its flight path and banked into its turns. */
function Enemies({ kinds }: { kinds: EnemyKind[] }) {
  const groups = useRef<(Group | null)[]>([])
  useFrame(() => {
    const { enemies } = game.combat
    groups.current.forEach((group, i) => {
      const enemy = enemies[i]
      if (!group) return
      // Gone once the wreck has struck the ground or the sea
      group.visible = enemy !== undefined && (enemy.alive || enemy.falling)
      if (!enemy || !group.visible) return
      group.position.copy(enemy.position)
      group.lookAt(ahead.copy(enemy.position).add(enemy.velocity))
      group.rotateZ(enemy.bank)
    })
  })
  return (
    <>
      {kinds.map((kind, i) => (
        <group
          // biome-ignore lint/suspicious/noArrayIndexKey: one group per enemy, in spawn order
          key={i}
          ref={group => {
            groups.current[i] = group
          }}
        >
          <EnemyModel kind={kind} />
        </group>
      ))}
    </>
  )
}

/**
 * A square box around each live enemy: white in sight, red on the one the seeker holds. With
 * `escort`, one more green box marks the friendly bomber.
 */
function LockBoxes({ count, escort }: { count: number; escort: boolean }) {
  const boxes = useRef<(Group | null)[]>([])
  const materials = useMemo(
    () =>
      Array.from(
        { length: count + (escort ? 1 : 0) },
        () => new MeshBasicMaterial({ depthTest: false, transparent: true, toneMapped: false })
      ),
    [count, escort]
  )
  useEffect(
    () => () => {
      for (const material of materials) material.dispose()
    },
    [materials]
  )
  useFrame(() => {
    const { combat } = game
    combat.enemies.forEach((enemy, i) => {
      const box = boxes.current[i]
      if (!box) return
      box.visible = enemy.alive
      if (!enemy.alive) return
      box.position.copy(enemy.position)
      box.quaternion.copy(eyeQuaternion)
      box.scale.setScalar(
        Math.max(enemy.kind === 'bomber' ? 50 : 18, box.position.distanceTo(eye) * BOX_SCALE)
      )
      const locked = combat.lock === i
      materials[i].color.set(locked ? '#ff3b30' : '#ffffff')
      materials[i].opacity = locked ? 1 : 0.75
    })
    const friend = combat.escort
    const box = boxes.current[count]
    if (!escort || !box) return
    box.visible = friend?.alive === true
    if (!friend?.alive) return
    box.position.copy(friend.position)
    box.quaternion.copy(eyeQuaternion)
    box.scale.setScalar(Math.max(70, box.position.distanceTo(eye) * BOX_SCALE))
    // Green, turning amber once it has taken a hit
    materials[count].color.set(friend.hits > 0 ? '#ffb020' : '#34c759')
    materials[count].opacity = 0.85
  })
  return (
    <>
      {materials.map((material, i) => (
        <group
          // biome-ignore lint/suspicious/noArrayIndexKey: one box per enemy, in spawn order
          key={i}
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
            <mesh key={`${x} ${y}`} position={[x, y, 0]} material={material} renderOrder={10}>
              <planeGeometry args={[w, h]} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  )
}

const matrix = new Matrix4()
const turn = new Quaternion()
const size = new Vector3(1, 1, 1)
const DOWN = new Vector3(0, -1, 0)
const heading = new Vector3()

/** Missiles in flight on both sides, nose first along their path. */
function Missiles() {
  const mesh = useMemo(() => {
    const missiles = new InstancedMesh(
      new CylinderGeometry(0.1, 0.12, 3, 8),
      new MeshStandardMaterial({ color: '#d9dadb', roughness: 0.4 }),
      MAX_MISSILES
    )
    missiles.frustumCulled = false
    missiles.count = 0
    return missiles
  }, [])
  useEffect(() => () => mesh.geometry.dispose(), [mesh])
  useFrame(() => {
    const { missiles } = game.combat
    mesh.count = Math.min(missiles.length, MAX_MISSILES)
    for (let i = 0; i < mesh.count; i++) {
      const missile = missiles[i]
      turn.setFromUnitVectors(DOWN, heading.copy(missile.velocity).normalize().negate())
      mesh.setMatrixAt(i, matrix.compose(missile.position, turn, size))
    }
    mesh.instanceMatrix.needsUpdate = true
  })
  return <primitive object={mesh} />
}

/** Enemy aircraft in every wave, the escort, their boxes, and missiles, on air combat missions. */
export function AirCombat() {
  const mission = useGame(state => state.mission)
  // Waves join the fight in order, so their enemies follow the first ones
  const kinds = useMemo(
    () => [...(mission?.enemies ?? []), ...(mission?.waves?.flat() ?? [])].map(enemy => enemy.kind),
    [mission]
  )
  const escort = mission?.escort !== undefined
  if (kinds.length === 0) return null
  return (
    <>
      <Enemies kinds={kinds} />
      {escort && <Escort />}
      <LockBoxes count={kinds.length} escort={escort} />
      <Missiles />
    </>
  )
}
