import { game } from '../../game/game'
import type { AircraftSpec } from '../../sim/aircraft'
import { DEGREES, FEET_PER_METRE, KNOTS_PER_MS, thousands } from '../../ui/telemetry'
import { drawFlightDisplay } from '../displays'

/*
 * Screen painters for the Boeing flight decks. Each paints a canvas `w` by `h` pixels and
 * reads the aircraft directly, as the painters in glass.ts do.
 */

export type Paint = (ctx: CanvasRenderingContext2D, w: number, h: number) => void

const BLACK = '#05070a'
const WHITE = '#e8ecef'
const GREEN = '#4be36f'
const AMBER = '#f2a93b'
const MAGENTA = '#e06bf0'
const CYAN = '#4fd3ff'
const DIM = '#56606a'
const MONO = 'ui-monospace, Menlo, Consolas, monospace'
const METRES_PER_NM = 1852

function write(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  color = WHITE,
  align: CanvasTextAlign = 'center',
  font = 'system-ui, sans-serif'
) {
  ctx.font = `600 ${size}px ${font}`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(value, x, y)
}

/** Two pages side by side on one landscape screen; the left one takes `share` of the width. */
export function sideBySide(left: Paint, right: Paint, share = 0.5): Paint {
  return (ctx, w, h) => {
    const x = Math.round(w * share)
    ctx.fillStyle = BLACK
    ctx.fillRect(0, 0, w, h)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, x, h)
    ctx.clip()
    left(ctx, x, h)
    ctx.restore()
    ctx.save()
    ctx.translate(x, 0)
    ctx.beginPath()
    ctx.rect(0, 0, w - x, h)
    ctx.clip()
    right(ctx, w - x, h)
    ctx.restore()
  }
}

/** The primary flight display on a tall half screen: attitude and tapes, the compass rose below. */
export const boeingPfd: Paint = (ctx, w, h) => {
  ctx.fillStyle = BLACK
  ctx.fillRect(0, 0, w, h)
  const s = Math.min(w, h)
  ctx.save()
  ctx.translate((w - s) / 2, 0)
  drawFlightDisplay(ctx, s)
  ctx.restore()
  if (!game.sim.powered || h - s < h * 0.15) return
  compassRose(ctx, w, s, h)
}

/** The top of a compass rose between `top` and `bottom`, with the heading bug in magenta. */
function compassRose(ctx: CanvasRenderingContext2D, w: number, top: number, bottom: number) {
  const { sim, pilot } = game
  const heading = sim.heading * DEGREES
  const r = w * 0.44
  const cx = w / 2
  const cy = top + (bottom - top) * 0.22 + r
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, top, w, bottom - top)
  ctx.clip()
  ctx.strokeStyle = WHITE
  ctx.lineWidth = Math.max(1, r * 0.018)
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  for (let d = Math.ceil((heading - 90) / 5) * 5; d <= heading + 90; d += 5) {
    const a = (d - heading) / DEGREES
    const sin = Math.sin(a)
    const cos = Math.cos(a)
    const inner = r * (d % 10 === 0 ? 0.9 : 0.95)
    ctx.beginPath()
    ctx.moveTo(cx + sin * r, cy - cos * r)
    ctx.lineTo(cx + sin * inner, cy - cos * inner)
    ctx.stroke()
    if (d % 30 === 0) {
      const label = String((((d % 360) + 360) % 360) / 10)
      write(ctx, label, cx + sin * r * 0.78, cy - cos * r * 0.78, r * 0.12)
    }
  }
  const bug = (pilot.autopilot.heading * DEGREES - heading) / DEGREES
  ctx.fillStyle = MAGENTA
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(bug)
  ctx.fillRect(-r * 0.05, -r * 1.02, r * 0.1, r * 0.06)
  ctx.restore()
  // The lubber line: a white triangle at the top
  ctx.fillStyle = WHITE
  ctx.beginPath()
  ctx.moveTo(cx, cy - r + r * 0.02)
  ctx.lineTo(cx - r * 0.04, cy - r - r * 0.08)
  ctx.lineTo(cx + r * 0.04, cy - r - r * 0.08)
  ctx.fill()
  ctx.restore()
}

/** The 787's auxiliary strip beside the flight display: time, transponder, and speeds. */
export const auxStrip: Paint = (ctx, w, h) => {
  ctx.fillStyle = BLACK
  ctx.fillRect(0, 0, w, h)
  const { sim } = game
  if (!sim.powered) return
  const size = w * 0.13
  const lines: [string, string, string][] = [
    ['UTC', new Date().toISOString().slice(11, 16), WHITE],
    ['XPDR', '2000', GREEN],
    ['TCAS', 'TA/RA', GREEN],
    ['GS', String(Math.round(Math.hypot(sim.velocity.x, sim.velocity.z) * KNOTS_PER_MS)), WHITE],
    ['MACH', sim.mach.toFixed(3).slice(1), WHITE],
    ['FUEL', thousands(Math.round(sim.fuel)), WHITE]
  ]
  lines.forEach(([label, value, color], i) => {
    const y = h * (0.1 + i * 0.15)
    write(ctx, label, w * 0.5, y, size, CYAN)
    write(ctx, value, w * 0.5, y + size * 1.2, size * 1.1, color)
  })
}

/**
 * The lower crew alerting page: secondary engine readings, then gear, flaps, brakes, and
 * fuel, as Boeing's lower display and status page show them.
 */
export function systemsPage(spec: AircraftSpec, speedbrakeArmed: () => boolean): Paint {
  return (ctx, w, h) => {
    ctx.fillStyle = BLACK
    ctx.fillRect(0, 0, w, h)
    const { sim, pilot } = game
    if (!sim.powered) return
    const c = pilot.controls
    const size = Math.min(w * 0.055, h * 0.045)
    const rows = ['N2', 'FF', 'OIL P', 'OIL T', 'VIB']
    rows.forEach((label, r) => {
      write(ctx, label, w * 0.5, h * (0.08 + r * 0.075), size, CYAN)
    })
    sim.engines.forEach((engine, i) => {
      const x = w * (i === 0 ? 0.24 : 0.76)
      const power = engine.running ? engine.power : 0
      const n2 = engine.running ? 59 + 41 * power : engine.starting > 0 ? 24 : 0
      const flow = engine.running
        ? (spec.fuelBurnIdle + (spec.fuelBurnFull - spec.fuelBurnIdle) * power) * 3.6
        : 0
      const values = [
        n2.toFixed(1),
        flow.toFixed(2),
        String(Math.round(engine.running ? 38 + 30 * power : 0)),
        String(Math.round(engine.running ? 85 + 35 * power : 20)),
        engine.running ? '0.4' : '0.0'
      ]
      values.forEach((value, r) => {
        write(ctx, value, x, h * (0.08 + r * 0.075), size * 1.1, engine.fire ? AMBER : WHITE)
      })
    })

    // Status: gear, flaps, speed brake, parking brake, fuel
    ctx.strokeStyle = DIM
    ctx.lineWidth = Math.max(1, h * 0.004)
    ctx.beginPath()
    ctx.moveTo(w * 0.05, h * 0.47)
    ctx.lineTo(w * 0.95, h * 0.47)
    ctx.stroke()
    const g = sim.gearPosition
    const gearColor = g >= 0.99 ? GREEN : g <= 0.01 ? DIM : AMBER
    const gearText = g >= 0.99 ? 'DOWN' : g <= 0.01 ? 'UP' : 'TRANS'
    write(ctx, 'GEAR', w * 0.5, h * 0.53, size, CYAN)
    for (const [x, y] of [
      [0.5, 0.6],
      [0.3, 0.66],
      [0.7, 0.66]
    ]) {
      ctx.strokeStyle = gearColor
      ctx.strokeRect(w * (x - 0.1), h * (y - 0.028), w * 0.2, h * 0.056)
      write(ctx, gearText, w * x, h * y, size, gearColor)
    }
    const moving = Math.abs(sim.flapPosition * (spec.flapLabels.length - 1) - c.flapNotch) > 0.05
    const lines: [string, string, string][] = [
      ['FLAPS', spec.flapLabels[c.flapNotch].toUpperCase(), moving ? AMBER : GREEN],
      [
        'SPD BRK',
        c.speedBrake ? 'EXT' : speedbrakeArmed() ? 'ARMED' : 'DOWN',
        c.speedBrake ? AMBER : GREEN
      ],
      ['PARK BRK', c.parkingBrake ? 'SET' : 'OFF', c.parkingBrake ? AMBER : WHITE],
      [
        'FUEL KG',
        thousands(Math.round(sim.fuel)),
        sim.fuel < spec.fuelCapacity * 0.15 ? AMBER : WHITE
      ]
    ]
    lines.forEach(([label, value, color], i) => {
      const y = h * (0.76 + i * 0.065)
      write(ctx, label, w * 0.3, y, size, CYAN, 'right')
      write(ctx, value, w * 0.36, y, size, color, 'left')
    })
  }
}

/** The flight computer's LEGS page in a rectangle: the route ahead with distances and heights. */
function legsPage(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = BLACK
  ctx.fillRect(x, y, w, h)
  const { sim, nav } = game
  if (!sim.powered) return
  const line = h / 8
  const size = Math.min(line * 0.6, w * 0.07)
  write(ctx, 'ACT RTE 1 LEGS', x + w / 2, y + line * 0.55, size, WHITE, 'center', MONO)
  const first = nav.waypointAhead
  const points = nav.waypoints
  if (first >= points.length) {
    write(ctx, 'NO ACTIVE ROUTE', x + w / 2, y + line * 3, size, WHITE, 'center', MONO)
  }
  let fromX = sim.position.x
  let fromZ = sim.position.z
  for (let i = 0; i < 6 && first + i < points.length; i++) {
    const fix = points[first + i]
    const nm = Math.hypot(fix.x - fromX, fix.z - fromZ) / METRES_PER_NM
    fromX = fix.x
    fromZ = fix.z
    const row = y + line * (1.45 + i * 0.95)
    const feet = Math.round((fix.altitude * FEET_PER_METRE) / 100) * 100
    write(ctx, fix.name, x + w * 0.04, row, size, i === 0 ? MAGENTA : WHITE, 'left', MONO)
    write(ctx, `${Math.round(nm)}NM`, x + w * 0.55, row, size * 0.85, WHITE, 'right', MONO)
    write(ctx, `${feet}`, x + w * 0.96, row, size, CYAN, 'right', MONO)
  }
  write(
    ctx,
    '<RTE 2 LEGS    RTE DATA>',
    x + w / 2,
    y + line * 7.5,
    size * 0.8,
    WHITE,
    'center',
    MONO
  )
}

/** The LEGS page filling a whole screen, as the 787's lower display shows it. */
export const legsScreen: Paint = (ctx, w, h) => legsPage(ctx, 0, 0, w, h)

/** The PROGRESS page: the next fix, distance and time to go, speeds, and fuel. */
export const progressScreen: Paint = (ctx, w, h) => {
  ctx.fillStyle = BLACK
  ctx.fillRect(0, 0, w, h)
  const { sim, nav } = game
  if (!sim.powered) return
  const line = h / 8
  const size = line * 0.6
  write(ctx, 'PROGRESS', w / 2, line * 0.55, size, WHITE, 'center', MONO)
  const fix = nav.waypoints[nav.waypointAhead]
  const speed = Math.max(1, Math.hypot(sim.velocity.x, sim.velocity.z))
  const metres = fix ? Math.hypot(fix.x - sim.position.x, fix.z - sim.position.z) : 0
  const minutes = Math.round(metres / speed / 60)
  const rows: [string, string][] = [
    ['TO', fix ? fix.name : '-----'],
    ['DTG', fix ? `${Math.round(metres / METRES_PER_NM)} NM` : '---'],
    ['ETE', fix ? `${minutes} MIN` : '---'],
    ['GS', `${Math.round(speed * KNOTS_PER_MS)} KT`],
    ['FUEL', `${thousands(Math.round(sim.fuel))} KG`]
  ]
  rows.forEach(([label, value], i) => {
    const row = line * (1.6 + i * 1.1)
    write(ctx, label, w * 0.06, row, size * 0.8, WHITE, 'left', MONO)
    write(ctx, value, w * 0.94, row, size, i === 0 ? MAGENTA : GREEN, 'right', MONO)
  })
}

/** Paints a grid of keys into a rectangle, `columns` across. */
function keys(
  ctx: CanvasRenderingContext2D,
  labels: string[],
  columns: number,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const rows = Math.ceil(labels.length / columns)
  const kw = w / columns
  const kh = h / rows
  labels.forEach((label, i) => {
    const kx = x + (i % columns) * kw
    const ky = y + Math.floor(i / columns) * kh
    ctx.fillStyle = '#16191c'
    ctx.fillRect(kx + kw * 0.08, ky + kh * 0.1, kw * 0.84, kh * 0.8)
    if (!label) return
    ctx.font = `600 ${Math.min(kh * 0.32, (kw * 1.4) / Math.max(3, label.length))}px system-ui, sans-serif`
    ctx.fillStyle = '#dcdcd4'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, kx + kw / 2, ky + kh / 2, kw * 0.8)
  })
}

const FUNCTION_KEYS = [
  'INIT REF',
  'RTE',
  'CLB',
  'CRZ',
  'DES',
  'MENU',
  'LEGS',
  'DEP ARR',
  'HOLD',
  'PROG',
  'EXEC',
  'N1 LIMIT',
  'FIX',
  'PREV PAGE',
  'NEXT PAGE'
]
const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '+/-']
const LETTER_KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'SP', 'DEL', '/', 'CLR']

/** A 737 flight computer keypad: the screen with its line keys, then the keys below. */
export const cdu: Paint = (ctx, w, h) => {
  ctx.fillStyle = '#353a3f'
  ctx.fillRect(0, 0, w, h)
  const sx = w * 0.14
  const sy = h * 0.035
  const sw = w * 0.72
  const sh = h * 0.4
  legsPage(ctx, sx, sy, sw, sh)
  ctx.fillStyle = '#16191c'
  for (let i = 0; i < 6; i++) {
    const y = sy + sh * (0.17 + i * 0.13)
    ctx.fillRect(w * 0.025, y, w * 0.09, sh * 0.07)
    ctx.fillRect(w * 0.885, y, w * 0.09, sh * 0.07)
  }
  keys(ctx, FUNCTION_KEYS, 5, w * 0.03, h * 0.46, w * 0.94, h * 0.19)
  keys(ctx, NUMBER_KEYS, 3, w * 0.03, h * 0.67, w * 0.36, h * 0.31)
  keys(ctx, LETTER_KEYS, 5, w * 0.41, h * 0.67, w * 0.56, h * 0.31)
}

/** A 787 multifunction keypad, drawn once: a scratchpad line above letters and numbers. */
export const keypad: Paint = (ctx, w, h) => {
  ctx.fillStyle = '#2f3337'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = BLACK
  ctx.fillRect(w * 0.06, h * 0.03, w * 0.88, h * 0.08)
  keys(
    ctx,
    ['FMC', 'COMM', 'NAV RAD', 'CHKL', 'MENU', 'EXEC'],
    3,
    w * 0.03,
    h * 0.13,
    w * 0.94,
    h * 0.15
  )
  keys(ctx, NUMBER_KEYS, 3, w * 0.03, h * 0.3, w * 0.94, h * 0.3)
  keys(ctx, LETTER_KEYS, 6, w * 0.03, h * 0.62, w * 0.94, h * 0.36)
}
