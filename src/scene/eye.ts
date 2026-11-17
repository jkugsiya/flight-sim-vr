import { Quaternion, Vector3 } from 'three'

/**
 * Where the viewer's eye is in the world, and which way it faces, refreshed each frame by the
 * camera rig. Read these instead of `camera.position`: in VR the camera sits inside the moving
 * cockpit, so its own position is relative to the seat, not the world.
 */
export const eye = new Vector3()
export const eyeQuaternion = new Quaternion()

/**
 * In VR, metres beyond which small things such as other aircraft and airport buildings are
 * left out. A 40 m airliner there covers about 4 headset pixels, faded by the haze, while
 * each object costs a draw for each eye.
 */
export const VR_DETAIL_RANGE = 12_000
