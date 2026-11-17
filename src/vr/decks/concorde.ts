import { Euler, Group, Vector3 } from 'three'
import { game } from '../../game/game'
import { WARNINGS } from '../../game/gpws'
import type { AircraftSpec } from '../../sim/aircraft'
import { LAMPS } from '../../ui/lamps'
import { FEET_PER_METRE, FPM_PER_MS, KNOTS_PER_MS } from '../../ui/telemetry'
import { key } from '../cockpit'
import { type Buzz, Lever, Yoke } from '../controls'
import { DeckCockpit, MATERIALS, type Panel } from '../deck'
import {
  AirspeedIndicator,
  Altimeter,
  AttitudeIndicator,
  CourseIndicator,
  type HalfGauge,
  HeadingIndicator,
  TwinGauge,
  VerticalSpeedIndicator
} from '../gauges'
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
 * Concorde's flight deck: a narrow nose with two small forward panes and the visor outside
 * them, ram's horn yokes, a dense analog panel with the engine instruments in four columns
 * down the middle, four throttles on the pedestal, the nose and visor lever, the overhead,
 * and the flight engineer's wall behind the first officer. The captain sits left, so the
 * centreline is 0.5 m right of the eye.
 */

const DEG = Math.PI / 180
const CL = 0.5
const FLOOR = -1.1

/** Mach number on a small lit counter, as the Machmeter's digits. */
function machCounter(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#0b0b0b'
  ctx.fillRect(0, 0, w, h)
  const { sim } = game
  if (!sim.powered) return
  ctx.fillStyle = '#f4f4ec'
  ctx.font = `700 ${h * 0.36}px ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`M ${sim.mach.toFixed(2)}`, w / 2, h * 0.38)
  ctx.fillStyle = '#9aa0a6'
  ctx.font = `700 ${h * 0.2}px system-ui, sans-serif`
  ctx.fillText('MACH', w / 2, h * 0.8)
}

/** Fuel on board in tonnes, on the centre panel's totaliser. */
function fuelCounter(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#0a0b0c'
  ctx.fillRect(0, 0, w, h)
  const { sim } = game
  if (!sim.powered) return
  ctx.fillStyle = '#ff9a3a'
  ctx.font = `700 ${h * 0.5}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`FUEL ${(sim.fuel / 1000).toFixed(1)} T`, w / 2, h / 2, w * 0.94)
}

/** The Concorde flight deck. */
export class ConcordeCockpit extends DeckCockpit {
  /** The visor, outside the forward panes: up for supersonic flight, down with the nose. */
  private readonly visor = new Group()
  /** Metres the visor has slid down its rails, from 0 (up) to `VISOR_TRAVEL`. */
  private visorDown = 0
  private readonly visorSlide = new Vector3()

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const { pilot, sim } = game
    const c = pilot.controls
    this.reverseRegion = 0.12

    this.shell()

    // Main panel: the captain's and first officer's flight instruments, engines between
    const main = d.panel([CL, -0.39, -0.7], 1.9, 0.52, [0, 0, 0], MATERIALS.grey, 0.3)
    const v = (y: number) => y + 0.39
    for (const side of [-1, 1]) this.flightInstruments(main, side * 0.5, v)
    this.engineInstruments(main, v)
    this.gearLever(main, 0.3, v(-0.25))
    this.noseLever(main, 0.2, v(-0.24))

    // Glareshield: the autopilot and the master warning lights
    const shield = d.panel([CL, -0.103, -0.657], 1.9, 0.056, [-0.35, 0, 0], MATERIALS.black, 0.05)
    this.autoflight(shield)

    this.overhead(
      d.panel([CL, 0.235, -0.13], 0.9, 0.62, [1.45, 0, 0], finish(0x5c636b, 0x2a2f34), 0.05),
      sim.engines.length
    )
    this.pedestal(d.panel([CL, -0.56, -0.36], 0.34, 0.6, [-1.45, 0, 0], MATERIALS.grey, 0.5))
    this.engineerStation()

    // Ram's horn yokes on columns from the floor, the first officer's moving with the captain's
    this.flight = d.add(
      new Yoke(d.group, d.buzz, new Vector3(0, -0.38, -0.43), new Vector3(2 * CL, -0.38, -0.43))
    )
    for (const x of [0, 2 * CL]) {
      d.box([0.05, 0.4, 0.05], [x, -0.82, -0.62], MATERIALS.black)
      // Rudder pedals
      for (const side of [-1, 1]) {
        d.box([0.08, 0.16, 0.03], [x + side * 0.12, -0.98, -0.72], MATERIALS.frame, [-0.5, 0, 0])
      }
    }

    // Tablet low on the captain's side console, clear of the panel and the side window
    this.tablet = {
      position: new Vector3(-0.3, -0.33, -0.06),
      rotation: new Euler(-0.45, 1.2, 0, 'YXZ')
    }
    this.checklists = [
      {
        title: 'Before Start',
        items: [
          { text: 'Battery: ON', done: () => c.battery },
          { text: 'Fuel pumps: ON', done: () => c.fuelPumps },
          { text: 'Parking brake: SET', done: () => c.parkingBrake },
          { text: 'Throttles: IDLE', done: () => c.throttle < 0.05 && !c.reverse }
        ]
      },
      {
        title: 'Engine Start',
        items: [
          ...sim.engines.map((_, i) => ({
            text: `Engine ${i + 1} start: ON`,
            done: () => c.engineSwitches[i]
          })),
          { text: 'All four running', done: () => sim.enginesRunning === sim.engines.length }
        ]
      },
      {
        title: 'Takeoff',
        items: [
          { text: 'Visor DOWN, nose 5°', done: () => c.flapNotch === 1 },
          { text: 'Landing lights: ON', done: () => pilot.landingLights },
          { text: 'Parking brake: OFF', done: () => !c.parkingBrake },
          { text: 'Throttles to the reheat gate', done: () => sim.afterburner },
          { text: 'Rotate at 195 kt', done: () => !sim.onGround },
          { text: 'Gear: UP', done: () => !c.gearDown }
        ]
      },
      {
        title: 'Climb and Cruise',
        items: [
          { text: 'Nose and visor: UP above 250 kt', done: () => c.flapNotch === 0 },
          { text: 'Reheat: OFF after takeoff', done: () => !sim.onGround && !sim.afterburner },
          { text: 'Reheat for the transonic push', done: () => sim.mach > 0.95 },
          { text: 'Cruise at Mach 2', done: () => sim.mach > 1.95 }
        ]
      },
      {
        title: 'Approach and Landing',
        items: [
          { text: 'Visor DOWN, nose 12.5°', done: () => c.flapNotch === 2 },
          { text: 'Gear: DOWN below 270 kt', done: () => c.gearDown },
          { text: 'Approach at 165 kt, nose high', done: () => sim.altitudeAgl < 300 },
          { text: 'Touchdown, reverse thrust', done: () => sim.onGround && c.reverse }
        ]
      }
    ]
    this.finish()
  }

  /**
   * The cabin shell: the forward panes, the angled side panes, the small side windows,
   * the roof, the walls to the floor, the visor, and the seats.
   */
  private shell() {
    const d = this.deck
    const g = d.group
    const skin = lining(0x8f8b82, 0x3a3833)
    const dark = lining(0x24272b, 0x08090a)
    // Window sill, windscreen top, and where the angled panes meet the side walls
    const FBL = p(-0.24, -0.12, -1.02)
    const FTL = p(-0.2, 0.19, -0.77)
    const SBL = p(-0.5, -0.12, -0.6)
    const STL = p(-0.44, 0.25, -0.5)
    const WBL = p(-0.52, -0.12, 1.6)
    const WTL = p(-0.46, 0.34, 1.6)
    const R = (v: Vector3) => p(2 * CL - v.x, v.y, v.z)
    const down = (v: Vector3) => p(v.x, FLOOR, v.z)

    // Two small forward panes either side of a centre post
    const forward: Corners = [FBL, R(FBL), R(FTL), FTL]
    wall(
      g,
      forward,
      [
        [0.035, 0.1, 0.47, 0.88],
        [0.53, 0.1, 0.965, 0.88]
      ],
      dark
    )
    // Angled side panes, then the small side window in each wall
    const angled: Corners = [SBL, FBL, FTL, STL]
    const angledHoles: [number, number, number, number][] = [[0.1, 0.12, 0.88, 0.86]]
    wall(g, angled, angledHoles, dark)
    wall(g, mirror(angled, CL), mirrorHoles(angledHoles), dark)
    const side: Corners = [WBL, SBL, STL, WTL]
    const sideHoles: [number, number, number, number][] = [[0.78, 0.22, 0.93, 0.8]]
    wall(g, side, sideHoles, skin)
    wall(g, mirror(side, CL), mirrorHoles(sideHoles), skin)
    // Lower walls to the floor
    for (const corners of [
      [down(WBL), down(SBL), SBL, WBL],
      [down(SBL), down(FBL), FBL, SBL],
      [down(FBL), down(R(FBL)), R(FBL), FBL]
    ] as Corners[]) {
      wall(g, corners, [], skin)
      if (corners[0].x < CL && corners[1].x < CL) wall(g, mirror(corners, CL), [], skin)
    }
    // Roof: over the windscreen, then over the crew back to the bulkhead
    wall(g, [FTL, R(FTL), R(STL), STL], [], skin)
    wall(g, [STL, R(STL), R(WTL), WTL], [], skin)
    // Glareshield top, from the sill back to its lip over the panel
    wall(g, [FBL, R(FBL), p(2 * CL + 0.47, -0.075, -0.645), p(-0.47, -0.075, -0.645)], [], dark)
    // Floor and the bulkhead behind the crew
    d.box([2.1, 0.04, 2.8], [CL, FLOOR, 0.3], MATERIALS.floor)
    d.box([2.1, 1.5, 0.04], [CL, -0.4, 1.6], MATERIALS.lining)

    // The visor: a frame with its own narrow windows, 35 mm outside the forward panes
    const outward = new Vector3()
      .subVectors(R(FBL), FBL)
      .cross(new Vector3().subVectors(FTL, FBL))
      .normalize()
      .multiplyScalar(-0.035)
    const lift = (v: Vector3) => v.clone().add(outward)
    const visorSkin = lining(0xc8c8c2, 0x46464a)
    wall(
      this.visor,
      [lift(p(-0.3, -0.13, -1.05)), lift(p(1.3, -0.13, -1.05)), lift(R(FTL)), lift(FTL)],
      [
        [0.08, 0.16, 0.47, 0.8],
        [0.53, 0.16, 0.92, 0.8]
      ],
      visorSkin
    )
    g.add(this.visor)
    // It slides down and forward along the windscreen, under the nose
    this.visorSlide.subVectors(FBL, FTL).normalize()

    // Seats, and the side consoles under the side windows
    for (const x of [0, 2 * CL]) {
      d.box([0.48, 0.12, 0.48], [x, -0.8, 0.28], MATERIALS.seat)
      d.box([0.48, 0.72, 0.1], [x, -0.4, 0.56], MATERIALS.seat, [-0.12, 0, 0])
    }
    for (const x of [-0.4, 2 * CL + 0.4]) {
      d.box([0.18, 0.5, 1.0], [x, -0.85, -0.05], MATERIALS.grey)
      d.box([0.16, 0.012, 0.9], [x, -0.597, -0.05], MATERIALS.black)
    }
    // Nose wheel tiller on the captain's console
    d.box([0.07, 0.012, 0.07], [-0.4, -0.58, -0.3], MATERIALS.black)
  }

  /** The flight engineer's wall behind the first officer, and his seat and desk. */
  private engineerStation() {
    const d = this.deck
    const wallPanel = d.panel(
      [2 * CL + 0.47, -0.12, 0.95],
      1.15,
      0.85,
      [0, -Math.PI / 2, 0],
      MATERIALS.grey,
      0.06
    )
    screen(
      d,
      wallPanel,
      0,
      0.06,
      1.08,
      0.64,
      gaugeField({ title: 'FLIGHT ENGINEER', rows: 6, columns: 12, kind: 'gauges' }),
      0,
      900
    )
    screen(
      d,
      wallPanel,
      0,
      -0.34,
      1.08,
      0.12,
      gaugeField({ rows: 2, columns: 24, kind: 'switches', seed: 3 }),
      0,
      900
    )
    d.box([0.35, 0.05, 1.0], [2 * CL + 0.3, -0.58, 0.95], MATERIALS.grey)
    d.box([0.42, 0.1, 0.42], [2 * CL - 0.1, -0.82, 1.05], MATERIALS.seat)
  }

  /** Airspeed, attitude, altimeter, ILS, heading, and climb rate, centred on a pilot. */
  private flightInstruments(panel: Panel, u: number, v: (y: number) => number) {
    const d = this.deck
    const { sim, pilot, nav } = game
    const D = 0.088
    const row1 = v(-0.205)
    const row2 = v(-0.315)
    const dx = 0.105
    d.instrument(
      panel,
      u - dx,
      row1,
      new AirspeedIndicator(D, this.spec.gauges.airspeed, () =>
        sim.powered ? sim.indicatedAirspeed * KNOTS_PER_MS : 0
      )
    )
    d.instrument(
      panel,
      u,
      row1,
      new AttitudeIndicator(D * 1.1, () => ({ pitch: sim.pitch, bank: sim.bank }))
    )
    d.instrument(panel, u + dx, row1, new Altimeter(D, () => sim.position.y * FEET_PER_METRE))
    d.instrument(
      panel,
      u - dx,
      row2,
      new CourseIndicator(D, () => {
        const valid = sim.powered && nav.approach !== null && nav.guidance.receiving
        return {
          lateral: nav.guidance.lateral,
          vertical: nav.guidance.vertical,
          course: nav.approach?.end.heading ?? 0,
          valid,
          slope: valid && nav.approach?.kind === 'ILS'
        }
      })
    )
    d.instrument(
      panel,
      u,
      row2,
      new HeadingIndicator(D * 1.1, () => ({
        heading: sim.heading / DEG,
        bug: pilot.autopilot.heading / DEG
      }))
    )
    d.instrument(
      panel,
      u + dx,
      row2,
      new VerticalSpeedIndicator(D, this.spec.gauges.climb, () => sim.verticalSpeed * FPM_PER_MS)
    )
    // Machmeter counter outboard, with the clock below it
    const out = u < 0 ? u - 0.215 : u + 0.215
    screen(d, panel, out, row1, 0.07, 0.04, machCounter, 4, 2000)
    d.instrument(panel, out, row2, new Altimeter(0.06, () => sim.altitudeAgl * FEET_PER_METRE))
    panel.label('RAD ALT', out, row2 + 0.042, 0.007)
  }

  /** The engine instruments: four columns, one per engine, in pairs of twin gauges. */
  private engineInstruments(panel: Panel, v: (y: number) => number) {
    const d = this.deck
    const { sim } = game
    const engine = (i: number) => sim.engines[i]
    const running = (i: number) => engine(i)?.running ?? false
    const rows: [string, (i: number) => number, HalfGauge['bands']][] = [
      ['N1', i => (engine(i)?.rpm ?? 0) / 110, [{ from: 0.2, to: 0.92, color: 'green' }]],
      [
        'N2',
        i => ((engine(i)?.rpm ?? 0) * 0.92 + (running(i) ? 8 : 0)) / 110,
        [{ from: 0.5, to: 0.95, color: 'green' }]
      ],
      [
        'EGT',
        i => (running(i) ? 0.3 + 0.6 * (engine(i)?.power ?? 0) : 0),
        [
          { from: 0.2, to: 0.85, color: 'green' },
          { from: 0.85, to: 1, color: 'red' }
        ]
      ],
      [
        'FUEL FLOW',
        i => (running(i) ? 0.1 + 0.85 * (engine(i)?.power ?? 0) : 0),
        [{ from: 0.1, to: 0.9, color: 'green' }]
      ],
      [
        'NOZZLE',
        i => (running(i) ? (sim.afterburner ? 0.9 : 0.35 + 0.3 * (engine(i)?.power ?? 0)) : 0),
        [{ from: 0.75, to: 1, color: 'yellow' }]
      ]
    ]
    rows.forEach(([name, read, bands], r) => {
      const y = v(-0.165 - r * 0.052)
      panel.label(name, 0, y + 0.026, 0.0065)
      for (const pair of [0, 1]) {
        const a = pair * 2
        const gauge = new TwinGauge(0.082, 0.042, [
          { label: String(a + 1), bands, read: () => read(a) },
          { label: String(a + 2), bands, read: () => read(a + 1) }
        ])
        d.instrument(panel, (pair - 0.5) * 0.094, y, gauge)
      }
    })
    // Reheat lights: lit while the afterburners burn
    for (let i = 0; i < 4; i++) {
      d.button(
        panel,
        `RHT ${i + 1}`,
        (i - 1.5) * 0.045,
        v(-0.465),
        {
          lit: () => (sim.afterburner && running(i) ? 'alert' : 'off'),
          state: () => (sim.afterburner && running(i) ? 'LIT' : 'OFF'),
          size: { w: 0.034, h: 0.02 }
        },
        true
      )
    }
    screen(d, panel, -0.05, v(-0.53), 0.085, 0.026, fuelCounter, 1, 2400)
    d.plate(panel, 0.05, v(-0.53), 0.085, 0.026, 'CG 53.5%')
  }

  /** The landing gear lever with its wheel-shaped knob, up for UP and down for DOWN. */
  private gearLever(panel: Panel, u: number, v: number) {
    const c = game.pilot.controls
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        'GEAR',
        panel.at(u, v + 0.06, 0.07),
        panel.at(u, v - 0.06, 0.07),
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
    const panelLabel = (text: string, du: number, dv: number) =>
      panel.label(text, u + du, v + dv, 0.0075)
    panelLabel('L/G', 0, 0.09)
    panelLabel('UP', 0.03, 0.06)
    panelLabel('DN', 0.03, -0.06)
    // Three gear lights below the lever
    for (let i = 0; i < 3; i++) {
      this.deck.button(
        panel,
        ['L', 'N', 'R'][i],
        u + (i - 1) * 0.022,
        v - 0.105,
        {
          lit: () => {
            const p = game.sim.gearPosition
            return !game.sim.powered || p <= 0 ? 'off' : p >= 1 ? 'on' : 'alert'
          },
          size: { w: 0.016, h: 0.014 }
        },
        false
      )
    }
  }

  /** The nose and visor lever: up for visor up, then the 5° and 12.5° nose droop. */
  private noseLever(panel: Panel, u: number, v: number) {
    const c = game.pilot.controls
    const labels = this.spec.flapLabels
    const notches = labels.length - 1
    this.deck.add(
      new Lever(
        this.deck.group,
        this.deck.buzz,
        'NOSE / VISOR',
        panel.at(u, v + 0.07, 0.06),
        panel.at(u, v - 0.07, 0.06),
        panel.at(u, v, 0),
        {
          get: () => c.flapNotch / notches,
          set: value => {
            if (game.getState().status === 'flying') c.flapNotch = Math.round(value * notches)
          },
          detents: labels.map((_, i) => i / notches),
          knob: { color: 0xd0d0c8, shape: 'tee' },
          state: () =>
            c.flapNotch === 0 ? 'NOSE AND VISOR UP' : `VISOR DOWN, NOSE ${labels[c.flapNotch]}`
        }
      )
    )
    panel.label('NOSE', u, v + 0.1, 0.0075)
    labels.forEach((label, i) => {
      panel.label(i === 0 ? 'UP' : label, u - 0.035, v + 0.07 - (0.14 * i) / notches, 0.007)
    })
  }

  /** Autopilot on the glareshield, with the master warning and caution each side. */
  private autoflight(shield: Panel) {
    const d = this.deck
    const { pilot, sim, nav } = game
    const c = pilot.controls
    const flying = () => game.getState().status === 'flying'
    const knob = (
      label: string,
      u: number,
      turn: (clicks: number) => void,
      press: () => void,
      state: () => string
    ) => d.knob(shield, label, u, -0.008, { step: 12 * DEG, radius: 0.01, turn, press, state })
    knob(
      'IAS',
      -0.24,
      clicks => pilot.adjust('speed', clicks),
      () => key('KeyX'),
      () => 'turn to set, push for autothrottle'
    )
    knob(
      'HDG',
      -0.1,
      clicks => pilot.adjust('heading', clicks),
      () => flying() && pilot.setLateral('HDG', sim, nav),
      () => 'turn to set, push for heading hold'
    )
    knob(
      'ALT',
      0.1,
      clicks => pilot.adjust('altitude', clicks),
      () => flying() && pilot.setVertical('FLCH', sim, nav),
      () => 'turn to set, push to climb or descend'
    )
    knob(
      'V/S',
      0.24,
      clicks => pilot.adjust('verticalSpeed', clicks),
      () => flying() && pilot.setVertical('VS', sim, nav),
      () => 'turn to set, push for vertical speed'
    )
    const small = { w: 0.026, h: 0.014 }
    const { autopilot } = pilot
    d.button(shield, 'AP 1', -0.03, 0.002, {
      press: () => key('KeyZ'),
      lit: () => (autopilot.on ? 'on' : 'off'),
      size: small
    })
    d.button(shield, 'A/THR', 0.03, 0.002, {
      press: () => key('KeyX'),
      lit: () => (pilot.autothrottle.on ? 'on' : 'off'),
      size: small
    })
    d.button(shield, 'NAV', -0.17, 0.002, {
      press: () =>
        flying() && pilot.setLateral(autopilot.lateral === 'NAV' ? 'HDG' : 'NAV', sim, nav),
      lit: () => (autopilot.on && autopilot.lateral === 'NAV' ? 'on' : 'off'),
      size: small
    })
    d.button(shield, 'LAND', 0.17, 0.002, {
      press: () => flying() && game.toggleApproachAutopilot(),
      lit: () => (pilot.flyingApproach ? 'on' : 'off'),
      size: small
    })
    const lamps = LAMPS.filter(lamp => lamp.kind === 'warning')
    const warning = () =>
      sim.powered &&
      (lamps.some(lamp => lamp.on(sim, c)) ||
        (game.gpws.alert !== null && WARNINGS.has(game.gpws.alert)))
    const caution = () => sim.powered && game.gpws.alert !== null && !WARNINGS.has(game.gpws.alert)
    const flashing = () => Math.floor(performance.now() / 400) % 2 === 0
    for (const u of [-0.7, 0.62]) {
      d.button(shield, 'WARN', u, 0, {
        lit: () => (warning() && flashing() ? 'alert' : 'off'),
        color: 0x5a1010,
        size: { w: 0.032, h: 0.02 }
      })
      d.button(shield, 'CAUT', u + 0.05, 0, {
        lit: () => (caution() ? 'alert' : 'off'),
        color: 0x5a3a10,
        size: { w: 0.032, h: 0.02 }
      })
    }
  }

  /** The overhead: engine fire and start, electrics, fuel pumps, anti-ice, and lights. */
  private overhead(panel: Panel, engines: number) {
    const d = this.deck
    const { pilot, sim } = game
    const c = pilot.controls
    const local = {
      ignition: false,
      antiIce: false,
      nav: true,
      beacon: true,
      strobe: false,
      blue: true,
      green: true,
      intakes: [true, true, true, true]
    }
    type Flag = Exclude<keyof typeof local, 'intakes'>
    const flip = (name: Flag) => () => {
      local[name] = !local[name]
    }
    const lit = (on: () => boolean) => () => (on() ? ('on' as const) : ('off' as const))
    const at = (i: number) => (i - (engines - 1) / 2) * 0.09
    const heading = (text: string, u: number, v: number) => panel.label(text, u, v, 0.009)

    heading('ENG FIRE', 0, -0.2)
    for (let i = 0; i < engines; i++) {
      d.button(panel, `FIRE ${i + 1}`, at(i), -0.25, {
        press: () => {
          if (sim.engines[i]?.fire) sim.extinguish(i, c.engineSwitches[i])
        },
        lit: () => (sim.engines[i]?.fire ? 'alert' : 'off'),
        color: 0x6a1010,
        size: { w: 0.04, h: 0.024 }
      })
      d.rocker(panel, `START ${i + 1}`, at(i), -0.145, {
        get: () => c.engineSwitches[i],
        set: () => key(`Digit${i + 1}`),
        state: () => (c.engineSwitches[i] ? 'ON' : 'OFF')
      })
      d.rocker(panel, `INTAKE ${i + 1}`, at(i), 0.07, {
        get: () => local.intakes[i],
        set: on => {
          local.intakes[i] = on
        },
        state: () => (local.intakes[i] ? 'AUTO' : 'MANUAL')
      })
    }
    // Flying controls: the blue and green hydraulic channels, outboard left
    heading('FLT CTL', -0.34, -0.2)
    d.rocker(panel, 'BLUE', -0.37, -0.25, { get: () => local.blue, set: flip('blue') })
    d.rocker(panel, 'GREEN', -0.31, -0.25, { get: () => local.green, set: flip('green') })
    // Electrics and fuel, the functional ones on the battery and fuel pump keys
    heading('ELEC AND FUEL', 0, 0.01)
    const size = { w: 0.034, h: 0.022 }
    const row = -0.035
    d.button(panel, 'BATTERY', -0.3, row, {
      press: () => key('KeyO'),
      lit: lit(() => c.battery),
      size
    })
    d.button(panel, 'IGNITION', -0.15, row, {
      press: flip('ignition'),
      lit: lit(() => local.ignition),
      size
    })
    d.button(panel, 'FUEL PUMPS', 0.15, row, {
      press: () => key('KeyU'),
      lit: lit(() => c.fuelPumps),
      size
    })
    d.button(panel, 'ANTI ICE', 0.3, row, {
      press: flip('antiIce'),
      lit: lit(() => local.antiIce),
      size
    })
    heading('EXT LIGHTS', 0, 0.21)
    const lights: [string, () => boolean, () => void][] = [
      ['NAV', () => local.nav, flip('nav')],
      ['BEACON', () => local.beacon, flip('beacon')],
      ['STROBE', () => local.strobe, flip('strobe')],
      ['LANDING', () => pilot.landingLights, () => key('KeyL')]
    ]
    lights.forEach(([label, get, set], i) => {
      d.rocker(panel, label, (i - 1.5) * 0.11, 0.165, { get, set: () => set() })
    })
    // Circuit breakers fill the back of the overhead
    screen(
      d,
      panel,
      0,
      0.27,
      0.82,
      0.06,
      gaugeField({ rows: 2, columns: 30, kind: 'breakers', seed: 11 }),
      0,
      900
    )
  }

  /** The pedestal: four throttles, the parking brake, and the radios. */
  private pedestal(panel: Panel) {
    const d = this.deck
    const c = game.pilot.controls
    const count = game.sim.engines.length
    const spacing = 0.058
    // Rated thrust at the start of the reheat gate, as a share of the lever's travel
    const reheat = this.reverseRegion + 0.85 * (1 - this.reverseRegion)
    for (let i = 0; i < count; i++) {
      const u = (i - (count - 1) / 2) * spacing
      this.throttles.push(
        d.add(
          new Lever(
            d.group,
            d.buzz,
            `THROTTLE ${i + 1}`,
            panel.at(u, 0.04, 0.07),
            panel.at(u, 0.24, 0.09),
            panel.at(u, 0.14, -0.06),
            {
              get: () => this.leverPosition(),
              set: () => {},
              notches: [this.reverseRegion, reheat, 1],
              knob: { color: 0x2a2c2e, shape: 'ball' },
              state: () =>
                c.reverse
                  ? 'REVERSE'
                  : game.sim.afterburner
                    ? 'REHEAT'
                    : `${Math.round(c.throttle * 100)}%`
            }
          )
        )
      )
    }
    const edge = spacing * (count / 2) + 0.03
    for (const [label, v] of [
      ['REHEAT', 0.24],
      ['MAX', 0.04 + 0.2 * reheat],
      ['IDLE', 0.04 + 0.2 * this.reverseRegion],
      ['REV', 0.04]
    ] as const) {
      panel.label(label, edge, v, 0.0065)
      panel.label(label, -edge, v, 0.0065)
    }
    // Parking brake handle: pull up to set
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'PARK BRK',
        panel.at(0, -0.06, 0.02),
        panel.at(0, -0.06, 0.07),
        panel.at(0, -0.06, -0.04),
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
    panel.label('PARK BRAKE', 0, -0.03)
    d.plate(panel, -0.075, -0.13, 0.13, 0.03, 'VHF 1  118.70')
    d.plate(panel, 0.075, -0.13, 0.13, 0.03, 'VHF 2  121.50')
    d.plate(panel, -0.075, -0.18, 0.13, 0.03, 'ADF  0350')
    d.plate(panel, 0.075, -0.18, 0.13, 0.03, 'ATC  7000')
    screen(
      d,
      panel,
      0,
      -0.25,
      0.3,
      0.07,
      gaugeField({ rows: 2, columns: 10, kind: 'switches', seed: 5 }),
      0,
      1200
    )
  }

  /** Slides the visor down with the nose, and back up for supersonic flight. */
  protected tick(dt: number) {
    const target = game.pilot.controls.flapNotch > 0 ? VISOR_TRAVEL : 0
    const step = dt * 0.12
    this.visorDown += Math.max(-step, Math.min(step, target - this.visorDown))
    this.visor.position.copy(this.visorSlide).multiplyScalar(this.visorDown)
    this.visor.visible = this.visorDown < VISOR_TRAVEL
  }
}

/** Metres the visor slides down its rails, enough to clear the forward panes. */
const VISOR_TRAVEL = 0.34

/** The cockpits this file builds, by aircraft id. */
export const COCKPITS = { concorde: ConcordeCockpit }
