import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { type PerspectiveCamera, Vector3 } from 'three'
import { game, useGame } from '../game/game'
import { heightAt } from '../world/island'

const FORWARD = new Vector3(0, 0, -1)
/** Vertical field of view in degrees from the pilot's seat. */
export const COCKPIT_FOV = 68
/** Pixels the view is shifted up so the horizon clears the instrument panel. */
export const horizonShift = (height: number) => Math.min(90, height * 0.11)
// The chase camera looks this many aircraft-distances past the nose,
// so the runway stays visible on approach
const CHASE_LOOK_AHEAD = 1.9
// Radians per second the camera circles a wreck or a bomb's blast
const ORBIT_RATE = 0.14
// Metres out from a bomb's blast, and up, that the camera circles it
const BLAST_ORBIT = 200
const BLAST_HEIGHT = 80
// The bombsight looks out from under the belly, in body axes, with a narrow view
const SIGHT_EYE = new Vector3(0, -2.5, 0.5)
const SIGHT_FOV = 40
const forward = new Vector3()
const target = new Vector3()
const goal = new Vector3()
const look = new Vector3()
const ahead = new Vector3()

/** Drives the camera: a smoothed chase view, the pilot's seat, or a slow circle around a wreck. */
export function CameraRig() {
  const mode = useGame(state => state.camera)
  const camera = useThree(state => state.camera) as PerspectiveCamera
  const size = useThree(state => state.size)
  const trail = useRef(new Vector3(0, 0, -1))
  const orbit = useRef({ angle: 0, started: false, focus: new Vector3() })
  const bombsight = useGame(state => state.bombsight)
  // Where the bombsight looks, eased so it swings smoothly between the cross and a blast
  const sight = useRef<Vector3 | null>(null)

  // Shifts the view up so the horizon sits in the middle of the area above the instrument panel
  useEffect(() => {
    const shift = horizonShift(size.height)
    camera.setViewOffset(size.width, size.height, 0, shift, size.width, size.height)
    return () => camera.clearViewOffset()
  }, [camera, size])

  useEffect(() => {
    camera.fov = bombsight ? SIGHT_FOV : mode === 'cockpit' ? COCKPIT_FOV : 58
    camera.updateProjectionMatrix()
  }, [camera, mode, bombsight])

  useFrame((_, delta) => {
    const { sim, wreck, effects, bombs } = game
    const view = sim.spec.camera
    const circle = orbit.current
    const blast = game.blastReplay

    if (wreck.active || blast) {
      sight.current = null
      const focus = blast ?? wreck.pieces[0].position
      if (!circle.started) {
        // Start the circle from wherever the camera was at the moment of the crash or blast
        circle.started = true
        circle.angle = Math.atan2(camera.position.z - focus.z, camera.position.x - focus.x)
        circle.focus.copy(focus)
      }
      circle.angle += ORBIT_RATE * delta
      circle.focus.lerp(focus, 1 - Math.exp(-delta * 3))
      goal
        .set(Math.cos(circle.angle), 0, Math.sin(circle.angle))
        .multiplyScalar(blast ? BLAST_ORBIT : view.distance * 1.9)
      goal
        .add(circle.focus)
        .setY(Math.max(circle.focus.y, 0) + (blast ? BLAST_HEIGHT : view.height * 2.2))
      // A blast far from the aircraft needs a cut, not a long glide across the sky
      if (blast && camera.position.distanceTo(goal) > BLAST_ORBIT * 4) camera.position.copy(goal)
      camera.position.lerp(goal, 1 - Math.exp(-delta * 1.6))
      keepAboveGround(camera.position, 2.5)
      camera.up.set(0, 1, 0)
      camera.lookAt(target.copy(circle.focus).setY(circle.focus.y + 1.5))
    } else if (game.getState().bombsight) {
      circle.started = false
      camera.position.copy(SIGHT_EYE).applyQuaternion(sim.orientation).add(sim.position)
      // Ground track, flat
      ahead.set(sim.velocity.x, 0, sim.velocity.z)
      if (ahead.lengthSq() < 1) ahead.set(0, 0, -1).applyQuaternion(sim.orientation).setY(0)
      ahead.normalize()
      const wanted =
        bombs.sightPoint(sim) ??
        goal
          .copy(sim.position)
          .addScaledVector(ahead, 600)
          .setY(sim.position.y - 800)
      if (!sight.current) sight.current = wanted.clone()
      else sight.current.lerp(wanted, 1 - Math.exp(-delta * 4))
      // Pitch down to the sight point without rolling, so the track stays at the top
      look.copy(sight.current).sub(camera.position).normalize()
      const down = Math.max(0, -look.y)
      camera.up
        .set(0, 1, 0)
        .multiplyScalar(Math.sqrt(1 - down * down))
        .addScaledVector(ahead, down)
      camera.lookAt(sight.current)
    } else if (mode === 'cockpit') {
      sight.current = null
      circle.started = false
      camera.position.copy(view.eye).applyQuaternion(sim.orientation).add(sim.position)
      camera.quaternion.copy(sim.orientation)
    } else {
      sight.current = null
      circle.started = false
      // The camera swings behind the nose with a short lag.
      // It follows only part of the pitch, so it stays above the tail in a climb or flare.
      forward.copy(FORWARD).applyQuaternion(sim.orientation)
      forward.y *= 0.4
      trail.current.lerp(forward.normalize(), 1 - Math.exp(-delta * 4)).normalize()
      camera.position.copy(sim.position).addScaledVector(trail.current, -view.distance)
      camera.position.y += view.height
      keepAboveGround(camera.position, 1.2)
      target.copy(sim.position).addScaledVector(trail.current, view.distance * CHASE_LOOK_AHEAD)
      target.y += 1
      camera.up.set(0, 1, 0)
      camera.lookAt(target)
    }

    // The blast of a crash shakes the view
    const shake = effects.shake * 0.05
    if (shake > 0.0005) {
      camera.rotateX((Math.random() - 0.5) * shake)
      camera.rotateZ((Math.random() - 0.5) * shake)
    }
  })
  return null
}

function keepAboveGround(position: Vector3, clearance: number) {
  const floor = Math.max(heightAt(position.x, position.z), 0) + clearance
  if (position.y < floor) position.y = floor
}
