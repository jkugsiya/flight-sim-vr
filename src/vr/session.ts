import type { WebGLRenderer } from 'three'
import { game } from '../game/game'

let renderer: WebGLRenderer | null = null

/** Lets the Enter VR button reach the renderer inside the 3D scene. Returns an unbind function. */
export function bindRenderer(gl: WebGLRenderer) {
  renderer = gl
  return () => {
    if (renderer === gl) renderer = null
  }
}

/** True when this browser and headset can show the game in VR. */
export async function vrSupported() {
  if (!navigator.xr) return false
  try {
    return await navigator.xr.isSessionSupported('immersive-vr')
  } catch {
    return false
  }
}

/** Puts the game in the headset. Call it from a click: browsers start VR only from one. */
export async function enterVR() {
  if (!renderer || !navigator.xr) {
    throw new Error('VR is unavailable here: open the game in the Meta Quest Browser over HTTPS')
  }
  game.prepareSound()
  // Bare hands are optional: the game works with controllers alone
  const session = await navigator.xr.requestSession('immersive-vr', {
    optionalFeatures: ['hand-tracking']
  })
  // Seated: the tracking origin is where the head was when the session began
  renderer.xr.setReferenceSpaceType('local')
  await renderer.xr.setSession(session)
  // Full fixed foveation: sharp in the middle of each lens, cheaper toward the edges
  renderer.xr.setFoveation(1)
}

/** Takes the game out of the headset, back to the page. */
export function exitVR() {
  void renderer?.xr.getSession()?.end()
}
