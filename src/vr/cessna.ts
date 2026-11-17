import {
  BoxGeometry,
  CanvasTexture,
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
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
  Vector3
} from 'three'
import { game } from '../game/game'
import type { AircraftSpec } from '../sim/aircraft'
import { bestMixture, MIXTURE_CUTOFF, type Procedures, procedureState } from '../sim/flight-sim'
import { FEET_PER_METRE, FPM_PER_MS, KNOTS_PER_MS } from '../ui/telemetry'
import { type CockpitView, key } from './cockpit'
import {
  Button,
  type Buzz,
  type Control,
  ControlSet,
  Key,
  Knob,
  Lever,
  Rocker,
  SHARED_MATERIALS,
  TrimWheel,
  Yoke
} from './controls'
import {
  AirspeedIndicator,
  Altimeter,
  AttitudeIndicator,
  Compass,
  CourseIndicator,
  HeadingIndicator,
  Tachometer,
  TurnCoordinator,
  TwinGauge,
  VerticalSpeedIndicator
} from './gauges'
import type { Interactor } from './input'
import type { Checklist } from './tablet'

/*
 * The Cessna 172S cockpit, life size, in metres from the pilot's eye: +X right, +Y up,
 * -Z forward. The pilot sits in the left seat, so the cabin's centreline is 0.25 m to the
 * right. Layout follows the 172S with its steam gauge panel and Bendix/King avionics.
 */
const C = 0.25
const PANEL_Z = -0.72
const PANEL_TOP = -0.1
const PANEL_BOTTOM = -0.5
const LEFT_WALL = -0.27
const RIGHT_WALL = 0.77
const FLOOR = -1.0
const ROOF = 0.2
const SILL = -0.28
const SIX = 0.082
// Centre of the avionics stack, just right of the cabin's centreline
const STACK = 0.31
const DEG = Math.PI / 180
const GALLONS_PER_KG = 1 / (0.72 * 3.785)

const PANEL = new MeshStandardMaterial({ color: 0x2a2b2d, roughness: 0.8, emissive: 0x0b0b0c })
const GLARESHIELD = new MeshStandardMaterial({ color: 0x141414, roughness: 0.95 })
// Interior surfaces glow a little: the cabin is lit by daylight through every window
const TRIM = new MeshStandardMaterial({ color: 0x9a968c, roughness: 0.9, emissive: 0x2c2a26 })
const CARPET = new MeshStandardMaterial({ color: 0x3a3c40, roughness: 1, emissive: 0x0e0f10 })
const SEAT = new MeshStandardMaterial({ color: 0x4a5160, roughness: 0.95, emissive: 0x121418 })
const FRAME = new MeshStandardMaterial({ color: 0xd9d6cc, roughness: 0.7, emissive: 0x3a3832 })
// The headliner faces down, away from the sun, so daylight from the windows lights it
const HEADLINER = new MeshStandardMaterial({ color: 0xd9d6cc, roughness: 0.9, emissive: 0x6e6a60 })
const PAINT = new MeshStandardMaterial({ color: 0xf3f2ee, roughness: 0.45, metalness: 0.1 })
const DARK = new MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.6 })
const BLADE = new MeshStandardMaterial({ color: 0x222222, roughness: 0.5 })
const DISC = new MeshBasicMaterial({
  color: 0x9a9a9a,
  transparent: true,
  opacity: 0.12,
  side: DoubleSide,
  depthWrite: false
})
const OWN = new Set<Material>([
  PANEL,
  GLARESHIELD,
  TRIM,
  CARPET,
  SEAT,
  FRAME,
  HEADLINER,
  PAINT,
  DARK,
  BLADE,
  DISC
])

/** A flat panel display drawn from a canvas, redrawn on demand. */
class Display {
  readonly mesh: Mesh
  readonly ctx: CanvasRenderingContext2D
  private readonly texture: CanvasTexture

  constructor(width: number, height: number, pixelsPerMetre: number) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * pixelsPerMetre)
    canvas.height = Math.round(height * pixelsPerMetre)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The browser gave no 2D canvas, so the avionics cannot draw')
    this.ctx = ctx
    this.texture = new CanvasTexture(canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = 4
    this.mesh = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false })
    )
  }

  draw(paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
    paint(this.ctx, this.ctx.canvas.width, this.ctx.canvas.height)
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
  }
}

/**
 * The airframe's own systems the instruments read: vacuum for the gyros, the electrical
 * bus, oil temperature and pressure, and the gyros' spin. Reset at each new flight.
 */
class Systems {
  vacuum = 0
  /** Spin of the vacuum gyros, 0 stopped to 1 at speed. */
  gyro = 0
  oilTemp = 60
  /** Degrees the heading indicator has drifted from the compass. */
  drift = 0
  volts = 0
  amps = 0
  private flight = -1

  update(dt: number) {
    const { sim } = game
    const procedures = game.pilot.controls.procedures
    if (game.flight !== this.flight) {
      // A new flight: warm and set if the engine already runs, cold and unset otherwise
      this.flight = game.flight
      const running = sim.enginesRunning > 0
      this.gyro = running ? 1 : 0
      this.oilTemp = running ? 180 : 60
      this.drift = running ? 0 : 25 + Math.random() * 60
    }
    const rpm = sim.rpm
    const running = sim.enginesRunning > 0
    // The engine-driven vacuum pump makes about 5 inches of mercury from 1,000 rpm
    const target = running ? Math.min(5.2, (rpm / 1000) * 4.8) : 0
    this.vacuum += (target - this.vacuum) * Math.min(1, dt * 2)
    // Gyros take about half a minute to spin up and several minutes to run down
    this.gyro +=
      ((this.vacuum > 3.5 ? 1 : 0) - this.gyro) * Math.min(1, dt / (this.vacuum > 3.5 ? 20 : 120))
    this.oilTemp +=
      ((running ? 180 + 25 * sim.enginePower : 60) - this.oilTemp) * Math.min(1, dt / 240)
    // A gyro precesses a few degrees every quarter hour
    this.drift += dt * 0.004
    const master = game.pilot.controls.battery
    const charging = running && rpm > 1000 && (procedures?.alternator ?? true)
    this.volts = master ? (charging ? 28 : 24) : 0
    this.amps = master ? (charging ? 4 : -8) : 0
  }

  get oilPressure() {
    const { sim } = game
    if (sim.enginesRunning === 0) return 0
    const cold = Math.max(0, (180 - this.oilTemp) / 120)
    return Math.min(100, 30 + 50 * (sim.rpm / 2700) + 25 * cold)
  }

  /** Exhaust gas temperature as a share of the gauge: hottest just lean of best power. */
  get egt() {
    const { sim } = game
    const procedures = game.pilot.controls.procedures
    if (sim.enginesRunning === 0 || !procedures) return 0
    const off = procedures.mixture - (bestMixture(sim.position.y) - 0.08)
    return Math.max(0, 0.55 + 0.35 * sim.enginePower - 1.4 * Math.abs(off))
  }

  get fuelFlow() {
    const { sim } = game
    return sim.enginesRunning > 0 ? 1.5 + 13 * sim.enginePower : 0
  }
}

/** The pilot's own copies of switches the flight model does not need, such as the beacon. */
type Lights = { beacon: boolean; taxi: boolean; nav: boolean; strobe: boolean }

/** The Cessna 172S cockpit in VR. */
export class CessnaCockpit implements CockpitView {
  readonly group = new Group()
  readonly controls: ControlSet
  /** A kneeboard strapped to the pilot's left thigh, tilted up to read. */
  readonly tablet = {
    position: new Vector3(-0.07, -0.52, -0.3),
    rotation: new Euler(-1.05, 0.25, 0, 'YXZ')
  }
  readonly checklists: Checklist[]
  private readonly yoke: Yoke
  private readonly throttle: Lever
  private readonly brake: Lever
  private readonly systems = new Systems()
  private readonly instruments: { update: (dt: number) => void; dispose: () => void }[] = []
  private readonly gps: Display
  private readonly autopilot: Display
  private readonly annunciator: Display
  private readonly textures: Texture[] = []
  /** Radio faces that go dark with the avionics master off. */
  private readonly radios: MeshBasicMaterial[] = []
  private readonly propeller = new Group()
  private readonly blades = new Group()
  private readonly disc = new Mesh(new CircleGeometry(0.95, 40), DISC)
  private readonly pedals: Group[] = []
  private readonly flapPointer: Mesh
  private readonly trimPointer: Mesh
  private readonly lights: Lights = { beacon: false, taxi: false, nav: false, strobe: false }
  private selector: 'left' | 'both' | 'right' = 'both'
  private shutoff = false
  private written: Procedures['fuelSelector'] = 'both'
  private displayClock = 0
  private shown = { gps: '', autopilot: '', annunciator: '' }
  /** Run-up checks seen so far: each magneto alone, and the controls at full travel. */
  private readonly runUp = { left: false, right: false, travel: new Set<string>() }
  private flight = -1

  constructor(
    readonly spec: AircraftSpec,
    buzz: Buzz
  ) {
    const g = this.group
    const { pilot, sim } = game
    const c = pilot.controls
    // The real controls: kept on the pilot so the flight model runs the engine by them
    // A ready aircraft has its master and radios on even with the engine stopped
    const running = sim.enginesRunning > 0
    c.procedures ??= {
      ...procedureState(running),
      alternator: running || c.battery,
      avionics: running || c.battery
    }
    const procedures = c.procedures
    this.buildCabin()
    this.buildEngine()

    // Six-pack: airspeed, attitude, altimeter over turn coordinator, heading, climb rate
    const s = this.systems
    const at = (x: number, y: number, item: { group: Group }) => {
      item.group.position.set(x, y, PANEL_Z + 0.002)
      g.add(item.group)
    }
    const track = <T extends { update: (dt: number) => void; dispose: () => void }>(item: T) => {
      this.instruments.push(item)
      return item
    }
    const [x1, x2, x3] = [-0.09, 0, 0.09]
    const [y1, y2] = [-0.175, -0.27]
    at(
      x1,
      y1,
      track(
        new AirspeedIndicator(SIX, spec.gauges.airspeed, () => sim.indicatedAirspeed * KNOTS_PER_MS)
      )
    )
    at(
      x2,
      y1,
      track(
        new AttitudeIndicator(SIX, () => {
          // A gyro short of speed wanders off level
          const error = 1 - s.gyro
          return { pitch: sim.pitch + error * 8 * DEG, bank: sim.bank + error * 25 * DEG }
        })
      )
    )
    at(x3, y1, track(new Altimeter(SIX, () => sim.position.y * FEET_PER_METRE)))
    at(
      x1,
      y2,
      track(
        new TurnCoordinator(SIX, () => ({
          turnRate: sim.powered ? sim.turnRate : 0,
          slip: sim.slip,
          powered: sim.powered
        }))
      )
    )
    const heading = () => (((sim.heading / DEG + s.drift * s.gyro) % 360) + 360) % 360
    at(
      x2,
      y2,
      track(
        new HeadingIndicator(SIX, () => ({
          heading: heading(),
          bug: pilot.autopilot.heading / DEG + s.drift * s.gyro
        }))
      )
    )
    at(x3, y2, track(new VerticalSpeedIndicator(SIX, 2000, () => sim.verticalSpeed * FPM_PER_MS)))
    at(x1, -0.37, track(new Tachometer(0.072, spec.gauges.power, () => sim.rpm)))
    at(
      0.175,
      y1,
      track(
        new CourseIndicator(0.075, () => {
          const { nav } = game
          const on = sim.powered && c.procedures?.avionics === true && nav.approach !== null
          const valid = on && nav.guidance.receiving
          return {
            lateral: nav.guidance.lateral,
            vertical: nav.guidance.vertical,
            course: nav.approach?.end.heading ?? 0,
            valid,
            slope: valid && nav.approach?.kind === 'ILS'
          }
        })
      )
    )

    // Engine cluster, left of the six-pack
    const gal = () => (sim.fuel * GALLONS_PER_KG) / 2 / 26
    const cluster: [string, () => number, string, () => number][] = [
      ['FUEL L', gal, 'FUEL R', gal],
      ['EGT', () => s.egt, 'FUEL FLOW', () => s.fuelFlow / 18],
      ['OIL °F', () => (s.oilTemp - 50) / 200, 'OIL PSI', () => s.oilPressure / 115],
      ['VAC', () => s.vacuum / 7, 'AMPS', () => 0.5 + s.amps / 40]
    ]
    // The gauges are electric: with the master off every needle rests at zero
    const powered = (read: () => number) => () => (c.battery ? read() : 0)
    cluster.forEach(([a, readA, b, readB], i) => {
      const gauge = track(
        new TwinGauge(0.075, 0.042, [
          { label: a, read: powered(readA), bands: [{ from: 0.15, to: 1, color: 'green' }] },
          { label: b, read: powered(readB), bands: [{ from: 0.3, to: 0.8, color: 'green' }] }
        ])
      )
      gauge.group.position.set(-0.205, -0.15 - i * 0.05, PANEL_Z + 0.002)
      g.add(gauge.group)
    })

    const compass = track(new Compass(() => sim.heading / DEG))
    compass.group.position.set(C, ROOF - 0.07, -0.5)
    g.add(compass.group)

    // Avionics stack on the centreline
    this.annunciator = new Display(0.15, 0.016, 2400)
    this.annunciator.mesh.position.set(STACK, -0.118, PANEL_Z + 0.003)
    this.gps = new Display(0.15, 0.06, 2000)
    this.gps.mesh.position.set(STACK, -0.172, PANEL_Z + 0.003)
    this.autopilot = new Display(0.15, 0.026, 2400)
    this.autopilot.mesh.position.set(STACK, -0.257, PANEL_Z + 0.003)
    g.add(this.annunciator.mesh, this.gps.mesh, this.autopilot.mesh)
    this.staticFace(STACK, -0.137, 0.15, 0.018, 'COM1  COM2  NAV1  MKR  SPKR', '#c9c9c9', '#202124')
    this.radios.push(
      this.staticFace(STACK, -0.222, 0.15, 0.03, 'NAV 110.30   COM 121.50', '#ff7a1a', '#0b0b0b')
    )
    this.radios.push(
      this.staticFace(STACK, -0.322, 0.15, 0.026, 'XPDR  1200   ALT', '#ff7a1a', '#0b0b0b')
    )

    // Autopilot (KAP 140) buttons under its display
    const all: Control[] = []
    const avionics = () => sim.powered && procedures.avionics
    const ap = (label: string, x: number, act: () => void) =>
      all.push(
        new Button(g, buzz, label, new Vector3(x, -0.283, PANEL_Z), {
          press: () => {
            if (avionics() && game.getState().status === 'flying') act()
          },
          size: { w: 0.017, h: 0.012 },
          color: 0x3a3c40
        })
      )
    const labels: { text: string; x: number; y: number }[] = []
    const apButtons: [string, () => void][] = [
      ['AP', () => key('KeyZ')],
      ['HDG', () => pilot.setLateral('HDG', sim, game.nav)],
      ['NAV', () => key('KeyJ')],
      ['APR', game.toggleApproachAutopilot],
      ['ALT', () => pilot.setVertical('ALT', sim, game.nav)],
      ['UP', () => this.nudgeAutopilot(1)],
      ['DN', () => this.nudgeAutopilot(-1)]
    ]
    apButtons.forEach(([label, act], i) => {
      const x = STACK - 0.066 + i * 0.022
      ap(label, x, act)
      labels.push({ text: label, x, y: -0.299 })
    })

    // Lower left: key, master, avionics, then the fuel pump and light switches
    all.push(
      new Key(g, buzz, new Vector3(-0.215, -0.405, PANEL_Z), {
        get: () => procedures.magnetos,
        set: position => {
          procedures.magnetos = position
          c.engineSwitches[0] = position !== 'off'
        }
      })
    )
    labels.push({ text: 'MAGNETOS', x: -0.215, y: -0.378 })
    const rocker = (
      label: string,
      x: number,
      get: () => boolean,
      set: (on: boolean) => void,
      color?: number
    ) => {
      all.push(new Rocker(g, buzz, label, new Vector3(x, -0.43, PANEL_Z), { get, set, color }))
      labels.push({ text: label, x, y: -0.405 })
    }
    // The split master: the alternator half cannot be on without the battery half
    rocker(
      'ALT',
      -0.172,
      () => procedures.alternator,
      on => {
        procedures.alternator = on
        if (on) c.battery = true
      },
      0xa01818
    )
    rocker(
      'BAT',
      -0.146,
      () => c.battery,
      on => {
        c.battery = on
        if (!on) procedures.alternator = false
      },
      0xa01818
    )
    rocker(
      'AVIONICS',
      -0.11,
      () => procedures.avionics,
      on => {
        procedures.avionics = on
      }
    )
    const switches: [string, () => boolean, (on: boolean) => void][] = [
      ['FUEL PUMP', () => procedures.auxPump, on => (procedures.auxPump = on)],
      ['BCN', () => this.lights.beacon, on => (this.lights.beacon = on)],
      ['LAND', () => pilot.landingLights, on => (pilot.landingLights = on)],
      ['TAXI', () => this.lights.taxi, on => (this.lights.taxi = on)],
      ['NAV', () => this.lights.nav, on => (this.lights.nav = on)],
      ['STROBE', () => this.lights.strobe, on => (this.lights.strobe = on)]
    ]
    switches.forEach(([label, get, set], i) => {
      rocker(label, -0.065 + i * 0.03, get, set)
    })

    // Parking brake: pull the handle under the panel. Pulled all the way it locks; partway,
    // it works the brakes for as long as it is held, as bare hands have no toe brakes.
    this.brake = new Lever(
      g,
      buzz,
      'PARKING BRAKE',
      new Vector3(-0.15, -0.49, PANEL_Z + 0.01),
      new Vector3(-0.15, -0.49, PANEL_Z + 0.08),
      new Vector3(-0.15, -0.49, PANEL_Z - 0.05),
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
    all.push(this.brake)

    // Throttle and mixture: push in for more
    const pushPull = (
      label: string,
      x: number,
      color: number,
      get: () => number,
      set: (value: number, released: boolean) => void,
      state: () => string
    ) =>
      new Lever(
        g,
        buzz,
        label,
        new Vector3(x, -0.43, PANEL_Z + 0.1),
        new Vector3(x, -0.43, PANEL_Z + 0.015),
        new Vector3(x, -0.43, PANEL_Z - 0.05),
        { get, set, knob: { color, shape: 'pull' }, state }
      )
    this.throttle = pushPull(
      'THROTTLE',
      C - 0.05,
      0x111111,
      () => c.throttle,
      (value, released) => {
        if (released) c.throttle = value
      },
      () => `${Math.round(sim.rpm / 10) * 10} RPM`
    )
    all.push(this.throttle)
    all.push(
      pushPull(
        'MIXTURE',
        C + 0.05,
        0xb01c1c,
        () => procedures.mixture,
        value => {
          procedures.mixture = value
        },
        () =>
          procedures.mixture < MIXTURE_CUTOFF
            ? 'IDLE CUTOFF'
            : procedures.mixture > 0.95
              ? 'RICH'
              : 'LEANED'
      )
    )
    labels.push({ text: 'THROTTLE', x: C - 0.05, y: -0.455 })
    labels.push({ text: 'MIXTURE', x: C + 0.05, y: -0.455 })

    // Flap selector, with the flap position gauge beside it
    const notches = spec.flapLabels.length - 1
    all.push(
      new Lever(
        g,
        buzz,
        'FLAPS',
        new Vector3(0.44, -0.37, PANEL_Z + 0.03),
        new Vector3(0.44, -0.46, PANEL_Z + 0.03),
        new Vector3(0.44, -0.415, PANEL_Z - 0.03),
        {
          get: () => c.flapNotch / notches,
          set: value => {
            // Electric flaps: the motor needs the master on
            if (game.getState().status === 'flying' && sim.powered) {
              c.flapNotch = Math.round(value * notches)
            }
          },
          detents: spec.flapLabels.map((_, i) => i / notches),
          knob: { color: 0xe8e8e8, shape: 'box' },
          state: () => spec.flapLabels[c.flapNotch]
        }
      )
    )
    labels.push({ text: 'FLAPS', x: 0.44, y: -0.355 })
    this.flapPointer = new Mesh(
      new BoxGeometry(0.012, 0.003, 0.002),
      new MeshBasicMaterial({ color: 0xffffff })
    )
    g.add(this.flapPointer)

    // Pedestal: trim wheel and fuel shutoff valve, with the fuel selector on the floor
    all.push(
      new TrimWheel(g, buzz, new Vector3(C, -0.6, -0.47), 0.07, {
        get: () => c.trim,
        set: trim => {
          c.trim = trim
        }
      })
    )
    this.trimPointer = new Mesh(
      new BoxGeometry(0.01, 0.004, 0.002),
      new MeshBasicMaterial({ color: 0xffffff })
    )
    g.add(this.trimPointer)
    all.push(
      new Lever(
        g,
        buzz,
        'FUEL SHUTOFF',
        new Vector3(C, -0.84, -0.49),
        new Vector3(C, -0.84, -0.43),
        new Vector3(C, -0.84, -0.54),
        {
          get: () => (this.shutoff ? 1 : 0),
          set: (value, released) => {
            if (released) this.shutoff = value > 0.5
          },
          detents: [0, 1],
          knob: { color: 0xb01c1c, shape: 'pull' },
          state: () => (this.shutoff ? 'OFF (pulled)' : 'ON (in)')
        }
      )
    )
    const positions = ['left', 'both', 'right'] as const
    all.push(
      new Knob(g, buzz, 'FUEL SELECTOR', new Vector3(C, FLOOR + 0.06, -0.38), {
        axis: 'y',
        step: 0.6,
        radius: 0.024,
        color: 0x2a2a2a,
        turn: clicks => {
          const index = Math.max(0, Math.min(2, positions.indexOf(this.selector) + clicks))
          this.selector = positions[index]
        },
        pointer: () => (positions.indexOf(this.selector) - 1) * 60 * DEG,
        state: () => this.selector.toUpperCase()
      })
    )

    // Heading indicator knobs: push the left one to set it to the compass, turn the right
    // one to move the heading bug
    all.push(
      new Knob(g, buzz, 'HEADING SET', new Vector3(x2 - 0.035, y2 - 0.036, PANEL_Z), {
        axis: 'z',
        step: 10 * DEG,
        turn: clicks => {
          s.drift -= clicks
        },
        press: () => {
          s.drift = 0
        },
        state: () => 'push to set to the compass'
      }),
      new Knob(g, buzz, 'HEADING BUG', new Vector3(x2 + 0.035, y2 - 0.036, PANEL_Z), {
        axis: 'z',
        step: 8 * DEG,
        color: 0x3a1a0a,
        turn: clicks => pilot.adjust('heading', clicks * 2),
        state: () =>
          `${Math.round((((pilot.autopilot.heading / DEG + s.drift * s.gyro) % 360) + 360) % 360)}°`
      })
    )

    // Both yokes, on the same cables
    this.yoke = new Yoke(g, buzz, new Vector3(0, -0.32, -0.47), new Vector3(2 * C, -0.32, -0.47))
    all.push(this.yoke)

    this.controls = new ControlSet(all, g)
    this.buildPlacards(labels)
    this.checklists = this.buildChecklists(procedures)
  }

  get flyingHand() {
    const holder = this.yoke.holders.keys().next()
    return holder.done ? null : holder.value
  }
  get flightHeld() {
    return this.yoke.held
  }
  get throttleHeld() {
    return this.throttle.held
  }

  /** The autopilot's UP and DN: climb rate in vertical speed mode, else the held altitude. */
  private nudgeAutopilot(direction: number) {
    const { pilot } = game
    if (pilot.autopilot.vertical === 'VS') pilot.adjust('verticalSpeed', direction)
    else {
      pilot.autopilot.hold += (direction * 20) / FEET_PER_METRE
      pilot.adjust('altitude', direction)
    }
  }

  update(dt: number, interactors: Interactor[], time: number) {
    const { pilot, sim } = game
    const c = pilot.controls
    const procedures = c.procedures
    if (!procedures) return
    this.controls.update(dt, interactors, time)
    this.systems.update(dt)

    // The fuel valve and selector together feed the engine. A new flight resets them.
    if (procedures.fuelSelector !== this.written) {
      this.shutoff = procedures.fuelSelector === 'off'
      if (!this.shutoff) this.selector = procedures.fuelSelector as 'left' | 'both' | 'right'
    }
    this.written = this.shutoff ? 'off' : this.selector
    procedures.fuelSelector = this.written
    c.engineSwitches[0] = procedures.magnetos !== 'off'
    // The plain fuel feed follows the valve, so the engine keeps running if VR ends
    c.fuelPumps = this.written !== 'off'

    const { analog } = pilot
    if (this.yoke.held || Math.abs(this.yoke.pitch) + Math.abs(this.yoke.roll) > 0.002) {
      analog.stick = this.yoke.output
    }
    if (this.throttle.held) analog.throttle = this.throttle.value
    if (this.brake.held) analog.brake = Math.max(analog.brake, this.brake.value)

    for (const instrument of this.instruments) instrument.update(dt)
    this.updateEngine(dt)
    if (game.flight !== this.flight) {
      // A new flight starts the run-up afresh
      this.flight = game.flight
      this.runUp.left = false
      this.runUp.right = false
      this.runUp.travel.clear()
    }
    this.trackRunUp()
    const flaps = 0.37 + sim.flapPosition * 0.09
    this.flapPointer.position.set(0.47, -flaps, PANEL_Z + 0.004)
    this.trimPointer.position.set(C + 0.045, -0.58 + c.trim * 0.04, -0.499)
    // The rudder pedals follow the rudder
    for (const [i, pedal] of this.pedals.entries())
      pedal.position.z = -0.78 + (i % 2 === 0 ? 1 : -1) * c.yaw * 0.04

    this.displayClock += dt
    if (this.displayClock > 0.25) {
      this.displayClock = 0
      this.drawAvionics(procedures)
    }
  }

  /** The propeller: blades you can see turning on the starter, a blur once it runs. */
  private updateEngine(dt: number) {
    const rpm = game.sim.rpm
    this.blades.rotation.z -= (rpm / 60) * Math.PI * 2 * dt
    const blur = rpm > 500
    this.blades.visible = !blur
    this.disc.visible = blur
  }

  /** Watches for the run-up's magneto check and the full and free flight controls. */
  private trackRunUp() {
    const { sim } = game
    const procedures = game.pilot.controls.procedures
    if (!procedures) return
    if (sim.rpm > 1500 && procedures.magnetos === 'left') this.runUp.left = true
    if (sim.rpm > 1500 && procedures.magnetos === 'right') this.runUp.right = true
    const { roll, pitch } = this.yoke
    if (roll > 0.8) this.runUp.travel.add('right')
    if (roll < -0.8) this.runUp.travel.add('left')
    if (pitch > 0.8) this.runUp.travel.add('back')
    if (pitch < -0.8) this.runUp.travel.add('forward')
  }

  /** The GPS, autopilot, and annunciator screens, redrawn only when what they show changes. */
  private drawAvionics(procedures: Procedures) {
    const { sim, pilot, nav } = game
    const on = sim.powered && procedures.avionics
    for (const radio of this.radios) radio.color.setHex(on ? 0xffffff : 0x0a0a0a)
    const ground = Math.round(sim.groundSpeed * KNOTS_PER_MS)
    const target = nav.approach
    const distance = target ? Math.max(0, nav.guidance.along) / 1852 : 0
    const gps = on
      ? `${target?.id ?? ''}|${distance.toFixed(1)}|${ground}|${Math.round(sim.heading / DEG)}`
      : 'off'
    if (gps !== this.shown.gps) {
      this.shown.gps = gps
      this.gps.draw((ctx, w, h) => {
        ctx.fillStyle = on ? '#06120a' : '#050505'
        ctx.fillRect(0, 0, w, h)
        if (!on) return
        // Radios across the top, the waypoint large in magenta, then speed and track
        ctx.textBaseline = 'middle'
        ctx.font = `700 ${h * 0.17}px system-ui, sans-serif`
        ctx.fillStyle = '#7dff9a'
        ctx.fillText('COM 122.800   NAV 110.30', w * 0.04, h * 0.15)
        ctx.font = `700 ${h * 0.26}px system-ui, sans-serif`
        ctx.fillStyle = '#e06bf0'
        ctx.fillText(target ? target.id : 'NO WPT', w * 0.04, h * 0.45)
        ctx.fillStyle = '#ffffff'
        ctx.font = `700 ${h * 0.19}px system-ui, sans-serif`
        const track = String(Math.round(sim.heading / DEG) % 360).padStart(3, '0')
        const dis = target ? `${distance.toFixed(1)} NM` : '--- NM'
        ctx.fillText(`DIS ${dis}   GS ${ground} KT   TRK ${track}°`, w * 0.04, h * 0.8, w * 0.92)
      })
    }
    const { autopilot } = pilot
    const vs = Math.round((autopilot.verticalSpeed * FPM_PER_MS) / 100) * 100
    const ap = on
      ? autopilot.on
        ? `${autopilot.lateral === 'APP' ? 'APR' : autopilot.lateral}|${autopilot.vertical === 'VS' ? `VS ${vs}` : autopilot.vertical === 'APP' ? 'GS' : 'ALT'}`
        : 'ready'
      : 'off'
    if (ap !== this.shown.autopilot) {
      this.shown.autopilot = ap
      this.autopilot.draw((ctx, w, h) => {
        ctx.fillStyle = '#050505'
        ctx.fillRect(0, 0, w, h)
        if (!on) return
        ctx.fillStyle = '#ffb21a'
        ctx.font = `700 ${h * 0.5}px system-ui, sans-serif`
        ctx.textBaseline = 'middle'
        if (ap === 'ready') {
          ctx.fillText('KAP 140', w * 0.05, h * 0.5)
          return
        }
        const [lateral, vertical] = ap.split('|')
        ctx.fillText(`AP  ${lateral}`, w * 0.05, h * 0.5)
        ctx.fillText(vertical, w * 0.55, h * 0.5)
      })
    }
    const s = this.systems
    const lowFuel = sim.fuel * GALLONS_PER_KG < 16
    const lamps = [
      { text: 'OIL PRESS', on: s.oilPressure < 20 },
      { text: 'LOW VAC', on: s.vacuum < 3 },
      { text: 'VOLTS', on: s.amps < 0 },
      { text: 'L LOW FUEL R', on: lowFuel }
    ]
    const annunciator = sim.powered ? lamps.map(lamp => (lamp.on ? '1' : '0')).join('') : 'off'
    if (annunciator !== this.shown.annunciator) {
      this.shown.annunciator = annunciator
      this.annunciator.draw((ctx, w, h) => {
        ctx.fillStyle = '#0b0b0b'
        ctx.fillRect(0, 0, w, h)
        lamps.forEach((lamp, i) => {
          const lit = sim.powered && lamp.on
          ctx.fillStyle = lit ? (i === 3 ? '#e8a020' : '#d0281c') : '#1c1c1c'
          ctx.fillRect((w / 4) * i + 2, 2, w / 4 - 4, h - 4)
          ctx.fillStyle = lit ? '#fff' : '#4a4a4a'
          ctx.font = `700 ${h * 0.45}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(lamp.text, (w / 4) * (i + 0.5), h / 2)
        })
      })
    }
  }

  /** A fixed panel face with one line of text, such as a radio's frequencies. */
  private staticFace(
    x: number,
    y: number,
    width: number,
    height: number,
    text: string,
    color: string,
    background: string
  ) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = Math.round((512 * height) / width)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The browser gave no 2D canvas, so the radio faces cannot draw')
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = color
    ctx.font = `700 ${canvas.height * 0.5}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width * 0.94)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    this.textures.push(texture)
    const material = new MeshBasicMaterial({ map: texture, toneMapped: false })
    const face = new Mesh(new PlaneGeometry(width, height), material)
    face.position.set(x, y, PANEL_Z + 0.003)
    this.group.add(face)
    return material
  }

  /** Switch and knob names printed on the panel, in one transparent texture. */
  private buildPlacards(labels: { text: string; x: number; y: number }[]) {
    const width = RIGHT_WALL - LEFT_WALL
    const height = PANEL_TOP - PANEL_BOTTOM
    const scale = 2000
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#e6e6e0'
    ctx.font = `700 ${0.0075 * scale}px Arial Narrow, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const label of labels) {
      ctx.fillText(
        label.text,
        (label.x - LEFT_WALL) * scale,
        (PANEL_TOP - label.y) * scale,
        0.05 * scale
      )
    }
    ctx.font = `700 ${0.009 * scale}px Arial Narrow, system-ui, sans-serif`
    ctx.fillText('UP', (0.475 - LEFT_WALL) * scale, (PANEL_TOP + 0.37) * scale)
    ctx.fillText('FULL', (0.48 - LEFT_WALL) * scale, (PANEL_TOP + 0.462) * scale)
    ctx.fillText('CESSNA', (0.6 - LEFT_WALL) * scale, (PANEL_TOP + 0.15) * scale)
    ctx.fillText('SKYHAWK SP', (0.6 - LEFT_WALL) * scale, (PANEL_TOP + 0.165) * scale)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    texture.anisotropy = 4
    this.textures.push(texture)
    const placards = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false })
    )
    placards.position.set(
      (LEFT_WALL + RIGHT_WALL) / 2,
      (PANEL_TOP + PANEL_BOTTOM) / 2,
      PANEL_Z + 0.001
    )
    this.group.add(placards)
  }

  /** Panel, glareshield, pedestal, floor, seats, walls, window frames, roof, and pedals. */
  private buildCabin() {
    const g = this.group
    const box = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      material: Material
    ) => {
      const mesh = new Mesh(new BoxGeometry(w, h, d), material)
      mesh.position.set(x, y, z)
      g.add(mesh)
      return mesh
    }
    const width = RIGHT_WALL - LEFT_WALL
    const middle = (LEFT_WALL + RIGHT_WALL) / 2
    box(
      width,
      PANEL_TOP - PANEL_BOTTOM,
      0.2,
      middle,
      (PANEL_TOP + PANEL_BOTTOM) / 2,
      PANEL_Z - 0.101,
      PANEL
    )
    box(width + 0.02, 0.03, 0.26, middle, PANEL_TOP + 0.012, PANEL_Z - 0.08, GLARESHIELD)
    // Footwell under the panel, and the pedestal between the seats
    box(width, PANEL_BOTTOM - FLOOR, 0.04, middle, (PANEL_BOTTOM + FLOOR) / 2, -0.82, PANEL)
    box(0.07, PANEL_BOTTOM - FLOOR, 0.22, C, (PANEL_BOTTOM + FLOOR) / 2, -0.61, PANEL)
    box(width, 0.04, 2.6, middle, FLOOR, 0.3, CARPET)
    // Walls up to the window sill, with the door's armrest
    for (const x of [LEFT_WALL, RIGHT_WALL]) {
      box(0.04, SILL - FLOOR, 2.6, x, (SILL + FLOOR) / 2, 0.3, TRIM)
      box(0.06, 0.04, 0.4, x + (x < 0 ? 0.04 : -0.04), -0.45, -0.05, TRIM)
    }
    // Windscreen posts, the header over the windscreen, door posts, and the roof
    const post = (x: number) => {
      const mesh = box(0.05, 0.36, 0.05, x, 0.06, -0.62, FRAME)
      mesh.rotation.x = 0.75
    }
    post(LEFT_WALL + 0.02)
    post(RIGHT_WALL - 0.02)
    box(width, 0.05, 0.06, middle, ROOF - 0.01, -0.46, FRAME)
    for (const x of [LEFT_WALL + 0.02, RIGHT_WALL - 0.02])
      box(0.05, ROOF - SILL, 0.06, x, (ROOF + SILL) / 2, 0.38, FRAME)
    box(width, 0.03, 1.9, middle, ROOF + 0.01, 0.5, HEADLINER)
    // Seats, front and back, and the wall behind the baggage area
    for (const x of [0, 2 * C]) {
      box(0.44, 0.1, 0.46, x, -0.8, 0.08, SEAT)
      const back = box(0.44, 0.62, 0.09, x, -0.45, 0.34, SEAT)
      back.rotation.x = -0.18
    }
    box(width - 0.04, 0.1, 0.44, middle, -0.8, 0.95, SEAT)
    box(width - 0.04, 0.55, 0.09, middle, -0.5, 1.2, SEAT)
    box(width, ROOF - FLOOR, 0.04, middle, (ROOF + FLOOR) / 2, 1.5, TRIM)
    // Right side of the panel: the glovebox and a row of circuit breakers
    box(0.2, 0.09, 0.004, 0.64, -0.43, PANEL_Z + 0.002, TRIM)
    for (let i = 0; i < 9; i++) {
      const breaker = new Mesh(
        new CylinderGeometry(0.004, 0.004, 0.01, 8).rotateX(Math.PI / 2),
        DARK
      )
      breaker.position.set(0.54 + i * 0.024, -0.36, PANEL_Z + 0.005)
      g.add(breaker)
    }
    this.selectorPlacard()
    // Rudder pedals for both seats, which move with the rudder
    for (const x of [0, 2 * C]) {
      for (const side of [-1, 1]) {
        const pedal = new Group()
        const plate = new Mesh(new BoxGeometry(0.07, 0.14, 0.02), DARK)
        plate.rotation.x = -0.6
        pedal.add(plate)
        pedal.position.set(x + side * 0.09, -0.9, -0.78)
        g.add(pedal)
        this.pedals.push(pedal)
      }
    }
  }

  /** The plate under the fuel selector, marked with its positions. */
  private selectorPlacard() {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#1d1e20'
    ctx.beginPath()
    ctx.arc(128, 128, 126, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f2f2ee'
    ctx.font = '700 30px Arial Narrow, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Seen from above with the nose up the page: left, ahead, and right
    ctx.fillText('LEFT', 128 - 80, 92)
    ctx.fillText('BOTH', 128, 30)
    ctx.fillText('RIGHT', 128 + 80, 92)
    ctx.font = '700 18px Arial Narrow, system-ui, sans-serif'
    ctx.fillText('FUEL', 128, 200)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    this.textures.push(texture)
    const plate = new Mesh(new CircleGeometry(0.06, 32), new MeshBasicMaterial({ map: texture }))
    plate.rotation.x = -Math.PI / 2
    plate.position.set(C, FLOOR + 0.022, -0.38)
    this.group.add(plate)
  }

  /** The cowling ahead of the windscreen, and the propeller with its spinner. */
  private buildEngine() {
    const cowl = new Mesh(
      new CylinderGeometry(0.3, 0.44, 1.1, 20, 1, false).rotateX(-Math.PI / 2),
      PAINT
    )
    cowl.position.set(C, -0.58, -1.38)
    cowl.scale.set(1, 0.92, 1)
    const spinner = new Mesh(new ConeGeometry(0.12, 0.3, 16).rotateX(-Math.PI / 2), PAINT)
    spinner.position.set(0, 0, -0.12)
    for (const side of [-1, 1]) {
      const blade = new Mesh(new BoxGeometry(0.09, 0.9, 0.02), BLADE)
      blade.position.y = side * 0.48
      blade.rotation.y = side * 0.3
      this.blades.add(blade)
    }
    this.propeller.add(spinner, this.blades, this.disc)
    this.propeller.position.set(C, -0.56, -1.98)
    // A stopped propeller rests at an angle, not standing up like a windscreen post
    this.blades.rotation.z = 0.6
    this.group.add(cowl, this.propeller)
  }

  /** The 172S's normal checklists, abbreviated, ticking as the pilot does each step. */
  private buildChecklists(procedures: Procedures): Checklist[] {
    const { pilot, sim } = game
    const c = pilot.controls
    const s = this.systems
    const near = (value: number, from: number, to: number) => value >= from && value <= to
    const step = (text: string, done: () => boolean) => ({ text, done })
    return [
      {
        title: 'Before Starting Engine',
        items: [
          step('Parking brake: SET', () => c.parkingBrake),
          step('Fuel shutoff valve: ON, pushed in', () => !this.shutoff),
          step('Fuel selector: BOTH', () => this.selector === 'both'),
          step('Avionics master: OFF', () => !procedures.avionics),
          step('Master switch BAT: ON', () => c.battery)
        ]
      },
      {
        title: 'Starting Engine',
        items: [
          step('Throttle: open about 1/4 inch', () => near(c.throttle, 0.03, 0.25)),
          step('Mixture: IDLE CUTOFF', () => procedures.mixture < MIXTURE_CUTOFF),
          step('Fuel pump: ON', () => procedures.auxPump),
          step(
            'Mixture: RICH for 3 to 5 seconds to prime, then IDLE CUTOFF',
            () => sim.prime > 1.5 && procedures.mixture < MIXTURE_CUTOFF
          ),
          step('Fuel pump: OFF', () => !procedures.auxPump),
          step('Propeller area: CLEAR', () => true),
          step('Magnetos: START, let go when the engine fires', () => sim.enginesRunning > 0),
          step(
            'Mixture: push to RICH as it fires',
            () => sim.enginesRunning > 0 && procedures.mixture > 0.9
          ),
          step('Oil pressure: in the green within 30 seconds', () => s.oilPressure > 25),
          step('Master switch ALT: ON', () => procedures.alternator),
          step('Avionics master: ON', () => procedures.avionics)
        ]
      },
      {
        title: 'Before Takeoff',
        items: [
          step('Parking brake: SET', () => c.parkingBrake),
          step(
            'Flight controls: FREE and CORRECT, full travel each way',
            () => this.runUp.travel.size === 4
          ),
          step('Fuel selector: BOTH', () => this.selector === 'both'),
          step('Mixture: RICH', () => procedures.mixture > 0.9),
          step('Heading indicator: SET to the compass', () => Math.abs(s.drift) < 3),
          step('Throttle: 1,800 RPM', () => near(sim.rpm, 1700, 1900)),
          step(
            'Magnetos: check L, then R, then BOTH',
            () => this.runUp.left && this.runUp.right && procedures.magnetos === 'both'
          ),
          step('Throttle: IDLE', () => sim.rpm < 1000),
          step('Flaps: UP to 10°', () => c.flapNotch <= 1),
          step('Trim: TAKEOFF, near neutral', () => Math.abs(c.trim) < 0.25),
          step('Landing light: ON', () => pilot.landingLights),
          step('Parking brake: RELEASE', () => !c.parkingBrake)
        ]
      },
      {
        title: 'Takeoff',
        items: [
          step('Flaps: UP to 10°', () => c.flapNotch <= 1),
          step('Throttle: FULL, pushed in', () => c.throttle > 0.97),
          step('Mixture: RICH', () => procedures.mixture > 0.9),
          step('Elevator: lift the nose at 55 knots', () => !sim.onGround),
          step(
            'Climb speed: 70 to 80 knots',
            () => near(sim.indicatedAirspeed * KNOTS_PER_MS, 70, 80) && sim.altitudeAgl > 30
          ),
          step('Flaps: UP above 300 feet', () => c.flapNotch === 0 && sim.altitudeAgl > 90)
        ]
      },
      {
        title: 'Before Landing',
        items: [
          step('Fuel selector: BOTH', () => this.selector === 'both'),
          step('Mixture: RICH', () => procedures.mixture > 0.9),
          step('Landing light: ON', () => pilot.landingLights),
          step('Flaps: as needed, 10° below 110 kt, more below 85 kt', () => c.flapNotch > 0),
          step('Approach speed: 65 to 75 knots', () =>
            near(sim.indicatedAirspeed * KNOTS_PER_MS, 65, 75)
          ),
          step('Touchdown: main wheels first, then lower the nose', () => sim.onGround)
        ]
      },
      {
        title: 'Shutdown',
        items: [
          step('Parking brake: SET', () => c.parkingBrake),
          step('Throttle: IDLE', () => c.throttle < 0.05),
          step('Avionics master: OFF', () => !procedures.avionics),
          step('Mixture: IDLE CUTOFF, the engine stops', () => sim.enginesRunning === 0),
          step('Magnetos: OFF', () => procedures.magnetos === 'off'),
          step('Master switch: OFF', () => !c.battery),
          step('Fuel selector: LEFT or RIGHT', () => this.selector !== 'both')
        ]
      }
    ]
  }

  dispose() {
    this.controls.releaseAll()
    for (const instrument of this.instruments) instrument.dispose()
    for (const texture of this.textures) texture.dispose()
    this.gps.dispose()
    this.autopilot.dispose()
    this.annunciator.dispose()
    const kept = new Set<Material>([...SHARED_MATERIALS, ...OWN])
    this.group.traverse(object => {
      if (!(object instanceof Mesh)) return
      object.geometry.dispose()
      const material = object.material as Material
      if (!kept.has(material)) {
        ;(material as MeshBasicMaterial).map?.dispose()
        material.dispose()
      }
    })
    this.group.removeFromParent()
    // Back to the one-button start for the other aircraft and the desktop
    delete game.pilot.controls.procedures
  }
}
