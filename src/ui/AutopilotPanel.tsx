import { type ReactNode, useCallback, useEffect, useRef } from 'react'
import { game } from '../game/game'
import type { Knob, LateralMode, VerticalMode } from '../game/pilot'
import type { FlightSim } from '../sim/flight-sim'
import {
  DEGREES,
  FEET_PER_METRE,
  FPM_PER_MS,
  KNOTS_PER_MS,
  setText,
  thousands,
  useTelemetry
} from './telemetry'

// Knob buttons repeat after this delay while held, every REPEAT_EVERY milliseconds
const REPEAT_AFTER = 350
const REPEAT_EVERY = 70

const BUTTON =
  'pointer-events-auto rounded-sm border border-panel-edge bg-bezel px-1.5 py-0.5 text-xs font-bold tracking-wide text-marking/70 hover:bg-panel-edge data-[on=true]:border-go data-[on=true]:text-go'

/** Mode button that lights while its mode is active, labelled with its keyboard key. */
function ModeButton(props: {
  mode: Mode
  lamp: (index: number) => (element: HTMLButtonElement | null) => void
  index: number
}) {
  const { label, hint, press } = props.mode
  return (
    <button
      ref={props.lamp(props.index)}
      type="button"
      title={hint ? `${label} (${hint})` : label}
      // Keep keyboard focus on the game so Space still brakes
      onMouseDown={event => event.preventDefault()}
      onClick={press}
      className={BUTTON}
    >
      {label}
      {hint && <span className="text-marking/40 ml-1 font-normal">{hint}</span>}
    </button>
  )
}

/** A knob readout with buttons either side. Hold a button, or scroll over the value, to turn it. */
function KnobControl(props: { label: string; knob: Knob; children: ReactNode }) {
  const timer = useRef<number | null>(null)
  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])
  useEffect(() => stop, [stop])
  const start = (steps: number) => {
    stop()
    game.pilot.adjust(props.knob, steps)
    const repeat = () => {
      game.pilot.adjust(props.knob, steps)
      timer.current = window.setTimeout(repeat, REPEAT_EVERY)
    }
    timer.current = window.setTimeout(repeat, REPEAT_AFTER)
  }
  const turn = (steps: number) => (
    <button
      type="button"
      aria-label={`${props.label} ${steps > 0 ? 'up' : 'down'}`}
      onMouseDown={event => event.preventDefault()}
      onPointerDown={() => start(steps)}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onBlur={stop}
      // Enter or Space on a focused button turns the knob one click
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') game.pilot.adjust(props.knob, steps)
      }}
      className="bg-bezel text-marking/80 hover:bg-panel-edge pointer-events-auto size-5 rounded-full text-sm leading-none"
    >
      {steps > 0 ? '+' : '−'}
    </button>
  )
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-marking/60 text-[10px] tracking-widest">{props.label}</span>
      <div className="flex items-center gap-1">
        {turn(-1)}
        <span
          className="text-amber pointer-events-auto min-w-14 rounded-sm bg-black/70 px-1.5 text-center font-mono text-sm"
          onWheel={event => game.pilot.adjust(props.knob, event.deltaY < 0 ? 1 : -1)}
        >
          {props.children}
        </span>
        {turn(1)}
      </div>
    </div>
  )
}

/** Which modes are active, for lighting the mode buttons. */
function modeState() {
  const { autopilot, autothrottle } = game.pilot
  const on = autopilot.on
  return {
    on,
    autothrottle: autothrottle.on,
    lateral: (mode: LateralMode) => on && autopilot.lateral === mode,
    vertical: (mode: VerticalMode) => on && autopilot.vertical === mode
  }
}

type Mode = {
  label: string
  hint: string
  active: (state: ReturnType<typeof modeState>) => boolean
  press: () => void
}

const MODES: Mode[] = [
  {
    label: 'A/THR',
    hint: 'X',
    active: state => state.autothrottle,
    press: () => game.pilot.toggleAutothrottle(game.sim)
  },
  {
    label: 'HDG',
    hint: 'H',
    active: state => state.lateral('HDG'),
    press: () => game.pilot.setLateral('HDG', game.sim, game.nav)
  },
  {
    label: 'NAV',
    hint: 'J',
    active: state => state.lateral('NAV'),
    press: () => game.pilot.setLateral('NAV', game.sim, game.nav)
  },
  {
    label: 'ALT',
    hint: '',
    active: state => state.vertical('ALT'),
    press: () => game.pilot.setVertical('ALT', game.sim, game.nav)
  },
  {
    label: 'V/S',
    hint: 'K',
    active: state => state.vertical('VS'),
    press: () => game.pilot.setVertical('VS', game.sim, game.nav)
  },
  {
    label: 'FLCH',
    hint: 'Y',
    active: state => state.vertical('FLCH'),
    press: () => game.pilot.setVertical('FLCH', game.sim, game.nav)
  },
  {
    label: 'VNAV',
    hint: '',
    active: state => state.vertical('VNAV'),
    press: () => game.pilot.setLateral('NAV', game.sim, game.nav)
  },
  {
    label: 'APP',
    hint: 'T',
    active: state => state.lateral('APP'),
    press: () => game.pilot.flyApproach(!game.pilot.flyingApproach, game.sim, game.nav)
  },
  {
    label: 'AP',
    hint: 'Z',
    active: state => state.on,
    press: () => game.pilot.engage(!game.pilot.autopilot.on, game.sim)
  }
]

/**
 * Autopilot panel above the instruments: speed, heading, altitude, and climb rate knobs,
 * and the mode buttons. It goes dark without electrical power.
 */
export function AutopilotPanel() {
  const panel = useRef<HTMLDivElement>(null)
  const speed = useRef<HTMLSpanElement>(null)
  const heading = useRef<HTMLSpanElement>(null)
  const altitude = useRef<HTMLSpanElement>(null)
  const climb = useRef<HTMLSpanElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const lamp = (index: number) => (element: HTMLButtonElement | null) => {
    buttons.current[index] = element
  }
  useTelemetry(
    useCallback((sim: FlightSim) => {
      const { autopilot, autothrottle } = game.pilot
      if (panel.current) panel.current.dataset.dark = String(!sim.powered)
      if (!sim.powered) {
        for (const element of [speed, heading, altitude, climb]) setText(element.current, '')
        for (const button of buttons.current) if (button) button.dataset.on = 'false'
        return
      }
      setText(speed.current, String(Math.round(autothrottle.speed * KNOTS_PER_MS)))
      const bearing = Math.round((((autopilot.heading * DEGREES) % 360) + 360) % 360)
      setText(heading.current, String(bearing === 0 ? 360 : bearing).padStart(3, '0'))
      const feet = Math.round((autopilot.altitude * FEET_PER_METRE) / 100) * 100
      setText(altitude.current, thousands(feet))
      // The climb wheel reads dashes until vertical speed mode is in use
      const rate = Math.round((autopilot.verticalSpeed * FPM_PER_MS) / 100) * 100
      const showing = autopilot.on && autopilot.vertical === 'VS'
      setText(climb.current, showing ? `${rate > 0 ? '+' : ''}${rate}` : '-----')
      const state = modeState()
      MODES.forEach((mode, i) => {
        const button = buttons.current[i]
        if (button) button.dataset.on = String(mode.active(state))
      })
    }, [])
  )
  return (
    <div
      ref={panel}
      className="border-panel-edge bg-panel/95 flex items-end justify-center gap-3 rounded-md border px-3 py-1.5 shadow-lg transition-opacity data-[dark=true]:opacity-60"
    >
      <ModeButton mode={MODES[0]} lamp={lamp} index={0} />
      <KnobControl label="SPEED kt" knob="speed">
        <span ref={speed} />
      </KnobControl>
      <KnobControl label="HEADING" knob="heading">
        <span ref={heading} />
      </KnobControl>
      <div className="flex gap-1">
        {[1, 2].map(i => (
          <ModeButton key={i} mode={MODES[i]} lamp={lamp} index={i} />
        ))}
      </div>
      <KnobControl label="ALTITUDE ft" knob="altitude">
        <span ref={altitude} />
      </KnobControl>
      <KnobControl label="V/S ft/min" knob="verticalSpeed">
        <span ref={climb} />
      </KnobControl>
      <div className="flex gap-1">
        {[3, 4, 5, 6, 7, 8].map(i => (
          <ModeButton key={i} mode={MODES[i]} lamp={lamp} index={i} />
        ))}
      </div>
    </div>
  )
}
