import { useCallback, useEffect, useRef, useState } from 'react'
import { game, useGame } from '../game/game'
import { STORM_CELLS } from '../game/storm'
import type { FlightSim } from '../sim/flight-sim'
import { AIRPORTS, fromStrip, HELIPADS, heightAt, WORLD_SIZE } from '../world/island'
import { DEGREES, useTelemetry } from './telemetry'

// Pixels along one side of the painted map. It is scaled to whatever size is shown.
const RESOLUTION = 720
const SMALL = 240
const LARGE = 500
// Height kept clear for the top bar and the instrument panel when the map is enlarged
const RESERVED_HEIGHT = 460

const mixed = (from: number[], to: number[], share: number) =>
  from.map((channel, i) => channel + (to[i] - channel) * Math.min(1, Math.max(0, share)))

/** Map colour for a ground height in metres: sea by depth, then sand, grass, rock, and snow. */
function mapColor(height: number) {
  if (height < 0) return mixed([62, 148, 178], [30, 96, 138], -height / 30)
  if (height < 4) return [200, 186, 150]
  if (height < 450) return mixed([108, 138, 74], [70, 98, 56], height / 450)
  if (height < 850) return mixed([70, 98, 56], [128, 120, 110], (height - 450) / 250)
  return mixed([128, 120, 110], [238, 240, 244], (height - 850) / 150)
}

/** Paints the whole world from above, north up, with the runways marked. */
function paintMap(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const image = ctx.createImageData(RESOLUTION, RESOLUTION)
  for (let row = 0; row < RESOLUTION; row++) {
    for (let column = 0; column < RESOLUTION; column++) {
      const x = ((column + 0.5) / RESOLUTION - 0.5) * WORLD_SIZE
      const z = ((row + 0.5) / RESOLUTION - 0.5) * WORLD_SIZE
      image.data.set([...mapColor(heightAt(x, z)), 255], (row * RESOLUTION + column) * 4)
    }
  }
  ctx.putImageData(image, 0, 0)

  const toPixel = (metres: number) => (metres / WORLD_SIZE + 0.5) * RESOLUTION
  ctx.lineCap = 'round'
  for (const runway of AIRPORTS.flatMap(airport => airport.runways)) {
    const start = fromStrip(runway, -runway.length / 2, 0)
    const end = fromStrip(runway, runway.length / 2, 0)
    for (const [color, width] of [
      ['#1c2529', 7],
      ['#ffffff', 3]
    ] as const) {
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(toPixel(start.x), toPixel(start.z))
      ctx.lineTo(toPixel(end.x), toPixel(end.z))
      ctx.stroke()
    }
  }
}

const percent = (metres: number) => `${(metres / WORLD_SIZE + 0.5) * 100}%`

/**
 * Every helipad as a white H in a dark circle, on a map `size` pixels across. Airport pads
 * are smaller, since the airport's code already marks the spot.
 */
function HelipadMarks({ size, large }: { size: number; large: boolean }) {
  const at = (metres: number) => ((metres / WORLD_SIZE + 0.5) * size).toFixed(1)
  return HELIPADS.map(pad => {
    const scale = (large ? 1.3 : 1) * (pad.airport ? 0.75 : 1)
    return (
      <g key={pad.id} transform={`translate(${at(pad.x)} ${at(pad.z)}) scale(${scale})`}>
        <circle r="4.5" fill="#1c2529" stroke="#ffffff" strokeWidth="1" />
        <path
          d="M -1.8 -2.4 V 2.4 M 1.8 -2.4 V 2.4 M -1.8 0 H 1.8"
          stroke="#ffffff"
          strokeWidth="1.1"
        />
      </g>
    )
  })
}

/**
 * Map of the whole world with the airports, helipads, the aircraft's position and heading,
 * and other traffic.
 */
export function MiniMap({ large }: { large: boolean }) {
  const storm = useGame(state => state.weather === 'storm')
  const [windowHeight, setWindowHeight] = useState(window.innerHeight)
  useEffect(() => {
    const update = () => setWindowHeight(window.innerHeight)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  // The enlarged map shrinks on short windows so it stays clear of the instrument panel
  const size = large ? Math.max(SMALL, Math.min(LARGE, windowHeight - RESERVED_HEIGHT)) : SMALL
  const canvas = useRef<HTMLCanvasElement>(null)
  const marker = useRef<HTMLDivElement>(null)
  const others = useRef<(HTMLSpanElement | null)[]>([])
  const route = useRef<SVGPolylineElement>(null)
  const fixes = useRef<(SVGCircleElement | null)[]>([])
  const gateDots = useRef<(SVGCircleElement | null)[]>([])
  useEffect(() => {
    if (canvas.current) paintMap(canvas.current)
  }, [])
  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        if (!marker.current) return
        const place = (metres: number) =>
          Math.min(size - 4, Math.max(4, (metres / WORLD_SIZE + 0.5) * size)).toFixed(1)
        const turn = (sim.heading * DEGREES).toFixed(1)
        marker.current.style.transform = `translate(${place(sim.position.x)}px, ${place(sim.position.z)}px) rotate(${turn}deg)`
        // The selected approach as a magenta line, with a dot on each waypoint
        const { waypoints, waypointAhead } = game.nav
        route.current?.setAttribute(
          'points',
          waypoints.map(fix => `${place(fix.x)},${place(fix.z)}`).join(' ')
        )
        fixes.current.forEach((dot, i) => {
          const fix = waypoints[i]
          if (!dot) return
          dot.setAttribute('visibility', fix ? 'visible' : 'hidden')
          if (!fix) return
          dot.setAttribute('cx', place(fix.x))
          dot.setAttribute('cy', place(fix.z))
          dot.setAttribute('r', i === waypointAhead ? '3.5' : '2.2')
        })
        // Mission gates still to fly through, the next one green
        const gates = game.getState().mission?.gates ?? []
        gateDots.current.forEach((dot, i) => {
          const gate = gates[i]
          if (!dot) return
          const showing = gate !== undefined && i >= game.missions.gates
          dot.setAttribute('visibility', showing ? 'visible' : 'hidden')
          if (!showing) return
          dot.setAttribute('cx', place(gate.x))
          dot.setAttribute('cy', place(gate.z))
          dot.setAttribute('fill', i === game.missions.gates ? '#4be36f' : '#f2a93b')
        })
        // Other aircraft in flight show as white dots
        game.traffic.flying.forEach((craft, i) => {
          const dot = others.current[i]
          if (!dot) return
          dot.hidden = !craft.visible
          dot.style.transform = `translate(${place(craft.position.x)}px, ${place(craft.position.z)}px)`
        })
      },
      [size]
    )
  )
  return (
    <div
      className="shadow-ink/40 ring-panel relative overflow-hidden rounded-md shadow-lg ring-2"
      style={{ width: size, height: size }}
    >
      <canvas ref={canvas} width={RESOLUTION} height={RESOLUTION} className="size-full" />
      {/* Storm cells show as weather radar returns: red in the core, amber and green around it */}
      {storm &&
        STORM_CELLS.map(cell => (
          <span
            key={`${cell.x} ${cell.z}`}
            className="absolute aspect-square -translate-1/2 rounded-full bg-[radial-gradient(circle,#e3412f_0%,#f2b33b_30%,#5fbf4ab0_52%,transparent_70%)]"
            style={{
              left: percent(cell.x),
              top: percent(cell.z),
              width: `${((cell.radius * 4) / WORLD_SIZE) * 100}%`
            }}
          />
        ))}
      <span className="absolute top-1 left-1.5 text-xs font-bold text-white drop-shadow">N ↑</span>
      <span className="absolute right-1.5 bottom-1 text-xs text-white/85 drop-shadow">
        <kbd className="font-sans font-bold">M</kbd> {large ? 'hides the map' : 'enlarges the map'}
      </span>
      <svg
        className="absolute inset-0 size-full"
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <HelipadMarks size={size} large={large} />
        <polyline ref={route} fill="none" stroke="#e06bf0" strokeWidth="2" strokeLinejoin="round" />
        {Array.from({ length: 16 }, (_, i) => i).map(i => (
          <circle
            key={i}
            ref={dot => {
              fixes.current[i] = dot
            }}
            fill="#e06bf0"
            stroke="#1c2529"
            visibility="hidden"
          />
        ))}
        {Array.from({ length: 16 }, (_, i) => i).map(i => (
          <circle
            key={`gate-${i}`}
            ref={dot => {
              gateDots.current[i] = dot
            }}
            r="4"
            stroke="#1c2529"
            strokeWidth="1.5"
            visibility="hidden"
          />
        ))}
      </svg>
      {AIRPORTS.map(airport => (
        <span
          key={airport.code}
          className="absolute -translate-y-full pl-1.5 leading-none font-bold text-white [text-shadow:0_0_3px_#1c2529,0_0_3px_#1c2529]"
          style={{
            left: percent(airport.x),
            top: percent(airport.z),
            fontSize: large ? 13 : 9
          }}
        >
          {airport.code}
        </span>
      ))}
      {game.traffic.flying.map((craft, i) => (
        <span
          key={craft.shape.accent}
          ref={dot => {
            others.current[i] = dot
          }}
          className="ring-ink absolute -top-0.75 -left-0.75 size-1.5 rounded-full bg-white ring-1"
        />
      ))}
      <div ref={marker} className="absolute top-0 left-0 size-0">
        <svg
          viewBox="-10 -10 20 20"
          className="absolute -top-2.5 -left-2.5 size-5"
          aria-hidden="true"
        >
          <path d="M 0 -9 L 6 8 L 0 4 L -6 8 Z" fill="#f2a93b" stroke="#1c2529" strokeWidth="1.5" />
        </svg>
      </div>
    </div>
  )
}
