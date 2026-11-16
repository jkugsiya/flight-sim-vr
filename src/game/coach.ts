import { KNOT } from '../sim/aircraft'
import type { FlightSim } from '../sim/flight-sim'
import type { Approach } from '../world/approaches'
import type { Navigator } from './navigation'
import { canAutoland, type Pilot } from './pilot'

/**
 * One line of landing advice. Keys sit in square brackets, after "tap" or "hold". A status
 * line only reports how things stand, with nothing to do, so the screen can leave it out.
 */
export type Advice = { text: string; tone: 'status' | 'good' | 'fix' | 'warn' }

const FEET = 0.3048
const FPM = 0.00508
const DEGREES = Math.PI / 180
const turnTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// Below this height the coach stops steering by the glide path and aims at the runway
const SHORT_FINAL = 200 * FEET
// Metres off the centreline that ask for the full turn back, per m/s of ground speed. Light
// aircraft swing across the line quickly, so the turn back eases in over 18 m at 70 kt;
// jets turn slowly, and need to be firmly back on the line before the runway.
const FULL_TURN_SECONDS = { piston: 0.5, jet: 0.25 }
// Degrees of bank asked for per degree of track still to turn
const BANK_GAIN = 2.5
// Steepest turn back toward the centreline, and the bank to fly it
const MAX_CORRECTION = 10 * DEGREES
const CORRECTION_BANK = 10 * DEGREES
// Most bank the coach asks for in the flare, to stop a sideways drift
const FLARE_BANK = 5 * DEGREES
// Bank within this of the bank wanted needs no correction
const BANK_SLACK = 4 * DEGREES
// Height off the glide path that counts as on it: this share of the height above the runway
const PATH_SHARE = 0.12
// Steepest change to the descent angle the coach asks for to get back on the glide path
const PATH_CORRECTION = 1.5 * DEGREES
// Throttle within this of the power the coach wants needs no change
const POWER_SLACK = 0.04

/**
 * Advice for a landing on the tuned approach, from the final approach to the stop: the
 * gear, flaps, and speed, then the glide path and flare by hand, or what the autopilot is
 * doing when it lands. Null away from the final approach and while the autopilot holds a heading.
 */
export function landingAdvice(sim: FlightSim, nav: Navigator, pilot: Pilot): Advice | null {
  const { approach } = nav
  if (!approach || !nav.onFinal || nav.enroute) return null
  const autoland = pilot.flyingApproach && canAutoland(sim)
  if (sim.onGround) {
    if (sim.groundSpeed < 1.5) return null
    if (pilot.autopilot.on) {
      return {
        text: 'The autopilot is braking and steering. It hands back at 30 knots.',
        tone: 'status'
      }
    }
    return rollout(sim, nav, pilot, approach)
  }
  // Wheel height above the runway, or above the ground on the way in over hills
  const above = Math.min(sim.altitudeAgl, sim.position.y - approach.end.elevation)
  const height = above - sim.spec.restHeight
  // The autopilot works the rudder itself, but leaves the gear and flaps to the pilot
  const yaw = pilot.autopilot.on ? null : rudder(sim)
  const setup = configure(sim, pilot, height)
  if (pilot.flyingApproach) {
    const flying: Advice = autoland
      ? { text: 'The autopilot will land the aircraft. Press [Z] to take over.', tone: 'status' }
      : { text: 'The autopilot is flying. It hands you control at 50 ft.', tone: 'status' }
    return combine([yaw, setup, flying].filter(tip => tip !== null))
  }
  if (pilot.autopilot.on) return yaw ?? setup
  // Airliners start the flare higher, as their noses come up slowly
  const flareHeight = (sim.spec.engine.type === 'piston' ? 15 : 30) * FEET
  if (height < flareHeight * 2 && sim.verticalSpeed > 0.25) {
    return { text: 'Ballooning: ease off [↓] and hold the nose steady.', tone: 'fix' }
  }
  if (height < flareHeight) return flare(sim, nav, pilot, approach, height)
  const tips = [
    yaw,
    setup,
    steer(sim, nav, approach, height),
    descend(sim, nav, pilot, approach, height)
  ]
  const shown = tips.filter(tip => tip !== null)
  if (shown.length > 0) return combine(shown)
  const where = height < SHORT_FINAL ? 'Aim at the runway numbers' : 'On the glide path'
  const lined = Math.abs(nav.guidance.across) < 10 ? 'lined up' : 'turning back to the runway line'
  // Airliners can land themselves, which a new pilot may not know
  const offer =
    canAutoland(sim) && height > 500 * FEET ? ' Or press [T] and the autopilot lands it.' : ''
  return { text: `${where}, ${lined}. Keep it steady.${offer}`, tone: 'status' }
}

/**
 * Gear and flaps for landing, each once the speed allows it, from 2,500 ft down. Light
 * aircraft with fixed gear only need the flaps.
 */
function configure(sim: FlightSim, pilot: Pilot, height: number): Advice | null {
  if (height > 2500 * FEET) return null
  const { spec } = sim
  const { controls } = pilot
  const knots = sim.indicatedAirspeed / KNOT
  // The autothrottle slows down by itself on the approach, so only a hand on the throttle
  // needs telling
  const slow = (limit: number, what: string): Advice =>
    pilot.autothrottle.on
      ? {
          text: `The autothrottle is slowing below ${limit} knots for the ${what}.`,
          tone: 'status'
        }
      : { text: `Slow below ${limit} knots for the ${what}: hold [S].`, tone: 'fix' }
  if (spec.retractableGear && !controls.gearDown) {
    if (spec.gearSpeed === null || knots < spec.gearSpeed - 5) {
      return { text: 'Lower the gear: press [G].', tone: 'fix' }
    }
    return slow(spec.gearSpeed, 'gear')
  }
  const notches = spec.autoFlaps ? 0 : spec.flapLabels.length - 1
  if (controls.flapNotch >= notches) return null
  // The limit for the next flap setting
  const limit = spec.flapSpeeds[controls.flapNotch]
  const what = spec.flapName === 'Nose' ? 'Lower the nose further' : 'More flaps'
  if (knots < limit - 5) return { text: `${what}: press [F].`, tone: 'fix' }
  return slow(limit, spec.flapName === 'Nose' ? 'nose' : 'flaps')
}

/**
 * With an engine out, the good engines swing the nose toward the dead one and the aircraft
 * flies sideways. Rudder toward the good side centres the slip ball.
 */
function rudder(sim: FlightSim): Advice | null {
  const running = sim.engines.filter(engine => engine.running && !engine.failed).length
  if (running === 0 || running === sim.engines.length) return null
  if (Math.abs(sim.slip) < 1.5 * DEGREES) return null
  const key = sim.slip > 0 ? 'D' : 'A'
  return {
    text: `Engine out, flying sideways: hold [${key}] for rudder until the slip ball centres.`,
    tone: Math.abs(sim.slip) > 3 * DEGREES ? 'warn' : 'fix'
  }
}

/** The last few feet: power off, nose up to slow the descent, no drift toward the edge. */
function flare(
  sim: FlightSim,
  nav: Navigator,
  pilot: Pilot,
  approach: Approach,
  height: number
): Advice {
  const feet = height / FEET
  const sink = -sim.verticalSpeed / FPM
  const tips: Advice[] = []
  // The descent rate that leaves time to touch down softly from this height
  const gentle = 120 + feet * 12
  // Body pitch rate, nose up positive: a nose already rising fast needs no more pull
  const rising = sim.angularVelocity.x > 1.5 * DEGREES
  if (rising && sink < gentle + 200) {
    tips.push({ text: 'The nose is coming up: let go of [↓] for a moment.', tone: 'fix' })
  } else if (!sim.spec.flyByWire && sim.angularVelocity.x < 1.5 * DEGREES && sink > gentle + 250) {
    // A full pull overshoots on a big airliner, so only lighter aircraft get it
    tips.push({ text: 'Flare: hold [↓] to raise the nose.', tone: 'warn' })
  } else if (sink < 60 && feet > 4) {
    tips.push({ text: 'Floating: let go of [↓] and let it settle.', tone: 'fix' })
  } else {
    // Shift limits the stick to a small pull, which holds the nose up steadily
    tips.push({ text: 'Flare: hold [Shift] and [↓] to keep the nose up gently.', tone: 'good' })
  }
  if (pilot.controls.throttle > 0.05 && !pilot.autothrottle.on) {
    tips.push({ text: 'Close the throttle: hold [S].', tone: 'fix' })
  }
  const side = flareSteer(sim, nav, approach)
  if (side) tips.push(side)
  const yaw = rudder(sim)
  if (yaw) tips.unshift(yaw)
  return combine(tips)
}

/**
 * Sideways drift in the flare. A little bank stops the drift toward the edge of the runway;
 * otherwise the wings come level for the touchdown.
 */
function flareSteer(sim: FlightSim, nav: Navigator, approach: Approach): Advice | null {
  const course = approach.end.heading * DEGREES
  const track = Math.atan2(sim.velocity.x, -sim.velocity.z)
  // Metres per second to the right of the runway line, and the drift that brings it back
  const drift = sim.groundSpeed * Math.sin(turnTo(course, track))
  const wanted = clamp(-nav.guidance.across * 0.3, -2, 2)
  const bankWanted = clamp((wanted - drift) * 2 * DEGREES, -FLARE_BANK, FLARE_BANK)
  const error = bankWanted - sim.bank
  if (Math.abs(error) < 2.5 * DEGREES) return null
  const key = error > 0 ? '→' : '←'
  const press = Math.abs(error) > 6 * DEGREES ? 'hold' : 'tap'
  if (Math.abs(bankWanted) < 1 * DEGREES) {
    return { text: `Level the wings: ${press} [${key}].`, tone: 'fix' }
  }
  const why = error > 0 ? 'Drifting left of the line' : 'Drifting right of the line'
  return { text: `${why}: ${press} [${key}].`, tone: 'fix' }
}

/** Turns back toward the centreline, more gently near the ground so the wheels touch down straight. */
function steer(sim: FlightSim, nav: Navigator, approach: Approach, height: number) {
  const course = approach.end.heading * DEGREES
  const track = Math.atan2(sim.velocity.x, -sim.velocity.z)
  const trackOff = turnTo(course, track)
  const reach = MAX_CORRECTION * clamp(height / SHORT_FINAL, 0.3, 1)
  const offset = Math.max(9, sim.groundSpeed * FULL_TURN_SECONDS[sim.spec.engine.type])
  const wanted = clamp(-nav.guidance.across / offset, -1, 1) * reach
  const bankWanted = clamp(turnTo(trackOff, wanted) * BANK_GAIN, -CORRECTION_BANK, CORRECTION_BANK)
  const bankError = bankWanted - sim.bank
  // A big change needs the key held, a small one a tap
  const press = Math.abs(bankError) > 12 * DEGREES ? 'hold' : 'tap'
  if (Math.abs(sim.bank) > 25 * DEGREES) {
    const key = sim.bank > 0 ? '←' : '→'
    return { text: `Bank is too steep: hold [${key}] to level the wings.`, tone: 'warn' } as const
  }
  if (bankError > BANK_SLACK) {
    const why = bankWanted > 2 * DEGREES ? 'Turn right toward the runway line' : 'Roll level'
    return { text: `${why}: ${press} [→].`, tone: 'fix' } as const
  }
  if (bankError < -BANK_SLACK) {
    const why = bankWanted < -2 * DEGREES ? 'Turn left toward the runway line' : 'Roll level'
    return { text: `${why}: ${press} [←].`, tone: 'fix' } as const
  }
  return null
}

/**
 * Glide path and speed. An aircraft without fly-by-wire holds its trimmed speed, so the
 * throttle sets the descent: the coach asks for the power of a steeper or shallower descent
 * back to the glide path. Fly-by-wire holds the flight path instead, so the stick sets the
 * descent and the throttle the speed.
 */
function descend(
  sim: FlightSim,
  nav: Navigator,
  pilot: Pilot,
  approach: Approach,
  height: number
): Advice | null {
  const { spec } = sim
  const knots = sim.indicatedAirspeed / KNOT
  const sink = -sim.verticalSpeed / FPM
  const above = sim.position.y - nav.guidance.pathAltitude
  const window = Math.max(8, PATH_SHARE * height)
  // How much faster the aircraft sinks than the glide path needs, so a correction already
  // under way is left to finish
  const extraSink = sink - (sim.groundSpeed * Math.tan(approach.glide)) / FPM
  const high = above > window && extraSink < 150 && height > SHORT_FINAL
  const low = above < -window && extraSink > -150
  const where = high ? 'Above the glide path' : low ? 'Below the glide path' : 'Power'
  // Below 50 ft the throttle comes back for the flare, so speed and power no longer matter
  if (height < 50 * FEET) return null
  if (knots < spec.approachSpeed - 8) {
    return { text: 'Too slow: tap [↑] to lower the nose, and hold [W].', tone: 'warn' }
  }
  if (spec.flyByWire) {
    if (extraSink > 200) {
      const tone = extraSink > 400 ? 'warn' : 'fix'
      return { text: 'Sinking too fast: tap [↓] to raise the nose a little.', tone }
    }
    if (high) return { text: `${where}: tap [↑] to descend a little faster.`, tone: 'fix' }
    if (low) return { text: `${where}: tap [↓] to descend a little slower.`, tone: 'fix' }
    if (pilot.autothrottle.on) return null
    // Power for this descent at the approach speed, plus more when slow and less when fast
    const speedError = clamp((spec.approachSpeed - knots) / 6, -1, 1)
    const target = clamp(sim.throttleFor(approach.glide) + speedError * 0.15, 0, 1)
    const what = speedError > 0.5 ? 'Slow' : speedError < -0.5 ? 'Fast' : 'Power'
    return power(target, pilot.controls.throttle, what)
  }
  // A dive that gains speed, or a climb that loses it, is the nose swinging: pitch damps it
  const reference = spec.approachSpeed + 5
  if (knots > reference + 4 && extraSink > 200) {
    return { text: 'Diving: tap [↓] to raise the nose a little.', tone: 'fix' }
  }
  if (knots < reference - 4 && extraSink < -200) {
    return { text: 'Climbing and slowing: tap [↑] to lower the nose a little.', tone: 'fix' }
  }
  // A steady speed error means the trim holds the wrong speed. Close to the ground a trim
  // change would upset the descent, so the coach leaves it alone there.
  const settled = Math.abs(extraSink) < 200 && height > 500 * FEET
  if (settled && Math.abs(knots - spec.approachSpeed) > 8) {
    const fast = knots > spec.approachSpeed
    const text = fast
      ? 'Fast: tap [E] to trim the nose up.'
      : 'Slow: tap [Q] to trim the nose down.'
    return { text, tone: 'fix' }
  }
  if (pilot.autothrottle.on) return null
  // Steeper when high, shallower when low, and shallower again while sinking too fast.
  // On short final the power stays put unless the aircraft sinks faster than the path.
  const path = height < SHORT_FINAL ? 0 : above / (2 * window)
  const correction = clamp(path - extraSink / 800, -1, 1)
  const glide = approach.glide + correction * PATH_CORRECTION
  const why = extraSink > 400 ? 'Sinking fast' : where
  return power(sim.throttleFor(glide), pilot.controls.throttle, why)
}

/** Asks for a throttle setting when the lever is well away from it. */
function power(target: number, throttle: number, why: string): Advice | null {
  const percent = `${Math.round(target * 20) * 5}%`
  const press = Math.abs(target - throttle) > 0.25 ? 'hold' : 'tap'
  if (target > throttle + POWER_SLACK) {
    return { text: `${why}: ${press} [W] for about ${percent} power.`, tone: 'fix' }
  }
  if (target < throttle - POWER_SLACK) {
    return { text: `${why}: ${press} [S] for about ${percent} power.`, tone: 'fix' }
  }
  return null
}

/** On the runway: wings level, straight down the centreline, then brakes once slow. */
function rollout(sim: FlightSim, nav: Navigator, pilot: Pilot, approach: Approach): Advice {
  const { spec } = sim
  const knots = sim.indicatedAirspeed / KNOT
  const tips: Advice[] = []
  if (pilot.controls.throttle > 0.05) {
    tips.push({ text: 'Close the throttle: hold [S].', tone: 'warn' })
  } else if (sim.pitch > 1 * DEGREES && knots > spec.approachSpeed * 0.5) {
    // Letting go drops the nose wheel hard, so a small pull lowers it gently
    tips.push({
      text: 'Wheels down. Hold [Shift] and [↓] while the nose comes down.',
      tone: 'good'
    })
  } else if (knots > spec.approachSpeed * 0.7) {
    // Full brakes at touchdown speed can tip the aircraft onto its nose
    tips.push({
      text: 'Wheels down. Keep straight and let it slow before you brake.',
      tone: 'good'
    })
  } else if (spec.engine.type === 'piston') {
    tips.push({ text: 'Hold [Space] to brake and hold [↓] to keep the nose up.', tone: 'good' })
  } else tips.push({ text: 'Hold [Space] to brake.', tone: 'good' })
  // A crosswind lifts the upwind wing, so the stick goes into the wind
  if (Math.abs(sim.bank) > 3 * DEGREES) {
    tips.push({ text: `Keep the wings level: hold [${sim.bank > 0 ? '←' : '→'}].`, tone: 'warn' })
  }
  const course = approach.end.heading * DEGREES
  const wanted = course + clamp(-nav.guidance.across / 15, -1, 1) * 5 * DEGREES
  const error = turnTo(sim.heading, wanted)
  const press = Math.abs(error) > 6 * DEGREES ? 'hold' : 'tap'
  if (error > 2 * DEGREES) tips.push({ text: `Steer right: ${press} [D].`, tone: 'fix' })
  else if (error < -2 * DEGREES) tips.push({ text: `Steer left: ${press} [A].`, tone: 'fix' })
  return combine(tips)
}

const URGENCY: Record<Advice['tone'], number> = { warn: 0, fix: 1, good: 2, status: 3 }

/**
 * Joins the two most urgent tips into one line, keeping their order otherwise. A status line
 * joins only when there is nothing to do.
 */
function combine(tips: Advice[]): Advice {
  const [first, second] = [...tips].sort((a, b) => URGENCY[a.tone] - URGENCY[b.tone])
  const join = second && (second.tone !== 'status' || first.tone === 'status')
  return { text: join ? `${first.text} ${second.text}` : first.text, tone: first.tone }
}
