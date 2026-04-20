import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { formatDist } from "./detail.ts";
import { favoriteIcon } from "./detail.ts";
import { getSelectedSystem, getSelectedSubset } from "./systemStore.ts";

// Returns the effective member subset for zoom-floor / focus-target /
// URL-serialize purposes. When the user clicks a partially-collapsed
// system label (e.g. "Rigil Kentaurus · Toliman" after Proxima
// separates on screen), interaction.selectSystem snapshots that subset
// into systemStore; this helper returns the snapshot so the selection
// stays stable across subsequent zoom changes. Falls back to the full
// group when no snapshot or the group isn't the active selection.
export function effectiveSystemSubset(
  group: SystemGroup,
): { members: THREE.Object3D[]; centroid: THREE.Vector3 } {
  if (getSelectedSystem() === group) {
    const subset = getSelectedSubset();
    if (subset && subset.length >= 2 && subset.length < group.meshes.length) {
      const c = new THREE.Vector3();
      for (const m of subset) c.add(m.position);
      c.divideScalar(subset.length);
      return { members: subset, centroid: c };
    }
  }
  return { members: group.meshes, centroid: group.centroid };
}

export function focusTarget(group: SystemGroup, cameraPos: THREE.Vector3): THREE.Vector3 {
  const { members, centroid } = effectiveSystemSubset(group);
  if (group.kind === "cluster") return centroid;
  let nearest = members[0];
  let nearestDist = Infinity;
  for (const m of members) {
    const d = m.position.distanceTo(cameraPos);
    if (d < nearestDist) { nearest = m; nearestDist = d; }
  }
  return nearest.position.distanceTo(centroid) < 0.5 ? centroid : nearest.position;
}

function renderWikiLink(url: string | undefined): string {
  return url ? `<div class="star-wiki"><a href="${url}" target="_blank">Wikipedia</a></div>` : "";
}

function renderNotes(text: string | undefined): string {
  return text ? `<div class="star-notes">${text}</div>` : "";
}

export function systemDetailHtml(group: SystemGroup): string {
  if (group.kind === "cluster") {
    const aliasLine = group.aliases && group.aliases.length > 0
      ? `<div class="star-aliases">${group.aliases.join(" · ")}</div>` : "";
    return `
      ${favoriteIcon(group.name)}
      <div class="star-name">${group.name}</div>
      ${aliasLine}
      <div class="detail-body">
        <div class="star-detail">Distance: ${formatDist(group.avgDist)}</div>
        ${renderNotes(group.notes)}
        ${renderWikiLink(group.wikipedia)}
      </div>`;
  }

  // Binary/trinary system
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

  const notesHtml = notes.length > 0
    ? `<div class="star-notes">${notes.join("<br>")}</div>` : "";

  return `
    ${favoriteIcon(group.name)}
    <div class="star-name">${group.name}</div>
    <div class="detail-body">
      <div class="star-detail">Distance: ${formatDist(group.avgDist)}</div>
      <div class="system-member-list">${rows.join("")}</div>
      ${notesHtml}
      ${renderWikiLink([...wikiUrls][0])}
    </div>`;
}

export function registerMembers(
  group: SystemGroup,
  meshToSystem: Map<THREE.Object3D, SystemGroup>,
  clusterOf: Map<THREE.Object3D, SystemGroup>,
) {
  if (group.kind === "cluster") {
    for (const m of group.meshes) clusterOf.set(m, group);
  } else {
    for (const m of group.meshes) meshToSystem.set(m, group);
  }
}
