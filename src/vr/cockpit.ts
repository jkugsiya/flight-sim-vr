import {
  BoxGeometry,
  CanvasTexture,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3
} from 'three'
import { game } from '../game/game'
import { WARNINGS } from '../game/gpws'
import type { AircraftSpec } from '../sim/aircraft'
import { LAMPS } from '../ui/lamps'
import {
  Button,
  type Buzz,
  type Control,
  ControlSet,
  Lever,
  SHARED_MATERIALS,
  Stick,
  Yoke
} from './controls'
import { drawFlightDisplay, Screen, systemsDisplay } from './displays'
import type { Interactor } from './input'

/** The panel face, facing the pilot, in metres ahead of the eye. */
const PANEL_Z = -0.7
const PANEL_LEFT = -0.56
const PANEL_RIGHT = 0.6
const PANEL_TOP = -0.1
const PANEL_BOTTOM = -0.52
// Top of the side consoles the levers stand in
const CONSOLE_Y = -0.47
// Hand travel in metres for full stick deflection
const STICK_TRAVEL = 0.07
// Panel face pixels per metre, enough for the button labels to read at arm's length
const FACE_RESOLUTION = 1800
// Size of each glass screen, and how far either side of centre it sits
const SCREEN = 0.24
const SCREEN_X = 0.13
// Seconds between redraws of each screen
const FLIGHT_DISPLAY_GAP = 1 / 24
const SYSTEMS_GAP = 1 / 6

type Layout = {
  flight: { kind: 'yoke' } | { kind: 'stick'; x: number; side: boolean }
  /** -1 puts the throttle, flaps, and speed brake on the left console, 1 on the right. */
  levers: -1 | 1
  frame: 'airliner' | 'canopy' | 'cabin'
}

/** Each aircraft's controls where its pilot finds them, or near enough. */
function layoutFor(spec: AircraftSpec): Layout {
  const sidestickLeft = ['a320', 'a380']
  const sidestickRight = ['f16', 'f35']
  const yoke = ['c172', 'b737', 'b787', 'concorde']
  const frame =
    spec.shape.type === 'fighter' || spec.id === 'p51'
      ? 'canopy'
      : spec.shape.type === 'propeller'
        ? 'cabin'
        : 'airliner'
  if (sidestickLeft.includes(spec.id))
    return { flight: { kind: 'stick', x: -0.27, side: true }, levers: 1, frame }
  if (sidestickRight.includes(spec.id))
    return { flight: { kind: 'stick', x: 0.27, side: true }, levers: -1, frame }
  if (yoke.includes(spec.id) || spec.shape.type === 'airliner')
    return { flight: { kind: 'yoke' }, levers: 1, frame }
  return { flight: { kind: 'stick', x: 0, side: false }, levers: -1, frame }
}

const STRUCTURE = new MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.85, emissive: 0x0c0d0e })
const DARK = new MeshStandardMaterial({ color: 0x15181b, roughness: 0.9, emissive: 0x060707 })
const MASTER_OFF = 0x3a0d0b
const MASTER_ON = 0xff2a1a

/** Taps a keyboard key on the pilot, so a panel button does exactly what the key does. */
function key(code: string) {
  const { pilot, sim, nav } = game
  if (game.getState().status !== 'flying') return
  pilot.press(code, false, sim, nav)
  pilot.release(code)
}

const flying = (act: () => void) => () => {
  if (game.getState().status === 'flying') act()
}

/**
 * The cockpit around the pilot in VR, life size: panel, screens, buttons, levers, and the
 * stick or yoke. Built for one aircraft; the seat rebuilds it when the aircraft changes.
 */
export class Cockpit {
  readonly group = new Group()
  readonly controls: ControlSet
  private readonly flightControl: Stick | Yoke
  private readonly throttle: Lever
  private readonly brake: Lever
  private readonly screens: Screen[]
  private readonly master: MeshBasicMaterial
  private readonly faceTexture: CanvasTexture
  private flightClock = 0
  private systemsClock = 0
  private trimHeld = 0

  constructor(
    readonly spec: AircraftSpec,
    buzz: Buzz
  ) {
    const layout = layoutFor(spec)
    const g = this.group
    const labels: { text: string; x: number; y: number }[] = []
    this.buildShell(layout)

    // Screens
    const flightDisplay = new Screen(
      512,
      SCREEN,
      new Vector3(-SCREEN_X, -0.27, PANEL_Z + 0.003),
      drawFlightDisplay
    )
    const systems = new Screen(
      512,
      SCREEN,
      new Vector3(SCREEN_X, -0.27, PANEL_Z + 0.003),
      systemsDisplay(spec)
    )
    this.screens = [flightDisplay, systems]
    g.add(flightDisplay.mesh, systems.mesh)

    // Master warning on the glareshield
    this.master = new MeshBasicMaterial({ color: MASTER_OFF, toneMapped: false })
    const master = new Mesh(new BoxGeometry(0.06, 0.022, 0.006), this.master)
    master.position.set(0, PANEL_TOP - 0.016, PANEL_Z + 0.055)
    g.add(master)

    // Buttons: systems on the left of the screens, flight on the right
    const { pilot, nav } = game
    const c = pilot.controls
    const all: Control[] = []
    const button = (
      label: string,
      x: number,
      y: number,
      options: ConstructorParameters<typeof Button>[4]
    ) => {
      all.push(new Button(g, buzz, label, new Vector3(x, y, PANEL_Z), options))
      labels.push({ text: label, x, y: y + 0.026 })
    }
    const columns = { left: [-0.47, -0.39, -0.31], right: [0.29, 0.37, 0.45] }
    const rows = [-0.17, -0.235, -0.3, -0.365, -0.43]
    const onOff = (on: boolean): 'on' | 'off' => (on ? 'on' : 'off')
    const [l1, l2, l3] = columns.left
    const [r1, r2, r3] = columns.right
    button('BATTERY', l1, rows[0], {
      lit: () => onOff(c.battery),
      press: () => key('KeyO'),
      state: () => (c.battery ? 'ON' : 'OFF')
    })
    button('FUEL PUMPS', l2, rows[0], {
      lit: () => onOff(c.fuelPumps),
      press: () => key('KeyU'),
      state: () => (c.fuelPumps ? 'ON' : 'OFF')
    })
    button('ENGINES', l3, rows[0], {
      lit: () => {
        const sim = game.sim
        if (sim.engines.some(engine => engine.starting > 0)) return 'alert'
        return onOff(sim.enginesRunning === sim.engines.length && sim.engines.length > 0)
      },
      press: () => key('KeyI'),
      state: () => `${game.sim.enginesRunning} of ${game.sim.engines.length} running`
    })
    button('LIGHTS', l1, rows[1], {
      lit: () => onOff(pilot.landingLights),
      press: () => key('KeyL')
    })
    button('PARK BRAKE', l2, rows[1], {
      lit: () => (c.parkingBrake ? 'alert' : 'off'),
      press: () => key('KeyP'),
      state: () => (c.parkingBrake ? 'SET' : 'OFF')
    })
    button('REVERSE', l3, rows[1], {
      lit: () => (c.reverse ? 'alert' : 'off'),
      press: () => key('KeyR')
    })
    button('FIRE', l1, rows[2], {
      lit: () => (game.sim.engines.some(engine => engine.fire) ? 'alert' : 'off'),
      press: flying(() => {
        game.sim.engines.forEach((engine, i) => {
          if (engine.fire) game.sim.extinguish(i, c.engineSwitches[i])
        })
      }),
      state: () => 'discharges the bottle in each burning engine'
    })
    if (spec.fuelDump)
      button('FUEL DUMP', l2, rows[2], {
        lit: () => (c.fuelDump ? 'alert' : 'off'),
        press: () => key('Minus')
      })

    button('AP', r1, rows[0], {
      lit: () => onOff(pilot.autopilot.on),
      press: () => key('KeyZ'),
      state: () => 'holds heading and altitude'
    })
    button('A/T', r2, rows[0], {
      lit: () => onOff(pilot.autothrottle.on),
      press: () => key('KeyX'),
      state: () => 'holds the speed'
    })
    button('NAV', r3, rows[0], {
      lit: () => onOff(pilot.autopilot.on && pilot.autopilot.lateral === 'NAV'),
      press: () => key('KeyJ'),
      state: () => 'flies the flight plan'
    })
    button('APPROACH', r1, rows[1], {
      lit: () => onOff(nav.approach !== null),
      press: flying(game.cycleApproach),
      state: () => nav.approach?.id ?? 'none picked'
    })
    button('AUTOLAND', r2, rows[1], {
      lit: () => onOff(pilot.flyingApproach),
      press: flying(game.toggleApproachAutopilot),
      state: () => 'the autopilot flies the approach'
    })
    button('CLEAR APP', r3, rows[1], { press: flying(game.clearApproach) })
    button('TRIM UP', r1, rows[2], {
      hold: pressed => this.holdTrim(1, pressed),
      state: () => 'hold for nose up'
    })
    button('TRIM DOWN', r2, rows[2], {
      hold: pressed => this.holdTrim(-1, pressed),
      state: () => 'hold for nose down'
    })
    const weapons =
      spec.bombBay !== undefined || spec.shape.type === 'fighter' || spec.shape.type === 'bomber'
    if (weapons) {
      if (spec.shape.type === 'bomber') {
        button('BOMB SIGHT', r3, rows[2], {
          lit: () => onOff(game.getState().bombsight),
          press: flying(game.toggleBombsight)
        })
      }
      button('RELEASE', r3, rows[3], {
        lit: () => (game.bombs.missiles > 0 || game.bombs.loaded > 0 ? 'alert' : 'off'),
        // One bomb or missile per press. Holding the right trigger drops a string.
        press: () => {
          game.release()
          game.endRelease()
        }
      })
    }

    // Stick or yoke
    if (layout.flight.kind === 'yoke') {
      this.flightControl = new Yoke(g, buzz, new Vector3(0, -0.4, -0.46))
    } else {
      const { x, side } = layout.flight
      // A sidestick stands on its console; a centre stick rises from the floor
      const top = new Vector3(x, side ? -0.4 : -0.46, side ? -0.3 : -0.36)
      const pivot = top.clone().setY(side ? -0.52 : -0.85)
      this.flightControl = new Stick(g, buzz, pivot, top, STICK_TRAVEL)
    }
    all.push(this.flightControl)

    // Levers on the side console, inboard to outboard: speed brake, throttle, flaps
    const s = layout.levers
    const lever = (x: number, forward: number, back: number) => ({
      fore: new Vector3(x, CONSOLE_Y + 0.07, forward),
      aft: new Vector3(x, CONSOLE_Y + 0.035, back),
      pivot: new Vector3(x, CONSOLE_Y - 0.12, (forward + back) / 2)
    })
    const t = lever(s * 0.25, -0.42, -0.2)
    this.throttle = new Lever(g, buzz, 'THROTTLE', t.aft, t.fore, t.pivot, {
      get: () => c.throttle,
      // Letting go keeps where the lever was before the hand drifted off it
      set: (value, released) => {
        if (released) c.throttle = value
      },
      knob: { color: 0x1a1a1a, shape: 'box' },
      state: () => `${Math.round(c.throttle * 100)}%`
    })
    all.push(this.throttle)
    const sb = lever(s * 0.18, -0.38, -0.24)
    all.push(
      new Lever(g, buzz, 'SPEED BRAKE', sb.fore, sb.aft, sb.pivot, {
        get: () => (c.speedBrake ? 1 : 0),
        set: (value, released) => {
          if (released && value > 0.5 !== c.speedBrake) key('KeyB')
        },
        detents: [0, 1],
        knob: { color: 0x8a8f94, shape: 'box' },
        state: () => (c.speedBrake ? 'OPEN' : 'STOWED')
      })
    )
    const notches = spec.flapLabels.length - 1
    if (notches > 0 && !spec.autoFlaps) {
      const f = lever(s * 0.32, -0.38, -0.22)
      all.push(
        new Lever(g, buzz, spec.flapName.toUpperCase(), f.fore, f.aft, f.pivot, {
          get: () => c.flapNotch / notches,
          set: value => {
            if (game.getState().status === 'flying') c.flapNotch = Math.round(value * notches)
          },
          detents: spec.flapLabels.map((_, i) => i / notches),
          knob: { color: 0xd8dadc, shape: 'box' },
          state: () => spec.flapLabels[c.flapNotch]
        })
      )
    }
    // Wheel brakes on the left console, outboard: pull back to brake, it springs forward
    const b = lever(-0.4, -0.34, -0.22)
    this.brake = new Lever(g, buzz, 'BRAKE', b.fore, b.aft, b.pivot, {
      get: () => 0,
      set: () => {},
      spring: true,
      knob: { color: 0xa82a22, shape: 'ball' }
    })
    all.push(this.brake)

    // Gear lever on the panel, right of the buttons: up and down, with a wheel for a knob
    if (spec.retractableGear) {
      const x = 0.53
      labels.push({ text: 'GEAR', x, y: -0.165 })
      all.push(
        new Lever(
          g,
          buzz,
          'GEAR',
          new Vector3(x, -0.2, PANEL_Z + 0.07),
          new Vector3(x, -0.34, PANEL_Z + 0.07),
          new Vector3(x, -0.27, PANEL_Z),
          {
            get: () => (c.gearDown ? 1 : 0),
            set: (value, released) => {
              if (released && value > 0.5 !== c.gearDown) key('KeyG')
            },
            detents: [0, 1],
            knob: { color: 0xe6e6e6, shape: 'wheel' },
            state: () => {
              const position = game.sim.gearPosition
              return position >= 1 ? 'DOWN' : position <= 0 ? 'UP' : 'MOVING'
            }
          }
        )
      )
    }

    this.controls = new ControlSet(all, g)
    this.faceTexture = this.buildFace(labels)
  }

  /** The hand on the stick or yoke, if any. */
  get flyingHand() {
    const holder = this.flightControl.holders.keys().next()
    return holder.done ? null : holder.value
  }

  get flightHeld() {
    return this.flightControl.held
  }

  get throttleHeld() {
    return this.throttle.held
  }

  private holdTrim(direction: number, pressed: boolean) {
    if (pressed) this.trimHeld = direction
    else if (this.trimHeld === direction) this.trimHeld = 0
  }

  /** Runs the controls against the hands, and feeds the pilot's analog inputs. */
  update(dt: number, interactors: Interactor[], time: number) {
    this.controls.update(dt, interactors, time)
    const { analog } = game.pilot
    const flight = this.flightControl
    // A stick springing back still moves the surfaces, until it is centred
    if (flight.held || Math.abs(flight.pitch) + Math.abs(flight.roll) > 0.002) {
      analog.stick = { pitch: flight.pitch, roll: flight.roll }
    }
    if (this.throttle.held) analog.throttle = this.throttle.value
    analog.brake = Math.max(analog.brake, this.brake.value)
    if (this.trimHeld !== 0) analog.trim = this.trimHeld

    // Master warning flashes with any red lamp, the stall, or a ground proximity warning
    const { sim } = game
    const alert = game.gpws.alert
    const warning =
      sim.powered &&
      (LAMPS.some(lamp => lamp.kind === 'warning' && lamp.on(sim, game.pilot.controls)) ||
        (alert !== null && WARNINGS.has(alert)))
    this.master.color.setHex(warning && Math.floor(time * 3) % 2 === 0 ? MASTER_ON : MASTER_OFF)

    this.flightClock += dt
    this.systemsClock += dt
    if (this.flightClock >= FLIGHT_DISPLAY_GAP) {
      this.flightClock = 0
      this.screens[0].draw()
    }
    if (this.systemsClock >= SYSTEMS_GAP) {
      this.systemsClock = 0
      this.screens[1].draw()
    }
  }

  /** The tub around the pilot: panel, glareshield, consoles, floor, and window frames. */
  private buildShell(layout: Layout) {
    const g = this.group
    const box = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      material = STRUCTURE
    ) => {
      const mesh = new Mesh(new BoxGeometry(w, h, d), material)
      mesh.position.set(x, y, z)
      g.add(mesh)
      return mesh
    }
    const width = PANEL_RIGHT - PANEL_LEFT
    const centre = (PANEL_RIGHT + PANEL_LEFT) / 2
    // Panel body behind the face, and the glareshield over it
    box(
      width,
      PANEL_TOP - PANEL_BOTTOM,
      0.3,
      centre,
      (PANEL_TOP + PANEL_BOTTOM) / 2,
      PANEL_Z - 0.152,
      DARK
    )
    box(width + 0.04, 0.03, 0.26, centre, PANEL_TOP + 0.005, PANEL_Z - 0.08, DARK)
    // The footwell wall under the panel, down to the floor
    box(width, PANEL_BOTTOM + 1, 0.04, centre, (PANEL_BOTTOM - 1) / 2, PANEL_Z - 0.02, DARK)
    // Side consoles, the floor, and the walls up to the window sill
    box(0.32, 0.5, 0.6, -0.3, CONSOLE_Y - 0.25, -0.4)
    box(0.32, 0.5, 0.6, 0.3, CONSOLE_Y - 0.25, -0.4)
    box(1.4, 0.04, 1.6, 0, -1.0, -0.1)
    box(0.04, 0.72, 1.4, -0.66, -0.64, -0.1)
    box(0.04, 0.72, 1.4, 0.66, -0.64, -0.1)
    if (layout.frame === 'canopy') {
      // Canopy bow over the panel
      const bow = new Mesh(new TorusGeometry(0.58, 0.022, 8, 32, Math.PI), DARK)
      bow.position.set(0, PANEL_TOP + 0.02, PANEL_Z + 0.08)
      g.add(bow)
    } else {
      // Window posts, the roof, and a wall behind the seats
      const post = (x: number) => {
        const mesh = box(0.05, 0.5, 0.05, x, 0.12, PANEL_Z + 0.12)
        mesh.rotation.x = 0.45
      }
      post(-0.62)
      post(0.62)
      if (layout.frame === 'airliner') post(0.05)
      box(1.4, 0.04, 1.3, 0, 0.36, -0.1)
      box(1.4, 1.4, 0.04, 0, -0.3, 0.6)
    }
  }

  /** Labels and section marks printed on the panel face, drawn once. */
  private buildFace(labels: { text: string; x: number; y: number }[]) {
    const width = PANEL_RIGHT - PANEL_LEFT
    const height = PANEL_TOP - PANEL_BOTTOM
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * FACE_RESOLUTION)
    canvas.height = Math.round(height * FACE_RESOLUTION)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The browser gave no 2D canvas, so the panel labels cannot draw')
    const px = (x: number) => (x - PANEL_LEFT) * FACE_RESOLUTION
    const py = (y: number) => (PANEL_TOP - y) * FACE_RESOLUTION
    ctx.fillStyle = '#23282c'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // Screen bezels
    ctx.fillStyle = '#0d0f11'
    const bezel = SCREEN + 0.02
    for (const x of [-SCREEN_X, SCREEN_X]) {
      ctx.fillRect(
        px(x - bezel / 2),
        py(-0.27 + bezel / 2),
        bezel * FACE_RESOLUTION,
        bezel * FACE_RESOLUTION
      )
    }
    ctx.fillStyle = '#d9dde0'
    ctx.font = `700 ${0.0125 * FACE_RESOLUTION}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const label of labels)
      ctx.fillText(label.text, px(label.x), py(label.y), 0.075 * FACE_RESOLUTION)
    ctx.fillStyle = '#8a959e'
    ctx.font = `600 ${0.011 * FACE_RESOLUTION}px system-ui, sans-serif`
    ctx.fillText('SYSTEMS', px(-0.39), py(-0.125))
    ctx.fillText('AUTOFLIGHT', px(0.37), py(-0.125))
    ctx.fillText(this.spec.label.toUpperCase(), px(0), py(-0.5))
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    texture.anisotropy = 4
    const material = new MeshBasicMaterial({ map: texture })
    const face = new Mesh(new PlaneGeometry(width, height), material)
    face.position.set((PANEL_LEFT + PANEL_RIGHT) / 2, (PANEL_TOP + PANEL_BOTTOM) / 2, PANEL_Z)
    this.group.add(face)
    return texture
  }

  dispose() {
    this.controls.releaseAll()
    for (const screen of this.screens) screen.dispose()
    this.faceTexture.dispose()
    const kept = new Set<Material>([...SHARED_MATERIALS, STRUCTURE, DARK])
    this.group.traverse(object => {
      if (!(object instanceof Mesh)) return
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) {
        if (!kept.has(material)) {
          ;(material as MeshBasicMaterial).map?.dispose()
          material.dispose()
        }
      }
    })
    this.group.removeFromParent()
  }
}
