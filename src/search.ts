import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { MAX_SEARCH_RESULTS } from "./constants.ts";

const searchEl = document.getElementById("search")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchResults = document.getElementById("search-results")!;
const searchBtn = document.getElementById("search-btn")!;

let searchOpen = false;
let selectedIndex = 0;
let filteredStars: { star: Star; mesh: THREE.Object3D }[] = [];

function openSearch() {
  searchOpen = true;
  searchEl.classList.add("active");
  searchBtn.classList.add("hidden");
  searchInput.value = "";
  updateSearchResults("");
  searchInput.focus();
}

function closeSearch() {
  searchOpen = false;
  searchEl.classList.remove("active");
  searchBtn.classList.remove("hidden");
  searchInput.blur();
}

function starMatchesQuery(star: Star, q: string): boolean {
  if (star.name.toLowerCase().includes(q)) return true;
  if (star.system?.toLowerCase().includes(q)) return true;
  if (star.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
  return false;
}

function updateSearchResults(query: string, starObjects?: THREE.Object3D[]) {
  const q = query.toLowerCase().trim();
  filteredStars = [];
  if (q.length > 0 && starObjects) {
    const seen = new Set<THREE.Object3D>();

    for (const mesh of starObjects) {
      const star = mesh.userData as Star;
      const nameMatch = star.name.toLowerCase().includes(q);
      const sysMatch = star.system?.toLowerCase().includes(q) ?? false;
      if (!nameMatch && !sysMatch) continue;
      seen.add(mesh);
      filteredStars.push({ star, mesh });
      if (filteredStars.length >= MAX_SEARCH_RESULTS) break;
    }

    if (filteredStars.length < MAX_SEARCH_RESULTS) {
      const seenSystems = new Set<string>();
      for (const mesh of starObjects) {
        if (seen.has(mesh)) continue;
        const star = mesh.userData as Star;
        if (!star.aliases?.some((a) => a.toLowerCase().includes(q))) continue;
        if (star.system) {
          if (seenSystems.has(star.system)) continue;
          seenSystems.add(star.system);
        }
        filteredStars.push({ star, mesh });
        if (filteredStars.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  selectedIndex = 0;
}

function findMatchSource(star: Star, q: string): string | null {
  if (star.name.toLowerCase().includes(q)) return null;
  if (star.system?.toLowerCase().includes(q)) return star.system;
  const alias = star.aliases?.find((a) => a.toLowerCase().includes(q));
  if (alias) return alias;
  return null;
}

function renderSearchResults(meshToSystem: Map<THREE.Object3D, SystemGroup>) {
  searchResults.innerHTML = "";
  const q = searchInput.value.toLowerCase().trim();
  filteredStars.forEach((entry, i) => {
    const li = document.createElement("li");
    const sys = meshToSystem.get(entry.mesh);
    const primaryName = sys ? sys.name : entry.star.name;
    const matchSource = findMatchSource(entry.star, q);
    const secondary = matchSource && matchSource !== primaryName
      ? matchSource
      : (sys && entry.star.name !== sys.name ? entry.star.name : null);

    if (secondary) {
      li.innerHTML = `${primaryName} <span class="search-secondary">${secondary}</span>`;
    } else {
      li.textContent = primaryName;
    }
    if (i === selectedIndex) li.classList.add("selected");
    li.addEventListener("click", () => selectResult(i));
    searchResults.appendChild(li);
  });
}

let selectResult = (_index: number) => {};

export function setupSearch(
  starObjects: THREE.Object3D[],
  meshToSystem: Map<THREE.Object3D, SystemGroup>,
  onSelect: (mesh: THREE.Object3D) => void,
) {
  selectResult = (index: number) => {
    if (index < 0 || index >= filteredStars.length) return;
    onSelect(filteredStars[index].mesh);
    closeSearch();
  };

  searchBtn.addEventListener("pointerup", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSearch();
  });

  searchInput.addEventListener("blur", () => {
    setTimeout(() => { if (searchOpen) closeSearch(); }, 150);
  });

  searchInput.addEventListener("input", () => {
    updateSearchResults(searchInput.value, starObjects);
    renderSearchResults(meshToSystem);
  });

  window.addEventListener("keydown", (e) => {
    if (searchOpen) {
    } else if (e.target instanceof HTMLInputElement) {
      return;
    } else if (e.key === "/") {
      e.preventDefault();
      openSearch();
      return;
    } else {
      return;
    }

    if (e.key === "Escape") {
      closeSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filteredStars.length - 1);
      renderSearchResults(meshToSystem);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderSearchResults(meshToSystem);
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectResult(selectedIndex);
    }
  });

  return { isSearchOpen: () => searchOpen };
}
