import type { Star, SystemGroup } from "./types.ts";
import { selectedMesh, selectedSystem } from "./interaction.ts";

const detail = document.getElementById("detail")!;

detail.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) return;
  if (window.getSelection()?.toString()) return;
  detail.classList.toggle("collapsed");
});

export function formatDist(pc: number): string {
  return `${(pc * 3.262).toFixed(1)} ly (${pc.toFixed(2)} pc)`;
}

function renderWikiLink(url: string | undefined): string {
  return url ? `<div class="star-wiki"><a href="${url}" target="_blank">Wikipedia</a></div>` : "";
}

function renderNotes(text: string | undefined): string {
  return text ? `<div class="star-notes">${text}</div>` : "";
}

function updateSystemDetailPanel(group: SystemGroup) {
  const wikiUrls = new Set<string>();
  const notes: string[] = [];
  const rows: string[] = [];
  for (const m of group.meshes) {
    const s = m.userData as Star;
    const spect = s.spect ? `<span class="member-spect">${s.spect}</span>` : "";
    rows.push(`<div class="system-member-row">${s.name} — ${formatDist(s.dist)} ${spect}</div>`);
    if (s.wikipedia) wikiUrls.add(s.wikipedia);
    if (s.notes) notes.push(`<strong>${s.name}:</strong> ${s.notes}`);
  }

  detail.innerHTML = `
    <div class="star-name">${group.name}</div>
    <div class="detail-body">
      <div class="star-detail">
        Distance: ${formatDist(group.avgDist)}
      </div>
      <div class="system-member-list">${rows.join("")}</div>
      ${notes.length > 0 ? `<div class="star-notes">${notes.join("<br>")}</div>` : ""}
      ${renderWikiLink([...wikiUrls][0])}
    </div>
  `;
  detail.classList.add("active");
}

export function updateDetailPanel() {
  if (selectedSystem) {
    updateSystemDetailPanel(selectedSystem);
    return;
  }

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
  detail.classList.add("active");
}
