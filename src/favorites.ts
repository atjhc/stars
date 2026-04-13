import { loadJSON, saveJSON } from "./storage.ts";

const favorites: Set<string> = new Set(loadJSON<string[]>("favorites", []));

export function isFavorite(name: string): boolean {
  return favorites.has(name);
}

export function toggleFavorite(name: string): boolean {
  if (favorites.has(name)) {
    favorites.delete(name);
  } else {
    favorites.add(name);
  }
  saveJSON("favorites", [...favorites]);
  return favorites.has(name);
}
