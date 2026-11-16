import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type Vector3
} from 'three'
import { game } from '../game/game'
import { WARNINGS } from '../game/gpws'
import type { AircraftSpec } from '../sim/aircraft'
import { LAMPS } from '../ui/lamps'
import { flightModes } from '../ui/modes'
import { DEGREES, FEET_PER_METRE, FPM_PER_MS, KNOTS_PER_MS, thousands } from '../ui/telemetry'

const WHITE = '#e8ecef'
const GREEN = '#4be36f'
const AMBER = '#f2a93b'
const RED = '#ff4b3a'
const MAGENTA = '#e06bf0'
const CYAN = '#4fd3ff'
const SKY = '#2d6fb3'
const EARTH = '#7a4f2a'
const FONT = 'system-ui, sans-serif'
const METRES_PER_NM = 1852

/** A glass screen on the panel: a canvas the aircraft's state is drawn into. */
export class Screen {
  readonly mesh: Mesh
  readonly ctx: CanvasRenderingContext2D
  private readonly texture: CanvasTexture

  constructor(
    readonly size: number,
    width: number,
    at: Vector3,
    private readonly paint: (ctx: CanvasRenderingContext2D, size: number) => void
  ) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The browser gave no 2D canvas, so the cockpit screens cannot draw')
    this.ctx = ctx
    this.texture = new CanvasTexture(canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = 4
    this.mesh = new Mesh(
      new PlaneGeometry(width, width),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false })
    )
    this.mesh.position.copy(at)
  }

  draw() {
    this.paint(this.ctx, this.size)
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as MeshBasicMaterial).dispose()
  }
}

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  color = WHITE,
  align: CanvasTextAlign = 'center'
) {
  ctx.font = `600 ${size}px ${FONT}`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(value, x, y)
}

/**
 * Primary flight display: attitude in the middle, speed tape on the left, altitude tape and
 * climb rate on the right, heading along the bottom, and the autopilot modes across the top.
 */
export function drawFlightDisplay(ctx: CanvasRenderingContext2D, s: number) {
  const { sim, pilot } = game
  ctx.fillStyle = '#05070a'
  ctx.fillRect(0, 0, s, s)
  if (!sim.powered) {
    text(ctx, 'NO POWER', s / 2, s / 2, s * 0.06, '#3a4248')
    return
  }
  const cx = s / 2
  const cy = s * 0.47
  const half = s * 0.27
  const perDegree = (half * 2) / 50

  // Attitude: the horizon turns against the bank and slides with the pitch
  ctx.save()
  ctx.beginPath()
  ctx.rect(cx - half, cy - half, half * 2, half * 2)
  ctx.clip()
  ctx.translate(cx, cy)
  ctx.rotate(-sim.bank)
  const shift = sim.pitch * DEGREES * perDegree
  ctx.fillStyle = SKY
  ctx.fillRect(-s, -s * 2 + shift, s * 2, s * 2)
  ctx.fillStyle = EARTH
  ctx.fillRect(-s, shift, s * 2, s * 2)
  ctx.strokeStyle = WHITE
  ctx.lineWidth = s * 0.004
  ctx.beginPath()
  ctx.moveTo(-s, shift)
  ctx.lineTo(s, shift)
  ctx.stroke()
  for (let deg = -40; deg <= 40; deg += 5) {
    if (deg === 0) continue
    const y = shift - deg * perDegree
    const long = deg % 10 === 0
    const w = long ? s * 0.09 : s * 0.04
    ctx.beginPath()
    ctx.moveTo(-w, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    if (long) {
      text(ctx, String(Math.abs(deg)), -w - s * 0.03, y, s * 0.028)
      text(ctx, String(Math.abs(deg)), w + s * 0.03, y, s * 0.028)
    }
  }
  ctx.restore()

  // Bank pointer on a fixed scale above the horizon
  ctx.save()
  ctx.translate(cx, cy)
  ctx.strokeStyle = WHITE
  ctx.lineWidth = s * 0.004
  for (const deg of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const a = deg / DEGREES - Math.PI / 2
    const inner = half * 0.9
    const outer = half * (deg % 30 === 0 ? 1.0 : 0.96)
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner)
    ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer)
    ctx.stroke()
  }
  ctx.rotate(-sim.bank)
  ctx.fillStyle = Math.abs(sim.bank * DEGREES) > 35 ? AMBER : WHITE
  ctx.beginPath()
  ctx.moveTo(0, -half * 0.89)
  ctx.lineTo(-s * 0.015, -half * 0.82)
  ctx.lineTo(s * 0.015, -half * 0.82)
  ctx.fill()
  // Slip: the bar slides out from under the pointer, as the ball does
  ctx.fillRect(-s * 0.018 + sim.slip * s * 0.4, -half * 0.8, s * 0.036, s * 0.008)
  ctx.restore()

  // The aircraft symbol
  ctx.strokeStyle = '#ffd400'
  ctx.lineWidth = s * 0.012
  ctx.beginPath()
  ctx.moveTo(cx - s * 0.13, cy)
  ctx.lineTo(cx - s * 0.05, cy)
  ctx.lineTo(cx - s * 0.05, cy + s * 0.02)
  ctx.moveTo(cx + s * 0.13, cy)
  ctx.lineTo(cx + s * 0.05, cy)
  ctx.lineTo(cx + s * 0.05, cy + s * 0.02)
  ctx.stroke()
  ctx.fillStyle = '#ffd400'
  ctx.fillRect(cx - s * 0.008, cy - s * 0.008, s * 0.016, s * 0.016)

  speedTape(ctx, s, cy, half)
  altitudeTape(ctx, s, cy, half)
  headingTape(ctx, s)

  // Autopilot modes and targets
  const modes = flightModes()
  const row = s * 0.05
  text(ctx, modes.thrust || '—', s * 0.2, row, s * 0.04, modes.thrust ? GREEN : '#56606a')
  text(ctx, modes.lateral || '—', s * 0.5, row, s * 0.04, modes.lateral ? GREEN : '#56606a')
  text(ctx, modes.vertical || '—', s * 0.8, row, s * 0.04, modes.vertical ? GREEN : '#56606a')
  if (pilot.autopilot.on) text(ctx, 'AP', s * 0.5, row + s * 0.05, s * 0.036, GREEN)
  if (pilot.autothrottle.on) {
    text(
      ctx,
      `${Math.round(pilot.autothrottle.speed * KNOTS_PER_MS)}`,
      s * 0.1,
      row + s * 0.05,
      s * 0.034,
      MAGENTA
    )
  }
  if (pilot.autopilot.on) {
    const feet = Math.round(pilot.autopilot.altitude * FEET_PER_METRE)
    text(ctx, thousands(feet), s * 0.88, row + s * 0.05, s * 0.034, MAGENTA)
  }

  // Ground proximity and stall warnings in large type across the attitude
  const alert = game.gpws.alert
  const warning = sim.stallWarning ? 'STALL' : alert && WARNINGS.has(alert) ? alert : null
  if (warning) {
    const flashing = Math.floor(performance.now() / 300) % 2 === 0
    if (flashing) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.fillRect(cx - s * 0.2, cy + half * 0.45, s * 0.4, s * 0.08)
      text(ctx, warning, cx, cy + half * 0.45 + s * 0.04, s * 0.06, RED)
    }
  }
}

function speedTape(ctx: CanvasRenderingContext2D, s: number, cy: number, half: number) {
  const { sim, pilot } = game
  const knots = sim.indicatedAirspeed * KNOTS_PER_MS
  const x = s * 0.03
  const w = s * 0.14
  const perKnot = (half * 2) / 80
  ctx.fillStyle = '#20262c'
  ctx.fillRect(x, cy - half, w, half * 2)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, cy - half, w, half * 2)
  ctx.clip()
  // Red below the stall, amber above the limit
  const stall = sim.spec.stats.stallSpeed
  const limit = sim.speedLimit * KNOTS_PER_MS
  ctx.fillStyle = RED
  ctx.fillRect(x + w - s * 0.012, cy + (knots - stall) * perKnot, s * 0.012, s)
  ctx.fillStyle = AMBER
  ctx.fillRect(x + w - s * 0.012, cy - s - (limit - knots) * perKnot, s * 0.012, s)
  ctx.strokeStyle = WHITE
  ctx.lineWidth = s * 0.004
  const from = Math.floor((knots - 45) / 10) * 10
  for (let k = Math.max(0, from); k < knots + 45; k += 10) {
    const y = cy - (k - knots) * perKnot
    ctx.beginPath()
    ctx.moveTo(x + w - s * 0.03, y)
    ctx.lineTo(x + w, y)
    ctx.stroke()
    if (k % 20 === 0) text(ctx, String(k), x + w * 0.42, y, s * 0.032)
  }
  if (pilot.autothrottle.on) {
    const y = cy - (pilot.autothrottle.speed * KNOTS_PER_MS - knots) * perKnot
    ctx.fillStyle = MAGENTA
    ctx.fillRect(x + w - s * 0.02, y - s * 0.006, s * 0.02, s * 0.012)
  }
  ctx.restore()
  readout(ctx, x, cy, w, String(Math.round(knots)), s)
  if (sim.mach > 0.4)
    text(ctx, `M ${sim.mach.toFixed(2)}`, x + w / 2, cy + half + s * 0.035, s * 0.032, GREEN)
}

function altitudeTape(ctx: CanvasRenderingContext2D, s: number, cy: number, half: number) {
  const { sim, pilot } = game
  const feet = sim.position.y * FEET_PER_METRE
  const x = s * 0.78
  const w = s * 0.15
  const perFoot = (half * 2) / 800
  ctx.fillStyle = '#20262c'
  ctx.fillRect(x, cy - half, w, half * 2)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, cy - half, w, half * 2)
  ctx.clip()
  ctx.strokeStyle = WHITE
  ctx.lineWidth = s * 0.004
  const from = Math.floor((feet - 450) / 100) * 100
  for (let f = from; f < feet + 450; f += 100) {
    const y = cy - (f - feet) * perFoot
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + s * 0.025, y)
    ctx.stroke()
    if (f % 200 === 0) text(ctx, thousands(f), x + w * 0.58, y, s * 0.03)
  }
  if (pilot.autopilot.on) {
    const y = cy - (pilot.autopilot.altitude * FEET_PER_METRE - feet) * perFoot
    ctx.fillStyle = MAGENTA
    ctx.fillRect(x, y - s * 0.006, s * 0.02, s * 0.012)
  }
  ctx.restore()
  readout(ctx, x, cy, w, thousands(Math.round(feet / 10) * 10), s)
  // Height above the ground, close to it
  const radio = sim.altitudeAgl * FEET_PER_METRE
  if (radio < 2500)
    text(ctx, `RA ${Math.round(radio)}`, x + w / 2, cy + half + s * 0.035, s * 0.032, GREEN)

  // Climb rate: a pointer on a scale to 6,000 ft/min, with the number above or below
  const fpm = sim.verticalSpeed * FPM_PER_MS
  const vx = s * 0.955
  ctx.fillStyle = '#20262c'
  ctx.fillRect(vx - s * 0.02, cy - half, s * 0.04, half * 2)
  const scale = (value: number) =>
    Math.sign(value) * Math.sqrt(Math.min(Math.abs(value), 6000) / 6000)
  ctx.strokeStyle = WHITE
  ctx.lineWidth = s * 0.008
  ctx.beginPath()
  ctx.moveTo(vx + s * 0.02, cy)
  ctx.lineTo(vx - s * 0.02, cy - scale(fpm) * half)
  ctx.stroke()
  if (Math.abs(fpm) > 100) {
    const y = fpm > 0 ? cy - half - s * 0.03 : cy + half + s * 0.08
    text(ctx, String(Math.round(fpm / 50) * 50), vx - s * 0.01, y, s * 0.028, GREEN)
  }
}

function headingTape(ctx: CanvasRenderingContext2D, s: number) {
  const { sim, pilot } = game
  const heading = sim.heading * DEGREES
  const y = s * 0.85
  const h = s * 0.1
  const perDegree = s / 90
  ctx.fillStyle = '#20262c'
  ctx.fillRect(s * 0.2, y, s * 0.6, h)
  ctx.save()
  ctx.beginPath()
  ctx.rect(s * 0.2, y, s * 0.6, h)
  ctx.clip()
  ctx.strokeStyle = WHITE
  ctx.lineWidth = s * 0.004
  const from = Math.floor((heading - 35) / 5) * 5
  for (let d = from; d < heading + 35; d += 5) {
    const x = s / 2 + (d - heading) * perDegree
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x, y + (d % 10 === 0 ? s * 0.025 : s * 0.014))
    ctx.stroke()
    if (d % 10 === 0) {
      const label = (((d % 360) + 360) % 360) / 10
      const name = { 0: 'N', 9: 'E', 18: 'S', 27: 'W' }[label] ?? String(label)
      text(ctx, name, x, y + h * 0.62, s * 0.032)
    }
  }
  if (pilot.autopilot.on && pilot.autopilot.lateral === 'HDG') {
    const target = pilot.autopilot.heading * DEGREES
    const off = ((target - heading + 540) % 360) - 180
    ctx.fillStyle = MAGENTA
    ctx.fillRect(s / 2 + off * perDegree - s * 0.008, y, s * 0.016, s * 0.02)
  }
  ctx.restore()
  ctx.fillStyle = '#05070a'
  ctx.fillRect(s / 2 - s * 0.05, y - s * 0.045, s * 0.1, s * 0.045)
  text(ctx, String(Math.round(heading) % 360).padStart(3, '0'), s / 2, y - s * 0.022, s * 0.036)
}

function readout(
  ctx: CanvasRenderingContext2D,
  x: number,
  cy: number,
  w: number,
  value: string,
  s: number
) {
  ctx.fillStyle = '#05070a'
  ctx.strokeStyle = WHITE
  ctx.lineWidth = s * 0.004
  ctx.fillRect(x, cy - s * 0.03, w, s * 0.06)
  ctx.strokeRect(x, cy - s * 0.03, w, s * 0.06)
  text(ctx, value, x + w / 2, cy, s * 0.042)
}

/**
 * Engine and systems display: one gauge per engine, the levers, gear, fuel, warning lamps,
 * and the selected approach.
 */
export function systemsDisplay(spec: AircraftSpec) {
  const lamps = LAMPS.filter(
    lamp =>
      (lamp.label !== 'AFTERBURNER' ||
        (spec.engine.type === 'jet' && spec.engine.afterburnerFrom < 1)) &&
      (lamp.label !== 'GEAR SPEED' || spec.retractableGear) &&
      (lamp.label !== 'FUEL DUMP' || spec.fuelDump)
  )
  return (ctx: CanvasRenderingContext2D, s: number) => {
    const { sim, pilot, nav, bombs } = game
    const c = pilot.controls
    ctx.fillStyle = '#05070a'
    ctx.fillRect(0, 0, s, s)

    // Warning lamps, three to a row
    const columns = 3
    const lw = s / columns
    const lh = s * 0.052
    lamps.forEach((lamp, i) => {
      const on = lamp.label === 'NO POWER' ? !sim.powered : sim.powered && lamp.on(sim, c)
      const x = (i % columns) * lw
      const y = Math.floor(i / columns) * lh
      ctx.fillStyle = on ? (lamp.kind === 'warning' ? '#c8261b' : '#c98a1c') : '#12171b'
      ctx.fillRect(x + 3, y + 3, lw - 6, lh - 6)
      text(ctx, lamp.label, x + lw / 2, y + lh / 2, s * 0.028, on ? '#fff' : '#3a444c')
    })
    const top = Math.ceil(lamps.length / columns) * lh + s * 0.02
    if (!sim.powered) return

    // Engine gauges: an arc of engine speed, with the number and a fire warning
    const engines = sim.engines
    const fullSpeed = spec.engine.type === 'piston' ? spec.engine.maxRpm : 100
    const gw = s / Math.max(2, engines.length)
    const radius = Math.min(gw * 0.36, s * 0.11)
    engines.forEach((engine, i) => {
      const x = gw * (i + 0.5)
      const y = top + radius + s * 0.02
      ctx.lineWidth = s * 0.012
      ctx.strokeStyle = '#2a3238'
      ctx.beginPath()
      ctx.arc(x, y, radius, Math.PI * 0.8, Math.PI * 2.2)
      ctx.stroke()
      ctx.strokeStyle = engine.fire ? RED : engine.running ? GREEN : AMBER
      ctx.beginPath()
      const share = Math.min(1, engine.rpm / fullSpeed)
      ctx.arc(x, y, radius, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * share))
      ctx.stroke()
      const label = engine.fire
        ? 'FIRE'
        : engine.failed
          ? 'FAIL'
          : engine.starting > 0
            ? 'START'
            : engine.running
              ? String(Math.round(engine.rpm))
              : 'OFF'
      text(ctx, label, x, y, s * 0.036, engine.fire || engine.failed ? RED : WHITE)
    })
    let y = top + radius * 2 + s * 0.08

    const row = (label: string, value: string, color = WHITE) => {
      text(ctx, label, s * 0.05, y, s * 0.036, '#8a959e', 'left')
      text(ctx, value, s * 0.95, y, s * 0.036, color, 'right')
      y += s * 0.052
    }
    row('THROTTLE', `${Math.round(c.throttle * 100)}%${sim.afterburner ? '  AB' : ''}`)
    if (sim.spec.flapLabels.length > 1) {
      const moving =
        Math.abs(sim.flapPosition * (sim.spec.flapLabels.length - 1) - c.flapNotch) > 0.05
      row(sim.spec.flapName.toUpperCase(), sim.spec.flapLabels[c.flapNotch], moving ? AMBER : WHITE)
    }
    const gear = sim.gearPosition
    row(
      'GEAR',
      gear >= 0.99 ? 'DOWN' : gear <= 0.01 ? 'UP' : 'MOVING',
      gear >= 0.99 ? GREEN : gear <= 0.01 ? WHITE : AMBER
    )
    row(
      'TRIM',
      `${c.trim > 0 ? 'UP' : c.trim < 0 ? 'DN' : ''} ${Math.round(Math.abs(c.trim) * 100)}`
    )
    const fuel = sim.fuel * sim.spec.fuelUnit.perKg
    row(
      'FUEL',
      `${thousands(fuel)} ${sim.spec.fuelUnit.label}`,
      sim.fuel < sim.spec.fuelCapacity * 0.15 ? AMBER : WHITE
    )
    if (nav.approach) {
      const distance = Math.max(0, nav.guidance.along) / METRES_PER_NM
      row('APPROACH', `${nav.approach.id}  ${distance.toFixed(1)} NM`, MAGENTA)
    } else row('APPROACH', 'NONE', '#56606a')
    if (bombs.missiles > 0) row('MISSILES', String(bombs.missiles), CYAN)
    else if (bombs.loaded > 0 || game.getState().bombsight) {
      const ready =
        bombs.armed >= 0 ? 'ARMED' : game.getState().bombsight ? 'SIGHT ON' : 'SIGHT OFF'
      row('BOMBS', `${bombs.loaded}  ${ready}`, CYAN)
    }
  }
}
