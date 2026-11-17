import type { AircraftSpec } from '../../sim/aircraft'
import { CessnaCockpit } from '../cessna'
import { Cockpit, type CockpitView } from '../cockpit'
import type { Buzz } from '../controls'

/** Builds a cockpit for an aircraft. */
export type CockpitBuilder = new (spec: AircraftSpec, buzz: Buzz) => CockpitView

/**
 * Each aircraft's own cockpit, by its id. Every file in this folder exports `COCKPITS`, a
 * map from aircraft id to its cockpit, and is picked up here. Aircraft not listed get the
 * generic cockpit.
 */
const modules = import.meta.glob<{ COCKPITS: Record<string, CockpitBuilder> }>('./*.ts', {
  eager: true
})
const COCKPITS: Record<string, CockpitBuilder> = { c172: CessnaCockpit }
for (const module of Object.values(modules)) Object.assign(COCKPITS, module.COCKPITS ?? {})

/** Builds the cockpit for an aircraft. */
export function cockpitFor(spec: AircraftSpec, buzz: Buzz): CockpitView {
  const Build = COCKPITS[spec.id] ?? Cockpit
  return new Build(spec, buzz)
}
