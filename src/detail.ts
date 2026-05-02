import type { Star } from "./types.ts";
import { getSelectedMesh, getSelectedSystem, setLabelsDirty } from "./systemStore.ts";
import { systemDetailHtml } from "./systemDispatch.ts";
import { getActiveDetailHtml } from "./labelRegistry.ts";
import { isFavorite, toggleFavorite } from "./favorites.ts";
import { registerPanel, setOpenPanel, closePanel } from "./panelManager.ts";

const detail = document.getElementById("detail")!;
const detailBtn = document.getElementById("detail-btn")!;

let starClickCallback: ((name: string) => void) | null = null;
export function onDetailStarClick(cb: (name: string) => void): void {
  starClickCallback = cb;
}

registerPanel("detail", () => detail.classList.remove("open"));

detailBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (detail.classList.contains("open")) closePanel("detail");
  else { detail.classList.add("open"); setOpenPanel("detail"); }
});

detail.addEventListener("click", (e) => {
  const bmBtn = (e.target as HTMLElement).closest(".favorite-toggle");
  if (bmBtn) {
    e.stopPropagation();
    const name = bmBtn.getAttribute("data-name");
    if (name) {
      toggleFavorite(name);
      setLabelsDirty(true);
      updateDetailPanel();
    }
    return;
  }
  const starLink = (e.target as HTMLElement).closest("[data-star]");
  if (starLink) {
    e.stopPropagation();
    const name = starLink.getAttribute("data-star");
    if (name && starClickCallback) starClickCallback(name);
    return;
  }
});

import { LY_PER_PARSEC } from "./constants.ts";

export function formatDist(pc: number): string {
  return `${(pc * LY_PER_PARSEC).toFixed(1)} ly (${pc.toFixed(2)} pc)`;
}

function renderWikiLink(url: string | undefined): string {
  return url ? `<div class="star-wiki"><a href="${url}" target="_blank">Wikipedia</a></div>` : "";
}

function renderNotes(text: string | undefined): string {
  return text ? `<div class="star-notes">${text}</div>` : "";
}

export function favoriteIcon(name: string): string {
  const icon = isFavorite(name) ? "★" : "☆";
  return `<span class="favorite-toggle" data-name="${name.replace(/"/g, "&quot;")}">${icon}</span>`;
}

// Memoize the rendered html so a re-fired selection event (or a
// favorite toggle inside the panel) doesn't re-write innerHTML and
// trash the user's text selection.
let lastHtml: string | null = null;

function showDetail(html: string) {
  if (lastHtml !== html) {
    lastHtml = html;
    detail.innerHTML = html;
  }
  detailBtn.classList.add("visible");
  if (!detail.classList.contains("open")) {
    detail.classList.add("open");
    setOpenPanel("detail");
  }
}

function hideDetail() {
  lastHtml = null;
  detailBtn.classList.remove("visible");
  closePanel("detail");
}

export function updateDetailPanel() {
  const registryHtml = getActiveDetailHtml();
  if (registryHtml) { showDetail(registryHtml); return; }

  const selectedSystem = getSelectedSystem();
  if (selectedSystem) { showDetail(systemDetailHtml(selectedSystem)); return; }

  const selectedMesh = getSelectedMesh();
  if (!selectedMesh) { hideDetail(); return; }

  const star = selectedMesh.userData as Star;
  const aliasLine = star.aliases?.length
    ? `<div class="star-aliases">${star.aliases.join(" · ")}</div>`
    : "";

  showDetail(`
    ${favoriteIcon(star.name)}
    <div class="star-name">${star.name}</div>
    ${aliasLine}
    <div class="detail-body">
      <div class="star-detail">
        From Sol: ${formatDist(star.dist)}<br>
        Magnitude: ${star.mag.toFixed(1)} (abs: ${star.absmag.toFixed(1)})<br>
        Spectral: ${star.spect || "\u2014"}<br>
        Luminosity: ${star.lum.toFixed(3)} L\u2609
      </div>
      ${renderNotes(star.notes)}
      ${renderWikiLink(star.wikipedia)}
    </div>
  `);
}
