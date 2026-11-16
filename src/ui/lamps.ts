import type { Controls, FlightSim } from '../sim/flight-sim'

/** A warning lamp, red for a warning or amber for a notice, lit while `on` holds. */
export type Lamp = {
  label: string
  kind: 'warning' | 'notice'
  on: (sim: FlightSim, controls: Controls) => boolean
}

/** Every lamp on the panel. NO POWER lights from the power state alone. */
export const LAMPS: Lamp[] = [
  { label: 'STALL', kind: 'warning', on: sim => sim.stallWarning },
  { label: 'ENGINE FIRE', kind: 'warning', on: sim => sim.engines.some(engine => engine.fire) },
  {
    // Low, slow, throttled back, and the wheels are still up
    label: 'GEAR UP',
    kind: 'warning',
    on: (sim, controls) =>
      sim.gearPosition < 1 && !sim.onGround && sim.altitudeAgl < 150 && controls.throttle < 0.4
  },
  {
    label: 'OVERSPEED',
    kind: 'warning',
    on: sim => sim.indicatedAirspeed > sim.speedLimit
  },
  { label: 'FLAP SPEED', kind: 'warning', on: sim => sim.flapOverspeed },
  { label: 'GEAR SPEED', kind: 'warning', on: sim => sim.gearOverspeed },
  { label: 'DAMAGE', kind: 'warning', on: sim => sim.flapsJammed || sim.gearJammed },
  { label: 'NO POWER', kind: 'notice', on: () => false },
  { label: 'PUMPS OFF', kind: 'notice', on: (_, controls) => !controls.fuelPumps },
  { label: 'ENGINE OFF', kind: 'notice', on: sim => sim.enginesRunning < sim.spec.engineCount },
  { label: 'LOW FUEL', kind: 'notice', on: sim => sim.fuel < sim.spec.fuelCapacity * 0.15 },
  { label: 'FUEL DUMP', kind: 'notice', on: sim => sim.dumping },
  {
    label: 'BRAKE',
    kind: 'notice',
    on: (_, c) => c.parkingBrake || c.brake > 0 || c.brakeLeft > 0 || c.brakeRight > 0
  },
  { label: 'AIRBRAKE', kind: 'notice', on: sim => sim.speedBrakePosition > 0.05 },
  { label: 'REVERSE', kind: 'notice', on: sim => sim.reversePosition > 0.05 },
  { label: 'AFTERBURNER', kind: 'notice', on: sim => sim.afterburner }
]
