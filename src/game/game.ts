import { useSyncExternalStore } from 'react'
import { Vector3 } from 'three'
import { type AircraftSpec, DEFAULT_AIRCRAFT, engineArms, HANGAR, KNOT } from '../sim/aircraft'
import { type CrashReason, FlightSim } from '../sim/flight-sim'
import { APPROACHES, onCentreline, pathAltitude } from '../world/approaches'
import {
  AIRPORTS,
  type Airport,
  fromStrip,
  heightAt,
  ISLAND_GROUND,
  outside
} from '../world/island'
import { Sound } from './audio'
import { Bombs, type Impact } from './bombs'
import { findCollision } from './collision'
import { Effects } from './effects'
import { Gpws } from './gpws'
import { type Mission, type MissionResult, MissionRunner, rememberPassed } from './missions'
import { Navigator, planRoute } from './navigation'
import { Pilot } from './pilot'
import {
  GRAPHICS_PRESETS,
  type Graphics,
  type GraphicsPreset,
  loadSettings,
  saveSettings
} from './settings'
import { Traffic } from './traffic'
import { Wreck } from './wreck'

/** `finished` means a mission ended with a pass or a fail, other than a crash. */
export type Status = 'menu' | 'flying' | 'paused' | 'crashed' | 'arrived' | 'finished'
export type CameraMode = 'chase' | 'cockpit'
export type WindLevel = 'calm' | 'light' | 'strong'
export type MapSize = 'small' | 'large' | 'hidden'
/** Sky and visibility. Cloudy adds a low overcast deck, rain adds showers, fog cuts visibility. */
export type Weather = 'clear' | 'cloudy' | 'rain' | 'fog'
export type TimeOfDay = 'morning' | 'noon' | 'evening' | 'night'

/** Summary of a flight that ended parked at an airport. */
export type Arrival = {
  airport: Airport
  /** Seconds from the first liftoff to shutdown. */
  flightSeconds: number
  /** Descent rate at touchdown in m/s. */
  touchdownRate: number
}

export type GameState = {
  status: Status
  camera: CameraMode
  /** Looking down from the bomb bay with the aiming cross. Tab switches it on and off. */
  bombsight: boolean
  /** True while a VR headset shows the game from the pilot's seat. */
  vr: boolean
  wind: WindLevel
  muted: boolean
  /** Live landing advice on screen. */
  coach: boolean
  /** The map starts small. M enlarges it, then hides it. */
  map: MapSize
  graphics: Graphics
  weather: Weather
  time: TimeOfDay
  crash: CrashReason | null
  /** True once the crash has played out and the menu may cover it. */
  crashShown: boolean
  arrival: Arrival | null
  /** The mission being flown, or null in free flight, and how it ended. */
  mission: Mission | null
  missionResult: MissionResult | null
  /** Aircraft and airport picked in the menu. They apply on the next start. */
  selected: AircraftSpec
  departure: Airport
  /** Airport the flight plan leads to, or null to fly without one. */
  destination: Airport | null
  /** Aircraft in the world right now. */
  flown: AircraftSpec
}

/** Mean wind speed in m/s for each setting. */
export const WIND_SPEEDS: Record<WindLevel, number> = { calm: 0, light: 4, strong: 9 }
/** Direction the wind blows from, in degrees clockwise from north. */
export const WIND_FROM = 60

// A bomb's blast throws debris straight up and out, carried by nothing
// Holding Enter over a city drops a string of bombs: the first repeat after this many
// seconds, then one every gap
const RIPPLE_START = 0.6
const RIPPLE_GAP = 0.7
// Burning ruins shown at once, newest first, so a flattened city stays within the smoke budget
const BURNING_RUINS = 20
// Seconds the bombsight stays on after the last bomb, to watch its blast
const SIGHT_LINGER = 2.5
const spot = new Vector3()
// Longest physics step in seconds. Longer frames are split into several steps.
const MAX_STEP = 1 / 120
// Seconds the crash plays before the menu appears
const CRASH_REPLAY = 3
// Seconds a won bombing mission flies on, so the last explosion shows before the menu
const BLAST_REPLAY = 4
// A flight counts once the aircraft has climbed this high, in metres
const AIRBORNE_HEIGHT = 30

/** True when an aircraft can use an airport's main runway. */
export const canUse = (spec: AircraftSpec, airport: Airport) =>
  airport.runways[0].length >= spec.runwayNeeded

const spotsBySpec = new WeakMap<AircraftSpec, Vector3[]>()

/** The back of each engine in body axes, numbered from the left wing, where a fire burns. */
function engineSpots(spec: AircraftSpec) {
  const known = spotsBySpec.get(spec)
  if (known) return known
  const { shape } = spec
  let spots = engineArms(spec).map(x => new Vector3(x, 0, 0))
  if (shape.type === 'airliner') {
    const right = [...shape.engines].sort((a, b) => a[0] - b[0])
    const back = (x: number, z: number) => new Vector3(x, shape.engineY, z + shape.engineLength)
    spots = [...right.map(([x, z]) => back(-x, z)).reverse(), ...right.map(([x, z]) => back(x, z))]
  }
  spotsBySpec.set(spec, spots)
  return spots
}

/** Owns the simulation, the pilot's controls, and the menu state. */
class Game {
  readonly sim = new FlightSim(ISLAND_GROUND, DEFAULT_AIRCRAFT)
  readonly pilot = new Pilot()
  readonly nav = new Navigator()
  readonly missions = new MissionRunner()
  /** Ground proximity warnings, spoken unless the sound is off. */
  readonly gpws = new Gpws((phrase, urgent) => {
    if (!this.state.muted && this.state.status === 'flying') this.sound.say(phrase, urgent)
  })
  /** Current air mass velocity in m/s, including gusts. */
  readonly wind = new Vector3()
  /** Seconds the boats, balloons, birds, and other aircraft have been moving. It stops while paused. */
  sceneryTime = 0
  /** Rendered frames per second, smoothed. */
  frameRate = 60
  /** Counts the flights started, so cockpit systems can tell when a new one begins. */
  flight = 0
  readonly effects = new Effects()
  readonly wreck = new Wreck()
  readonly traffic = new Traffic()
  /** The B-2's bomb bay on bombing missions; empty otherwise. */
  readonly bombs = new Bombs()
  // A won bombing mission waiting for its last explosion to play out
  private won: { result: MissionResult; left: number } | null = null
  private readonly lastBlast = new Vector3()
  // Seconds since a ditching, for the spray it throws up
  private sprayClock = 0
  // Enter held down in the bombsight, and seconds until the next bomb of the string
  private rippleHeld = false
  private rippleClock = 0

  // Settings come back as the player left them
  private state: GameState = {
    status: 'menu',
    bombsight: false,
    vr: false,
    ...savedState(),
    crash: null,
    crashShown: false,
    arrival: null,
    mission: null,
    missionResult: null
  }
  private time = 0
  /** Free flight settings, kept while a mission overrides them. */
  private freeFlight: Pick<
    GameState,
    'selected' | 'departure' | 'destination' | 'weather' | 'time' | 'wind'
  > | null = null
  /** Graphics and camera to put back when the headset comes off. */
  private beforeVR: Pick<GameState, 'graphics' | 'camera'> | null = null
  private liftoffTime: number | null = null
  private sinkRate = 0
  private touchdownRate = 0
  private readonly sound = new Sound()
  private readonly stateListeners = new Set<() => void>()
  private readonly frameListeners = new Set<() => void>()

  constructor() {
    this.placeAtStand()
  }

  getState = () => this.state

  /** True once the aircraft has left the ground on this flight. */
  get hasFlown() {
    return this.liftoffTime !== null
  }

  /** The point the camera and the sun's shadow follow: the aircraft, or its wreckage. */
  get focus() {
    return this.wreck.active ? this.wreck.pieces[0].position : this.sim.position
  }

  subscribe = (listener: () => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Runs `listener` after every simulation frame. Returns a function that removes it. */
  onFrame(listener: () => void) {
    this.frameListeners.add(listener)
    return () => {
      this.frameListeners.delete(listener)
    }
  }

  /** Picks the aircraft for the next flight. On the start screen it rolls out straight away. */
  selectAircraft = (id: string) => {
    const selected = HANGAR.find(spec => spec.id === id)
    if (!selected) return
    // An airliner cannot leave from a short strip, so fall back to the first airport that fits
    const departure = canUse(selected, this.state.departure)
      ? this.state.departure
      : (AIRPORTS.find(airport => canUse(selected, airport)) ?? AIRPORTS[0])
    // A destination the new aircraft cannot land at is dropped
    const { destination } = this.state
    const keep = destination && destination !== departure && canUse(selected, destination)
    this.change({ selected, departure, destination: keep ? destination : null })
    if (this.state.status === 'menu') this.placeAtStand()
  }

  /** Picks the airport the next flight starts from. */
  selectDeparture = (name: string) => {
    const departure = AIRPORTS.find(airport => airport.name === name)
    if (!departure || !canUse(this.state.selected, departure)) return
    const destination = this.state.destination === departure ? null : this.state.destination
    this.change({ departure, destination })
    if (this.state.status === 'menu') this.placeAtStand()
  }

  /** Picks the airport the flight plan leads to, or none. It applies on the next start. */
  selectDestination = (name: string | null) => {
    const destination = AIRPORTS.find(airport => airport.name === name) ?? null
    this.change({ destination })
  }

  /** Starts cold at the terminal gate for an airliner, or in front of the hangars otherwise. */
  startAtStand = () => {
    this.leaveMission()
    this.beginAtStand()
  }

  /** Starts lined up at the end of the departure airport's main runway, engines off. */
  startOnRunway = () => {
    this.leaveMission()
    this.beginOnRunway()
  }

  /** Starts in level flight, about 100 seconds out on the approach to the main runway. */
  startInAir = () => {
    this.leaveMission()
    this.beginInAir()
  }

  /**
   * Starts a mission: its aircraft, weather, and starting point, keeping the free flight
   * settings to restore afterwards.
   */
  startMission = (mission: Mission) => {
    const spec = HANGAR.find(candidate => candidate.id === mission.aircraft)
    if (!spec) return
    if (!this.state.mission) {
      const { selected, departure, destination, weather, time, wind } = this.state
      this.freeFlight = { selected, departure, destination, weather, time, wind }
    }
    const { start } = mission
    const code = start.kind === 'stand' || start.kind === 'runway' ? start.airport : null
    this.setState({
      mission,
      missionResult: null,
      selected: spec,
      departure: AIRPORTS.find(airport => airport.code === code) ?? this.state.departure,
      destination: AIRPORTS.find(airport => airport.code === mission.destination) ?? null,
      weather: mission.weather ?? 'clear',
      time: mission.time ?? 'noon',
      wind: mission.wind ?? 'calm'
    })
    if (start.kind === 'stand' || start.kind === 'runway') {
      if (start.kind === 'stand') this.beginAtStand()
      else this.beginOnRunway()
    } else if ('speed' in start) {
      this.changeAircraft()
      const knots = start.speed * KNOT
      const fixedGear = !spec.retractableGear
      if (start.kind === 'air') {
        const heading = (start.heading * Math.PI) / 180
        this.sim.placeInAir(start.x, start.altitude, start.z, heading, knots)
        this.pilot.resetForAir(spec, this.sim)
        this.settle(((start.glide ?? 0) * Math.PI) / 180, 0, fixedGear)
        this.pilot.controls.speedBrake = start.speedBrake ?? false
      } else {
        const approach = APPROACHES.find(candidate => candidate.id === start.approach)
        if (!approach) return
        const { x, z } = onCentreline(approach.end, start.distance)
        const altitude = pathAltitude(approach.end, approach.glide, start.distance)
        this.sim.placeInAir(x, altitude, z, (approach.end.heading * Math.PI) / 180, knots)
        this.pilot.resetForAir(spec, this.sim)
        const glide = start.level ? 0 : approach.glide
        this.settle(glide, start.flapNotch ?? 0, start.gearDown ?? fixedGear)
      }
      this.fly()
    }
    const approach = APPROACHES.find(candidate => candidate.id === mission.approach)
    if (approach) this.nav.select(approach, this.sim)
    this.missions.start(mission, this.sim)
    this.won = null
    this.bombs.load(
      mission.bombs ?? 0,
      mission.targets ?? [],
      mission.guided,
      mission.missiles ?? 0
    )
  }

  /** Flies the current mission again from the start. */
  retryMission = () => {
    if (this.state.mission) this.startMission(this.state.mission)
  }

  /** Ends any mission and puts the free flight settings back. */
  leaveMission = () => {
    if (!this.state.mission) return
    this.missions.stop()
    this.setState({ mission: null, missionResult: null, ...this.freeFlight })
    this.freeFlight = null
    if (this.state.status !== 'flying') {
      this.placeAtStand()
      this.setState({ status: 'menu' })
    }
  }

  private beginAtStand() {
    this.placeAtStand()
    this.fly()
    this.loadPlan()
  }

  private beginOnRunway() {
    this.changeAircraft()
    const runway = this.state.departure.runways[0]
    const start = fromStrip(runway, -runway.length / 2 + 150, 0)
    this.sim.placeOnGround(start.x, start.z, (runway.heading * Math.PI) / 180)
    this.pilot.resetForGround(this.sim, false)
    this.fly()
    this.loadPlan()
  }

  private beginInAir() {
    const spec = this.changeAircraft()
    const airport = this.state.departure
    const runway = airport.runways[0]
    const distance = spec.cruiseSpeed * 100
    const start = fromStrip(runway, -runway.length / 2 - distance, 0)
    // On the glide path when the runway has an approach, its course already tuned in.
    // Otherwise 300 m above the highest ground between the start and the runway.
    const approach = APPROACHES.find(
      candidate => candidate.end.runway === runway && candidate.end.sense === 1
    )
    let altitude = 0
    if (approach) altitude = pathAltitude(approach.end, approach.glide, distance)
    else {
      let ridge = 0
      for (let along = 0; along <= distance; along += 100) {
        const spot = fromStrip(runway, -runway.length / 2 - along, 0)
        ridge = Math.max(ridge, heightAt(spot.x, spot.z))
      }
      altitude = Math.max(airport.elevation + spec.cruiseSpeed * 9, ridge + 300)
    }
    this.sim.placeInAir(
      start.x,
      altitude,
      start.z,
      (runway.heading * Math.PI) / 180,
      spec.cruiseSpeed
    )
    this.pilot.resetForAir(spec, this.sim)
    this.settle(0, 0, !spec.retractableGear)
    this.fly()
    this.nav.select(approach ?? null, this.sim)
    const { destination } = this.state
    if (destination && destination !== airport) {
      const here = this.sim.position
      this.nav.load(
        planRoute(
          { x: here.x, z: here.z, heading: this.sim.heading },
          destination,
          spec,
          WIND_FROM
        ),
        this.sim
      )
    }
  }

  /** Plans the route from the departure's main runway to the destination, if one is picked. */
  private loadPlan() {
    const { departure, destination, selected } = this.state
    if (!destination || destination === departure) return
    const runway = departure.runways[0]
    const liftOff = fromStrip(runway, runway.length / 2, 0)
    const heading = (runway.heading * Math.PI) / 180
    this.nav.load(planRoute({ ...liftOff, heading }, destination, selected, WIND_FROM), this.sim)
  }

  /** A mechanical click from a cockpit switch or notch, `strength` from 0 to 1. */
  click = (strength: number) => {
    if (!this.state.muted) this.sound.click(strength)
  }

  /** Creates the sound engine. Browsers allow this only during a click, such as Enter VR. */
  prepareSound = () => this.sound.start()

  pause = () => {
    if (this.state.status !== 'flying') return
    this.pilot.releaseAll()
    this.setState({ status: 'paused' })
  }

  resume = () => {
    if (this.state.status === 'paused') this.setState({ status: 'flying' })
  }

  setWind = (wind: WindLevel) => this.change({ wind })
  setWeather = (weather: Weather) => this.change({ weather })
  setTime = (time: TimeOfDay) => this.change({ time })
  toggleMuted = () => this.change({ muted: !this.state.muted })
  setCoach = (on: boolean) => this.change({ coach: on })
  /** Enters or leaves the bombsight. It only opens with bombs aboard. */
  toggleBombsight = () => {
    const { bombs } = this
    const open = this.state.bombsight
    if (!open && bombs.loaded === 0 && bombs.falling.length === 0) return
    this.rippleHeld = false
    this.setState({ bombsight: !open })
  }

  toggleCamera = () => this.change({ camera: this.state.camera === 'chase' ? 'cockpit' : 'chase' })

  /**
   * Switches to the headset: the pilot's seat, and graphics light enough to hold the
   * headset's frame rate. Taking it off puts back the player's own choices. Neither is saved.
   */
  setVR = (on: boolean) => {
    if (on === this.state.vr) return
    if (on) {
      this.beforeVR = { graphics: this.state.graphics, camera: this.state.camera }
      this.setState({ vr: true, camera: 'cockpit', graphics: VR_GRAPHICS })
    } else {
      this.setState({ vr: false, ...this.beforeVR })
      this.beforeVR = null
    }
  }

  /** Steps to the next approach, nearest airport first, and stops the autopilot flying the old one. */
  cycleApproach = () => {
    this.nav.cycle(this.sim, WIND_FROM)
    this.pilot.flyApproach(false, this.sim, this.nav)
  }

  /** Clears the selected approach. */
  clearApproach = () => {
    this.nav.select(null, this.sim)
    this.pilot.flyApproach(false, this.sim, this.nav)
  }

  /** Lets the autopilot fly the approach, picking the best one first if none is selected. */
  toggleApproachAutopilot = () => {
    if (!this.nav.approach) this.nav.cycle(this.sim, WIND_FROM)
    this.pilot.flyApproach(!this.pilot.flyingApproach, this.sim, this.nav)
  }

  /**
   * Fires a missile, or in the bombsight releases a bomb and starts a string while `held`.
   * Returns true when something left the aircraft or a release was armed.
   */
  release = () => {
    if (this.state.status !== 'flying') return false
    if (this.bombs.missiles > 0) {
      const before = this.bombs.missiles
      this.bombs.fire(this.sim)
      return this.bombs.missiles < before
    }
    if (!this.state.bombsight) return false
    const before = this.bombs.loaded
    const armed = this.bombs.armed
    this.bombs.release(this.sim)
    this.rippleHeld = true
    this.rippleClock = RIPPLE_START
    return this.bombs.loaded < before || this.bombs.armed !== armed
  }

  /** Stops the string of bombs a held release started. */
  endRelease = () => {
    this.rippleHeld = false
  }
  toggleMap = () => {
    const next = { small: 'large', large: 'hidden', hidden: 'small' } as const
    this.change({ map: next[this.state.map] })
  }

  /** Picks a graphics preset, which sets every graphics choice at once. */
  setGraphicsPreset = (preset: Exclude<GraphicsPreset, 'custom'>) =>
    this.change({ graphics: GRAPHICS_PRESETS[preset] })

  /** Changes one graphics choice by hand, which leaves the presets for Custom. */
  setGraphics = (choice: Partial<Omit<Graphics, 'preset'>>) =>
    this.change({ graphics: { ...this.state.graphics, ...choice, preset: 'custom' } })

  /** Applies a change the player made, and remembers it for the next visit. */
  private change(patch: Partial<GameState>) {
    this.setState(patch)
    // During a mission, the free flight choices it set aside are the ones to keep,
    // and in VR, the graphics and camera from before the headset went on
    const free = { ...this.state, ...this.freeFlight }
    const own = { ...this.state, ...this.beforeVR }
    saveSettings({
      wind: free.wind,
      weather: free.weather,
      time: free.time,
      muted: this.state.muted,
      coach: this.state.coach,
      map: this.state.map,
      camera: own.camera,
      graphics: own.graphics,
      aircraft: free.selected.id,
      departure: free.departure.code,
      destination: free.destination?.code ?? null
    })
  }

  /** Advances the game by one rendered frame of `delta` seconds. */
  frame(delta: number) {
    const dt = Math.min(delta, 0.1)
    const { status } = this.state
    if (delta > 0) this.frameRate += (1 / delta - this.frameRate) * 0.05
    if (status !== 'paused') {
      this.sceneryTime += dt
      this.traffic.update(this.sceneryTime)
    }
    if (status === 'flying') {
      this.nav.update(this.sim)
      this.pilot.update(dt, this.sim, this.nav)
      const steps = Math.ceil(dt / MAX_STEP)
      const step = dt / steps
      for (let i = 0; i < steps; i++) {
        this.time += step
        this.updateWind()
        this.sim.step(step, this.pilot.controls, this.wind)
        // Trees, buildings, balloons, boats, and other aircraft are solid
        this.sim.crash ??= findCollision(this.sim, this.sceneryTime, this.traffic, this.bombs.ruins)
        if (this.sim.crash) break
      }
      if (this.sim.crash) this.breakUp(this.sim.crash)
      else {
        this.gpws.update(dt, this.sim, this.pilot.controls, this.nav)
        if (this.effects.emitFlight(dt, this.sim, ISLAND_GROUND)) this.sound.chirp()
        this.burnEngines(dt)
        this.trackFlight()
        this.dropString(dt)
        for (const impact of this.bombs.update(dt, this.sim, ISLAND_GROUND)) this.blast(impact)
        this.burnTargets(dt)
        this.checkMission(dt)
      }
    } else if (status === 'crashed') {
      this.wreck.step(dt, ISLAND_GROUND, this.effects)
      if (!this.state.crashShown && this.wreck.time > CRASH_REPLAY) {
        this.setState({ crashShown: true })
      }
    }
    if (status === 'flying' || status === 'crashed') this.effects.update(dt, this.wind)
    const audible = !this.state.muted && (status === 'flying' || status === 'crashed')
    this.sound.update(this.sim, audible ? status : 'silent')
    for (const listener of this.frameListeners) listener()
  }

  /** Starts listening to the keyboard. Returns a function that stops listening. */
  attach() {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const { status } = this.state
      if (event.code === 'Escape') {
        if (status === 'flying') this.pause()
        else this.resume()
        return
      }
      // A focused button or list already reacts to Enter
      const widget =
        event.target instanceof HTMLButtonElement || event.target instanceof HTMLSelectElement
      // Tab opens and closes the bombsight, so the browser must not move the focus
      if (event.code === 'Tab' && status === 'flying') {
        event.preventDefault()
        if (!event.repeat) this.toggleBombsight()
        return
      }
      // Enter releases a bomb in the bombsight, and starts or resumes from the menus
      if (event.code === 'Enter' && status === 'flying') {
        event.preventDefault()
        // Missiles fire straight from the normal view, with no sight to open
        if (!event.repeat) this.release()
        return
      }
      if (event.code === 'Enter' && !widget) {
        if (status === 'paused') this.resume()
        else if (this.state.mission && status !== 'flying') this.retryMission()
        else if (status !== 'flying') this.startAtStand()
        return
      }
      if (status !== 'flying') return
      if (event.code === 'KeyC' && !event.repeat) this.toggleCamera()
      else if (event.code === 'KeyM' && !event.repeat) this.toggleMap()
      else if (event.code === 'KeyN' && !event.repeat) {
        if (event.shiftKey) this.clearApproach()
        else this.cycleApproach()
      } else if (event.code === 'KeyT' && !event.repeat) {
        this.toggleApproachAutopilot()
      } else if (this.pilot.press(event.code, event.repeat, this.sim, this.nav, event.shiftKey)) {
        event.preventDefault()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Enter') this.endRelease()
      this.pilot.release(event.code)
    }
    // Entering VR can take the focus from the page, which must not pause the flight
    const onBlur = () => {
      if (!this.state.vr) this.pause()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }

  /**
   * Notes the liftoff and the touchdown, and ends the flight once the aircraft is
   * parked on an apron with the parking brake set and the engines stopped.
   */
  /** Advances the mission's objectives, and ends the flight once it passes or fails. */
  private checkMission(dt: number) {
    if (this.won) {
      this.won.left -= dt
      if (this.won.left <= 0) this.finishMission(this.won.result)
      return
    }
    const result = this.missions.update(dt, {
      sim: this.sim,
      controls: this.pilot.controls,
      pilot: this.pilot,
      nav: this.nav,
      parkedAt: this.parkedAirport(),
      bombs: this.bombs,
      bombsight: this.state.bombsight
    })
    if (!result) return
    if (result.passed && this.bombs.targets.length > 0) {
      this.won = { result, left: BLAST_REPLAY }
      return
    }
    this.finishMission(result)
  }

  private finishMission(result: MissionResult) {
    this.won = null
    const { mission } = this.state
    if (result.passed && mission) rememberPassed(mission.id)
    this.pilot.releaseAll()
    this.gpws.alert = null
    this.setState({ status: 'finished', missionResult: result })
  }

  /**
   * A bomb going off: a fireball and debris on land, spray at sea. The sound and the shake
   * fade with distance, so a blast far below rumbles rather than rattles.
   */
  /** Where the winning bomb landed, while the view circles its blast before the results. */
  get blastReplay() {
    return this.won ? this.lastBlast : null
  }

  private blast(impact: Impact) {
    this.lastBlast.copy(impact.at)
    const distance = impact.at.distanceTo(this.sim.position)
    const shake = this.effects.shake
    if (impact.water) this.effects.splash(impact.at, 3)
    else this.effects.bombBlast(impact.at)
    this.effects.shake = Math.max(shake, 0.9 * Math.max(0, 1 - distance / 3000))
    if (!this.state.muted)
      this.sound.crash(Math.max(0.15, Math.min(1, 1.2 - distance / 6000)), impact.water)
  }

  /**
   * Holding Enter in the bombsight over a city drops a string of bombs. Missions with
   * targets keep one bomb per press, so a held key never spoils an armed release.
   */
  private dropString(dt: number) {
    const { bombs } = this
    if (this.state.bombsight && bombs.loaded === 0 && bombs.falling.length === 0) {
      if (bombs.sinceImpact > SIGHT_LINGER) this.setState({ bombsight: false })
    }
    if (!this.rippleHeld || !this.state.bombsight || bombs.targets.length > 0) return
    this.rippleClock -= dt
    if (this.rippleClock > 0) return
    bombs.drop(this.sim)
    this.rippleClock = RIPPLE_GAP
  }

  /**
   * Flames and smoke from each burning engine, and spray while a ditched aircraft slides to
   * a stop on the sea.
   */
  private burnEngines(dt: number) {
    const { sim } = this
    const spots = engineSpots(sim.spec)
    for (const missile of this.bombs.flying) this.effects.missileTrail(missile.position, dt)
    sim.engines.forEach((engine, i) => {
      if (!engine.fire) return
      spot
        .copy(spots[i] ?? spots[0])
        .applyQuaternion(sim.orientation)
        .add(sim.position)
      this.effects.engineFire(spot, dt)
    })
    if (!sim.ditched) {
      this.sprayClock = 0
      return
    }
    // The first touch throws up a big sheet of spray, then less as the aircraft slows
    if (this.sprayClock === 0) this.effects.splash(sim.position, 2.5)
    this.sprayClock += dt
    if (sim.groundSpeed > 4 && this.sprayClock % 0.2 < dt) {
      this.effects.splash(sim.position, Math.min(0.6, sim.groundSpeed / 80))
    }
  }

  /** Destroyed targets and the newest ruins burn, then smoulder, for the rest of the flight. */
  private burnTargets(dt: number) {
    const { bombs } = this
    bombs.targets.forEach((target, i) => {
      if (!bombs.destroyed[i]) return
      spot.set(target.x, ISLAND_GROUND.heightAt(target.x, target.z), target.z)
      this.effects.burn(spot, 1, dt)
    })
    const { craters } = bombs.ruins
    for (let i = craters.length - 1, shown = 0; i >= 0 && shown < BURNING_RUINS; i--) {
      const crater = craters[i]
      if (crater.fell === 0) continue
      shown++
      spot.set(crater.x, ISLAND_GROUND.heightAt(crater.x, crater.z), crater.z)
      this.effects.burn(spot, 1.4, dt)
    }
  }

  /** The airport whose apron the aircraft is parked on, brake set and engines off. */
  private parkedAirport() {
    const { sim } = this
    if (!sim.onGround || sim.groundSpeed > 0.3) return null
    if (!this.pilot.controls.parkingBrake || sim.enginesRunning > 0) return null
    const { x, z } = sim.position
    return (
      AIRPORTS.find(candidate => candidate.aprons.some(apron => outside(apron, x, z) === 0)) ?? null
    )
  }

  private trackFlight() {
    const { sim } = this
    if (!sim.onGround) {
      this.sinkRate = -sim.verticalSpeed
      if (this.liftoffTime === null && sim.altitudeAgl > AIRBORNE_HEIGHT)
        this.liftoffTime = this.time
      return
    }
    if (this.sinkRate > 0) {
      this.touchdownRate = this.sinkRate
      this.sinkRate = 0
    }
    // Missions decide for themselves when parking ends the flight
    if (this.liftoffTime === null || this.state.mission) return
    const airport = this.parkedAirport()
    if (!airport) return
    this.setState({
      status: 'arrived',
      arrival: {
        airport,
        flightSeconds: this.time - this.liftoffTime,
        touchdownRate: this.touchdownRate
      }
    })
  }

  /** Swaps the world's aircraft for the selected one and clears any wreckage. */
  private changeAircraft() {
    const spec = this.state.selected
    this.wreck.reset()
    this.effects.clear()
    this.sim.setAircraft(spec)
    if (this.state.flown !== spec) this.setState({ flown: spec })
    return spec
  }

  private placeAtStand() {
    const spec = this.changeAircraft()
    const airport = this.state.departure
    // Airliners park at the terminal; everything else parks in front of the hangars
    const stands = spec.shape.type === 'airliner' ? airport.gates : airport.ramps
    const stand = stands[Math.floor(stands.length / 2)]
    this.sim.placeOnGround(stand.x, stand.z, stand.heading)
    // At the stand everything starts cold and dark
    this.pilot.resetForGround(this.sim, true)
  }

  private fly() {
    this.flight++
    // Bombers carry a load in free flight too. A mission loads its own after this.
    this.bombs.load(this.sim.spec.bombBay ?? 0, [])
    this.rippleHeld = false
    this.pilot.releaseAll()
    this.gpws.reset(this.sim)
    this.nav.load(null, this.sim)
    this.sound.start()
    this.liftoffTime = null
    this.sinkRate = 0
    this.touchdownRate = 0
    this.setState({
      status: 'flying',
      bombsight: false,
      crash: null,
      crashShown: false,
      arrival: null
    })
  }

  /** Ends the flight: the aircraft breaks apart with a blast on land or a splash at sea. */
  private breakUp(reason: CrashReason) {
    this.pilot.releaseAll()
    this.gpws.alert = null
    this.wreck.start(this.sim, reason, ISLAND_GROUND, this.effects)
    this.sound.crash(Math.min(1, Math.max(0.5, this.effects.shake)), reason === 'water')
    this.setState({ status: 'crashed', crash: reason, crashShown: false })
  }

  /**
   * Trims an aircraft just placed in the air for a steady descent `glide` radians down, or
   * level flight at 0, so it flies on by itself until the pilot takes over.
   */
  private settle(glide: number, flapNotch: number, gearDown: boolean) {
    this.updateWind()
    const hold = this.sim.settleOnPath(glide, flapNotch, gearDown, this.wind)
    Object.assign(this.pilot.controls, { flapNotch, gearDown, ...hold })
  }

  /** Steady wind with gusts and small, slow direction swings. */
  private updateWind() {
    const speed = WIND_SPEEDS[this.state.wind]
    const t = this.time
    // Gusts come every few seconds, well away from the slow 15 to 35 second swing in speed
    // and height that a disturbed aircraft settles with, so they never build it up
    const gust = 1 + 0.2 * Math.sin(t * 0.83) + 0.12 * Math.sin(t * 1.9 + 1.7)
    const toward =
      ((WIND_FROM + 180) * Math.PI) / 180 +
      0.15 * Math.sin(t * 0.23 + 0.5) +
      0.08 * Math.sin(t * 0.9)
    this.wind.set(
      Math.sin(toward) * speed * gust,
      speed * 0.06 * Math.sin(t * 1.9 + 0.3),
      -Math.cos(toward) * speed * gust
    )
  }

  private setState(patch: Partial<GameState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.stateListeners) listener()
  }
}

/** The settings saved on the last visit, with the aircraft and airports looked up. */
function savedState() {
  const saved = loadSettings()
  const selected = HANGAR.find(spec => spec.id === saved.aircraft) ?? DEFAULT_AIRCRAFT
  const byCode = (code: string | null) => AIRPORTS.find(airport => airport.code === code)
  const stored = byCode(saved.departure)
  const departure =
    stored && canUse(selected, stored)
      ? stored
      : (AIRPORTS.find(airport => canUse(selected, airport)) ?? AIRPORTS[0])
  const target = byCode(saved.destination)
  const destination = target && target !== departure && canUse(selected, target) ? target : null
  return {
    camera: saved.camera,
    wind: saved.wind,
    muted: saved.muted,
    coach: saved.coach,
    map: saved.map,
    graphics: saved.graphics,
    weather: saved.weather,
    time: saved.time,
    selected,
    departure,
    destination,
    flown: selected
  }
}

/** Graphics in the headset: what a Quest 2 can draw twice, once per eye, 72 times a second. */
const VR_GRAPHICS = GRAPHICS_PRESETS.low

export const game = new Game()

/** Subscribes a component to one piece of menu state. */
export function useGame<T>(select: (state: GameState) => T) {
  return useSyncExternalStore(game.subscribe, () => select(game.getState()))
}
