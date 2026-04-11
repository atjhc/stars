import * as THREE from "three";
import type { Star, SystemGroup, ClusterGroup } from "./types.ts";
import { starGlowShadow } from "./color.ts";
import { formatDist } from "./detail.ts";
import { camera } from "./scene.ts";
import { SCALE, LY_PER_PARSEC } from "./constants.ts";

const CLUSTER_HIGHLIGHT_GLOW = "0 0 8px rgba(160,200,255,0.9), 0 0 20px rgba(130,170,255,0.4), 0 0 4px #000";

export function focusTarget(group: SystemGroup, cameraPos: THREE.Vector3): THREE.Vector3 {
  if (group.kind === "cluster") return group.centroid;
  let nearest = group.meshes[0];
  let nearestDist = Infinity;
  for (const m of group.meshes) {
    const d = m.position.distanceTo(cameraPos);
    if (d < nearestDist) { nearest = m; nearestDist = d; }
  }
  return nearest.position.distanceTo(group.centroid) < 0.5
    ? group.centroid : nearest.position;
}

export function applySystemLabelGlow(group: SystemGroup) {
  const el = group.label.element as HTMLElement;
  if (group.meshes.length > 0) {
    let brightestStar = group.meshes[0].userData as Star;
    for (const m of group.meshes) {
      const s = m.userData as Star;
      if (s.lum > brightestStar.lum) brightestStar = s;
    }
    el.style.textShadow = starGlowShadow(brightestStar.ci);
  } else {
    el.style.textShadow = CLUSTER_HIGHLIGHT_GLOW;
  }
}

export function removeSystemLabelGlow(group: SystemGroup) {
  (group.label.element as HTMLElement).style.textShadow =
    group.kind === "cluster" ? group.defaultShadow : "";
}

function formatSceneDist(sceneUnits: number): string {
  const ly = (sceneUnits / SCALE) * LY_PER_PARSEC;
  if (ly < 1) return `${ly.toFixed(3)} ly`;
  if (ly < 10) return `${ly.toFixed(2)} ly`;
  return `${ly.toFixed(1)} ly`;
}

export function labelContent(group: SystemGroup, isActive: boolean): string {
  if (group.kind === "cluster") {
    if (!isActive) return group.name;
    const dist = group.anchor.position.distanceTo(camera.position);
    return `<div>${group.name}</div><div class="system-members">${formatSceneDist(dist)}</div>`;
  }
  if (!isActive) return group.name;
  const members = group.collapsedMembers.length > 0 ? group.collapsedMembers : group.meshes;
  const names = members.map((m) => (m.userData as Star).name);
  return `<div>${group.name}</div><div class="system-members">${names.join(" · ")}</div>`;
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
