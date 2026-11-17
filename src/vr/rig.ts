import { type Camera, Group, type PerspectiveCamera, Vector3, type WebGLRenderer } from 'three'
import { game } from '../game/game'
import { heightAt } from '../world/island'
import { CessnaCockpit } from './cessna'
import { Cockpit, type CockpitView } from './cockpit'
import type { Buzz } from './controls'
import { Feel, pulse } from './feel'
import { Gamepads } from './gamepad'
import { XRInput } from './input'
import { exitVR } from './session'
import { Tablet } from './tablet'

const UP = new Vector3(0, 1, 0)
const forward = new Vector3()
const head = new Vector3()
const other = new Vector3()
// Near plane in VR, close enough to see a hand on the stick
const VR_NEAR = 0.03
// Metres above the ground the view stays after a crash
const CRASH_HEIGHT = 3

/**
 * The pilot's seat in VR. The seat rides on the aircraft at its eye point and carries the
 * cockpit and the tablet. Inside it, the dolly holds the headset's tracking space, offset
 * so the pilot's head sits at the eye point facing forward.
 */
export class Rig {
  readonly seat = new Group()
  private readonly dolly = new Group()
  private readonly input: XRInput
  private readonly tablet: Tablet
  private readonly feel = new Feel()
  private readonly gamepads = new Gamepads()
  private cockpit: CockpitView | null = null
  private camera: PerspectiveCamera | null = null
  private recenterIn = 0
  private crashView = false
  private time = 0

  constructor(private readonly gl: WebGLRenderer) {
    this.seat.add(this.dolly)
    this.seat.visible = false
    this.input = new XRInput(gl, this.dolly)
    this.tablet = new Tablet({ recenter: () => this.recenter(), exit: exitVR })
    this.seat.add(this.tablet.group)
    gl.xr.addEventListener('sessionstart', this.start)
    gl.xr.addEventListener('sessionend', this.end)
  }

  /** The scene's camera, which the headset moves while presenting. */
  setCamera(camera: Camera) {
    this.camera = camera as PerspectiveCamera
  }

  private readonly start = () => {
    const camera = this.camera
    if (camera) {
      this.dolly.add(camera)
      camera.near = VR_NEAR
      camera.updateProjectionMatrix()
    }
    this.seat.visible = true
    // On the crash screen the seat stays put, so it starts where the aircraft came down
    this.placeOnAircraft()
    // The headset's pose arrives with the first frame drawn, so recenter just after it
    this.recenterIn = 2
    this.gl.xr.getSession()?.addEventListener('visibilitychange', this.visibility)
    // Holding the Meta button recenters the headset's own origin; the seat follows it
    this.gl.xr.getReferenceSpace()?.addEventListener('reset', this.reset)
    game.setVR(true)
  }

  private readonly reset = () => {
    this.recenterIn = 2
  }

  private readonly end = () => {
    // A bomb string started with the trigger must not run on in the desktop game
    game.endRelease()
    const camera = this.camera
    if (camera) {
      this.dolly.remove(camera)
      camera.near = 1
      camera.updateProjectionMatrix()
    }
    this.seat.visible = false
    this.cockpit?.dispose()
    this.cockpit = null
    resetAnalog(false)
    game.setVR(false)
  }

  /** The Quest's system menu covers the game, so the flight pauses under it. */
  private readonly visibility = (event: XRSessionEvent) => {
    if (event.session.visibilityState !== 'visible') game.pause()
  }

  /** Puts the pilot's head at the eye point, facing forward, wherever they sit in the room. */
  recenter() {
    const camera = this.camera
    if (!camera) return
    // The camera's own transform is the left eye's pose in the tracking space.
    // The head sits midway between the eyes.
    head.copy(camera.position)
    const [left, right] = this.gl.xr.getCamera().cameras
    if (left && right) {
      head.setFromMatrixPosition(left.matrix)
      head.add(other.setFromMatrixPosition(right.matrix)).multiplyScalar(0.5)
    }
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
    const yaw = Math.atan2(-forward.x, -forward.z)
    this.dolly.quaternion.setFromAxisAngle(UP, -yaw)
    this.dolly.position.copy(head).applyQuaternion(this.dolly.quaternion).multiplyScalar(-1)
    this.tablet.refresh()
  }

  /** Runs after the simulation step, before anything is drawn. */
  frame(dt: number) {
    if (!game.getState().vr) return
    const { sim } = game
    if (this.cockpit?.spec !== sim.spec) {
      this.cockpit?.dispose()
      // The Cessna has its own cockpit, true to the real one; the others share a generic one
      this.cockpit =
        sim.spec.id === 'c172' ? new CessnaCockpit(sim.spec, feel) : new Cockpit(sim.spec, feel)
      this.seat.add(this.cockpit.group)
      this.tablet.place(this.cockpit.tablet.position, this.cockpit.tablet.rotation)
      this.tablet.setChecklists(this.cockpit.checklists)
    }
    const cockpit = this.cockpit
    this.placeSeat()
    if (this.recenterIn > 0 && --this.recenterIn === 0) this.recenter()

    this.time += dt
    const interactors = this.input.update(dt)
    resetAnalog(true)
    cockpit.update(dt, interactors, this.time)
    this.gamepads.update(dt, this.input, cockpit.flightHeld, cockpit.throttleHeld)
    this.tablet.update(dt, interactors, this.time, it => cockpit.controls.heldBy(it) !== null)
    const controllers = interactors.filter(it => it.active && it.gamepad)
    const flying = cockpit.flyingHand
    this.feel.update(dt, controllers, flying?.gamepad ? flying : null)
  }

  /**
   * Moves the seat with the aircraft. After a crash the view stops where it was, level and
   * a little above the ground, and the cockpit around it goes, so the wreck can be seen.
   */
  private placeSeat() {
    const { wreck } = game
    const cockpit = this.cockpit
    if (wreck.active) {
      if (!this.crashView) {
        this.crashView = true
        forward.set(0, 0, -1).applyQuaternion(this.seat.quaternion)
        this.seat.quaternion.setFromAxisAngle(UP, Math.atan2(-forward.x, -forward.z))
        const { x, z } = this.seat.position
        const floor = Math.max(heightAt(x, z), 0) + CRASH_HEIGHT
        this.seat.position.y = Math.max(this.seat.position.y, floor)
        if (cockpit) cockpit.group.visible = false
        cockpit?.controls.releaseAll()
      }
    } else {
      this.crashView = false
      if (cockpit) cockpit.group.visible = true
      this.placeOnAircraft()
    }
    // The camera and hands inherit this before anything reads where the eye is
    this.seat.updateMatrixWorld(true)
  }

  private placeOnAircraft() {
    const { sim } = game
    this.seat.position.copy(sim.spec.camera.eye).applyQuaternion(sim.orientation).add(sim.position)
    this.seat.quaternion.copy(sim.orientation)
  }
}

/**
 * What touching a control feels and sounds like: a controller vibrates, and switches,
 * notches, and presses click. Merely grabbing something is silent.
 */
const feel: Buzz = (it, strength, ms) => {
  pulse(it, strength, ms)
  if (strength >= 0.3) game.click(strength)
}

/** Clears the hands' hold on the controls. In VR there are no pedals, so the stick steers. */
function resetAnalog(noPedals: boolean) {
  Object.assign(game.pilot.analog, {
    stick: null,
    yaw: null,
    throttle: null,
    brake: 0,
    trim: 0,
    noPedals
  })
}

const rigs = new WeakMap<WebGLRenderer, Rig>()

/**
 * The one seat for a renderer. The headset's hands and controllers belong to the renderer
 * for its whole life, so the seat that holds them does too.
 */
export function rigFor(gl: WebGLRenderer) {
  let rig = rigs.get(gl)
  if (!rig) {
    rig = new Rig(gl)
    rigs.set(gl, rig)
  }
  return rig
}
