import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Euler, type PerspectiveCamera, Quaternion, Vector3 } from 'three'
import { game } from '../game/game'
import { heightAt } from '../world/island'

// Metres per second the camera moves, and how many times faster with Shift held
const SPEED = 30
const FAST = 6
// Radians the view turns for each pixel the mouse drags
const TURN = 0.004
// Steepest look up or down, just short of straight, in radians
const MAX_PITCH = 1.55
// Narrowest and widest vertical field of view in degrees, and the zoom per wheel pixel
const MIN_FOV = 15
const MAX_FOV = 90
const ZOOM = 0.001
// Metres the camera keeps above the ground and the sea
const CLEARANCE = 1.5
const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'ShiftLeft',
  'ShiftRight'
])

const angles = new Euler(0, 0, 0, 'YXZ')
const step = new Vector3()

/**
 * The free camera of photo mode. On entry it takes over from wherever the flight's view
 * was and stops the render clock, so the sea, rain, and lights hold still. On exit it puts
 * the view back exactly and restarts the clock from that moment.
 */
export function PhotoCamera() {
  const camera = useThree(state => state.camera) as PerspectiveCamera
  const clock = useThree(state => state.clock)
  const canvas = useThree(state => state.gl.domElement)
  const photo = useRef({
    on: false,
    held: new Set<string>(),
    yaw: 0,
    pitch: 0,
    roll: 0,
    // The mouse position while dragging, or null
    drag: null as { x: number; y: number } | null,
    // performance.now() of the last frame, since the stopped clock gives no delta
    last: 0,
    saved: { position: new Vector3(), quaternion: new Quaternion(), up: new Vector3(), fov: 0 }
  })

  useEffect(() => {
    const p = photo.current
    const { saved } = p
    // Runs on every game state change, straight away, so not one frame slips past
    const sync = () => {
      const on = game.getState().photo
      if (on === p.on) return
      p.on = on
      p.held.clear()
      p.drag = null
      if (on) {
        saved.position.copy(camera.position)
        saved.quaternion.copy(camera.quaternion)
        saved.up.copy(camera.up)
        saved.fov = camera.fov
        angles.setFromQuaternion(camera.quaternion)
        p.yaw = angles.y
        p.pitch = angles.x
        p.roll = angles.z
        p.last = performance.now()
        clock.stop()
        canvas.style.cursor = 'grab'
        return
      }
      camera.position.copy(saved.position)
      camera.quaternion.copy(saved.quaternion)
      camera.up.copy(saved.up)
      camera.fov = saved.fov
      camera.updateProjectionMatrix()
      // Resume from now rather than restart, so the clock's time carries on without a jump
      clock.oldTime = performance.now()
      clock.running = true
      clock.autoStart = true
      canvas.style.cursor = ''
    }
    const keyDown = (event: KeyboardEvent) => {
      if (p.on && MOVE_KEYS.has(event.code)) p.held.add(event.code)
    }
    const keyUp = (event: KeyboardEvent) => p.held.delete(event.code)
    const blur = () => {
      p.held.clear()
      p.drag = null
    }
    const pointerDown = (event: PointerEvent) => {
      if (!p.on || event.button !== 0) return
      p.drag = { x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId)
      canvas.style.cursor = 'grabbing'
    }
    const pointerMove = (event: PointerEvent) => {
      const { drag } = p
      if (!drag) return
      p.yaw -= (event.clientX - drag.x) * TURN
      p.pitch -= (event.clientY - drag.y) * TURN
      p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p.pitch))
      drag.x = event.clientX
      drag.y = event.clientY
    }
    const pointerUp = () => {
      if (!p.drag) return
      p.drag = null
      canvas.style.cursor = 'grab'
    }
    const wheel = (event: WheelEvent) => {
      if (!p.on) return
      event.preventDefault()
      const fov = camera.fov * Math.exp(event.deltaY * ZOOM)
      camera.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, fov))
      camera.updateProjectionMatrix()
    }
    const unsubscribe = game.subscribe(sync)
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerup', pointerUp)
    canvas.addEventListener('pointercancel', pointerUp)
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      unsubscribe()
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', blur)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', pointerUp)
      canvas.removeEventListener('wheel', wheel)
    }
  }, [camera, clock, canvas])

  useFrame(() => {
    const p = photo.current
    if (!p.on) return
    const now = performance.now()
    const dt = Math.min((now - p.last) / 1000, 0.1)
    p.last = now
    camera.quaternion.setFromEuler(angles.set(p.pitch, p.yaw, p.roll))
    const { held } = p
    // Ahead and sideways follow the view, down and up stay level with the world
    step
      .set(axis(held, 'KeyD', 'KeyA'), 0, axis(held, 'KeyS', 'KeyW'))
      .applyQuaternion(camera.quaternion)
    step.y += axis(held, 'KeyE', 'KeyQ')
    if (step.lengthSq() === 0) return
    const fast = held.has('ShiftLeft') || held.has('ShiftRight') ? FAST : 1
    camera.position.addScaledVector(step.normalize(), SPEED * fast * dt)
    const floor = Math.max(heightAt(camera.position.x, camera.position.z), 0) + CLEARANCE
    if (camera.position.y < floor) camera.position.y = floor
  })
  return null
}

/** 1 while only `plus` is held, -1 while only `minus` is held, 0 otherwise. */
function axis(held: Set<string>, plus: string, minus: string) {
  return (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0)
}
