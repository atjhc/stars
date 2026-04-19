import { COLLISION_PAD_PX, COLLISION_ALPHA_CUTOFF } from "./constants.ts";
import { collectScreenOccluders, type Occluder } from "./labelRegistry.ts";

function rectInside(rect: DOMRect, occ: Occluder): boolean {
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const dx = cx - occ.cx;
  const dy = cy - occ.cy;
  return dx * dx + dy * dy < occ.radius * occ.radius;
}

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

// Drop every reference to a label's collision state. Called from the
// tile streamer when a tier-1 label's div is torn down — otherwise the
// tracking Maps/Sets leak HTMLElement references across long sessions.
export function untrackLabel(div: HTMLElement): void {
  const anim = activeAnim.get(div);
  if (anim) { anim.cancel(); activeAnim.delete(div); }
  collisionHidden.delete(div);
  lastOpacity.delete(div);
  visibleLabels.delete(div);
}

// Cancel in-flight fades and fully clear the collision tracking state for
// every label we've touched. Called when the whole label layer is being
// hidden so the next resolveCollisions pass treats labels as fresh —
// otherwise labels that were collision-hidden stay hidden, and labels
// that were visible replay a fade-out from the stale pre-hide opacity.
export function resetCollisionFadeState(): void {
  for (const [div] of lastOpacity) {
    const anim = activeAnim.get(div);
    if (anim) { anim.cancel(); activeAnim.delete(div); }
    div.style.visibility = "";
  }
  lastOpacity.clear();
  collisionHidden.clear();
}

// Labels currently rendered on screen (populated by labels.ts each dirty frame)
export const visibleLabels = new Set<HTMLElement>();

export function isLabelInteractive(div: HTMLElement): boolean {
  return visibleLabels.has(div) && !collisionHidden.has(div);
}

export function isCollisionHidden(div: HTMLElement): boolean {
  return collisionHidden.has(div);
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
  anim.onfinish = () => {
    div.style.opacity = String(to);
    activeAnim.delete(div);
  };
}

function hideLabel(div: HTMLElement) {
  const prev = lastOpacity.get(div) ?? 0;
  setLabelOpacity(div, prev, 0);
  lastOpacity.set(div, 0);
  if (prev > 0) {
    setTimeout(() => { if (collisionHidden.has(div)) div.style.visibility = "hidden"; }, FADE_MS);
  } else {
    div.style.visibility = "hidden";
  }
  collisionHidden.add(div);
}

function showLabel(div: HTMLElement, opacity: number) {
  const wasHidden = collisionHidden.has(div);
  div.style.visibility = "";
  if (wasHidden) {
    // Transitioning from hidden: animate the fade-in
    const prev = lastOpacity.get(div) ?? 0;
    setLabelOpacity(div, prev, opacity);
  } else {
    // Already visible: set opacity directly (no animation for camera-driven changes)
    const prev = activeAnim.get(div);
    if (prev) { prev.cancel(); activeAnim.delete(div); }
    div.style.opacity = String(opacity);
  }
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
  // Don't clear collisionHidden — labels keep their hidden state between runs.
  // Each label in the current frame is re-evaluated below; labels no longer in
  // the frame stay in whatever state they were in (hidden labels remain hidden).

  // Screen-space occlusion circles (BH shadow, selected star's disc, …).
  // Sources register via labelRegistry.registerScreenOccluder.
  const occluders = collectScreenOccluders();

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
    if (rect.width === 0 || rect.height === 0) {
      // Not yet positioned by CSS2DRenderer — hide until next frame
      hideLabel(div);
      continue;
    }

    // Hide labels behind any registered occluder (BH shadow, star disc, …)
    let occluded = false;
    for (const occ of occluders) {
      if (rectInside(rect, occ)) { occluded = true; break; }
    }
    if (occluded) { hideLabel(div); continue; }

    if (overlapsPlaced(rect)) {
      hideLabel(div);
    } else {
      showLabel(div, label.opacity);
      insertPlaced(rect);
    }
  }
}
