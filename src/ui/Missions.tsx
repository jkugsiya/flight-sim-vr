import { type ReactNode, useCallback, useRef, useState } from 'react'
import { bombAdvice, missileAdvice } from '../game/bombs'
import { type Advice, landingAdvice } from '../game/coach'
import { game, useGame } from '../game/game'
import {
  MISSION_CATEGORIES,
  MISSIONS,
  type Mission,
  type MissionCategory,
  passedMissions
} from '../game/missions'
import { HANGAR } from '../sim/aircraft'
import type { FlightSim } from '../sim/flight-sim'
import { Key } from './Hud'
import { setText, useTelemetry } from './telemetry'

const FOCUS =
  'outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 focus-visible:ring-offset-paper'

/** Missions whose aircraft exists in the hangar. */
const AVAILABLE = MISSIONS.filter(mission => HANGAR.some(spec => spec.id === mission.aircraft))

const CATEGORY_TITLES: Record<MissionCategory, string> = {
  Tutorial: 'Tutorials',
  'Speed Run': 'Speed Runs',
  Airline: 'Airline Flights',
  Challenge: 'Challenges',
  Bombing: 'Bombing Range',
  Strike: 'Air Strike'
}

const CATEGORY_NOTES: Record<MissionCategory, string> = {
  Tutorial: 'Step-by-step lessons for new pilots.',
  'Speed Run': 'Fighters against the clock.',
  Airline: 'Passengers aboard, gate to gate.',
  Challenge: 'Harder flying when things go wrong.',
  Bombing: 'The B-2 on the Gull Point practice range.',
  Strike: 'Fighters with guided missiles on the same range.'
}

/** Mission text with keys in square brackets drawn as key caps. */
export function KeyText({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\])/)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('[') && part.endsWith(']') ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a sentence never reorder
          <Key key={i}>{part.slice(1, -1)}</Key>
        ) : (
          part
        )
      )}
    </>
  )
}

const aircraftName = (mission: Mission) =>
  HANGAR.find(spec => spec.id === mission.aircraft)?.name ?? mission.aircraft

function Button(props: { onClick: () => void; primary?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`${FOCUS} border-ink rounded-sm border-2 px-4 py-2 text-left text-lg font-bold ${
        props.primary ? 'bg-ink text-paper hover:bg-ink/85' : 'text-ink hover:bg-ink/10'
      }`}
    >
      {props.children}
    </button>
  )
}

/** Conditions a mission sets, such as fog at night, in a few words. */
function conditions(mission: Mission) {
  const parts = [
    mission.weather &&
      mission.weather !== 'clear' &&
      { cloudy: 'low cloud', rain: 'rain', fog: 'fog' }[mission.weather],
    mission.time &&
      mission.time !== 'noon' &&
      { morning: 'morning', evening: 'sunset', night: 'night' }[mission.time],
    mission.wind && mission.wind !== 'calm' && `${mission.wind} wind`,
    mission.timeLimit && `${Math.round(mission.timeLimit / 60)} min limit`
  ]
  return parts.filter(Boolean).join(', ')
}

/** The mission list by category, with the chosen mission's briefing beside it. */
export function MissionsPanel() {
  const [chosen, setChosen] = useState<Mission>(AVAILABLE[0])
  const passed = passedMissions()
  const done = AVAILABLE.filter(mission => passed.has(mission.id)).length
  return (
    <div className="mt-5 grid gap-8 md:grid-cols-[5fr_6fr]">
      <div className="flex flex-col gap-3">
        <p className="text-sm opacity-75">
          {done} of {AVAILABLE.length} missions passed.
        </p>
        {MISSION_CATEGORIES.map(category => (
          <div key={category}>
            <h3 className="font-bold">
              {CATEGORY_TITLES[category]}{' '}
              <span className="text-sm font-normal opacity-65">{CATEGORY_NOTES[category]}</span>
            </h3>
            <ul className="mt-1 flex flex-col gap-1">
              {AVAILABLE.filter(mission => mission.category === category).map(mission => (
                <li key={mission.id}>
                  <button
                    type="button"
                    aria-pressed={chosen.id === mission.id}
                    onClick={() => setChosen(mission)}
                    className={`${FOCUS} border-ink/30 hover:bg-ink/10 aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper flex w-full items-baseline gap-2 rounded-sm border px-3 py-1.5 text-left`}
                  >
                    <span className="w-4 shrink-0 font-bold" aria-hidden="true">
                      {passed.has(mission.id) ? '✓' : ''}
                    </span>
                    {passed.has(mission.id) && <span className="sr-only">Passed:</span>}
                    <span className="font-bold">{mission.title}</span>
                    <span className="ml-auto text-sm opacity-70">{aircraftName(mission)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <Briefing mission={chosen} passed={passed.has(chosen.id)} />
    </div>
  )
}

/** Title, aircraft, story, steps, and the start button for one mission. */
function Briefing({ mission, passed }: { mission: Mission; passed: boolean }) {
  const extra = conditions(mission)
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-bold tracking-wider uppercase opacity-65">
          {mission.category} · {aircraftName(mission)}
          {passed && ' · Passed'}
        </p>
        <h2 className="text-2xl leading-tight font-bold">{mission.title}</h2>
        <p className="mt-1 leading-snug">{mission.briefing}</p>
        {extra && <p className="mt-1 text-sm font-bold">Conditions: {extra}.</p>}
      </div>
      <ol className="border-ink/25 list-decimal space-y-0.5 border-y py-2 pl-6 text-sm leading-snug">
        {mission.objectives.map(objective => (
          <li key={objective.text}>
            <KeyText text={objective.text} />
          </li>
        ))}
      </ol>
      <Button primary onClick={() => game.startMission(mission)}>
        Start Mission
      </Button>
    </div>
  )
}

/** Buttons while a mission is paused or over: resume or retry, the next one, or leave. */
export function MissionActions({ mission }: { mission: Mission }) {
  const status = useGame(state => state.status)
  const result = useGame(state => state.missionResult)
  const index = AVAILABLE.indexOf(mission)
  const next = AVAILABLE[index + 1]
  const passed = status === 'finished' && result?.passed
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-bold tracking-wider uppercase opacity-65">
        {mission.category} · {aircraftName(mission)}
      </p>
      <h2 className="text-2xl leading-tight font-bold">{mission.title}</h2>
      {status === 'paused' && (
        <Button primary onClick={game.resume}>
          Resume Mission
        </Button>
      )}
      {passed && next && (
        <Button primary onClick={() => game.startMission(next)}>
          Next: {next.title}
        </Button>
      )}
      <Button primary={!passed && status !== 'paused'} onClick={game.retryMission}>
        {status === 'paused' ? 'Restart Mission' : 'Try Again'}
      </Button>
      <Button onClick={game.leaveMission}>Back to the Menu</Button>
    </div>
  )
}

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

/** The mission's steps while flying: the one just done, the current one, and the next two. */
export function MissionCard({ mission }: { mission: Mission }) {
  const items = useRef<(HTMLLIElement | null)[]>([])
  const timer = useRef<HTMLSpanElement>(null)
  const [alert, setAlert] = useState<{ text: string; left: number } | null>(null)
  const shown = useRef('')
  useTelemetry(
    useCallback(() => {
      const { step, time, gates } = game.missions
      items.current.forEach((item, index) => {
        if (!item) return
        item.dataset.done = String(index < step)
        item.dataset.next = String(index === step)
        item.hidden = index < step - 1 || index > step + 2
      })
      const limit = mission.timeLimit
      const parts = [
        limit ? `${clock(Math.max(0, limit - time))} left` : clock(time),
        mission.gates &&
          `gate ${Math.min(gates + 1, mission.gates.length)} of ${mission.gates.length}`
      ]
      setText(timer.current, parts.filter(Boolean).join(' · '))
      if (timer.current) timer.current.dataset.on = String(Boolean(limit && limit - time < 30))
      // Only redraw the warning when its words or whole seconds change
      const { warning } = game.missions
      const next = warning ? `${warning.text} ${Math.ceil(warning.left)} s` : ''
      if (next !== shown.current) {
        shown.current = next
        setAlert(warning && { text: warning.text, left: Math.ceil(warning.left) })
      }
    }, [mission])
  )
  return (
    <div className="bg-paper/95 text-ink w-80 rounded-md px-4 py-3 text-sm shadow-lg">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">{mission.title}</h2>
        <span ref={timer} className="data-[on=true]:text-warn font-bold tabular-nums" />
      </div>
      <ol className="mt-1 list-decimal space-y-0.5 pl-5">
        {mission.objectives.map((objective, index) => (
          <li
            key={objective.text}
            ref={item => {
              items.current[index] = item
            }}
            className="data-[done=true]:line-through data-[done=true]:opacity-45 data-[next=true]:font-bold"
          >
            <KeyText text={objective.text} />
          </li>
        ))}
      </ol>
      {mission.missiles !== undefined && <MissilePanel total={mission.missiles} />}
      {mission.bombs !== undefined && (
        <BombPanel total={mission.bombs} demolish={mission.demolish} />
      )}
      {alert && (
        <p
          role="alert"
          className="border-warn bg-warn/10 mt-2 rounded-sm border-l-4 px-2 py-1 leading-snug font-bold"
        >
          <KeyText text={alert.text} />{' '}
          <span className="text-warn tabular-nums">Mission fails in {alert.left} s</span>
        </p>
      )}
    </div>
  )
}

/** Missiles left, targets hit, and advice on pointing the nose and firing. */
function MissilePanel({ total }: { total: number }) {
  const count = useRef<HTMLSpanElement>(null)
  const [advice, setAdvice] = useState('')
  const shown = useRef({ text: '', at: 0 })
  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        const { bombs } = game
        setText(
          count.current,
          `Missiles ${bombs.missiles} of ${total} · Targets hit ${bombs.hits} of ${bombs.targets.length}`
        )
        // Advice holds half a second, so it can be read while it changes
        const now = performance.now()
        if (now - shown.current.at < 500) return
        const next = missileAdvice(bombs, sim) ?? ''
        if (next === shown.current.text) return
        shown.current = { text: next, at: now }
        setAdvice(next)
      },
      [total]
    )
  )
  return (
    <div className="border-ink/25 mt-2 border-t pt-2">
      <span ref={count} className="font-bold tabular-nums" />
      {advice && (
        <p className="mt-1 leading-snug">
          <KeyText text={advice} />
        </p>
      )}
    </div>
  )
}

/**
 * Bombs left, what they destroyed, and aiming advice. Outside the bombsight it only says
 * how to open it.
 */
export function BombPanel({
  total,
  demolish
}: {
  total: number
  /** On a demolition mission, the city whose buildings count toward the goal. */
  demolish?: Mission['demolish']
}) {
  const count = useRef<HTMLSpanElement>(null)
  const [advice, setAdvice] = useState('')
  const shown = useRef({ text: '', at: 0 })
  const bombsight = useGame(state => state.bombsight)
  useTelemetry(
    useCallback(
      (sim: FlightSim) => {
        const { bombs } = game
        const hits = bombs.targets.length
          ? ` · Targets hit ${bombs.hits} of ${bombs.targets.length}`
          : ''
        const fallen = bombs.ruins.fallen.length
        // A demolition counts only the city's own buildings, so show those against the goal
        const down = demolish
          ? ` · ${demolish.city} down ${bombs.ruins.fallenInCity(demolish.city)} of ${demolish.goal}`
          : fallen > 0
            ? ` · Buildings down ${fallen}`
            : ''
        setText(count.current, `Bombs ${bombs.loaded} of ${total}${hits}${down}`)
        // Advice holds half a second, so it can be read while it changes
        const now = performance.now()
        if (now - shown.current.at < 500) return
        const closed = bombs.loaded > 0 ? 'Press [Tab] to open the bombsight.' : ''
        const next = bombsight ? (bombAdvice(bombs, sim) ?? '') : closed
        if (next === shown.current.text) return
        shown.current = { text: next, at: now }
        setAdvice(next)
      },
      [total, bombsight, demolish]
    )
  )
  return (
    <div className="border-ink/25 mt-2 border-t pt-2">
      {bombsight && (
        <p className="text-go mb-1 text-xs font-bold tracking-wide uppercase">
          Bombsight · <KeyText text="[Tab] closes it" />
        </p>
      )}
      <span ref={count} className="font-bold tabular-nums" />
      {advice && (
        <p className="mt-1 leading-snug">
          <KeyText text={advice} />
        </p>
      )}
    </div>
  )
}

// Milliseconds a piece of advice stays up before the next one replaces it, so it can be read
// without flickering
const COACH_HOLD = 1000

const COACH_TONES: Record<Exclude<Advice['tone'], 'status'>, string> = {
  good: 'border-go',
  fix: 'border-amber',
  warn: 'border-warn'
}

/**
 * Live landing advice under the steps or checklist, in free flight and missions alike: which
 * key to press, and how, from the final approach to the stop. It shows only when there is
 * something to do, and Settings can turn it off.
 */
export function CoachCard() {
  const on = useGame(state => state.coach)
  return on ? <CoachLine /> : null
}

function CoachLine() {
  const [advice, setAdvice] = useState<Advice | null>(null)
  const shown = useRef({ text: '', at: 0 })
  useTelemetry(
    useCallback((sim: FlightSim) => {
      const now = performance.now()
      if (now - shown.current.at < COACH_HOLD) return
      const found = landingAdvice(sim, game.nav, game.pilot)
      const next = found?.tone === 'status' ? null : found
      const text = next?.text ?? ''
      if (text === shown.current.text) return
      shown.current = { text, at: now }
      setAdvice(next)
    }, [])
  )
  if (!advice || advice.tone === 'status') return null
  return (
    <p
      aria-live="polite"
      className={`bg-paper/90 text-ink w-80 rounded-md border-l-4 px-3 py-1 text-sm leading-snug shadow-md ${COACH_TONES[advice.tone]}`}
    >
      <KeyText text={advice.text} />
    </p>
  )
}
