import {
  CylinderGeometry,
  type Material,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3
} from 'three'
import { game } from '../../game/game'
import { WARNINGS } from '../../game/gpws'
import type { LateralMode, VerticalMode } from '../../game/pilot'
import type { AircraftSpec } from '../../sim/aircraft'
import { LAMPS } from '../../ui/lamps'
import { DEGREES, FEET_PER_METRE, FPM_PER_MS, KNOTS_PER_MS } from '../../ui/telemetry'
import { flying, key } from '../cockpit'
import { type Buzz, Knob, Lever, Rocker, TrimWheel, Yoke } from '../controls'
import { DeckCockpit, Display, MATERIALS, type Panel } from '../deck'
import { engineDisplay, headUpDisplay, navigationDisplay, primaryFlight } from '../glass'
import type { Checklist } from '../tablet'
import {
  auxStrip,
  boeingPfd,
  cdu,
  keypad,
  legsScreen,
  type Paint,
  progressScreen,
  sideBySide,
  systemsPage
} from './boeing-glass'

/*
 * Boeing 737 MAX 8 and 787-9 flight decks, at real scale from the captain's eye. The
 * captain sits left, so the centreline is CL metres to the right. Both share the shell,
 * the yokes, the glareshield's mode control panel, and the pedestal levers; each lays out
 * its own screens, overhead, and pedestal.
 */

const DEG = Math.PI / 180
/** The fuselage centreline, right of the captain's eye. */
const CL = 0.55
/** The main panel's face, ahead of the eye. */
const PANEL_Z = -0.78
/** The glareshield: its top, its underside, and its back face over the main panel. */
const SHIELD_TOP = -0.1
const SHIELD_BOTTOM = -0.19
const SHIELD_BACK = -0.7
/** A 15.1 inch landscape display's picture, in metres. */
const DU = { w: 0.305, h: 0.229 }

const LAMP_COLOURS = {
  red: [0xff3a22, 0x2e0c0a],
  green: [0x3cff6a, 0x0b2412],
  amber: [0xffa21a, 0x2e2008]
} as const

type McpItem =
  | {
      /** A window with a value, with its knob below. */
      window: string
      text: () => string
      turn: (clicks: number) => void
      press?: () => void
      hint: string
    }
  | { button: string; press: () => void; lit?: () => boolean }
  | { toggle: string; get: () => boolean; set: (on: boolean) => void }

const autopilot = () => game.pilot.autopilot
const autothrottle = () => game.pilot.autothrottle
const lateral = (mode: LateralMode) => flying(() => game.pilot.setLateral(mode, game.sim, game.nav))
const vertical = (mode: VerticalMode) =>
  flying(() => game.pilot.setVertical(mode, game.sim, game.nav))
const lateralIs = (mode: LateralMode) => () => autopilot().on && autopilot().lateral === mode
const verticalIs = (mode: VerticalMode) => () => autopilot().on && autopilot().vertical === mode

const speedText = () => {
  const speed = autothrottle().speed
  return speed < 1 ? '' : String(Math.round(speed * KNOTS_PER_MS))
}
const degreesText = (radians: number) =>
  String(Math.round((((radians * DEGREES) % 360) + 360) % 360) || 360).padStart(3, '0')
const altitudeText = () =>
  String(Math.round((autopilot().altitude * FEET_PER_METRE) / 100) * 100).padStart(5, ' ')
const climbText = () => {
  if (!verticalIs('VS')()) return ''
  const fpm = Math.round((autopilot().verticalSpeed * FPM_PER_MS) / 100) * 100
  return `${fpm > 0 ? '+' : ''}${fpm}`
}

/** A box from one point to another in a side view (y, z), `width` across, such as a roof slope. */
function slab(
  cockpit: BoeingCockpit,
  x: number,
  width: number,
  from: [number, number],
  to: [number, number],
  thick: number,
  material: Material
) {
  const dy = to[0] - from[0]
  const dz = to[1] - from[1]
  cockpit.deck.box(
    [width, thick, Math.hypot(dy, dz)],
    [x, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
    material,
    [Math.atan2(-dy, dz), 0, 0]
  )
}

/** The parts both Boeing decks share. Subclasses build their layout, then call `finish`. */
abstract class BoeingCockpit extends DeckCockpit {
  protected speedbrakeArmed = false
  private airborne = false
  private readonly lamps: {
    material: MeshBasicMaterial
    on: () => boolean
    colours: readonly [number, number]
  }[] = []
  /** Switches that only show a position, such as the beacon or the packs. */
  private readonly switches = new Map<string, boolean>()
  /** The engine start switches' positions, as indices into their names. */
  protected readonly starters = [1, 1]
  private readonly master = {
    warning: () => {
      const { sim } = game
      const c = game.pilot.controls
      return (
        sim.powered &&
        (LAMPS.some(lamp => lamp.kind === 'warning' && lamp.on(sim, c)) ||
          (game.gpws.alert !== null && WARNINGS.has(game.gpws.alert)))
      )
    },
    caution: () => game.sim.powered && game.gpws.alert !== null && !WARNINGS.has(game.gpws.alert)
  }

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    this.reverseRegion = 0.14
  }

  /** A switch that holds its own position, for a rocker. */
  protected latch(name: string, initial = false) {
    this.switches.set(name, initial)
    return {
      get: () => this.switches.get(name) ?? false,
      set: (on: boolean) => {
        this.switches.set(name, on)
      }
    }
  }

  /** A canvas on a panel with no bezel, such as the autopilot windows or the head-up display. */
  protected glass(
    panel: Panel,
    u: number,
    v: number,
    width: number,
    height: number,
    paint: Paint,
    hz: number,
    pixelsPerMetre = 2400
  ) {
    const display = new Display(width, height, pixelsPerMetre, paint, hz)
    display.mesh.position.copy(panel.at(u, v, 0.002))
    display.mesh.quaternion.copy(panel.face)
    this.deck.group.add(display.mesh)
    this.deck.track(display)
    display.draw()
    return display
  }

  /** An annunciator light on a panel, lit while `on` says so. */
  protected lamp(
    panel: Panel,
    u: number,
    v: number,
    width: number,
    height: number,
    colour: keyof typeof LAMP_COLOURS,
    on: () => boolean
  ) {
    const colours = LAMP_COLOURS[colour]
    const material = new MeshBasicMaterial({ color: colours[1], toneMapped: false })
    const mesh = new Mesh(new PlaneGeometry(width, height), material)
    mesh.position.copy(panel.at(u, v, 0.0015))
    mesh.quaternion.copy(panel.face)
    this.deck.group.add(mesh)
    this.lamps.push({ material, on, colours })
  }

  /**
   * Floor, walls, windscreen and window posts, roof, back wall, and the footwell wall under
   * the main panel. `header` is the windscreen's top edge; `posts` are where the side
   * window posts stand, front to back.
   */
  protected shell(left: number, right: number, header: number, posts: number[], post: number) {
    const d = this.deck
    const width = right - left
    const roof = header + 0.27
    d.box([width + 0.1, 0.04, 2.5], [CL, -1.08, -0.05], MATERIALS.floor)
    for (const x of [left, right]) {
      const wall = x + Math.sign(x - CL) * 0.02
      // Lining below the windows, and above them up to the roof
      d.box([0.04, 0.96, 2.42], [wall, -0.61, 0], MATERIALS.lining)
      d.box([0.04, roof - header + 0.04, 1.9], [wall, (roof + header) / 2, 0.3], MATERIALS.lining)
      // Window frame: sill, header, the corner post along the windscreen, and side posts
      d.beam(new Vector3(x, -0.13, -1.08), new Vector3(x, -0.13, 1.1), 0.05, MATERIALS.frame)
      d.beam(new Vector3(x, header, -0.66), new Vector3(x, header, 1.1), 0.06, MATERIALS.frame)
      d.beam(new Vector3(x, -0.14, -1.08), new Vector3(x, header, -0.64), post, MATERIALS.frame)
      for (const z of posts) {
        d.beam(new Vector3(x, -0.13, z), new Vector3(x, header, z), post, MATERIALS.frame)
      }
      const last = posts[posts.length - 1]
      d.box(
        [0.04, header + 0.15, 1.2 - last],
        [wall, (header - 0.13) / 2, (last + 1.2) / 2],
        MATERIALS.lining
      )
    }
    // Windscreen: centre post and top header
    d.beam(
      new Vector3(CL, SHIELD_TOP, -1.08),
      new Vector3(CL, header, -0.64),
      post * 0.8,
      MATERIALS.frame
    )
    d.beam(
      new Vector3(left, header, -0.64),
      new Vector3(right, header, -0.64),
      0.07,
      MATERIALS.frame
    )
    // Brow from the windscreen up to the roof, the roof, and the back wall with its door
    slab(this, CL, width, [header + 0.02, -0.66], [roof, -0.25], 0.04, MATERIALS.lining)
    d.box([width, 0.04, 1.45], [CL, roof, 0.47], MATERIALS.lining)
    d.box([width + 0.1, roof + 1.08, 0.04], [CL, (roof - 1.08) / 2, 1.17], MATERIALS.lining)
    d.box([0.6, 1.5, 0.02], [CL, -0.33, 1.13], MATERIALS.grey)
    // Glareshield over the main panel, and the footwell wall below it
    d.box(
      [width, SHIELD_TOP - SHIELD_BOTTOM, SHIELD_BACK + 1.08],
      [CL, (SHIELD_TOP + SHIELD_BOTTOM) / 2, (SHIELD_BACK - 1.08) / 2],
      MATERIALS.black
    )
    d.box([width, 0.4, 0.04], [CL, -0.88, -0.99], MATERIALS.panel)
  }

  /** Both seats, rudder pedals, and the yoke columns, with the captain's yoke flying. */
  protected seatsAndYokes(sideConsole: number, left: number, right: number) {
    const d = this.deck
    for (const x of [0, 2 * CL]) {
      d.box([0.3, 0.2, 0.42], [x, -0.98, 0.25], MATERIALS.frame)
      d.box([0.5, 0.1, 0.5], [x, -0.84, 0.24], MATERIALS.seat)
      d.box([0.48, 0.72, 0.1], [x, -0.42, 0.52], MATERIALS.seat, [-0.12, 0, 0])
      d.box([0.26, 0.16, 0.08], [x, 0.0, 0.57], MATERIALS.seat, [-0.12, 0, 0])
      for (const side of [-1, 1]) {
        d.box([0.05, 0.04, 0.34], [x + side * 0.27, -0.62, 0.3], MATERIALS.seat)
        // Rudder pedals
        d.box([0.08, 0.2, 0.03], [x + side * 0.12, -0.93, -0.82], MATERIALS.grey, [-0.45, 0, 0])
      }
      // The yoke column, up from the floor to the wheel's shaft
      d.box([0.06, 0.56, 0.07], [x, -0.78, -0.62], MATERIALS.panel)
      d.box([0.09, 0.05, 0.1], [x, -0.5, -0.62], MATERIALS.panel)
      // A sleeve over the wheel's shaft, from the column into the panel
      d.box([0.04, 0.04, 0.27], [x, -0.47, -0.615], MATERIALS.panel)
    }
    // Side consoles under the side windows
    d.box([sideConsole, 0.52, 1.0], [left + sideConsole / 2, -0.82, -0.1], MATERIALS.panel)
    d.box([sideConsole, 0.52, 1.0], [right - sideConsole / 2, -0.82, -0.1], MATERIALS.panel)
    // Tiller on the captain's console
    const tiller = new Mesh(new CylinderGeometry(0.06, 0.06, 0.02, 20), MATERIALS.black)
    tiller.position.set(left + sideConsole * 0.6, -0.55, -0.42)
    d.group.add(tiller)
    this.flight = d.add(
      new Yoke(d.group, d.buzz, new Vector3(0, -0.47, -0.38), new Vector3(2 * CL, -0.47, -0.38))
    )
  }

  /**
   * The mode control panel along the glareshield: windows with their knobs, push buttons,
   * and switches, laid out left to right as given. Returns its width.
   */
  protected modeControlPanel(panel: Panel, items: McpItem[]) {
    const d = this.deck
    const widths = items.map(item => ('window' in item ? 0.058 : 'button' in item ? 0.04 : 0.036))
    const total = widths.reduce((sum, w) => sum + w, 0)
    const windows: { u: number; text: () => string }[] = []
    let edge = -total / 2
    items.forEach((item, i) => {
      const u = edge + widths[i] / 2
      edge += widths[i]
      if ('window' in item) {
        windows.push({ u, text: item.text })
        panel.label(item.window, u, 0.032, 0.0055)
        d.add(
          new Knob(d.group, d.buzz, item.window, panel.at(u, -0.016), {
            axis: 'z',
            face: panel.face,
            step: 12 * DEG,
            radius: 0.0095,
            turn: item.turn,
            press: item.press,
            state: () => item.hint
          })
        )
      } else if ('button' in item) {
        const lit = item.lit
        d.button(
          panel,
          item.button,
          u,
          -0.016,
          {
            press: item.press,
            lit: lit && (() => (lit() ? 'on' : 'off')),
            size: { w: 0.03, h: 0.016 }
          },
          false
        )
        panel.label(item.button, u, 0.005, 0.0055)
      } else {
        panel.label(item.toggle, u, 0.012, 0.0055)
        d.add(
          new Rocker(d.group, d.buzz, item.toggle, panel.at(u, -0.014), {
            get: item.get,
            set: item.set,
            face: panel.face
          })
        )
      }
    })
    // One strip of glass carries every window, clear between them
    const box = 0.046
    this.glass(
      panel,
      0,
      0.018,
      total,
      0.014,
      (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h)
        const scale = w / total
        ctx.font = `700 ${h * 0.7}px ui-monospace, Menlo, Consolas, monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        for (const window of windows) {
          const x = (window.u + total / 2) * scale
          ctx.fillStyle = '#0a0b0c'
          ctx.fillRect(x - (box / 2) * scale, 0, box * scale, h)
          if (!game.sim.powered) continue
          ctx.fillStyle = '#ffcf6a'
          ctx.fillText(window.text(), x, h * 0.54)
        }
      },
      5,
      3000
    )
    return total
  }

  /** An EFIS control panel: minimums, barometer, map mode, and range knobs. */
  protected efisPanel(panel: Panel) {
    for (const [i, label] of ['MINS', 'BARO', 'MODE', 'RANGE'].entries()) {
      this.deck.knob(panel, label, -0.06 + i * 0.04, -0.012, {
        step: 15 * DEG,
        radius: 0.009,
        turn: () => {},
        state: () => 'display setting'
      })
    }
  }

  /** The fire warning and master caution lights, which flash and glow as alerts come up. */
  protected masterLights(panel: Panel, u: number) {
    const fire = () => game.sim.engines.some(engine => engine.fire)
    const flashing = () => Math.floor(performance.now() / 400) % 2 === 0
    this.deck.button(
      panel,
      'FIRE WARN',
      u - 0.032,
      -0.01,
      {
        lit: () => ((fire() || this.master.warning()) && flashing() ? 'alert' : 'off'),
        color: 0x6a1010,
        size: { w: 0.034, h: 0.024 }
      },
      false
    )
    this.deck.button(
      panel,
      'MASTER CAUTION',
      u + 0.032,
      -0.01,
      {
        lit: () => (this.master.caution() ? 'alert' : 'off'),
        color: 0x5a3a10,
        size: { w: 0.034, h: 0.024 }
      },
      false
    )
    panel.label('FIRE WARN', u - 0.032, 0.017, 0.0055)
    panel.label('MASTER CAUTION', u + 0.032, 0.017, 0.0055)
  }

  /** The landing gear lever with its wheel-shaped knob: up at the top, down at the bottom. */
  protected gearLever(panel: Panel, u: number, v: number) {
    const c = game.pilot.controls
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        'GEAR',
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
    panel.label('UP', u + 0.032, v + 0.045, 0.007)
    panel.label('DN', u + 0.032, v - 0.045, 0.007)
  }

  /** Two thrust levers: idle at the back, full forward, and reverse pulled back past idle. */
  protected thrustLevers(panel: Panel, spacing: number) {
    const d = this.deck
    const c = game.pilot.controls
    for (const [i, u] of [-spacing / 2, spacing / 2].entries()) {
      const lever = new Lever(
        d.group,
        d.buzz,
        `THRUST ${i + 1}`,
        panel.at(u, -0.12, 0.11),
        panel.at(u, 0.1, 0.15),
        panel.at(u, -0.02, -0.1),
        {
          get: () => this.leverPosition(),
          set: () => {},
          notches: [this.reverseRegion],
          knob: { color: 0x1c1d1f, shape: 'box' },
          state: () => (c.reverse ? 'REVERSE' : `${Math.round(c.throttle * 100)}%`)
        }
      )
      this.throttles.push(d.add(lever))
    }
  }

  /**
   * The speed brake lever, on the left of the thrust levers: DOWN forward, then ARMED, which
   * raises the spoilers on touchdown, then UP at the back.
   */
  protected speedbrakeLever(panel: Panel, u: number) {
    const c = game.pilot.controls
    const armed = 0.18
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        'SPEED BRAKE',
        panel.at(u, 0.1, 0.07),
        panel.at(u, -0.06, 0.07),
        panel.at(u, 0.02, -0.05),
        {
          get: () => (c.speedBrake ? 1 : this.speedbrakeArmed ? armed : 0),
          set: (value, released) => {
            if (!released) return
            const up = value > 0.6
            this.speedbrakeArmed = !up && value > armed / 2
            if (up !== c.speedBrake) key('KeyB')
          },
          detents: [0, armed, 1],
          knob: { color: 0x8c9196, shape: 'box' },
          state: () => (c.speedBrake ? 'UP' : this.speedbrakeArmed ? 'ARMED' : 'DOWN')
        }
      )
    )
    panel.label('SPEED BRAKE', u, 0.14, 0.007)
    panel.label('DOWN', u - 0.045, 0.1, 0.0065)
    panel.label('ARMED', u - 0.045, 0.1 - 0.16 * armed, 0.0065)
    panel.label('UP', u - 0.045, -0.06, 0.0065)
  }

  /** The flap lever on the right of the thrust levers, with a detent for each setting. */
  protected flapLever(panel: Panel, u: number) {
    const c = game.pilot.controls
    const labels = this.spec.flapLabels
    const notches = labels.length - 1
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        'FLAPS',
        panel.at(u, 0.1, 0.07),
        panel.at(u, -0.08, 0.07),
        panel.at(u, 0.01, -0.05),
        {
          get: () => c.flapNotch / notches,
          set: value => {
            if (game.getState().status === 'flying') c.flapNotch = Math.round(value * notches)
          },
          detents: labels.map((_, i) => i / notches),
          knob: { color: 0xd8d8d4, shape: 'box' },
          state: () => labels[c.flapNotch]
        }
      )
    )
    panel.label('FLAPS', u, 0.14, 0.007)
    labels.forEach((label, i) => {
      panel.label(label.toUpperCase(), u + 0.045, 0.1 - (0.18 * i) / notches, 0.0065)
    })
  }

  /** An engine's start lever or fuel control switch: up runs the engine, down cuts its fuel. */
  protected fuelLever(panel: Panel, i: number, u: number, v: number, shape: 'box' | 'pull') {
    const c = game.pilot.controls
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        `ENGINE ${i + 1} FUEL`,
        panel.at(u, v - 0.018, 0.025),
        panel.at(u, v + 0.018, 0.045),
        panel.at(u, v - 0.01, -0.03),
        {
          get: () => (c.engineSwitches[i] ? 1 : 0),
          set: (value, released) => {
            if (released && value > 0.5 !== c.engineSwitches[i]) key(`Digit${i + 1}`)
          },
          detents: [0, 1],
          knob: { color: 0x202224, shape },
          state: () => (c.engineSwitches[i] ? 'RUN' : 'CUTOFF')
        }
      )
    )
  }

  /** The parking brake handle: pull it up to set it. */
  protected parkingBrake(panel: Panel, u: number, v: number) {
    const c = game.pilot.controls
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        'PARKING BRAKE',
        panel.at(u, v, 0.02),
        panel.at(u, v, 0.065),
        panel.at(u, v, -0.03),
        {
          get: () => (c.parkingBrake ? 1 : 0),
          set: (value, released) => {
            if (released) c.parkingBrake = value > 0.5
          },
          detents: [0, 1],
          knob: { color: 0xb01c1c, shape: 'tee' },
          state: () => (c.parkingBrake ? 'SET' : 'OFF')
        }
      )
    )
    panel.label('PARK BRAKE', u, v - 0.03, 0.0065)
    this.lamp(panel, u - 0.045, v, 0.016, 0.012, 'red', () => game.sim.powered && c.parkingBrake)
  }

  /**
   * An engine fire handle: with the engine's fuel cut off, pull it to put the fire out. The
   * light under it glows red while the engine burns. `engine` is null for the APU's.
   */
  protected fireHandle(panel: Panel, label: string, u: number, v: number, engine: number | null) {
    let pulled = false
    const fire = () => engine !== null && (game.sim.engines[engine]?.fire ?? false)
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        label,
        panel.at(u, v, 0.02),
        panel.at(u, v, 0.06),
        panel.at(u, v, -0.03),
        {
          get: () => (pulled ? 1 : 0),
          set: (value, released) => {
            if (!released) return
            pulled = value > 0.5
            if (pulled && engine !== null) {
              game.sim.extinguish(engine, game.pilot.controls.engineSwitches[engine])
            }
          },
          detents: [0, 1],
          knob: { color: 0xc01e1e, shape: 'tee' },
          state: () => (fire() ? 'FIRE: cut the fuel, then pull' : pulled ? 'PULLED' : 'IN')
        }
      )
    )
    panel.label(label, u, v + 0.03, 0.007)
    this.lamp(panel, u, v - 0.026, 0.045, 0.01, 'red', fire)
  }

  /** An engine start switch: GRD cranks it and drops back to OFF once the engine runs. */
  protected startSwitch(panel: Panel, label: string, u: number, v: number, i: number) {
    const names = ['GRD', 'OFF', 'CONT', 'FLT']
    this.deck.knob(panel, label, u, v, {
      step: 30 * DEG,
      radius: 0.013,
      turn: clicks => {
        this.starters[i] = Math.min(3, Math.max(0, this.starters[i] + clicks))
      },
      pointer: () => (this.starters[i] - 1) * 50 * DEG,
      state: () => names[this.starters[i]]
    })
  }

  /** The aft pedestal's radio and transponder faces. */
  protected radios(panel: Panel, v: number, colour = '#ff9a3a') {
    const d = this.deck
    d.plate(panel, -0.1, v, 0.17, 0.026, 'VHF 1   118.70   121.50', colour)
    d.plate(panel, 0.1, v, 0.17, 0.026, 'VHF 2   121.50   123.45', colour)
    d.plate(panel, -0.1, v - 0.05, 0.17, 0.026, 'NAV 1   110.30   CRS 090', colour)
    d.plate(panel, 0.1, v - 0.05, 0.17, 0.026, 'XPDR   2000   TA/RA', colour)
  }

  protected tick() {
    for (const lamp of this.lamps) {
      lamp.material.color.setHex(lamp.colours[lamp.on() ? 0 : 1])
    }
    const { sim } = game
    const c = game.pilot.controls
    // A start switch at GRD drops back to OFF once its engine runs
    for (let i = 0; i < this.starters.length; i++) {
      if (this.starters[i] === 0 && sim.engines[i]?.running) this.starters[i] = 1
    }
    // Armed spoilers rise on touchdown
    if (!sim.onGround) this.airborne = true
    else if (this.airborne) {
      this.airborne = false
      if (this.speedbrakeArmed && !c.speedBrake) key('KeyB')
      this.speedbrakeArmed = false
    }
  }
}

/** The Boeing 737 MAX 8: four large displays, the classic overhead, and stab trim wheels. */
class B737Cockpit extends BoeingCockpit {
  private command: 'A' | 'B' = 'A'
  private readonly course = [0, 0]

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const left = -0.5
    const right = 2 * CL + 0.5
    this.shell(left, right, 0.26, [-0.14, 0.34], 0.07)
    this.seatsAndYokes(0.2, left, right)

    // Main panel: a display for each pilot, engine display above the lower display
    const top = SHIELD_BOTTOM
    const bottom = -0.72
    const main = d.panel(
      [CL, (top + bottom) / 2, PANEL_Z],
      right - left,
      top - bottom,
      [0, 0, 0],
      MATERIALS.boeing,
      0.3
    )
    const v = (y: number) => y - (top + bottom) / 2
    const u = (x: number) => x - CL
    const row = v(-0.335)
    d.screen(main, u(0.035), row, DU.w, DU.h, sideBySide(boeingPfd, navigationDisplay), 15)
    d.screen(main, 0, row, DU.w, DU.h, engineDisplay(spec), 8)
    d.screen(
      main,
      0,
      v(-0.585),
      DU.w,
      DU.h,
      systemsPage(spec, () => this.speedbrakeArmed),
      4
    )
    d.screen(main, u(2 * CL - 0.035), row, DU.w, DU.h, sideBySide(navigationDisplay, boeingPfd), 5)
    // Between the captain's display and the engine display: standby, spoilers, autobrake
    d.screen(main, u(0.29), v(-0.305), 0.075, 0.075, primaryFlight, 4)
    this.lamp(main, u(0.29), v(-0.228), 0.05, 0.011, 'green', () => this.speedbrakeArmed)
    main.label('SPEEDBRAKE ARMED', u(0.29), v(-0.245), 0.0055)
    const autobrake = ['RTO', 'OFF', '1', '2', '3', 'MAX']
    let brake = 1
    d.knob(main, 'AUTO BRAKE', u(0.29), v(-0.4), {
      step: 30 * DEG,
      radius: 0.012,
      turn: clicks => {
        brake = Math.min(5, Math.max(0, brake + clicks))
      },
      pointer: () => (brake - 1) * 40 * DEG,
      state: () => autobrake[brake]
    })
    // Right of the engine display: the gear lever under its three green and red lights
    const gear = u(0.81)
    main.label('LANDING GEAR', gear, v(-0.215), 0.0065)
    for (const [dx, label] of [
      [-0.03, 'L'],
      [0, 'N'],
      [0.03, 'R']
    ] as const) {
      const g = () => game.sim.gearPosition
      this.lamp(
        main,
        gear + dx,
        v(-0.235),
        0.022,
        0.012,
        'green',
        () => game.sim.powered && g() >= 0.99
      )
      this.lamp(main, gear + dx, v(-0.255), 0.022, 0.012, 'red', () => {
        const p = g()
        return game.sim.powered && p > 0.01 && p < 0.99
      })
      main.label(label, gear + dx, v(-0.27), 0.006)
    }
    this.gearLever(main, gear, v(-0.345))
    // Outboard of each display: the clock
    for (const x of [-0.3, 2 * CL + 0.3]) {
      d.plate(main, u(x), v(-0.3), 0.07, 0.03, '12:00:00', '#4be36f')
      main.label('CLOCK', u(x), v(-0.275), 0.007)
    }

    this.glareshield737(right - left)
    this.overhead737(d.panel([CL, 0.37, -0.25], 0.78, 0.7, [1.27, 0, 0], MATERIALS.boeing, 0.1))
    this.pedestal737()

    this.tablet = {
      position: new Vector3(-0.4, -0.27, -0.18),
      rotation: this.tablet.rotation
    }
    this.checklists = this.checklist737()
    this.finish()
  }

  /** The mode control panel, both EFIS panels, and the warning lights along the glareshield. */
  private glareshield737(width: number) {
    const d = this.deck
    const face = (u: number, w: number, material: Material) =>
      d.panel([CL + u, -0.145, SHIELD_BACK + 0.006], w, 0.08, [-0.12, 0, 0], material, 0.02)
    const turnCourse = (i: number) => (clicks: number) => {
      this.course[i] = (((this.course[i] + clicks) % 360) + 360) % 360
    }
    const command = (which: 'A' | 'B') => () => {
      if (!(autopilot().on && this.command !== which)) key('KeyZ')
      this.command = which
    }
    const n1 = () =>
      autothrottle().on &&
      autopilot().on &&
      (autopilot().vertical === 'FLCH' || autopilot().vertical === 'VNAV') &&
      autopilot().altitude > game.sim.position.y + 60
    const engageThrottle = () => {
      if (!autothrottle().on) key('KeyX')
    }
    const mcp = face(0, 0.84, MATERIALS.boeing)
    const total = this.modeControlPanel(mcp, [
      {
        window: 'COURSE',
        text: () => String(this.course[0]).padStart(3, '0'),
        turn: turnCourse(0),
        hint: 'turn to set the course'
      },
      { toggle: 'F/D', ...this.latch('fd1', true) },
      { toggle: 'A/T ARM', get: () => autothrottle().on, set: () => key('KeyX') },
      { button: 'N1', press: engageThrottle, lit: n1 },
      { button: 'SPEED', press: engageThrottle, lit: () => autothrottle().on && !n1() },
      {
        window: 'IAS/MACH',
        text: speedText,
        turn: clicks => game.pilot.adjust('speed', clicks),
        hint: 'turn to set the speed'
      },
      { button: 'LVL CHG', press: vertical('FLCH'), lit: verticalIs('FLCH') },
      { button: 'VNAV', press: vertical('VNAV'), lit: verticalIs('VNAV') },
      {
        window: 'HEADING',
        text: () => degreesText(autopilot().heading),
        turn: clicks => game.pilot.adjust('heading', clicks),
        press: lateral('HDG'),
        hint: 'turn to set, push for heading select'
      },
      { button: 'HDG SEL', press: lateral('HDG'), lit: lateralIs('HDG') },
      { button: 'LNAV', press: lateral('NAV'), lit: lateralIs('NAV') },
      { button: 'VOR LOC', press: lateral('APP'), lit: lateralIs('APP') },
      {
        button: 'APP',
        press: flying(() => game.toggleApproachAutopilot()),
        lit: () => game.pilot.flyingApproach
      },
      {
        window: 'ALTITUDE',
        text: altitudeText,
        turn: clicks => game.pilot.adjust('altitude', clicks),
        hint: 'turn to set the altitude'
      },
      { button: 'ALT HLD', press: vertical('ALT'), lit: verticalIs('ALT') },
      {
        window: 'VERT SPEED',
        text: climbText,
        turn: clicks => game.pilot.adjust('verticalSpeed', clicks),
        hint: 'turn to set the climb rate'
      },
      { button: 'V/S', press: vertical('VS'), lit: verticalIs('VS') },
      { button: 'CMD A', press: command('A'), lit: () => autopilot().on && this.command === 'A' },
      { button: 'CMD B', press: command('B'), lit: () => autopilot().on && this.command === 'B' },
      {
        window: 'COURSE',
        text: () => String(this.course[1]).padStart(3, '0'),
        turn: turnCourse(1),
        hint: 'turn to set the course'
      }
    ])
    const efis = total / 2 + 0.1
    this.efisPanel(face(-efis, 0.17, MATERIALS.boeing))
    this.efisPanel(face(efis, 0.17, MATERIALS.boeing))
    const lights = Math.min(efis + 0.15, width / 2 - 0.08)
    this.masterLights(face(-lights, 0.13, MATERIALS.panel), 0)
    this.masterLights(face(lights, 0.13, MATERIALS.panel), 0)
  }

  /**
   * The forward overhead: electrics, fuel pumps, hydraulics, bleeds, anti-ice and window heat,
   * then the lights and engine start switches along its front edge.
   */
  private overhead737(panel: Panel) {
    const d = this.deck
    const c = game.pilot.controls
    const section = (label: string, u: number, v: number) => panel.label(label, u, v, 0.0085)
    const latch = (label: string, u: number, v: number, on = false) =>
      d.rocker(panel, label, u, v, this.latch(label + u, on))

    section('ELECTRICAL', -0.27, 0.33)
    d.rocker(panel, 'BAT', -0.34, 0.27, { get: () => c.battery, set: () => key('KeyO') })
    latch('STBY PWR', -0.27, 0.27, true)
    latch('GEN 1', -0.34, 0.17)
    latch('APU GEN', -0.27, 0.17)
    latch('GEN 2', -0.2, 0.17)
    d.plate(panel, -0.27, 0.09, 0.13, 0.026, 'DC 28 V    AC 115 V', '#4be36f')

    section('FUEL', 0, 0.33)
    const pump = (label: string, u: number, v: number) =>
      d.rocker(panel, label, u, v, { get: () => c.fuelPumps, set: () => key('KeyU') })
    pump('CTR L', -0.035, 0.27)
    pump('CTR R', 0.035, 0.27)
    let crossfeed = false
    d.knob(panel, 'CROSSFEED', 0, 0.175, {
      step: 45 * DEG,
      radius: 0.012,
      turn: () => {
        crossfeed = !crossfeed
      },
      pointer: () => (crossfeed ? 90 * DEG : 0),
      state: () => (crossfeed ? 'OPEN' : 'CLOSED')
    })
    pump('L AFT', -0.135, 0.09)
    pump('L FWD', -0.075, 0.09)
    pump('R FWD', 0.075, 0.09)
    pump('R AFT', 0.135, 0.09)

    section('PRESSURIZATION', 0.27, 0.33)
    d.plate(panel, 0.27, 0.285, 0.14, 0.026, 'CAB ALT 8000   RATE 0', '#ffffff')
    latch('PACK L', 0.22, 0.17, true)
    latch('ISOLATION', 0.27, 0.17, true)
    latch('PACK R', 0.32, 0.17, true)
    section('ANTI-ICE', 0.27, 0.12)
    latch('ENG 1', 0.22, 0.07)
    latch('WING', 0.27, 0.07)
    latch('ENG 2', 0.32, 0.07)

    section('HYDRAULIC PUMPS', -0.27, -0.02)
    latch('ENG 1', -0.35, -0.08, true)
    latch('ELEC 2', -0.295, -0.08, true)
    latch('ELEC 1', -0.24, -0.08, true)
    latch('ENG 2', -0.185, -0.08, true)
    section('BLEED AIR', 0, -0.02)
    latch('ENG 1', -0.06, -0.08, true)
    latch('APU', 0, -0.08)
    latch('ENG 2', 0.06, -0.08, true)
    section('WINDOW HEAT', 0.255, -0.02)
    for (const [i, label] of ['L SIDE', 'L FWD', 'R FWD', 'R SIDE'].entries()) {
      latch(label, 0.18 + i * 0.05, -0.08, true)
    }

    const apu = ['OFF', 'ON', 'START']
    let apuAt = 0
    d.knob(panel, 'APU', -0.33, -0.19, {
      step: 30 * DEG,
      radius: 0.012,
      turn: clicks => {
        apuAt = Math.min(2, Math.max(0, apuAt + clicks))
      },
      pointer: () => (apuAt - 1) * 45 * DEG,
      state: () => apu[apuAt]
    })
    latch('NO SMOKING', 0.24, -0.19, true)
    latch('SEAT BELTS', 0.31, -0.19, true)

    // Front row: landing and taxi lights, the start switches, then the outside lights
    section('ENGINE START', 0, -0.21)
    this.startSwitch(panel, '1', -0.05, -0.28, 0)
    this.startSwitch(panel, '2', 0.05, -0.28, 1)
    const landing = { get: () => game.pilot.landingLights, set: () => key('KeyL') }
    d.rocker(panel, 'L LAND', -0.355, -0.29, landing)
    d.rocker(panel, 'R LAND', -0.3, -0.29, landing)
    latch('L TURNOFF', -0.24, -0.29)
    latch('R TURNOFF', -0.18, -0.29)
    latch('TAXI', -0.125, -0.29)
    latch('LOGO', 0.13, -0.29)
    latch('POSITION', 0.185, -0.29, true)
    latch('ANTI COLL', 0.24, -0.29)
    latch('WING', 0.295, -0.29)
    latch('WHEEL WELL', 0.35, -0.29)
  }

  /**
   * The pedestal: flight computer keypads at the front, then the control stand with the
   * thrust, speed brake, flap, and start levers and the trim wheels, then the fire handles
   * and radios.
   */
  private pedestal737() {
    const d = this.deck
    const width = 0.42
    d.box([width, 0.26, 1.0], [CL, -0.95, -0.28], MATERIALS.boeing)
    const keypads = d.panel([CL, -0.763, -0.668], width, 0.24, [-1.2, 0, 0], MATERIALS.boeing, 0.2)
    this.glass(keypads, -0.104, -0.005, 0.135, 0.215, cdu, 1, 2200)
    this.glass(keypads, 0.104, -0.005, 0.135, 0.215, cdu, 0.5, 2200)

    const stand = d.panel([CL, -0.8, -0.33], width, 0.46, [-1.5, 0, 0], MATERIALS.boeing, 0.06)
    // The raised quadrant the thrust levers come out of
    const hump = stand.at(0, -0.01, 0.015)
    d.box([0.15, 0.03, 0.3], [hump.x, hump.y, hump.z], MATERIALS.frame, [-1.5 + Math.PI / 2, 0, 0])
    this.thrustLevers(stand, 0.09)
    this.speedbrakeLever(stand, -0.15)
    this.flapLever(stand, 0.15)
    stand.label('START LEVERS', 0, -0.15, 0.0065)
    stand.label('IDLE', 0, -0.172, 0.006)
    stand.label('CUTOFF', 0, -0.208, 0.006)
    this.fuelLever(stand, 0, -0.045, -0.19, 'box')
    this.fuelLever(stand, 1, 0.045, -0.19, 'box')
    this.parkingBrake(stand, -0.15, -0.185)
    stand.label('STAB TRIM', 0.155, -0.16, 0.0065)
    d.rocker(stand, 'MAIN', 0.13, -0.2, this.latch('stab main', true))
    d.rocker(stand, 'AUTO', 0.18, -0.2, this.latch('stab auto', true))
    // Stab trim wheels on both sides of the control stand
    const c = game.pilot.controls
    for (const side of [-1, 1]) {
      const centre = new Vector3(CL + side * 0.228, -0.85, -0.36)
      d.add(
        new TrimWheel(d.group, d.buzz, centre, 0.1, {
          get: () => c.trim,
          set: trim => {
            c.trim = trim
          }
        })
      )
      const disc = new Mesh(new CylinderGeometry(0.094, 0.094, 0.012, 24), MATERIALS.black)
      disc.rotation.z = Math.PI / 2
      disc.position.copy(centre).setX(CL + side * 0.218)
      d.group.add(disc)
    }

    const aft = d.panel([CL, -0.8, 0.07], width, 0.34, [-1.5, 0, 0], MATERIALS.boeing, 0.06)
    aft.label('FIRE', 0, 0.16, 0.008)
    this.fireHandle(aft, 'ENG 1', -0.11, 0.1, 0)
    this.fireHandle(aft, 'APU', 0, 0.1, null)
    this.fireHandle(aft, 'ENG 2', 0.11, 0.1, 1)
    this.radios(aft, 0.0)
  }

  private checklist737(): Checklist[] {
    const { pilot } = game
    const c = pilot.controls
    const sim = () => game.sim
    return [
      {
        title: 'Before Start',
        items: [
          { text: 'Battery: ON', done: () => c.battery },
          { text: 'Fuel pumps: ON', done: () => c.fuelPumps },
          { text: 'Parking brake: SET', done: () => c.parkingBrake },
          { text: 'Thrust levers: CLOSED', done: () => c.throttle < 0.05 && !c.reverse }
        ]
      },
      {
        title: 'Engine Start',
        items: [
          {
            text: 'Engine 2 start switch: GRD',
            done: () => this.starters[1] === 0 || sim().engines[1]?.running
          },
          { text: 'Start lever 2: IDLE', done: () => c.engineSwitches[1] },
          {
            text: 'Engine 1 start switch: GRD',
            done: () => this.starters[0] === 0 || sim().engines[0]?.running
          },
          { text: 'Start lever 1: IDLE', done: () => c.engineSwitches[0] },
          {
            text: 'Engines: stable at idle',
            done: () => sim().enginesRunning === sim().engines.length
          }
        ]
      },
      {
        title: 'Before Takeoff',
        items: [
          { text: 'Flaps: 5 or 15', done: () => c.flapNotch === 1 || c.flapNotch === 2 },
          { text: 'Landing lights: ON', done: () => pilot.landingLights },
          { text: 'Parking brake: RELEASED', done: () => !c.parkingBrake },
          { text: 'Speed brake: DOWN', done: () => !c.speedBrake },
          { text: 'Thrust: takeoff, A/T ARM', done: () => c.throttle > 0.85 },
          { text: 'Positive climb, gear: UP', done: () => !sim().onGround && !c.gearDown }
        ]
      },
      {
        title: 'Approach and Landing',
        items: [
          { text: 'APP: pressed', done: () => pilot.flyingApproach },
          { text: 'Speed brake: ARMED', done: () => this.speedbrakeArmed || c.speedBrake },
          { text: 'Gear: DOWN, three green', done: () => c.gearDown },
          { text: 'Flaps: 30 or 40', done: () => c.flapNotch >= this.spec.flapLabels.length - 2 },
          { text: 'Touchdown, reverse thrust', done: () => sim().onGround && c.reverse },
          { text: 'Flaps: UP after landing', done: () => sim().onGround && c.flapNotch === 0 }
        ]
      }
    ]
  }
}

/** The Boeing 787-9: five large displays, a head-up display, and big four-pane windows. */
class B787Cockpit extends BoeingCockpit {
  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const left = -0.6
    const right = 2 * CL + 0.6
    this.shell(left, right, 0.3, [0.42], 0.06)
    this.seatsAndYokes(0.24, left, right)

    // Main panel: four displays across, then the standby, autobrake, and gear lever below
    const top = SHIELD_BOTTOM
    const bottom = -0.585
    const main = d.panel(
      [CL, (top + bottom) / 2, PANEL_Z],
      right - left,
      top - bottom,
      [0, 0, 0],
      MATERIALS.grey,
      0.3
    )
    const v = (y: number) => y - (top + bottom) / 2
    const row = v(-0.335)
    const pitch = 0.33
    d.screen(main, -1.5 * pitch, row, DU.w, DU.h, sideBySide(auxStrip, boeingPfd, 0.25), 15)
    d.screen(
      main,
      -0.5 * pitch,
      row,
      DU.w,
      DU.h,
      sideBySide(navigationDisplay, engineDisplay(spec)),
      8
    )
    d.screen(
      main,
      0.5 * pitch,
      row,
      DU.w,
      DU.h,
      sideBySide(
        systemsPage(spec, () => this.speedbrakeArmed),
        navigationDisplay
      ),
      4
    )
    d.screen(main, 1.5 * pitch, row, DU.w, DU.h, sideBySide(boeingPfd, auxStrip, 0.75), 5)
    d.screen(main, 0, v(-0.52), 0.06, 0.06, primaryFlight, 2)
    const autobrake = ['RTO', 'OFF', '1', '2', '3', '4', 'MAX']
    let brake = 1
    d.knob(main, 'AUTOBRAKE', -0.12, v(-0.53), {
      step: 30 * DEG,
      radius: 0.012,
      turn: clicks => {
        brake = Math.min(6, Math.max(0, brake + clicks))
      },
      pointer: () => (brake - 1) * 35 * DEG,
      state: () => autobrake[brake]
    })
    this.gearLever(main, 0.13, v(-0.52))

    this.glareshield787(right - left)
    this.headUp()
    this.overhead787(d.panel([CL, 0.41, -0.25], 0.8, 0.7, [1.27, 0, 0], MATERIALS.grey, 0.1))
    this.pedestal787()

    this.tablet = {
      position: new Vector3(-0.47, -0.27, -0.18),
      rotation: this.tablet.rotation
    }
    this.checklists = this.checklist787()
    this.finish()
  }

  /** The 787's mode control panel, EFIS panels, and warning lights. */
  private glareshield787(width: number) {
    const d = this.deck
    const face = (u: number, w: number, material: Material) =>
      d.panel([CL + u, -0.145, SHIELD_BACK + 0.006], w, 0.08, [-0.12, 0, 0], material, 0.02)
    const engageThrottle = () => {
      if (!autothrottle().on) key('KeyX')
    }
    const mcp = face(0, 0.86, MATERIALS.grey)
    const total = this.modeControlPanel(mcp, [
      { toggle: 'F/D', ...this.latch('fd1', true) },
      { toggle: 'A/T ARM', get: () => autothrottle().on, set: () => key('KeyX') },
      { button: 'CLB CON', press: engageThrottle },
      { button: 'A/T', press: engageThrottle, lit: () => autothrottle().on },
      {
        window: 'IAS/MACH',
        text: speedText,
        turn: clicks => game.pilot.adjust('speed', clicks),
        hint: 'turn to set the speed'
      },
      { button: 'LNAV', press: lateral('NAV'), lit: lateralIs('NAV') },
      { button: 'VNAV', press: vertical('VNAV'), lit: verticalIs('VNAV') },
      { button: 'FLCH', press: vertical('FLCH'), lit: verticalIs('FLCH') },
      {
        window: 'HDG/TRK',
        text: () => degreesText(autopilot().heading),
        turn: clicks => game.pilot.adjust('heading', clicks),
        press: lateral('HDG'),
        hint: 'turn to set, push for heading select'
      },
      { button: 'HDG HOLD', press: lateral('HDG'), lit: lateralIs('HDG') },
      {
        window: 'V/S FPA',
        text: climbText,
        turn: clicks => game.pilot.adjust('verticalSpeed', clicks),
        hint: 'turn to set the climb rate'
      },
      { button: 'V/S', press: vertical('VS'), lit: verticalIs('VS') },
      {
        window: 'ALTITUDE',
        text: altitudeText,
        turn: clicks => game.pilot.adjust('altitude', clicks),
        hint: 'turn to set the altitude'
      },
      { button: 'ALT HOLD', press: vertical('ALT'), lit: verticalIs('ALT') },
      { button: 'LOC', press: lateral('APP'), lit: lateralIs('APP') },
      {
        button: 'APP',
        press: flying(() => game.toggleApproachAutopilot()),
        lit: () => game.pilot.flyingApproach
      },
      { button: 'A/P', press: () => key('KeyZ'), lit: () => autopilot().on },
      { toggle: 'F/D', ...this.latch('fd2', true) }
    ])
    const efis = total / 2 + 0.1
    this.efisPanel(face(-efis, 0.17, MATERIALS.grey))
    this.efisPanel(face(efis, 0.17, MATERIALS.grey))
    const lights = Math.min(efis + 0.15, width / 2 - 0.08)
    this.masterLights(face(-lights, 0.13, MATERIALS.panel), 0)
    this.masterLights(face(lights, 0.13, MATERIALS.panel), 0)
  }

  /**
   * The captain's head-up display: a combiner glass hung in front of the eye, its picture
   * drawn to scale so the horizon and flight path sit on the world outside.
   */
  private headUp() {
    const d = this.deck
    const distance = 0.33
    const w = 0.17
    const h = 0.12
    const field = 2 * Math.atan(w / 2 / distance) * DEGREES
    const combiner = new Display(w, h, 3600, headUpDisplay(field), 10)
    combiner.mesh.position.set(0, 0, -distance)
    d.group.add(combiner.mesh)
    d.track(combiner)
    combiner.draw()
    const tint = new Mesh(new PlaneGeometry(w, h), MATERIALS.glass)
    tint.position.set(0, 0, -distance - 0.002)
    d.group.add(tint)
    // Its frame, and the arms back to the projector over the captain's head
    d.box([w + 0.012, 0.014, 0.012], [0, h / 2 + 0.003, -distance], MATERIALS.frame)
    d.box([w + 0.012, 0.006, 0.008], [0, -h / 2, -distance], MATERIALS.frame)
    for (const side of [-1, 1]) {
      d.box([0.006, h, 0.008], [side * (w / 2 + 0.003), 0, -distance], MATERIALS.frame)
      d.beam(
        new Vector3(side * 0.06, h / 2 + 0.008, -distance),
        new Vector3(side * 0.06, 0.42, -0.06),
        0.012,
        MATERIALS.frame
      )
    }
    d.box([0.18, 0.1, 0.3], [0, 0.46, 0], MATERIALS.frame)
  }

  /**
   * The 787's overhead: electrics, fuel with jettison, hydraulics, the APU and start
   * switches, the fire handles, and the lights along its front edge.
   */
  private overhead787(panel: Panel) {
    const d = this.deck
    const c = game.pilot.controls
    const section = (label: string, u: number, v: number) => panel.label(label, u, v, 0.0085)
    const size = { w: 0.03, h: 0.02 }
    const push = (label: string, u: number, v: number, on = true) => {
      const state = this.latch(label + u, on)
      d.button(panel, label, u, v, {
        press: () => state.set(!state.get()),
        lit: () => (state.get() ? 'on' : 'off'),
        size
      })
    }
    const latch = (label: string, u: number, v: number, on = false) =>
      d.rocker(panel, label, u, v, this.latch(label + u, on))

    section('ELECTRICAL', -0.27, 0.33)
    d.button(panel, 'BATTERY', -0.34, 0.27, {
      press: () => key('KeyO'),
      lit: () => (c.battery ? 'on' : 'off'),
      size
    })
    push('APU GEN', -0.27, 0.27)
    push('L GEN', -0.34, 0.18)
    push('R GEN', -0.2, 0.18)
    push('L BUS TIE', -0.34, 0.09)
    push('R BUS TIE', -0.2, 0.09)

    section('FUEL', 0, 0.33)
    const pump = (label: string, u: number, v: number) =>
      d.button(panel, label, u, v, {
        press: () => key('KeyU'),
        lit: () => (c.fuelPumps ? 'on' : 'off'),
        size
      })
    pump('CTR L', -0.04, 0.27)
    pump('CTR R', 0.04, 0.27)
    pump('L FWD', -0.12, 0.18)
    pump('L AFT', -0.12, 0.09)
    pump('R FWD', 0.12, 0.18)
    pump('R AFT', 0.12, 0.09)
    push('CROSSFEED', 0, 0.18, false)
    d.button(panel, 'JETTISON', 0, 0.09, {
      press: () => key('Minus'),
      lit: () => (c.fuelDump ? 'alert' : 'off'),
      size
    })

    section('HYDRAULICS', 0.27, 0.33)
    push('L ENG', 0.2, 0.27)
    push('R ENG', 0.34, 0.27)
    push('C1 ELEC', 0.2, 0.18)
    push('C2 ELEC', 0.34, 0.18)
    push('WING A/I', 0.2, 0.09, false)
    push('ENG A/I', 0.34, 0.09, false)

    const apu = ['OFF', 'ON', 'START']
    let apuAt = 0
    d.knob(panel, 'APU', -0.3, -0.06, {
      step: 30 * DEG,
      radius: 0.013,
      turn: clicks => {
        apuAt = Math.min(2, Math.max(0, apuAt + clicks))
      },
      pointer: () => (apuAt - 1) * 45 * DEG,
      state: () => apu[apuAt]
    })
    section('ENGINE START', 0, 0.005)
    this.startSwitch(panel, 'L', -0.05, -0.06, 0)
    this.startSwitch(panel, 'R', 0.05, -0.06, 1)
    section('WINDOW HEAT', 0.27, 0.0)
    for (const [i, label] of ['L SIDE', 'L FWD', 'R FWD', 'R SIDE'].entries()) {
      push(label, 0.165 + i * 0.07, -0.06)
    }

    this.fireHandle(panel, 'L ENG', -0.1, -0.17, 0)
    this.fireHandle(panel, 'APU', 0, -0.17, null)
    this.fireHandle(panel, 'R ENG', 0.1, -0.17, 1)
    latch('SEAT BELTS', 0.27, -0.18, true)
    latch('NO SMOKING', 0.33, -0.18, true)
    latch('EMER LIGHTS', -0.3, -0.18, true)

    const landing = { get: () => game.pilot.landingLights, set: () => key('KeyL') }
    const lights = ['LANDING L', 'NOSE', 'LANDING R', 'TURNOFF', 'TAXI']
    lights.forEach((label, i) => {
      const u = -0.35 + i * 0.065
      if (i < 3) d.rocker(panel, label, u, -0.29, landing)
      else latch(label, u, -0.29)
    })
    for (const [i, label] of ['BEACON', 'NAV', 'LOGO', 'WING', 'STROBE'].entries()) {
      latch(label, 0.09 + i * 0.065, -0.29, label === 'NAV')
    }
  }

  /**
   * The aisle stand: the lower display between two keypads at the front, the control stand
   * with thrust, speed brake, and flap levers and the fuel control switches, then the cursor
   * control devices and radios.
   */
  private pedestal787() {
    const d = this.deck
    d.box([0.5, 0.26, 1.05], [CL, -0.95, -0.28], MATERIALS.grey)
    const front = d.panel([CL, -0.7, -0.7], 0.56, 0.27, [-0.6, 0, 0], MATERIALS.grey, 0.25)
    d.screen(front, 0, 0, DU.w, DU.h, sideBySide(legsScreen, progressScreen), 2)
    this.glass(front, -0.215, 0, 0.1, 0.2, keypad, 0, 2000)
    this.glass(front, 0.215, 0, 0.1, 0.2, keypad, 0, 2000)

    const stand = d.panel([CL, -0.8, -0.37], 0.5, 0.5, [-1.5, 0, 0], MATERIALS.grey, 0.06)
    const hump = stand.at(0, -0.01, 0.015)
    d.box([0.16, 0.03, 0.3], [hump.x, hump.y, hump.z], MATERIALS.frame, [-1.5 + Math.PI / 2, 0, 0])
    this.thrustLevers(stand, 0.1)
    this.speedbrakeLever(stand, -0.17)
    this.flapLever(stand, 0.17)
    stand.label('FUEL CONTROL', 0, -0.15, 0.0065)
    stand.label('RUN', 0, -0.172, 0.006)
    stand.label('CUTOFF', 0, -0.208, 0.006)
    this.fuelLever(stand, 0, -0.05, -0.19, 'pull')
    this.fuelLever(stand, 1, 0.05, -0.19, 'pull')
    this.parkingBrake(stand, -0.17, -0.19)
    stand.label('STAB', 0.17, -0.16, 0.0065)
    d.rocker(stand, 'L', 0.15, -0.2, this.latch('stab l', true))
    d.rocker(stand, 'R', 0.19, -0.2, this.latch('stab r', true))

    const aft = d.panel([CL, -0.8, 0.07], 0.5, 0.38, [-1.5, 0, 0], MATERIALS.grey, 0.06)
    // Cursor control devices: a palm rest and a trackball each side
    for (const side of [-1, 1]) {
      const rest = aft.at(side * 0.18, 0.11, 0.015)
      d.box([0.1, 0.03, 0.12], [rest.x, rest.y, rest.z], MATERIALS.black)
      const ball = new Mesh(new SphereGeometry(0.014, 12, 8), MATERIALS.white)
      ball.position.copy(aft.at(side * 0.18, 0.14, 0.032))
      d.group.add(ball)
      aft.label('CCD', side * 0.18, 0.18, 0.007)
    }
    this.radios(aft, 0.02, '#e8ecef')
  }

  private checklist787(): Checklist[] {
    const { pilot } = game
    const c = pilot.controls
    const sim = () => game.sim
    return [
      {
        title: 'Before Start',
        items: [
          { text: 'Battery: ON', done: () => c.battery },
          { text: 'Fuel pumps: ON', done: () => c.fuelPumps },
          { text: 'Parking brake: SET', done: () => c.parkingBrake },
          { text: 'Thrust levers: IDLE', done: () => c.throttle < 0.05 && !c.reverse }
        ]
      },
      {
        title: 'Engine Start',
        items: [
          { text: 'Fuel control switch L: RUN', done: () => c.engineSwitches[0] },
          { text: 'Fuel control switch R: RUN', done: () => c.engineSwitches[1] },
          {
            text: 'Engines: stable at idle',
            done: () => sim().enginesRunning === sim().engines.length
          }
        ]
      },
      {
        title: 'Before Takeoff',
        items: [
          { text: 'Flaps: 5 to 20', done: () => c.flapNotch >= 1 && c.flapNotch <= 3 },
          { text: 'Landing lights: ON', done: () => pilot.landingLights },
          { text: 'Parking brake: RELEASED', done: () => !c.parkingBrake },
          { text: 'Thrust: takeoff, A/T ARM', done: () => c.throttle > 0.85 },
          { text: 'Positive climb, gear: UP', done: () => !sim().onGround && !c.gearDown }
        ]
      },
      {
        title: 'Approach and Landing',
        items: [
          { text: 'APP: pressed', done: () => pilot.flyingApproach },
          { text: 'Speed brake: ARMED', done: () => this.speedbrakeArmed || c.speedBrake },
          { text: 'Gear: DOWN', done: () => c.gearDown },
          { text: 'Flaps: 30', done: () => c.flapNotch === this.spec.flapLabels.length - 1 },
          { text: 'Touchdown, reverse thrust', done: () => sim().onGround && c.reverse },
          { text: 'Flaps: UP after landing', done: () => sim().onGround && c.flapNotch === 0 }
        ]
      }
    ]
  }
}

/** The cockpits this file builds, by aircraft id. */
export const COCKPITS = { b737: B737Cockpit, b787: B787Cockpit }
