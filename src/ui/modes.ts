import { game } from '../game/game'

/**
 * Flight mode names as a real flight display shows them: what the throttle, the roll,
 * and the pitch are doing. Each is empty while that part is flown by hand.
 */
export function flightModes() {
  const { autopilot, autothrottle } = game.pilot
  const sim = game.sim
  const ils = game.nav.approach?.kind === 'ILS'
  let thrust = ''
  if (autothrottle.on) {
    const changing = autopilot.on && autopilot.vertical === 'FLCH'
    thrust = changing ? (autopilot.altitude > sim.position.y ? 'THR CLB' : 'IDLE') : 'SPEED'
  }
  if (!autopilot.on) return { thrust, lateral: '', vertical: '' }
  const lateral = { HDG: 'HDG', NAV: 'LNAV', APP: ils ? 'LOC' : 'LNAV' }[autopilot.lateral]
  const vertical = {
    ALT: 'ALT',
    VS: 'V/S',
    FLCH: 'FLCH',
    VNAV: 'VNAV',
    APP: ils ? 'G/S' : 'VNAV'
  }[autopilot.vertical]
  return { thrust, lateral, vertical }
}
