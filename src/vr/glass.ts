import { game } from '../game/game'
import type { AircraftSpec } from '../sim/aircraft'
import { LAMPS, ROTORLESS_LAMPS } from '../ui/lamps'
import { DEGREES, FEET_PER_METRE, KNOTS_PER_MS, thousands } from '../ui/telemetry'
import { AIRPORTS } from '../world/island'
import { drawFlightDisplay } from './displays'

/*
 * Glass cockpit screens, each a painter for a canvas `w` by `h` pixels. They read the
 * aircraft and the game directly, and are redrawn a dozen or so times a second.
 */

const WHITE = '#e8ecef'
const GREEN = '#4be36f'
const AMBER = '#f2a93b'
const RED = '#ff4b3a'
const MAGENTA = '#e06bf0'
const CYAN = '#4fd3ff'
const DIM = '#56606a'
const FONT = 'system-ui, sans-serif'
const METRES_PER_NM = 1852

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

/** No power: the screen is dark. Returns true when the painter should stop. */
function dark(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#05070a'
  ctx.fillRect(0, 0, w, h)
  return !game.sim.powered
}

/** The primary flight display, on a square screen. */
export function primaryFlight(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const s = Math.min(w, h)
  ctx.save()
  ctx.translate((w - s) / 2, (h - s) / 2)
  drawFlightDisplay(ctx, s)
  ctx.restore()
}

/**
 * Navigation display in arc mode: the compass arc ahead, the route in magenta, nearby
 * airports in cyan, and the next waypoint, ground speed, and wind across the top.
 */
export function navigationDisplay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  if (dark(ctx, w, h)) return
  const { sim, nav } = game
  const heading = sim.heading
  const cx = w / 2
  const cy = h * 0.82
  const radius = h * 0.7
  // The range grows with height, from 10 NM low down to 80 NM at cruise
  const ranges = [10, 20, 40, 80]
  const feet = sim.position.y * FEET_PER_METRE
  const range = ranges[feet < 4000 ? 0 : feet < 12000 ? 1 : feet < 25000 ? 2 : 3]
  const perMetre = radius / (range * METRES_PER_NM)
  // World point to screen, heading up
  const place = (x: number, z: number) => {
    const dx = x - sim.position.x
    const dz = z - sim.position.z
    const right = dx * Math.cos(heading) + dz * Math.sin(heading)
    const ahead = dx * Math.sin(heading) - dz * Math.cos(heading)
    return [cx + right * perMetre, cy - ahead * perMetre] as const
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, h * 0.1, w, h * 0.9)
  ctx.clip()
  // Airports in range
  for (const airport of AIRPORTS) {
    const [x, y] = place(airport.x, airport.z)
    if (Math.hypot(x - cx, y - cy) > radius * 1.05) continue
    ctx.strokeStyle = CYAN
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x, y, h * 0.012, 0, Math.PI * 2)
    ctx.stroke()
    text(ctx, airport.code, x + h * 0.02, y - h * 0.02, h * 0.035, CYAN, 'left')
  }
  // The route and approach, the waypoint ahead in magenta
  const points = nav.waypoints
  if (points.length > 0) {
    ctx.strokeStyle = MAGENTA
    ctx.lineWidth = 3
    ctx.beginPath()
    const ahead = nav.waypointAhead
    const [sx, sy] = place(sim.position.x, sim.position.z)
    ctx.moveTo(sx, sy)
    for (let i = ahead; i < points.length; i++) {
      const [x, y] = place(points[i].x, points[i].z)
      ctx.lineTo(x, y)
    }
    ctx.stroke()
    points.forEach((fix, i) => {
      if (i < ahead) return
      const [x, y] = place(fix.x, fix.z)
      const color = i === ahead ? MAGENTA : WHITE
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(x, y - h * 0.014)
      ctx.lineTo(x + h * 0.014, y)
      ctx.lineTo(x, y + h * 0.014)
      ctx.lineTo(x - h * 0.014, y)
      ctx.fill()
      text(ctx, fix.name, x + h * 0.02, y + h * 0.02, h * 0.032, color, 'left')
    })
  }
  ctx.restore()

  // Range ring and compass arc
  ctx.strokeStyle = WHITE
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, radius, Math.PI * 1.17, Math.PI * 1.83)
  ctx.stroke()
  ctx.setLineDash([6, 8])
  ctx.beginPath()
  ctx.arc(cx, cy, radius / 2, Math.PI * 1.17, Math.PI * 1.83)
  ctx.stroke()
  ctx.setLineDash([])
  text(ctx, String(range / 2), cx - radius * 0.47, cy - radius * 0.2, h * 0.03, DIM)
  const headingDegrees = heading * DEGREES
  for (let d = Math.ceil((headingDegrees - 55) / 5) * 5; d <= headingDegrees + 55; d += 5) {
    const a = (d - headingDegrees) / DEGREES - Math.PI / 2
    const long = d % 10 === 0
    const inner = radius * (long ? 0.95 : 0.975)
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius)
    ctx.stroke()
    if (d % 30 === 0) {
      const label = String((((d % 360) + 360) % 360) / 10)
      text(ctx, label, cx + Math.cos(a) * radius * 0.89, cy + Math.sin(a) * radius * 0.89, h * 0.04)
    }
  }
  // Heading box, and the aircraft symbol
  ctx.fillStyle = '#05070a'
  ctx.fillRect(cx - w * 0.07, cy - radius - h * 0.07, w * 0.14, h * 0.055)
  ctx.strokeRect(cx - w * 0.07, cy - radius - h * 0.07, w * 0.14, h * 0.055)
  text(
    ctx,
    String(Math.round(headingDegrees) % 360).padStart(3, '0'),
    cx,
    cy - radius - h * 0.042,
    h * 0.045
  )
  ctx.strokeStyle = '#ffd400'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(cx, cy - h * 0.04)
  ctx.lineTo(cx, cy + h * 0.04)
  ctx.moveTo(cx - h * 0.04, cy - h * 0.005)
  ctx.lineTo(cx + h * 0.04, cy - h * 0.005)
  ctx.moveTo(cx - h * 0.015, cy + h * 0.035)
  ctx.lineTo(cx + h * 0.015, cy + h * 0.035)
  ctx.stroke()

  // Top line: ground speed and true airspeed, wind, and the waypoint ahead
  const gs = Math.round(sim.groundSpeed * KNOTS_PER_MS)
  const tas = Math.round(sim.trueAirspeed * KNOTS_PER_MS)
  text(ctx, `GS ${gs}  TAS ${tas}`, w * 0.03, h * 0.04, h * 0.038, WHITE, 'left')
  const wind = game.wind
  const knots = Math.round(Math.hypot(wind.x, wind.z) * KNOTS_PER_MS)
  if (knots > 0) {
    const from = Math.round((Math.atan2(-wind.x, wind.z) * DEGREES + 360) % 360)
    text(
      ctx,
      `${String(from).padStart(3, '0')}°/${knots}`,
      w * 0.03,
      h * 0.09,
      h * 0.034,
      WHITE,
      'left'
    )
  }
  const fix = points[nav.waypointAhead]
  if (fix) {
    const distance = Math.hypot(fix.x - sim.position.x, fix.z - sim.position.z) / METRES_PER_NM
    text(ctx, fix.name, w * 0.97, h * 0.04, h * 0.04, MAGENTA, 'right')
    text(ctx, `${distance.toFixed(1)} NM`, w * 0.97, h * 0.09, h * 0.036, WHITE, 'right')
  }
  if (nav.approach) text(ctx, nav.approach.id, w * 0.97, h * 0.95, h * 0.035, MAGENTA, 'right')
}

/**
 * Engine display, after a Boeing EICAS or an Airbus E/WD: a round thrust gauge per engine,
 * exhaust temperature, fuel flow, flaps, gear, fuel, and the warning list.
 */
export function engineDisplay(spec: AircraftSpec) {
  const lamps = LAMPS.filter(lamp => !(spec.rotor && ROTORLESS_LAMPS.has(lamp.label)))
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    if (dark(ctx, w, h)) return
    const { sim, pilot } = game
    const c = pilot.controls
    const engines = sim.engines
    const columns = Math.max(2, engines.length)
    const cell = w / columns
    const radius = Math.min(cell * 0.36, h * 0.13)
    engines.forEach((engine, i) => {
      const x = cell * (i + 0.5)
      const y = h * 0.2
      const share = Math.min(1.1, engine.rpm / 100)
      ctx.lineWidth = Math.max(2, h * 0.012)
      ctx.strokeStyle = '#2a3238'
      ctx.beginPath()
      ctx.arc(x, y, radius, Math.PI, Math.PI * 2.2)
      ctx.stroke()
      ctx.strokeStyle = engine.fire ? RED : engine.running ? WHITE : AMBER
      ctx.beginPath()
      ctx.arc(x, y, radius, Math.PI, Math.PI * (1 + 1.2 * share))
      ctx.stroke()
      // Throttle lever position as a cyan mark on the arc
      const lever = Math.PI * (1 + 1.2 * c.throttle)
      ctx.fillStyle = CYAN
      ctx.beginPath()
      ctx.arc(x + Math.cos(lever) * radius, y + Math.sin(lever) * radius, h * 0.008, 0, Math.PI * 2)
      ctx.fill()
      const label = engine.fire
        ? 'FIRE'
        : engine.starting > 0
          ? 'START'
          : engine.running
            ? engine.rpm.toFixed(1)
            : 'OFF'
      text(ctx, label, x, y + radius * 0.15, h * 0.05, engine.fire ? RED : WHITE)
      // Exhaust temperature as a bar, hotter with power
      const egt = engine.running ? 0.35 + 0.55 * engine.power : engine.starting > 0 ? 0.4 : 0
      ctx.fillStyle = '#2a3238'
      ctx.fillRect(x - cell * 0.3, h * 0.38, cell * 0.6, h * 0.025)
      ctx.fillStyle = egt > 0.95 ? RED : GREEN
      ctx.fillRect(x - cell * 0.3, h * 0.38, cell * 0.6 * egt, h * 0.025)
      const flow = engine.running
        ? Math.round(
            (spec.fuelBurnIdle + (spec.fuelBurnFull - spec.fuelBurnIdle) * engine.power) * 3600
          )
        : 0
      text(ctx, `FF ${thousands(flow)}`, x, h * 0.45, h * 0.035, GREEN)
    })
    text(ctx, sim.spec.engine.type === 'jet' ? 'N1 %' : 'TQ %', w / 2, h * 0.06, h * 0.035, DIM)
    text(ctx, 'EGT', w * 0.04, h * 0.39, h * 0.03, DIM, 'left')

    // Flaps, gear, fuel, speed brake
    let y = h * 0.55
    const row = (label: string, value: string, color = WHITE) => {
      text(ctx, label, w * 0.05, y, h * 0.04, DIM, 'left')
      text(ctx, value, w * 0.5, y, h * 0.04, color, 'left')
      y += h * 0.06
    }
    if (spec.flapLabels.length > 1) {
      const moving = Math.abs(sim.flapPosition * (spec.flapLabels.length - 1) - c.flapNotch) > 0.05
      row(spec.flapName.toUpperCase(), spec.flapLabels[c.flapNotch], moving ? AMBER : GREEN)
    }
    if (spec.retractableGear) {
      const g = sim.gearPosition
      row(
        'GEAR',
        g >= 0.99 ? 'DOWN ▮▮▮' : g <= 0.01 ? 'UP' : 'TRANSIT',
        g >= 0.99 ? GREEN : g <= 0.01 ? WHITE : AMBER
      )
    }
    row(
      'FUEL',
      `${thousands(sim.fuel * spec.fuelUnit.perKg)} ${spec.fuelUnit.label}`,
      sim.fuel < spec.fuelCapacity * 0.15 ? AMBER : GREEN
    )
    if (sim.speedBrakePosition > 0.05) row('SPD BRK', 'EXT', AMBER)

    // Warnings in red, cautions in amber, as the crew alerting list
    let alerts = 0
    for (const lamp of lamps) {
      if (lamp.label === 'NO POWER' || !lamp.on(sim, c)) continue
      if (lamp.present && !lamp.present(sim)) continue
      const x = w * 0.72
      text(
        ctx,
        lamp.label,
        x,
        h * 0.55 + alerts * h * 0.055,
        h * 0.038,
        lamp.kind === 'warning' ? RED : AMBER,
        'left'
      )
      if (++alerts > 7) break
    }
  }
}

/**
 * Helicopter engine and rotor display: torque for each engine, rotor speed, and the
 * collective, as on the Black Hawk's displays.
 */
export function helicopterDisplay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  if (dark(ctx, w, h)) return
  const { sim, pilot } = game
  const bar = (label: string, x: number, share: number, color: string, value: string) => {
    const top = h * 0.12
    const height = h * 0.62
    ctx.fillStyle = '#20262c'
    ctx.fillRect(x - w * 0.06, top, w * 0.12, height)
    const fill = Math.max(0, Math.min(1.1, share)) / 1.1
    ctx.fillStyle = share > 1 ? RED : color
    ctx.fillRect(x - w * 0.06, top + height * (1 - fill), w * 0.12, height * fill)
    // 100% mark
    ctx.fillStyle = WHITE
    ctx.fillRect(x - w * 0.07, top + height * (1 - 1 / 1.1), w * 0.14, 2)
    text(ctx, label, x, h * 0.06, h * 0.045, DIM)
    text(ctx, value, x, h * 0.82, h * 0.05)
  }
  sim.engines.forEach((engine, i) => {
    bar(`TRQ ${i + 1}`, w * (0.18 + i * 0.2), engine.rpm / 100, GREEN, `${Math.round(engine.rpm)}%`)
  })
  bar('NR', w * 0.66, sim.rotorSpeed, GREEN, `${Math.round(sim.rotorSpeed * 100)}%`)
  bar(
    'COLL',
    w * 0.86,
    pilot.controls.throttle,
    CYAN,
    `${Math.round(pilot.controls.throttle * 100)}`
  )
  const low = sim.rotorSpeed < 0.95 && sim.enginesRunning > 0
  if (low) text(ctx, 'LOW ROTOR RPM', w / 2, h * 0.93, h * 0.05, RED)
}

/**
 * A fighter's radar page: a plan view ahead out to 20 NM with each enemy, the locked one
 * boxed, and the missiles left.
 */
export function radarDisplay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  if (dark(ctx, w, h)) return
  const { sim, combat } = game
  const cx = w / 2
  const cy = h * 0.92
  const radius = h * 0.82
  const range = 20 * METRES_PER_NM
  ctx.strokeStyle = '#2f6b3a'
  ctx.lineWidth = 2
  for (const share of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath()
    ctx.arc(cx, cy, radius * share, Math.PI * 1.2, Math.PI * 1.8)
    ctx.stroke()
  }
  text(ctx, 'FCR  20', w * 0.04, h * 0.05, h * 0.045, GREEN, 'left')
  text(ctx, `MSL ${combat.ammo}`, w * 0.96, h * 0.05, h * 0.045, GREEN, 'right')
  const heading = sim.heading
  combat.enemies.forEach((enemy, i) => {
    if (!enemy.alive) return
    const dx = enemy.position.x - sim.position.x
    const dz = enemy.position.z - sim.position.z
    const right = dx * Math.cos(heading) + dz * Math.sin(heading)
    const ahead = dx * Math.sin(heading) - dz * Math.cos(heading)
    if (ahead < 0 || Math.hypot(right, ahead) > range) return
    const x = cx + (right / range) * radius
    const y = cy - (ahead / range) * radius
    ctx.fillStyle = combat.lock === i ? '#ffd400' : WHITE
    ctx.fillRect(x - h * 0.012, y - h * 0.012, h * 0.024, h * 0.024)
    if (combat.lock === i) {
      ctx.strokeStyle = '#ffd400'
      ctx.strokeRect(x - h * 0.03, y - h * 0.03, h * 0.06, h * 0.06)
    }
  })
  if (combat.warning) text(ctx, 'MISSILE LAUNCH', cx, h * 0.15, h * 0.06, RED)
}

/**
 * A head-up display's symbology, drawn on a transparent glass in green. It is conformal:
 * the pitch lines sit on the real horizon, given the glass's angular width in degrees.
 */
export function headUpDisplay(fieldDegrees: number) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(0, 0, w, h)
    const { sim, combat } = game
    if (!sim.powered) return
    const perDegree = w / fieldDegrees
    const cx = w / 2
    const cy = h / 2
    const color = '#3dff6e'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = Math.max(2, w * 0.005)
    // Pitch ladder, rolled with the aircraft
    ctx.save()
    ctx.beginPath()
    ctx.rect(w * 0.12, h * 0.1, w * 0.76, h * 0.8)
    ctx.clip()
    ctx.translate(cx, cy)
    ctx.rotate(-sim.bank)
    const pitch = sim.pitch * DEGREES
    for (let deg = -90; deg <= 90; deg += 5) {
      const y = (pitch - deg) * perDegree
      if (Math.abs(y) > h) continue
      const width = deg === 0 ? w * 0.5 : w * 0.14
      if (deg < 0) ctx.setLineDash([w * 0.015, w * 0.01])
      ctx.beginPath()
      ctx.moveTo(-width, y)
      ctx.lineTo(-w * 0.04, y)
      ctx.moveTo(w * 0.04, y)
      ctx.lineTo(width, y)
      ctx.stroke()
      ctx.setLineDash([])
      if (deg !== 0) text(ctx, String(Math.abs(deg)), width + w * 0.03, y, h * 0.04, color)
    }
    ctx.restore()
    // Flight path marker: where the aircraft is going, from its velocity
    const v = sim.velocity
    const speed = Math.hypot(v.x, v.y, v.z)
    if (speed > 5) {
      const climb = Math.asin(v.y / speed) * DEGREES
      const track = Math.atan2(v.x, -v.z)
      const drift = (((track - sim.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * DEGREES
      const x = cx + drift * perDegree
      const y = cy + (pitch - climb) * perDegree
      ctx.beginPath()
      ctx.arc(x, y, w * 0.018, 0, Math.PI * 2)
      ctx.moveTo(x - w * 0.045, y)
      ctx.lineTo(x - w * 0.018, y)
      ctx.moveTo(x + w * 0.018, y)
      ctx.lineTo(x + w * 0.045, y)
      ctx.moveTo(x, y - w * 0.018)
      ctx.lineTo(x, y - w * 0.035)
      ctx.stroke()
    }
    // Speed left, altitude right, heading across the top, g and Mach below the speed
    text(
      ctx,
      String(Math.round(sim.indicatedAirspeed * KNOTS_PER_MS)),
      w * 0.1,
      cy,
      h * 0.06,
      color
    )
    text(
      ctx,
      thousands(Math.round((sim.position.y * FEET_PER_METRE) / 10) * 10),
      w * 0.9,
      cy,
      h * 0.06,
      color
    )
    text(
      ctx,
      String(Math.round(sim.heading * DEGREES) % 360).padStart(3, '0'),
      cx,
      h * 0.07,
      h * 0.055,
      color
    )
    text(ctx, `G ${sim.gLoad.toFixed(1)}`, w * 0.1, cy + h * 0.1, h * 0.045, color)
    if (sim.mach > 0.4)
      text(ctx, `M ${sim.mach.toFixed(2)}`, w * 0.1, cy + h * 0.17, h * 0.045, color)
    if (combat.active) text(ctx, `MSL ${combat.ammo}`, w * 0.9, cy + h * 0.1, h * 0.045, color)
    if (sim.stallWarning) text(ctx, 'AOA', cx, h * 0.85, h * 0.06, color)
    // Boresight cross
    ctx.beginPath()
    ctx.moveTo(cx - w * 0.02, cy - h * 0.12)
    ctx.lineTo(cx + w * 0.02, cy - h * 0.12)
    ctx.moveTo(cx, cy - h * 0.12 - w * 0.02)
    ctx.lineTo(cx, cy - h * 0.12 + w * 0.02)
    ctx.stroke()
  }
}
