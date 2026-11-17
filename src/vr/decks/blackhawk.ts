import { Euler, Mesh, PlaneGeometry, Vector3 } from 'three'
import { game } from '../../game/game'
import type { AircraftSpec } from '../../sim/aircraft'
import { LAMPS, ROTORLESS_LAMPS } from '../../ui/lamps'
import { FEET_PER_METRE, KNOTS_PER_MS } from '../../ui/telemetry'
import { key } from '../cockpit'
import { type Buzz, Lever, Stick } from '../controls'
import { DeckCockpit, MATERIALS, type Panel } from '../deck'
import { AirspeedIndicator, Altimeter, AttitudeIndicator } from '../gauges'
import { engineDisplay, helicopterDisplay, navigationDisplay, primaryFlight } from '../glass'
import {
  Annunciator,
  Collective,
  CollectiveModel,
  CyclicModel,
  PAINT,
  Pedals,
  Shell
} from './blackhawk-parts'

/*
 * The Sikorsky UH-60M Black Hawk cockpit. The pilot sits right, so the centreline is left
 * of the eye. Four displays span the panel, the narrow overhead console carries the engine
 * power control levers, fuel selectors, and rotor brake, and the chin windows at the feet
 * show the ground under the nose.
 */

/** The centreline, left of the pilot's eye; the copilot's eye is as far again. */
const CL = -0.55
const COPILOT = 2 * CL
const FLOOR = -1.05
const ROOF = 0.445
/** The right door's inner face; the left door mirrors it across the centreline. */
const DOOR = 0.5
// The display's glass, 6 by 8 inches, standing upright
const MFD_W = 0.155
const MFD_H = 0.205
// Metres the cyclic grip moves from centre to full travel
const CYCLIC_TRAVEL = 0.1
const AMBER = 0xe08a10
const RED = 0xd01a12
const GREEN = 0x2bd35a

const mirror = (x: number) => 2 * CL - x
const flashing = () => Math.floor(performance.now() / 400) % 2 === 0

/** The primary flight display, with the rotor and torque readout above it and the radar altitude below. */
function flightPage(ctx: CanvasRenderingContext2D, w: number, h: number) {
  primaryFlight(ctx, w, h)
  const { sim } = game
  if (!sim.powered) return
  const band = (h - w) / 2
  ctx.font = `700 ${band * 0.5}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = sim.rotorSpeed < 0.95 && sim.enginesRunning > 0 ? '#ff4b3a' : '#4be36f'
  ctx.fillText(
    `NR ${Math.round(sim.rotorSpeed * 100)}%   TRQ ${Math.round(sim.rpm)}%`,
    w / 2,
    band / 2
  )
  ctx.fillStyle = '#e8ecef'
  const feet = Math.max(0, sim.altitudeAgl * FEET_PER_METRE)
  ctx.fillText(feet < 1500 ? `RAD ALT ${Math.round(feet)} FT` : 'RAD ALT ----', w / 2, h - band / 2)
}

/** The UH-60M Black Hawk cockpit. */
export class BlackHawkCockpit extends DeckCockpit {
  /** A kneeboard strapped to the pilot's right thigh, clear of the cyclic and the chin window. */
  tablet = { position: new Vector3(0.21, -0.62, -0.2), rotation: new Euler(-1.0, -0.3, 0, 'YXZ') }
  private readonly cyclic: Stick
  private readonly collective: Collective
  private readonly shell = new Shell()
  /** Engine power control levers: 0 is OFF, 0.5 IDLE, 1 FLY. The sim knows only off and on. */
  private readonly pcl = [1, 1]
  /** Engine emergency off T-handles, pulled. */
  private readonly pulled = [false, false]
  /** Switches the flight model has no use for, kept so they stay where the pilot set them. */
  private readonly local = {
    rotorBrake: false,
    apu: false,
    apuGenerator: false,
    position: true,
    antiCollision: true,
    search: false,
    pitot: true,
    antiIce1: false,
    antiIce2: false,
    sas1: true,
    sas2: true,
    trim: true,
    boost: true,
    stabilator: true
  }
  /** True while any caution shows, worked out once a frame. */
  private caution = false
  /** True after the master caution is pressed, until the cautions behind it clear. */
  private cautionReset = false
  private readonly cautions = LAMPS.filter(
    lamp =>
      !ROTORLESS_LAMPS.has(lamp.label) && !['NO POWER', 'ENGINE OFF', 'BRAKE'].includes(lamp.label)
  )

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const { pilot } = game
    const c = pilot.controls

    this.airframe()
    this.seat(0, 1)
    this.seat(COPILOT, -1)
    this.instrumentPanel()
    this.masterWarning(0)
    this.masterWarning(COPILOT)
    this.overheadFront(d.panel([CL, 0.215, -0.369], 0.34, 0.24, [1.0, 0, 0], PAINT.console, 0.05))
    this.overheadAft(d.panel([CL, 0.31, -0.02], 0.34, 0.5, [1.45, 0, 0], PAINT.console, 0.06))
    this.consoleFront(d.panel([CL, -0.607, -0.66], 0.28, 0.28, [-0.9, 0, 0], PAINT.console, 0.3))
    this.consoleAft(d.panel([CL, -0.745, -0.306], 0.28, 0.5, [-1.35, 0, 0], PAINT.console, 0.3))

    // The cyclic rises from the floor between the pilot's knees on a long stick
    this.cyclic = d.add(
      new Stick(
        d.group,
        d.buzz,
        new Vector3(0, -1.0, -0.47),
        new Vector3(0, -0.5, -0.41),
        CYCLIC_TRAVEL
      )
    )
    this.flight = this.cyclic

    // The collective on the pilot's left pivots behind the hip and lifts at the front
    const root = new Vector3(-0.32, -0.86, 0.12)
    this.collective = d.add(
      new Collective(
        d.group,
        d.buzz,
        new Vector3(-0.32, -0.76, -0.4),
        new Vector3(-0.32, -0.6, -0.36),
        root,
        {
          get: () => c.throttle,
          set: () => {},
          knob: { color: 0x1a1c1e, shape: 'pull' },
          state: () => `${Math.round(c.throttle * 100)}%`
        }
      )
    )
    this.throttles = [this.collective]
    // The collective's housing along the seat
    this.shell.box([0.05, 0.08, 0.3], [-0.32, -0.9, 0.12], PAINT.console)

    this.linkage()
    this.checklists = this.checklistsFor()
    this.shell.build(d.group)
    this.finish()
  }

  /** Floor, chin windows, windshield posts, doors, roof, and the back wall. */
  private airframe() {
    const s = this.shell
    const width = DOOR - mirror(DOOR)
    // Floor under the seats, back to the cabin
    s.box([width, 0.04, 1.6], [CL, FLOOR - 0.02, -0.04], MATERIALS.floor)
    // Keel between the chin windows, under the lower console
    s.box([0.4, 0.55, 0.7], [CL, -0.85, -1.18], PAINT.console)
    // Chin windows: open floor ahead of each pilot's pedals, framed
    for (const x of [0.02, mirror(0.02)]) {
      const half = 0.33
      const aft = new Vector3(0, -1.07, -0.84)
      const fore = new Vector3(0, -0.9, -1.5)
      const corner = (side: number, end: Vector3) => end.clone().setX(x + side * half)
      s.beam(corner(-1, aft), corner(1, aft), 0.04, PAINT.frame)
      s.beam(corner(-1, fore), corner(1, fore), 0.04, PAINT.frame)
      s.beam(corner(-1, aft), corner(-1, fore), 0.035, PAINT.frame)
      s.beam(corner(1, aft), corner(1, fore), 0.035, PAINT.frame)
      // A middle bow across the glass
      s.beam(
        corner(-1, aft).lerp(corner(-1, fore), 0.5),
        corner(1, aft).lerp(corner(1, fore), 0.5),
        0.018,
        PAINT.frame
      )
      const glass = new Mesh(new PlaneGeometry(half * 2, aft.distanceTo(fore)), PAINT.tint)
      glass.position.set(x, (aft.y + fore.y) / 2, (aft.z + fore.z) / 2)
      glass.rotation.x = -Math.PI / 2 + Math.atan2(fore.y - aft.y, aft.z - fore.z)
      this.deck.group.add(glass)
    }
    // Nose sides outboard of the chin windows, and the wall from the panel down to them
    for (const x of [0.43, mirror(0.43)]) {
      s.box([0.14, 0.6, 0.72], [x, -0.82, -1.16], PAINT.console)
    }
    s.sheet(CL, width - 0.1, [-0.5, -1.02], [-0.9, -1.52], 0.03, PAINT.console)

    // Glareshield over the panel, and the posts round the windshield
    s.box([width - 0.06, 0.035, 0.25], [CL, -0.155, -0.885], MATERIALS.black, [0.08, 0, 0])
    s.box([width - 0.06, 0.04, 0.03], [CL, -0.16, -0.77], MATERIALS.black)
    s.beam(new Vector3(CL, -0.15, -1.0), new Vector3(CL, ROOF - 0.01, -0.5), 0.06, PAINT.frame)
    for (const side of [1, -1]) {
      const x = (offset: number) => CL + side * offset
      // Windshield corner post and the door's front post, meeting at the roof
      const top = new Vector3(x(1.04), ROOF - 0.01, -0.48)
      s.beam(new Vector3(x(0.99), -0.15, -0.96), top, 0.055, PAINT.frame)
      s.beam(new Vector3(x(1.05), -0.47, -0.58), top, 0.05, PAINT.frame)
      // Sill under the small window ahead of the door, and the nose side below it
      s.beam(new Vector3(x(1.05), -0.47, -0.58), new Vector3(x(1.0), -0.3, -0.98), 0.04, PAINT.wall)
      s.box([0.04, 0.6, 0.46], [x(1.06), -0.77, -0.8], PAINT.wall)
      s.box([0.1, 0.38, 0.24], [x(1.0), -0.34, -0.9], PAINT.console)
      // The door: solid below, a big window above with a sliding pane's middle frame
      s.box([0.04, 0.6, 1.08], [x(1.07), -0.76, -0.02], PAINT.wall)
      s.beam(
        new Vector3(x(1.06), -0.45, -0.56),
        new Vector3(x(1.06), -0.45, 0.52),
        0.06,
        PAINT.lining
      )
      s.beam(
        new Vector3(x(1.06), -0.45, 0.52),
        new Vector3(x(1.05), ROOF - 0.01, 0.5),
        0.05,
        PAINT.frame
      )
      s.beam(
        new Vector3(x(1.05), ROOF - 0.02, -0.48),
        new Vector3(x(1.05), ROOF - 0.02, 0.5),
        0.05,
        PAINT.frame
      )
      s.beam(
        new Vector3(x(1.065), -0.43, 0.02),
        new Vector3(x(1.06), ROOF - 0.03, 0.02),
        0.025,
        PAINT.frame
      )
      // Door handle and the yellow emergency release
      s.box([0.025, 0.03, 0.12], [x(1.03), -0.55, 0.3], PAINT.metal)
      s.box([0.02, 0.06, 0.02], [x(1.03), -0.2, -0.54], PAINT.yellow)
      // Wall behind the door
      s.box([0.04, 1.5, 0.3], [x(1.07), -0.3, 0.67], PAINT.lining)
      // Windshield wiper, parked along the bottom of the glass
      s.beam(
        new Vector3(x(0.82), -0.13, -0.97),
        new Vector3(x(0.38), -0.11, -0.97),
        0.012,
        PAINT.grip
      )
    }
    // Header over the windshield, the roof, and the back wall
    s.beam(
      new Vector3(mirror(DOOR) + 0.02, ROOF - 0.01, -0.49),
      new Vector3(DOOR - 0.02, ROOF - 0.01, -0.49),
      0.06,
      PAINT.frame
    )
    s.box([width + 0.1, 0.04, 1.32], [CL, ROOF + 0.02, 0.17], PAINT.lining)
    // The overhead console's front face and side skirts, up to the roof
    s.sheet(CL, 0.34, [0.15, -0.475], [ROOF, -0.49], 0.03, PAINT.console)
    for (const side of [-1, 1]) {
      s.box([0.02, 0.15, 0.5], [CL + side * 0.17, 0.375, -0.02], PAINT.console)
      s.box([0.02, 0.25, 0.24], [CL + side * 0.17, 0.33, -0.37], PAINT.console)
    }
    s.box([width + 0.1, 1.5, 0.04], [CL, -0.3, 0.82], PAINT.wall)
  }

  /** An armoured crew seat at `x`; `outboard` is +1 for the right seat, -1 for the left. */
  private seat(x: number, outboard: number) {
    const s = this.shell
    s.box([0.44, 0.09, 0.44], [x, -0.815, 0.14], PAINT.cushion)
    s.box([0.46, 0.08, 0.46], [x, -0.9, 0.15], PAINT.armour)
    for (const side of [-1, 1])
      s.box([0.025, 0.2, 0.48], [x + side * 0.245, -0.82, 0.16], PAINT.armour)
    s.box([0.44, 0.66, 0.08], [x, -0.42, 0.42], PAINT.cushion, [-0.1, 0, 0])
    s.box([0.48, 0.8, 0.04], [x, -0.42, 0.48], PAINT.armour, [-0.1, 0, 0])
    s.box([0.26, 0.15, 0.08], [x, 0.04, 0.47], PAINT.cushion)
    // Sliding side armour, slid back, and the seat's floor frame
    s.box([0.03, 0.5, 0.34], [x + outboard * 0.28, -0.52, 0.45], PAINT.armour)
    s.box([0.36, 0.14, 0.36], [x, -1.0, 0.15], PAINT.frame)
  }

  /** The instrument panel: four displays, standby instruments, and the parking brake. */
  private instrumentPanel() {
    const d = this.deck
    const s = this.shell
    const { sim, pilot } = game
    const c = pilot.controls
    const panel = d.panel(
      [CL, -0.345, -0.8],
      DOOR - mirror(DOOR) - 0.1,
      0.35,
      [-0.12, 0, 0],
      PAINT.console,
      0.2
    )
    const mfd = (
      u: number,
      paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
      hz: number
    ) => {
      const glass = d.screen(panel, u, 0, MFD_W, MFD_H, paint, hz)
      // The kit's bezel front sits in the glass's plane; lift the glass clear so it never flickers
      glass.mesh.position.copy(panel.at(u, 0, 0.0045))
      // Bezel with its row of keys each side and along the bottom
      s.boxOn(panel, u, -0.005, -0.004, [MFD_W + 0.06, MFD_H + 0.055, 0.01], MATERIALS.black)
      for (let i = 0; i < 6; i++) {
        const v = MFD_H / 2 - 0.018 - i * 0.034
        for (const side of [-1, 1]) {
          s.boxOn(panel, u + side * (MFD_W / 2 + 0.017), v, 0.007, [0.014, 0.012, 0.006], PAINT.key)
        }
      }
      for (let i = 0; i < 5; i++) {
        s.boxOn(
          panel,
          u - 0.06 + i * 0.03,
          -MFD_H / 2 - 0.016,
          0.007,
          [0.018, 0.01, 0.006],
          PAINT.key
        )
      }
    }
    // Pilot's flight display outboard, the rotor and torque page inboard; the copilot's alike
    mfd(0.68, flightPage, 15)
    mfd(0.44, helicopterDisplay, 8)
    mfd(-0.44, navigationDisplay, 5)
    mfd(-0.68, engineDisplay(this.spec), 4)

    // Standby instruments in the middle
    const att = () => ({ pitch: sim.pitch, bank: sim.bank })
    d.instrument(panel, 0, 0.075, new AttitudeIndicator(0.08, att))
    d.instrument(
      panel,
      -0.12,
      0.075,
      new AirspeedIndicator(
        0.065,
        this.spec.gauges.airspeed,
        () => sim.indicatedAirspeed * KNOTS_PER_MS
      )
    )
    d.instrument(panel, 0.12, 0.075, new Altimeter(0.065, () => sim.position.y * FEET_PER_METRE))
    panel.label('STBY', 0, 0.13, 0.007)
    d.plate(panel, -0.12, -0.03, 0.12, 0.028, 'STAB 0° TE DN', '#4be36f')
    panel.label('STABILATOR', -0.12, 0.0, 0.007)
    d.plate(panel, -0.12, -0.09, 0.12, 0.028, 'IFF  MODE 3  4000', '#ff9a3a')

    // Parking brake handle, lower right of the middle panel: pull to set
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'PARKING BRAKE',
        panel.at(0.17, -0.1, 0.02),
        panel.at(0.17, -0.1, 0.07),
        panel.at(0.17, -0.1, -0.04),
        {
          get: () => (c.parkingBrake ? 1 : 0),
          set: (value, released) => {
            if (released && value > 0.5 !== c.parkingBrake) key('KeyP')
          },
          detents: [0, 1],
          knob: { color: 0xb01c1c, shape: 'tee' },
          state: () => (c.parkingBrake ? 'SET' : 'OFF')
        }
      )
    )
    panel.label('PARKING BRAKE', 0.17, -0.065, 0.007)
  }

  /** The master warning panel on the glareshield in front of the seat at `x`. */
  private masterWarning(x: number) {
    const d = this.deck
    const { sim } = game
    const panel = d.panel([x, -0.12, -0.786], 0.3, 0.05, [-0.5, 0, 0], MATERIALS.black, 0.03)
    const size = { w: 0.05, h: 0.026 }
    const lamp = (
      label: string,
      u: number,
      color: number,
      lit: () => boolean,
      press?: () => void
    ) => {
      d.add(new Annunciator(d.group, d.buzz, label, panel, u, 0, size, { lit, color, press }))
      const words = label.split(' ')
      const half = Math.ceil(words.length / 2)
      panel.label(words.slice(0, half).join(' '), u, 0.005, 0.0065, '#d8d8d2')
      if (words.length > 1) panel.label(words.slice(half).join(' '), u, -0.005, 0.0065, '#d8d8d2')
    }
    lamp('FIRE', -0.116, RED, () => sim.powered && sim.engines.some(e => e.fire) && flashing())
    lamp(
      'MASTER CAUTION',
      -0.058,
      AMBER,
      () => this.caution && !this.cautionReset,
      () => {
        this.cautionReset = true
      }
    )
    lamp(
      'LOW ROTOR RPM',
      0,
      RED,
      () => sim.powered && sim.enginesRunning > 0 && sim.rotorSpeed < 0.95 && flashing()
    )
    for (const i of [0, 1]) {
      lamp(
        `#${i + 1} ENG OUT`,
        0.058 + i * 0.058,
        AMBER,
        () => sim.powered && !sim.engines[i]?.running
      )
    }
  }

  /** True while any caution or warning shows, or the ground proximity system calls out. */
  private cautionActive() {
    const { sim, pilot, gpws } = game
    if (!sim.powered) return false
    if (gpws.alert !== null) return true
    for (const lamp of this.cautions) if (lamp.on(sim, pilot.controls)) return true
    return false
  }

  protected tick() {
    this.caution = this.cautionActive()
    if (!this.caution) this.cautionReset = false
  }

  /** The overhead console's sloping front: fire T-handles, power levers, and fuel selectors. */
  private overheadFront(panel: Panel) {
    const d = this.deck
    const { sim, pilot } = game
    const c = pilot.controls
    // Engine emergency off T-handles: pull to shut the engine down
    for (const i of [0, 1]) {
      const u = i === 0 ? -0.1 : 0.1
      d.add(
        new Lever(
          d.group,
          d.buzz,
          `#${i + 1} ENG EMER OFF`,
          panel.at(u, -0.095, 0.02),
          panel.at(u, -0.095, 0.07),
          panel.at(u, -0.095, -0.03),
          {
            get: () => (this.pulled[i] && !c.engineSwitches[i] ? 1 : 0),
            set: (value, released) => {
              if (!released) return
              this.pulled[i] = value > 0.5
              if (this.pulled[i] && c.engineSwitches[i]) {
                this.pcl[i] = 0
                key(`Digit${i + 1}`)
              }
            },
            detents: [0, 1],
            knob: { color: 0xb01c1c, shape: 'tee' },
            state: () => (this.pulled[i] && !c.engineSwitches[i] ? 'PULLED' : 'IN')
          }
        )
      )
      panel.label(`#${i + 1} ENG EMER OFF`, u, -0.068, 0.006)
    }
    // The fire bottle: puts out a fire in an engine already shut down
    d.add(
      new Annunciator(
        d.group,
        d.buzz,
        'FIRE EXT',
        panel,
        0,
        -0.095,
        { w: 0.04, h: 0.024 },
        {
          lit: () => sim.engines.some(e => e.fire),
          color: RED,
          press: () => {
            for (const i of sim.engines.keys()) sim.extinguish(i, c.engineSwitches[i])
          },
          state: () => 'press to discharge'
        }
      )
    )
    panel.label('FIRE', 0, -0.09, 0.0065, '#d8d8d2')
    panel.label('EXT', 0, -0.1, 0.0065, '#d8d8d2')

    // Engine power control levers inboard, fuel selector levers outboard; forward is down the slope
    const lever = (
      label: string,
      u: number,
      knob: 'box' | 'pull',
      color: number,
      get: () => number,
      set: (value: number) => void,
      state: () => string
    ) =>
      d.add(
        new Lever(
          d.group,
          d.buzz,
          label,
          panel.at(u, 0.075, 0.05),
          panel.at(u, -0.035, 0.05),
          panel.at(u, 0.02, -0.04),
          {
            get,
            set: (value, released) => {
              if (released) set(value)
            },
            detents: [0, 0.5, 1],
            knob: { color, shape: knob },
            state
          }
        )
      )
    const positions = ['OFF', 'IDLE', 'FLY']
    for (const i of [0, 1]) {
      lever(
        `#${i + 1} ENG PCL`,
        i === 0 ? -0.045 : 0.045,
        'box',
        0xd8d8d2,
        () => (c.engineSwitches[i] ? Math.max(0.5, this.pcl[i]) : 0),
        value => {
          this.pcl[i] = value
          if (value > 0.25 !== c.engineSwitches[i]) key(`Digit${i + 1}`)
        },
        () => positions[c.engineSwitches[i] ? Math.max(1, Math.round(this.pcl[i] * 2)) : 0]
      )
      // Both selectors feed both engines here: either one shuts or opens the fuel
      lever(
        `#${i + 1} FUEL SEL`,
        i === 0 ? -0.125 : 0.125,
        'pull',
        0x2a2c2e,
        () => (c.fuelPumps ? 0.5 : 0),
        value => {
          if (value > 0.25 !== c.fuelPumps) key('KeyU')
        },
        () => (c.fuelPumps ? 'DIR' : 'OFF')
      )
    }
    panel.label('ENG POWER CONT', 0, 0.105, 0.0065)
    panel.label('FUEL', -0.125, 0.105, 0.0065)
    panel.label('FUEL', 0.125, 0.105, 0.0065)
    for (const [label, v] of [
      ['OFF', 0.075],
      ['IDLE', 0.02],
      ['FLY', -0.035]
    ] as const) {
      panel.label(label, 0, v, 0.0055)
    }
    for (const [label, v] of [
      ['OFF', 0.075],
      ['DIR', 0.02],
      ['XFD', -0.035]
    ] as const) {
      panel.label(label, -0.158, v, 0.0055)
      panel.label(label, 0.158, v, 0.0055)
    }
  }

  /** The overhead console's flat aft part: electrics, lights, anti-ice, and the rotor brake. */
  private overheadAft(panel: Panel) {
    const d = this.deck
    const { pilot } = game
    const c = pilot.controls
    const local = this.local
    const toggle = (name: keyof typeof local) => () => {
      local[name] = !local[name]
    }
    panel.label('ELECTRICAL', 0, -0.225, 0.0075)
    d.rocker(panel, 'BATT', -0.11, -0.19, { get: () => c.battery, set: () => key('KeyO') })
    d.add(
      new Annunciator(
        d.group,
        d.buzz,
        'APU',
        panel,
        0,
        -0.19,
        { w: 0.032, h: 0.022 },
        {
          lit: () => local.apu,
          color: GREEN,
          press: toggle('apu')
        }
      )
    )
    panel.label('APU', 0, -0.19, 0.0065, '#d8d8d2')
    d.rocker(panel, 'APU GEN', 0.11, -0.19, {
      get: () => local.apuGenerator,
      set: toggle('apuGenerator')
    })

    panel.label('LIGHTS', 0, -0.125, 0.0075)
    const lights: [string, () => boolean, () => void][] = [
      ['POSITION', () => local.position, toggle('position')],
      ['ANTI COLL', () => local.antiCollision, toggle('antiCollision')],
      ['LDG LT', () => pilot.landingLights, () => key('KeyL')],
      ['SEARCH', () => local.search, toggle('search')]
    ]
    lights.forEach(([label, get, set], i) => {
      d.rocker(panel, label, -0.12 + i * 0.08, -0.09, { get, set: () => set() })
    })

    panel.label('ANTI ICE', 0, -0.025, 0.0075)
    const ice: [string, keyof typeof local][] = [
      ['PITOT HEAT', 'pitot'],
      ['#1 ENG', 'antiIce1'],
      ['#2 ENG', 'antiIce2']
    ]
    ice.forEach(([label, name], i) => {
      d.rocker(panel, label, -0.11 + i * 0.11, 0.01, { get: () => local[name], set: toggle(name) })
    })

    // Rotor brake: pull aft to apply, with its lamp beside
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'ROTOR BRAKE',
        panel.at(0.08, 0.1, 0.045),
        panel.at(0.08, 0.19, 0.045),
        panel.at(0.08, 0.145, -0.03),
        {
          get: () => (local.rotorBrake ? 1 : 0),
          set: (value, released) => {
            if (released) local.rotorBrake = value > 0.5
          },
          detents: [0, 1],
          knob: { color: 0xd4a017, shape: 'tee' },
          state: () => (local.rotorBrake ? 'ON' : 'OFF')
        }
      )
    )
    panel.label('ROTOR BRAKE', 0.08, 0.225, 0.0075)
    panel.label('OFF', 0.13, 0.1, 0.0055)
    panel.label('ON', 0.13, 0.19, 0.0055)
    d.add(
      new Annunciator(
        d.group,
        d.buzz,
        'ROTOR BRAKE',
        panel,
        -0.07,
        0.145,
        { w: 0.05, h: 0.026 },
        {
          lit: () => local.rotorBrake,
          color: AMBER
        }
      )
    )
    panel.label('RTR BRK', -0.07, 0.145, 0.0065, '#d8d8d2')
  }

  /** The lower console's sloping front: the two control display units. */
  private consoleFront(panel: Panel) {
    const d = this.deck
    const s = this.shell
    for (const [u, name] of [
      [-0.067, 'CDU 1'],
      [0.067, 'CDU 2']
    ] as const) {
      d.plate(panel, u, 0.075, 0.105, 0.06, 'FLIGHT PLAN', '#4be36f')
      s.boxOn(panel, u, 0.075, -0.001, [0.115, 0.07, 0.004], MATERIALS.black)
      panel.label(name, u, 0.118, 0.0075)
      // The keypad
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 4; col++) {
          s.boxOn(
            panel,
            u - 0.033 + col * 0.022,
            0.02 - row * 0.022,
            0.004,
            [0.016, 0.014, 0.008],
            PAINT.key
          )
        }
      }
    }
  }

  /** The lower console's flat aft part: flight control computers, stabilator, and radios. */
  private consoleAft(panel: Panel) {
    const d = this.deck
    const { pilot, sim, nav } = game
    const local = this.local
    const size = { w: 0.042, h: 0.024 }
    panel.label('AFCS', 0, 0.215, 0.0075)
    const afcs: [string, () => boolean, () => void][] = [
      ['SAS 1', () => local.sas1, () => (local.sas1 = !local.sas1)],
      ['SAS 2', () => local.sas2, () => (local.sas2 = !local.sas2)],
      ['TRIM', () => local.trim, () => (local.trim = !local.trim)],
      ['FPS', () => pilot.autopilot.on, () => key('KeyZ')],
      ['BOOST', () => local.boost, () => (local.boost = !local.boost)]
    ]
    afcs.forEach(([label, lit, press], i) => {
      const u = -0.104 + i * 0.052
      d.add(
        new Annunciator(d.group, d.buzz, label, panel, u, 0.18, size, { lit, color: GREEN, press })
      )
      panel.label(label, u, 0.18, 0.0065, '#d8d8d2')
    })
    // The flight path stabilisation's height hold: push to hold the present altitude
    d.add(
      new Annunciator(d.group, d.buzz, 'ALT HOLD', panel, -0.052, 0.13, size, {
        lit: () => pilot.autopilot.on && pilot.autopilot.vertical === 'ALT',
        color: GREEN,
        press: () => {
          if (game.getState().status === 'flying') pilot.setVertical('ALT', sim, nav)
        }
      })
    )
    panel.label('ALT', -0.052, 0.13, 0.0065, '#d8d8d2')
    d.add(
      new Annunciator(d.group, d.buzz, 'HDG HOLD', panel, 0.052, 0.13, size, {
        lit: () => pilot.autopilot.on && pilot.autopilot.lateral === 'HDG',
        color: GREEN,
        press: () => {
          if (game.getState().status === 'flying') pilot.setLateral('HDG', sim, nav)
        }
      })
    )
    panel.label('HDG', 0.052, 0.13, 0.0065, '#d8d8d2')

    panel.label('STABILATOR', 0, 0.075, 0.0075)
    d.add(
      new Annunciator(
        d.group,
        d.buzz,
        'STAB AUTO CONTROL',
        panel,
        -0.04,
        0.045,
        { w: 0.05, h: 0.024 },
        {
          lit: () => local.stabilator,
          color: GREEN,
          press: () => {
            local.stabilator = !local.stabilator
          }
        }
      )
    )
    panel.label('AUTO', -0.04, 0.05, 0.0055, '#d8d8d2')
    panel.label('CONTROL', -0.04, 0.04, 0.0055, '#d8d8d2')
    d.plate(panel, 0.055, 0.045, 0.07, 0.024, 'TEST', '#9aa0a6')

    d.plate(panel, 0, -0.04, 0.2, 0.03, 'VHF  121.500   UHF  243.000')
    panel.label('RADIO', 0, -0.012, 0.0075)
    d.plate(panel, 0, -0.1, 0.2, 0.03, 'HF  8.992   FM  30.000')
    panel.label('PLT / CPLT ICS', 0, -0.165, 0.0075)
  }

  /** The copilot's cyclic and collective, and both pairs of pedals, moving with the pilot's. */
  private linkage() {
    const d = this.deck
    const c = game.pilot.controls
    const group = this.deck.group
    const cyclic = new CyclicModel(
      group,
      new Vector3(COPILOT, -1.0, -0.47),
      new Vector3(COPILOT, -0.5, -0.41),
      CYCLIC_TRAVEL
    )
    const collective = new CollectiveModel(group)
    const root = new Vector3(COPILOT - 0.32, -0.86, 0.12)
    const down = new Vector3(COPILOT - 0.32, -0.76, -0.4)
    const up = new Vector3(COPILOT - 0.32, -0.6, -0.36)
    const head = new Vector3()
    this.shell.box([0.05, 0.08, 0.3], [COPILOT - 0.32, -0.9, 0.12], PAINT.console)
    const pedals = [new Pedals(group, 0, -0.94, -0.86), new Pedals(group, COPILOT, -0.94, -0.86)]
    d.track({
      update: () => {
        cyclic.pose(this.cyclic.pitch, this.cyclic.roll)
        collective.pose(root, head.copy(down).lerp(up, this.collective.value))
        for (const pair of pedals) pair.pose(c.yaw)
      },
      dispose: () => {}
    })
  }

  private checklistsFor() {
    const { sim, pilot } = game
    const c = pilot.controls
    const local = this.local
    return [
      {
        title: 'Before Start',
        items: [
          { text: 'Parking brake: SET', done: () => c.parkingBrake },
          { text: 'Collective: full down', done: () => c.throttle < 0.05 },
          { text: 'BATT switch: ON', done: () => c.battery },
          { text: 'Fuel selectors: DIR', done: () => c.fuelPumps },
          { text: 'Rotor brake: OFF', done: () => !local.rotorBrake }
        ]
      },
      {
        title: 'Engine Start',
        items: [
          { text: '#1 PCL: IDLE', done: () => c.engineSwitches[0] },
          { text: '#2 PCL: IDLE', done: () => c.engineSwitches[1] },
          { text: 'Both engines running', done: () => sim.enginesRunning === 2 },
          { text: '#1 and #2 ENG OUT lights: out', done: () => sim.enginesRunning === 2 }
        ]
      },
      {
        title: 'Rotor Up to 100%',
        items: [
          {
            text: 'PCLs: FLY',
            done: () => this.pcl.every(p => p === 1) && c.engineSwitches.every(Boolean)
          },
          { text: 'NR: 100%', done: () => sim.rotorSpeed >= 0.99 },
          { text: 'LOW ROTOR RPM light: out', done: () => sim.rotorSpeed >= 0.95 },
          { text: 'FPS: ON', done: () => pilot.autopilot.on || !sim.onGround },
          { text: 'Parking brake: OFF', done: () => !c.parkingBrake }
        ]
      },
      {
        title: 'Hover Check',
        items: [
          { text: 'Collective: raise to a 10 ft hover', done: () => !sim.onGround },
          {
            text: 'Hover height: 5 to 15 ft',
            done: () => {
              const feet = sim.altitudeAgl * FEET_PER_METRE
              return !sim.onGround && feet > 5 && feet < 15
            }
          },
          { text: 'NR: holding 100%', done: () => !sim.onGround && sim.rotorSpeed > 0.98 },
          { text: 'Torque: below 100%', done: () => !sim.onGround && sim.rpm < 100 }
        ]
      },
      {
        title: 'Before Landing',
        items: [
          { text: 'Landing light: ON', done: () => pilot.landingLights },
          { text: 'Airspeed: below 60 kt', done: () => sim.indicatedAirspeed * KNOTS_PER_MS < 60 },
          {
            text: 'Touchdown, collective: full down',
            done: () => sim.onGround && c.throttle < 0.05
          },
          { text: 'Parking brake: SET', done: () => sim.onGround && c.parkingBrake }
        ]
      },
      {
        title: 'Shutdown',
        items: [
          { text: 'PCLs: IDLE, then OFF', done: () => !c.engineSwitches.some(Boolean) },
          {
            text: 'Rotor brake: ON below 40% NR',
            done: () => local.rotorBrake && sim.rotorSpeed < 0.4
          },
          { text: 'Fuel selectors: OFF', done: () => !c.fuelPumps },
          { text: 'BATT switch: OFF', done: () => !c.battery }
        ]
      }
    ]
  }
}

/** The cockpits this file builds, by aircraft id. */
export const COCKPITS = { uh60: BlackHawkCockpit }
