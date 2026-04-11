import type { SearchEntry } from "./catalog.ts";
import { getSearchIndex } from "./catalog.ts";
import { filterSearch } from "./searchFilter.ts";

const searchEl = document.getElementById("search")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchResults = document.getElementById("search-results")!;
const searchBtn = document.getElementById("search-btn")!;

let searchOpen = false;
let selectedIndex = 0;
let filteredEntries: SearchEntry[] = [];

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

function updateSearchResults(query: string) {
  filteredEntries = filterSearch(query, getSearchIndex());
  selectedIndex = 0;
}

function findMatchSource(entry: SearchEntry, q: string): string | null {
  if (entry.n.toLowerCase().includes(q)) return null;
  if (entry.sy?.toLowerCase().includes(q)) return entry.sy;
  const alias = entry.a?.find((a) => a.toLowerCase().includes(q));
  return alias ?? null;
}

function renderSearchResults() {
  searchResults.innerHTML = "";
  const q = searchInput.value.toLowerCase().trim();
  filteredEntries.forEach((entry, i) => {
    const li = document.createElement("li");

    if (entry.k === "c") {
      li.innerHTML = `${entry.n} <span class="search-secondary">Star Cluster</span>`;
    } else if (entry.k === "n") {
      li.innerHTML = `${entry.n} <span class="search-secondary">Nebula</span>`;
    } else {
      const primaryName = entry.sy ?? entry.n;
      const matchSource = findMatchSource(entry, q);
      const secondary = matchSource && matchSource !== primaryName
        ? matchSource
        : (entry.sy && entry.n !== entry.sy ? entry.n : null);
      if (secondary) {
        li.innerHTML = `${primaryName} <span class="search-secondary">${secondary}</span>`;
      } else {
        li.textContent = primaryName;
      }
    }

    if (i === selectedIndex) li.classList.add("selected");
    li.addEventListener("click", () => selectResult(i));
    searchResults.appendChild(li);
  });
}

let selectResult = (_index: number) => {};

export function setupSearch(onSelect: (entry: SearchEntry) => void) {
  selectResult = (index: number) => {
    if (index < 0 || index >= filteredEntries.length) return;
    onSelect(filteredEntries[index]);
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
    updateSearchResults(searchInput.value);
    renderSearchResults();
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
      selectedIndex = Math.min(selectedIndex + 1, filteredEntries.length - 1);
      renderSearchResults();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderSearchResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectResult(selectedIndex);
    }
  });

  return { isSearchOpen: () => searchOpen };
}
