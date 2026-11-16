import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import {
  Color,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  TorusGeometry,
  Vector3
} from 'three'
import { game } from '../game/game'
import type { Mission } from '../game/missions'

// Most gates any mission uses
const MAX_GATES = 16
const NEXT = new Color('#4be36f')
const LATER = new Color('#f2a93b')
const UP = new Vector3(0, 1, 0)
const matrix = new Matrix4()
const turn = new Quaternion()
const position = new Vector3()
const scale = new Vector3()

/** Rings for the active mission's next three gates: the next one green, the others amber. */
export function MissionGates() {
  const mesh = useMemo(() => {
    const rings = new InstancedMesh(
      new TorusGeometry(1, 0.06, 6, 40),
      new MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false }),
      MAX_GATES
    )
    rings.frustumCulled = false
    rings.visible = false
    return rings
  }, [])
  const shown = useRef<{ mission: Mission | null; gates: number }>({ mission: null, gates: -1 })
  useFrame(() => {
    const mission = game.getState().mission
    const gates = mission?.gates ?? []
    const passed = game.missions.gates
    if (shown.current.mission === mission && shown.current.gates === passed) return
    shown.current = { mission, gates: passed }
    mesh.visible = gates.length > 0
    for (let i = 0; i < MAX_GATES; i++) {
      const gate = gates[i]
      // Only the next few gates show, so the course reads clearly ahead
      if (!gate || i < passed || i > passed + 2) {
        mesh.setMatrixAt(i, matrix.makeScale(0, 0, 0))
        continue
      }
      turn.setFromAxisAngle(UP, -gate.heading)
      position.set(gate.x, gate.y, gate.z)
      mesh.setMatrixAt(i, matrix.compose(position, turn, scale.setScalar(gate.radius)))
      mesh.setColorAt(i, i === passed ? NEXT : LATER)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })
  return <primitive object={mesh} />
}
