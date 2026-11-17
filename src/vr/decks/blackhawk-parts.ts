import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  Euler,
  Group,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { type Buzz, Control, Lever } from '../controls'
import { keepMaterials, type Panel } from '../deck'
import type { Interactor } from '../input'

/*
 * Parts of the Black Hawk cockpit the shared kit lacks: an airframe merged into a few
 * meshes, flush push-lights, the collective's grip, and the copilot's linked controls.
 */

const UP = new Vector3(0, 1, 0)
const ONE = new Vector3(1, 1, 1)
const span = new Vector3()
const turn = new Quaternion()

/** Interior paint and fittings. */
export const PAINT = {
  lining: new MeshStandardMaterial({ color: 0x6a7068, roughness: 0.9, emissive: 0x2c2f2b }),
  wall: new MeshStandardMaterial({ color: 0x4a5049, roughness: 0.9, emissive: 0x1c1f1b }),
  frame: new MeshStandardMaterial({ color: 0x23262a, roughness: 0.75, emissive: 0x08090a }),
  console: new MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.85, emissive: 0x0e1012 }),
  cushion: new MeshStandardMaterial({ color: 0x3b3f2c, roughness: 1, emissive: 0x0e0f0a }),
  armour: new MeshStandardMaterial({ color: 0x4a4d4f, roughness: 0.7, emissive: 0x141516 }),
  metal: new MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.5 }),
  grip: new MeshStandardMaterial({ color: 0x16181a, roughness: 0.8, emissive: 0x050505 }),
  key: new MeshStandardMaterial({ color: 0x34383c, roughness: 0.7, emissive: 0x0c0d0e }),
  yellow: new MeshStandardMaterial({ color: 0xd4a017, roughness: 0.6, emissive: 0x2a2005 }),
  tint: new MeshBasicMaterial({
    color: 0x5fa88a,
    transparent: true,
    opacity: 0.1,
    depthWrite: false
  })
}
keepMaterials(...Object.values(PAINT))

/** Static boxes merged into one mesh per material, so the airframe costs a few draw calls. */
export class Shell {
  private readonly parts = new Map<Material, BufferGeometry[]>()
  private readonly matrix = new Matrix4()

  /** A box `size` [w, h, d] centred at `at`, turned by `rotation` in radians. */
  box(
    size: [number, number, number],
    at: [number, number, number],
    material: Material,
    rotation: [number, number, number] = [0, 0, 0]
  ) {
    turn.setFromEuler(new Euler(...rotation))
    this.matrix.compose(new Vector3(...at), turn, ONE)
    this.put(new BoxGeometry(...size), material)
  }

  /** A box on a panel's face, `out` metres off it, in the panel's own axes. */
  boxOn(
    panel: Panel,
    u: number,
    v: number,
    out: number,
    size: [number, number, number],
    material: Material
  ) {
    this.matrix.compose(panel.at(u, v, out), panel.face, ONE)
    this.put(new BoxGeometry(...size), material)
  }

  /** A square-section bar from one point to another, such as a window post. */
  beam(from: Vector3, to: Vector3, thickness: number, material: Material) {
    span.copy(to).sub(from)
    const length = span.length()
    turn.setFromUnitVectors(UP, span.normalize())
    this.matrix.compose(from.clone().lerp(to, 0.5), turn, ONE)
    this.put(new BoxGeometry(thickness, length, thickness), material)
  }

  /** A sheet `width` wide across X at `x`, from one [y, z] edge to another. */
  sheet(
    x: number,
    width: number,
    from: [number, number],
    to: [number, number],
    thickness: number,
    material: Material
  ) {
    const dy = to[0] - from[0]
    const dz = to[1] - from[1]
    const length = Math.hypot(dy, dz)
    // Turn the box's height onto the edge-to-edge line, which lies in the YZ plane
    turn.setFromEuler(new Euler(Math.atan2(dz, dy), 0, 0))
    this.matrix.compose(new Vector3(x, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2), turn, ONE)
    this.put(new BoxGeometry(width, length, thickness), material)
  }

  private put(geometry: BufferGeometry, material: Material) {
    geometry.applyMatrix4(this.matrix)
    const list = this.parts.get(material) ?? []
    list.push(geometry)
    this.parts.set(material, list)
  }

  /** Merges everything into `group`. Call once, after the last part. */
  build(group: Group) {
    for (const [material, list] of this.parts) {
      const merged = mergeGeometries(list)
      for (const geometry of list) geometry.dispose()
      if (merged) group.add(new Mesh(merged, material))
    }
    this.parts.clear()
  }
}

const LAMP_OFF = 0x1b1c1d

/**
 * A flush push-light or warning capsule on a panel. Its legend prints on the panel's
 * placard over it, so it reads both lit and dark. Pressable only when it has `press`.
 */
export class Annunciator extends Control {
  private readonly lamp = new MeshBasicMaterial({ color: LAMP_OFF, toneMapped: false })

  constructor(
    group: Group,
    buzz: Buzz,
    readonly label: string,
    panel: Panel,
    u: number,
    v: number,
    size: { w: number; h: number },
    private readonly options: {
      lit: () => boolean
      /** Lamp colour when lit. */
      color: number
      press?: () => void
      state?: () => string
    }
  ) {
    super(group, buzz)
    this.pressable = options.press !== undefined
    this.pressHalf = { x: size.w / 2 + 0.003, y: size.h / 2 + 0.003 }
    const mount = this.mount(panel.at(u, v), panel.face)
    this.pressAt.copy(this.outFrom(panel.at(u, v), 0.004))
    const face = new Mesh(new PlaneGeometry(size.w, size.h), this.lamp)
    face.position.z = 0.0006
    const rim = new Mesh(new BoxGeometry(size.w + 0.005, size.h + 0.005, 0.003), PAINT.grip)
    rim.position.z = -0.0012
    mount.add(rim, face)
  }

  tooltip() {
    return `${this.label}: ${this.options.state?.() ?? (this.options.lit() ? 'ON' : 'OFF')}`
  }

  onPress(it: Interactor) {
    this.options.press?.()
    this.buzz(it, 0.5, 25)
  }

  update() {
    this.lamp.color.setHex(this.options.lit() ? this.options.color : LAMP_OFF)
  }
}

/** Stretches a unit-height cylinder from `from` to `to`. */
function stretch(mesh: Mesh, from: Vector3, to: Vector3) {
  span.copy(to).sub(from)
  const length = span.length()
  mesh.position.copy(from).addScaledVector(span, 0.5)
  mesh.quaternion.setFromUnitVectors(UP, span.divideScalar(Math.max(length, 1e-6)))
  mesh.scale.set(1, length, 1)
}

/** A collective's tube, twist grip, and switch box head, posed from its pivot to its head. */
export class CollectiveModel {
  private readonly tube = new Mesh(new CylinderGeometry(0.014, 0.016, 1, 10), PAINT.metal)
  private readonly grip = new Mesh(new CylinderGeometry(0.019, 0.019, 0.11, 14), PAINT.grip)
  private readonly head = new Mesh(new BoxGeometry(0.05, 0.065, 0.045), PAINT.grip)
  private readonly direction = new Vector3()

  constructor(group: Group) {
    // The head's switches: the searchlight hat and the engine trim beep switch
    const hat = new Mesh(new BoxGeometry(0.014, 0.014, 0.014), PAINT.key)
    hat.position.set(0.012, 0.02, 0.026)
    const beep = new Mesh(new BoxGeometry(0.01, 0.012, 0.012), PAINT.yellow)
    beep.position.set(-0.012, 0.015, 0.026)
    this.head.add(hat, beep)
    group.add(this.tube, this.grip, this.head)
  }

  /** Lays the collective from `pivot` at the back to the grip at `at`. */
  pose(pivot: Vector3, at: Vector3) {
    stretch(this.tube, pivot, at)
    this.direction.copy(at).sub(pivot).normalize()
    // The twist grip sits just behind the hand point, the switch box just ahead
    this.grip.position.copy(at).addScaledVector(this.direction, -0.075)
    this.grip.quaternion.setFromUnitVectors(UP, this.direction)
    this.head.position.copy(at).addScaledVector(this.direction, 0.04)
    this.head.quaternion.copy(this.grip.quaternion)
  }
}

/** The pilot's collective: a lever pivoting at the back, with a full collective head. */
export class Collective extends Lever {
  private readonly model: CollectiveModel

  constructor(
    group: Group,
    buzz: Buzz,
    start: Vector3,
    end: Vector3,
    private readonly root: Vector3,
    options: ConstructorParameters<typeof Lever>[6]
  ) {
    super(group, buzz, 'COLLECTIVE', start, end, root, options)
    this.model = new CollectiveModel(group)
  }

  update(dt: number) {
    super.update(dt)
    this.model.pose(this.root, this.grabPoint())
  }
}

/** A cyclic with no hand of its own: the copilot's, moving with the pilot's. */
export class CyclicModel {
  private readonly shaft = new Mesh(new CylinderGeometry(0.009, 0.013, 1, 10), PAINT.metal)
  private readonly grip = new Mesh(new CylinderGeometry(0.02, 0.024, 0.11, 14), PAINT.grip)
  private readonly at = new Vector3()

  constructor(
    group: Group,
    private readonly pivot: Vector3,
    private readonly top: Vector3,
    private readonly travel: number
  ) {
    const boot = new Mesh(new CylinderGeometry(0.03, 0.05, 0.05, 12), PAINT.grip)
    boot.position.copy(pivot).setY(pivot.y + 0.02)
    group.add(this.shaft, this.grip, boot)
  }

  /** Tilts it: pitch back toward the seat is positive, roll right is positive. */
  pose(pitch: number, roll: number) {
    this.at.set(roll, 0, pitch).multiplyScalar(this.travel).add(this.top)
    stretch(this.shaft, this.pivot, this.at)
    this.grip.position.copy(this.at)
    this.grip.quaternion.copy(this.shaft.quaternion)
  }
}

/** A pair of anti-torque pedals that slide with the yaw input. */
export class Pedals {
  private readonly left = new Group()
  private readonly right = new Group()

  constructor(
    group: Group,
    x: number,
    y: number,
    private readonly z: number
  ) {
    for (const [pedal, side] of [
      [this.left, -1],
      [this.right, 1]
    ] as const) {
      const pad = new Mesh(new BoxGeometry(0.075, 0.13, 0.018), PAINT.key)
      pad.rotation.x = -0.45
      const arm = new Mesh(new BoxGeometry(0.02, 0.12, 0.02), PAINT.metal)
      arm.position.set(0, -0.08, 0.04)
      arm.rotation.x = 0.5
      pedal.add(pad, arm)
      pedal.position.set(x + side * 0.12, y, z)
      group.add(pedal)
    }
    // The cross tube the pedals hang on
    const tube = new Mesh(new BoxGeometry(0.34, 0.025, 0.025), PAINT.metal)
    tube.position.set(x, y - 0.13, z + 0.08)
    group.add(tube)
  }

  /** Right pedal forward for a right yaw, from -1 to 1. */
  pose(yaw: number) {
    this.right.position.z = this.z - yaw * 0.05
    this.left.position.z = this.z + yaw * 0.05
  }
}
