import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import { CircleGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { game } from '../game/game'
import type { OtherAircraft } from '../game/traffic'
import { airlinerParts } from './Aircraft'
import { eye, VR_DETAIL_RANGE } from './eye'
import { mergeStill } from './merge'

const QUARTER_TURN = Math.PI / 2
const DARK = new MeshStandardMaterial({ color: '#1e2226', roughness: 0.6 })

/** Builds a complete airliner as one object, for aircraft the player does not fly. */
function buildAirliner(craft: OtherAircraft) {
  const { shape } = craft
  const { wing, radius } = shape
  const parts = airlinerParts(shape)
  const paint = new MeshStandardMaterial({ color: shape.paint, roughness: 0.4, metalness: 0.1 })
  const accent = new MeshStandardMaterial({ color: shape.accent, roughness: 0.45 })
  const aircraft = new Group()
  const add = (mesh: Mesh, parent: Group = aircraft) => {
    mesh.castShadow = true
    parent.add(mesh)
    return mesh
  }
  add(new Mesh(parts.fuselage.nose, parts.skin))
  add(new Mesh(parts.fuselage.body, parts.skin))

  parts.wings.forEach((geometry, side) => {
    const sign = side === 1 ? 1 : -1
    const panel = new Group()
    panel.position.y = wing.y
    panel.rotation.z = wing.dihedral * sign
    add(new Mesh(geometry, paint), panel)
    add(new Mesh(parts.flaps[side], paint), panel)
    aircraft.add(panel)
    for (const [x, z] of shape.engines) {
      const nacelle = add(
        new Mesh(
          new CylinderGeometry(
            shape.engineRadius * 0.7,
            shape.engineRadius,
            shape.engineLength,
            20,
            1,
            true
          ),
          paint
        )
      )
      nacelle.rotation.x = QUARTER_TURN
      nacelle.position.set(x * sign, shape.engineY, z + shape.engineLength / 2)
      const fan = add(new Mesh(new CircleGeometry(shape.engineRadius * 0.97, 20), DARK))
      fan.rotation.y = Math.PI
      fan.position.set(x * sign, shape.engineY, z + shape.engineLength * 0.12)
    }
  })

  const tailLift = radius * 0.75
  for (const geometry of parts.stabs) add(new Mesh(geometry, paint)).position.y = tailLift * 0.55
  add(new Mesh(parts.fin, accent)).position.y = radius * shape.tall * 0.7 + tailLift * 0.5

  // Legs and wheels, hidden once the aircraft has climbed away
  const gear = new Group()
  const tyre = craft.gearHeight * 0.17
  const legs = [
    [0, shape.noseZ + (shape.tailZ - shape.noseZ) * 0.13],
    [-radius * 1.9, 1.1],
    [radius * 1.9, 1.1]
  ]
  for (const [x, z] of legs) {
    const strut = add(
      new Mesh(new CylinderGeometry(tyre * 0.22, tyre * 0.22, craft.gearHeight, 8), DARK),
      gear
    )
    strut.position.set(x, -craft.gearHeight / 2, z)
    const wheels = add(new Mesh(new CylinderGeometry(tyre, tyre, tyre * 2, 14), DARK), gear)
    wheels.rotation.z = QUARTER_TURN
    wheels.position.set(x, -craft.gearHeight + tyre, z)
  }
  aircraft.add(gear)
  // The airframe and the gear each draw as one mesh per material
  const meshes = (root: Group) => {
    const found: Mesh[] = []
    root.traverse(object => {
      if (object instanceof Mesh) found.push(object)
    })
    return found
  }
  mergeStill(meshes(gear), gear)
  mergeStill(
    meshes(aircraft).filter(mesh => mesh.parent !== gear),
    aircraft
  )
  return { craft, aircraft, gear }
}

/** Draws the airliners that fly their own routes and the ones parked at the gates. */
export function TrafficAircraft() {
  const fleet = useMemo(
    () => [...game.traffic.flying, ...game.traffic.parked].map(buildAirliner),
    []
  )
  useFrame(() => {
    // In VR an airliner farther than this is a speck in the haze, not worth drawing twice
    const range = game.getState().vr ? VR_DETAIL_RANGE : Number.POSITIVE_INFINITY
    for (const { craft, aircraft, gear } of fleet) {
      aircraft.visible = craft.visible && craft.position.distanceTo(eye) < range
      aircraft.position.copy(craft.position)
      aircraft.quaternion.copy(craft.orientation)
      gear.visible = !craft.airborne
    }
  })
  return fleet.map(({ aircraft }) => <primitive key={aircraft.uuid} object={aircraft} />)
}
