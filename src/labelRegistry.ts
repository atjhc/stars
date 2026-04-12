// Unified label registry. Each label type (star, cluster, nebula, etc.)
// registers a handler. The registry coordinates cross-type concerns:
// visibility toggling, selection clearing, click dispatch, detail panel.

import type { RankedLabel } from "./labelCollision.ts";

export interface LabelTypeHandler {
  readonly type: string;
  setVisible(visible: boolean): void;
  update(): void;
  selectByName(name: string): boolean;
  clearSelection(): void;
  handleClick(div: HTMLElement): boolean;
  detailHtml(): string | null;
  collectVisibleLabels?(): RankedLabel[];
}

const handlers: LabelTypeHandler[] = [];

export function registerLabelType(handler: LabelTypeHandler): void {
  handlers.push(handler);
}

export function setAllLabelsVisible(visible: boolean): void {
  for (const h of handlers) h.setVisible(visible);
}

export function updateAllLabels(): void {
  for (const h of handlers) h.update();
}

export function clearAllSelections(except?: string): void {
  for (const h of handlers) {
    if (h.type !== except) h.clearSelection();
  }
}

export function dispatchLabelClick(target: HTMLElement): boolean {
  const labelDiv = target.closest("[data-label-type]") as HTMLElement | null;
  if (!labelDiv) return false;
  const type = labelDiv.getAttribute("data-label-type")!;
  const handler = handlers.find((h) => h.type === type);
  if (!handler) return false;
  clearAllSelections(type);
  return handler.handleClick(labelDiv);
}

export function selectByType(type: string, name: string): boolean {
  const handler = handlers.find((h) => h.type === type);
  if (!handler) return false;
  return handler.selectByName(name);
}

export function collectAllRegisteredLabels(): RankedLabel[] {
  const result: RankedLabel[] = [];
  for (const h of handlers) {
    if (h.collectVisibleLabels) result.push(...h.collectVisibleLabels());
  }
  return result;
}

export function getActiveDetailHtml(): string | null {
  for (const h of handlers) {
    const html = h.detailHtml();
    if (html) return html;
  }
  return null;
}
