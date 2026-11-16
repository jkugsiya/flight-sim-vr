import type { FlightSim } from '../sim/flight-sim'

/** What the player should hear: the aircraft in flight, only the crash, or nothing. */
export type SoundMode = 'flying' | 'crashed' | 'silent'

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
      hornGain
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
    const turning = flying && (jet ? rpm > 15 : rpm > 50)
    if (jet) {
      // A turbine whines far above the low rumble of its exhaust
      engine.type = 'sine'
      engine.frequency.setTargetAtTime(700 + rpm * 24, now, 0.1)
      engineSub.frequency.setTargetAtTime(45 + rpm * 0.5, now, 0.1)
      engineFilter.frequency.setTargetAtTime(4000, now, 0.05)
      engineGain?.gain.setTargetAtTime(turning ? 0.012 + 0.02 * sim.enginePower : 0, now, 0.1)
    } else {
      // A four-cylinder engine fires twice per revolution
      const firing = Math.max(rpm / 30, 1)
      engine.type = 'sawtooth'
      engine.frequency.setTargetAtTime(firing, now, 0.05)
      engineSub.frequency.setTargetAtTime(firing / 2, now, 0.05)
      engineFilter.frequency.setTargetAtTime(180 + rpm * 0.3, now, 0.05)
      engineGain?.gain.setTargetAtTime(turning ? 0.04 + 0.1 * sim.enginePower : 0, now, 0.1)
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
