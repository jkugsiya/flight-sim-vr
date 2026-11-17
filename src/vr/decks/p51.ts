import {
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  TorusGeometry,
  Vector3
} from 'three'
import { game } from '../../game/game'
import type { AircraftSpec } from '../../sim/aircraft'
import { FEET_PER_METRE, FPM_PER_MS, KNOTS_PER_MS } from '../../ui/telemetry'
import { key } from '../cockpit'
import { type Buzz, Knob, Lever, Stick, TrimWheel } from '../controls'
import { type Deck, DeckCockpit, Display, MATERIALS, type Panel } from '../deck'
import {
  AirspeedIndicator,
  Altimeter,
  AttitudeIndicator,
  Compass,
  HeadingIndicator,
  Tachometer,
  TurnCoordinator,
  VerticalSpeedIndicator
} from '../gauges'
import { Dial, type Scale } from './p51-dials'

/*
 * The P-51D Mustang's cockpit: the black instrument panel in the P-51D arrangement, the
 * K-14 gyro gunsight on the coaming, the stick between the knees, the throttle quadrant and
 * trim wheels on the left console, the electrical box on the right, the armour plate behind
 * the head, and the long Merlin nose ahead. Metres from the pilot's eye, on the centreline.
 */

const DEG = Math.PI / 180
const UP = new Vector3(0, 1, 0)
const FLOOR = -0.97
const SILL = -0.36
const WALL = 0.42
const PANEL_Z = -0.76
// The K-14's reflector, where the reticle is seen at infinity
const SIGHT_Z = -0.55
const SIGHT_W = 0.09
const SIGHT_H = 0.075
// The propeller hub, ahead and below
const HUB = new Vector3(0, -0.77, -4.2)

const MAGNETOS = ['off', 'right', 'left', 'both'] as const
const MAGNETO_NAMES = { off: 'OFF', right: 'R', left: 'L', both: 'BOTH' }
const TANKS = ['OFF', 'L MAIN', 'FUSELAGE', 'R MAIN'] as const

/** Air pressure in inches of mercury at a height in metres, for the manifold gauge. */
const ambientInHg = (metres: number) =>
  29.92 * Math.max(0.05, 1 - 2.2558e-5 * Math.max(0, metres)) ** 5.2559

/** A tapered tube from one point to another, as for the cowling or the rear fuselage. */
function tube(
  d: Deck,
  from: Vector3,
  to: Vector3,
  radiusFrom: number,
  radiusTo: number,
  material: Material,
  arc = Math.PI * 2
) {
  const span = to.clone().sub(from)
  const mesh = new Mesh(
    new CylinderGeometry(radiusTo, radiusFrom, span.length(), 24, 1, true, -arc / 2, arc),
    material
  )
  mesh.position.copy(from).addScaledVector(span, 0.5)
  mesh.quaternion.setFromUnitVectors(UP, span.normalize())
  d.group.add(mesh)
  return mesh
}

/** The engine's warmth, pressures, and the vacuum the gyros run on. Reset at each flight. */
class Engine {
  coolant = 15
  oilTemp = 15
  private flight = -1

  update(dt: number) {
    const { sim } = game
    const running = sim.enginesRunning > 0
    if (game.flight !== this.flight) {
      this.flight = game.flight
      this.coolant = running ? 100 : 15
      this.oilTemp = running ? 70 : 15
    }
    const p = sim.enginePower
    // The glycol warms in a few minutes of running and cools slowly when stopped
    this.coolant += ((running ? 85 + 30 * p : 15) - this.coolant) * Math.min(1, dt / 90)
    this.oilTemp += ((running ? 60 + 25 * p : 15) - this.oilTemp) * Math.min(1, dt / 150)
  }

  get oilPressure() {
    const { sim } = game
    return sim.enginesRunning > 0 ? 50 + 30 * Math.min(1, sim.rpm / 2400) : 0
  }

  /** Inches of mercury: the supercharger holds the boost up to its critical height. */
  get manifold() {
    const { sim } = game
    const ambient = ambientInHg(sim.position.y)
    if (sim.enginesRunning === 0) return ambient
    const boost = Math.min(1, ambient / ambientInHg(6300))
    return Math.max(10, (12 + 49 * sim.enginePower) * boost)
  }
}

/** The P-51D Mustang's cockpit in VR. */
export class MustangCockpit extends DeckCockpit {
  private readonly stick: Stick
  private readonly engine = new Engine()
  private readonly blades = new Group()
  private readonly disc: Mesh
  private readonly grip = new Group()
  private readonly pedals: Group[] = []
  private readonly reach = new Vector3()
  private readonly stickPivot = new Vector3(0, -0.93, -0.3)
  private magnetos: (typeof MAGNETOS)[number] = 'off'
  private tank: (typeof TANKS)[number] = 'L MAIN'
  private mixture = 0
  private prop = 1
  private boost = false
  private starter = false
  private priming = false
  private primed = 0
  private rudderTrim = 0
  private aileronTrim = 0
  private sight = true
  private guns = false
  private generator = true
  private navLights = false
  /** Hand position the engine switch was last set to, to notice the keyboard changing it. */
  private wrote = false
  private latched = false
  private fed = true
  private flightSeen = -1

  constructor(spec: AircraftSpec, buzz: Buzz) {
    super(spec, buzz)
    const d = this.deck
    const { sim } = game
    // A kneeboard on the left thigh, clear of the stick and the throttle hand
    this.tablet = {
      position: new Vector3(-0.18, -0.55, -0.27),
      rotation: new Euler(-1.0, 0.35, 0, 'YXZ')
    }
    const paint = {
      // Dull dark green, the factory's cockpit finish
      interior: new MeshStandardMaterial({ color: 0x4a5236, roughness: 0.9, emissive: 0x15180f }),
      panel: new MeshStandardMaterial({ color: 0x18191a, roughness: 0.85, emissive: 0x060606 }),
      metal: new MeshStandardMaterial({ color: 0xc4c9ce, roughness: 0.45, metalness: 0.25 }),
      olive: new MeshStandardMaterial({ color: 0x3b4029, roughness: 0.95, emissive: 0x0a0b06 }),
      red: new MeshStandardMaterial({ color: 0xb5262b, roughness: 0.5 }),
      yellow: new MeshStandardMaterial({ color: 0xe0b81c, roughness: 0.6 }),
      leather: new MeshStandardMaterial({ color: 0x3b2a1e, roughness: 0.9, emissive: 0x0e0a07 }),
      armour: new MeshStandardMaterial({ color: 0x3c4232, roughness: 0.8, emissive: 0x0f110c }),
      exhaust: new MeshStandardMaterial({ color: 0x4a3a30, roughness: 0.9 }),
      // Clear glass, faintly tinted so the windscreen and reflector read as glass
      glass: new MeshBasicMaterial({
        color: 0xcfe3e0,
        transparent: true,
        opacity: 0.06,
        depthWrite: false
      })
    }
    this.buildShell(paint)
    this.buildNose(paint)
    this.disc = new Mesh(
      new CircleGeometry(1.7, 40),
      new MeshBasicMaterial({
        color: 0x9a9a9a,
        transparent: true,
        opacity: 0.1,
        side: DoubleSide,
        depthWrite: false
      })
    )
    this.disc.position.copy(HUB).setZ(HUB.z + 0.05)
    d.group.add(this.disc)

    // Main panel, tilted back a little, with its flight and engine instruments
    const main = d.panel([0, -0.36, PANEL_Z], 0.64, 0.32, [-0.08, 0, 0], paint.panel, 0.12)
    this.instruments(main)
    // Coaming over the panel, and the K-14 sight on top of it
    d.box([0.66, 0.03, 0.15], [0, -0.19, -0.77], paint.panel)
    d.box([0.6, 0.02, 0.03], [0, -0.2, -0.695], paint.leather)
    this.gunsight(paint)

    // Lower switch panels under the main panel, either side of the stick
    const lowerLeft = d.panel([-0.16, -0.575, -0.71], 0.22, 0.09, [-0.6, 0, 0], paint.panel, 0.05)
    const lowerRight = d.panel([0.16, -0.575, -0.71], 0.22, 0.09, [-0.6, 0, 0], paint.panel, 0.05)
    this.startPanel(lowerLeft)
    this.sightPanel(lowerRight)

    // Side consoles, flat on top, with the levers and wheels on the left
    const left = d.panel([-0.36, -0.47, -0.14], 0.11, 0.68, [-Math.PI / 2, 0, 0], paint.interior)
    const right = d.panel([0.36, -0.47, -0.14], 0.11, 0.68, [-Math.PI / 2, 0, 0], paint.interior)
    this.leftConsole(left, paint)
    this.rightConsole(right)
    this.gearAndBrake()

    // The stick between the knees, with its pistol grip
    this.stick = d.add(
      new Stick(d.group, d.buzz, this.stickPivot, new Vector3(0, -0.4, -0.36), 0.09)
    )
    this.flight = this.stick
    this.buildGrip()

    // Fuel: the tank selector on the floor ahead of the stick, and the wing tank gauges
    // on the floor either side of the seat
    d.box([0.07, 0.05, 0.07], [-0.08, FLOOR + 0.04, -0.56], paint.interior)
    d.add(
      new Knob(d.group, d.buzz, 'FUEL SELECTOR', new Vector3(-0.08, FLOOR + 0.065, -0.56), {
        axis: 'y',
        step: 0.6,
        radius: 0.022,
        color: 0x8a1c14,
        turn: clicks => {
          const i = Math.max(0, Math.min(TANKS.length - 1, TANKS.indexOf(this.tank) + clicks))
          this.tank = TANKS[i]
        },
        pointer: () => (TANKS.indexOf(this.tank) - 1.5) * 60 * DEG,
        state: () => this.tank
      })
    )
    const gallons = () => Math.min(92, (sim.fuel * spec.fuelUnit.perKg) / 2)
    for (const side of [-1, 1]) {
      const floor = d.panel([side * 0.3, FLOOR + 0.03, 0.02], 0.08, 0.08, [-Math.PI / 2, 0, 0])
      d.instrument(
        floor,
        0,
        0,
        new Dial(
          0.06,
          [side < 0 ? 'L MAIN' : 'R MAIN', 'U.S. GAL'],
          [{ min: 0, max: 92, from: -135, to: 135, ticks: 10, labels: 20, read: gallons }]
        )
      )
    }

    // Rudder pedals, which follow the rudder
    for (const side of [-1, 1]) {
      const pedal = new Group()
      const plate = new Mesh(new BoxGeometry(0.08, 0.15, 0.02), MATERIALS.black)
      plate.rotation.x = -0.5
      pedal.add(plate)
      pedal.position.set(side * 0.17, -0.86, -0.86)
      d.group.add(pedal)
      this.pedals.push(pedal)
    }

    this.checklists = this.buildChecklists()
    this.finish()
    // Start matching the aircraft as it is now: running, or cold and dark
    this.syncToFlight()
  }

  /** The P-51D's panel: flight group in the middle, engine gauges either side. */
  private instruments(main: Panel) {
    const d = this.deck
    const { sim } = game
    const spec = this.spec
    const e = this.engine
    const big = 0.078
    const small = 0.056
    const [r1, r2, r3] = [0.095, 0, -0.095]
    // Top row: manifold pressure, airspeed, directional gyro, gyro horizon, tachometer
    d.instrument(
      main,
      -0.215,
      r1,
      new Dial(
        big,
        ['MANIFOLD', 'PRESSURE'],
        [
          {
            min: 10,
            max: 75,
            from: -150,
            to: 150,
            ticks: 1,
            labels: 10,
            read: () => e.manifold,
            bands: [
              { from: 30, to: 46, color: 'green' },
              { from: 61, to: 67, color: 'yellow' }
            ],
            format: v => (v % 10 === 0 ? String(v) : ''),
            lag: 0.4
          }
        ]
      )
    )
    d.instrument(
      main,
      -0.11,
      r1,
      new AirspeedIndicator(big, spec.gauges.airspeed, () => sim.indicatedAirspeed * KNOTS_PER_MS)
    )
    d.instrument(
      main,
      0,
      r1,
      new HeadingIndicator(big, () => {
        const heading = (((sim.heading / DEG) % 360) + 360) % 360
        return { heading, bug: heading }
      })
    )
    d.instrument(
      main,
      0.11,
      r1,
      new AttitudeIndicator(big, () => ({ pitch: sim.pitch, bank: sim.bank }))
    )
    d.instrument(main, 0.215, r1, new Tachometer(big, spec.gauges.power, () => sim.rpm))

    // Middle row: clock, altimeter, turn and bank, rate of climb, engine gauge unit
    // Local time in hours on a 12-hour face, without making a Date every frame
    const localStart = Date.now() - new Date().getTimezoneOffset() * 60_000 - performance.now()
    const hours = () => ((localStart + performance.now()) / 3_600_000) % 12
    d.instrument(
      main,
      -0.215,
      r2,
      new Dial(
        small,
        [],
        [
          {
            min: 0,
            max: 12,
            from: 0,
            to: 360,
            ticks: 0.2,
            labels: 1,
            read: hours,
            needle: 0.55,
            format: v => (v === 12 ? '' : String(v === 0 ? 12 : v)),
            lag: 0.05
          },
          {
            min: 0,
            max: 12,
            from: 0,
            to: 360,
            ticks: 12,
            labels: 12,
            read: () => (hours() % 1) * 12,
            needle: 0.85,
            format: () => '',
            lag: 0.05
          }
        ]
      )
    )
    d.instrument(main, -0.11, r2, new Altimeter(big, () => sim.position.y * FEET_PER_METRE))
    d.instrument(
      main,
      0,
      r2,
      new TurnCoordinator(big, () => ({
        turnRate: sim.powered ? sim.turnRate : 0,
        slip: sim.slip,
        powered: sim.powered
      }))
    )
    d.instrument(
      main,
      0.11,
      r2,
      new VerticalSpeedIndicator(big, spec.gauges.climb, () => sim.verticalSpeed * FPM_PER_MS)
    )
    const fuelPressure = () =>
      (sim.enginesRunning > 0 ? 15 : 0) + (this.boost && sim.powered ? 3 : 0)
    d.instrument(
      main,
      0.215,
      r2,
      new Dial(
        big,
        ['ENGINE GAUGE'],
        [
          {
            centre: [0.3, 0.36],
            radius: 0.42,
            min: 0,
            max: 25,
            from: -80,
            to: 80,
            ticks: 5,
            labels: 25,
            read: fuelPressure,
            bands: [{ from: 12, to: 16, color: 'green' }],
            title: 'FUEL'
          },
          {
            centre: [0.7, 0.36],
            radius: 0.42,
            min: 0,
            max: 200,
            from: -80,
            to: 80,
            ticks: 25,
            labels: 100,
            read: () => e.oilPressure,
            bands: [{ from: 70, to: 80, color: 'green' }],
            title: 'OIL'
          },
          {
            centre: [0.5, 0.74],
            radius: 0.36,
            min: 0,
            max: 100,
            from: -80,
            to: 80,
            ticks: 10,
            labels: 50,
            read: () => e.oilTemp,
            bands: [{ from: 70, to: 80, color: 'green' }],
            title: 'OIL °C',
            lag: 2
          }
        ]
      )
    )

    // Bottom row: suction, hydraulic pressure, compass, coolant, carburettor air, oxygen
    const running = () => sim.enginesRunning > 0
    const smallDial = (u: number, caption: string[], scale: Parameters<typeof dialScale>[0]) =>
      d.instrument(main, u, r3, new Dial(small, caption, [dialScale(scale)]))
    smallDial(-0.25, ['SUCTION'], {
      min: 0,
      max: 10,
      ticks: 1,
      labels: 2,
      read: () => (running() ? Math.min(4.1, sim.rpm / 250) : 0),
      bands: [{ from: 3.75, to: 4.25, color: 'green' }]
    })
    smallDial(-0.18, ['HYDRAULIC'], {
      min: 0,
      max: 2000,
      ticks: 100,
      labels: 500,
      read: () => (running() ? 1050 : 0),
      bands: [{ from: 800, to: 1100, color: 'green' }],
      format: v => String(v / 100)
    })
    smallDial(-0.11, ['REMOTE', 'COMPASS'], {
      min: 0,
      max: 360,
      from: 0,
      to: 360,
      ticks: 10,
      labels: 90,
      read: () => (((sim.heading / DEG) % 360) + 360) % 360,
      format: v => (v === 360 ? '' : (['N', 'E', 'S', 'W'][v / 90] ?? ''))
    })
    smallDial(0.11, ['COOLANT', '°C'], {
      min: -70,
      max: 150,
      ticks: 10,
      labels: 50,
      read: () => e.coolant,
      bands: [
        { from: 100, to: 110, color: 'green' },
        { from: 121, to: 125, color: 'red' }
      ],
      lag: 2
    })
    smallDial(0.18, ['CARB AIR', '°C'], {
      min: -50,
      max: 150,
      ticks: 10,
      labels: 50,
      read: () => 15 - sim.position.y * 0.0065 + 20 * sim.enginePower,
      bands: [{ from: 15, to: 40, color: 'green' }],
      lag: 3
    })
    smallDial(0.25, ['OXYGEN'], {
      min: 0,
      max: 500,
      ticks: 50,
      labels: 100,
      read: () => 400,
      bands: [{ from: 400, to: 450, color: 'green' }],
      format: v => String(v / 100)
    })
    // The standby compass in the middle of the bottom row
    const compass = d.track(new Compass(() => sim.heading / DEG))
    compass.group.position.copy(main.at(0, r3, 0.025))
    compass.group.quaternion.copy(main.face)

    // Gear lights above the gear handle
    d.button(main, 'GEAR DOWN', -0.285, -0.14, {
      lit: () => (sim.gearPosition >= 1 ? 'on' : sim.gearPosition > 0 ? 'alert' : 'off'),
      size: { w: 0.022, h: 0.014 },
      state: () => (sim.gearPosition >= 1 ? 'locked down' : 'not down')
    })
    main.label('NORTH AMERICAN P-51D', 0.215, -0.15, 0.007, '#9a9a90')
  }

  /** The K-14 gyro gunsight on the coaming: the sight head, crash pad, and reflector glass. */
  private gunsight(paint: Record<string, Material>) {
    const d = this.deck
    // Sight head, mounted on the coaming and reaching back toward the pilot
    d.box([0.05, 0.04, 0.08], [0, -0.155, SIGHT_Z - 0.09], MATERIALS.black)
    d.box([0.085, 0.07, 0.14], [0, -0.105, SIGHT_Z - 0.035], MATERIALS.black)
    d.box([0.08, 0.05, 0.03], [0, -0.105, SIGHT_Z + 0.05], paint.leather)
    // Range knob on the left side of the head
    const knob = new Mesh(
      new CylinderGeometry(0.014, 0.014, 0.012, 16).rotateZ(Math.PI / 2),
      MATERIALS.grey
    )
    knob.position.set(-0.05, -0.105, SIGHT_Z - 0.03)
    d.group.add(knob)
    // The reflector: a square of glass leaning back above the head, in a thin frame
    const lean = -0.5
    const glass = d.box(
      [SIGHT_W + 0.01, SIGHT_H + 0.01, 0.003],
      [0, -0.012, SIGHT_Z - 0.01],
      MATERIALS.glass,
      [lean, 0, 0]
    )
    glass.renderOrder = 2
    for (const side of [-1, 1]) {
      d.box(
        [0.004, 0.09, 0.006],
        [side * (SIGHT_W / 2 + 0.007), -0.025, SIGHT_Z - 0.03],
        MATERIALS.black,
        [lean, 0, 0]
      )
    }
    d.box([SIGHT_W + 0.018, 0.004, 0.006], [0, 0.026, SIGHT_Z - 0.031], MATERIALS.black)
    // The reticle, drawn on a plane facing the eye so it lies over the world at its true size
    const field = (2 * Math.atan(SIGHT_W / 2 / -SIGHT_Z)) / DEG
    const reticle = new Display(
      SIGHT_W,
      SIGHT_H,
      4000,
      k14Reticle(field, () => this.sight),
      15
    )
    reticle.mesh.position.set(0, 0, SIGHT_Z)
    reticle.mesh.renderOrder = 3
    d.group.add(reticle.mesh)
    d.track(reticle)
  }

  /** Ignition, primer, booster pump, starter, and the supercharger switch. */
  private startPanel(panel: Panel) {
    const d = this.deck
    const { sim } = game
    d.knob(panel, 'IGNITION', -0.075, -0.008, {
      step: 30 * DEG,
      radius: 0.013,
      color: 0x1c1c1c,
      turn: clicks => {
        const i = Math.max(0, Math.min(3, MAGNETOS.indexOf(this.magnetos) + clicks))
        this.magnetos = MAGNETOS[i]
      },
      pointer: () => (MAGNETOS.indexOf(this.magnetos) - 1.5) * 40 * DEG,
      state: () => MAGNETO_NAMES[this.magnetos]
    })
    d.rocker(panel, 'BOOST', -0.025, -0.012, {
      get: () => this.boost,
      set: on => {
        this.boost = on
      },
      state: () => (this.boost ? 'ON' : 'OFF')
    })
    d.button(panel, 'PRIMER', 0.02, -0.012, {
      hold: pressed => {
        this.priming = pressed && sim.powered
      },
      size: { w: 0.018, h: 0.018 },
      color: 0x2a2c2e,
      state: () => `${this.primed.toFixed(0)} s primed, hold to prime`
    })
    d.button(panel, 'STARTER', 0.06, -0.012, {
      hold: pressed => {
        this.starter = pressed
      },
      size: { w: 0.018, h: 0.018 },
      color: 0x8a1a14,
      state: () => {
        const engine = sim.engines[0]
        if (engine?.running) return 'engine running'
        if (!sim.powered) return 'battery off'
        return this.starter ? 'cranking' : 'hold until the engine fires'
      }
    })
    // The starter's red guard, swung open
    const guard = d.box([0.024, 0.004, 0.02], [0, 0, 0], MATERIALS.black)
    guard.position.copy(panel.at(0.06, 0.008, 0.02))
    guard.quaternion.copy(panel.face)
    panel.label('L    R    BOTH', -0.075, -0.035, 0.006)
  }

  /** The gunsight and gun switches, right of the stick. */
  private sightPanel(panel: Panel) {
    const d = this.deck
    d.rocker(panel, 'SIGHT', -0.06, -0.012, {
      get: () => this.sight,
      set: on => {
        this.sight = on
      },
      state: () => (this.sight ? 'GYRO + FIXED' : 'OFF')
    })
    d.rocker(panel, 'GUNS', -0.02, -0.012, {
      get: () => this.guns,
      set: on => {
        this.guns = on
      },
      state: () => (this.guns ? 'GUNS, CAMERA & SIGHT' : 'SAFE')
    })
    d.plate(panel, 0.055, -0.005, 0.07, 0.03, 'OXYGEN', '#e8e8e2')
  }

  /** Throttle quadrant, trim wheels, and the flap handle along the left console. */
  private leftConsole(panel: Panel, paint: Record<string, Material>) {
    const d = this.deck
    const { pilot } = game
    const c = pilot.controls
    const consoleZ = -0.14
    const v = (z: number) => consoleZ - z
    // The quadrant: its body, and three levers sliding fore and aft over it
    d.box([0.12, 0.05, 0.27], [-0.34, -0.445, -0.32], paint.interior)
    const quadrant = (
      label: string,
      x: number,
      knob: { color: number; shape: 'box' | 'ball' | 'pull' },
      get: () => number,
      set: (value: number, released: boolean) => void,
      state: () => string,
      detents?: number[]
    ) =>
      d.add(
        new Lever(
          d.group,
          d.buzz,
          label,
          new Vector3(x, -0.385, -0.21),
          new Vector3(x, -0.385, -0.43),
          new Vector3(x, -0.48, -0.32),
          { get, set, knob, state, detents }
        )
      )
    const throttle = quadrant(
      'THROTTLE',
      -0.295,
      { color: 0x161616, shape: 'box' },
      () => c.throttle,
      (value, released) => {
        if (released) c.throttle = value
      },
      () => `${this.engine.manifold.toFixed(0)} in. Hg`
    )
    this.throttles = [throttle]
    quadrant(
      'PROPELLER',
      -0.34,
      { color: 0x1c1c1c, shape: 'ball' },
      () => this.prop,
      value => {
        this.prop = value
      },
      () => `${Math.round(1800 + 1200 * this.prop)} RPM governed`
    )
    quadrant(
      'MIXTURE',
      -0.38,
      { color: 0x8a1c14, shape: 'pull' },
      () => this.mixture,
      value => {
        this.mixture = value
      },
      () =>
        this.mixture < 0.25 ? 'IDLE CUT-OFF' : this.mixture < 0.75 ? 'AUTO LEAN' : 'AUTO RICH',
      [0, 0.5, 1]
    )
    panel.label('THROTTLE', 0.035, v(-0.43), 0.007)
    panel.label('OPEN', 0.035, v(-0.41), 0.006)
    panel.label('CLOSED', 0.035, v(-0.2), 0.006)

    // Elevator trim wheel against the wall, rudder and aileron trim knobs inboard of it
    d.add(
      new TrimWheel(d.group, d.buzz, new Vector3(-0.39, -0.445, -0.08), 0.055, {
        get: () => c.trim,
        set: trim => {
          c.trim = trim
        }
      })
    )
    d.add(
      new Knob(d.group, d.buzz, 'RUDDER TRIM', new Vector3(-0.33, -0.47, -0.12), {
        axis: 'y',
        step: 15 * DEG,
        radius: 0.03,
        color: 0x1a1a1a,
        turn: clicks => {
          this.rudderTrim = Math.max(-1, Math.min(1, this.rudderTrim + clicks * 0.1))
        },
        pointer: () => this.rudderTrim * 90 * DEG,
        state: () =>
          `${Math.abs(Math.round(this.rudderTrim * 10))}° ${this.rudderTrim >= 0 ? 'right' : 'left'}`
      })
    )
    d.add(
      new Knob(d.group, d.buzz, 'AILERON TRIM', new Vector3(-0.33, -0.47, -0.03), {
        axis: 'y',
        step: 15 * DEG,
        radius: 0.014,
        color: 0x1a1a1a,
        turn: clicks => {
          this.aileronTrim = Math.max(-1, Math.min(1, this.aileronTrim + clicks * 0.1))
        },
        pointer: () => this.aileronTrim * 90 * DEG,
        state: () => `${Math.round(this.aileronTrim * 10)}°`
      })
    )
    panel.label('ELEV TRIM', -0.03, v(-0.16), 0.006)
    panel.label('RUDDER', 0.03, v(-0.165), 0.006)
    panel.label('AIL', 0.03, v(-0.055), 0.006)

    // Flap handle: pull it aft for more flap
    const notches = this.spec.flapLabels.length - 1
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'FLAPS',
        new Vector3(-0.375, -0.43, 0.03),
        new Vector3(-0.375, -0.43, 0.16),
        new Vector3(-0.375, -0.5, 0.095),
        {
          get: () => c.flapNotch / notches,
          set: value => {
            if (game.getState().status === 'flying') c.flapNotch = Math.round(value * notches)
          },
          detents: this.spec.flapLabels.map((_, i) => i / notches),
          knob: { color: 0x9a9fa4, shape: 'box' },
          state: () => this.spec.flapLabels[c.flapNotch]
        }
      )
    )
    this.spec.flapLabels.forEach((label, i) => {
      panel.label(label, 0.04, v(0.03 + (0.13 * i) / notches), 0.006)
    })
    panel.label('FLAPS', 0.04, v(0.0), 0.007)
  }

  /** The electrical switch box and the radio, along the right console. */
  private rightConsole(panel: Panel) {
    const d = this.deck
    const { pilot } = game
    const c = pilot.controls
    const switches: [string, () => boolean, (on: boolean) => void][] = [
      ['BATTERY', () => c.battery, () => key('KeyO')],
      ['GENERATOR', () => this.generator, on => (this.generator = on)],
      ['LANDING LT', () => pilot.landingLights, () => key('KeyL')],
      ['NAV LIGHTS', () => this.navLights, on => (this.navLights = on)]
    ]
    switches.forEach(([label, get, set], i) => {
      d.rocker(panel, label, 0, 0.27 - i * 0.065, {
        get,
        set,
        color: i === 0 ? 0x8a1a14 : undefined
      })
    })
    panel.label('ELECTRICAL', 0, 0.31, 0.008)
    // The four-channel VHF radio's control box, aft
    d.plate(panel, 0, -0.1, 0.08, 0.05, 'VHF  A B C D', '#e8e8e2')
    d.plate(panel, 0, -0.18, 0.08, 0.04, 'IFF', '#e8e8e2')
  }

  /** The gear handle and parking brake, low on the left of the panel. */
  private gearAndBrake() {
    const d = this.deck
    const c = game.pilot.controls
    d.add(
      new Lever(
        d.group,
        d.buzz,
        'LANDING GEAR',
        new Vector3(-0.33, -0.49, -0.68),
        new Vector3(-0.33, -0.6, -0.68),
        new Vector3(-0.33, -0.545, -0.74),
        {
          get: () => (c.gearDown ? 1 : 0),
          set: (value, released) => {
            if (released && value > 0.5 !== c.gearDown) key('KeyG')
          },
          detents: [0, 1],
          knob: { color: 0x1a1a1a, shape: 'wheel' },
          state: () => {
            const p = game.sim.gearPosition
            return p >= 1 ? 'DOWN' : p <= 0 ? 'UP' : 'MOVING'
          }
        }
      )
    )
    // Pull the T handle to set the brakes: held partway, it works them while held
    const brake = new Lever(
      d.group,
      d.buzz,
      'PARKING BRAKE',
      new Vector3(-0.25, -0.645, -0.71),
      new Vector3(-0.25, -0.645, -0.64),
      new Vector3(-0.25, -0.645, -0.76),
      {
        get: () => (c.parkingBrake ? 1 : 0),
        set: (value, released) => {
          if (released) c.parkingBrake = value > 0.85
        },
        spring: () => !c.parkingBrake,
        knob: { color: 0x1a1a1a, shape: 'tee' },
        state: () => (c.parkingBrake ? 'SET' : 'OFF')
      }
    )
    this.brakes = [d.add(brake)]
  }

  /** The pistol grip on the stick: a forward-leaning head, trigger guard, and bomb button. */
  private buildGrip() {
    const head = new Mesh(new BoxGeometry(0.036, 0.04, 0.055), MATERIALS.black)
    head.position.set(0, 0.07, -0.01)
    head.rotation.x = 0.3
    const guard = new Mesh(new TorusGeometry(0.02, 0.003, 6, 12, Math.PI), MATERIALS.grey)
    guard.rotation.y = Math.PI / 2
    guard.position.set(0, 0.03, -0.022)
    const bomb = new Mesh(
      new CylinderGeometry(0.005, 0.005, 0.008, 10),
      new MeshStandardMaterial({ color: 0xb01c1c, roughness: 0.5 })
    )
    bomb.position.set(0.008, 0.093, -0.004)
    this.grip.add(head, guard, bomb)
    this.deck.group.add(this.grip)
  }

  /** Floor, walls, seat, armour, canopy rails and frame, and the rear fuselage. */
  private buildShell(paint: Record<string, Material>) {
    const d = this.deck
    d.box([2 * WALL, 0.03, 1.5], [0, FLOOR, -0.2], MATERIALS.floor)
    for (const side of [-1, 1]) {
      // Inside wall up to the sill, and the outside skin just beyond it
      d.box([0.03, SILL - FLOOR, 1.5], [side * WALL, (SILL + FLOOR) / 2, -0.2], paint.interior)
      d.box([0.02, 0.62, 1.7], [side * (WALL + 0.035), SILL - 0.33, -0.15], paint.metal)
      // Canopy rail along the sill, from the windscreen to behind the head
      d.box([0.05, 0.025, 1.3], [side * (WALL + 0.01), SILL + 0.01, 0.25], MATERIALS.frame)
    }
    // Footwell behind the panel
    d.box([2 * WALL, 0.5, 0.04], [0, FLOOR + 0.25, -0.88], paint.interior)
    // Seat, with its cushion and back
    d.box([0.4, 0.08, 0.42], [0, -0.79, 0.06], paint.olive)
    d.box([0.38, 0.06, 0.4], [0, -0.73, 0.06], paint.leather)
    d.box([0.4, 0.5, 0.06], [0, -0.5, 0.31], paint.olive, [-0.12, 0, 0])
    // Armour plate behind the head: wide at the shoulders, narrower behind the head, with
    // the headrest pad
    d.box([0.48, 0.42, 0.025], [0, -0.42, 0.37], paint.armour, [-0.1, 0, 0])
    d.box([0.3, 0.3, 0.025], [0, -0.06, 0.4], paint.armour, [-0.1, 0, 0])
    d.box([0.2, 0.16, 0.05], [0, 0.0, 0.37], paint.leather, [-0.1, 0, 0])

    // Windscreen: the flat armoured front pane, side panes, and the bow they meet
    const base = -0.17
    const top = 0.2
    const bl = (s: number) => new Vector3(s * 0.16, base, -0.76)
    const tl = (s: number) => new Vector3(s * 0.12, top, -0.46)
    const rail = (s: number) => new Vector3(s * WALL, SILL + 0.02, -0.4)
    const bow = (s: number) => new Vector3(s * 0.34, 0.02, -0.42)
    for (const s of [-1, 1]) {
      d.beam(bl(s), tl(s), 0.016, MATERIALS.frame)
      d.beam(bl(s), rail(s), 0.018, MATERIALS.frame)
      d.beam(rail(s), bow(s), 0.016, MATERIALS.frame)
      d.beam(bow(s), tl(s), 0.016, MATERIALS.frame)
    }
    d.beam(bl(-1), bl(1), 0.02, MATERIALS.frame)
    d.beam(tl(-1), tl(1), 0.018, MATERIALS.frame)
    // The armoured glass, thick enough to tint the view a little
    const pane = d.box([0.27, 0.47, 0.004], [0, (base + top) / 2, -0.61], paint.glass, [0.68, 0, 0])
    pane.renderOrder = 1
    // Rear-view mirror on top of the bow
    d.box([0.07, 0.02, 0.008], [0, top + 0.03, -0.45], MATERIALS.grey)

    // The bubble canopy's frame behind the head, down to the rails
    const hoop: Vector3[] = []
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * Math.PI
      hoop.push(
        new Vector3(
          -Math.cos(a) * WALL,
          SILL + 0.02 + Math.sin(a) * 0.52,
          0.95 - Math.sin(a) * 0.15
        )
      )
    }
    for (let i = 0; i < hoop.length - 1; i++) d.beam(hoop[i], hoop[i + 1], 0.025, MATERIALS.frame)
    // Rear fuselage behind the canopy, out to the tail
    tube(d, new Vector3(0, -0.66, 0.6), new Vector3(0, -0.5, 5.4), 0.5, 0.2, paint.metal).scale.set(
      0.88,
      1,
      1
    )
    // The radio and fuselage tank behind the armour, seen through the canopy
    d.box([0.6, 0.3, 0.5], [0, -0.42, 0.75], paint.interior)
  }

  /** The long Merlin nose: cowling, anti-glare panel, exhaust stacks, spinner, and blades. */
  private buildNose(paint: Record<string, Material>) {
    const d = this.deck
    const rear = new Vector3(0, -0.63, -0.72)
    const front = new Vector3(0, HUB.y, HUB.z + 0.25)
    tube(d, rear, front, 0.46, 0.37, paint.metal).scale.set(0.84, 1, 1)
    // The olive drab anti-glare panel along the top, a little proud of the skin
    tube(d, rear, front, 0.465, 0.375, paint.olive, 1.1).scale.set(0.84, 1, 1)
    // Six exhaust stacks each side, in a row along the upper cowling
    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const t = 0.32 + i * 0.07
        const at = rear.clone().lerp(front, t)
        const r = 0.46 + (0.37 - 0.46) * t
        d.box([0.05, 0.06, 0.09], [side * r * 0.84, at.y + r * 0.35, at.z], paint.exhaust)
      }
    }
    // Spinner and four blades with yellow tips
    const spinner = new Mesh(new ConeGeometry(0.21, 0.6, 20).rotateX(-Math.PI / 2), paint.red)
    spinner.position.copy(HUB).setZ(HUB.z - 0.05)
    d.group.add(spinner)
    for (let i = 0; i < 4; i++) {
      const arm = new Group()
      arm.rotation.z = (i * Math.PI) / 2 + 0.4
      const blade = new Mesh(new BoxGeometry(0.2, 1.5, 0.04), MATERIALS.black)
      blade.position.y = 0.95
      blade.rotation.y = 0.35
      const tip = new Mesh(new BoxGeometry(0.2, 0.12, 0.045), paint.yellow)
      tip.position.y = 0.69
      blade.add(tip)
      arm.add(blade)
      this.blades.add(arm)
    }
    this.blades.position.copy(HUB)
    d.group.add(this.blades)
  }

  /** Sets the switches to match the aircraft at the start of a flight. */
  private syncToFlight() {
    const { pilot, sim } = game
    const c = pilot.controls
    this.flightSeen = game.flight
    const running = sim.enginesRunning > 0
    this.magnetos = running ? 'both' : 'off'
    this.mixture = running ? 1 : 0
    this.boost = false
    this.starter = false
    this.primed = running ? 3 : 0
    this.latched = false
    this.wrote = c.engineSwitches[0]
    this.tank = c.fuelPumps ? 'L MAIN' : 'OFF'
    this.fed = c.fuelPumps
  }

  protected tick(dt: number) {
    const { pilot, sim } = game
    const c = pilot.controls
    if (game.flight !== this.flightSeen) this.syncToFlight()
    this.engine.update(dt)
    if (this.priming) this.primed += dt

    // The fuel selector feeds the engine; the keyboard's fuel key moves it too
    if (c.fuelPumps !== this.fed) this.tank = c.fuelPumps ? 'L MAIN' : 'OFF'
    c.fuelPumps = this.tank !== 'OFF'
    this.fed = c.fuelPumps

    // The engine runs with the ignition on and the mixture out of cut-off. The starter
    // turns it over while held; let go before it fires and it stops cranking.
    const running = sim.engines[0]?.running ?? false
    if (c.engineSwitches[0] !== this.wrote) {
      // The keyboard's engine key: set the panel to match
      if (c.engineSwitches[0]) {
        this.magnetos = 'both'
        this.mixture = 1
        this.latched = true
      } else this.magnetos = 'off'
    }
    const lit = this.magnetos !== 'off' && this.mixture >= 0.25
    if (!lit || running) this.latched = false
    const on = lit && (this.starter || running || this.latched)
    c.engineSwitches[0] = on
    this.wrote = on

    // Propeller: blades turning on the starter, a blur once it runs
    this.blades.rotation.z -= (sim.rpm / 60) * Math.PI * 2 * dt
    const blur = sim.rpm > 400
    this.blades.visible = !blur
    this.disc.visible = blur

    // The grip rides on top of the stick
    const top = this.stick.grabPoint()
    this.grip.position.copy(top)
    this.grip.quaternion.setFromUnitVectors(
      UP,
      this.reach.copy(top).sub(this.stickPivot).normalize()
    )
    for (const [i, pedal] of this.pedals.entries()) {
      pedal.position.z = -0.86 + (i === 0 ? 1 : -1) * c.yaw * 0.05
    }
  }

  /** The P-51D's checklists, short, ticking as each step is done. */
  private buildChecklists() {
    const { pilot, sim } = game
    const c = pilot.controls
    const step = (text: string, done: () => boolean) => ({ text, done })
    return [
      {
        title: 'Before Starting',
        items: [
          step('Battery: ON', () => c.battery),
          step('Fuel selector: L MAIN', () => this.tank === 'L MAIN'),
          step('Mixture: AUTO RICH', () => this.mixture > 0.75),
          step('Propeller: full INCREASE', () => this.prop > 0.9),
          step('Throttle: cracked 1 inch', () => c.throttle > 0.03 && c.throttle < 0.2),
          step('Ignition: BOTH', () => this.magnetos === 'both')
        ]
      },
      {
        title: 'Starting Engine',
        items: [
          step('Fuel boost pump: ON', () => this.boost),
          step('Primer: hold 3 seconds', () => this.primed >= 3),
          step('Starter: hold until the engine fires', () => sim.enginesRunning > 0),
          step('Oil pressure: 50 psi or more', () => this.engine.oilPressure >= 50),
          step('Generator: ON', () => this.generator)
        ]
      },
      {
        title: 'Before Takeoff',
        items: [
          step('Rudder trim: 6° right', () => this.rudderTrim > 0.45 && this.rudderTrim < 0.75),
          step('Elevator trim: about neutral', () => Math.abs(c.trim) < 0.25),
          step('Flaps: UP', () => c.flapNotch === 0),
          step('Gunsight: ON', () => this.sight),
          step('Parking brake: OFF', () => !c.parkingBrake),
          step('Throttle: smoothly to 61 inches', () => this.engine.manifold > 55),
          step('Gear: UP once airborne', () => !sim.onGround && !c.gearDown)
        ]
      },
      {
        title: 'Landing',
        items: [
          step('Fuel boost pump: ON', () => this.boost),
          step('Gear: DOWN below 148 kt', () => c.gearDown),
          step('Flaps: 50° on final', () => c.flapNotch === this.spec.flapLabels.length - 1),
          step('Propeller: full INCREASE', () => this.prop > 0.9),
          step('Touchdown: three points', () => sim.onGround)
        ]
      }
    ]
  }
}

/** A scale for a small single-needle dial, swept round most of the face. */
function dialScale(scale: Omit<Scale, 'from' | 'to'> & Partial<Pick<Scale, 'from' | 'to'>>) {
  return { from: -135, to: 135, ...scale }
}

/**
 * The K-14 reticle, drawn at its true angular size: the fixed cross in its ring, and the
 * gyro reticle of six diamonds around a centre pip, which lags behind a turn by the lead
 * the bullets need. `field` is the glass's width in degrees.
 */
function k14Reticle(field: number, on: () => boolean) {
  let down = 0
  let right = 0
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(0, 0, w, h)
    const { sim } = game
    if (!sim.powered || !on()) return
    const perDegree = w / field
    const cx = w / 2
    const cy = h / 2
    // About 0.4 s of flight time to the target: the reticle lags the turn by that much
    const lead = 0.4 / DEG
    const spin = sim.angularVelocity
    down += (spin.x * lead - down) * 0.3
    right += (spin.y * lead - right) * 0.3
    ctx.lineWidth = Math.max(2, w * 0.006)
    // Fixed reticle: a cross and its 70 mil ring
    ctx.strokeStyle = 'rgba(255, 150, 60, 0.85)'
    ctx.beginPath()
    ctx.arc(cx, cy, 2 * perDegree, 0, Math.PI * 2)
    ctx.moveTo(cx - 0.5 * perDegree, cy)
    ctx.lineTo(cx + 0.5 * perDegree, cy)
    ctx.moveTo(cx, cy - 0.5 * perDegree)
    ctx.lineTo(cx, cy + 0.5 * perDegree)
    ctx.stroke()
    // Gyro reticle: set for a 37 ft wingspan at 300 yards
    const x = cx + Math.max(-4, Math.min(4, right)) * perDegree
    const y = cy + Math.max(-3.5, Math.min(3.5, down)) * perDegree
    const radius = 1.2 * perDegree
    const size = w * 0.012
    ctx.fillStyle = 'rgba(255, 176, 70, 0.95)'
    ctx.beginPath()
    ctx.arc(x, y, size * 0.7, 0, Math.PI * 2)
    ctx.fill()
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3
      const px = x + Math.sin(a) * radius
      const py = y - Math.cos(a) * radius
      ctx.beginPath()
      ctx.moveTo(px, py - size)
      ctx.lineTo(px + size * 0.7, py)
      ctx.lineTo(px, py + size)
      ctx.lineTo(px - size * 0.7, py)
      ctx.closePath()
      ctx.fill()
    }
  }
}

/** The cockpits this file builds, by aircraft id. */
export const COCKPITS = { p51: MustangCockpit }
