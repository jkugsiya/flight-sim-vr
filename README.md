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
8. If the seat feels off, sit up, look forward, and tap **Recenter Seat** on the tablet.

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

## The Other Cockpits

Every other aircraft gets the same layout, with the flight control its real pilot uses:

- **Yoke:** Cessna 172, Boeing 737 and 787, and Concorde.
- **Left sidestick:** Airbus A320 and A380.
- **Right sidestick:** F-16 and F-35.
- **Centre stick:** P-51 Mustang, B-2, and the Space Shuttle.

The throttle, flap, and speed brake levers stand on the console on the opposite side from the stick. The red brake handle sits on the left console. The gear lever sits on the panel, right of the buttons.

The panel has two screens. The left one shows attitude, speed, altitude, climb rate, heading, and autopilot modes. The right one shows warning lamps, engines, levers, gear, fuel, the approach, and weapons. A red master warning light flashes on the glareshield for any warning.

The tablet on the left wall replaces the page's menus. Use it to set up a free flight, pick a mission, pause, read the landing coach, and see your result.

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
