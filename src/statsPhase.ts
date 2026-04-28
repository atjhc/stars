// Phase-timing shim. Lives in its own module (no imports) so files
// inside the debug → starfield → labelCanvas import chain can call
// statsPhase without re-introducing the cycle.
//
// debug.ts installs the real implementation via setStatsPhaseImpl()
// when its statsKit comes online; until then the call is a passthrough.

type PhaseFn = <T>(name: string, fn: () => T) => T;

let impl: PhaseFn = (_, fn) => fn();

export function setStatsPhaseImpl(fn: PhaseFn | null): void {
  impl = fn ?? ((_, f) => f());
}

export function statsPhase<T>(name: string, fn: () => T): T {
  return impl(name, fn);
}
