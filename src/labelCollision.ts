import { COLLISION_PAD_PX, COLLISION_ALPHA_CUTOFF } from "./constants.ts";

export type RankedLabel = {
  div: HTMLElement;
  rank: number;
  opacity: number;
  pinned?: boolean; // always visible, exempt from collision
};

const FADE_MS = 400;

const collisionHidden = new Set<HTMLElement>();
const lastOpacity = new Map<HTMLElement, number>();
const activeAnim = new WeakMap<HTMLElement, Animation>();

// Labels currently rendered on screen (populated by labels.ts each dirty frame)
export const visibleLabels = new Set<HTMLElement>();

export function isLabelInteractive(div: HTMLElement): boolean {
  return visibleLabels.has(div) && !collisionHidden.has(div);
}

function setLabelOpacity(div: HTMLElement, from: number, to: number) {
  // Cancel any running animation first
  const prev = activeAnim.get(div);
  if (prev) { prev.cancel(); activeAnim.delete(div); }

  if (Math.abs(from - to) < 0.01) {
    div.style.opacity = String(to);
    return;
  }

  const anim = div.animate(
    [{ opacity: from }, { opacity: to }],
    { duration: FADE_MS, easing: "ease-in-out" },
  );
  activeAnim.set(div, anim);
  // Commit final value to inline style when done, then release the Animation
  anim.onfinish = () => {
    div.style.opacity = String(to);
    activeAnim.delete(div);
  };
}

function hideLabel(div: HTMLElement) {
  const prev = lastOpacity.get(div) ?? 0;
  setLabelOpacity(div, prev, 0);
  lastOpacity.set(div, 0);
  // visibility:hidden after the fade completes to block pointer events
  if (prev > 0) {
    setTimeout(() => { if (collisionHidden.has(div)) div.style.visibility = "hidden"; }, FADE_MS);
  } else {
    div.style.visibility = "hidden";
  }
  collisionHidden.add(div);
}

function showLabel(div: HTMLElement, opacity: number) {
  const prev = lastOpacity.get(div) ?? opacity;
  div.style.visibility = "";
  setLabelOpacity(div, prev, opacity);
  lastOpacity.set(div, opacity);
  collisionHidden.delete(div);
}

// Spatial grid for fast overlap queries
const CELL_SIZE = 64;

function cellKey(cx: number, cy: number): number {
  return (cx & 0xffff) | ((cy & 0xffff) << 16);
}

export function resolveCollisions(labels: RankedLabel[]): void {
  labels.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.rank - a.rank;
  });
  collisionHidden.clear();

  // Restore visibility so getBoundingClientRect returns real sizes
  for (const label of labels) {
    label.div.style.visibility = "";
  }

  const grid = new Map<number, DOMRect[]>();

  function overlapsPlaced(r: DOMRect): boolean {
    const x0 = Math.floor((r.left - COLLISION_PAD_PX) / CELL_SIZE);
    const x1 = Math.floor((r.right + COLLISION_PAD_PX) / CELL_SIZE);
    const y0 = Math.floor((r.top - COLLISION_PAD_PX) / CELL_SIZE);
    const y1 = Math.floor((r.bottom + COLLISION_PAD_PX) / CELL_SIZE);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = grid.get(cellKey(cx, cy));
        if (!cell) continue;
        for (const p of cell) {
          if (r.left - COLLISION_PAD_PX < p.right + COLLISION_PAD_PX
            && r.right + COLLISION_PAD_PX > p.left - COLLISION_PAD_PX
            && r.top - COLLISION_PAD_PX < p.bottom + COLLISION_PAD_PX
            && r.bottom + COLLISION_PAD_PX > p.top - COLLISION_PAD_PX) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function insertPlaced(r: DOMRect) {
    const x0 = Math.floor(r.left / CELL_SIZE);
    const x1 = Math.floor(r.right / CELL_SIZE);
    const y0 = Math.floor(r.top / CELL_SIZE);
    const y1 = Math.floor(r.bottom / CELL_SIZE);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        let cell = grid.get(key);
        if (!cell) { cell = []; grid.set(key, cell); }
        cell.push(r);
      }
    }
  }

  for (const label of labels) {
    const div = label.div;

    if (label.pinned) {
      showLabel(div, label.opacity);
      const el = div.firstElementChild as HTMLElement | null;
      const rect = (el ?? div).getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) insertPlaced(rect);
      continue;
    }

    if (label.opacity < COLLISION_ALPHA_CUTOFF) {
      hideLabel(div);
      continue;
    }

    // Use first child (name line) for collision rect, ignoring subtitle
    const el = div.firstElementChild as HTMLElement | null;
    const rect = (el ?? div).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    if (overlapsPlaced(rect)) {
      hideLabel(div);
    } else {
      showLabel(div, label.opacity);
      insertPlaced(rect);
    }
  }
}
