import { Quaternion, Vector3 } from 'three'

/**
 * Where the viewer's eye is in the world, and which way it faces, refreshed each frame by the
 * camera rig. Read these instead of `camera.position`: in VR the camera sits inside the moving
 * cockpit, so its own position is relative to the seat, not the world.
 */
export const eye = new Vector3()
export const eyeQuaternion = new Quaternion()
