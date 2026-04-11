import type { Star } from "./types.ts";
import { getSelectedMesh, getSelectedSystem } from "./systemStore.ts";
import { systemDetailHtml } from "./systemDispatch.ts";
import { getActiveDetailHtml } from "./labelRegistry.ts";

const detail = document.getElementById("detail")!;

detail.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) return;
  if (window.getSelection()?.toString()) return;
  detail.classList.toggle("collapsed");
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

export function updateDetailPanel() {
  // Check registry-managed label types (nebulae, etc.) first
  const registryHtml = getActiveDetailHtml();
  if (registryHtml) {
    detail.innerHTML = registryHtml;
    detail.classList.remove("collapsed");
    detail.classList.add("active");
    return;
  }

  const selectedSystem = getSelectedSystem();
  if (selectedSystem) {
    detail.innerHTML = systemDetailHtml(selectedSystem);
    detail.classList.remove("collapsed");
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
    <div class="star-name">${star.name}</div>
    <div class="detail-body">
      ${aliasLine}
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
  detail.classList.remove("collapsed");
  detail.classList.add("active");
}
