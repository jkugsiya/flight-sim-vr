import { game } from '../game/game'
import { pulse } from './feel'
import type { Interactor, XRInput } from './input'

// Thumbstick travel ignored around centre, so a resting thumb does not fly the aircraft
const DEAD_ZONE = 0.15
// Throttle travel per second with the left thumbstick held fully forward or back
const THROTTLE_RATE = 0.5
// Trigger travel that counts as pulled
const TRIGGER_ON = 0.6

// Touch controller buttons in the standard WebXR layout
const TRIGGER = 0
const THUMBSTICK_PRESS = 3
const LOWER = 4 // A on the right, X on the left
const UPPER = 5 // B on the right, Y on the left
const STICK_X = 2
const STICK_Y = 3

/** A thumbstick axis past the dead zone, eased so small moves stay small. */
function axis(value: number) {
  const beyond = Math.max(0, Math.abs(value) - DEAD_ZONE) / (1 - DEAD_ZONE)
  return Math.sign(value) * beyond ** 1.6
}

/** Taps a keyboard key on the pilot, so a controller button does exactly what the key does. */
function key(code: string) {
  const { pilot, sim, nav } = game
  pilot.press(code, false, sim, nav)
  pilot.release(code)
}

/**
 * Touch controller buttons and thumbsticks, on top of grabbing with the grip. This layer
 * is separate from the hands: without controllers it does nothing, and everything here can
 * also be done by grabbing and pressing in the cockpit.
 */
export class Gamepads {
  private readonly down = new Set<string>()

  /**
   * `flightHeld` is true while a hand grabs the stick or yoke, and `throttleHeld` while one
   * grabs the throttle lever: then the thumbsticks trim instead of flying.
   */
  update(dt: number, input: XRInput, flightHeld: boolean, throttleHeld: boolean) {
    const { analog, controls } = game.pilot
    const { status } = game.getState()
    const right = input.controller('right')
    const left = input.controller('left')

    if (right?.gamepad) {
      const pad = right.gamepad
      const x = axis(pad.axes[STICK_X] ?? 0)
      const y = axis(pad.axes[STICK_Y] ?? 0)
      // Pulling the thumbstick back raises the nose, like a stick
      if (flightHeld) {
        if (y !== 0) analog.trim = y
      } else if (x !== 0 || y !== 0) analog.stick = { pitch: y, roll: x }
      const trigger = (pad.buttons[TRIGGER]?.value ?? 0) > TRIGGER_ON
      if (this.edge('right-trigger', trigger)) {
        if (game.release()) pulse(right, 0.6, 60)
      } else if (!trigger && this.was('right-trigger')) game.endRelease()
      this.remember('right-trigger', trigger)
      const flying = status === 'flying'
      this.button(right, 'right-a', LOWER, flying, () => key('KeyG'))
      this.button(right, 'right-b', UPPER, flying, () => key('KeyB'))
      this.button(right, 'right-stick', THUMBSTICK_PRESS, flying, () => key('KeyZ'))
    } else if (this.was('right-trigger')) {
      // The controller went out of sight with the trigger down: stop the string
      game.endRelease()
      this.remember('right-trigger', false)
    }

    if (left?.gamepad) {
      const pad = left.gamepad
      const x = axis(pad.axes[STICK_X] ?? 0)
      const y = axis(pad.axes[STICK_Y] ?? 0)
      if (x !== 0) analog.yaw = x
      // Forward on the thumbstick opens the throttle
      if (y !== 0 && !throttleHeld) {
        analog.throttle = Math.min(1, Math.max(0, controls.throttle - y * THROTTLE_RATE * dt))
      }
      analog.brake = Math.max(analog.brake, pad.buttons[TRIGGER]?.value ?? 0)
      const flying = status === 'flying'
      this.button(left, 'left-x', LOWER, flying, () => key('KeyV'))
      this.button(left, 'left-y', UPPER, flying, () => key('KeyF'))
      this.button(left, 'left-stick', THUMBSTICK_PRESS, true, () => {
        if (status === 'flying') game.pause()
        else game.resume()
      })
    }
  }

  /** Acts on the press of a button. Presses while `enabled` is false are tracked but ignored. */
  private button(it: Interactor, name: string, index: number, enabled: boolean, act: () => void) {
    const pressed = it.gamepad?.buttons[index]?.pressed ?? false
    if (enabled && this.edge(name, pressed)) {
      act()
      pulse(it, 0.3, 20)
    }
    this.remember(name, pressed)
  }

  /** True on the frame a button goes down. */
  private edge(name: string, pressed: boolean) {
    return pressed && !this.down.has(name)
  }
  private was(name: string) {
    return this.down.has(name)
  }
  private remember(name: string, pressed: boolean) {
    if (pressed) this.down.add(name)
    else this.down.delete(name)
  }
}
