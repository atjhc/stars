import type { Star } from "./types.ts";
import { getSelectedMesh, getSelectedSystem, setLabelsDirty } from "./systemStore.ts";
import { systemDetailHtml } from "./systemDispatch.ts";
import { getActiveDetailHtml } from "./labelRegistry.ts";
import { isFavorite, toggleFavorite } from "./favorites.ts";
import { loadJSON, saveJSON } from "./storage.ts";

const detail = document.getElementById("detail")!;

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
  if ((e.target as HTMLElement).closest("a")) return;
  if (window.getSelection()?.toString()) return;
  detail.classList.toggle("collapsed");
  saveJSON("panels", { ...loadJSON<Record<string, boolean>>("panels", {}), detail: detail.classList.contains("collapsed") });
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

function applyDetailCollapsed() {
  const saved = loadJSON<Record<string, boolean>>("panels", {});
  if (saved.detail) detail.classList.add("collapsed");
  else detail.classList.remove("collapsed");
}

export function updateDetailPanel() {
  const registryHtml = getActiveDetailHtml();
  if (registryHtml) {
    detail.innerHTML = registryHtml;
    applyDetailCollapsed();
    detail.classList.add("active");
    return;
  }

  const selectedSystem = getSelectedSystem();
  if (selectedSystem) {
    detail.innerHTML = systemDetailHtml(selectedSystem);
    applyDetailCollapsed();
    detail.classList.add("active");
    return;
  }

  const selectedMesh = getSelectedMesh();
  if (!selectedMesh) {
    detail.classList.remove("active");
    return;
  }
  const star = selectedMesh.userData as Star;

  const aliasLine = star.aliases?.length
    ? `<div class="star-aliases">${star.aliases.join(" · ")}</div>`
    : "";

  detail.innerHTML = `
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
  `;
  applyDetailCollapsed();
  detail.classList.add("active");
}
