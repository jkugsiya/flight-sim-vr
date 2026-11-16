import { type ReactNode, type RefObject, useCallback, useRef } from 'react'
import type { AircraftSpec } from '../sim/aircraft'
import type { FlightSim } from '../sim/flight-sim'
import {
  DEGREES,
  FEET_PER_METRE,
  FPM_PER_MS,
  KNOTS_PER_MS,
  rotate,
  setText,
  useTelemetry
} from './telemetry'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Point on a dial. Angles are degrees clockwise from 12 o'clock. */
function polar(radius: number, degrees: number): [number, number] {
  const angle = (degrees * Math.PI) / 180
  return [radius * Math.sin(angle), -radius * Math.cos(angle)]
}

function arc(radius: number, from: number, to: number) {
  const [x1, y1] = polar(radius, from)
  const [x2, y2] = polar(radius, to)
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`
}

function Dial({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg viewBox="-50 -50 100 100" className="text-marking size-33 shrink-0" role="img">
      <title>{label}</title>
      <circle r="49.5" className="fill-bezel" />
      <circle r="48.5" fill="none" className="stroke-panel-edge" strokeWidth="1.2" />
      <circle r="45" className="fill-face" />
      {children}
    </svg>
  )
}

function Ticks(props: {
  count: number
  start: number
  step: number
  inner: number
  width?: number
}) {
  return Array.from({ length: props.count }, (_, i) => {
    const angle = props.start + i * props.step
    const [x1, y1] = polar(props.inner, angle)
    const [x2, y2] = polar(44, angle)
    return (
      <line
        key={angle}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="currentColor"
        strokeWidth={props.width ?? 0.7}
      />
    )
  })
}

function Label(props: { radius: number; angle: number; size?: number; children: ReactNode }) {
  const [x, y] = polar(props.radius, props.angle)
  return (
    <text
      x={x}
      y={y}
      fontSize={props.size ?? 7}
      textAnchor="middle"
      dominantBaseline="central"
      fill="currentColor"
    >
      {props.children}
    </text>
  )
}

function Caption({ y, children }: { y: number; children: ReactNode }) {
  return (
    <text
      y={y}
      fontSize="4.2"
      textAnchor="middle"
      fill="currentColor"
      opacity="0.7"
      letterSpacing="0.4"
    >
      {children}
    </text>
  )
}

const NEEDLE = '-1.1,7 1.1,7 0.7,-34 0,-39 -0.7,-34'

function Hub() {
  return <circle r="3.2" className="fill-bezel stroke-panel-edge" strokeWidth="0.6" />
}

/** Multiples of `step` from `from` to `to`, inclusive. */
function every(step: number, from: number, to: number) {
  const values: number[] = []
  for (let value = Math.ceil(from / step) * step; value <= to; value += step) values.push(value)
  return values
}

function Mark(props: { angle: number; inner: number; width?: number }) {
  const [x1, y1] = polar(props.inner, props.angle)
  const [x2, y2] = polar(44, props.angle)
  return (
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={props.width ?? 0.7} />
  )
}

function Readout({ target }: { target: RefObject<SVGTextElement | null> }) {
  return (
    <>
      <rect
        x="-11"
        y="9"
        width="22"
        height="9"
        rx="1.2"
        className="fill-bezel stroke-panel-edge"
        strokeWidth="0.5"
      />
      <text
        ref={target}
        y="13.6"
        fontSize="6.4"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
      >
        0
      </text>
    </>
  )
}

export function AirspeedIndicator({ spec }: { spec: AircraftSpec }) {
  const needle = useRef<SVGPolygonElement>(null)
  const readout = useRef<SVGTextElement>(null)
  const scale = spec.gauges.airspeed
  // The scale sweeps 320° from its lowest to its highest speed
  const angle = useCallback(
    (knots: number) =>
      (clamp(knots - scale.min, 0, scale.max - scale.min) / (scale.max - scale.min)) * 320,
    [scale]
  )
  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        const knots = sim.indicatedAirspeed * KNOTS_PER_MS
        rotate(needle.current, angle(knots))
        setText(readout.current, String(Math.round(knots)))
      },
      [angle]
    )
  )
  const redline = scale.cautionRange[1]
  const sliver = (scale.max - scale.min) / 270
  return (
    <Dial label="Airspeed indicator">
      {/* White: flap range. Green: normal range. Amber: smooth air only. Red: never exceed. */}
      {scale.flapRange && (
        <path
          d={arc(40.5, angle(scale.flapRange[0]), angle(scale.flapRange[1]))}
          fill="none"
          stroke="#fff"
          strokeWidth="1.6"
        />
      )}
      <path
        d={arc(42.8, angle(scale.normalRange[0]), angle(scale.normalRange[1]))}
        fill="none"
        className="stroke-go"
        strokeWidth="2.4"
      />
      <path
        d={arc(42.8, angle(scale.cautionRange[0]), angle(redline))}
        fill="none"
        className="stroke-amber"
        strokeWidth="2.4"
      />
      <path
        d={arc(42.2, angle(redline - sliver), angle(redline + sliver))}
        fill="none"
        className="stroke-warn"
        strokeWidth="5"
      />
      {every(scale.tickEvery, scale.min, scale.max).map(knots => (
        <Mark key={knots} angle={angle(knots)} inner={39} />
      ))}
      {every(scale.labelEvery, scale.min + scale.labelEvery, scale.max - scale.labelEvery / 2).map(
        knots => (
          <g key={knots}>
            <Mark angle={angle(knots)} inner={36.5} width={1.1} />
            <Label radius={29} angle={angle(knots)} size={scale.max > 300 ? 5.6 : 7}>
              {scale.max > 300 ? knots / 100 : knots}
            </Label>
          </g>
        )
      )}
      <Caption y={-9}>{scale.max > 300 ? 'KNOTS × 100' : 'KNOTS'}</Caption>
      <Readout target={readout} />
      <polygon ref={needle} points={NEEDLE} fill="currentColor" />
      <Hub />
    </Dial>
  )
}

export function AttitudeIndicator() {
  const horizon = useRef<SVGGElement>(null)
  const bankScale = useRef<SVGGElement>(null)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      const bank = -sim.bank * DEGREES
      const pitch = clamp(sim.pitch * DEGREES, -60, 60)
      horizon.current?.setAttribute(
        'transform',
        `rotate(${bank.toFixed(2)}) translate(0 ${pitch.toFixed(2)})`
      )
      rotate(bankScale.current, bank)
    }, [])
  )
  return (
    <Dial label="Attitude indicator">
      <clipPath id="attitude-window">
        <circle r="37" />
      </clipPath>
      <g clipPath="url(#attitude-window)">
        <g ref={horizon}>
          <rect x="-120" y="-240" width="240" height="240" fill="#3f86c9" />
          <rect x="-120" y="0" width="240" height="240" fill="#80552f" />
          <line x1="-120" x2="120" stroke="#fff" strokeWidth="0.8" />
          {[-20, -10, 10, 20].map(pitch => (
            <g key={pitch}>
              <line x1="-9" x2="9" y1={-pitch} y2={-pitch} stroke="#fff" strokeWidth="0.6" />
              <text x="13" y={-pitch} fontSize="4.5" fill="#fff" dominantBaseline="central">
                {Math.abs(pitch)}
              </text>
            </g>
          ))}
          {[-15, -5, 5, 15].map(pitch => (
            <line
              key={pitch}
              x1="-4.5"
              x2="4.5"
              y1={-pitch}
              y2={-pitch}
              stroke="#fff"
              strokeWidth="0.5"
            />
          ))}
        </g>
      </g>
      <g ref={bankScale}>
        {[-60, -30, -20, -10, 0, 10, 20, 30, 60].map(angle => {
          const [x1, y1] = polar(37, angle)
          const [x2, y2] = polar(angle % 30 === 0 ? 44 : 41, angle)
          return (
            <line
              key={angle}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="currentColor"
              strokeWidth="0.9"
            />
          )
        })}
      </g>
      <polygon points="0,-36.5 -2.6,-31.5 2.6,-31.5" className="fill-amber" />
      {/* Fixed aircraft symbol */}
      <path
        d="M -20 0 H -7 L 0 5 L 7 0 H 20"
        fill="none"
        className="stroke-amber"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle r="1.1" className="fill-amber" />
    </Dial>
  )
}

export function Altimeter() {
  const hundreds = useRef<SVGPolygonElement>(null)
  const thousands = useRef<SVGPolygonElement>(null)
  const readout = useRef<SVGTextElement>(null)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      const feet = sim.position.y * FEET_PER_METRE
      rotate(hundreds.current, (feet % 1000) * 0.36)
      rotate(thousands.current, (feet % 10_000) * 0.036)
      setText(readout.current, String(Math.round(feet / 10) * 10))
    }, [])
  )
  return (
    <Dial label="Altimeter">
      <Ticks count={50} start={0} step={7.2} inner={41} />
      <Ticks count={10} start={0} step={36} inner={38} width={1.1} />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => (
        <Label key={digit} radius={31.5} angle={digit * 36} size={8}>
          {digit}
        </Label>
      ))}
      <Caption y={-13}>FEET</Caption>
      <rect
        x="-11"
        y="9"
        width="22"
        height="9"
        rx="1.2"
        className="fill-bezel stroke-panel-edge"
        strokeWidth="0.5"
      />
      <text
        ref={readout}
        y="13.6"
        fontSize="6.4"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
      >
        0
      </text>
      <polygon ref={thousands} points="-1.8,5 1.8,5 1.8,-20 0,-24 -1.8,-20" fill="currentColor" />
      <polygon ref={hundreds} points={NEEDLE} fill="currentColor" />
      <Hub />
    </Dial>
  )
}

export function TurnCoordinator() {
  const wings = useRef<SVGGElement>(null)
  const ball = useRef<SVGCircleElement>(null)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      // A standard-rate turn of 3° per second tilts the wings onto the L and R marks
      rotate(wings.current, clamp((sim.turnRate * DEGREES * 20) / 3, -40, 40))
      ball.current?.setAttribute('cx', clamp(sim.slip * 110, -13, 13).toFixed(2))
    }, [])
  )
  return (
    <Dial label="Turn coordinator">
      {[-110, -90, 90, 110].map(angle => {
        const [x1, y1] = polar(38, angle)
        const [x2, y2] = polar(44, angle)
        return (
          <line
            key={angle}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="currentColor"
            strokeWidth="1.6"
          />
        )
      })}
      <Label radius={33} angle={-118} size={6}>
        L
      </Label>
      <Label radius={33} angle={118} size={6}>
        R
      </Label>
      <g ref={wings}>
        <path
          d="M -30 0 H 30 M 0 0 V -8 M -7 -5 H 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <circle r="3.4" fill="currentColor" />
      </g>
      {/* Slip ball: step on the rudder on the side the ball sits */}
      <rect
        x="-19"
        y="18"
        width="38"
        height="10"
        rx="5"
        className="fill-bezel stroke-panel-edge"
        strokeWidth="0.5"
      />
      <line x1="-5" x2="-5" y1="18" y2="28" stroke="currentColor" strokeWidth="0.6" />
      <line x1="5" x2="5" y1="18" y2="28" stroke="currentColor" strokeWidth="0.6" />
      <circle ref={ball} cy="23" r="4.2" fill="currentColor" />
      <Caption y={38}>2 MIN</Caption>
    </Dial>
  )
}

const COMPASS = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33']

export function HeadingIndicator() {
  const card = useRef<SVGGElement>(null)
  useTelemetry(
    useCallback((sim: FlightSim) => {
      rotate(card.current, -sim.heading * DEGREES)
    }, [])
  )
  return (
    <Dial label="Heading indicator">
      <g ref={card}>
        <Ticks count={72} start={0} step={5} inner={41.5} />
        <Ticks count={36} start={0} step={10} inner={39} width={1} />
        {COMPASS.map((text, i) => (
          <text
            key={text}
            y="-29"
            fontSize={i % 3 === 0 ? 8.5 : 6.5}
            textAnchor="middle"
            fill="currentColor"
            transform={`rotate(${i * 30})`}
          >
            {text}
          </text>
        ))}
      </g>
      <polygon points="0,-44.5 -2.8,-49 2.8,-49" className="fill-amber" />
      {/* Fixed aircraft outline, nose up */}
      <path
        d="M 0 -15 V 13 M -13 -2 H 13 M -5 11 H 5"
        fill="none"
        className="stroke-amber"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </Dial>
  )
}

export function VerticalSpeedIndicator({ spec }: { spec: AircraftSpec }) {
  const needle = useRef<SVGPolygonElement>(null)
  const full = spec.gauges.climb
  // Zero sits at 9 o'clock and full scale is 160° away
  const angle = useCallback(
    (feetPerMinute: number) => -90 + (clamp(feetPerMinute, -full, full) / full) * 160,
    [full]
  )
  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        rotate(needle.current, angle(sim.verticalSpeed * FPM_PER_MS))
      },
      [angle]
    )
  )
  return (
    <Dial label="Vertical speed indicator">
      <Ticks count={41} start={angle(-full)} step={8} inner={41} />
      {[-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].map(share => (
        <g key={share}>
          <Mark angle={angle(share * full)} inner={38} width={1.1} />
          <Label radius={31} angle={angle(share * full)}>
            {Math.abs(share * full) / 100}
          </Label>
        </g>
      ))}
      <text x="-12" y="-9" fontSize="4.2" fill="currentColor" opacity="0.7">
        UP
      </text>
      <text x="-12" y="12" fontSize="4.2" fill="currentColor" opacity="0.7">
        DN
      </text>
      <text x="14" y="1.5" fontSize="3.6" textAnchor="middle" fill="currentColor" opacity="0.7">
        100 FT/MIN
      </text>
      <polygon ref={needle} points={NEEDLE} fill="currentColor" />
      <Hub />
    </Dial>
  )
}

/** Engine speed: propeller rpm, or percent of full speed for a jet. */
export function Tachometer({ spec }: { spec: AircraftSpec }) {
  const needle = useRef<SVGPolygonElement>(null)
  const scale = spec.gauges.power
  // The scale sweeps 270° from zero to its highest reading
  const angle = useCallback(
    (reading: number) => -135 + (clamp(reading, 0, scale.max) / scale.max) * 270,
    [scale]
  )
  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        rotate(needle.current, angle(sim.rpm))
      },
      [angle]
    )
  )
  const sliver = scale.max / 300
  return (
    <Dial label="Tachometer">
      <path
        d={arc(42.8, angle(scale.normalRange[0]), angle(scale.normalRange[1]))}
        fill="none"
        className="stroke-go"
        strokeWidth="2.4"
      />
      <path
        d={arc(42.2, angle(scale.redline - sliver), angle(scale.redline + sliver))}
        fill="none"
        className="stroke-warn"
        strokeWidth="5"
      />
      {every(scale.tickEvery, 0, scale.max).map(reading => (
        <Mark key={reading} angle={angle(reading)} inner={41} />
      ))}
      {every(scale.labelEvery, 0, scale.max).map(reading => (
        <g key={reading}>
          <Mark angle={angle(reading)} inner={38} width={1.1} />
          <Label radius={31} angle={angle(reading)}>
            {reading / scale.labelScale}
          </Label>
        </g>
      ))}
      <Caption y={22}>{scale.caption}</Caption>
      <polygon ref={needle} points={NEEDLE} fill="currentColor" />
      <Hub />
    </Dial>
  )
}
