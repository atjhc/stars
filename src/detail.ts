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
  const isCluster = group.kind === "cluster";

  // Clusters have their own curated blurb + wikipedia at the group level;
  // binary systems aggregate from members instead.
  const groupWiki = group.wikipedia;
  const groupNotes = group.notes;

  const wikiUrls = new Set<string>();
  const memberNotes: string[] = [];
  const rows: string[] = [];
  for (const m of group.meshes) {
    const s = m.userData as Star;
    const spect = s.spect ? `<span class="member-spect">${s.spect}</span>` : "";
    rows.push(`<div class="system-member-row">${s.name} — ${formatDist(s.dist)} ${spect}</div>`);
    if (!isCluster) {
      if (s.wikipedia) wikiUrls.add(s.wikipedia);
      if (s.notes) memberNotes.push(`<strong>${s.name}:</strong> ${s.notes}`);
    }
  }

  const wikiUrl = groupWiki ?? [...wikiUrls][0];
  const notesHtml = groupNotes
    ? renderNotes(groupNotes)
    : (memberNotes.length > 0 ? `<div class="star-notes">${memberNotes.join("<br>")}</div>` : "");

  const aliasLine = isCluster && group.aliases && group.aliases.length > 0
    ? `<div class="star-aliases">${group.aliases.join(" · ")}</div>` : "";

  const memberList = isCluster
    ? ""
    : `<div class="system-member-list">${rows.join("")}</div>`;

  detail.innerHTML = `
    <div class="star-name">${group.name}</div>
    ${aliasLine}
    <div class="detail-body">
      <div class="star-detail">
        Distance: ${formatDist(group.avgDist)}
      </div>
      ${memberList}
      ${notesHtml}
      ${renderWikiLink(wikiUrl)}
    </div>
  `;
  detail.classList.remove("collapsed");
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
  detail.classList.remove("collapsed");
  detail.classList.add("active");
}
