const STORAGE_KEY = "drake-favorites";

const favorites: Set<string> = new Set(
  JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"),
);

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...favorites]));
}

export function isFavorite(name: string): boolean {
  return favorites.has(name);
}

export function toggleFavorite(name: string): boolean {
  if (favorites.has(name)) {
    favorites.delete(name);
  } else {
    favorites.add(name);
  }
  save();
  return favorites.has(name);
}
