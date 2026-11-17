import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { type Group, type Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { game, useGame } from '../game/game'
import type { Rescue } from '../game/missions'
import { useDisposal } from './dispose'

// Where survivors stand on deck, along the boat's open stern, in the order they wait
const SEATS: [number, number][] = [
  [-0.5, 1.2],
  [0.5, 1.2],
  [-0.5, 2.3],
  [0.5, 2.3],
  [-0.5, 3.4],
  [0.5, 3.4]
]
// Where the winch hangs from, in the helicopter's body axes: above the right cabin door
const HOIST = new Vector3(1.3, 0.7, -1.4)
// Height of the boat's deck above the sea
const DECK = 0.9
const UP = new Vector3(0, 1, 0)
const top = new Vector3()
const bottom = new Vector3()
const span = new Vector3()
const turn = new Quaternion()

/**
 * A rescue mission's boat, swamped and listing, with its survivors on deck. While the winch
 * runs, a cable hangs from the helicopter and the next survivor rides it up.
 */
export function RescueBoat() {
  const rescue = useGame(state => state.mission?.rescue)
  return rescue ? <Boat key={`${rescue.x},${rescue.z}`} rescue={rescue} /> : null
}

function Boat({ rescue }: { rescue: Rescue }) {
  const paint = useMemo(
    () => ({
      hull: new MeshStandardMaterial({ color: '#e9e4d8', roughness: 0.6 }),
      stripe: new MeshStandardMaterial({ color: '#2a5d8f', roughness: 0.6 }),
      cabin: new MeshStandardMaterial({ color: '#c9c2b1', roughness: 0.7 }),
      vest: new MeshStandardMaterial({ color: '#ff6a12', roughness: 0.5 }),
      cable: new MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.4, metalness: 0.6 })
    }),
    []
  )
  useDisposal(paint)
  const people = useRef<(Mesh | null)[]>([])
  const cable = useRef<Mesh>(null)
  const rider = useRef<Group>(null)

  useFrame(() => {
    const { sim, missions } = game
    const { aboard, hoist } = missions
    // Survivors still waiting, less the one on the cable
    const waiting = rescue.survivors - aboard - (hoist > 0 ? 1 : 0)
    people.current.forEach((person, i) => {
      if (person) person.visible = i < waiting
    })
    const hoisting = hoist > 0 && aboard < rescue.survivors && !sim.crash
    if (cable.current) cable.current.visible = hoisting
    if (rider.current) rider.current.visible = hoisting
    if (!hoisting || !cable.current || !rider.current) return
    top.copy(HOIST).applyQuaternion(sim.orientation).add(sim.position)
    bottom.set(rescue.x, DECK, rescue.z)
    span.subVectors(top, bottom)
    const length = span.length()
    cable.current.position.copy(bottom).addScaledVector(span, 0.5)
    cable.current.quaternion.copy(turn.setFromUnitVectors(UP, span.normalize()))
    cable.current.scale.set(1, length, 1)
    rider.current.position.copy(bottom).lerp(top, hoist)
  })

  return (
    <group>
      {/* Swamped to the gunwales and listing to one side */}
      <group position={[rescue.x, 0, rescue.z]} rotation={[0.05, 0.6, 0.14]}>
        <mesh material={paint.hull} position={[0, 0.25, 0]} castShadow>
          <boxGeometry args={[3.2, 1.1, 9]} />
        </mesh>
        <mesh material={paint.hull} position={[0, 0.25, -5.2]} rotation-y={Math.PI / 4} castShadow>
          <boxGeometry args={[2.26, 1.1, 2.26]} />
        </mesh>
        <mesh material={paint.stripe} position={[0, 0.7, 0]}>
          <boxGeometry args={[3.26, 0.18, 9.05]} />
        </mesh>
        <mesh material={paint.cabin} position={[0, 1.6, -1]} castShadow>
          <boxGeometry args={[2.4, 1.6, 3]} />
        </mesh>
        {SEATS.map(([x, z], i) => (
          <mesh
            key={`${x},${z}`}
            ref={person => {
              people.current[i] = person
            }}
            material={paint.vest}
            position={[x, DECK + 0.45, z]}
            castShadow
          >
            <capsuleGeometry args={[0.25, 0.8, 4, 8]} />
          </mesh>
        ))}
      </group>
      <mesh ref={cable} material={paint.cable} visible={false}>
        <cylinderGeometry args={[0.03, 0.03, 1, 5]} />
      </mesh>
      <group ref={rider} visible={false}>
        <mesh material={paint.vest} position={[0, -0.7, 0]} castShadow>
          <capsuleGeometry args={[0.25, 0.8, 4, 8]} />
        </mesh>
      </group>
    </group>
  )
}
