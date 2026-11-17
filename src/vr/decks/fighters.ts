import {
  BoxGeometry,
  Euler,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { game } from '../../game/game'
import type { AircraftSpec } from '../../sim/aircraft'
import { LAMPS } from '../../ui/lamps'
import { FEET_PER_METRE, KNOTS_PER_MS } from '../../ui/telemetry'
import { key } from '../cockpit'
import { type Buzz, Lever, Stick } from '../controls'
import { type Deck, DeckCockpit, Display, keepMaterials, MATERIALS, type Panel } from '../deck'
import { AirspeedIndicator, Altimeter, AttitudeIndicator, TwinGauge } from '../gauges'
import { radarDisplay } from '../glass'
import type { Checklist } from '../tablet'
import {
  dataEntryDisplay,
  EYEBROW_LIGHTS,
  missilesLeft,
  offsetHeadUp,
  panoramicDisplay,
  rightDisplay,
  warningLights
} from './fighters-screens'

/*
 * F-16 and F-35A cockpits. Both put a short-travel sidestick on the right console and the
 * throttle on the left, under a bubble canopy with the seat reclined. The F-16 has a head-up
 * display, the up-front controls, and two square displays. The F-35 has one wide touch
 * screen and no head-up display; the helmet draws its symbology instead.
 */

const DEG = Math.PI / 180

type ScreenOptions =
  Parameters<Deck['screen']> extends [Panel, number, number, ...infer R] ? R : never
// Sidestick travel at full deflection: the F-16's force stick barely moves
const STICK_TRAVEL = 0.035
const DARK_GREY = new MeshStandardMaterial({ color: 0x3b4046, roughness: 0.85, emissive: 0x0e1012 })
const YELLOW = new MeshStandardMaterial({ color: 0xd8b21c, roughness: 0.7, emissive: 0x2a2205 })
const KEYCAP = new MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.6, emissive: 0x060607 })
const TINT = new MeshBasicMaterial({
  color: 0x9fe0b0,
  transparent: true,
  opacity: 0.07,
  depthWrite: false
})
keepMaterials(DARK_GREY, YELLOW, KEYCAP, TINT)

/** What both fighters share: the canopy, seat, consoles, throttle, stick, and weapons. */
abstract class FighterCockpit extends DeckCockpit {
  /** The master arm switch: weapons release from the panel only when armed. */
  protected armed = false

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    // A kneeboard on the left thigh, tilted up to read, clear of the forward view
    this.tablet = {
      position: new Vector3(-0.13, -0.56, -0.36),
      rotation: new Euler(-1.15, 0.3, 0, 'YXZ')
    }
  }

  /**
   * The airframe round the cockpit: the bubble canopy's rails along both sills and its
   * frame bow behind the seat, an arch `halfWidth` wide from the rails at `sill` up to
   * `top`; the cockpit walls; and the outside of the fuselage, the nose ahead of the
   * glareshield, and the spine behind the canopy, in the aircraft's paint.
   */
  protected airframe(halfWidth: number, sill: number, top: number, bowZ: number, bow: Material) {
    const d = this.deck
    const shape = this.spec.shape
    const paint = new MeshStandardMaterial({
      color: 'paint' in shape ? shape.paint : '#8d959c',
      roughness: 0.75,
      emissive: 0x15171a
    })
    for (const side of [-1, 1]) {
      d.box([0.045, 0.035, 1.9], [side * halfWidth, sill, -0.05], bow)
      // The cockpit wall from the sill down to the floor
      d.box([0.025, 0.72, 1.6], [side * (halfWidth + 0.01), sill - 0.36, -0.2], DARK_GREY)
      // The fuselage's shoulder outside the sill, sloping down to the wing root
      d.box([0.5, 0.04, 2.6], [side * (halfWidth + 0.24), sill - 0.1, -0.3], paint, [
        0,
        0,
        side * -0.38
      ])
    }
    // The forward bulkhead behind the panel, and the nose ahead of it, sloping away
    d.box([halfWidth * 2, 0.8, 0.04], [0, -0.6, -0.92], DARK_GREY)
    d.box([halfWidth * 2 + 0.1, 0.04, 1.4], [0, -0.39, -1.55], paint, [-0.26, 0, 0])
    // The spine behind the canopy
    d.box([0.6, 0.3, 1.6], [0, sill + 0.08, bowZ + 0.85], paint)
    const segments = 10
    let from = new Vector3(-halfWidth, sill, bowZ)
    for (let i = 1; i <= segments; i++) {
      const a = Math.PI - (i / segments) * Math.PI
      const to = new Vector3(halfWidth * Math.cos(a), sill + (top - sill) * Math.sin(a), bowZ)
      d.beam(from, to, 0.05, bow)
      from = to
    }
  }

  /** The ejection seat: pan, reclined back, headrest behind the head, and the pull handle. */
  protected seat(recline: number) {
    const d = this.deck
    d.box([0.46, 0.1, 0.48], [0, -0.82, -0.2], MATERIALS.seat)
    d.box([0.44, 0.8, 0.1], [0, -0.38, 0.12], MATERIALS.seat, [recline, 0, 0])
    d.box([0.34, 0.26, 0.14], [0, 0.06, 0.22], MATERIALS.black, [recline, 0, 0])
    for (const side of [-1, 1])
      d.box([0.04, 0.6, 0.12], [side * 0.25, -0.45, 0.16], MATERIALS.olive, [recline, 0, 0])
    // The yellow and black ejection handle at the front of the seat
    d.box([0.12, 0.025, 0.03], [0, -0.75, -0.45], YELLOW)
    d.box([0.02, 0.05, 0.02], [-0.05, -0.78, -0.45], MATERIALS.black)
    d.box([0.02, 0.05, 0.02], [0.05, -0.78, -0.45], MATERIALS.black)
    // Floor and the footwell under the panel
    d.box([0.9, 0.04, 1.6], [0, -1.0, -0.25], MATERIALS.floor)
  }

  /** A flat side console, `side` -1 left or 1 right, with its top face as a panel. */
  protected console(side: number, x: number, top: number, from: number, to: number, width = 0.18) {
    const length = to - from
    return this.deck.panel(
      [side * x, top, (from + to) / 2],
      width,
      length,
      [-Math.PI / 2 + 0.06, 0, side * -0.12],
      MATERIALS.panel,
      0.35
    )
  }

  /**
   * The throttle on the left console: idle at the back, military power, then the
   * afterburner past a notch at the forward end.
   */
  protected throttle(console: Panel, u: number, idle: number, full: number) {
    const { engine } = this.spec
    const notch = engine.type === 'jet' ? engine.afterburnerFrom : 1
    const lever = new Lever(
      this.deck.group,
      this.deck.buzz,
      'THROTTLE',
      console.at(u, idle, 0.09),
      console.at(u, full, 0.1),
      console.at(u, (idle + full) / 2, -0.12),
      {
        get: () => this.leverPosition(),
        set: () => {},
        notches: [0, notch, 1],
        knob: { color: 0x26292c, shape: 'box' },
        state: () => {
          const c = game.pilot.controls
          return c.throttle >= notch ? 'AFTERBURNER' : `${Math.round(c.throttle * 100)}%`
        }
      }
    )
    this.throttles.push(this.deck.add(lever))
    const at = (share: number) => idle + (full - idle) * share
    console.label('OFF', u - 0.045, at(0), 0.007)
    console.label('MIL', u - 0.045, at(notch) - 0.008, 0.007)
    console.label('AB', u - 0.045, at(1), 0.008, '#ff9a3a')
    // The afterburner detent: a raised stop across the slot
    this.deck.box(
      [0.05, 0.006, 0.004],
      console.at(u, at(notch), 0.004).toArray(),
      MATERIALS.white,
      [-Math.PI / 2, 0, 0]
    )
    this.deck.box(
      [0.012, 0.004, Math.abs(full - idle) + 0.03],
      console.at(u, (idle + full) / 2, 0.001).toArray(),
      MATERIALS.black
    )
  }

  /** The sidestick on the right console, with the forearm rest behind it. */
  protected sidestick(console: Panel, u: number, v: number) {
    const d = this.deck
    const base = console.at(u, v, 0)
    this.flight = d.add(
      new Stick(
        d.group,
        d.buzz,
        base.clone().add(new Vector3(0, -0.02, 0)),
        base.clone().add(new Vector3(0, 0.08, 0)),
        STICK_TRAVEL
      )
    )
    const rest = console.at(u + 0.01, v - 0.2, 0.035)
    d.box([0.09, 0.05, 0.22], rest.toArray(), MATERIALS.seat)
  }

  /** Landing gear handle with a wheel-shaped knob: up at the top, down at the bottom. */
  protected gearHandle(panel: Panel, u: number, v: number) {
    const c = game.pilot.controls
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        'LG HANDLE',
        panel.at(u, v + 0.045, 0.06),
        panel.at(u, v - 0.045, 0.06),
        panel.at(u, v, 0),
        {
          get: () => (c.gearDown ? 1 : 0),
          set: (value, released) => {
            if (released && value > 0.5 !== c.gearDown) key('KeyG')
          },
          detents: [0, 1],
          knob: { color: 0xe6e6e6, shape: 'wheel' },
          state: () => {
            const p = game.sim.gearPosition
            return p >= 1 ? 'DOWN' : p <= 0 ? 'UP' : 'MOVING'
          }
        }
      )
    )
    panel.label('LG', u, v + 0.075)
    panel.label('UP', u + 0.03, v + 0.045, 0.007)
    panel.label('DN', u + 0.03, v - 0.045, 0.007)
  }

  /** Master arm, weapons release, flares, and stores jettison. */
  protected weapons(panel: Panel, u: number, v: number, spacing = 0.045) {
    const d = this.deck
    d.rocker(panel, 'MASTER ARM', u, v, {
      get: () => this.armed,
      set: on => {
        this.armed = on
      },
      color: 0x6a1a12,
      state: () => (this.armed ? 'ARM' : 'SAFE')
    })
    d.button(panel, 'WPN REL', u + spacing, v, {
      lit: () => (this.armed && missilesLeft() + game.bombs.loaded > 0 ? 'alert' : 'off'),
      press: () => {
        if (!this.armed) return
        game.release()
        game.endRelease()
      },
      state: () => (this.armed ? 'fires a missile or drops a bomb' : 'set MASTER ARM first'),
      color: 0x8a1a14,
      size: { w: 0.028, h: 0.022 }
    })
    d.button(panel, 'FLARE', u + spacing * 2, v, {
      press: () => {
        if (game.getState().status === 'flying') game.combat.dropFlares(game.sim)
      },
      state: () => `${game.combat.flaresLeft} left`,
      size: { w: 0.028, h: 0.022 }
    })
  }

  /** The emergency jettison button. The sim carries no external stores to drop yet. */
  protected jettison(panel: Panel, u: number, v: number, label: string) {
    this.deck.button(panel, label, u, v, {
      press: () => {},
      state: () => 'no external stores to jettison',
      color: 0x7a5a14,
      size: { w: 0.03, h: 0.03 }
    })
  }

  /** Start-up and lighting switches on the left console. */
  protected startSwitches(panel: Panel, u: number, v: number, names: [string, string, string]) {
    const d = this.deck
    const c = game.pilot.controls
    const [power, fuel, engine] = names
    d.rocker(panel, power, u, v, { get: () => c.battery, set: () => key('KeyO') })
    d.rocker(panel, fuel, u + 0.045, v, { get: () => c.fuelPumps, set: () => key('KeyU') })
    d.rocker(panel, engine, u, v - 0.055, {
      get: () => c.engineSwitches[0],
      set: () => key('Digit1'),
      state: () => (game.sim.enginesRunning > 0 ? 'RUNNING' : c.engineSwitches[0] ? 'START' : 'OFF')
    })
    d.rocker(panel, 'LDG LT', u + 0.045, v - 0.055, {
      get: () => game.pilot.landingLights,
      set: () => key('KeyL')
    })
    d.rocker(panel, 'SPD BRK', u, v - 0.11, {
      get: () => c.speedBrake,
      set: () => key('KeyB'),
      state: () => (c.speedBrake ? 'OPEN' : 'CLOSED')
    })
    d.rocker(panel, 'PARK BRK', u + 0.045, v - 0.11, {
      get: () => c.parkingBrake,
      set: () => key('KeyP'),
      state: () => (c.parkingBrake ? 'SET' : 'OFF')
    })
  }

  /**
   * Decorative push buttons in a grid on a panel, merged into one mesh: `rows` of `columns`
   * square caps `size` wide at `pitch` spacing, centred on (u, v).
   */
  protected keypad(
    panel: Panel,
    u: number,
    v: number,
    columns: number,
    rows: number,
    size: number,
    pitch: number
  ) {
    const parts: BoxGeometry[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const box = new BoxGeometry(size, size, 0.006)
        box.translate((c - (columns - 1) / 2) * pitch, ((rows - 1) / 2 - r) * pitch, 0.003)
        parts.push(box)
      }
    }
    this.mergedOnPanel(panel, u, v, parts, KEYCAP)
  }

  /** The option select buttons round a square display `size` wide: five a side. */
  protected optionButtons(panel: Panel, u: number, v: number, size: number) {
    const parts: BoxGeometry[] = []
    const edge = size / 2 + 0.016
    for (let i = 0; i < 5; i++) {
      const along = (i - 2) * (size / 5.5)
      for (const [x, y, w, h] of [
        [along, edge, 0.012, 0.008],
        [along, -edge, 0.012, 0.008],
        [edge, along, 0.008, 0.012],
        [-edge, along, 0.008, 0.012]
      ]) {
        const box = new BoxGeometry(w, h, 0.006)
        box.translate(x, y, 0.003)
        parts.push(box)
      }
    }
    // The grey bezel the buttons sit in
    const bezel = new BoxGeometry(size + 0.05, size + 0.05, 0.004)
    bezel.translate(0, 0, -0.001)
    this.mergedOnPanel(panel, u, v, [bezel], DARK_GREY)
    this.mergedOnPanel(panel, u, v, parts, KEYCAP)
  }

  private mergedOnPanel(
    panel: Panel,
    u: number,
    v: number,
    parts: BoxGeometry[],
    material: Material
  ) {
    const geometry = mergeGeometries(parts)
    for (const part of parts) part.dispose()
    const mesh = new Mesh(geometry, material)
    mesh.position.copy(panel.at(u, v, 0))
    mesh.quaternion.copy(panel.face)
    this.deck.group.add(mesh)
  }

  /**
   * A transparent symbology glass `width` by `height` centred at `centre`, facing the
   * pilot and drawn `hz` times a second. `overlay` draws it over everything, as a helmet's
   * visor display is.
   */
  protected symbology(
    centre: Vector3,
    width: number,
    height: number,
    paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    pixelsPerMetre: number,
    overlay: boolean
  ) {
    const display = new Display(width, height, pixelsPerMetre, paint, 15)
    const material = display.mesh.material as MeshBasicMaterial
    material.depthWrite = false
    if (overlay) {
      material.depthTest = false
      display.mesh.renderOrder = 10
    }
    display.mesh.position.copy(centre)
    display.draw()
    this.deck.group.add(display.mesh)
    this.deck.track({ update: dt => display.update(dt), dispose: () => display.dispose() })
  }

  /** A screen on a panel, lifted 1.5 mm clear of its bezel's face so the two do not flicker. */
  protected screen(panel: Panel, u: number, v: number, ...rest: ScreenOptions) {
    const display = this.deck.screen(panel, u, v, ...rest)
    display.mesh.position.copy(panel.at(u, v, 0.0045))
    return display
  }

  /** Short checklists, for either fighter. */
  protected fighterChecklists(names: { power: string; engine: string }): Checklist[] {
    const { pilot, sim, combat } = game
    const c = pilot.controls
    return [
      {
        title: 'Before Start',
        items: [
          { text: `${names.power}: ON`, done: () => c.battery },
          { text: 'FUEL MASTER: ON', done: () => c.fuelPumps },
          { text: 'PARK BRK: SET', done: () => c.parkingBrake },
          { text: 'Throttle: OFF', done: () => c.throttle < 0.05 }
        ]
      },
      {
        title: 'Engine Start',
        items: [
          { text: `${names.engine}: START`, done: () => c.engineSwitches[0] },
          { text: 'Engine: running at idle', done: () => sim.enginesRunning > 0 }
        ]
      },
      {
        title: 'Takeoff',
        items: [
          { text: 'PARK BRK: OFF', done: () => !c.parkingBrake },
          { text: 'Throttle: MIL or AB', done: () => c.throttle > 0.8 },
          { text: 'Rotate at 150 KIAS', done: () => !sim.onGround },
          { text: 'LG HANDLE: UP', done: () => !c.gearDown }
        ]
      },
      {
        title: 'Fight',
        items: [
          { text: 'MASTER ARM: ARM', done: () => this.armed },
          { text: 'Radar: target locked', done: () => combat.lock >= 0 },
          { text: 'WPN REL or trigger: fire', done: () => combat.missiles.some(m => m.fromPlayer) }
        ]
      },
      {
        title: 'Landing',
        items: [
          { text: 'MASTER ARM: SAFE', done: () => !this.armed },
          { text: 'LG HANDLE: DOWN', done: () => c.gearDown },
          { text: 'LDG LT: ON', done: () => pilot.landingLights },
          { text: 'Fly 13 degrees AOA to touchdown', done: () => sim.onGround },
          { text: 'SPD BRK: OPEN', done: () => c.speedBrake }
        ]
      }
    ]
  }
}

/** The F-16C Block 50 cockpit. */
export class F16Cockpit extends FighterCockpit {
  private page: 'SMS' | 'ENG' | 'HSD' = 'SMS'

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const { sim, pilot } = game
    const c = pilot.controls

    this.airframe(0.41, -0.3, 0.3, 0.36, MATERIALS.frame)
    this.seat(0.52)

    // Glareshield coaming over the main panel, with the head-up display's body through it
    d.box([0.8, 0.02, 0.2], [0, -0.21, -0.79], MATERIALS.black, [-0.15, 0, 0])
    d.box([0.17, 0.05, 0.16], [0, -0.17, -0.68], MATERIALS.black)

    // Head-up display: the combiner glass centred 4.8 degrees under the line of sight
    const hudZ = -0.6
    const hudWidth = 0.22
    const hudHeight = 0.17
    const below = 4.8
    const field = (2 * Math.atan(hudWidth / 2 / -hudZ)) / DEG
    const hudCentre = new Vector3(0, hudZ * Math.tan(below * DEG), hudZ)
    this.symbology(hudCentre, hudWidth, hudHeight, offsetHeadUp(field, below), 2600, false)
    const tint = new Mesh(new BoxGeometry(hudWidth, hudHeight, 0.002), TINT)
    tint.position.copy(hudCentre).setZ(hudZ - 0.004)
    d.group.add(tint)
    for (const side of [-1, 1]) {
      d.beam(
        new Vector3(side * (hudWidth / 2 + 0.005), hudCentre.y - hudHeight / 2 - 0.03, hudZ - 0.03),
        new Vector3(side * (hudWidth / 2 + 0.005), hudCentre.y + hudHeight / 2 - 0.01, hudZ + 0.01),
        0.007,
        MATERIALS.frame
      )
    }

    // Up-front controls under the head-up display: keypad, mode buttons, and the DED
    const icp = d.panel([0, -0.215, -0.57], 0.22, 0.1, [-0.5, 0, 0], MATERIALS.panel, 0.06)
    this.keypad(icp, 0, 0.012, 3, 3, 0.013, 0.018)
    this.keypad(icp, -0.075, 0.012, 2, 2, 0.016, 0.022)
    this.keypad(icp, 0.075, 0.012, 2, 2, 0.016, 0.022)
    icp.label('COM1  COM2', -0.075, 0.042, 0.006)
    icp.label('A-A  A-G', 0.075, 0.042, 0.006)
    icp.label('ICP', 0, 0.044, 0.007)
    this.screen(icp, 0, -0.03, 0.085, 0.026, dataEntryDisplay(spec), 4, 3000)

    // Main panel: two square displays, standby instruments between, switches above
    const main = d.panel([0, -0.42, -0.7], 0.58, 0.32, [-0.2, 0, 0], MATERIALS.panel, 0.25)
    const mfd = 0.1
    this.optionButtons(main, -0.17, -0.045, mfd)
    this.screen(main, -0.17, -0.045, mfd, mfd, radarDisplay, 8)
    main.label('FCR', -0.17, 0.045, 0.007)
    this.optionButtons(main, 0.17, -0.045, mfd)
    this.screen(
      main,
      0.17,
      -0.045,
      mfd,
      mfd,
      rightDisplay(
        spec,
        () => this.page,
        () => this.armed
      ),
      6
    )
    // The right display's page buttons along its bottom edge
    for (const [i, page] of (['SMS', 'ENG', 'HSD'] as const).entries()) {
      d.button(
        main,
        page,
        0.17 + (i - 1) * 0.035,
        -0.125,
        {
          press: () => {
            this.page = page
          },
          lit: () => (this.page === page ? 'on' : 'off'),
          size: { w: 0.022, h: 0.012 }
        },
        false
      )
      main.label(page, 0.17 + (i - 1) * 0.035, -0.142, 0.007)
    }
    d.instrument(
      main,
      0,
      -0.035,
      new AttitudeIndicator(0.07, () => ({ pitch: sim.pitch, bank: sim.bank }))
    )
    d.instrument(
      main,
      -0.042,
      -0.115,
      new AirspeedIndicator(0.05, spec.gauges.airspeed, () => sim.indicatedAirspeed * KNOTS_PER_MS)
    )
    d.instrument(main, 0.042, -0.115, new Altimeter(0.05, () => sim.position.y * FEET_PER_METRE))

    // The MISC panel above the left display: master arm and the autopilot
    main.label('MISC', -0.17, 0.135, 0.007)
    this.weapons(main, -0.24, 0.1, 0.04)
    d.rocker(main, 'AP', -0.1, 0.1, {
      get: () => pilot.autopilot.on,
      set: () => key('KeyZ'),
      state: () => (pilot.autopilot.on ? 'ATT HOLD' : 'OFF')
    })

    // Eyebrows: master caution on the left, the warning lights on the right
    const leftBrow = d.panel(
      [-0.2, -0.205, -0.64],
      0.09,
      0.045,
      [-0.7, 0.25, 0],
      MATERIALS.panel,
      0.03
    )
    const notices = LAMPS.filter(lamp => lamp.kind === 'notice' && lamp.label !== 'NO POWER')
    d.button(leftBrow, 'MASTER CAUTION', 0, -0.004, {
      lit: () =>
        sim.powered && notices.some(lamp => lamp.on(sim, c) && (!lamp.present || lamp.present(sim)))
          ? 'alert'
          : 'off',
      color: 0x5a3a10,
      size: { w: 0.032, h: 0.02 }
    })
    const rightBrow = d.panel(
      [0.2, -0.205, -0.64],
      0.1,
      0.045,
      [-0.7, -0.25, 0],
      MATERIALS.panel,
      0.03
    )
    this.screen(rightBrow, 0, 0, 0.088, 0.038, warningLights(EYEBROW_LIGHTS, 2), 4, 3000)

    // Left auxiliary console: gear handle, jettison, and the hook
    const gear = d.panel([-0.3, -0.45, -0.6], 0.14, 0.2, [-0.45, 0.7, 0], MATERIALS.panel, 0.1)
    this.gearHandle(gear, -0.02, 0.0)
    this.jettison(gear, 0.04, 0.05, 'STORES JETT')
    d.rocker(gear, 'HOOK', 0.04, -0.05, { get: () => false, set: () => {}, state: () => 'UP' })
    // Right auxiliary console: engine speed and fuel quantity
    const engine = d.panel([0.3, -0.45, -0.6], 0.14, 0.2, [-0.45, -0.7, 0], MATERIALS.panel, 0.1)
    engine.label('ENGINE', 0, 0.075, 0.008)
    d.instrument(
      engine,
      0,
      0.02,
      new TwinGauge(0.1, 0.07, [
        {
          label: 'RPM',
          bands: [
            { from: 0, to: 0.95, color: 'green' },
            { from: 0.95, to: 1, color: 'red' }
          ],
          read: () => (sim.engines[0]?.rpm ?? 0) / 105
        },
        {
          label: 'FUEL',
          bands: [
            { from: 0, to: 0.15, color: 'red' },
            { from: 0.15, to: 1, color: 'green' }
          ],
          read: () => sim.fuel / spec.fuelCapacity
        }
      ])
    )

    // Side consoles: throttle and start switches left, sidestick right
    const left = this.console(-1, 0.3, -0.47, -0.52, 0.12)
    this.throttle(left, 0.035, 0.0, 0.17)
    left.label('ELEC  FUEL', -0.03, -0.065, 0.007)
    this.startSwitches(left, -0.055, -0.1, ['MAIN PWR', 'FUEL MSTR', 'JFS'])
    const right = this.console(1, 0.3, -0.47, -0.52, 0.12)
    this.sidestick(right, -0.01, 0.13)
    right.label('AVIONICS POWER', 0, -0.12, 0.007)
    this.keypad(right, 0.02, -0.16, 3, 1, 0.014, 0.03)

    this.checklists = this.fighterChecklists({ power: 'MAIN PWR', engine: 'JFS' })
    this.finish()
  }
}

/**
 * The F-35A cockpit. There is no head-up display: the pilot's helmet projects flight
 * symbology on the visor wherever they look. Here it is a glass fixed ahead of the eye,
 * 30 degrees wide, drawn over everything as the visor's image is.
 */
export class F35Cockpit extends FighterCockpit {
  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const { sim } = game

    // A one-piece canopy: no frame ahead, only the sills and the frame behind the seat
    this.airframe(0.45, -0.3, 0.32, 0.4, MATERIALS.black)
    this.seat(0.5)

    // Glareshield over the wide display
    d.box([0.88, 0.02, 0.2], [0, -0.215, -0.85], MATERIALS.black, [-0.15, 0, 0])

    // Helmet symbology, fixed ahead at 1.5 m and drawn over the cockpit
    const distance = 1.5
    const field = 30
    const width = 2 * distance * Math.tan((field / 2) * DEG)
    this.symbology(
      new Vector3(0, 0, -distance),
      width,
      width * 0.7,
      offsetHeadUp(field, 0),
      800,
      true
    )

    // The panoramic display, its integrated standby display below, and the hard switches
    const main = d.panel([0, -0.385, -0.71], 0.68, 0.3, [-0.3, 0, 0], MATERIALS.panel, 0.25)
    this.screen(
      main,
      0,
      0.04,
      0.5,
      0.2,
      panoramicDisplay(spec, () => this.armed),
      12,
      2000
    )
    this.screen(
      main,
      0,
      -0.105,
      0.06,
      0.06,
      (ctx, w, h) => {
        ctx.fillStyle = '#05070a'
        ctx.fillRect(0, 0, w, h)
        if (sim.powered) standbyDisplay(ctx, w, h)
      },
      4
    )
    main.label('ISD', 0, -0.067, 0.006)
    this.gearHandle(main, -0.29, -0.06)
    this.weapons(main, 0.1, -0.11, 0.045)
    this.jettison(main, 0.27, -0.11, 'EMER JETT')

    // Side consoles: throttle left, sidestick right
    const left = this.console(-1, 0.33, -0.48, -0.56, 0.12, 0.2)
    this.throttle(left, 0.04, 0.0, 0.17)
    this.startSwitches(left, -0.06, -0.1, ['BATT', 'FUEL PUMP', 'ENG START'])
    const right = this.console(1, 0.33, -0.48, -0.56, 0.12, 0.2)
    this.sidestick(right, -0.01, 0.13)
    this.keypad(right, 0.03, -0.14, 2, 2, 0.016, 0.03)
    right.label('LIGHTS', 0.03, -0.1, 0.007)

    this.checklists = this.fighterChecklists({ power: 'BATT', engine: 'ENG START' })
    this.finish()
  }
}

/** The standby display: attitude, speed, and altitude, after the primary flight display. */
function standbyDisplay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const { sim } = game
  const cx = w / 2
  const cy = h / 2
  const perDegree = h / 50
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.clip()
  ctx.translate(cx, cy)
  ctx.rotate(-sim.bank)
  const y = (sim.pitch / DEG) * perDegree
  ctx.fillStyle = '#2f7fc6'
  ctx.fillRect(-w, -h * 2 + y, w * 2, h * 2)
  ctx.fillStyle = '#6b4424'
  ctx.fillRect(-w, y, w * 2, h * 2)
  ctx.restore()
  ctx.strokeStyle = '#ffd400'
  ctx.lineWidth = Math.max(2, h * 0.02)
  ctx.beginPath()
  ctx.moveTo(cx - w * 0.25, cy)
  ctx.lineTo(cx - w * 0.08, cy)
  ctx.moveTo(cx + w * 0.08, cy)
  ctx.lineTo(cx + w * 0.25, cy)
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${h * 0.12}px system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.fillText(String(Math.round(sim.indicatedAirspeed * KNOTS_PER_MS)), w * 0.04, h * 0.04)
  ctx.textAlign = 'right'
  ctx.fillText(String(Math.round(sim.position.y * FEET_PER_METRE)), w * 0.96, h * 0.04)
}

/** The cockpits this file builds, by aircraft id. */
export const COCKPITS = { f16: F16Cockpit, f35: F35Cockpit }
