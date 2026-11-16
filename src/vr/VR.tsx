import { useFrame, useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { rigFor } from './rig'
import { bindRenderer } from './session'

/** The VR seat, cockpit, and hands. Mount inside the Canvas; it stays idle until VR starts. */
export function VR() {
  const gl = useThree(state => state.gl)
  const scene = useThree(state => state.scene)
  const camera = useThree(state => state.camera)
  const rig = rigFor(gl)
  useEffect(() => bindRenderer(gl), [gl])
  useEffect(() => rig.setCamera(camera), [rig, camera])
  useEffect(() => {
    scene.add(rig.seat)
    return () => {
      scene.remove(rig.seat)
    }
  }, [rig, scene])
  // After the simulation step (also -1, mounted earlier), before the camera rig and drawing
  useFrame((_, delta) => rig.frame(Math.min(delta, 0.1)), -1)
  return null
}
