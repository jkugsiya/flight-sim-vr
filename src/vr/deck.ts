import {
  BoxGeometry,
  CanvasTexture,
  Euler,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  type Texture,
  Vector3
} from 'three'
import { game } from '../game/game'
import type { AircraftSpec } from '../sim/aircraft'
import type { CockpitView } from './cockpit'
import {
  Button,
  type Buzz,
  type Control,
  ControlSet,
  Knob,
  type Lever,
  Rocker,
  SHARED_MATERIALS,
  type Stick,
  type Yoke
} from './controls'
import type { Interactor } from './input'
import type { Checklist } from './tablet'

/*
 * The kit every cockpit is built from. Coordinates are metres from the pilot's eye point:
 * +X right, +Y up, -Z forward. Panels are flat boards at any angle; things on a panel are
 * placed by `u` (metres right of its centre) and `v` (metres up from its centre), in the
 * panel's own axes, so a switch on the overhead or the pedestal is placed the same way as
 * one on the main panel.
 */

/** Shared cockpit materials. Interior surfaces glow a little, as daylight lights them. */
export const MATERIALS = {
  panel: new MeshStandardMaterial({ color: 0x2c3034, roughness: 0.85, emissive: 0x0c0d0e }),
  boeing: new MeshStandardMaterial({ color: 0x7d8790, roughness: 0.8, emissive: 0x33383d }),
  airbus: new MeshStandardMaterial({ color: 0x5e6a74, roughness: 0.8, emissive: 0x2e353b }),
  black: new MeshStandardMaterial({ color: 0x141516, roughness: 0.9, emissive: 0x050505 }),
  lining: new MeshStandardMaterial({ color: 0xa9a59b, roughness: 0.9, emissive: 0x58554e }),
  frame: new MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.7, emissive: 0x101214 }),
  seat: new MeshStandardMaterial({ color: 0x2e3440, roughness: 0.95, emissive: 0x0c0d10 }),
  floor: new MeshStandardMaterial({ color: 0x2a2c30, roughness: 1, emissive: 0x0a0a0b }),
  olive: new MeshStandardMaterial({ color: 0x3f4430, roughness: 0.85, emissive: 0x101208 }),
  grey: new MeshStandardMaterial({ color: 0x4c5258, roughness: 0.8, emissive: 0x121416 }),
  white: new MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.6, emissive: 0x3a3936 }),
  glass: new MeshBasicMaterial({
    color: 0x9fd8a8,
    transparent: true,
    opacity: 0.12,
    depthWrite: false
  })
}
const KEPT = new Set<Material>([...SHARED_MATERIALS, ...Object.values(MATERIALS)])

/** Placard pixels per metre: enough for 8 mm lettering to read at arm's length. */
const PLACARD_RESOLUTION = 2000

/**
 * A flat board in the cockpit: the main panel, the glareshield's autopilot panel, the
 * overhead, a side console, or the pedestal. It carries printed labels on its face.
 */
export class Panel {
  readonly face: Quaternion
  readonly labels: { text: string; u: number; v: number; size: number; color: string }[] = []

  constructor(
    readonly centre: Vector3,
    readonly width: number,
    readonly height: number,
    rotation: Euler
  ) {
    this.face = new Quaternion().setFromEuler(rotation)
  }

  /** The cockpit point at `u` right and `v` up of the centre, `out` metres off the face. */
  at(u: number, v: number, out = 0) {
    return new Vector3(u, v, out).applyQuaternion(this.face).add(this.centre)
  }

  /** Prints a label on the face, `size` metres tall. */
  label(text: string, u: number, v: number, size = 0.008, color = '#e8e8e2') {
    this.labels.push({ text, u, v, size, color })
  }
}

/** A flat display drawn from a canvas at its own rate. */
export class Display {
  readonly mesh: Mesh
  readonly ctx: CanvasRenderingContext2D
  private readonly texture: CanvasTexture
  private clock = Math.random()

  constructor(
    width: number,
    height: number,
    pixelsPerMetre: number,
    private readonly paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    private readonly hz: number
  ) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * pixelsPerMetre)
    canvas.height = Math.round(height * pixelsPerMetre)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The browser gave no 2D canvas, so the cockpit screens cannot draw')
    this.ctx = ctx
    this.texture = new CanvasTexture(canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = 4
    this.mesh = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false, transparent: true })
    )
  }

  /** Redraws when its turn comes round; screens start at random phases to spread the work. */
  update(dt: number) {
    this.clock += dt * this.hz
    if (this.clock < 1) return
    this.clock %= 1
    this.draw()
  }

  draw() {
    this.paint(this.ctx, this.ctx.canvas.width, this.ctx.canvas.height)
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
  }
}

type Updatable = { update: (dt: number) => void; dispose: () => void; group?: Group }

/** Builds a cockpit's model, panels, screens, instruments, and controls. */
export class Deck {
  readonly group = new Group()
  readonly controls: Control[] = []
  private readonly panels: Panel[] = []
  private readonly displays: Display[] = []
  private readonly instruments: Updatable[] = []
  private readonly textures: Texture[] = []

  constructor(readonly buzz: Buzz) {}

  /** A box `size` [w, h, d] centred at `at`, turned by `rotation` in radians. */
  box(
    size: [number, number, number],
    at: [number, number, number],
    material: Material,
    rotation: [number, number, number] = [0, 0, 0]
  ) {
    const mesh = new Mesh(new BoxGeometry(...size), material)
    mesh.position.set(...at)
    mesh.rotation.set(...rotation)
    this.group.add(mesh)
    return mesh
  }

  /** A square-section bar from one point to another, such as a window post. */
  beam(from: Vector3, to: Vector3, thickness: number, material: Material) {
    const span = to.clone().sub(from)
    const mesh = new Mesh(new BoxGeometry(thickness, span.length(), thickness), material)
    mesh.position.copy(from).addScaledVector(span, 0.5)
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), span.normalize())
    this.group.add(mesh)
    return mesh
  }

  /**
   * A panel board `width` by `height` at `centre`, facing along `rotation` from facing the
   * pilot. `depth` gives it a body behind the face, so nothing shows through.
   */
  panel(
    centre: [number, number, number],
    width: number,
    height: number,
    rotation: [number, number, number] = [0, 0, 0],
    material: Material = MATERIALS.panel,
    depth = 0.04
  ) {
    const panel = new Panel(new Vector3(...centre), width, height, new Euler(...rotation, 'YXZ'))
    const board = new Mesh(new BoxGeometry(width, height, depth), material)
    board.position.copy(panel.at(0, 0, -depth / 2))
    board.quaternion.copy(panel.face)
    this.group.add(board)
    this.panels.push(panel)
    return panel
  }

  /** A glass screen on a panel, drawn `hz` times a second. */
  screen(
    panel: Panel,
    u: number,
    v: number,
    width: number,
    height: number,
    paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    hz = 12,
    pixelsPerMetre = 2400
  ) {
    const display = new Display(width, height, pixelsPerMetre, paint, hz)
    display.mesh.position.copy(panel.at(u, v, 0.003))
    display.mesh.quaternion.copy(panel.face)
    // A dark bezel round it
    const bezel = new Mesh(new BoxGeometry(width + 0.016, height + 0.016, 0.006), MATERIALS.black)
    bezel.position.copy(panel.at(u, v, 0))
    bezel.quaternion.copy(panel.face)
    this.group.add(bezel, display.mesh)
    this.displays.push(display)
    display.draw()
    return display
  }

  /** A round instrument or anything else with a group, placed on a panel and updated. */
  instrument<T extends Updatable & { group: Group }>(panel: Panel, u: number, v: number, item: T) {
    item.group.position.copy(panel.at(u, v, 0.002))
    item.group.quaternion.copy(panel.face)
    this.group.add(item.group)
    this.instruments.push(item)
    return item
  }

  /** Something updated every frame that is not on a panel, such as a compass. */
  track<T extends Updatable>(item: T) {
    this.instruments.push(item)
    if (item.group) this.group.add(item.group)
    return item
  }

  /** Adds a control built elsewhere, such as a stick, yoke, or lever. */
  add<T extends Control>(control: T) {
    this.controls.push(control)
    return control
  }

  /** A lit push button on a panel, labelled above unless `labelled` is false. */
  button(
    panel: Panel,
    label: string,
    u: number,
    v: number,
    options: ConstructorParameters<typeof Button>[4],
    labelled = true
  ) {
    const button = new Button(this.group, this.buzz, label, panel.at(u, v), {
      ...options,
      face: panel.face
    })
    const h = options.size?.h ?? 0.026
    if (labelled) panel.label(label, u, v + h / 2 + 0.01)
    return this.add(button)
  }

  /** A toggle or rocker switch on a panel, labelled above. */
  rocker(
    panel: Panel,
    label: string,
    u: number,
    v: number,
    options: Omit<ConstructorParameters<typeof Rocker>[4], 'face'>
  ) {
    panel.label(label, u, v + 0.025)
    return this.add(
      new Rocker(this.group, this.buzz, label, panel.at(u, v), { ...options, face: panel.face })
    )
  }

  /** A knob on a panel you grab and twist, labelled above. */
  knob(
    panel: Panel,
    label: string,
    u: number,
    v: number,
    options: Omit<ConstructorParameters<typeof Knob>[4], 'face' | 'axis'>
  ) {
    panel.label(label, u, v + (options.radius ?? 0.011) + 0.01)
    return this.add(
      new Knob(this.group, this.buzz, label, panel.at(u, v), {
        ...options,
        axis: 'z',
        face: panel.face
      })
    )
  }

  /** A fixed face with one line of text, such as a radio, drawn once. */
  plate(
    panel: Panel,
    u: number,
    v: number,
    width: number,
    height: number,
    text: string,
    color = '#ff9a3a'
  ) {
    const display = new Display(
      width,
      height,
      2400,
      (ctx, w, h) => {
        ctx.fillStyle = '#0a0b0c'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = color
        ctx.font = `700 ${h * 0.5}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, w / 2, h / 2, w * 0.94)
      },
      0
    )
    display.draw()
    display.mesh.position.copy(panel.at(u, v, 0.002))
    display.mesh.quaternion.copy(panel.face)
    this.group.add(display.mesh)
    this.displays.push(display)
    return display
  }

  /** Prints every panel's labels into one transparent texture per panel. Call once, last. */
  finish() {
    for (const panel of this.panels) {
      if (panel.labels.length === 0) continue
      const canvas = document.createElement('canvas')
      canvas.width = Math.min(4096, Math.round(panel.width * PLACARD_RESOLUTION))
      canvas.height = Math.min(4096, Math.round(panel.height * PLACARD_RESOLUTION))
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      const sx = canvas.width / panel.width
      const sy = canvas.height / panel.height
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const label of panel.labels) {
        ctx.fillStyle = label.color
        ctx.font = `700 ${label.size * sy}px Arial Narrow, Roboto Condensed, system-ui, sans-serif`
        ctx.fillText(
          label.text,
          (label.u + panel.width / 2) * sx,
          (panel.height / 2 - label.v) * sy,
          panel.width * sx
        )
      }
      const texture = new CanvasTexture(canvas)
      texture.colorSpace = SRGBColorSpace
      texture.anisotropy = 4
      this.textures.push(texture)
      const placard = new Mesh(
        new PlaneGeometry(panel.width, panel.height),
        new MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false })
      )
      placard.position.copy(panel.at(0, 0, 0.0008))
      placard.quaternion.copy(panel.face)
      this.group.add(placard)
    }
    return new ControlSet(this.controls, this.group)
  }

  update(dt: number) {
    for (const display of this.displays) display.update(dt)
    for (const instrument of this.instruments) instrument.update(dt)
  }

  dispose() {
    for (const display of this.displays) display.dispose()
    for (const instrument of this.instruments) instrument.dispose()
    for (const texture of this.textures) texture.dispose()
    this.group.traverse(object => {
      if (!(object instanceof Mesh)) return
      object.geometry.dispose()
      const material = object.material as Material
      if (!KEPT.has(material)) {
        ;(material as MeshBasicMaterial).map?.dispose()
        material.dispose()
      }
    })
    this.group.removeFromParent()
  }
}

/**
 * A cockpit built from a Deck. Subclasses build their layout in the constructor, set
 * `flight`, `throttles`, and `brakes`, then call `finish`. This class feeds the pilot's
 * analog inputs from the hands each frame.
 */
export abstract class DeckCockpit implements CockpitView {
  readonly deck: Deck
  readonly group: Group
  controls!: ControlSet
  /** Where the tablet hangs, in cockpit axes. */
  tablet = { position: new Vector3(-0.46, -0.2, -0.24), rotation: new Euler(-0.2, 1.05, 0, 'YXZ') }
  checklists: Checklist[] | null = null
  /** The stick, sidestick, yoke, or cyclic. */
  protected flight: Stick | Yoke | null = null
  /** Throttle levers, or a helicopter's collective: any held one sets the throttle. */
  protected throttles: Lever[] = []
  /** Levers or handles that work the wheel brakes while held. */
  protected brakes: Lever[] = []
  /**
   * Share of the throttle levers' travel, at the back, that is reverse thrust: pulled past
   * idle into it, the engines reverse, harder the further back. 0 for no reverse range.
   */
  protected reverseRegion = 0

  /** Where the throttle levers sit for the current throttle and reverse, from 0 to 1. */
  protected leverPosition() {
    const c = game.pilot.controls
    const r = this.reverseRegion
    if (r === 0) return c.throttle
    return c.reverse ? r * (1 - c.throttle) : r + c.throttle * (1 - r)
  }

  constructor(
    readonly spec: AircraftSpec,
    buzz: Buzz
  ) {
    this.deck = new Deck(buzz)
    this.group = this.deck.group
  }

  /** Prints the labels and wires up the controls. Call at the end of the constructor. */
  protected finish() {
    this.controls = this.deck.finish()
  }

  get flyingHand() {
    if (!this.flight) return null
    const holder = this.flight.holders.keys().next()
    return holder.done ? null : holder.value
  }
  get flightHeld() {
    return this.flight?.held ?? false
  }
  get throttleHeld() {
    return this.throttles.some(lever => lever.held)
  }

  /** Per-frame work of the aircraft's own, after the controls and before the screens. */
  protected tick(_dt: number) {}

  update(dt: number, interactors: Interactor[], time: number) {
    this.controls.update(dt, interactors, time)
    const { analog } = game.pilot
    const flight = this.flight
    if (flight) {
      flight.follow ??= () => game.pilot.controls
      // Only a hand sends input: let go, the stick shows what the controls do
      if (flight.held) analog.stick = flight.output
    }
    const held = this.throttles.filter(lever => lever.held)
    if (held.length > 0) {
      const lever = held.reduce((sum, each) => sum + each.value, 0) / held.length
      const r = this.reverseRegion
      if (r > 0) game.pilot.controls.reverse = lever < r
      analog.throttle = r === 0 ? lever : lever < r ? 1 - lever / r : (lever - r) / (1 - r)
    }
    for (const brake of this.brakes) {
      if (brake.held) analog.brake = Math.max(analog.brake, brake.value)
    }
    this.tick(dt)
    this.deck.update(dt)
  }

  dispose() {
    this.controls.releaseAll()
    this.deck.dispose()
  }
}
