import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type WebGLRenderer,
  type XRHandSpace,
  type XRTargetRaySpace
} from 'three'
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js'

/**
 * One hand or controller, in cockpit coordinates: metres from the pilot's eye point,
 * +X right, +Y up, -Z forward. Bare hands grab with a pinch or a fist; controllers grab
 * with the grip button. Either presses switches with the fingertip or the controller's tip.
 */
export type Interactor = {
  kind: 'hand' | 'controller'
  handedness: XRHandedness | 'none'
  active: boolean
  /** Index fingertip, or the tip of the controller, for pressing. */
  tip: Vector3
  /** Where the hand closes, for grabbing. */
  grip: Vector3
  quaternion: Quaternion
  grabbing: boolean
  /** True for the one frame a grab begins. */
  grabStarted: boolean
  pinching: boolean
  /** All fingers curled around a control. */
  fist: boolean
  /** Index finger out, others curled: pressing, not grabbing. */
  pointing: boolean
  /**
   * True while the fingers start to open on a held control. Hand tracking sees the release
   * a few frames late, so the control freezes here instead of following the hand away.
   */
  opening: boolean
  tipVelocity: Vector3
  /** The controller's buttons, sticks, and vibration, or null for a bare hand. */
  gamepad: Gamepad | null
  // Tracking state, private to this module
  lost: number
  minCurl: number
  minPinch: number
  anchor: Vector3 | null
  previousTip: Vector3
  seen: boolean
}

type Slot = {
  hand: XRHandSpace
  grip: Group
  source: XRInputSource | null
  interactor: Interactor
  controllerModel: Group
  tipFilter: OneEuro
  gripFilter: OneEuro
}

/**
 * The One Euro filter for a moving point: heavy smoothing while the point is nearly still,
 * which hides tracking jitter, and light smoothing while it moves fast, which avoids lag.
 */
class OneEuro {
  private readonly value = new Vector3()
  private readonly speed = new Vector3()
  private readonly step = new Vector3()

  reset(point: Vector3) {
    this.value.copy(point)
    this.speed.set(0, 0, 0)
  }

  filter(point: Vector3, dt: number, tuning: { minCutoff: number; beta: number }) {
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * Math.max(dt, 1e-3)))
    this.step.copy(point).sub(this.value).divideScalar(Math.max(dt, 1e-3))
    this.speed.lerp(this.step, alpha(1))
    const cutoff = tuning.minCutoff + tuning.beta * this.speed.length()
    return this.value.lerp(point, alpha(cutoff))
  }
}

const JOINTS = {
  wrist: 'wrist',
  thumbTip: 'thumb-tip',
  indexTip: 'index-finger-tip',
  indexBase: 'index-finger-phalanx-proximal',
  middleTip: 'middle-finger-tip',
  middleBase: 'middle-finger-phalanx-proximal',
  ringTip: 'ring-finger-tip'
} as const

// Fingertip-to-thumb distances in metres that start and end a pinch
const PINCH_ON = 0.02
const PINCH_OFF = 0.034
// Middle and ring fingertip-to-wrist over palm length: below GRIP_ON the hand wraps a
// control, above GRIP_OFF it has let go. The index finger may rest on a trigger, so a grip
// ignores it, except that a fully straight index means pointing, not grabbing.
const GRIP_ON = 1.3
const GRIP_OFF = 1.5
const INDEX_STRAIGHT = 1.65
// Seconds a hand may drop out of tracking before it counts as gone. A hand holding a
// control keeps its hold longer, as tracking often blinks when fingers hide behind a grip.
const LOST_SECONDS = 0.35
const LOST_HOLDING_SECONDS = 1.2
// Adaptive smoothing: steady at rest, quick when moving. Hands jitter more than controllers.
const HAND_FILTER = { minCutoff: 1.2, beta: 4 }
const CONTROLLER_FILTER = { minCutoff: 4, beta: 1 }
// Grip button values that start and end a grab, with a gap so a half squeeze does not chatter
const SQUEEZE_ON = 0.6
const SQUEEZE_OFF = 0.35
// Where the controller's pressing tip sits, in the grip's own axes
const CONTROLLER_TIP = new Vector3(0, -0.015, -0.075)

const v = new Vector3()
const w = new Vector3()
const q = new Quaternion()

function interactor(): Interactor {
  return {
    kind: 'hand',
    handedness: 'none',
    active: false,
    tip: new Vector3(),
    grip: new Vector3(),
    quaternion: new Quaternion(),
    grabbing: false,
    grabStarted: false,
    pinching: false,
    fist: false,
    pointing: false,
    opening: false,
    tipVelocity: new Vector3(),
    gamepad: null,
    lost: 0,
    minCurl: 9,
    minPinch: 9,
    anchor: null,
    previousTip: new Vector3(),
    seen: false
  }
}

/** A plain stand-in for a Touch controller, so nothing has to load from the internet. */
function controllerModel() {
  const model = new Group()
  const body = new Mesh(
    new CylinderGeometry(0.018, 0.022, 0.1, 12),
    new MeshLambertMaterial({ color: 0x333338 })
  )
  body.rotation.x = Math.PI / 2
  const ring = new Mesh(
    new TorusGeometry(0.035, 0.006, 6, 20),
    new MeshLambertMaterial({ color: 0x555560 })
  )
  ring.position.set(0, 0.02, -0.04)
  ring.rotation.x = 0.6
  const tip = new Mesh(
    new SphereGeometry(0.008, 10, 8),
    new MeshBasicMaterial({ color: 0x00e5ff, toneMapped: false })
  )
  tip.position.copy(CONTROLLER_TIP)
  model.add(body, ring, tip)
  model.visible = false
  return model
}

/**
 * Reads both hands or controllers each frame and reports them as interactors in the
 * cockpit. Hands and controllers can be swapped at any time; each slot follows whichever
 * the headset reports.
 */
export class XRInput {
  readonly interactors: Interactor[]
  private readonly slots: Slot[]

  /** `dolly` holds the headset's tracking space; the interactors come out in its parent's axes. */
  constructor(
    renderer: WebGLRenderer,
    private readonly dolly: Group
  ) {
    const hands = new XRHandModelFactory().setPath('/hands/')
    this.slots = [0, 1].map(index => {
      const hand = renderer.xr.getHand(index)
      const grip = renderer.xr.getControllerGrip(index)
      const controller: XRTargetRaySpace = renderer.xr.getController(index)
      dolly.add(hand, grip, controller)
      hand.add(hands.createHandModel(hand, 'mesh'))
      const model = controllerModel()
      grip.add(model)
      const slot: Slot = {
        hand,
        grip,
        source: null,
        interactor: interactor(),
        controllerModel: model,
        tipFilter: new OneEuro(),
        gripFilter: new OneEuro()
      }
      controller.addEventListener('connected', event => {
        const source = event.data
        slot.source = source
        slot.interactor.handedness = source.handedness
        slot.interactor.kind = source.hand ? 'hand' : 'controller'
        slot.interactor.gamepad = source.hand ? null : (source.gamepad ?? null)
        model.visible = !source.hand
      })
      controller.addEventListener('disconnected', () => {
        slot.source = null
        slot.interactor.active = false
        slot.interactor.grabbing = false
        slot.interactor.gamepad = null
        model.visible = false
      })
      return slot
    })
    this.interactors = this.slots.map(slot => slot.interactor)
  }

  /** The controller in the given hand, if one is held. */
  controller(handedness: XRHandedness) {
    return this.interactors.find(
      it => it.active && it.kind === 'controller' && it.handedness === handedness
    )
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 28)
    for (const slot of this.slots) {
      const it = slot.interactor
      it.grabStarted = false
      const source = slot.source
      if (!source) {
        it.active = false
        continue
      }
      const read = source.hand ? this.readHand(slot, dt) : this.readController(slot)
      if (!read) continue
      const filter = it.kind === 'hand' ? HAND_FILTER : CONTROLLER_FILTER
      if (!it.seen || !it.active) {
        it.tip.copy(read.tip)
        it.grip.copy(read.grip)
        slot.tipFilter.reset(read.tip)
        slot.gripFilter.reset(read.grip)
        it.previousTip.copy(read.tip)
        it.tipVelocity.set(0, 0, 0)
        it.seen = true
      } else {
        it.tip.copy(slot.tipFilter.filter(read.tip, dt, filter))
        it.grip.copy(slot.gripFilter.filter(read.grip, dt, filter))
      }
      it.quaternion.slerp(read.quaternion, it.active ? k : 1)
      v.copy(it.tip).sub(it.previousTip).divideScalar(Math.max(dt, 1e-3))
      it.tipVelocity.lerp(v, 0.5)
      it.previousTip.copy(it.tip)
      it.grabStarted = read.grabbing && !it.grabbing
      it.grabbing = read.grabbing
      it.active = true
    }
    return this.interactors
  }

  /** Tracking space to cockpit axes. */
  private toCockpit(point: Vector3) {
    return point.applyQuaternion(this.dolly.quaternion).add(this.dolly.position)
  }

  /** Pinch and fist detection from the hand's joints, after SkyHands. */
  private readHand(slot: Slot, dt: number) {
    const it = slot.interactor
    const j = slot.hand.joints
    const wrist = j[JOINTS.wrist]
    const indexTip = j[JOINTS.indexTip]
    const thumbTip = j[JOINTS.thumbTip]
    const middleTip = j[JOINTS.middleTip]
    const middleBase = j[JOINTS.middleBase]
    if (!wrist || !indexTip || !thumbTip || !middleTip || !middleBase || !indexTip.visible) {
      it.lost += dt
      // The hand keeps its last place meanwhile, so a held control stays put
      if (it.lost > (it.grabbing ? LOST_HOLDING_SECONDS : LOST_SECONDS)) {
        it.active = false
        it.grabbing = false
      }
      return null
    }
    it.lost = 0
    const pinch = indexTip.position.distanceTo(thumbTip.position)
    if (!it.pinching && pinch < PINCH_ON) it.pinching = true
    else if (it.pinching && pinch > PINCH_OFF) it.pinching = false
    // Curl as fingertip-to-wrist over palm length, which works for any hand size
    const palm = Math.max(0.05, middleBase.position.distanceTo(wrist.position))
    const ringTip = j[JOINTS.ringTip]
    const middleCurl = middleTip.position.distanceTo(wrist.position) / palm
    const ringCurl = ringTip ? ringTip.position.distanceTo(wrist.position) / palm : middleCurl
    const curl = (middleCurl + ringCurl) / 2
    const indexCurl = indexTip.position.distanceTo(wrist.position) / palm
    it.pointing = curl < GRIP_OFF && indexCurl > INDEX_STRAIGHT
    let fist = it.fist
    if (!fist && curl < GRIP_ON && indexCurl < INDEX_STRAIGHT) fist = true
    else if (fist && curl > GRIP_OFF) fist = false
    it.fist = fist
    const grabbing = it.pinching || fist
    // Letting go starts the moment the fingers begin to open
    const closed = curl
    if (grabbing && it.grabbing) {
      it.minCurl = Math.min(it.minCurl, closed)
      it.minPinch = Math.min(it.minPinch, pinch)
      const fistOpening = fist && closed > it.minCurl + 0.12
      const pinchOpening = it.pinching && !fist && pinch > it.minPinch + 0.009
      it.opening = fistOpening || pinchOpening
    } else {
      it.minCurl = closed
      it.minPinch = pinch
      it.opening = false
    }
    const tip = this.toCockpit(v.copy(indexTip.position)).clone()
    const pinchGrip = it.pinching && !fist
    // While holding, the grab point rides on the wrist, so curling fingers do not drag the control
    if (grabbing && !it.anchor) {
      const local = pinchGrip
        ? w.copy(indexTip.position).add(thumbTip.position).multiplyScalar(0.5)
        : w.copy(middleBase.position).lerp(wrist.position, 0.3)
      q.copy(wrist.quaternion).invert()
      it.anchor = local.sub(wrist.position).applyQuaternion(q).clone()
    } else if (!grabbing) it.anchor = null
    let grip: Vector3
    if (it.anchor) {
      grip = w.copy(it.anchor).applyQuaternion(wrist.quaternion).add(wrist.position)
    } else if (pinchGrip) {
      grip = w.copy(indexTip.position).add(thumbTip.position).multiplyScalar(0.5)
    } else grip = w.copy(middleBase.position).lerp(wrist.position, 0.3)
    return {
      tip,
      grip: this.toCockpit(grip).clone(),
      quaternion: q.copy(this.dolly.quaternion).multiply(wrist.quaternion).clone(),
      grabbing
    }
  }

  private readController(slot: Slot) {
    const it = slot.interactor
    const grip = slot.grip
    if (!grip.visible) {
      it.active = false
      return null
    }
    it.gamepad = slot.source?.gamepad ?? null
    const squeeze = it.gamepad?.buttons[1]?.value ?? 0
    const grabbing = it.grabbing ? squeeze > SQUEEZE_OFF : squeeze > SQUEEZE_ON
    // A controller lets go cleanly, so it needs no freeze while the grip relaxes
    it.opening = false
    it.pinching = false
    it.pointing = false
    const tip = this.toCockpit(
      v.copy(CONTROLLER_TIP).applyQuaternion(grip.quaternion).add(grip.position)
    ).clone()
    return {
      tip,
      grip: this.toCockpit(w.copy(grip.position)).clone(),
      quaternion: q.copy(this.dolly.quaternion).multiply(grip.quaternion).clone(),
      grabbing
    }
  }
}
