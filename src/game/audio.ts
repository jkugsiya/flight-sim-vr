import type { FlightSim } from '../sim/flight-sim'

/** What the player should hear: the aircraft in flight, only the crash, or nothing. */
export type SoundMode = 'flying' | 'crashed' | 'silent'

// The piston firing cycle is recorded for this rpm: one cycle is two revolutions
const CYCLE_RPM = 1200
const CYCLE_SECONDS = 2 / (CYCLE_RPM / 60)

/** Synthesised engine, wind, stall horn, tyre chirp, and crash sounds. */
export class Sound {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private engine: OscillatorNode | null = null
  private engineSub: OscillatorNode | null = null
  private engineFilter: BiquadFilterNode | null = null
  private engineGain: GainNode | null = null
  private windGain: GainNode | null = null
  private hornGain: GainNode | null = null
  /** A piston engine: a looped firing cycle, sped up and slowed with the rpm. */
  private piston: AudioBufferSourceNode | null = null
  private pistonFilter: BiquadFilterNode | null = null
  private pistonGain: GainNode | null = null
  /** The propeller's whup: rushing noise pulsed as each blade passes. */
  private propGain: GainNode | null = null
  private bladeBeat: OscillatorNode | null = null
  private bladeDepth: GainNode | null = null

  /** Creates the audio graph. Browsers only allow this after a click or key press. */
  start() {
    if (this.context) {
      void this.context.resume()
      return
    }
    const context = new AudioContext()
    const master = context.createGain()
    master.gain.value = 0
    master.connect(context.destination)

    const engineFilter = context.createBiquadFilter()
    engineFilter.type = 'lowpass'
    const engineGain = context.createGain()
    engineGain.gain.value = 0
    engineFilter.connect(engineGain).connect(master)
    const engine = context.createOscillator()
    engine.type = 'sawtooth'
    const engineSub = context.createOscillator()
    engineSub.type = 'square'
    engine.connect(engineFilter)
    engineSub.connect(engineFilter)
    engine.start()
    engineSub.start()

    // Two seconds of white noise: looped for wind, played once for chirps and blasts
    const noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
    const samples = noise.getChannelData(0)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1
    const wind = context.createBufferSource()
    wind.buffer = noise
    wind.loop = true
    const windFilter = context.createBiquadFilter()
    windFilter.type = 'bandpass'
    windFilter.frequency.value = 500
    windFilter.Q.value = 0.4
    const windGain = context.createGain()
    windGain.gain.value = 0
    wind.connect(windFilter).connect(windGain).connect(master)
    wind.start()

    // One four-stroke cycle of a four-cylinder engine at the reference rpm: four exhaust
    // pops, each a little different, as no two cylinders fire quite alike
    const cycle = context.createBuffer(
      1,
      Math.round(context.sampleRate * CYCLE_SECONDS),
      context.sampleRate
    )
    const wave = cycle.getChannelData(0)
    const spacing = CYCLE_SECONDS / 4
    for (let cylinder = 0; cylinder < 4; cylinder++) {
      const start = cylinder * spacing + (Math.random() - 0.5) * spacing * 0.08
      const strength = 0.8 + Math.random() * 0.25
      for (let i = 0; i < wave.length; i++) {
        let t = i / context.sampleRate - start
        if (t < 0) t += CYCLE_SECONDS
        const pop = Math.exp(-t / 0.005) * (Math.random() * 2 - 1) * 0.7
        const thump = Math.exp(-t / 0.014) * Math.sin(2 * Math.PI * 70 * t)
        wave[i] += (pop + thump) * strength * 0.45
      }
    }
    const piston = context.createBufferSource()
    piston.buffer = cycle
    piston.loop = true
    const pistonFilter = context.createBiquadFilter()
    pistonFilter.type = 'lowpass'
    const pistonGain = context.createGain()
    pistonGain.gain.value = 0
    piston.connect(pistonFilter).connect(pistonGain).connect(master)
    piston.start()

    const prop = context.createBufferSource()
    prop.buffer = noise
    prop.loop = true
    const propFilter = context.createBiquadFilter()
    propFilter.type = 'bandpass'
    propFilter.frequency.value = 650
    propFilter.Q.value = 0.7
    const propGain = context.createGain()
    propGain.gain.value = 0
    const bladeBeat = context.createOscillator()
    const bladeDepth = context.createGain()
    bladeDepth.gain.value = 0
    bladeBeat.connect(bladeDepth).connect(propGain.gain)
    prop.connect(propFilter).connect(propGain).connect(master)
    prop.start(0, 0.7)
    bladeBeat.start()

    const horn = context.createOscillator()
    horn.type = 'square'
    horn.frequency.value = 540
    const hornGain = context.createGain()
    hornGain.gain.value = 0
    horn.connect(hornGain).connect(master)
    horn.start()

    Object.assign(this, {
      context,
      master,
      noise,
      engine,
      engineSub,
      engineFilter,
      engineGain,
      windGain,
      hornGain,
      piston,
      pistonFilter,
      pistonGain,
      propGain,
      bladeBeat,
      bladeDepth
    })
  }

  /** Matches the continuous sounds to the aircraft. */
  update(sim: FlightSim, mode: SoundMode) {
    const { context, master, engine, engineSub, engineFilter, engineGain, windGain, hornGain } =
      this
    if (!context || !master || !engine || !engineSub || !engineFilter) return
    const now = context.currentTime
    const flying = mode === 'flying'
    master.gain.setTargetAtTime(mode === 'silent' ? 0 : 1, now, 0.08)
    const jet = sim.spec.engine.type === 'jet'
    // The fastest engine sets the pitch, so one running engine is heard among stopped ones
    let rpm = 0
    for (const state of sim.engines) rpm = Math.max(rpm, state.rpm)
    const { rotor } = sim.spec
    const turning = flying && (rotor ? sim.rotorSpeed > 0.05 : jet ? rpm > 15 : rpm > 50)
    if (rotor) {
      // Each blade slaps the air once a turn, about 17 times a second at full rotor speed
      const slap = Math.max(1, (sim.rotorSpeed * rotor.speed * rotor.blades) / (Math.PI * 2))
      engine.type = 'sawtooth'
      engine.frequency.setTargetAtTime(slap, now, 0.05)
      engineSub.frequency.setTargetAtTime(slap / 2, now, 0.05)
      engineFilter.frequency.setTargetAtTime(200 + 250 * sim.rotorSpeed, now, 0.05)
      const thump = Math.min(1, sim.rotorSpeed) * (0.05 + 0.08 * sim.enginePower)
      engineGain?.gain.setTargetAtTime(turning ? thump : 0, now, 0.1)
    } else if (jet) {
      // A turbine whines far above the low rumble of its exhaust
      engine.type = 'sine'
      engine.frequency.setTargetAtTime(700 + rpm * 24, now, 0.1)
      engineSub.frequency.setTargetAtTime(45 + rpm * 0.5, now, 0.1)
      engineFilter.frequency.setTargetAtTime(4000, now, 0.05)
      engineGain?.gain.setTargetAtTime(turning ? 0.012 + 0.02 * sim.enginePower : 0, now, 0.1)
      this.pistonGain?.gain.setTargetAtTime(0, now, 0.1)
      this.propGain?.gain.setTargetAtTime(0, now, 0.1)
      this.bladeDepth?.gain.setTargetAtTime(0, now, 0.1)
    } else {
      // The firing cycle plays faster as the engine speeds up: chuffs on the starter, a
      // steady rumble at idle, a hard drone at full power. Cabin walls take off the top.
      engineGain?.gain.setTargetAtTime(0, now, 0.1)
      const power = sim.enginePower
      this.piston?.playbackRate.setTargetAtTime(Math.max(rpm, 30) / CYCLE_RPM, now, 0.05)
      this.pistonFilter?.frequency.setTargetAtTime(500 + rpm * 0.9, now, 0.05)
      this.pistonGain?.gain.setTargetAtTime(turning ? 0.22 + 0.3 * power : 0, now, 0.08)
      // A two-blade propeller passes twice per revolution
      const blades = Math.max(rpm / 30, 1)
      const whup = turning ? 0.015 + 0.07 * power * Math.min(1, rpm / 2000) : 0
      this.bladeBeat?.frequency.setTargetAtTime(blades, now, 0.05)
      this.propGain?.gain.setTargetAtTime(whup, now, 0.1)
      this.bladeDepth?.gain.setTargetAtTime(whup * 0.8, now, 0.1)
    }
    // Rushing air, plus the roar of the exhaust on a jet
    const air = Math.min(0.25, (sim.indicatedAirspeed / 70) ** 2 * 0.15)
    const roar = jet && turning ? 0.04 + 0.22 * sim.enginePower + (sim.afterburner ? 0.25 : 0) : 0
    windGain?.gain.setTargetAtTime(flying ? air + roar : 0, now, 0.2)
    hornGain?.gain.setTargetAtTime(flying && sim.stallWarning ? 0.09 : 0, now, 0.03)
  }

  /**
   * Speaks a cockpit voice phrase with the browser's speech voice. An urgent phrase cuts off
   * whatever is being said; others wait their turn.
   */
  say(phrase: string, urgent: boolean) {
    if (typeof speechSynthesis === 'undefined') return
    if (urgent) speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(phrase)
    utterance.rate = 1.15
    utterance.pitch = 0.85
    speechSynthesis.speak(utterance)
  }

  /** A cockpit switch, knob detent, or lever notch: a short mechanical click. */
  click(strength: number) {
    this.burst('highpass', 3500, 1800, 0.25 * strength, 0.03)
  }

  /** Short squeal of a tyre touching the runway. */
  chirp() {
    this.burst('highpass', 2400, 2400, 0.6, 0.18)
  }

  /** Deep blast for a crash on land, or a wash of spray for a crash at sea. */
  crash(power: number, inSea: boolean) {
    if (inSea) {
      this.burst('bandpass', 1400, 500, 1.1 * power, 1.8)
      return
    }
    this.burst('lowpass', 1800, 70, 1.1 * power, 2.4)
    const { context, master } = this
    if (!context || !master) return
    // A falling sine adds the thump you feel in the chest
    const now = context.currentTime
    const thump = context.createOscillator()
    thump.frequency.setValueAtTime(75, now)
    thump.frequency.exponentialRampToValueAtTime(28, now + 0.7)
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.9 * power, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9)
    thump.connect(gain).connect(master)
    thump.start(now)
    thump.stop(now + 1)
  }

  /**
   * Thunder from a lightning flash `distance` metres away. It starts once the sound has
   * travelled that far at 343 m/s. A close strike cracks, then rumbles; a far one only rolls,
   * softer and lower.
   */
  thunder(distance: number) {
    const { context, master, noise } = this
    if (!context || !master || !noise) return
    const start = context.currentTime + distance / 343
    const near = Math.max(0, 1 - distance / 12_000)
    const volume = 0.12 + 0.6 * near * near
    if (near > 0.6) this.roll(start, 'bandpass', 2600, volume * 0.8, 0.01, 0.35)
    // Overlapping rolls make the rumble swell and fade unevenly, longer the farther away
    let at = start
    for (let i = 0; i < 4; i++) {
      const pitch = (90 + 260 * near) * (0.75 + Math.random() * 0.5)
      const loud = volume * (i === 0 ? 1 : 0.5 + Math.random() * 0.5)
      this.roll(at, 'lowpass', pitch, loud, 0.15 + Math.random() * 0.3, 2 + Math.random() * 3)
      at += (0.3 + Math.random() * 0.8) * (1.6 - near)
    }
  }

  /** Plays filtered noise from `at` seconds that swells for `attack` seconds, then fades. */
  private roll(
    at: number,
    type: BiquadFilterType,
    hz: number,
    volume: number,
    attack: number,
    seconds: number
  ) {
    const { context, master, noise } = this
    if (!context || !master || !noise) return
    const source = context.createBufferSource()
    source.buffer = noise
    source.loop = true
    const filter = context.createBiquadFilter()
    filter.type = type
    filter.frequency.value = hz
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(volume, at + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds)
    source.connect(filter).connect(gain).connect(master)
    source.start(at, Math.random())
    source.stop(at + seconds)
  }

  /** Plays filtered noise that fades out, sweeping the filter from one frequency to another. */
  private burst(
    type: BiquadFilterType,
    fromHz: number,
    toHz: number,
    volume: number,
    seconds: number
  ) {
    const { context, master, noise } = this
    if (!context || !master || !noise) return
    const now = context.currentTime
    const source = context.createBufferSource()
    source.buffer = noise
    source.loop = true
    const filter = context.createBiquadFilter()
    filter.type = type
    filter.frequency.setValueAtTime(fromHz, now)
    filter.frequency.exponentialRampToValueAtTime(toHz, now + seconds)
    const gain = context.createGain()
    gain.gain.setValueAtTime(volume, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + seconds)
    source.connect(filter).connect(gain).connect(master)
    source.start(now, Math.random())
    source.stop(now + seconds)
  }
}
