import { Vector3 } from 'three'
import { game } from '../../game/game'
import { WARNINGS } from '../../game/gpws'
import type { AircraftSpec } from '../../sim/aircraft'
import { LAMPS } from '../../ui/lamps'
import { FEET_PER_METRE, FPM_PER_MS, KNOTS_PER_MS } from '../../ui/telemetry'
import { key } from '../cockpit'
import { type Buzz, Lever, Stick } from '../controls'
import { DeckCockpit, MATERIALS, type Panel } from '../deck'
import { engineDisplay, navigationDisplay, primaryFlight } from '../glass'

/*
 * Airbus A320 and A380 flight decks: the captain's left sidestick, the glareshield's flight
 * control unit, two displays each side and two in the middle, the overhead panel, and the
 * pedestal with the thrust levers, flaps, speedbrake, and engine master switches. The
 * captain sits left, so the centreline is to the right of the eye.
 */

const DEG = Math.PI / 180

/** Text drawn on the flight control unit's displays: selected values, or dashes when managed. */
function fcuDisplay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#0b0b0b'
  ctx.fillRect(0, 0, w, h)
  const { sim, pilot } = game
  if (!sim.powered) return
  const { autopilot, autothrottle } = pilot
  ctx.fillStyle = '#ff9a3a'
  ctx.font = `700 ${h * 0.5}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const managedLateral = autopilot.on && autopilot.lateral !== 'HDG'
  const managedVertical =
    autopilot.on && (autopilot.vertical === 'VNAV' || autopilot.vertical === 'APP')
  const speed = autothrottle.on ? String(Math.round(autothrottle.speed * KNOTS_PER_MS)) : '---'
  const heading = managedLateral
    ? '---'
    : String(Math.round((((autopilot.heading / DEG) % 360) + 360) % 360)).padStart(3, '0')
  const altitude = String(Math.round((autopilot.altitude * FEET_PER_METRE) / 100) * 100).padStart(
    5,
    '0'
  )
  const vs =
    autopilot.vertical === 'VS'
      ? `${autopilot.verticalSpeed >= 0 ? '+' : ''}${Math.round((autopilot.verticalSpeed * FPM_PER_MS) / 100) * 100}`
      : '-----'
  ctx.fillText(`SPD ${speed}`, w * 0.11, h / 2)
  ctx.fillText(`HDG ${heading}`, w * 0.33, h / 2)
  ctx.fillText(`ALT ${altitude}${managedVertical ? ' •' : ''}`, w * 0.62, h / 2)
  ctx.fillText(`V/S ${vs}`, w * 0.87, h / 2)
}

/** The flight computer's flight plan page, on the pedestal's keypad screens. */
function mcduDisplay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#05070a'
  ctx.fillRect(0, 0, w, h)
  const { sim, nav } = game
  if (!sim.powered) return
  ctx.font = `700 ${h * 0.09}px ui-monospace, monospace`
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.fillText('F-PLN', w / 2, h * 0.04)
  ctx.textAlign = 'left'
  const points = nav.waypoints.slice(nav.waypointAhead, nav.waypointAhead + 6)
  if (points.length === 0) {
    ctx.fillStyle = '#4be36f'
    ctx.fillText('NO FLIGHT PLAN', w * 0.06, h * 0.3)
    return
  }
  let from = sim.position
  points.forEach((fix, i) => {
    const nm = Math.hypot(fix.x - from.x, fix.z - from.z) / 1852
    from = new Vector3(fix.x, 0, fix.z)
    ctx.fillStyle = i === 0 ? '#e06bf0' : '#4be36f'
    ctx.fillText(fix.name.padEnd(7), w * 0.06, h * (0.2 + i * 0.13))
    ctx.fillStyle = '#ffffff'
    ctx.fillText(
      `${nm.toFixed(0).padStart(3)}NM  ${Math.round((fix.altitude * FEET_PER_METRE) / 100) * 100}`,
      w * 0.45,
      h * (0.2 + i * 0.13)
    )
  })
}

/** The Airbus A320 and A380 flight decks. */
export class AirbusCockpit extends DeckCockpit {
  private readonly master: { warning: () => boolean; caution: () => boolean }

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const { pilot, sim } = game
    const c = pilot.controls
    const big = spec.id === 'a380'
    // The captain sits left of the centreline; the A380's deck is wider
    const CL = big ? 0.62 : 0.55
    const screen = big ? 0.2 : 0.178
    this.reverseRegion = 0.12

    // Shell: floor, side walls, windscreen posts, roof, and the seats
    const left = -0.62
    const right = 2 * CL + 0.62
    const width = right - left
    d.box([width, 0.04, 2.2], [CL, -1.05, 0], MATERIALS.floor)
    for (const x of [left, right]) {
      d.box([0.04, 0.85, 1.8], [x, -0.62, 0.05], MATERIALS.lining)
    }
    d.box([width, 0.04, 1.6], [CL, 0.46, 0.1], MATERIALS.lining)
    const post = (x: number, z: number, lean: number) =>
      d.beam(new Vector3(x, -0.09, z), new Vector3(x + lean, 0.44, z + 0.32), 0.05, MATERIALS.frame)
    post(CL, -0.9, 0)
    post(left + 0.18, -0.82, -0.05)
    post(right - 0.18, -0.82, 0.05)
    post(left + 0.02, -0.4, 0)
    post(right - 0.02, -0.4, 0)
    for (const x of [0, 2 * CL]) {
      d.box([0.5, 0.12, 0.5], [x, -0.82, 0.2], MATERIALS.seat)
      d.box([0.5, 0.7, 0.1], [x, -0.42, 0.48], MATERIALS.seat, [-0.12, 0, 0])
    }
    // Side consoles under the sidesticks, with the first officer's stick as a fixed model
    d.box([0.3, 0.45, 0.6], [left + 0.2, -0.72, -0.35], MATERIALS.airbus)
    d.box([0.3, 0.45, 0.6], [right - 0.2, -0.72, -0.35], MATERIALS.airbus)
    d.box([0.035, 0.11, 0.035], [right - 0.25, -0.44, -0.33], MATERIALS.black)

    // The footwell wall under the main panel, down to the floor
    d.box([width - 0.3, 0.5, 0.04], [CL, -0.81, -0.82], MATERIALS.airbus)
    // Main panel: displays each side, the two crew alerting screens in the middle
    const main = d.panel([CL, -0.33, -0.8], width - 0.3, 0.46, [0, 0, 0], MATERIALS.airbus, 0.3)
    const v = (y: number) => y + 0.33
    d.screen(main, -CL - 0.1, v(-0.3), screen, screen, primaryFlight, 15)
    d.screen(main, -CL + 0.11, v(-0.3), screen, screen, navigationDisplay, 6)
    d.screen(main, 0, v(-0.24), screen, screen, engineDisplay(spec), 8)
    d.screen(main, 0, v(-0.44), screen * 0.95, screen * 0.7, systemsPage(spec), 4)
    d.screen(main, CL - 0.11, v(-0.3), screen, screen, navigationDisplay, 3)
    d.screen(main, CL + 0.1, v(-0.3), screen, screen, primaryFlight, 6)
    // Standby instrument beside the upper screen
    d.screen(main, -0.19, v(-0.22), 0.075, 0.075, primaryFlight, 4)
    main.label('ISIS', -0.19, v(-0.17))
    this.gearLever(main, 0.2, v(-0.33))

    // Glareshield: the flight control unit, and the master warning and caution lights
    const shield = d.panel(
      [CL, -0.105, -0.83],
      width - 0.4,
      0.07,
      [-0.45, 0, 0],
      MATERIALS.airbus,
      0.06
    )
    this.flightControlUnit(shield)
    const lamps = LAMPS.filter(lamp => lamp.kind === 'warning')
    this.master = {
      warning: () =>
        sim.powered &&
        (lamps.some(lamp => lamp.on(sim, c)) ||
          (game.gpws.alert !== null && WARNINGS.has(game.gpws.alert))),
      caution: () => sim.powered && game.gpws.alert !== null && !WARNINGS.has(game.gpws.alert)
    }
    const flashing = () => Math.floor(performance.now() / 400) % 2 === 0
    d.button(shield, 'MASTER WARN', -CL - 0.22, 0, {
      lit: () => (this.master.warning() && flashing() ? 'alert' : 'off'),
      color: 0x5a1010,
      size: { w: 0.035, h: 0.022 }
    })
    d.button(shield, 'MASTER CAUT', -CL - 0.16, 0, {
      lit: () => (this.master.caution() ? 'alert' : 'off'),
      color: 0x5a3a10,
      size: { w: 0.035, h: 0.022 }
    })

    this.overhead(d.panel([CL, 0.33, -0.36], 0.78, 0.62, [1.22, 0, 0], MATERIALS.airbus, 0.08))
    this.pedestal(
      d.panel([CL, -0.6, -0.42], 0.38, 0.64, [-1.45, 0, 0], MATERIALS.airbus, 0.32),
      big
    )

    // Captain's sidestick on the left console
    this.flight = d.add(
      new Stick(
        d.group,
        d.buzz,
        new Vector3(left + 0.29, -0.53, -0.33),
        new Vector3(left + 0.29, -0.43, -0.33),
        0.06
      )
    )
    this.checklists = [
      {
        title: 'Before Start',
        items: [
          { text: 'Batteries: ON', done: () => c.battery },
          { text: 'Fuel pumps: ON', done: () => c.fuelPumps },
          { text: 'Parking brake: SET', done: () => c.parkingBrake },
          { text: 'Thrust levers: IDLE', done: () => c.throttle < 0.05 && !c.reverse }
        ]
      },
      {
        title: 'Engine Start',
        items: [
          { text: 'ENG MASTER 1: ON', done: () => c.engineSwitches[0] },
          { text: 'ENG MASTER 2: ON', done: () => c.engineSwitches[1] },
          {
            text: 'Engines: stabilised at idle',
            done: () => sim.enginesRunning === sim.engines.length
          }
        ]
      },
      {
        title: 'Before Takeoff',
        items: [
          { text: 'Flaps: CONF 1 to 3', done: () => c.flapNotch >= 1 && c.flapNotch <= 3 },
          { text: 'Landing lights: ON', done: () => pilot.landingLights },
          { text: 'Parking brake: OFF', done: () => !c.parkingBrake },
          { text: 'Thrust levers: FLX/MCT or TOGA', done: () => c.throttle > 0.85 },
          { text: 'Rotate at VR', done: () => !sim.onGround },
          { text: 'Gear: UP', done: () => !c.gearDown }
        ]
      },
      {
        title: 'Approach and Landing',
        items: [
          { text: 'APPR: pressed, approach armed', done: () => pilot.flyingApproach },
          { text: 'Gear: DOWN', done: () => c.gearDown },
          { text: 'Flaps: FULL', done: () => c.flapNotch === spec.flapLabels.length - 1 },
          { text: 'Touchdown, reverse thrust', done: () => sim.onGround && c.reverse },
          { text: 'Flaps: UP after landing', done: () => sim.onGround && c.flapNotch === 0 }
        ]
      }
    ]
    this.finish()
  }

  /** The landing gear lever with its wheel-shaped knob, on the centre panel. */
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
    panel.label('L/G', u, v + 0.09)
    panel.label('UP', u + 0.03, v + 0.06)
    panel.label('DN', u + 0.03, v - 0.06)
  }

  /** The flight control unit: speed, heading, altitude, and climb rate knobs and the AP buttons. */
  private flightControlUnit(shield: Panel) {
    const d = this.deck
    const { pilot, sim, nav } = game
    const flying = () => game.getState().status === 'flying'
    d.screen(shield, 0, 0.018, 0.5, 0.022, fcuDisplay, 6, 3000)
    const knob = (
      label: string,
      u: number,
      turn: (clicks: number) => void,
      press: () => void,
      state: () => string
    ) => d.knob(shield, label, u, -0.012, { step: 12 * DEG, radius: 0.012, turn, press, state })
    knob(
      'SPD',
      -0.19,
      clicks => pilot.adjust('speed', clicks),
      () => key('KeyX'),
      () => 'turn to set, push for autothrust'
    )
    knob(
      'HDG',
      -0.08,
      clicks => pilot.adjust('heading', clicks),
      () => {
        if (flying()) pilot.setLateral(pilot.autopilot.lateral === 'HDG' ? 'NAV' : 'HDG', sim, nav)
      },
      () => 'turn to set, push for heading or managed'
    )
    knob(
      'ALT',
      0.1,
      clicks => pilot.adjust('altitude', clicks),
      () => {
        if (flying()) pilot.setVertical('FLCH', sim, nav)
      },
      () => 'turn to set, push to climb or descend'
    )
    knob(
      'V/S',
      0.21,
      clicks => pilot.adjust('verticalSpeed', clicks),
      () => {
        if (flying()) pilot.setVertical('VS', sim, nav)
      },
      () => 'turn to set, push for vertical speed'
    )
    const small = { w: 0.026, h: 0.014 }
    const { autopilot } = pilot
    d.button(shield, 'LOC', -0.03, -0.012, {
      press: () => flying() && pilot.setLateral('APP', sim, nav),
      lit: () => (autopilot.on && autopilot.lateral === 'APP' ? 'on' : 'off'),
      size: small
    })
    d.button(shield, 'AP1', 0.015, 0.0, {
      press: () => key('KeyZ'),
      lit: () => (autopilot.on ? 'on' : 'off'),
      size: small
    })
    d.button(shield, 'A/THR', 0.015, -0.022, {
      press: () => key('KeyX'),
      lit: () => (pilot.autothrottle.on ? 'on' : 'off'),
      size: small
    })
    d.button(shield, 'APPR', 0.155, -0.012, {
      press: () => flying() && game.toggleApproachAutopilot(),
      lit: () => (pilot.flyingApproach ? 'on' : 'off'),
      size: small
    })
  }

  /** The overhead panel: electrics, fuel pumps, lights, engine fire, and the APU. */
  private overhead(panel: Panel) {
    const d = this.deck
    const { pilot, sim } = game
    const c = pilot.controls
    const local = {
      apu: false,
      beacon: false,
      strobe: false,
      nav: false,
      belts: false,
      antiIce: false
    }
    const toggle = (name: keyof typeof local) => () => {
      local[name] = !local[name]
    }
    const lit = (on: () => boolean) => () => (on() ? ('on' as const) : ('off' as const))
    const size = { w: 0.03, h: 0.022 }
    panel.label('ELEC', -0.25, 0.27, 0.011)
    d.button(panel, 'BAT 1', -0.3, 0.2, {
      press: () => key('KeyO'),
      lit: lit(() => c.battery),
      size
    })
    d.button(panel, 'BAT 2', -0.2, 0.2, {
      press: () => key('KeyO'),
      lit: lit(() => c.battery),
      size
    })
    d.button(panel, 'APU MASTER', -0.3, 0.1, {
      press: toggle('apu'),
      lit: lit(() => local.apu),
      size
    })
    panel.label('FUEL', 0.18, 0.27, 0.011)
    for (const [i, label] of ['L1', 'L2', 'CTR', 'R1', 'R2'].entries()) {
      d.button(panel, label, 0.06 + i * 0.055, 0.2, {
        press: () => key('KeyU'),
        lit: lit(() => c.fuelPumps),
        size
      })
    }
    panel.label('ENG FIRE', 0, 0.06, 0.011)
    sim.engines.forEach((_, i) => {
      const u = (i - (sim.engines.length - 1) / 2) * 0.09
      d.button(panel, `ENG ${i + 1}`, u, 0.0, {
        press: () => {
          if (sim.engines[i]?.fire) sim.extinguish(i, c.engineSwitches[i])
        },
        lit: () => (sim.engines[i]?.fire ? 'alert' : 'off'),
        color: 0x6a1010,
        size: { w: 0.04, h: 0.026 }
      })
    })
    panel.label('EXT LT', 0, -0.1, 0.011)
    const lights: [string, () => boolean, () => void][] = [
      ['STROBE', () => local.strobe, toggle('strobe')],
      ['BEACON', () => local.beacon, toggle('beacon')],
      ['NAV', () => local.nav, toggle('nav')],
      ['LAND', () => pilot.landingLights, () => key('KeyL')]
    ]
    lights.forEach(([label, get, set], i) => {
      d.rocker(panel, label, -0.15 + i * 0.1, -0.17, { get, set: () => set() })
    })
    d.rocker(panel, 'SEAT BELTS', -0.1, -0.26, {
      get: () => local.belts,
      set: () => toggle('belts')()
    })
    d.rocker(panel, 'ANTI ICE', 0.1, -0.26, {
      get: () => local.antiIce,
      set: () => toggle('antiIce')()
    })
  }

  /** The pedestal: keypads, thrust levers, speedbrake, flaps, engine masters, parking brake. */
  private pedestal(panel: Panel, big: boolean) {
    const d = this.deck
    const { pilot, sim } = game
    const c = pilot.controls
    // Keypad screens for the flight computer, at the front
    d.screen(panel, -0.09, 0.22, 0.09, 0.075, mcduDisplay, 2)
    d.screen(panel, 0.09, 0.22, 0.09, 0.075, mcduDisplay, 1)
    panel.label('MCDU 1', -0.09, 0.27)
    panel.label('MCDU 2', 0.09, 0.27)

    // Thrust levers: TOGA forward, FLX/MCT, CL, IDLE, then reverse at the back
    const count = sim.engines.length
    const spacing = big ? 0.045 : 0.065
    for (let i = 0; i < count; i++) {
      const u = (i - (count - 1) / 2) * spacing
      const lever = new Lever(
        d.group,
        d.buzz,
        `THRUST ${i + 1}`,
        panel.at(u, -0.08, 0.06),
        panel.at(u, 0.11, 0.08),
        panel.at(u, 0.02, -0.06),
        {
          get: () => this.leverPosition(),
          set: () => {},
          notches: [this.reverseRegion, 0.75, 0.88, 1],
          knob: { color: 0x2a2c2e, shape: 'box' },
          state: () => (c.reverse ? 'REVERSE' : `${Math.round(c.throttle * 100)}%`)
        }
      )
      this.throttles.push(d.add(lever))
    }
    for (const [label, v] of [
      ['TOGA', 0.11],
      ['FLX MCT', 0.087],
      ['CL', 0.062],
      ['IDLE', -0.054],
      ['REV', -0.08]
    ] as const) {
      panel.label(label, spacing * (count / 2) + 0.03, v, 0.007)
    }

    // Speedbrake on the left: forward is retracted. Flaps on the right: forward is up.
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'SPEED BRAKE',
        panel.at(-0.15, 0.08, 0.05),
        panel.at(-0.15, -0.04, 0.05),
        panel.at(-0.15, 0.02, -0.05),
        {
          get: () => (c.speedBrake ? 1 : 0),
          set: (value, released) => {
            if (released && value > 0.5 !== c.speedBrake) key('KeyB')
          },
          detents: [0, 1],
          knob: { color: 0x9a9fa4, shape: 'box' },
          state: () => (c.speedBrake ? 'EXTENDED' : 'RETRACTED')
        }
      )
    )
    panel.label('SPEED BRAKE', -0.15, 0.11)
    const notches = this.spec.flapLabels.length - 1
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'FLAPS',
        panel.at(0.15, 0.08, 0.05),
        panel.at(0.15, -0.06, 0.05),
        panel.at(0.15, 0.01, -0.05),
        {
          get: () => c.flapNotch / notches,
          set: value => {
            if (game.getState().status === 'flying') c.flapNotch = Math.round(value * notches)
          },
          detents: this.spec.flapLabels.map((_, i) => i / notches),
          knob: { color: 0xe8e8e8, shape: 'box' },
          state: () => this.spec.flapLabels[c.flapNotch]
        }
      )
    )
    this.spec.flapLabels.forEach((label, i) => {
      panel.label(label, 0.19, 0.08 - (0.14 * i) / notches, 0.007)
    })

    // Engine master switches and the start mode selector, behind the thrust levers
    sim.engines.forEach((_, i) => {
      const u = (i - (count - 1) / 2) * 0.05
      d.rocker(panel, `ENG ${i + 1}`, u, -0.16, {
        get: () => c.engineSwitches[i],
        set: () => key(`Digit${i + 1}`),
        state: () => (c.engineSwitches[i] ? 'ON' : 'OFF')
      })
    })
    panel.label('ENG MASTER', 0, -0.13 + 0.03)

    // Parking brake handle: pull up to set
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'PARK BRK',
        panel.at(0, -0.26, 0.02),
        panel.at(0, -0.26, 0.07),
        panel.at(0, -0.26, -0.04),
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
    panel.label('PARK BRK', 0, -0.23)
  }
}

/** The lower crew alerting screen: the system page, here wheels, brakes, and doors. */
function systemsPage(spec: AircraftSpec) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.fillStyle = '#05070a'
    ctx.fillRect(0, 0, w, h)
    const { sim, pilot } = game
    if (!sim.powered) return
    const c = pilot.controls
    ctx.font = `700 ${h * 0.09}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#ffffff'
    ctx.fillText('WHEEL', w / 2, h * 0.08)
    const gear = sim.gearPosition
    const color = gear >= 0.99 ? '#4be36f' : gear <= 0.01 ? '#56606a' : '#f2a93b'
    for (const x of [0.25, 0.5, 0.75]) {
      ctx.fillStyle = color
      ctx.fillText(gear >= 0.99 ? '▼▼' : gear <= 0.01 ? 'UP' : 'TRAN', w * x, h * 0.3)
    }
    ctx.fillStyle = c.parkingBrake ? '#f2a93b' : '#4be36f'
    ctx.fillText(
      c.parkingBrake ? 'PARK BRK ON' : `BRAKES ${Math.round(Math.max(c.brake, 0) * 100)}%`,
      w / 2,
      h * 0.55
    )
    ctx.fillStyle = '#4be36f'
    ctx.fillText(`FOB ${Math.round(sim.fuel)} KG`, w / 2, h * 0.75)
    ctx.fillStyle = '#56606a'
    ctx.fillText(spec.label, w / 2, h * 0.92)
  }
}

/** The cockpits this file builds, by aircraft id. */
export const COCKPITS = { a320: AirbusCockpit, a380: AirbusCockpit }
