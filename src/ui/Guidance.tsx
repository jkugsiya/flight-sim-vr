import { useCallback, useRef } from 'react'
import { game } from '../game/game'
import { WARNINGS } from '../game/gpws'
import type { FlightSim } from '../sim/flight-sim'
import { DEGREES, FEET_PER_METRE, setText, thousands, useTelemetry } from './telemetry'

const METRES_PER_NM = 1852
const MAGENTA = '#e06bf0'
// Bank angles marked on the scale, in degrees
const BANK_TICKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]
// Within this bank the wings count as level, in degrees
const LEVEL = 2.5

/**
 * Bank angle arc for the chase view. The pointer and the small aircraft tilt with the wings,
 * and the hint names the way to roll to level them.
 */
export function BankIndicator() {
  const pointer = useRef<SVGGElement>(null)
  const plane = useRef<SVGGElement>(null)
  const readout = useRef<SVGTextElement>(null)
  const box = useRef<SVGSVGElement>(null)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      // Nothing to level while the wheels are on the ground
      box.current?.setAttribute('visibility', sim.onGround ? 'hidden' : 'visible')
      const bank = sim.bank * DEGREES
      const shown = Math.max(-70, Math.min(70, bank))
      pointer.current?.setAttribute('transform', `rotate(${shown.toFixed(1)})`)
      plane.current?.setAttribute('transform', `rotate(${shown.toFixed(1)})`)
      const size = Math.abs(bank)
      const level = size < LEVEL
      // Colour shifts from green when level to amber in steep turns and red past 60°
      const tone = level ? 'level' : size < 30 ? 'turn' : size < 60 ? 'steep' : 'danger'
      if (box.current) box.current.dataset.tone = tone
      const side = bank > 0 ? 'right' : 'left'
      const toward = bank > 0 ? 'left' : 'right'
      setText(
        readout.current,
        level ? 'Wings level' : `${Math.round(size)}° ${side} · roll ${toward} to level`
      )
    }, [])
  )
  const radius = 92
  const point = (degrees: number, distance: number) => {
    const angle = (degrees * Math.PI) / 180
    return [Math.sin(angle) * distance, -Math.cos(angle) * distance] as const
  }
  return (
    <svg
      ref={box}
      viewBox="-150 -112 300 130"
      className="group w-60 opacity-90 drop-shadow-[0_1px_2px_rgb(0_0_0/0.7)]"
      role="img"
      aria-label="Bank angle"
    >
      {/* Fixed scale */}
      <path
        d={`M ${point(-60, radius).join(' ')} A ${radius} ${radius} 0 0 1 ${point(60, radius).join(' ')}`}
        fill="none"
        stroke="white"
        strokeOpacity="0.7"
        strokeWidth="1.5"
      />
      {BANK_TICKS.map(tick => {
        const long = tick % 30 === 0
        const [x1, y1] = point(tick, radius)
        const [x2, y2] = point(tick, radius + (long ? 11 : 6))
        return (
          <line
            key={tick}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="white"
            strokeWidth={tick === 0 ? 3 : long ? 2 : 1.4}
          />
        )
      })}
      {/* Moving pointer, like the sky pointer of an attitude indicator */}
      <g ref={pointer}>
        <path
          d={`M 0 ${-radius + 2} l -7 12 h 14 z`}
          className="fill-white stroke-none transition-colors group-data-[tone=danger]:fill-[#ff5a4a] group-data-[tone=level]:fill-[#4be36f] group-data-[tone=steep]:fill-[#f2a93b]"
        />
      </g>
      {/* Wings, tilting with the aircraft against a fixed horizon line */}
      <line x1="-70" x2="70" y1="-38" y2="-38" stroke="white" strokeOpacity="0.35" />
      <g transform="translate(0 -38)">
        <g ref={plane}>
          <path
            d="M -46 0 H -12 L -6 6 H 6 L 12 0 H 46 M 0 -4 V -12"
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            className="stroke-white transition-colors group-data-[tone=danger]:stroke-[#ff5a4a] group-data-[tone=level]:stroke-[#4be36f] group-data-[tone=steep]:stroke-[#f2a93b]"
          />
        </g>
      </g>
      <text
        ref={readout}
        y="10"
        textAnchor="middle"
        fontSize="16"
        fontWeight="bold"
        fill="white"
        className="tabular-nums"
      />
    </svg>
  )
}

/** Plain-language steering hint from a deviation in dots. */
function hint(dots: number, positive: string, negative: string, centred: string) {
  if (Math.abs(dots) < 0.4) return centred
  return dots > 0 ? positive : negative
}

/**
 * Approach guidance for every cockpit: the selected approach, the next waypoint, and a
 * course deviation indicator. Needles show where the course and glide path lie.
 */
export function ApproachCard() {
  const card = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLSpanElement>(null)
  const airport = useRef<HTMLSpanElement>(null)
  const fix = useRef<HTMLSpanElement>(null)
  const fixDetail = useRef<HTMLSpanElement>(null)
  const runway = useRef<HTMLSpanElement>(null)
  const lateral = useRef<SVGGElement>(null)
  const vertical = useRef<SVGGElement>(null)
  const flags = useRef<SVGTextElement>(null)
  const steer = useRef<HTMLSpanElement>(null)
  const mode = useRef<HTMLSpanElement>(null)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      const { nav, pilot } = game
      const { approach } = nav
      if (!card.current) return
      card.current.hidden = !approach
      if (!approach) return
      const guidance = nav.guidance
      const plan = nav.enroute ? nav.plan : null
      const next = nav.next ?? approach.fixes[nav.active]
      // On the route the card names the destination; on the approach, the approach
      setText(
        title.current,
        plan ? `To ${plan.to.code}` : approach.id.replace(` ${approach.end.airport.code}`, '')
      )
      setText(airport.current, plan ? `then ${approach.id}` : approach.end.airport.name)
      setText(fix.current, next.role === 'RWY' ? `Runway ${approach.end.designator}` : next.name)
      const toFix = Math.hypot(next.x - sim.position.x, next.z - sim.position.z) / METRES_PER_NM
      const crossAt = Math.round((next.altitude * FEET_PER_METRE) / 100) * 100
      setText(
        fixDetail.current,
        `${next.role === 'RWY' ? '' : `${next.role} · `}${toFix.toFixed(1)} NM · cross ${thousands(crossAt)} ft`
      )
      // Straight-line distance, which stays right when the runway is behind or off to one side
      const { end } = approach
      const toRunway = Math.hypot(end.x - sim.position.x, end.z - sim.position.z) / METRES_PER_NM
      const cruise = plan ? Math.round((plan.cruise * FEET_PER_METRE) / 100) * 100 : 0
      setText(
        runway.current,
        plan
          ? `Cruise ${thousands(cruise)} ft`
          : `Runway ${toRunway.toFixed(1)} NM · glide ${(approach.glide * DEGREES).toFixed(1)}°`
      )
      const receiving = guidance.receiving
      lateral.current?.setAttribute(
        'transform',
        `translate(${(guidance.lateral * 18).toFixed(1)} 0)`
      )
      vertical.current?.setAttribute(
        'transform',
        `translate(0 ${(-guidance.vertical * 18).toFixed(1)})`
      )
      lateral.current?.setAttribute('visibility', receiving ? 'visible' : 'hidden')
      vertical.current?.setAttribute('visibility', receiving ? 'visible' : 'hidden')
      setText(flags.current, receiving ? '' : approach.kind === 'ILS' ? 'NO SIGNAL' : '')
      if (plan) {
        const following = pilot.autopilot.on && pilot.autopilot.lateral === 'NAV'
        setText(
          steer.current,
          following ? 'Autopilot following the route' : `Fly to ${next.name}, or press J`
        )
      } else if (!receiving) setText(steer.current, 'Fly toward the airport to pick up the beams')
      else if (!nav.onFinal) setText(steer.current, `Fly to ${next.name} first`)
      else {
        const side = hint(guidance.lateral, 'Steer right', 'Steer left', 'On course')
        const slope = hint(guidance.vertical, 'too low', 'too high', 'on the glide path')
        setText(steer.current, `${side}, ${slope}`)
      }
      const flying = pilot.flyingApproach
      setText(
        mode.current,
        flying ? 'Autopilot is flying it. T hands back control' : 'T lets the autopilot fly it'
      )
      if (mode.current) mode.current.dataset.on = String(flying)
    }, [])
  )
  return (
    <div
      ref={card}
      hidden
      className="bg-ink/80 text-marking w-76 rounded-md px-3 py-2 shadow-lg backdrop-blur-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span ref={title} className="text-lg font-bold" style={{ color: MAGENTA }} />
        <span ref={airport} className="text-marking/60 truncate text-xs" />
      </div>
      <div className="mt-1 flex gap-3">
        <svg viewBox="-50 -50 100 100" className="size-24 shrink-0" role="img">
          <title>Course and glide path deviation</title>
          <rect x="-48" y="-48" width="96" height="96" rx="8" fill="#06080a" />
          {[-2, -1, 1, 2].map(dot => (
            <g key={dot} fill="none" stroke="white" strokeWidth="1.2">
              <circle cx={dot * 18} cy="40" r="2.6" />
              <circle cx="40" cy={dot * 18} r="2.6" />
            </g>
          ))}
          {/* Centre marks: the aircraft is where the lines cross */}
          <path d="M -6 0 H 6 M 0 -6 V 6" stroke="#f2a93b" strokeWidth="2" />
          <g ref={lateral}>
            <line y1="-36" y2="36" stroke={MAGENTA} strokeWidth="3" />
            <path d="M 0 33 l -5 7 l 5 7 l 5 -7 z" fill={MAGENTA} />
          </g>
          <g ref={vertical}>
            <line x1="-36" x2="36" stroke={MAGENTA} strokeWidth="3" />
            <path d="M 33 0 l 7 -5 l 7 5 l -7 5 z" fill={MAGENTA} />
          </g>
          <text ref={flags} y="-28" textAnchor="middle" fontSize="9" fill="#ff5a4a" />
        </svg>
        <div className="flex min-w-0 flex-col justify-center gap-0.5 text-sm leading-tight">
          <span className="text-marking/60 text-xs">Next waypoint</span>
          <span ref={fix} className="text-base font-bold" style={{ color: MAGENTA }} />
          <span ref={fixDetail} className="text-xs tabular-nums" />
          <span ref={runway} className="text-marking/80 mt-1 text-xs tabular-nums" />
        </div>
      </div>
      <span ref={steer} className="mt-1.5 block text-sm font-bold" />
      <span ref={mode} className="text-marking/60 data-[on=true]:text-go block text-xs" />
    </div>
  )
}

/** Ground proximity alert: red and flashing for a warning, amber for a caution. */
export function GpwsAlert() {
  const box = useRef<HTMLDivElement>(null)
  useTelemetry(
    useCallback(() => {
      const element = box.current
      if (!element) return
      const { alert } = game.gpws
      element.hidden = alert === null
      if (!alert) return
      setText(element, alert)
      element.dataset.warning = String(WARNINGS.has(alert))
    }, [])
  )
  return (
    <div
      ref={box}
      role="alert"
      hidden
      className="bg-amber text-ink data-[warning=true]:bg-warn rounded-md border-2 border-black/40 px-5 py-1 text-2xl font-black tracking-widest shadow-lg data-[warning=true]:animate-pulse data-[warning=true]:text-white"
    />
  )
}
