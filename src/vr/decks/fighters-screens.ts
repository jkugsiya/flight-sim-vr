import { game } from '../../game/game'
import type { AircraftSpec } from '../../sim/aircraft'
import { LAMPS } from '../../ui/lamps'
import { DEGREES, FEET_PER_METRE, KNOTS_PER_MS, thousands } from '../../ui/telemetry'
import {
  engineDisplay,
  headUpDisplay,
  navigationDisplay,
  primaryFlight,
  radarDisplay
} from '../glass'

/*
 * Screen painters for the F-16 and F-35 cockpits: the F-16's data entry display, warning
 * lights, and stores page, the F-35's panoramic display, and a head-up display whose
 * glass sits below the line of sight.
 */

type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number) => void

const FONT = 'ui-monospace, Menlo, monospace'
const SANS = 'Arial Narrow, Roboto Condensed, system-ui, sans-serif'
const DED_GREEN = '#b6ff4a'
const GREEN = '#4be36f'
const WHITE = '#e8ecef'
const AMBER = '#f2a93b'
const RED = '#ff4b3a'
const DIM = '#56606a'
const CYAN = '#4fd3ff'

const lamp = (label: string) => {
  const found = LAMPS.find(each => each.label === label)
  if (!found)
    throw new Error(`The warning lamp ${label} is missing, so the fighter panel cannot show it`)
  return found
}
const LAMP_FIRE = lamp('FIRE')
const LAMP_ENGINE = lamp('ENGINE OFF')
const LAMP_HYDRAULICS = lamp('HYD FAIL')
const LAMP_DAMAGE = lamp('DAMAGE')
const LAMP_GEAR_UP = lamp('GEAR UP')
const LAMP_FUEL = lamp('LOW FUEL')
const LAMP_STALL = lamp('STALL')
const LAMP_MISSILE = lamp('MISSILE')

/** Missiles left, from the air combat or the mission's own load. */
export function missilesLeft() {
  const { combat, bombs } = game
  return combat.active ? combat.ammo : bombs.missiles
}

/**
 * A head-up display on a glass whose centre sits `below` degrees under the line of sight,
 * across `fieldDegrees`. The symbology shifts up so its horizon stays on the real one.
 */
export function offsetHeadUp(fieldDegrees: number, below: number): Painter {
  const paint = headUpDisplay(fieldDegrees)
  return (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.translate(0, -below * (w / fieldDegrees))
    paint(ctx, w, h)
    ctx.restore()
  }
}

/** The F-16's data entry display: radio, steerpoint, and flight data in green. */
export function dataEntryDisplay(spec: AircraftSpec): Painter {
  return (ctx, w, h) => {
    ctx.fillStyle = '#060805'
    ctx.fillRect(0, 0, w, h)
    const { sim, nav, pilot } = game
    if (!sim.powered) return
    ctx.fillStyle = DED_GREEN
    ctx.font = `600 ${h * 0.2}px ${FONT}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const fix = nav.waypoints[nav.waypointAhead]
    const distance = fix ? Math.hypot(fix.x - sim.position.x, fix.z - sim.position.z) / 1852 : 0
    const heading = String(Math.round(sim.heading * DEGREES + 360) % 360).padStart(3, '0')
    const fuel = thousands(Math.round((sim.fuel * spec.fuelUnit.perKg) / 10) * 10)
    const lines = [
      `UHF 251.00   STPT ${fix ? fix.name : '---'}`,
      `HDG ${heading}   ${fix ? `${distance.toFixed(1)} NM` : 'NO ROUTE'}`,
      `ALT ${thousands(Math.round((sim.position.y * FEET_PER_METRE) / 10) * 10)}  M ${sim.mach.toFixed(2)}`,
      `FUEL ${fuel}  AP ${pilot.autopilot.on ? 'ON' : 'OFF'}`
    ]
    lines.forEach((line, i) => {
      ctx.fillText(line, w * 0.04, h * (0.14 + i * 0.24), w * 0.92)
    })
  }
}

/** One lamp in a warning light panel: its legend, colour, and when it lights. */
type Light = { legend: string; color: string; on: () => boolean }

/** The F-16's right eyebrow warning lights, in two columns. */
export const EYEBROW_LIGHTS: Light[] = [
  { legend: 'ENG FIRE', color: RED, on: () => LAMP_FIRE.on(game.sim, game.pilot.controls) },
  { legend: 'ENGINE', color: RED, on: () => LAMP_ENGINE.on(game.sim, game.pilot.controls) },
  {
    legend: 'HYD/OIL PRESS',
    color: RED,
    on: () => LAMP_HYDRAULICS.on(game.sim, game.pilot.controls)
  },
  { legend: 'FLCS', color: RED, on: () => LAMP_DAMAGE.on(game.sim, game.pilot.controls) },
  {
    legend: 'TO/LDG CONFIG',
    color: RED,
    on: () => LAMP_GEAR_UP.on(game.sim, game.pilot.controls)
  },
  { legend: 'FUEL LOW', color: AMBER, on: () => LAMP_FUEL.on(game.sim, game.pilot.controls) },
  { legend: 'AOA', color: AMBER, on: () => LAMP_STALL.on(game.sim, game.pilot.controls) },
  { legend: 'MSL LAUNCH', color: RED, on: () => LAMP_MISSILE.on(game.sim, game.pilot.controls) }
]

/** A block of warning lights, each dark until it lights with its legend. */
export function warningLights(lights: Light[], columns: number): Painter {
  const rows = Math.ceil(lights.length / columns)
  return (ctx, w, h) => {
    ctx.fillStyle = '#0b0b0c'
    ctx.fillRect(0, 0, w, h)
    const powered = game.sim.powered
    const cw = w / columns
    const ch = h / rows
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `700 ${ch * 0.42}px ${SANS}`
    lights.forEach((light, i) => {
      const x = (i % columns) * cw
      const y = Math.floor(i / columns) * ch
      const lit = powered && light.on()
      ctx.fillStyle = lit ? light.color : '#1c1d1f'
      ctx.fillRect(x + cw * 0.04, y + ch * 0.08, cw * 0.92, ch * 0.84)
      ctx.fillStyle = lit ? '#1a0505' : '#47494d'
      ctx.fillText(light.legend, x + cw / 2, y + ch / 2, cw * 0.86)
    })
  }
}

/**
 * The stores page: the stations under the wings, missiles left, flares, and whether the
 * master arm switch is armed.
 */
export function storesDisplay(armed: () => boolean): Painter {
  return (ctx, w, h) => {
    ctx.fillStyle = '#05070a'
    ctx.fillRect(0, 0, w, h)
    const { sim, combat, bombs } = game
    if (!sim.powered) return
    const text = (value: string, x: number, y: number, size: number, color = WHITE) => {
      ctx.font = `600 ${size}px ${SANS}`
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(value, x, y)
    }
    text('SMS', w / 2, h * 0.06, h * 0.06, CYAN)
    text(armed() ? 'ARM' : 'SAFE', w / 2, h * 0.16, h * 0.08, armed() ? AMBER : WHITE)
    // Nine stations across, missiles on the wingtips and outer pylons
    const missiles = missilesLeft()
    const stations = [1, 2, 3, 7, 8, 9]
    ctx.strokeStyle = WHITE
    ctx.lineWidth = Math.max(2, h * 0.006)
    ctx.beginPath()
    ctx.moveTo(w * 0.08, h * 0.42)
    ctx.lineTo(w * 0.5, h * 0.32)
    ctx.lineTo(w * 0.92, h * 0.42)
    ctx.stroke()
    stations.forEach((station, i) => {
      const x = w * (0.1 + (station - 1) * 0.1)
      const loaded = i < Math.min(stations.length, missiles)
      ctx.fillStyle = loaded ? GREEN : '#2a3238'
      ctx.fillRect(x - w * 0.015, h * 0.46, w * 0.03, h * 0.14)
      text(String(station), x, h * 0.66, h * 0.045, DIM)
    })
    text('FUEL', w / 2, h * 0.53, h * 0.04, DIM)
    ctx.fillStyle = '#2a3238'
    ctx.fillRect(w * 0.47, h * 0.46, w * 0.06, h * 0.1)
    text(`MSL ${missiles}`, w * 0.27, h * 0.78, h * 0.06, missiles > 0 ? GREEN : DIM)
    text(`BOMB ${bombs.loaded}`, w * 0.73, h * 0.78, h * 0.06, bombs.loaded > 0 ? GREEN : DIM)
    text(`CHAFF/FLARE ${combat.active ? combat.flaresLeft : 0}`, w / 2, h * 0.9, h * 0.05)
  }
}

/** The F-16's right display, which its page buttons switch between stores, engine, and map. */
export function rightDisplay(
  spec: AircraftSpec,
  page: () => 'SMS' | 'ENG' | 'HSD',
  armed: () => boolean
): Painter {
  const pages = {
    SMS: storesDisplay(armed),
    ENG: engineDisplay(spec),
    HSD: navigationDisplay
  }
  return (ctx, w, h) => pages[page()](ctx, w, h)
}

/**
 * The F-35's panoramic cockpit display: one wide touch screen in four portals (radar,
 * flight, tactical map, engine) under a title bar, with the caution and warning strip
 * along the bottom. Portals repaint at their own share of the screen's rate.
 */
export function panoramicDisplay(spec: AircraftSpec, armed: () => boolean): Painter {
  const portals: { title: string; paint: Painter; every: number }[] = [
    { title: 'FCR', paint: radarDisplay, every: 2 },
    { title: 'PFD', paint: primaryFlight, every: 1 },
    { title: 'TSD', paint: navigationDisplay, every: 3 },
    { title: 'ENG', paint: engineDisplay(spec), every: 3 }
  ]
  const alerts = LAMPS.filter(each => each.label !== 'NO POWER')
  let frame = 0
  return (ctx, w, h) => {
    const top = h * 0.08
    const bottom = h * 0.9
    const gap = w * 0.006
    const pw = w / portals.length
    const { sim, pilot } = game
    if (!sim.powered) {
      ctx.fillStyle = '#05070a'
      ctx.fillRect(0, 0, w, h)
      frame = 0
      return
    }
    portals.forEach((portal, i) => {
      if (frame % portal.every !== 0) return
      const x = i * pw + gap
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, top, pw - gap * 2, bottom - top)
      ctx.clip()
      ctx.translate(x, top)
      portal.paint(ctx, pw - gap * 2, bottom - top)
      ctx.restore()
    })
    frame++
    // Title bar with each portal's name, and the strip below
    ctx.fillStyle = '#10161c'
    ctx.fillRect(0, 0, w, top)
    ctx.fillRect(0, bottom, w, h - bottom)
    ctx.font = `700 ${top * 0.6}px ${SANS}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    portals.forEach((portal, i) => {
      ctx.fillStyle = CYAN
      ctx.fillText(portal.title, (i + 0.5) * pw, top / 2)
    })
    ctx.textAlign = 'left'
    ctx.font = `700 ${(h - bottom) * 0.5}px ${SANS}`
    let x = w * 0.01
    const c = pilot.controls
    for (const each of alerts) {
      if (!each.on(sim, c) || (each.present && !each.present(sim))) continue
      ctx.fillStyle = each.kind === 'warning' ? RED : AMBER
      ctx.fillText(each.label, x, (bottom + h) / 2)
      x += ctx.measureText(each.label).width + w * 0.015
      if (x > w * 0.6) break
    }
    ctx.textAlign = 'right'
    ctx.fillStyle = armed() ? AMBER : WHITE
    const speed = Math.round(sim.indicatedAirspeed * KNOTS_PER_MS)
    ctx.fillText(
      `${armed() ? 'ARM' : 'SAFE'}  MSL ${missilesLeft()}   ${speed} KT   FUEL ${thousands(Math.round(sim.fuel * spec.fuelUnit.perKg))}`,
      w * 0.99,
      (bottom + h) / 2
    )
  }
}
