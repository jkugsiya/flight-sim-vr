import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

// Only light brighter than this glows: the sun, lamps, fire, and glints off the sea
const THRESHOLD = 1
const STRENGTH = 0.45
const RADIUS = 0.55

/**
 * Soft glow around the brightest light in view. While mounted it draws the whole frame:
 * the scene into a high-range image, the glow over it, then the colours for the screen.
 */
export function Glow() {
  const gl = useThree(state => state.gl)
  const scene = useThree(state => state.scene)
  const camera = useThree(state => state.camera)
  const size = useThree(state => state.size)
  const composer = useMemo(() => {
    // Multisampled, so edges stay as smooth as without the glow
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 })
    const passes = new EffectComposer(gl, target)
    passes.addPass(new RenderPass(scene, camera))
    passes.addPass(new UnrealBloomPass(new Vector2(1, 1), STRENGTH, RADIUS, THRESHOLD))
    passes.addPass(new OutputPass())
    return passes
  }, [gl, scene, camera])
  useEffect(() => {
    composer.setPixelRatio(gl.getPixelRatio())
    composer.setSize(size.width, size.height)
  }, [composer, gl, size])
  useEffect(() => () => composer.dispose(), [composer])
  // A frame callback with a priority takes over drawing from the default renderer
  useFrame((_, delta) => composer.render(delta), 1)
  return null
}
