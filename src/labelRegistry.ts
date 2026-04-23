// Unified label registry. Each label type (star, cluster, nebula, etc.)
// registers a handler. The registry coordinates cross-type concerns:
// visibility toggling, selection clearing, click dispatch, detail panel.

import { clearStarSystemSelection } from "./interaction.ts";

export interface LabelTypeHandler {
  readonly type: string;
  setVisible(visible: boolean): void;
  update(): void;
  selectByName(name: string): boolean;
  clearSelection(): void;
  handleClick(div: HTMLElement): boolean;
  detailHtml(): string | null;
}

// Screen-space circular region that hides labels behind it (e.g. a black-hole
// shadow or a selected star's disc). Sources can come from label handlers or
// from any module that cares — register via registerScreenOccluder().
export type Occluder = { cx: number; cy: number; radius: number };
const occluders: Array<() => Occluder | null> = [];
const frameOccluders: Occluder[] = [];
export function registerScreenOccluder(fn: () => Occluder | null): void {
  occluders.push(fn);
}
// Per-frame occluders published by the active label pass (e.g. every
// rendered star's disc). Cleared each time updateLabels starts a dirty
// pass so stale occluders don't linger between frames.
export function clearFrameOccluders(): void { frameOccluders.length = 0; }
export function pushFrameOccluder(o: Occluder): void { frameOccluders.push(o); }
export function collectScreenOccluders(): Occluder[] {
  const out: Occluder[] = [];
  for (const fn of occluders) {
    const o = fn();
    if (o) out.push(o);
  }
  for (const o of frameOccluders) out.push(o);
  return out;
}

const handlers: LabelTypeHandler[] = [];

export function registerLabelType(handler: LabelTypeHandler): void {
  handlers.push(handler);
}

// main.ts subscribes updateDetailPanel here so any new label type wired
// through selectByType / clearAllSelections gets info-panel updates for
// free, instead of having to remember at each call site.
const selectionChangeListeners: Array<() => void> = [];
export function onSelectionChanged(fn: () => void): void {
  selectionChangeListeners.push(fn);
}
function notifySelectionChanged(): void {
  for (const fn of selectionChangeListeners) fn();
}

export function setAllLabelsVisible(visible: boolean): void {
  for (const h of handlers) h.setVisible(visible);
}

export function updateAllLabels(): void {
  for (const h of handlers) h.update();
}

export function clearAllSelections(except?: string): void {
  clearStarSystemSelection();
  for (const h of handlers) {
    if (h.type !== except) h.clearSelection();
  }
  // selectByType also calls us then selects — it fires the notifier
  // itself on success to avoid a double-fire here. Pure-clear callers
  // (e.g. empty-space click) rely on this fire for panel refresh.
  if (except === undefined) notifySelectionChanged();
}

export function selectByType(type: string, name: string): boolean {
  const handler = handlers.find((h) => h.type === type);
  if (!handler) return false;
  clearAllSelections(type);
  const ok = handler.selectByName(name);
  if (ok) notifySelectionChanged();
  return ok;
}

export function getActiveDetailHtml(): string | null {
  for (const h of handlers) {
    const html = h.detailHtml();
    if (html) return html;
  }
  return null;
}
