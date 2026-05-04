import type { SearchEntry } from "./catalog.ts";
import { getSearchIndex } from "./catalog.ts";
import { filterSearch, getSearchKindLabel } from "./searchFilter.ts";
import { isDustVisible } from "./dust.ts";
import { isFavorite } from "./favorites.ts";
import { addRecent, getRecents } from "./recents.ts";
import { registerPanel, setOpenPanel, closePanel } from "./panelManager.ts";

const searchEl = document.getElementById("search")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchResults = document.getElementById("search-results")!;
const searchBtn = document.getElementById("search-btn")!;
const tabButtons = searchEl.querySelectorAll<HTMLButtonElement>(".search-tab");

type Category = "all" | "favorites" | "recent";

const isSearchOpen = () => searchEl.classList.contains("active");
// -1 means "nothing highlighted yet" — stays that way until the user
// presses an arrow key. Typing a query doesn't implicitly pre-select
// the first row; the user has to confirm with ArrowDown (or ArrowUp,
// which jumps to the last result).
let selectedIndex = -1;
let filteredEntries: SearchEntry[] = [];
let activeTab: Category = "all";

function setActiveTab(tab: Category) {
  activeTab = tab;
  tabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  updateSearchResults(searchInput.value);
  renderSearchResults();
  searchInput.focus();
}

registerPanel("search", () => {
  searchEl.classList.remove("active");
  searchInput.blur();
});

// Document-level capture-phase Escape handler. Forces the close
// directly rather than going through closePanel, which early-returns
// if panelManager's `current` drifts out of sync with the visible
// .active class. (Note: only fires if the runtime environment isn't
// intercepting Escape — Karabiner / Hammerspoon / similar can swallow
// the event before any browser handler sees it.)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchEl.classList.contains("active")) {
    e.preventDefault();
    e.stopPropagation();
    searchEl.classList.remove("active");
    searchInput.blur();
    closePanel("search");
  }
}, true);

function openSearch() {
  searchEl.classList.add("active");
  searchInput.value = "";
  setActiveTab(activeTab);
  setOpenPanel("search");
}

function closeSearch() {
  closePanel("search");
}

function updateSearchResults(query: string) {
  const q = query.trim();
  const exclude = isDustVisible() ? undefined : new Set(["n"]);

  if (activeTab === "all") {
    filteredEntries = q.length > 0 ? filterSearch(q, getSearchIndex(), exclude) : [];
  } else if (activeTab === "favorites") {
    const all = q.length > 0 ? filterSearch(q, getSearchIndex(), exclude) : getSearchIndex();
    const seen = new Set<string>();
    filteredEntries = [];
    for (const e of all) {
      // Directly favorited by own name
      if (isFavorite(e.n)) {
        if (!seen.has(e.n)) { seen.add(e.n); filteredEntries.push(e); }
        continue;
      }
      // System/cluster favorited — show one representative entry
      if (e.sy && isFavorite(e.sy) && !seen.has(e.sy)) {
        // Find the cluster/nebula entry if it exists, otherwise use this one
        const clusterEntry = all.find((c) => c.n === e.sy && (c.k === "c" || c.k === "n"));
        seen.add(e.sy);
        filteredEntries.push(clusterEntry ?? e);
      }
      if (filteredEntries.length >= 20) break;
    }
    filteredEntries.sort((a, b) => a.n.localeCompare(b.n));
    filteredEntries = filteredEntries.slice(0, 20);
  } else {
    const recentNames = getRecents();
    const index = getSearchIndex();
    const byName = new Map<string, SearchEntry>();
    for (const e of index) byName.set(e.sy ?? e.n, e);
    const recentEntries = recentNames
      .map((name) => byName.get(name))
      .filter((e): e is SearchEntry => e !== undefined);
    if (q.length > 0) {
      const ql = q.toLowerCase();
      filteredEntries = recentEntries.filter((e) =>
        e.n.toLowerCase().includes(ql)
        || e.sy?.toLowerCase().includes(ql)
        || e.a?.some((a) => a.toLowerCase().includes(ql))
      ).slice(0, 20);
    } else {
      filteredEntries = recentEntries.slice(0, 20);
    }
  }
  selectedIndex = -1;
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

    const bookmarkName = entry.sy ?? entry.n;
    const bmSuffix = activeTab !== "favorites" && isFavorite(bookmarkName) ? " ★" : "";

    const kindLabel = entry.k ? getSearchKindLabel(entry.k) : undefined;
    if (kindLabel) {
      li.innerHTML = `${entry.n}${bmSuffix} <span class="search-secondary">${kindLabel}</span>`;
    } else {
      const primaryName = entry.sy ?? entry.n;
      const matchSource = findMatchSource(entry, q);
      const secondary = matchSource && matchSource !== primaryName
        ? matchSource
        : (entry.sy && entry.n !== entry.sy ? entry.n : null);
      if (secondary) {
        li.innerHTML = `${primaryName}${bmSuffix} <span class="search-secondary">${secondary}</span>`;
      } else {
        li.textContent = primaryName + bmSuffix;
      }
    }

    if (i === selectedIndex) li.classList.add("selected");
    li.addEventListener("click", () => selectResult(i));
    searchResults.appendChild(li);
  });
}

function scrollToSelected() {
  const el = searchResults.children[selectedIndex] as HTMLElement | undefined;
  if (el) el.scrollIntoView({ block: "nearest" });
}

let selectResult = (_index: number) => {};
let previewResult = (_entry: SearchEntry) => {};

function notifyPreview() {
  if (selectedIndex >= 0 && selectedIndex < filteredEntries.length) {
    previewResult(filteredEntries[selectedIndex]);
  }
}

export function setupSearch(onSelect: (entry: SearchEntry) => void, onPreview?: (entry: SearchEntry) => void) {
  if (onPreview) previewResult = onPreview;
  selectResult = (index: number) => {
    if (index < 0 || index >= filteredEntries.length) return;
    const entry = filteredEntries[index];
    addRecent(entry.sy ?? entry.n);
    onSelect(entry);
    closeSearch();
  };

  searchBtn.addEventListener("pointerup", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSearch();
  });

  tabButtons.forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // prevent blur on the input
      setActiveTab(btn.dataset.tab as Category);
    });
  });

  searchInput.addEventListener("blur", () => {
    setTimeout(() => { if (isSearchOpen()) closeSearch(); }, 150);
  });

  searchInput.addEventListener("input", () => {
    updateSearchResults(searchInput.value);
    renderSearchResults();
  });

  window.addEventListener("keydown", (e) => {
    if (isSearchOpen()) {
    } else if (e.target instanceof HTMLInputElement) {
      return;
    } else if (e.key === "/") {
      e.preventDefault();
      openSearch();
      return;
    } else {
      return;
    }

    const tabs: Category[] = ["all", "favorites", "recent"];

    if (e.key === "Escape") {
      closeSearch();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const i = tabs.indexOf(activeTab);
      if (i > 0) setActiveTab(tabs[i - 1]);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const i = tabs.indexOf(activeTab);
      if (i < tabs.length - 1) setActiveTab(tabs[i + 1]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = selectedIndex < 0
        ? 0
        : Math.min(selectedIndex + 1, filteredEntries.length - 1);
      renderSearchResults();
      scrollToSelected();
      notifyPreview();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = selectedIndex < 0
        ? filteredEntries.length - 1
        : Math.max(selectedIndex - 1, 0);
      renderSearchResults();
      scrollToSelected();
      notifyPreview();
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectResult(selectedIndex);
    }
  });

  return { isSearchOpen };
}

export function refreshSearch() {
  if (isSearchOpen()) { updateSearchResults(searchInput.value); renderSearchResults(); }
}
