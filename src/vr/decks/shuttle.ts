import { Euler, type Mesh, Vector3 } from 'three'
import { game } from '../../game/game'
import { WARNINGS } from '../../game/gpws'
import type { AircraftSpec } from '../../sim/aircraft'
import { LAMPS } from '../../ui/lamps'
import { FEET_PER_METRE, KNOTS_PER_MS } from '../../ui/telemetry'
import { key } from '../cockpit'
import { type Buzz, Lever, Stick } from '../controls'
import { DeckCockpit, Display, MATERIALS, type Panel } from '../deck'
import { headUpDisplay, navigationDisplay, primaryFlight } from '../glass'
import {
  type Corners,
  finish,
  gaugeField,
  lining,
  mirror,
  mirrorHoles,
  p,
  screen,
  wall
} from './concorde-shell'

/*
 * The Space Shuttle orbiter's forward flight deck, from the commander's seat: six small
 * forward windows and two overhead ones, the head-up display on the glareshield, nine
 * MEDS glass displays across the forward panel, the overhead panels of switches, the
 * rotational hand controller between the knees, and the speed brake handle on the left
 * console. The commander sits left, so the centreline is 0.6 m right of the eye.
 */

const CL = 0.6
const FLOOR = -1.1
const MDU = 0.155
const RAD = 180 / Math.PI

const GREEN = '#4be36f'
const WHITE = '#e8ecef'
const AMBER = '#f2a93b'
const MAGENTA = '#e06bf0'
const FONT = 'ui-monospace, Menlo, monospace'

/** A data processing system page: green text on black, as the general purpose computers drew it. */
function dpsPage(title: string, lines: string[]) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.fillStyle = '#04060a'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = GREEN
    ctx.font = `600 ${h * 0.055}px ${FONT}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(title, w * 0.05, h * 0.04)
    ctx.font = `500 ${h * 0.047}px ${FONT}`
    lines.forEach((line, i) => {
      ctx.fillText(line, w * 0.05, h * (0.14 + i * 0.075))
    })
  }
}

/** One labelled bar from 0 to 1 on a systems page. */
function bar(
  ctx: CanvasRenderingContext2D,
  label: string,
  share: number,
  x: number,
  y: number,
  w: number,
  h: number
) {
  ctx.fillStyle = '#1c242c'
  ctx.fillRect(x, y, w, h)
  const clamped = Math.max(0, Math.min(1, share))
  ctx.fillStyle = clamped < 0.2 ? AMBER : GREEN
  ctx.fillRect(x, y + h * (1 - clamped), w, h * clamped)
  ctx.fillStyle = WHITE
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(label, x + w / 2, y + h + w * 0.2)
}

/** The APU and hydraulics page: fuel and pressure for each of the three systems. */
function apuPage(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#04060a'
  ctx.fillRect(0, 0, w, h)
  const { sim, pilot } = game
  if (!sim.powered) return
  const c = pilot.controls
  const running = sim.engines[0]?.running ?? false
  const fuel = sim.fuel / sim.spec.fuelCapacity
  ctx.font = `600 ${h * 0.06}px ${FONT}`
  ctx.fillStyle = WHITE
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText('APU / HYD', w / 2, h * 0.04)
  ctx.font = `600 ${h * 0.045}px ${FONT}`
  for (let i = 0; i < 3; i++) {
    const x = w * (0.1 + i * 0.14)
    bar(ctx, `FU${i + 1}`, fuel, x, h * 0.18, w * 0.08, h * 0.5)
    bar(ctx, `HY${i + 1}`, running ? 0.92 : 0.05, x + w * 0.45, h * 0.18, w * 0.08, h * 0.5)
  }
  ctx.textAlign = 'left'
  ctx.fillStyle = running ? GREEN : AMBER
  ctx.fillText(running ? 'APU RUN' : 'APU OFF', w * 0.06, h * 0.84)
  ctx.fillStyle = c.gearDown ? GREEN : WHITE
  ctx.fillText(c.gearDown ? 'GEAR DN' : 'GEAR UP', w * 0.4, h * 0.84)
  ctx.fillStyle = c.speedBrake ? AMBER : WHITE
  ctx.fillText(c.speedBrake ? 'SB OPEN' : 'SB CLSD', w * 0.72, h * 0.84)
}

/**
 * The approach and landing page: height, equivalent airspeed, the glide angle against
 * the 19° outer and 1.5° inner glideslopes, and the speed brake.
 */
function approachPage(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#04060a'
  ctx.fillRect(0, 0, w, h)
  const { sim, pilot } = game
  if (!sim.powered) return
  const c = pilot.controls
  const feet = Math.max(0, Math.round(sim.altitudeAgl * FEET_PER_METRE))
  const knots = Math.round(sim.indicatedAirspeed * KNOTS_PER_MS)
  const glide = sim.groundSpeed > 5 ? Math.atan2(-sim.verticalSpeed, sim.groundSpeed) * RAD : 0
  ctx.font = `600 ${h * 0.06}px ${FONT}`
  ctx.fillStyle = WHITE
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText('A/L  VERT SIT', w / 2, h * 0.04)
  ctx.textAlign = 'left'
  ctx.font = `600 ${h * 0.075}px ${FONT}`
  const rows: [string, string, string][] = [
    ['ALT', `${feet} FT`, feet < 2000 ? AMBER : GREEN],
    ['KEAS', String(knots), knots > 315 || knots < 185 ? AMBER : GREEN],
    ['GLIDE', `${glide.toFixed(1)}°`, GREEN],
    ['SB', c.speedBrake ? 'OPEN' : 'CLOSED', c.speedBrake ? AMBER : WHITE],
    ['GEAR', c.gearDown ? 'DOWN' : 'UP', c.gearDown ? GREEN : WHITE]
  ]
  rows.forEach(([label, value, color], i) => {
    const y = h * (0.18 + i * 0.13)
    ctx.fillStyle = WHITE
    ctx.fillText(label, w * 0.07, y)
    ctx.fillStyle = color
    ctx.fillText(value, w * 0.45, y)
  })
  // Glide angle against the outer glideslope, as a needle on a scale from 0 to 25°
  const x = w * 0.9
  ctx.fillStyle = '#1c242c'
  ctx.fillRect(x - w * 0.02, h * 0.18, w * 0.04, h * 0.64)
  const y = (deg: number) => h * (0.18 + (Math.max(0, Math.min(25, deg)) / 25) * 0.64)
  ctx.fillStyle = MAGENTA
  ctx.fillRect(x - w * 0.04, y(19) - 2, w * 0.08, 4)
  ctx.fillRect(x - w * 0.04, y(1.5) - 2, w * 0.08, 4)
  ctx.fillStyle = WHITE
  ctx.beginPath()
  ctx.moveTo(x - w * 0.05, y(glide))
  ctx.lineTo(x - w * 0.025, y(glide) - h * 0.02)
  ctx.lineTo(x - w * 0.025, y(glide) + h * 0.02)
  ctx.fill()
}

/** The caution and warning matrix: forty labelled lights, drawn unlit. */
function cautionMatrix(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const names = [
    'O2 PRESS',
    'H2 PRESS',
    'FUEL CELL',
    'FC STACK',
    'FC PUMP',
    'CABIN ATM',
    'O2 HEATER',
    'MAIN BUS',
    'AC VOLT',
    'AC OVLD',
    'FREON',
    'AV BAY',
    'IMU',
    'FWD RCS',
    'RHC',
    'LEFT RHC',
    'RIGHT RHC',
    'AFT RHC',
    'LEFT OMS',
    'RIGHT OMS',
    'PAYLOAD',
    'GPC',
    'FCS SAT',
    'FCS CH',
    'MPS',
    'PL CAUT',
    'BACKUP C/W',
    'APU TEMP',
    'APU SPEED',
    'HYD PRESS',
    'APU OVHT',
    'APU UNDSPD',
    'HYD QTY',
    'OMS TVC',
    'OMS KIT',
    'PRI C/W',
    'RCS JET',
    'ADI',
    'NAV',
    'AIR DATA'
  ]
  ctx.fillStyle = '#121416'
  ctx.fillRect(0, 0, w, h)
  const cols = 8
  const rows = 5
  const cw = w / cols
  const ch = h / rows
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${ch * 0.3}px Arial Narrow, system-ui, sans-serif`
  names.forEach((name, i) => {
    const x = (i % cols) * cw
    const y = Math.floor(i / cols) * ch
    ctx.fillStyle = '#24282c'
    ctx.fillRect(x + cw * 0.05, y + ch * 0.08, cw * 0.9, ch * 0.84)
    ctx.fillStyle = '#8a8f94'
    ctx.fillText(name, x + cw / 2, y + ch / 2, cw * 0.86)
  })
}

/** The orbiter's forward flight deck. */
export class ShuttleCockpit extends DeckCockpit {
  /** Screens drawn once, which go dark with the power off. */
  private readonly fixedScreens: Mesh[] = []
  /** The landing gear arm button has been pressed, so DN lowers the gear. */
  private gearArmed = false
  private hudPower = true
  private chute: 'stowed' | 'armed' | 'out' | 'gone' = 'stowed'

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const { pilot, sim } = game
    const c = pilot.controls

    this.shell()
    const grey = finish(0x5f666e, 0x23272b)

    // Forward panels: F2 and F6 for the commander, F7 in the middle, F8 and F4 for the pilot
    const main = d.panel([CL, -0.38, -0.74], 2.7, 0.52, [0, 0, 0], grey, 0.3)
    const v = (y: number) => y + 0.38
    const top = v(-0.25)
    screen(d, main, -0.695, top, MDU, MDU, primaryFlight, 15)
    screen(d, main, -0.505, top, MDU, MDU, navigationDisplay, 5)
    this.fixed(
      screen(
        d,
        main,
        -0.19,
        top,
        MDU,
        MDU,
        dpsPage('2011/050/     HORIZ SIT', [
          'RW  RNG   XTRK  DEL H',
          'PRI  15.2  0.1   +250',
          'TGT NEP   HAC  OGS 19',
          'AIM  NOM   SB  AUTO',
          'ALIGN 6000   FLARE 2000',
          'AUTOLAND  INH',
          'NAV DATA  GOOD',
          'TACAN  GOOD  ADTA  GOOD',
          'DRAG H   GOOD',
          'MLS  AVAIL'
        ]),
        0,
        1600
      )
    )
    screen(d, main, 0, top, MDU, MDU, apuPage, 2, 1600)
    this.fixed(
      screen(
        d,
        main,
        0.19,
        top,
        MDU,
        MDU,
        dpsPage('2011/     /018  GNC SYS SUMM 1', [
          'RCS  CMD  JET  ISOL',
          'F    1    OK   OP',
          'L    2    OK   OP',
          'R    3    OK   OP',
          'SURF   POS   MOM',
          'L OB  -2.1   0.2',
          'L IB  -1.8   0.1',
          'R IB  -1.9   0.1',
          'R OB  -2.2   0.2',
          'AIL   +0.1   RUD  0.0'
        ]),
        0,
        1600
      )
    )
    screen(d, main, 0.505, top, MDU, MDU, primaryFlight, 6)
    screen(d, main, 0.695, top, MDU, MDU, navigationDisplay, 2)
    // The two multifunction displays below the warning matrix
    screen(d, main, -0.1, v(-0.555), MDU, MDU, approachPage, 4, 1600)
    this.fixed(
      screen(
        d,
        main,
        0.1,
        v(-0.555),
        MDU,
        MDU,
        dpsPage('2011/     /078  SM SYS SUMM 1', [
          'FC    1     2     3',
          'VOLTS 31.4  31.2  31.3',
          'AMPS  178   181   176',
          'MAIN  A     B     C',
          'VOLTS 30.9  30.8  30.9',
          'CABIN  P 14.7  T 72',
          'O2 FLOW  0.1',
          'N2 FLOW  0.0',
          'FREON  LOOP 1  2',
          'AV BAY  1 82  2 84  3 80'
        ]),
        0,
        1600
      )
    )
    screen(d, main, 0, v(-0.405), 0.3, 0.1, cautionMatrix, 0, 1600)
    main.label('CAUTION / WARNING', 0, v(-0.343), 0.007)
    this.labelScreens(main, top)
    // Display and air data select switches under each seat's pair of screens
    for (const side of [-1, 1]) {
      screen(
        d,
        main,
        side * 0.6,
        v(-0.43),
        0.34,
        0.1,
        gaugeField({ rows: 2, columns: 9, kind: 'switches', seed: side < 0 ? 71 : 73 }),
        0,
        1200
      )
      main.label('ADI   HSI   AIR DATA   MDU PORT', side * 0.6, v(-0.37), 0.0065)
      d.plate(main, side * 0.35, v(-0.2), 0.09, 0.026, 'EVENT 00:00', '#ff5a3a')
      d.plate(main, side * 0.35, v(-0.24), 0.09, 0.026, 'RA 100', '#ff5a3a')
    }

    for (const side of [-1, 1]) this.sidePanel(main, side, v)

    // Glareshield: master alarm for each seat
    const shield = d.panel([CL, -0.105, -0.715], 2.7, 0.05, [-0.35, 0, 0], MATERIALS.black, 0.05)
    const lamps = LAMPS.filter(lamp => lamp.kind === 'warning')
    const alarm = () =>
      sim.powered &&
      (lamps.some(lamp => lamp.on(sim, c)) ||
        (game.gpws.alert !== null && WARNINGS.has(game.gpws.alert)))
    const flashing = () => Math.floor(performance.now() / 400) % 2 === 0
    for (const u of [-0.9, 0.9]) {
      d.button(shield, 'MASTER ALARM', u, -0.004, {
        lit: () => (alarm() && flashing() ? 'alert' : 'off'),
        color: 0x5a1010,
        size: { w: 0.04, h: 0.022 }
      })
    }
    this.headUp()

    this.overhead(
      d.panel([CL, 0.27, -0.16], 1.9, 0.62, [1.4, 0, 0], finish(0x6a7179, 0x30353a), 0.05)
    )
    this.centreConsole(d.panel([CL, -0.6, -0.42], 0.36, 0.45, [-1.25, 0, 0], grey, 0.45))
    this.leftConsole(d.panel([-0.68, -0.45, -0.15], 0.7, 0.26, [-0.6, Math.PI / 2, 0], grey, 0.05))

    // Rotational hand controller between the commander's knees, on an arm from the panel
    d.box([0.07, 0.06, 0.3], [0.13, -0.67, -0.6], MATERIALS.black)
    this.flight = d.add(
      new Stick(
        d.group,
        d.buzz,
        new Vector3(0.13, -0.63, -0.45),
        new Vector3(0.13, -0.52, -0.44),
        0.06
      )
    )
    // The pilot's own hand controller, a fixed model
    d.box([0.07, 0.06, 0.3], [2 * CL - 0.13, -0.67, -0.6], MATERIALS.black)
    d.box([0.04, 0.11, 0.04], [2 * CL - 0.13, -0.57, -0.45], MATERIALS.black)
    for (const x of [0, 2 * CL]) {
      for (const side of [-1, 1]) {
        d.box([0.08, 0.16, 0.03], [x + side * 0.12, -0.98, -0.72], MATERIALS.frame, [-0.5, 0, 0])
      }
    }

    // Tablet beside the left console, below the side window
    this.tablet = {
      position: new Vector3(-0.47, -0.27, 0.08),
      rotation: new Euler(-0.3, 1.2, 0, 'YXZ')
    }
    const feet = () => sim.altitudeAgl * FEET_PER_METRE
    const knots = () => sim.indicatedAirspeed * KNOTS_PER_MS
    this.checklists = [
      {
        title: 'Entry Interface to TAEM',
        items: [
          { text: 'MN BUS A, B, C: ON', done: () => c.battery },
          { text: 'APU 1 to 3: RUN', done: () => c.engineSwitches[0] },
          { text: 'HUD PWR: ON', done: () => this.hudPower },
          { text: 'DAP: CSS, fly the hand controller', done: () => !pilot.autopilot.on }
        ]
      },
      {
        title: 'Outer Glideslope',
        items: [
          { text: 'Hold 280 to 300 KEAS', done: () => knots() > 280 && knots() < 310 },
          { text: 'Speed brake: OPEN to hold speed', done: () => c.speedBrake },
          { text: 'Preflare at 2,000 ft', done: () => feet() < 2000 }
        ]
      },
      {
        title: 'Landing',
        items: [
          { text: 'LDG GEAR: ARM', done: () => this.gearArmed },
          { text: 'LDG GEAR: DN at 300 ft', done: () => c.gearDown },
          { text: 'Touchdown near 195 kt', done: () => sim.onGround },
          { text: 'DRAG CHUTE: DPY', done: () => this.chute === 'out' || this.chute === 'gone' },
          {
            text: 'Brakes below 140 kt, wheels stop',
            done: () => sim.onGround && sim.groundSpeed < 1
          }
        ]
      }
    ]
    this.finish()
  }

  /** Marks a screen as drawn once, to be hidden while the power is off. */
  private fixed(display: Display) {
    this.fixedScreens.push(display.mesh)
  }

  /** Each display's name above it, as the MEDS bezels print them. */
  private labelScreens(main: Panel, top: number) {
    const names: [string, number][] = [
      ['CDR 1', -0.695],
      ['CDR 2', -0.505],
      ['CRT 1', -0.19],
      ['CRT 2', 0],
      ['CRT 3', 0.19],
      ['PLT 1', 0.505],
      ['PLT 2', 0.695]
    ]
    for (const [name, u] of names) main.label(name, u, top + MDU / 2 + 0.016, 0.0065)
    main.label('MFD 1', -0.1, top - 0.305 + MDU / 2 + 0.014, 0.0065)
    main.label('MFD 2', 0.1, top - 0.305 + MDU / 2 + 0.014, 0.0065)
  }

  /**
   * The cabin shell: six forward windows, the two overhead windows behind, the roof, the
   * walls to the floor, and the seats.
   */
  private shell() {
    const d = this.deck
    const g = d.group
    const skin = lining(0xb9b6ad, 0x4a4843)
    const dark = lining(0x202326, 0x07080a)
    const FBL = p(-0.42, -0.1, -0.98)
    const FTL = p(-0.36, 0.22, -0.8)
    const SBL = p(-0.8, -0.1, -0.55)
    const STL = p(-0.72, 0.29, -0.45)
    const WBL = p(-0.82, -0.1, 1.4)
    const WTL = p(-0.74, 0.46, 1.4)
    const R = (at: Vector3) => p(2 * CL - at.x, at.y, at.z)
    const down = (at: Vector3) => p(at.x, FLOOR, at.z)

    // W2 to W5 across the front, with the centre post on the centreline
    wall(
      g,
      [FBL, R(FBL), R(FTL), FTL],
      [
        [0.02, 0.1, 0.27, 0.9],
        [0.3, 0.1, 0.48, 0.9],
        [0.52, 0.1, 0.7, 0.9],
        [0.73, 0.1, 0.98, 0.9]
      ],
      dark
    )
    // W1 and W6, angled back to the side walls
    const angled: Corners = [SBL, FBL, FTL, STL]
    const angledHoles: [number, number, number, number][] = [[0.12, 0.14, 0.86, 0.86]]
    wall(g, angled, angledHoles, dark)
    wall(g, mirror(angled, CL), mirrorHoles(angledHoles), dark)
    const side: Corners = [WBL, SBL, STL, WTL]
    wall(g, side, [], skin)
    wall(g, mirror(side, CL), [], skin)
    for (const corners of [
      [down(WBL), down(SBL), SBL, WBL],
      [down(SBL), down(FBL), FBL, SBL]
    ] as Corners[]) {
      wall(g, corners, [], skin)
      wall(g, mirror(corners, CL), [], skin)
    }
    wall(g, [down(FBL), down(R(FBL)), R(FBL), FBL], [], skin)
    // Roof over the windows, then the overhead windows W7 and W8 above the aft station
    wall(g, [FTL, R(FTL), R(STL), STL], [], dark)
    wall(
      g,
      [STL, R(STL), R(WTL), WTL],
      [
        [0.22, 0.52, 0.46, 0.85],
        [0.54, 0.52, 0.78, 0.85]
      ],
      skin
    )
    // Glareshield top, from the window sill back to its lip
    wall(g, [FBL, R(FBL), p(2 * CL + 0.68, -0.08, -0.7), p(-0.68, -0.08, -0.7)], [], dark)
    d.box([2.8, 0.04, 2.6], [CL, FLOOR, 0.15], MATERIALS.floor)
    d.box([2.8, 1.6, 0.04], [CL, -0.3, 1.4], MATERIALS.lining)
    for (const x of [0, 2 * CL]) {
      d.box([0.5, 0.12, 0.5], [x, -0.8, 0.3], MATERIALS.seat)
      d.box([0.5, 0.75, 0.1], [x, -0.38, 0.58], MATERIALS.seat, [-0.12, 0, 0])
      d.box([0.06, 0.06, 0.4], [x - 0.27, -0.62, 0.3], MATERIALS.seat)
    }
    // Right console, the pilot's side, as a block
    d.box([0.22, 0.65, 0.8], [2 * CL + 0.72, -0.78, -0.15], MATERIALS.grey)
  }

  /** The head-up display's combiner glass over the glareshield, straight ahead of the eye. */
  private headUp() {
    const d = this.deck
    const width = 0.18
    const height = 0.13
    const distance = 0.68
    const field = 2 * Math.atan(width / 2 / distance) * RAD
    const hud = new Display(width, height, 3200, headUpDisplay(field), 15)
    hud.mesh.position.set(0, 0, -distance)
    hud.mesh.renderOrder = 2
    d.group.add(hud.mesh)
    d.track({
      update: (dt: number) => {
        hud.mesh.visible = this.hudPower && game.sim.powered
        if (hud.mesh.visible) hud.update(dt)
      },
      dispose: () => hud.dispose()
    })
    // A thin frame at the sides and top, and the projector on the glareshield
    const z = -distance - 0.004
    for (const side of [-1, 1]) {
      d.box([0.006, height + 0.02, 0.006], [(side * (width + 0.006)) / 2, 0, z], MATERIALS.black)
    }
    d.box([width + 0.012, 0.006, 0.006], [0, height / 2 + 0.01, z], MATERIALS.black)
    d.box([0.12, 0.03, 0.12], [0, -0.1, -0.76], MATERIALS.black)
  }

  /**
   * F2 for the commander or F4 for the pilot: the flight control mode buttons, the drag
   * chute, the landing gear arm and down buttons, and the HUD power switch.
   */
  private sidePanel(main: Panel, side: number, v: (y: number) => number) {
    const d = this.deck
    const { pilot, sim } = game
    const c = pilot.controls
    const u = side * 1.07
    const size = { w: 0.03, h: 0.022 }
    const lit = (on: () => boolean) => () => (on() ? ('on' as const) : ('off' as const))
    const head = (text: string, at: number) => main.label(text, u, at, 0.0075)

    head('DAP', v(-0.15))
    d.button(main, 'AUTO', u - 0.028, v(-0.19), {
      press: () => {
        if (!pilot.autopilot.on) key('KeyZ')
      },
      lit: lit(() => pilot.autopilot.on),
      state: () => (pilot.autopilot.on ? 'ENGAGED' : 'OFF'),
      size
    })
    d.button(main, 'CSS', u + 0.028, v(-0.19), {
      press: () => {
        if (pilot.autopilot.on) key('KeyZ')
      },
      lit: lit(() => !pilot.autopilot.on),
      state: () => (pilot.autopilot.on ? 'OFF' : 'FLYING BY HAND'),
      size
    })

    head('LDG GEAR', v(-0.255))
    d.button(main, 'ARM', u - 0.028, v(-0.295), {
      press: () => {
        this.gearArmed = true
      },
      lit: lit(() => this.gearArmed),
      state: () => (this.gearArmed ? 'ARMED' : 'SAFE'),
      color: 0x3a3f44,
      size
    })
    d.button(main, 'DN', u + 0.028, v(-0.295), {
      // Down only once armed, and it stays down
      press: () => {
        if (this.gearArmed && !c.gearDown) key('KeyG')
      },
      lit: lit(() => c.gearDown && sim.gearPosition >= 1),
      state: () => (c.gearDown ? 'DOWN' : this.gearArmed ? 'PRESS TO LOWER' : 'ARM FIRST'),
      color: 0x3a3f44,
      size
    })
    for (let i = 0; i < 3; i++) {
      d.button(
        main,
        ['N', 'L', 'R'][i],
        u + (i - 1) * 0.022,
        v(-0.33),
        {
          lit: () => {
            const at = sim.gearPosition
            return !sim.powered || at <= 0 ? 'off' : at >= 1 ? 'on' : 'alert'
          },
          size: { w: 0.016, h: 0.012 }
        },
        false
      )
    }

    head('DRAG CHUTE', v(-0.375))
    const chute = ['ARM', 'DPY', 'JETT'] as const
    chute.forEach((name, i) => {
      d.button(main, name, u + (i - 1) * 0.04, v(-0.415), {
        press: () => {
          if (name === 'ARM' && this.chute === 'stowed') this.chute = 'armed'
          if (name === 'DPY' && this.chute === 'armed' && sim.onGround) this.chute = 'out'
          if (name === 'JETT' && this.chute === 'out') this.chute = 'gone'
        },
        lit: lit(() =>
          name === 'ARM'
            ? this.chute !== 'stowed'
            : name === 'DPY'
              ? this.chute === 'out'
              : this.chute === 'gone'
        ),
        state: () => this.chute.toUpperCase(),
        color: 0x3a3f44,
        size: { w: 0.026, h: 0.018 }
      })
    })

    if (side < 0) {
      d.rocker(main, 'HUD PWR', u, v(-0.5), {
        get: () => this.hudPower,
        set: on => {
          this.hudPower = on
        }
      })
    } else {
      d.rocker(main, 'HUD PWR', u, v(-0.5), { get: () => true, set: () => {} })
    }
    screen(
      d,
      main,
      u,
      v(-0.59),
      0.14,
      0.06,
      gaugeField({ rows: 2, columns: 6, kind: 'switches', seed: side < 0 ? 21 : 23 }),
      0,
      1200
    )
  }

  /** The overhead panels: electrics, cryogenics, the APUs, and lights, with breakers behind. */
  private overhead(panel: Panel) {
    const d = this.deck
    const { pilot } = game
    const c = pilot.controls
    const local: boolean[] = []
    const cosmetic = (label: string, u: number, v: number, on: boolean) => {
      const i = local.push(on) - 1
      d.rocker(panel, label, u, v, {
        get: () => local[i],
        set: value => {
          local[i] = value
        }
      })
    }
    // Where each panel sits, by its order in `titles`. The ones the commander works in
    // flight (O8's APUs, O1's buses, O9's landing lights) sit within reach of the left seat.
    const columns = [-0.38, 0.38, 0.76, -0.76, 0]
    const titles = ['O1  ELECTRICAL', 'O2  CRYO', 'O3  RCS / OMS', 'O8  APU / HYD', 'O9  LIGHTING']
    columns.forEach((u, i) => {
      panel.label(titles[i], u, -0.27, 0.009)
      screen(
        d,
        panel,
        u,
        0.19,
        0.34,
        0.2,
        gaugeField({ rows: 5, columns: 14, kind: 'breakers', seed: 31 + i }),
        0,
        800
      )
    })
    const row1 = -0.2
    const row2 = -0.11
    const row3 = -0.02
    const at = (column: number, k: number) => columns[column] + (k - 1.5) * 0.075
    // O1: main buses on the battery key, the fuel cells and inverters cosmetic
    ;['MN BUS A', 'MN BUS B', 'MN BUS C'].forEach((label, k) => {
      d.rocker(panel, label, at(0, k), row1, {
        get: () => c.battery,
        set: () => key('KeyO'),
        state: () => (c.battery ? 'ON' : 'OFF')
      })
    })
    cosmetic('ESS BUS', at(0, 3), row1, true)
    for (let k = 0; k < 4; k++) cosmetic(`FC ${k < 3 ? k + 1 : 'GPC'}`, at(0, k), row2, true)
    for (let k = 0; k < 4; k++) cosmetic(`INV ${k + 1}`, at(0, k), row3, k < 3)
    // O2: tank heaters
    for (let k = 0; k < 4; k++) cosmetic(`O2 HTR ${k + 1}`, at(1, k), row1, k < 2)
    for (let k = 0; k < 4; k++) cosmetic(`H2 HTR ${k + 1}`, at(1, k), row2, k < 2)
    for (let k = 0; k < 4; k++) cosmetic(`CRYO ${k + 1}`, at(1, k), row3, false)
    // O3: a dial field in place of the RCS and OMS meters
    screen(
      d,
      panel,
      0,
      -0.12,
      0.32,
      0.17,
      gaugeField({ rows: 2, columns: 5, kind: 'gauges', seed: 41 }),
      0,
      900
    )
    // O8: the three APUs on the engine switch, the fuel tank valves on the fuel pumps
    for (let k = 0; k < 3; k++) {
      d.rocker(panel, `APU ${k + 1} RUN`, at(3, k), row1, {
        get: () => c.engineSwitches[0],
        set: () => key('Digit1'),
        state: () => (c.engineSwitches[0] ? 'RUN' : 'OFF')
      })
      d.rocker(panel, `TK VLV ${k + 1}`, at(3, k), row2, {
        get: () => c.fuelPumps,
        set: () => key('KeyU'),
        state: () => (c.fuelPumps ? 'OPEN' : 'CLOSED')
      })
      cosmetic(`HYD ${k + 1}`, at(3, k), row3, true)
    }
    cosmetic('APU AUTO', at(3, 3), row1, true)
    cosmetic('BOILER', at(3, 3), row2, true)
    cosmetic('WSB', at(3, 3), row3, false)
    // O9: the landing lights are functional, the rest cosmetic
    d.rocker(panel, 'LDG LTS', at(4, 0), row1, {
      get: () => pilot.landingLights,
      set: () => key('KeyL'),
      state: () => (pilot.landingLights ? 'ON' : 'OFF')
    })
    cosmetic('FLOOD', at(4, 1), row1, true)
    cosmetic('PANEL', at(4, 2), row1, true)
    cosmetic('ANNUN', at(4, 3), row1, true)
    for (let k = 0; k < 4; k++) cosmetic(`DOCK ${k + 1}`, at(4, k), row2, false)
    for (let k = 0; k < 4; k++) cosmetic(`MDU ${k + 1}`, at(4, k), row3, true)
  }

  /** The centre console between the seats: keyboards and the parking brake. */
  private centreConsole(panel: Panel) {
    const d = this.deck
    const c = game.pilot.controls
    for (const u of [-0.09, 0.09]) {
      screen(
        d,
        panel,
        u,
        0.1,
        0.15,
        0.14,
        gaugeField({ rows: 8, columns: 6, kind: 'switches', seed: u < 0 ? 51 : 53 }),
        0,
        1200
      )
      panel.label('KEYBOARD', u, 0.185, 0.0075)
    }
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'PARK BRK',
        panel.at(0, -0.1, 0.02),
        panel.at(0, -0.1, 0.07),
        panel.at(0, -0.1, -0.04),
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
    panel.label('PARK BRAKE', 0, -0.065)
  }

  /** The left console: the speed brake and thrust controller, back to open the brake. */
  private leftConsole(panel: Panel) {
    const d = this.deck
    const c = game.pilot.controls
    // The console's body stops below the panel's lower edge, so no switch field is buried
    d.box([0.22, 0.62, 0.8], [-0.72, -0.9, -0.15], MATERIALS.grey)
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'SPEED BRAKE',
        panel.at(0.13, -0.02, 0.06),
        panel.at(-0.07, -0.02, 0.06),
        panel.at(0.03, -0.02, -0.06),
        {
          get: () => (c.speedBrake ? 1 : 0),
          set: (value, released) => {
            if (released && value > 0.5 !== c.speedBrake) key('KeyB')
          },
          detents: [0, 1],
          knob: { color: 0x2a2c2e, shape: 'box' },
          state: () => (c.speedBrake ? 'OPEN' : 'CLOSED')
        }
      )
    )
    panel.label('SBTC', 0.03, 0.06, 0.009)
    panel.label('CLOSE', 0.16, 0.035, 0.007)
    panel.label('OPEN', -0.1, 0.035, 0.007)
    screen(
      d,
      panel,
      -0.23,
      0,
      0.2,
      0.2,
      gaugeField({ title: 'L1', rows: 4, columns: 5, kind: 'switches', seed: 61 }),
      0,
      1200
    )
    screen(
      d,
      panel,
      0.27,
      0,
      0.14,
      0.2,
      gaugeField({ title: 'L2', rows: 4, columns: 3, kind: 'switches', seed: 63 }),
      0,
      1200
    )
  }

  /** Hides the screens drawn once while the power is off. */
  protected tick() {
    const on = game.sim.powered
    for (const mesh of this.fixedScreens) mesh.visible = on
  }
}

/** The cockpits this file builds, by aircraft id. */
export const COCKPITS = { shuttle: ShuttleCockpit }
