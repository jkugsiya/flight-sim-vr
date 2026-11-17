import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3
} from 'three'
import { game } from '../../game/game'
import type { AircraftSpec } from '../../sim/aircraft'
import { FEET_PER_METRE, KNOTS_PER_MS } from '../../ui/telemetry'
import { flying, key } from '../cockpit'
import { type Buzz, Lever, Stick } from '../controls'
import { DeckCockpit, MATERIALS, type Panel } from '../deck'
import { AirspeedIndicator, Altimeter, AttitudeIndicator } from '../gauges'
import { engineDisplay, navigationDisplay, primaryFlight, radarDisplay } from '../glass'

/*
 * The B-2 Spirit's two-seat flight deck: the pilot on the left, the mission commander on
 * the right, each with a centre stick and four colour displays, a ninth display between
 * them, the four throttles and the weapons panel on the centre console, the overhead, and
 * the four-pane windscreen in its heavy frame. Metres from the pilot's eye; the aircraft's
 * centreline is 0.6 m to the right.
 */

const DEG = Math.PI / 180
const CL = 0.6
const FLOOR = -1.05
// Window line: the windscreen's foot and head, and the side windows' sill
const BASE_Y = -0.13
const BASE_Z = -0.95
const HEAD_Y = 0.28
const HEAD_Z = -0.62
const SILL_Y = 0.02
const ROOF_Y = 0.33
// Multifunction displays: 6.25 inch squares
const MFD = 0.155
const LBS_PER_KG = 2.2046

/** A point mirrored across the centreline, for the commander's side. */
const mirror = (p: Vector3) => new Vector3(2 * CL - p.x, p.y, p.z)

/** One mesh from quads, each four corners in order round its edge. */
function skin(quads: Vector3[][], material: MeshStandardMaterial) {
  const positions: number[] = []
  for (const [a, b, c, d] of quads) {
    for (const p of [a, b, c, a, c, d]) positions.push(p.x, p.y, p.z)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  return new Mesh(geometry, material)
}

/** The stores page: bombs in the two bays, the release state, and the sight. */
function storesPage(armed: () => boolean) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.fillStyle = '#05070a'
    ctx.fillRect(0, 0, w, h)
    const { sim, bombs } = game
    if (!sim.powered) return
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `700 ${h * 0.07}px system-ui, sans-serif`
    ctx.fillStyle = '#ffffff'
    ctx.fillText('SMS', w / 2, h * 0.07)
    // Each bay holds half the load, drawn as rotary launcher stations
    const loaded = bombs.loaded
    for (const [bay, x] of [
      [0, 0.28],
      [1, 0.72]
    ] as const) {
      const count = Math.ceil(loaded / 2) - (bay === 1 && loaded % 2 === 1 ? 1 : 0)
      ctx.strokeStyle = '#56606a'
      ctx.lineWidth = h * 0.008
      ctx.beginPath()
      ctx.arc(w * x, h * 0.36, h * 0.16, 0, Math.PI * 2)
      ctx.stroke()
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        ctx.fillStyle = i < count ? '#4be36f' : '#1c2126'
        ctx.beginPath()
        ctx.arc(
          w * x + Math.sin(a) * h * 0.11,
          h * 0.36 - Math.cos(a) * h * 0.11,
          h * 0.025,
          0,
          Math.PI * 2
        )
        ctx.fill()
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillText(bay === 0 ? 'L BAY' : 'R BAY', w * x, h * 0.6)
    }
    ctx.fillStyle = armed() ? '#ffa21a' : '#4be36f'
    ctx.fillText(armed() ? 'MASTER ARM' : 'SAFE', w / 2, h * 0.72)
    ctx.fillStyle = game.getState().bombsight ? '#4fd3ff' : '#56606a'
    ctx.fillText(game.getState().bombsight ? 'SIGHT ON' : 'SIGHT OFF', w / 2, h * 0.82)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(`${loaded} WPN  ${bombs.falling.length} FALLING`, w / 2, h * 0.92)
  }
}

/** The systems page: fuel, gear, brakes, and the drag rudders. */
function systemsPage(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#05070a'
  ctx.fillRect(0, 0, w, h)
  const { sim, pilot } = game
  if (!sim.powered) return
  const c = pilot.controls
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${h * 0.07}px system-ui, sans-serif`
  ctx.fillStyle = '#ffffff'
  ctx.fillText('SYSTEMS', w / 2, h * 0.07)
  const line = (label: string, value: string, y: number, color = '#4be36f') => {
    ctx.textAlign = 'left'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, w * 0.08, h * y)
    ctx.textAlign = 'right'
    ctx.fillStyle = color
    ctx.fillText(value, w * 0.92, h * y)
  }
  line('FUEL LB', String(Math.round((sim.fuel * LBS_PER_KG) / 100) * 100), 0.22)
  const gear = sim.gearPosition
  line(
    'GEAR',
    gear >= 0.99 ? 'DN' : gear <= 0.01 ? 'UP' : 'TRANS',
    0.36,
    gear > 0.01 && gear < 0.99 ? '#f2a93b' : '#4be36f'
  )
  line('PARK BRK', c.parkingBrake ? 'SET' : 'OFF', 0.5, c.parkingBrake ? '#f2a93b' : '#4be36f')
  line('DRAG RUD', `${Math.round(sim.speedBrakePosition * 100)}%`, 0.64)
  line(
    'HYD',
    sim.hydraulicsFailed ? 'FAIL' : '4000',
    0.78,
    sim.hydraulicsFailed ? '#ff4b3a' : '#4be36f'
  )
  line('ENG RUN', `${sim.enginesRunning}/4`, 0.92)
}

/** The up-front display on the glareshield: autopilot modes and selected values. */
function upFront(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#060807'
  ctx.fillRect(0, 0, w, h)
  const { sim, pilot } = game
  if (!sim.powered) return
  const { autopilot, autothrottle } = pilot
  ctx.fillStyle = '#4be36f'
  ctx.font = `700 ${h * 0.5}px ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const heading = String(Math.round((((autopilot.heading / DEG) % 360) + 360) % 360)).padStart(
    3,
    '0'
  )
  const altitude = Math.round((autopilot.altitude * FEET_PER_METRE) / 100) * 100
  const speed = autothrottle.on ? String(Math.round(autothrottle.speed * KNOTS_PER_MS)) : '---'
  ctx.fillText(
    autopilot.on ? `AP ${autopilot.lateral}/${autopilot.vertical}` : 'AP OFF',
    w * 0.16,
    h / 2
  )
  ctx.fillText(`SPD ${speed}`, w * 0.42, h / 2)
  ctx.fillText(`HDG ${heading}`, w * 0.64, h / 2)
  ctx.fillText(`ALT ${altitude}`, w * 0.87, h / 2)
}

/** The B-2 Spirit's flight deck in VR. */
export class SpiritCockpit extends DeckCockpit {
  private readonly pedals: Group[] = []
  private armed = false
  private readonly local = { apu: false, nav: false, beacon: false, antiIce: false }

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const { sim } = game
    // The tablet rests on the left console, below the side window
    this.tablet = {
      position: new Vector3(-0.47, -0.36, -0.12),
      rotation: new Euler(-0.75, 1.05, 0, 'YXZ')
    }
    const paint = {
      // The deck is a dark blue-grey; the airframe outside is the B-2's darker grey
      deck: new MeshStandardMaterial({ color: 0x3c434b, roughness: 0.85, emissive: 0x111417 }),
      console: new MeshStandardMaterial({ color: 0x2a2f35, roughness: 0.85, emissive: 0x0b0d0f }),
      frame: new MeshStandardMaterial({ color: 0x24272b, roughness: 0.7, emissive: 0x08090a }),
      outside: new MeshStandardMaterial({
        color: 0x4a4f56,
        roughness: 0.75,
        metalness: 0.05,
        side: DoubleSide
      }),
      seat: new MeshStandardMaterial({ color: 0x2b3a2c, roughness: 0.95, emissive: 0x0b100b }),
      yellow: new MeshStandardMaterial({ color: 0xe0b81c, roughness: 0.6, emissive: 0x2a2205 })
    }
    this.buildShell(paint)
    this.buildWindscreen(paint.frame)
    this.buildOutside(paint.outside)

    // Main panel: four displays per crew station and one between them
    const main = d.panel([CL, -0.4, -0.8], 2.1, 0.4, [-0.15, 0, 0], paint.deck, 0.3)
    d.box([2.1, -0.6 - FLOOR, 0.04], [CL, (FLOOR - 0.6) / 2 + 0.02, -0.86], paint.deck)
    const top = 0.075
    const low = -0.105
    const station = (u: number, pilot: boolean) => {
      // The pilot's are the busy ones; nobody sits in the commander's seat, so its screens
      // redraw only about once a second
      d.screen(main, u - 0.19, top, MFD, MFD, navigationDisplay, pilot ? 6 : 1)
      d.screen(main, u, top, MFD, MFD, primaryFlight, pilot ? 15 : 1)
      d.screen(
        main,
        u + 0.19,
        top,
        MFD,
        MFD,
        pilot ? engineDisplay(spec) : systemsPage,
        pilot ? 4 : 1
      )
      d.screen(
        main,
        u,
        low,
        MFD,
        MFD,
        pilot ? storesPage(() => this.armed) : radarDisplay,
        pilot ? 2 : 1
      )
    }
    station(-CL, true)
    station(CL, false)
    // The ninth display shows the fuel and systems page, slowly
    d.screen(main, 0, top, MFD, MFD, systemsPage, 1)
    // Standby instruments under the middle display
    const standby = 0.068
    d.instrument(
      main,
      -0.1,
      low,
      new AirspeedIndicator(
        standby,
        spec.gauges.airspeed,
        () => sim.indicatedAirspeed * KNOTS_PER_MS
      )
    )
    d.instrument(
      main,
      0,
      low,
      new AttitudeIndicator(standby, () => ({ pitch: sim.pitch, bank: sim.bank }))
    )
    d.instrument(main, 0.1, low, new Altimeter(standby, () => sim.position.y * FEET_PER_METRE))
    main.label('STBY', 0, low + 0.045)
    this.gearAndBrake(main)

    this.glareshield(d.panel([CL, -0.175, -0.87], 2.0, 0.07, [-0.6, 0, 0], paint.deck, 0.08))
    this.overhead(d.panel([CL, 0.3, -0.05], 0.8, 0.44, [1.4, 0, 0], paint.deck, 0.03))
    this.console(
      d.panel([CL, -0.6, -0.3], 0.42, 0.82, [-Math.PI / 2 + 0.1, 0, 0], paint.console, 0.42)
    )

    // The pilot's centre stick; the commander's is the same model, fixed
    this.flight = d.add(
      new Stick(d.group, d.buzz, new Vector3(0, -0.98, -0.36), new Vector3(0, -0.48, -0.4), 0.07)
    )
    d.beam(
      new Vector3(2 * CL, -0.98, -0.36),
      new Vector3(2 * CL, -0.44, -0.4),
      0.025,
      MATERIALS.black
    )
    d.box([0.04, 0.11, 0.045], [2 * CL, -0.42, -0.4], MATERIALS.black)

    // Rudder pedals at both seats, moving with the rudder
    for (const x of [0, 2 * CL]) {
      for (const side of [-1, 1]) {
        const pedal = new Group()
        pedal.add(d.box([0.08, 0.16, 0.02], [0, 0, 0], MATERIALS.black, [-0.6, 0, 0]))
        pedal.position.set(x + side * 0.12, -0.92, -0.78)
        d.group.add(pedal)
        this.pedals.push(pedal)
      }
    }

    this.checklists = this.buildChecklists()
    this.finish()
  }

  /** Gear handle and parking brake, at the pilot's left on the main panel. */
  private gearAndBrake(main: Panel) {
    const d = this.deck
    const c = game.pilot.controls
    const u = -0.97
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'GEAR',
        main.at(u, 0.07, 0.07),
        main.at(u, -0.06, 0.07),
        main.at(u, 0, 0),
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
    main.label('GEAR', u, 0.12)
    main.label('UP', u + 0.035, 0.07, 0.007)
    main.label('DN', u + 0.035, -0.06, 0.007)
    // Pull the handle out to set the brakes; held partway, it works them while held
    const brake = new Lever(
      d.group,
      d.buzz,
      'PARK BRK',
      main.at(u, -0.15, 0.01),
      main.at(u, -0.15, 0.08),
      main.at(u, -0.15, -0.05),
      {
        get: () => (c.parkingBrake ? 1 : 0),
        set: (value, released) => {
          if (released) c.parkingBrake = value > 0.85
        },
        spring: () => !c.parkingBrake,
        knob: { color: 0xb01c1c, shape: 'tee' },
        state: () => (c.parkingBrake ? 'SET' : 'OFF')
      }
    )
    this.brakes = [d.add(brake)]
    main.label('PARK BRK', u, -0.115, 0.007)
  }

  /** The glareshield: the up-front display, autopilot keys, and the master lights. */
  private glareshield(shield: Panel) {
    const d = this.deck
    const { pilot, sim, nav } = game
    d.screen(shield, 0, 0.006, 0.42, 0.03, upFront, 2, 3000)
    const small = { w: 0.03, h: 0.016 }
    const keys: [string, number, () => void, () => boolean][] = [
      ['AP', -0.3, () => key('KeyZ'), () => pilot.autopilot.on],
      ['A/THR', -0.25, () => key('KeyX'), () => pilot.autothrottle.on],
      [
        'HDG',
        0.25,
        flying(() => pilot.setLateral('HDG', sim, nav)),
        () => pilot.autopilot.lateral === 'HDG'
      ],
      [
        'ALT',
        0.3,
        flying(() => pilot.setVertical('ALT', sim, nav)),
        () => pilot.autopilot.vertical === 'ALT'
      ],
      ['APPR', 0.35, flying(game.toggleApproachAutopilot), () => pilot.flyingApproach]
    ]
    for (const [label, u, press, on] of keys) {
      d.button(shield, label, u, -0.012, {
        press,
        lit: () => (pilot.autopilot.on || label === 'A/THR' ? (on() ? 'on' : 'off') : 'off'),
        size: small
      })
    }
    const flashing = () => Math.floor(performance.now() / 400) % 2 === 0
    const warning = () =>
      sim.powered &&
      (sim.engines.some(engine => engine.fire) || sim.stallWarning || game.gpws.alert !== null)
    d.button(shield, 'MASTER WARN', -CL - 0.24, 0, {
      lit: () => (warning() && flashing() ? 'alert' : 'off'),
      color: 0x5a1010,
      size: { w: 0.035, h: 0.022 }
    })
    d.button(shield, 'MASTER WARN', CL + 0.24, 0, {
      lit: () => (warning() && flashing() ? 'alert' : 'off'),
      color: 0x5a1010,
      size: { w: 0.035, h: 0.022 }
    })
  }

  /** The overhead: electrics, fuel, the four engine start switches, fire, and lights. */
  private overhead(panel: Panel) {
    const d = this.deck
    const { pilot, sim } = game
    const c = pilot.controls
    const lit = (on: () => boolean) => () => (on() ? ('on' as const) : ('off' as const))
    panel.label('ENGINE START', 0, 0.17, 0.011)
    sim.engines.forEach((_, i) => {
      d.rocker(panel, `ENG ${i + 1}`, -0.15 + i * 0.1, 0.1, {
        get: () => c.engineSwitches[i],
        set: () => key(`Digit${i + 1}`),
        state: () =>
          sim.engines[i]?.running
            ? 'RUNNING'
            : sim.engines[i]?.starting
              ? 'STARTING'
              : c.engineSwitches[i]
                ? 'ON'
                : 'OFF'
      })
      d.button(
        panel,
        `FIRE ${i + 1}`,
        -0.15 + i * 0.1,
        0.02,
        {
          press: () => {
            if (sim.engines[i]?.fire) sim.extinguish(i, c.engineSwitches[i])
          },
          lit: () => (sim.engines[i]?.fire ? 'alert' : 'off'),
          color: 0x6a1010,
          size: { w: 0.04, h: 0.02 }
        },
        false
      )
    })
    panel.label('FIRE', 0.21, 0.02, 0.008)
    panel.label('ELEC / FUEL', -0.25, -0.06, 0.011)
    d.button(panel, 'BATTERY', -0.3, -0.12, {
      press: () => key('KeyO'),
      lit: lit(() => c.battery),
      size: { w: 0.04, h: 0.024 }
    })
    d.button(panel, 'FUEL PUMPS', -0.2, -0.12, {
      press: () => key('KeyU'),
      lit: lit(() => c.fuelPumps),
      size: { w: 0.04, h: 0.024 }
    })
    d.button(
      panel,
      'APU',
      -0.3,
      -0.18,
      {
        press: () => {
          this.local.apu = !this.local.apu
        },
        lit: lit(() => this.local.apu),
        size: { w: 0.04, h: 0.024 }
      },
      false
    )
    panel.label('APU', -0.3, -0.155, 0.007)
    panel.label('LIGHTS', 0.2, -0.06, 0.011)
    const lights: [string, () => boolean, () => void][] = [
      ['LAND', () => pilot.landingLights, () => key('KeyL')],
      ['NAV', () => this.local.nav, () => (this.local.nav = !this.local.nav)],
      ['BEACON', () => this.local.beacon, () => (this.local.beacon = !this.local.beacon)],
      ['ANTI ICE', () => this.local.antiIce, () => (this.local.antiIce = !this.local.antiIce)]
    ]
    lights.forEach(([label, get, toggle], i) => {
      d.rocker(panel, label, 0.08 + i * 0.075, -0.15, { get, set: () => toggle() })
    })
  }

  /** The centre console: throttles, the drag rudder lever, and the weapons panel. */
  private console(panel: Panel) {
    const d = this.deck
    const { pilot, bombs } = game
    const c = pilot.controls
    // Four throttles: idle at the back, military power at the front
    for (let i = 0; i < 4; i++) {
      const u = (i - 1.5) * 0.056
      const lever = new Lever(
        d.group,
        d.buzz,
        `THROTTLE ${i + 1}`,
        panel.at(u, 0.06, 0.07),
        panel.at(u, 0.27, 0.08),
        panel.at(u, 0.16, -0.06),
        {
          get: () => c.throttle,
          set: (value, released) => {
            if (released) c.throttle = value
          },
          notches: [0.9],
          knob: { color: 0x2a2c2e, shape: 'box' },
          state: () => `${Math.round(c.throttle * 100)}%`
        }
      )
      this.throttles.push(d.add(lever))
    }
    panel.label('MIL', 0.145, 0.27, 0.007)
    panel.label('IDLE', 0.145, 0.06, 0.007)
    panel.label('THROTTLES', 0, 0.32, 0.009)
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'DRAG RUDDERS',
        panel.at(-0.165, 0.24, 0.05),
        panel.at(-0.165, 0.1, 0.05),
        panel.at(-0.165, 0.17, -0.05),
        {
          get: () => (c.speedBrake ? 1 : 0),
          set: (value, released) => {
            if (released && value > 0.5 !== c.speedBrake) key('KeyB')
          },
          detents: [0, 1],
          knob: { color: 0x9a9fa4, shape: 'box' },
          state: () => (c.speedBrake ? 'OPEN' : 'CLOSED')
        }
      )
    )
    panel.label('SPD BRK', -0.165, 0.28, 0.008)

    // Weapons: master arm, the bombsight, and the release, behind the throttles
    panel.label('WEAPONS', 0, -0.06, 0.011)
    d.rocker(panel, 'MASTER ARM', -0.12, -0.13, {
      get: () => this.armed,
      set: on => {
        this.armed = on
      },
      color: 0x8a1a14,
      state: () => (this.armed ? 'ARM' : 'SAFE')
    })
    d.button(panel, 'BOMB SIGHT', 0, -0.13, {
      press: flying(game.toggleBombsight),
      lit: () => (game.getState().bombsight ? 'on' : 'off'),
      size: { w: 0.05, h: 0.028 },
      state: () =>
        bombs.loaded === 0 && bombs.falling.length === 0
          ? 'no weapons aboard'
          : game.getState().bombsight
            ? 'ON'
            : 'OFF'
    })
    d.button(panel, 'RELEASE', 0.12, -0.13, {
      press: () => {
        if (!this.armed) return
        game.release()
        game.endRelease()
      },
      lit: () => (this.armed && bombs.loaded > 0 ? 'alert' : 'off'),
      color: 0x6a1010,
      size: { w: 0.05, h: 0.028 },
      state: () => (!this.armed ? 'MASTER ARM is SAFE' : `${bombs.loaded} aboard`)
    })
    panel.label(`${this.spec.label} SPIRIT`, 0, -0.38, 0.009, '#8a9096')
  }

  /** Floor, walls, roof, side consoles, and the two ejection seats. */
  private buildShell(paint: Record<string, MeshStandardMaterial>) {
    const d = this.deck
    const left = -0.66
    const right = 2 * CL + 0.66
    const width = right - left
    d.box([width, 0.04, 2.0], [CL, FLOOR, 0], MATERIALS.floor)
    for (const x of [left, right]) {
      d.box([0.04, SILL_Y - FLOOR, 1.9], [x, (SILL_Y + FLOOR) / 2, -0.05], paint.deck)
      // Above the sill, aft of the side window
      d.box([0.04, ROOF_Y - SILL_Y, 1.2], [x, (ROOF_Y + SILL_Y) / 2, 0.32], paint.deck)
    }
    d.box([width, 0.04, 1.6], [CL, ROOF_Y + 0.02, 0.18], paint.deck)
    d.box([width, ROOF_Y - FLOOR, 0.04], [CL, (ROOF_Y + FLOOR) / 2, 0.92], paint.deck)
    // Side consoles outboard of each seat
    d.box([0.26, 0.52, 0.9], [left + 0.15, FLOOR + 0.26, -0.2], paint.console)
    d.box([0.26, 0.52, 0.9], [right - 0.15, FLOOR + 0.26, -0.2], paint.console)
    // Ejection seats, with their yellow and black firing handles
    for (const x of [0, 2 * CL]) {
      d.box([0.5, 0.12, 0.5], [x, -0.82, 0.22], paint.seat)
      d.box([0.5, 0.82, 0.12], [x, -0.36, 0.52], paint.seat, [-0.1, 0, 0])
      d.box([0.38, 0.22, 0.16], [x, 0.14, 0.56], MATERIALS.black, [-0.1, 0, 0])
      for (const side of [-1, 1]) {
        d.box([0.03, 0.14, 0.04], [x + side * 0.27, -0.7, 0.05], paint.yellow)
      }
    }
  }

  /**
   * The windscreen: two big front panes either side of a centre post, and a side window
   * each side whose lower edge steps up aft, all in a heavy frame.
   */
  private buildWindscreen(frame: MeshStandardMaterial) {
    const d = this.deck
    const t = 0.055
    const foot = (x: number, z = BASE_Z) => new Vector3(x, BASE_Y, z)
    const head = (x: number, z = HEAD_Z) => new Vector3(x, HEAD_Y, z)
    // Left half; the right is its mirror image
    const post = [foot(-0.4, BASE_Z + 0.08), head(-0.3, HEAD_Z + 0.07)]
    const centre = [foot(CL), head(CL)]
    // The side window's foot, stepping up twice toward the back, and its aft post
    const sill = [
      post[0],
      new Vector3(-0.5, -0.08, -0.7),
      new Vector3(-0.56, -0.08, -0.56),
      new Vector3(-0.62, SILL_Y, -0.32)
    ]
    const aft = [sill[3], new Vector3(-0.56, 0.25, -0.3)]
    for (const side of [false, true]) {
      const m = (p: Vector3) => (side ? mirror(p) : p)
      d.beam(m(post[0]), m(post[1]), t, frame)
      d.beam(m(post[0]), m(centre[0]), t, frame)
      d.beam(m(post[1]), m(centre[1]), t, frame)
      for (let i = 0; i < sill.length - 1; i++) d.beam(m(sill[i]), m(sill[i + 1]), t, frame)
      d.beam(m(aft[0]), m(aft[1]), t, frame)
      d.beam(m(post[1]), m(aft[1]), t, frame)
    }
    d.beam(centre[0], centre[1], t * 1.3, frame)
    // A lip over the windscreen head, and the eyebrow panel back to the roof
    d.box([2 * CL + 1.2, 0.03, 0.4], [CL, HEAD_Y + 0.03, HEAD_Z + 0.2], frame)
  }

  /** The upper body outside: the cockpit hump and the wing's centre section around it. */
  private buildOutside(material: MeshStandardMaterial) {
    const d = this.deck
    const v = (x: number, y: number, z: number) => new Vector3(x, y, z)
    // The hump: its front slopes down from the windscreen, its sides down to the wing
    const windscreen = [
      v(-0.4, BASE_Y, -0.87),
      v(CL, BASE_Y, BASE_Z),
      v(2 * CL + 0.4, BASE_Y, -0.87)
    ]
    const foot = [v(-0.9, -1.2, -1.9), v(CL, -1.17, -2.2), v(2 * CL + 0.9, -1.2, -1.9)]
    const quads: Vector3[][] = [
      [windscreen[0], windscreen[1], foot[1], foot[0]],
      [windscreen[1], windscreen[2], foot[2], foot[1]]
    ]
    const side = [
      v(-0.4, BASE_Y, -0.87),
      v(-0.62, SILL_Y, -0.32),
      v(-0.66, 0.06, 0.9),
      v(-0.5, -0.1, 2.6)
    ]
    const base = [v(-0.9, -1.2, -1.9), v(-1.4, -1.1, -0.6), v(-1.6, -0.8, 0.9), v(-1.3, -0.5, 2.8)]
    for (let i = 0; i < side.length - 1; i++) {
      quads.push([side[i], side[i + 1], base[i + 1], base[i]])
      quads.push([mirror(side[i + 1]), mirror(side[i]), mirror(base[i]), mirror(base[i + 1])])
    }
    // The roof of the hump, aft of the cockpit
    quads.push([side[2], mirror(side[2]), mirror(side[3]), side[3]])
    // The centre wing's upper surface, from its leading edge to the crest a third of the
    // way back, out to where the outer wing takes over. Aircraft axes, less the eye point.
    const eye = this.spec.camera.eye
    const point = (x: number, y: number, z: number) => v(x - eye.x, y - eye.y, z - eye.z)
    const stations: [x: number, top: number][] = [
      [0, 1.5],
      [2.5, 1.4],
      [4.25, 1.1],
      [8.5, 0.55]
    ]
    const edges = (x: number) => {
      const lead = -10.5 + x * (17 / 26.2)
      const trail = 10.5 - x * (5.5 / 8.5)
      return { lead, crest: lead + (trail - lead) * 0.33, trail }
    }
    for (const sign of [-1, 1]) {
      for (let i = 0; i < stations.length - 1; i++) {
        const [x1, top1] = stations[i]
        const [x2, top2] = stations[i + 1]
        const a = edges(x1)
        const b = edges(x2)
        const front = [
          point(sign * x1, 0, a.lead),
          point(sign * x2, 0, b.lead),
          point(sign * x2, top2, b.crest),
          point(sign * x1, top1, a.crest)
        ]
        const back = [
          point(sign * x1, top1, a.crest),
          point(sign * x2, top2, b.crest),
          point(sign * x2, 0, b.trail),
          point(sign * x1, 0, a.trail)
        ]
        quads.push(front, back)
      }
    }
    d.group.add(skin(quads, material))
  }

  protected tick() {
    const c = game.pilot.controls
    for (const [i, pedal] of this.pedals.entries()) {
      pedal.position.z = -0.78 + (i % 2 === 0 ? 1 : -1) * c.yaw * 0.04
    }
  }

  /** Short checklists, ticking as each step is done. */
  private buildChecklists() {
    const { pilot, sim, bombs } = game
    const c = pilot.controls
    const step = (text: string, done: () => boolean) => ({ text, done })
    return [
      {
        title: 'Before Start',
        items: [
          step('Battery: ON', () => c.battery),
          step('Fuel pumps: ON', () => c.fuelPumps),
          step('Parking brake: SET', () => c.parkingBrake),
          step('Throttles: IDLE', () => c.throttle < 0.05)
        ]
      },
      {
        title: 'Engine Start',
        items: [
          ...[0, 1, 2, 3].map(i => step(`ENG ${i + 1}: START`, () => c.engineSwitches[i])),
          step('Four engines: running', () => sim.enginesRunning === 4)
        ]
      },
      {
        title: 'Takeoff',
        items: [
          step('Parking brake: OFF', () => !c.parkingBrake),
          step('Throttles: MIL', () => c.throttle > 0.9),
          step('Rotate at 150 kt', () => !sim.onGround),
          step('Gear: UP', () => !c.gearDown)
        ]
      },
      {
        title: 'Weapons',
        items: [
          step('MASTER ARM: ARM', () => this.armed),
          step('BOMB SIGHT: ON', () => game.getState().bombsight),
          step('RELEASE over the target', () => bombs.falling.length > 0 || bombs.sinceImpact < 60),
          step('MASTER ARM: SAFE', () => !this.armed)
        ]
      },
      {
        title: 'Landing',
        items: [
          step('Gear: DOWN', () => c.gearDown),
          step('Approach: 140 kt', () => Math.abs(sim.indicatedAirspeed * KNOTS_PER_MS - 140) < 10),
          step('Touchdown', () => sim.onGround),
          step('Drag rudders: OPEN', () => c.speedBrake)
        ]
      }
    ]
  }
}

/** The cockpits this file builds, by aircraft id. */
export const COCKPITS = { b2: SpiritCockpit }
