import { loadJSON, saveJSON } from "./storage.ts";

// Click-vs-drag toggle: tiny accidental drags over selectable text would
// otherwise create a selection that blocks a plain click handler.
export function makeCollapsible(el: HTMLElement, panelKey?: string, threshold = 4) {
  if (panelKey) {
    const saved = loadJSON<Record<string, boolean>>("panels", {});
    if (saved[panelKey] !== undefined) {
      el.classList.toggle("collapsed", saved[panelKey]);
    }
  }

  let downX = 0, downY = 0;
  el.addEventListener("mousedown", (e) => { downX = e.clientX; downY = e.clientY; });
  el.addEventListener("mouseup", (e) => {
    if (Math.abs(e.clientX - downX) < threshold && Math.abs(e.clientY - downY) < threshold) {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      el.classList.toggle("collapsed");
      if (panelKey) {
        saveJSON("panels", { ...loadJSON<Record<string, boolean>>("panels", {}), [panelKey]: el.classList.contains("collapsed") });
      }
    }
  });
}
