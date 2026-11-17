# Island Flyer VR

Island Flyer, the browser flight sim, ported to VR for the Meta Quest 2. You sit in a life-size cockpit and fly with your bare hands, the Touch controllers, or both. The desktop game still works unchanged on a normal screen.

## Run It on Your Quest

The Quest Browser allows VR only over HTTPS, so the dev server needs a local certificate.

1. Install packages and make the certificate once:

   ```sh
   bun install
   bun run certs
   ```

2. Start the dev server. It prints a `Network` address such as `https://192.168.2.85:5173/`:

   ```sh
   bun run dev
   ```

3. Put the Quest on the same Wi-Fi as your Mac.
4. In the Quest Browser, open the `Network` address.
5. The certificate is self-signed, so the browser warns you. Select **Advanced**, then **Proceed**.
6. Pick an aircraft and a start on the page, or skip that and use the tablet in VR.
7. Select **Enter VR** in the bottom-right corner, sit in a chair, and look straight ahead.
8. If the seat feels off, tap **Recenter Seat** on the tablet, then sit up and look straight ahead during the countdown.

Run `bun run certs` again if your Mac's network address changes.

For bare-hand flying, turn on hand tracking first: **Settings**, then **Movement Tracking**, then **Hand Tracking**. Put the controllers down and the game switches to your hands.

## The Cessna 172 Cockpit

The Cessna has a full-size copy of the 172S cockpit, flown by its real procedures.

- **Panel:** the six steam gauges with moving needles, the engine cluster, the tachometer, a course needle with glideslope, and a magnetic compass on the windscreen frame.
- **Avionics:** the warning lights, GPS, radio, and KAP 140 autopilot, which go dark with the avionics master off.
- **Engine controls:** the key (OFF, R, L, BOTH, START), the red split master switch, the fuel pump, the push-pull throttle, and the red mixture knob.
- **Pedestal and floor:** the trim wheel, the red fuel shutoff valve, and the fuel selector.
- **Brakes:** pull the parking brake handle under the panel partway to brake, or all the way to lock it.

The engine starts the way the handbook says:

1. Set the master switch BAT on, and open the throttle about a quarter inch.
2. Set the mixture to idle cutoff.
3. Prime with the fuel pump and the mixture rich for 3 to 5 seconds, then go back to idle cutoff.
4. Turn the key to START.
5. When the engine fires, push the mixture to rich within about 3 seconds.

Over-priming floods the engine. Clear a flood by cranking with the throttle full and the mixture at idle cutoff.

The kneeboard on your left thigh carries the 172S checklists. Each item ticks itself off as you do it. The heading indicator starts unset on a cold start, so set it to the compass with its left knob.

The Cessna flies to its handbook numbers at full weight: stalls at 53 kt clean and 48 kt with full flaps, climbs 730 ft/min, cruises at 124 kt at 8,000 ft, glides 9 to 1, takes off in about 960 ft, and stops in about 575 ft.

## Every Aircraft's Own Cockpit

Every aircraft has a life-size cockpit modelled on the real one, with its own controls in their real places:

- **Airbus A320 and A380:** left sidestick, flight control unit on the glareshield, six displays, overhead panel, and a pedestal with notched thrust levers, speedbrake, flaps, and engine master switches.
- **Boeing 737 MAX and 787:** yokes, the mode control panel, big landscape displays, the 787's head-up display, overhead panels, and the pedestal with thrust levers, speedbrake, flaps, and start levers.
- **Concorde:** ram's-horn yokes, a dense analog panel with gauges for all four engines, the droop nose and visor lever, and four throttles with reheat.
- **F-16 and F-35:** right sidestick, left throttle with an afterburner notch, the F-16's head-up display and the F-35's wide panoramic display, master arm, and weapons release.
- **P-51 Mustang:** the WWII steam gauge panel, the K-14 gunsight, a central stick, and the throttle quadrant.
- **B-2:** two seats, nine colour displays, four throttles, and the bomb sight and release.
- **Space Shuttle:** the hand controller between your knees, the speedbrake handle, nine displays, the head-up display, and overhead switch panels.
- **UH-60 Black Hawk:** you sit right, as in the real aircraft. The cyclic is between your knees and the collective on your left, with four displays, the overhead engine levers, and chin windows to see the ground.

Throttle levers move with the autothrottle, and the stick or yoke moves when the autopilot flies, as in the real aircraft. A firm push on it takes over.

The tablet replaces the page's menus. Use it to set up a free flight, pick a mission, pause, read the landing coach and checklists, and see your result.

## Seat and Recenter

- **Recenter Seat** on the tablet counts down three seconds first. Sit up and look straight ahead before it reaches zero, since that sets which way is forward.
- **Up**, **Down**, **Closer**, and **Farther** on the tablet move the seat 2 cm per tap, up to 25 cm each way. The game remembers your setting.
- Holding the Quest's Meta button also recenters, at once.

## Preview the Cockpit Without a Headset

Press **C** on the page to cycle the views: chase, classic cockpit, and pilot seat. The pilot seat view shows exactly the VR cockpit:

- **Look:** drag over empty space.
- **Switches and buttons:** click them.
- **Levers, stick, and yoke:** click and drag.
- **Knobs and the key:** hold the click and scroll.

The keyboard still flies the aircraft.

## Flying With Your Hands

| Action | How |
| --- | --- |
| Grab | Pinch, or wrap your middle and ring fingers round the stick, yoke, or a lever. Your index finger can rest free |
| Turn a knob or the key | Pinch it and twist your wrist |
| Roll the trim wheel | Grab its rim and roll it: top forward is nose down |
| Fly | Grab the stick and tilt it, or grab the yoke and turn and push or pull it |
| Press a button | Poke it with your fingertip, or pinch it |
| Tap the tablet | Touch the screen with your fingertip |
| Steer on the ground | Move the stick or yoke left and right |
| Brake | Pull the red brake handle toward you; it springs back when you let go |
| Let go | Open your hand. The control freezes as your fingers open, so it stays where you left it |

A held control keeps its hold through about a second of lost tracking, so a hand hidden behind the yoke does not drop it. A small dead zone at centre hides hand tremor, and small moves give fine control.

The stick and yoke spring back to centre when you let go. A firm push or pull switches off the autopilot, as in a real cockpit. Grabbing the throttle switches off the autothrottle.

There are no rudder pedals. In the air, the yaw damper keeps your turns balanced. On the ground, the stick steers the nose wheel.

## Flying With Controllers

The controllers grab with the grip button, the same way your hands do. They also add these shortcuts:

| Control | Action |
| --- | --- |
| Right thumbstick | Fly without grabbing anything. While you hold the stick, it trims instead |
| Left thumbstick | Left and right work the rudder. Forward and back move the throttle |
| Left trigger | Wheel brakes, as hard as you pull |
| Right trigger | Fire a missile, or release a bomb with the bomb sight on |
| A / B | Gear / speed brake |
| X / Y | Flaps up / flaps down |
| Right thumbstick press | Autopilot on or off |
| Left thumbstick press | Pause or resume |

The controllers vibrate for the stall buffet, overspeed, the runway rumble, touchdown, the gear locking, engine starts, crashes, and lever detents. Bare hands get no vibration.

## Comfort and Performance

Your view rolls and pitches with the aircraft, as in a real cockpit. If that makes you queasy, start with gentle turns and the autopilot.

VR uses the Low graphics preset to hold the Quest's 72 frames per second. Your desktop graphics settings come back when you take the headset off.

## Development

```sh
bun run dev        # HTTPS dev server when certs/ exists, plain HTTP otherwise
bun test           # flight model, pilot, and mission tests
bun run typecheck
bun run check      # Biome lint and format
```

The VR code lives in `src/vr`. The `certs` folder is ignored by git.
