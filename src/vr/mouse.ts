import {
  type Group,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3
} from 'three'
import { type Control, Knob, Stick, Yoke } from './controls'
import { type Interactor, interactor } from './input'

// Metres a held control moves per pixel the mouse is dragged
const DRAG = 0.0005
// Radians of view turn per pixel dragged over empty space
const LOOK = 0.004
// Radians of knob twist per unit of mouse wheel
const TWIST = 0.003
// How far in front of the surface the pointer's fingertip hovers, so it does not press
const HOVER = 0.05

const ndc = new Vector2()
const point = new Vector3()
const axis = new Vector3()
const look = new Quaternion()

/**
 * The mouse as a hand in the pilot seat view on the page. Hovering puts its fingertip just
 * in front of whatever is under the pointer, which shows the control's name; a click
 * pushes it onto the surface, which presses a button or grabs a lever. Dragging a grabbed
 * control moves it, the wheel turns a grabbed knob, and dragging over nothing looks round.
 */
export class MouseInput {
  readonly interactor: Interactor = { ...interactor(), kind: 'hand', pointing: true }
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2()
  private hovering = false
  private yaw = 0
  private pitch = -0.2
  private twist = 0
  private pressed = false
  private looking = false
  private dragged = new Vector2()
  private readonly grabbedAt = new Vector3()
  private targets: Object3D[] = []
  private detach: (() => void) | null = null

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly seat: Group
  ) {}

  /** Starts listening on the page's canvas. */
  attach(canvas: HTMLCanvasElement) {
    if (this.detach) return
    const move = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect()
      this.pointer.set(
        ((event.clientX - box.left) / box.width) * 2 - 1,
        -((event.clientY - box.top) / box.height) * 2 + 1
      )
      this.hovering = true
      if (this.looking) {
        this.yaw -= event.movementX * LOOK
        this.pitch = Math.max(-1.4, Math.min(1.3, this.pitch - event.movementY * LOOK))
      } else if (this.pressed) this.dragged.add(new Vector2(event.movementX, event.movementY))
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return
      canvas.setPointerCapture(event.pointerId)
      // A click on a control presses or grabs it; anywhere else, or a right drag, looks round
      const onControl = event.button === 0 && this.hit() !== null
      this.looking = !onControl
      this.pressed = onControl
      this.dragged.set(0, 0)
      this.twist = 0
    }
    const up = () => {
      this.pressed = false
      this.looking = false
    }
    const wheel = (event: WheelEvent) => {
      if (!this.pressed) return
      event.preventDefault()
      this.twist -= event.deltaY * TWIST
    }
    const leave = () => {
      this.hovering = false
    }
    const menu = (event: Event) => event.preventDefault()
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('contextmenu', menu)
    this.detach = () => {
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('contextmenu', menu)
      this.detach = null
    }
  }

  stop() {
    this.detach?.()
    this.pressed = false
    this.looking = false
    this.interactor.active = false
  }

  /** Looks straight ahead again. */
  lookAhead() {
    this.yaw = 0
    this.pitch = -0.2
  }

  /** Points the camera where the mouse has looked; the camera sits at the eye point. */
  aim() {
    this.camera.position.set(0, 0, 0)
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
  }

  /** The cockpit models the pointer can touch. */
  setTargets(targets: Object3D[]) {
    this.targets = targets
  }

  /** The cockpit point under the pointer, in the seat's axes, or null. */
  private hit() {
    if (!this.hovering) return null
    this.camera.updateMatrixWorld()
    ndc.copy(this.pointer)
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObjects(this.targets, true)[0]
    if (!hit) return null
    return this.seat.worldToLocal(point.copy(hit.point))
  }

  /** The mouse's hand for this frame. `held` is the control it holds, if any. */
  update(held: Control | null): Interactor[] {
    const it = this.interactor
    const wasGrabbing = it.grabbing
    it.grabStarted = false
    if (this.pressed && wasGrabbing) {
      // Dragging a held control: across the view moves it sideways; up the view moves it
      // up and forward, except a stick or yoke, which it pushes forward only
      const camera = this.camera
      const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
      const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
      const forward = new Vector3(0, 0, -1)
      const flight = held instanceof Stick || held instanceof Yoke
      it.grip
        .copy(this.grabbedAt)
        .addScaledVector(right, this.dragged.x * DRAG)
        .addScaledVector(forward, -this.dragged.y * DRAG)
      if (!flight) it.grip.addScaledVector(up, -this.dragged.y * DRAG)
      it.tip.copy(it.grip)
      // The wheel twists the hand about the knob's axis
      if (held) {
        if (held instanceof Knob && held.floor) axis.set(0, 1, 0)
        else axis.set(0, 0, 1).applyQuaternion(held.face)
        it.quaternion.copy(look.setFromAxisAngle(axis, this.twist))
      }
      return [it]
    }
    const at = this.hit()
    it.active = at !== null
    if (!at) {
      it.grabbing = false
      return [it]
    }
    if (this.pressed) {
      // The click: onto the surface, closing the hand
      it.tip.copy(at)
      it.grip.copy(at)
      this.grabbedAt.copy(at)
      it.quaternion.identity()
      it.grabStarted = !wasGrabbing
      it.grabbing = true
    } else {
      // Hovering: just in front of the surface, toward the eye
      it.grip.copy(at)
      it.tip.copy(at).addScaledVector(at.clone().normalize(), -HOVER)
      it.grabbing = false
    }
    it.tipVelocity.set(0, 0, 0)
    return [it]
  }
}
