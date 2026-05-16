// Unified label registry. Each label type (star, cluster, nebula, etc.)
// registers a handler. The registry coordinates cross-type concerns:
// visibility toggling, selection clearing, click dispatch, detail panel.

import { clearStarSystemSelection } from "./interaction.ts";
import { registerSearchKindKeywords } from "./searchFilter.ts";

export interface LabelTypeHandler {
  readonly type: string;
  // Search-entry kind code (e.g. "b", "ns", "n") — the `k` field on
  // SearchEntry. If set, registerLabelType auto-wires search keywords.
  readonly searchKind?: string;
  readonly searchKeywords?: string[];
  readonly searchLabel?: string;
  // Overlay selections coexist with the star/system focus. Selecting an
  // overlay handler clears other handlers but keeps the camera target
  // and star selection intact. Used for constellations.
  readonly overlay?: boolean;
  setVisible(visible: boolean): void;
  update(): void;
  selectByName(name: string): boolean;
  clearSelection(): void;
  getSelectedName(): string | null;
  setHoverByName(name: string | null): void;
  handleClick(div: HTMLElement): boolean;
  detailHtml(): string | null;
}

// Screen-space circular region that hides labels behind it (e.g. a black-hole
// shadow or a selected star's disc). Sources can come from label handlers or
// from any module that cares — register via registerScreenOccluder().
export type Occluder = { cx: number; cy: number; radius: number };
const occluders: Array<() => Occluder | null> = [];
const frameOccluders: Occluder[] = [];
// Star-disc occluders survive between the dirty labels passes that
// produce them, so idle-frame consumers (e.g. the hit-target overlay)
// keep seeing them.
const starOccluders: Occluder[] = [];
export function registerScreenOccluder(fn: () => Occluder | null): void {
  occluders.push(fn);
}
export function clearFrameOccluders(): void { frameOccluders.length = 0; }
export function pushFrameOccluder(o: Occluder): void { frameOccluders.push(o); }
export function clearStarOccluders(): void { starOccluders.length = 0; }
export function pushStarOccluder(o: Occluder): void { starOccluders.push(o); }
export function collectScreenOccluders(): Occluder[] {
  const out: Occluder[] = [];
  for (const fn of occluders) {
    const o = fn();
    if (o) out.push(o);
  }
  for (const o of frameOccluders) out.push(o);
  for (const o of starOccluders) out.push(o);
  return out;
}

const handlers: LabelTypeHandler[] = [];
const kindToType = new Map<string, string>();

export function registerLabelType(handler: LabelTypeHandler): void {
  handlers.push(handler);
  if (handler.searchKind && handler.searchKeywords) {
    registerSearchKindKeywords(handler.searchKind, handler.searchKeywords, handler.searchLabel);
    kindToType.set(handler.searchKind, handler.type);
  }
}

// Register an additional search kind that dispatches to an existing
// handler type, with its own keywords and display label. Used when a
// single handler manages logically distinct families that should show
// different sublabels in search (e.g. planets and moons both go to the
// "planet" handler, but moons should sublabel as "Moon").
export function registerSearchKindAlias(
  kind: string, type: string, keywords: string[], label: string,
): void {
  registerSearchKindKeywords(kind, keywords, label);
  kindToType.set(kind, type);
}

// Map a search-entry kind code ("b", "ns", "n") to a handler type name.
export function handlerTypeForSearchKind(kind: string): string | undefined {
  return kindToType.get(kind);
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
  if (handler.overlay) {
    // Clear other handler selections but keep star/system focus.
    for (const h of handlers) {
      if (h !== handler) h.clearSelection();
    }
  } else {
    clearAllSelections(type);
  }
  const ok = handler.selectByName(name);
  if (ok) notifySelectionChanged();
  return ok;
}

export function getActiveDetailHtml(): string | null {
  // Overlay handlers take priority (e.g. constellation info shown
  // on top of a star selection).
  for (const h of handlers) {
    if (h.overlay) { const html = h.detailHtml(); if (html) return html; }
  }
  for (const h of handlers) {
    if (!h.overlay) { const html = h.detailHtml(); if (html) return html; }
  }
  return null;
}

// Clear hover on every handler except the given type. Ensures that
// entering one label type's hover automatically exits the previous.
export function clearHoverExcept(exceptType: string | null): void {
  for (const h of handlers) {
    if (h.type !== exceptType) h.setHoverByName(null);
  }
}

// Return the name of whichever handler has an active selection, or null.
// `overlayOnly` restricts the scan to overlay handlers (exoplanet,
// constellation) — those layer over the star/system focus, so their
// selection is the topmost UI state.
export function getHandlerSelectedName(overlayOnly = false): string | null {
  for (const h of handlers) {
    if (overlayOnly && !h.overlay) continue;
    const name = h.getSelectedName();
    if (name) return name;
  }
  return null;
}

// Look up a handler by type.
export function getHandlerByType(type: string): LabelTypeHandler | undefined {
  return handlers.find((h) => h.type === type);
}
