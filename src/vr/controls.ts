import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3
} from 'three'
import type { Interactor } from './input'

/** Vibrates a controller: strength 0 to 1, for `ms` milliseconds. Bare hands feel nothing. */
export type Buzz = (it: Interactor, strength: number, ms: number) => void

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))
const UP = new Vector3(0, 1, 0)
const v = new Vector3()

// Seconds back a released control rolls, to undo the drift of a hand opening
const ROLLBACK = 0.12
// Seconds between two presses of one button, so a shaky fingertip does not double-press
const PRESS_GAP = 0.3
const HOVER = 0x3a3a1a
const HELD = 0x2a6f2a

/**
 * Something in the cockpit a hand can grab or press. Positions are in cockpit axes, metres
 * from the pilot's eye point. Pressable controls sit on the panel face and face the pilot.
 */
export abstract class Control {
  grabbable = false
  pressable = false
  grabRadius = 0.06
  /** Centre of the press zone on the panel face, and its half width and height. */
  readonly pressAt = new Vector3()
  pressHalf = { x: 0.022, y: 0.018 }
  lastPress = -1
  /** Hands holding this control, with what each needs to remember. */
  readonly holders = new Map<Interactor, unknown>()
  private readonly glowing: MeshStandardMaterial[] = []
  private highlight = 0

  constructor(
    readonly group: Group,
    protected readonly buzz: Buzz
  ) {}

  abstract tooltip(): string

  /** A material that lights up while a hand hovers over or holds this control. */
  protected glowMaterial(color: number) {
    const material = new MeshStandardMaterial({ color, roughness: 0.6 })
    this.glowing.push(material)
    return material
  }

  setHighlight(level: 0 | 1 | 2) {
    if (level === this.highlight) return
    this.highlight = level
    for (const material of this.glowing) {
      material.emissive.setHex(level === 2 ? HELD : level === 1 ? HOVER : 0)
    }
  }

  grabPoint() {
    return this.pressAt
  }
  grabDistance(point: Vector3) {
    return point.distanceTo(this.grabPoint())
  }
  /** Where the hint label sits. */
  labelPoint() {
    return this.grabbable ? this.grabPoint() : this.pressAt
  }

  /**
   * Where a fingertip is: `in` the button, hovering in `front` of it, or `out`.
   * Once in, the zone grows a little, so a trembling finger does not press twice.
   */
  pressZone(point: Vector3, previous: 'in' | 'front' | 'out') {
    const c = this.pressAt
    const dx = Math.abs(point.x - c.x)
    const dy = Math.abs(point.y - c.y)
    const dz = point.z - c.z
    const grow = previous === 'in' ? 1.35 : 1
    const front = 0.03 + (previous === 'in' ? 0.012 : 0)
    const { x, y } = this.pressHalf
    if (dx < x * grow && dy < y * grow && dz < front && dz > -0.04) return 'in'
    if (dx < x * 1.7 && dy < y * 1.7 && dz >= front && dz < 0.18) return 'front'
    return 'out'
  }

  onGrab(_it: Interactor) {}
  onMove(_it: Interactor) {}
  onRelease(_it: Interactor) {}
  onPress(_it: Interactor) {}
  /** Called every frame with whether any fingertip is inside the button. */
  onPressHold(_dt: number, _pressed: boolean) {}
  /** The control's position, to roll back to after a release. Null if it needs none. */
  snapshot(): number[] | null {
    return null
  }
  restore(_state: number[]) {}
  /** Starts a fresh grab from the current hand position, after a pause in the grab. */
  rebase(it: Interactor) {
    this.onGrab(it)
  }
  /** Per frame: springs, and moving the model to match the aircraft. */
  update(_dt: number, _time: number) {}
}

/** A lit push button on the panel face. */
export class Button extends Control {
  private readonly cap: Mesh
  private readonly lamp: MeshBasicMaterial
  private flash = 0

  constructor(
    group: Group,
    buzz: Buzz,
    readonly label: string,
    at: Vector3,
    private readonly options: {
      /** What the lamp shows: off, on in green, or a warning in amber. */
      lit?: () => 'off' | 'on' | 'alert'
      press?: () => void
      /** For buttons that act while held, such as trim. */
      hold?: (pressed: boolean) => void
      state?: () => string
    }
  ) {
    super(group, buzz)
    this.pressable = true
    this.pressAt.copy(at).setZ(at.z + 0.012)
    const plate = new Mesh(new BoxGeometry(0.05, 0.034, 0.004), PLATE)
    plate.position.copy(at).setZ(at.z + 0.002)
    this.cap = new Mesh(new BoxGeometry(0.042, 0.026, 0.012), this.glowMaterial(0x2b3035))
    this.cap.position.copy(at).setZ(at.z + 0.008)
    this.lamp = new MeshBasicMaterial({ color: 0x0c1a10, toneMapped: false })
    const lamp = new Mesh(new PlaneGeometry(0.03, 0.005), this.lamp)
    lamp.position.set(0, 0.006, 0.0061)
    this.cap.add(lamp)
    group.add(plate, this.cap)
  }

  tooltip() {
    const state = this.options.state?.()
    return state ? `${this.label}: ${state}` : this.label
  }

  onPress(it: Interactor) {
    this.options.press?.()
    this.flash = 0.2
    this.buzz(it, 0.5, 25)
  }

  onPressHold(_dt: number, pressed: boolean) {
    this.options.hold?.(pressed)
    if (pressed && this.options.hold) this.flash = 0.05
  }

  update(dt: number) {
    this.flash = Math.max(0, this.flash - dt)
    const lit = this.options.lit?.() ?? 'off'
    this.cap.position.z = this.pressAt.z - 0.004 - (this.flash > 0 ? 0.004 : 0)
    this.lamp.color.setHex(
      this.flash > 0 ? 0xffffff : lit === 'on' ? 0x2bff5a : lit === 'alert' ? 0xffa21a : 0x0c1a10
    )
  }
}

/**
 * A lever whose knob slides from `start` (value 0) to `end` (value 1), on a shaft from
 * `pivot`. With detents it clicks into the nearest one on release; with `spring` it
 * returns to 0, like a hand brake.
 */
export class Lever extends Control {
  private readonly knob: Mesh
  private readonly shaft: Mesh
  private readonly axis: Vector3
  private readonly length2: number
  private readonly point = new Vector3()
  /** True while a hand moves it, so the aircraft does not drive it. */
  held = false
  /** Where the knob is, from 0 at `start` to 1 at `end`. */
  value: number
  private lastDetent = -1

  constructor(
    group: Group,
    buzz: Buzz,
    readonly label: string,
    private readonly start: Vector3,
    private readonly end: Vector3,
    private readonly pivot: Vector3,
    private readonly options: {
      get: () => number
      set: (value: number, released: boolean) => void
      detents?: number[]
      spring?: boolean
      knob?: { color: number; shape: 'box' | 'ball' | 'wheel' }
      state?: () => string
    }
  ) {
    super(group, buzz)
    this.grabbable = true
    this.grabRadius = 0.055
    this.axis = end.clone().sub(start)
    this.length2 = this.axis.lengthSq()
    this.value = options.get()
    const knob = options.knob ?? { color: 0x1a1a1a, shape: 'box' }
    const geometry =
      knob.shape === 'ball'
        ? new SphereGeometry(0.02, 14, 10)
        : knob.shape === 'wheel'
          ? new CylinderGeometry(0.018, 0.018, 0.012, 16).rotateZ(Math.PI / 2)
          : new BoxGeometry(0.05, 0.022, 0.03)
    this.knob = new Mesh(geometry, this.glowMaterial(knob.color))
    this.shaft = new Mesh(new CylinderGeometry(0.005, 0.005, 1, 8), SHAFT)
    group.add(this.knob, this.shaft)
  }

  tooltip() {
    const state = this.options.state?.()
    return state ? `${this.label}: ${state}` : this.label
  }

  grabPoint() {
    return this.point.copy(this.start).lerp(this.end, this.value)
  }

  snapshot() {
    return [this.value]
  }
  restore([value]: number[]) {
    this.value = value
    this.options.set(value, false)
  }

  onGrab(it: Interactor) {
    this.holders.set(it, { from: this.value, hand: it.grip.clone() })
    this.held = true
    this.buzz(it, 0.25, 15)
  }

  onMove(it: Interactor) {
    const hold = this.holders.get(it) as { from: number; hand: Vector3 } | undefined
    if (!hold) return
    const moved = v.copy(it.grip).sub(hold.hand).dot(this.axis) / this.length2
    this.value = clamp(hold.from + moved, 0, 1)
    this.options.set(this.value, false)
    // A click through each detent
    const { detents } = this.options
    if (detents) {
      const nearest = detents.reduce(
        (best, d, i) =>
          Math.abs(d - this.value) < Math.abs(detents[best] - this.value) ? i : best,
        0
      )
      if (Math.abs(detents[nearest] - this.value) < 0.04 && nearest !== this.lastDetent) {
        this.lastDetent = nearest
        this.buzz(it, 0.35, 18)
      }
    }
  }

  onRelease(it: Interactor) {
    this.holders.delete(it)
    this.held = this.holders.size > 0
    const { detents } = this.options
    if (detents) {
      this.value = detents.reduce((best, d) =>
        Math.abs(d - this.value) < Math.abs(best - this.value) ? d : best
      )
    }
    this.options.set(this.value, true)
  }

  update(dt: number) {
    if (!this.held) {
      if (this.options.spring) {
        this.value = Math.max(0, this.value - dt * 4)
        this.options.set(this.value, false)
      } else this.value = this.options.get()
    }
    const at = this.grabPoint()
    this.knob.position.copy(at)
    beam(this.shaft, this.pivot, at)
  }
}

/**
 * A joystick that tilts about `pivot`. Moving the hand forward and back pitches, left and
 * right rolls, up to full travel at `travel` metres. It springs back to centre when let go.
 */
export class Stick extends Control {
  pitch = 0
  roll = 0
  private readonly grip: Mesh
  private readonly shaft: Mesh
  private readonly top: Vector3
  private readonly point = new Vector3()

  constructor(
    group: Group,
    buzz: Buzz,
    private readonly pivot: Vector3,
    top: Vector3,
    private readonly travel: number
  ) {
    super(group, buzz)
    this.grabbable = true
    this.grabRadius = 0.075
    this.top = top.clone()
    this.grip = new Mesh(new CylinderGeometry(0.02, 0.024, 0.11, 14), this.glowMaterial(0x1c1e21))
    const trigger = new Mesh(new BoxGeometry(0.012, 0.02, 0.012), RED)
    trigger.position.set(0, 0.03, -0.024)
    this.grip.add(trigger)
    this.shaft = new Mesh(new CylinderGeometry(0.008, 0.012, 1, 10), SHAFT)
    const boot = new Mesh(new CylinderGeometry(0.03, 0.05, 0.05, 12), BOOT)
    boot.position.copy(pivot).setY(pivot.y + 0.02)
    group.add(this.grip, this.shaft, boot)
  }

  tooltip() {
    return 'STICK: tilt to pitch and roll'
  }

  grabPoint() {
    return this.point.set(this.roll, 0, this.pitch).multiplyScalar(this.travel).add(this.top)
  }

  snapshot() {
    return [this.pitch, this.roll]
  }
  restore([pitch, roll]: number[]) {
    this.pitch = pitch
    this.roll = roll
  }

  onGrab(it: Interactor) {
    this.holders.set(it, { pitch: this.pitch, roll: this.roll, hand: it.grip.clone() })
    this.buzz(it, 0.25, 15)
  }

  onRelease(it: Interactor) {
    this.holders.delete(it)
  }

  update(dt: number) {
    const moving = [...this.holders].filter(([it]) => !frozen.has(it))
    if (moving.length > 0) {
      let pitch = 0
      let roll = 0
      for (const [it, held] of moving) {
        const hold = held as { pitch: number; roll: number; hand: Vector3 }
        // Back toward the pilot raises the nose
        pitch += hold.pitch + (it.grip.z - hold.hand.z) / this.travel
        roll += hold.roll + (it.grip.x - hold.hand.x) / this.travel
      }
      const k = Math.min(1, dt * 25)
      this.pitch += (clamp(pitch / moving.length, -1, 1) - this.pitch) * k
      this.roll += (clamp(roll / moving.length, -1, 1) - this.roll) * k
    } else if (this.holders.size === 0) {
      // Centring springs
      const k = Math.min(1, dt * 6)
      this.pitch -= this.pitch * k
      this.roll -= this.roll * k
    }
    const top = this.grabPoint()
    this.grip.position.copy(top)
    this.grip.quaternion.setFromUnitVectors(UP, v.copy(top).sub(this.pivot).normalize())
    beam(this.shaft, this.pivot, top)
  }

  /** True while a hand holds the stick. */
  get held() {
    return this.holders.size > 0
  }
}

/**
 * A control wheel, after SkyHands. Turn it like a steering wheel to roll, push and pull it
 * to pitch. One hand or two; a hand gripping the hub twists it from the wrist.
 */
export class Yoke extends Control {
  angle = 0
  /** Metres, positive pulled toward the pilot. */
  pull = 0
  private readonly pitchGroup = new Group()
  private readonly rollGroup = new Group()
  private readonly maxAngle = (70 * Math.PI) / 180
  private readonly maxPull = 0.09

  constructor(
    group: Group,
    buzz: Buzz,
    private readonly hub: Vector3
  ) {
    super(group, buzz)
    this.grabbable = true
    this.grabRadius = 0.085
    this.pitchGroup.position.copy(hub)
    this.pitchGroup.add(this.rollGroup)
    group.add(this.pitchGroup)
    const material = this.glowMaterial(0x1c1c1e)
    const shaft = new Mesh(new CylinderGeometry(0.012, 0.012, 0.36, 12), SHAFT)
    shaft.rotation.x = Math.PI / 2
    shaft.position.z = -0.17
    const bar = new Mesh(new BoxGeometry(0.24, 0.035, 0.03), material)
    const centre = new Mesh(new BoxGeometry(0.07, 0.06, 0.035), material)
    centre.position.y = 0.01
    this.rollGroup.add(shaft, bar, centre)
    for (const side of [-1, 1]) {
      const horn = new Mesh(new CylinderGeometry(0.016, 0.018, 0.11, 12), material)
      horn.position.set(side * 0.13, 0.04, 0)
      horn.rotation.z = -side * 0.12
      const knob = new Mesh(new SphereGeometry(0.018, 12, 8), material)
      knob.position.set(side * 0.137, 0.095, 0)
      this.rollGroup.add(horn, knob)
    }
    const button = new Mesh(new BoxGeometry(0.012, 0.008, 0.01), RED)
    button.position.set(-0.13, 0.08, 0.016)
    this.rollGroup.add(button)
  }

  tooltip() {
    return 'YOKE: turn to roll, push or pull to pitch'
  }

  /** Normalised -1 to 1, back raises the nose. */
  get pitch() {
    return this.pull / this.maxPull
  }
  get roll() {
    return this.angle / this.maxAngle
  }
  get held() {
    return this.holders.size > 0
  }

  private handles() {
    return [-1, 1].map(side =>
      new Vector3(side * 0.13, 0.045, 0)
        .applyAxisAngle(new Vector3(0, 0, 1), -this.angle)
        .add(this.hub)
        .setZ(this.hub.z + this.pull)
    )
  }

  grabPoint() {
    return this.handles()[0]
  }
  grabDistance(point: Vector3) {
    const hubNow = v.copy(this.hub).setZ(this.hub.z + this.pull)
    return Math.min(...this.handles().map(h => h.distanceTo(point)), hubNow.distanceTo(point))
  }

  snapshot() {
    return [this.angle, this.pull]
  }
  restore([angle, pull]: number[]) {
    this.angle = angle
    this.pull = pull
  }

  private handAngle(point: Vector3) {
    return Math.atan2(point.y - this.hub.y, point.x - this.hub.x)
  }
  private wristTwist(quaternion: Quaternion) {
    const x = v.set(1, 0, 0).applyQuaternion(quaternion)
    return Math.atan2(x.y, x.x)
  }

  onGrab(it: Interactor) {
    const radius = Math.hypot(it.grip.x - this.hub.x, it.grip.y - this.hub.y)
    this.holders.set(it, {
      angle: this.angle,
      pull: this.pull,
      z: it.grip.z,
      hand: this.handAngle(it.grip),
      wrist: this.wristTwist(it.quaternion),
      // A hand on the hub has no lever arm, so the wrist's twist turns the wheel
      byWrist: radius < 0.05
    })
    this.buzz(it, 0.25, 15)
  }

  onRelease(it: Interactor) {
    this.holders.delete(it)
  }

  update(dt: number) {
    const moving = [...this.holders].filter(([it]) => !frozen.has(it))
    if (moving.length > 0) {
      let angle = 0
      let pull = 0
      for (const [it, held] of moving) {
        const hold = held as {
          angle: number
          pull: number
          z: number
          hand: number
          wrist: number
          byWrist: boolean
        }
        const turned = hold.byWrist
          ? -wrap(this.wristTwist(it.quaternion) - hold.wrist)
          : -wrap(this.handAngle(it.grip) - hold.hand)
        angle += hold.angle + turned
        pull += hold.pull + (it.grip.z - hold.z)
      }
      const k = Math.min(1, dt * 25)
      const n = moving.length
      this.angle += (clamp(angle / n, -this.maxAngle, this.maxAngle) - this.angle) * k
      this.pull += (clamp(pull / n, -this.maxPull, this.maxPull) - this.pull) * k
    } else if (this.holders.size === 0) {
      const k = Math.min(1, dt * 3.5)
      this.angle -= this.angle * k
      this.pull -= this.pull * k
    }
    this.pitchGroup.position.set(this.hub.x, this.hub.y, this.hub.z + this.pull)
    this.rollGroup.rotation.z = -this.angle
  }
}

/** Hands whose fingers are opening on a control: it ignores them until they close or let go. */
const frozen = new Set<Interactor>()

type Holding = { control: Control; history: { time: number; state: number[] }[] }

/**
 * Runs every control against the hands each frame: grabbing, pressing with a fingertip,
 * and the hover highlight with a label naming the control under the hand.
 */
export class ControlSet {
  readonly label: HintLabel
  private readonly holding = new Map<Interactor, Holding>()
  private readonly zones = new Map<Interactor, Map<Control, 'in' | 'front' | 'out'>>()

  constructor(
    readonly controls: Control[],
    group: Group
  ) {
    this.label = new HintLabel(group)
  }

  /** The control a hand holds, if any. */
  heldBy(it: Interactor) {
    return this.holding.get(it)?.control ?? null
  }

  update(dt: number, interactors: Interactor[], time: number) {
    for (const it of interactors) {
      const holding = this.holding.get(it)
      if (!it.active) {
        if (holding) this.release(it, holding)
        continue
      }
      if (it.grabStarted && !holding) this.grab(it, time)
      const held = this.holding.get(it)
      if (held) this.hold(it, held, time)
    }
    for (const control of this.controls) control.update(dt, time)
    this.press(dt, interactors, time)
    this.hover(interactors)
  }

  releaseAll() {
    for (const [it, holding] of this.holding) this.release(it, holding)
  }

  private grab(it: Interactor, time: number) {
    let best: Control | null = null
    let nearest = Number.POSITIVE_INFINITY
    for (const control of this.controls) {
      if (!control.grabbable) continue
      const d = control.grabDistance(it.grip)
      if (d < control.grabRadius && d < nearest) {
        best = control
        nearest = d
      }
    }
    // A pinch or a squeeze right on a button presses it
    let button: Control | null = null
    let closest = Number.POSITIVE_INFINITY
    if (it.pinching || it.kind === 'controller') {
      for (const control of this.controls) {
        if (!control.pressable || control.grabbable) continue
        const d = control.pressAt.distanceTo(it.grip)
        if (d < 0.032 && d < closest) {
          button = control
          closest = d
        }
      }
    }
    if (button && (!best || closest < nearest)) {
      if (time - button.lastPress > PRESS_GAP) {
        button.lastPress = time
        button.onPress(it)
      }
    } else if (best) {
      this.holding.set(it, { control: best, history: [] })
      frozen.delete(it)
      best.onGrab(it)
    }
  }

  /**
   * Holding a control. As fingers open, the hand drifts before tracking sees the release,
   * so the control freezes while they open, and rolls back to where it was just before.
   */
  private hold(it: Interactor, holding: Holding, time: number) {
    const { control, history } = holding
    const rollback = () => {
      const target = time - ROLLBACK
      let state = history[0]?.state ?? null
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].time <= target) {
          state = history[i].state
          break
        }
      }
      if (state) control.restore(state)
    }
    if (!it.grabbing) {
      if (!frozen.has(it)) rollback()
      this.release(it, holding)
      return
    }
    if (it.opening) {
      if (!frozen.has(it)) {
        rollback()
        frozen.add(it)
      }
      return
    }
    if (frozen.delete(it)) {
      control.rebase(it)
      history.length = 0
    }
    control.onMove(it)
    const state = control.snapshot()
    if (state) {
      history.push({ time, state })
      while (history.length > 2 && history[0].time < time - 0.5) history.shift()
    }
  }

  private release(it: Interactor, holding: Holding) {
    frozen.delete(it)
    holding.control.onRelease(it)
    this.holding.delete(it)
  }

  /** Pressing with a fingertip: it must come into the button from the front. */
  private press(dt: number, interactors: Interactor[], time: number) {
    for (const control of this.controls) {
      if (!control.pressable) continue
      let pressed = false
      for (const it of interactors) {
        let zones = this.zones.get(it)
        if (!zones) {
          zones = new Map()
          this.zones.set(it, zones)
        }
        const free = it.active && !this.holding.has(it) && !(it.pinching && !it.pointing)
        if (!free) {
          zones.delete(control)
          continue
        }
        const before = zones.get(control) ?? 'out'
        const zone = control.pressZone(it.tip, before)
        if (zone === 'in' && before !== 'in') {
          // A quick jab can skip the hover zone; a controller's tip is steady enough without it
          const jab = it.tipVelocity.z < -0.12
          const fromFront = before === 'front' || jab || it.kind === 'controller'
          if (fromFront && time - control.lastPress > PRESS_GAP) {
            control.lastPress = time
            control.onPress(it)
          }
        }
        if (zone === 'in') pressed = true
        zones.set(control, zone)
      }
      control.onPressHold(dt, pressed)
    }
  }

  private hover(interactors: Interactor[]) {
    const levels = new Map<Control, 0 | 1 | 2>()
    let shown: Control | null = null
    let score = Number.POSITIVE_INFINITY
    for (const it of interactors) {
      if (!it.active) continue
      const held = this.holding.get(it)?.control
      if (held) {
        levels.set(held, 2)
        shown = held
        score = -1
        continue
      }
      let best: Control | null = null
      let nearest = 1
      for (const control of this.controls) {
        let d = Number.POSITIVE_INFINITY
        if (control.grabbable) d = control.grabDistance(it.grip) / control.grabRadius
        if (control.pressable && control.pressZone(it.tip, 'out') !== 'out') {
          const c = control.pressAt
          d = Math.min(
            d,
            Math.hypot(
              (it.tip.x - c.x) / control.pressHalf.x,
              (it.tip.y - c.y) / control.pressHalf.y
            ) * 0.5
          )
        }
        if (d < nearest) {
          nearest = d
          best = control
        }
      }
      if (best && !levels.has(best)) levels.set(best, 1)
      if (best && nearest < score) {
        score = nearest
        shown = best
      }
    }
    for (const control of this.controls) control.setHighlight(levels.get(control) ?? 0)
    this.label.show(shown)
  }
}

/** A small floating label naming the control under the hand. */
class HintLabel {
  private readonly canvas = document.createElement('canvas')
  private readonly texture: CanvasTexture
  private readonly mesh: Mesh
  private text = ''

  constructor(group: Group) {
    this.canvas.width = 512
    this.canvas.height = 64
    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.mesh = new Mesh(
      new PlaneGeometry(0.16, 0.02),
      new MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false,
        depthTest: false
      })
    )
    this.mesh.renderOrder = 10
    this.mesh.visible = false
    group.add(this.mesh)
  }

  show(control: Control | null) {
    this.mesh.visible = control !== null
    if (!control) return
    const text = control.tooltip()
    if (text !== this.text) {
      this.text = text
      const ctx = this.canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, 512, 64)
      ctx.font = 'bold 34px system-ui, sans-serif'
      const width = Math.min(500, ctx.measureText(text).width + 28)
      ctx.fillStyle = 'rgba(12, 16, 20, 0.85)'
      ctx.beginPath()
      ctx.roundRect(256 - width / 2, 6, width, 52, 10)
      ctx.fill()
      ctx.fillStyle = '#f2f4f5'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, 256, 33, 480)
      this.texture.needsUpdate = true
    }
    this.mesh.position.copy(control.labelPoint()).add(v.set(0, 0.05, 0.03))
  }
}

/** Stretches a unit-height cylinder from `from` to `to`. */
function beam(mesh: Mesh, from: Vector3, to: Vector3) {
  const span = v.copy(to).sub(from)
  const length = span.length()
  mesh.position.copy(from).addScaledVector(span, 0.5)
  mesh.quaternion.setFromUnitVectors(UP, span.divideScalar(Math.max(length, 1e-6)))
  mesh.scale.set(1, length, 1)
}

const PLATE = new MeshStandardMaterial({ color: 0x0f1113, roughness: 0.9 })
const SHAFT = new MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.6 })
const BOOT = new MeshStandardMaterial({ color: 0x141414, roughness: 1 })
const RED = new MeshStandardMaterial({ color: 0xaa2020, roughness: 0.6 })

/** Materials shared by every cockpit, which outlive any one of them. */
export const SHARED_MATERIALS: Material[] = [PLATE, SHAFT, BOOT, RED]
