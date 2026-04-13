import { loadJSON, saveJSON } from "./storage.ts";

const MAX_RECENTS = 20;
const recents: string[] = loadJSON<string[]>("recents", []);

export function addRecent(name: string): void {
  const i = recents.indexOf(name);
  if (i !== -1) recents.splice(i, 1);
  recents.unshift(name);
  if (recents.length > MAX_RECENTS) recents.length = MAX_RECENTS;
  saveJSON("recents", recents);
}

export function getRecents(): readonly string[] {
  return recents;
}
