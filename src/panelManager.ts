// Single-panel coordination: at most one of detail/debug/layers/search
// can be open at a time. The registered close fn must NOT call back into
// the manager — `current` is already updated before the fn runs.

export type Panel = "detail" | "debug" | "layers" | "search";
type CloseFn = () => void;

const closeFns: Map<Panel, CloseFn> = new Map();
let current: Panel | null = null;

export function registerPanel(name: Panel, close: CloseFn): void {
  closeFns.set(name, close);
}

export function setOpenPanel(name: Panel): void {
  if (current === name) return;
  const prev = current;
  current = name;
  if (prev) closeFns.get(prev)?.();
}

export function closePanel(name: Panel): void {
  if (current !== name) return;
  current = null;
  closeFns.get(name)?.();
}
