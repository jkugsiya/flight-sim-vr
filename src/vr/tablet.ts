import {
  BoxGeometry,
  CanvasTexture,
  type Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  Vector3
} from 'three'
import { landingAdvice } from '../game/coach'
import { canUse, game, type TimeOfDay, type Weather, type WindLevel } from '../game/game'
import { MISSIONS, type Mission, passedMissions } from '../game/missions'
import { HANGAR } from '../sim/aircraft'
import { CRASH_REASONS } from '../ui/Menu'
import { FPM_PER_MS } from '../ui/telemetry'
import { AIRPORTS } from '../world/island'
import type { Interactor } from './input'

const W = 600
const H = 820
// Size of the screen in metres
const WIDTH = 0.2
const HEIGHT = (WIDTH * H) / W
const PAPER = '#efe9d6'
const INK = '#1c2529'
const MUTED = '#5d676c'
const ACCENT = '#1f6f8b'
const GOOD = '#2f7d32'
const BAD = '#b3261e'
const FONT = 'system-ui, sans-serif'
const PER_PAGE = 7
// Seconds between redraws while nothing is tapped, for timers and live advice
const REFRESH = 0.25

const WEATHERS: Weather[] = ['clear', 'cloudy', 'rain', 'fog']
const TIMES: TimeOfDay[] = ['morning', 'noon', 'evening', 'night']
const WINDS: WindLevel[] = ['calm', 'light', 'strong']

/**
 * The keyboard keys mission steps and landing advice mention, and the cockpit control to
 * use instead in VR.
 */
const VR_KEYS: Record<string, string> = {
  '↓': 'pull back',
  '↑': 'push forward',
  '←': 'roll left',
  '→': 'roll right',
  W: 'throttle up',
  S: 'throttle back',
  Space: 'BRAKE lever',
  G: 'GEAR lever',
  A: 'left rudder',
  D: 'right rudder',
  I: 'ENGINES',
  i: 'ENGINES',
  '1': 'ENGINES',
  '2': 'ENGINES',
  P: 'PARK BRAKE',
  Shift: '',
  Enter: 'RELEASE',
  Tab: 'BOMB SIGHT',
  T: 'AUTOLAND',
  Z: 'AP',
  X: 'A/T',
  F: 'FLAPS lever',
  V: 'FLAPS lever',
  R: 'REVERSE',
  Q: 'TRIM DOWN',
  E: 'TRIM UP',
  J: 'NAV',
  B: 'SPEED BRAKE lever',
  U: 'FUEL PUMPS',
  O: 'BATTERY',
  N: 'APPROACH',
  L: 'LIGHTS'
}

/** Rewrites "Press [G]" as "Press GEAR lever", naming the cockpit control instead of the key. */
export function forVR(text: string) {
  return text
    .replace(/\[([^\]]+)\]/g, (_, key: string) => VR_KEYS[key] ?? key)
    .replace(/ \+ (?=\S)/g, ' ')
    .replace(/ {2,}/g, ' ')
}

type Rect = { x: number; y: number; w: number; h: number; act: () => void }
type Page = 'fly' | 'missions' | 'checklist' | 'help'

/**
 * A checklist whose items tick themselves off, in order, as the pilot does each one. An
 * item can only tick once the one before it has.
 */
export type Checklist = { title: string; items: { text: string; done: () => boolean }[] }

/** What the tablet needs from the VR cockpit around it. */
export type TabletActions = { recenter: () => void; exit: () => void }

/**
 * A touch screen beside the pilot, after SkyHands' kneeboard tablet: free flight setup,
 * missions, pause, results, and help. Tap it with a fingertip or a controller's tip.
 */
export class Tablet {
  readonly group = new Group()
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly texture: CanvasTexture
  private readonly cursor: Mesh
  private readonly inverse = new Matrix4()
  private readonly local = new Vector3()
  private buttons: Rect[] = []
  private page: Page = 'fly'
  /** In flight: the flight card, or the checklist. */
  private flightPage: 'flight' | 'checklist' = 'flight'
  private checklists: Checklist[] | null = null
  private checklist = 0
  /** How many items of each checklist are done. */
  private progress: number[] = []
  private flight = -1
  private missionPage = 0
  private briefing: Mission | null = null
  private sinceDraw = REFRESH
  private lastTap = 0
  private readonly depth = new Map<Interactor, number>()

  constructor(private readonly actions: TabletActions) {
    this.canvas.width = W
    this.canvas.height = H
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('The browser gave no 2D canvas, so the VR tablet cannot draw')
    this.ctx = ctx
    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = 8
    const frame = new Mesh(
      new BoxGeometry(WIDTH + 0.016, HEIGHT + 0.016, 0.008),
      new MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.8 })
    )
    frame.position.z = -0.0045
    const screen = new Mesh(
      new PlaneGeometry(WIDTH, HEIGHT),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false })
    )
    this.cursor = new Mesh(
      new RingGeometry(0.004, 0.006, 16),
      new MeshBasicMaterial({ color: 0x00a5d6, transparent: true, opacity: 0.9, toneMapped: false })
    )
    this.cursor.position.z = 0.001
    this.cursor.visible = false
    this.group.add(frame, screen, this.cursor)
    // Mounted on the left wall beside the pilot, clear of the panel and the windscreen
    this.group.position.set(-0.46, -0.2, -0.24)
    this.group.rotation.set(-0.2, 1.05, 0, 'YXZ')
  }

  /** Mounts the tablet in the cockpit, in cockpit axes. */
  place(position: Vector3, rotation: Euler) {
    this.group.position.copy(position)
    this.group.rotation.copy(rotation)
  }

  /** The aircraft's own checklists, or null for none. */
  setChecklists(checklists: Checklist[] | null) {
    this.checklists = checklists
    this.progress = checklists?.map(() => 0) ?? []
    this.checklist = 0
    if (!checklists && this.page === 'checklist') this.page = 'fly'
    if (!checklists) this.flightPage = 'flight'
    this.refresh()
  }

  /** Ticks off the next item of the open checklist once the pilot has done it. */
  private tickChecklist() {
    // Each new flight starts every checklist afresh
    if (game.flight !== this.flight) {
      this.flight = game.flight
      this.progress = this.checklists?.map(() => 0) ?? []
      this.refresh()
    }
    const list = this.checklists?.[this.checklist]
    if (!list) return
    const done = this.progress[this.checklist]
    if (done < list.items.length && list.items[done].done()) {
      this.progress[this.checklist] = done + 1
      this.refresh()
    }
  }

  /** Redraws on the next frame, after the game changes under it. */
  refresh() {
    this.sinceDraw = REFRESH
  }

  update(
    dt: number,
    interactors: Interactor[],
    time: number,
    holding: (it: Interactor) => boolean
  ) {
    let pointed = false
    this.group.updateMatrix()
    this.inverse.copy(this.group.matrix).invert()
    for (const it of interactors) {
      if (!it.active || holding(it)) {
        this.depth.delete(it)
        continue
      }
      const p = this.local.copy(it.tip).applyMatrix4(this.inverse)
      const inside = Math.abs(p.x) < WIDTH / 2 && Math.abs(p.y) < HEIGHT / 2
      if (inside && p.z < 0.04 && p.z > -0.03) {
        this.cursor.position.set(p.x, p.y, 0.001)
        pointed = true
        // A tap is the fingertip crossing the glass from the front
        const before = this.depth.get(it)
        if (before !== undefined && before > 0.004 && p.z <= 0.004 && time - this.lastTap > 0.35) {
          this.lastTap = time
          this.tap((p.x / WIDTH + 0.5) * W, (0.5 - p.y / HEIGHT) * H)
        }
      }
      // Only a fingertip over the glass can tap, so one sliding in from an edge cannot
      if (inside) this.depth.set(it, p.z)
      else this.depth.delete(it)
    }
    this.cursor.visible = pointed
    this.tickChecklist()
    this.sinceDraw += dt
    if (this.sinceDraw >= REFRESH) {
      this.sinceDraw = 0
      this.draw()
    }
  }

  private tap(x: number, y: number) {
    const hit = this.buttons.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
    if (!hit) return
    hit.act()
    this.refresh()
  }

  dispose() {
    this.texture.dispose()
  }

  // Drawing

  private draw() {
    const ctx = this.ctx
    this.buttons = []
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, W, H)
    const state = game.getState()
    const { status } = state
    if (status === 'flying' || (status === 'crashed' && !state.crashShown)) {
      this.drawFlight()
    } else {
      let y = this.drawResult()
      y = this.tabs(y)
      if (this.page === 'fly') this.drawSetup(y)
      else if (this.page === 'missions') this.drawMissions(y)
      else if (this.page === 'checklist') this.drawChecklist(y)
      else this.drawHelp(y)
    }
    this.texture.needsUpdate = true
  }

  private text(value: string, x: number, y: number, size: number, color = INK, weight = 600) {
    const ctx = this.ctx
    ctx.font = `${weight} ${size}px ${FONT}`
    ctx.fillStyle = color
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(value, x, y, W - x - 20)
  }

  /** Writes wrapped lines and returns the y below them. */
  private paragraph(value: string, x: number, y: number, size: number, color = INK, maxLines = 8) {
    const ctx = this.ctx
    ctx.font = `500 ${size}px ${FONT}`
    const words = value.split(' ')
    let line = ''
    let lines = 0
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width > W - x - 24 && line) {
        this.text(line, x, y, size, color, 500)
        y += size * 1.3
        line = word
        if (++lines >= maxLines) return y
      } else line = next
    }
    if (line) {
      this.text(line, x, y, size, color, 500)
      y += size * 1.3
    }
    return y
  }

  private button(
    label: string,
    x: number,
    y: number,
    w: number,
    h: number,
    act: () => void,
    tone: 'main' | 'plain' | 'on' = 'plain'
  ) {
    const ctx = this.ctx
    ctx.fillStyle = tone === 'main' ? INK : tone === 'on' ? ACCENT : '#ddd6c0'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 10)
    ctx.fill()
    ctx.font = `700 ${Math.min(26, h * 0.42)}px ${FONT}`
    ctx.fillStyle = tone === 'plain' ? INK : PAPER
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + w / 2, y + h / 2, w - 12)
    this.buttons.push({ x, y, w, h, act })
  }

  /** A row with a label and arrows that step through `options`. */
  private picker(label: string, value: string, y: number, step: (by: number) => void) {
    this.text(label, 24, y + 4, 18, MUTED)
    this.button('‹', 24, y + 28, 64, 52, () => step(-1))
    this.text(value, 100, y + 40, 26)
    this.button('›', W - 88, y + 28, 64, 52, () => step(1))
    return y + 92
  }

  private tabs(y: number) {
    const tabs: [Page, string][] = [
      ['fly', 'Free Flight'],
      ['missions', 'Missions'],
      ...(this.checklists ? ([['checklist', 'Checklist']] as [Page, string][]) : []),
      ['help', 'Help']
    ]
    const w = (W - 48 - (tabs.length - 1) * 8) / tabs.length
    tabs.forEach(([page, label], i) => {
      this.button(
        label,
        24 + i * (w + 8),
        y,
        w,
        56,
        () => {
          this.page = page
          this.briefing = null
        },
        this.page === page ? 'on' : 'plain'
      )
    })
    return y + 76
  }

  /** The heading card: the title, what happened, and the main actions. Returns the y below. */
  private drawResult() {
    const state = game.getState()
    const { status, mission, missionResult, arrival } = state
    let title = 'Island Flyer VR'
    let summary = 'Pick an aircraft and an airport, then start. Or take on a mission.'
    if (status === 'paused') {
      title = 'Paused'
      summary = 'The aircraft holds its position until you resume.'
    } else if (status === 'crashed') {
      title = mission ? 'Mission Failed' : 'Flight Ended'
      summary = forVR(CRASH_REASONS[state.crash ?? 'terrain'])
    } else if (status === 'finished' && missionResult) {
      title = missionResult.passed ? 'Mission Complete' : 'Mission Failed'
      summary = !missionResult.passed
        ? forVR(missionResult.reason)
        : missionResult.touchdown === undefined
          ? 'Every step done. Well flown.'
          : `Every step done, with a touchdown at ${missionResult.touchdown} ft/min. Well flown.`
    } else if (status === 'arrived' && arrival) {
      title = 'Flight Complete'
      const minutes = Math.max(1, Math.round(arrival.flightSeconds / 60))
      const rate = Math.round((arrival.touchdownRate * FPM_PER_MS) / 10) * 10
      summary = `Parked at ${arrival.airport.name} after ${minutes} min, touching down at ${rate} ft/min.`
    }
    const color =
      title.includes('Failed') || title === 'Flight Ended'
        ? BAD
        : title.includes('Complete')
          ? GOOD
          : INK
    this.text(title, 24, 22, 40, color, 800)
    let y = this.paragraph(summary, 24, 76, 20, INK, 4) + 10
    const half = (W - 48 - 12) / 2
    if (status === 'paused') {
      this.button('Resume', 24, y, half, 64, game.resume, 'main')
      this.button('Recenter Seat', 24 + half + 12, y, half, 64, this.actions.recenter)
      y += 80
    } else if (mission && status !== 'menu') {
      this.button('Retry Mission', 24, y, half, 64, game.retryMission, 'main')
      this.button('Leave Mission', 24 + half + 12, y, half, 64, game.leaveMission)
      y += 80
    }
    return y
  }

  private drawSetup(y: number) {
    const state = game.getState()
    const cycle = <T>(list: T[], current: T, by: number) =>
      list[(list.indexOf(current) + by + list.length) % list.length]
    y = this.picker('Aircraft', state.selected.name, y, by =>
      game.selectAircraft(cycle(HANGAR, state.selected, by).id)
    )
    const usable = AIRPORTS.filter(airport => canUse(state.selected, airport))
    y = this.picker('From', state.departure.name, y, by =>
      game.selectDeparture(cycle(usable, state.departure, by).name)
    )
    const destinations = [null, ...usable.filter(airport => airport !== state.departure)]
    y = this.picker('To', state.destination?.name ?? 'No flight plan', y, by =>
      game.selectDestination(cycle(destinations, state.destination, by)?.name ?? null)
    )
    const third = (W - 48 - 16) / 3
    const small = (label: string, value: string, x: number, act: () => void) => {
      this.text(label, x, y + 4, 18, MUTED)
      this.button(value, x, y + 28, third, 52, act)
    }
    small('Weather', capital(state.weather), 24, () =>
      game.setWeather(cycle(WEATHERS, state.weather, 1))
    )
    small('Time', capital(state.time), 24 + third + 8, () =>
      game.setTime(cycle(TIMES, state.time, 1))
    )
    small('Wind', capital(state.wind), 24 + (third + 8) * 2, () =>
      game.setWind(cycle(WINDS, state.wind, 1))
    )
    y += 100
    const airliner = state.selected.shape.type === 'airliner'
    this.button(
      airliner ? 'Start at the Gate' : 'Start at the Hangar',
      24,
      y,
      W - 48,
      60,
      game.startAtStand,
      'main'
    )
    const half = (W - 48 - 12) / 2
    this.button('On the Runway', 24, y + 70, half, 60, game.startOnRunway, 'main')
    this.button('In the Air', 24 + half + 12, y + 70, half, 60, game.startInAir, 'main')
  }

  private drawMissions(y: number) {
    if (this.briefing) {
      const mission = this.briefing
      const spec = HANGAR.find(candidate => candidate.id === mission.aircraft)
      this.text(mission.title, 24, y, 30, INK, 800)
      this.text(`${mission.category} · ${spec?.label ?? ''}`, 24, y + 40, 20, MUTED)
      const bottom = this.paragraph(forVR(mission.briefing), 24, y + 76, 20, INK, 12)
      const half = (W - 48 - 12) / 2
      const at = Math.max(bottom + 16, H - 96)
      this.button('Back', 24, at, half, 64, () => {
        this.briefing = null
      })
      this.button(
        'Start Mission',
        24 + half + 12,
        at,
        half,
        64,
        () => {
          this.briefing = null
          game.startMission(mission)
        },
        'main'
      )
      return
    }
    const passed = passedMissions()
    const pages = Math.ceil(MISSIONS.length / PER_PAGE)
    this.missionPage = Math.min(this.missionPage, pages - 1)
    const shown = MISSIONS.slice(this.missionPage * PER_PAGE, (this.missionPage + 1) * PER_PAGE)
    for (const mission of shown) {
      const done = passed.has(mission.id)
      this.button('', 24, y, W - 48, 70, () => {
        this.briefing = mission
      })
      this.text(`${done ? '✓ ' : ''}${mission.title}`, 40, y + 10, 24, done ? GOOD : INK, 700)
      this.text(`${mission.category} · ${mission.summary}`, 40, y + 42, 17, MUTED, 500)
      y += 78
    }
    const third = (W - 48 - 16) / 3
    this.button('‹ Prev', 24, H - 84, third, 60, () => {
      this.missionPage = (this.missionPage - 1 + pages) % pages
    })
    this.text(`${this.missionPage + 1} / ${pages}`, 24 + third + 8 + third / 2 - 24, H - 66, 22)
    this.button('Next ›', 24 + (third + 8) * 2, H - 84, third, 60, () => {
      this.missionPage = (this.missionPage + 1) % pages
    })
  }

  /** The open checklist, with the done items ticked and the next one marked. */
  private drawChecklist(y: number) {
    const lists = this.checklists
    if (!lists) return
    const list = lists[this.checklist]
    const step = (by: number) => () => {
      this.checklist = (this.checklist + by + lists.length) % lists.length
    }
    this.button('‹', 24, y, 56, 52, step(-1))
    this.button('›', W - 80, y, 56, 52, step(1))
    this.text(list.title, 92, y + 12, 24, INK, 800)
    y += 68
    const done = this.progress[this.checklist]
    list.items.forEach((item, i) => {
      const mark = i < done ? '✓' : i === done ? '›' : '·'
      const color = i < done ? GOOD : i === done ? INK : MUTED
      y = this.paragraph(`${mark} ${item.text}`, 24, y, 20, color, 2) + 4
    })
    this.button('Start Over', 24, H - 84, W - 48, 60, () => {
      this.progress[this.checklist] = 0
    })
  }

  private drawHelp(y: number) {
    const lines = [
      ['Bare hands', ''],
      ['Grab', 'Pinch or make a fist on the stick, yoke, or a lever'],
      ['Press', 'Poke a button with your fingertip, or pinch it'],
      ['Steer', 'On the ground the stick steers the nose wheel'],
      ['Controllers', ''],
      ['Grip', 'Grab the stick, yoke, or a lever'],
      ['Right stick', 'Fly without grabbing; with the stick held, trim'],
      ['Left stick', 'Rudder left and right, throttle up and down'],
      ['Triggers', 'Left: wheel brakes. Right: fire or release'],
      ['A / B', 'Gear / speed brake'],
      ['X / Y', 'Flaps up / flaps down'],
      ['Stick press', 'Right: autopilot. Left: pause']
    ]
    for (const [name, what] of lines) {
      if (!what) {
        this.text(name, 24, y + 6, 24, ACCENT, 800)
        y += 40
        continue
      }
      this.text(name, 24, y, 19, INK, 700)
      y = this.paragraph(what, 170, y, 19, INK, 2) + 4
    }
    const half = (W - 48 - 12) / 2
    this.button('Recenter Seat', 24, H - 84, half, 60, this.actions.recenter)
    this.button('Exit VR', 24 + half + 12, H - 84, half, 60, this.actions.exit)
  }

  /** In flight: the mission step or landing advice, and the pause and seat buttons. */
  private drawFlight() {
    const state = game.getState()
    const { mission } = state
    let y = 24
    if (this.checklists) {
      const half = (W - 48 - 8) / 2
      const pick = (page: 'flight' | 'checklist') => () => {
        this.flightPage = page
      }
      this.button(
        'Flight',
        24,
        16,
        half,
        52,
        pick('flight'),
        this.flightPage === 'flight' ? 'on' : 'plain'
      )
      this.button(
        'Checklist',
        32 + half,
        16,
        half,
        52,
        pick('checklist'),
        this.flightPage === 'checklist' ? 'on' : 'plain'
      )
      y = 84
      if (this.flightPage === 'checklist') {
        this.drawChecklist(y)
        return
      }
    }
    if (mission) {
      const runner = game.missions
      this.text(mission.title, 24, y, 30, INK, 800)
      const limit = mission.timeLimit
      const clock = limit
        ? `${seconds(Math.max(0, limit - runner.time))} left`
        : seconds(runner.time)
      this.text(clock, 24, y + 40, 20, limit && limit - runner.time < 30 ? BAD : MUTED)
      y += 80
      mission.objectives.forEach((objective, i) => {
        if (i < runner.step - 1 || i > runner.step + 2) return
        const done = i < runner.step
        const color = done ? MUTED : i === runner.step ? INK : MUTED
        y =
          this.paragraph(
            `${done ? '✓' : i === runner.step ? '›' : '·'} ${forVR(objective.text)}`,
            24,
            y,
            21,
            color,
            4
          ) + 8
      })
      if (runner.warning) {
        y = this.paragraph(
          `${forVR(runner.warning.text)} ${Math.ceil(runner.warning.left)} s`,
          24,
          y + 4,
          22,
          BAD,
          3
        )
      }
    } else {
      this.text(state.flown.name, 24, y, 30, INK, 800)
      y += 50
      const advice = state.coach ? landingAdvice(game.sim, game.nav, game.pilot) : null
      if (advice) {
        const color =
          advice.tone === 'warn'
            ? BAD
            : advice.tone === 'good'
              ? GOOD
              : advice.tone === 'fix'
                ? ACCENT
                : INK
        y = this.paragraph(forVR(advice.text), 24, y, 22, color, 5)
      } else {
        y = this.paragraph(
          'Grab the stick or yoke to fly. The panel buttons work the systems, and the levers beside you set throttle, flaps, gear, and brakes.',
          24,
          y,
          20,
          MUTED,
          6
        )
      }
    }
    const half = (W - 48 - 12) / 2
    this.button('Pause', 24, H - 160, half, 64, game.pause, 'main')
    this.button('Recenter Seat', 24 + half + 12, H - 160, half, 64, this.actions.recenter)
    this.button(state.muted ? 'Sound Off' : 'Sound On', 24, H - 86, half, 60, game.toggleMuted)
    this.button(state.coach ? 'Coach On' : 'Coach Off', 24 + half + 12, H - 86, half, 60, () =>
      game.setCoach(!state.coach)
    )
  }
}

const capital = (value: string) => value[0].toUpperCase() + value.slice(1)

function seconds(total: number) {
  const whole = Math.floor(total)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
