---
name: research
description: Fill metadata gaps in data/augmentations.json for the Drake star visualization. Runs scripts/audit-notable.py to identify tier-0 stars missing wikipedia links, traditional aliases, or curator notes, then dispatches research subagents in parallel to look up the missing data and merges their results. Use when the user says "research notable stars", "fill in star metadata", "update augmentations", or after build-catalog.py has been re-run on a newer catalog.
allowed-tools: Bash, Read, Edit, Write, Agent, WebFetch
---

# Drake — Notable Star Research

Fills gaps in `data/augmentations.json` for the stars classified as tier 0 by `scripts/build-catalog.py`. The tier-0 set (~265 stars) is what gets always-visible labels, so each entry should have a Wikipedia link, a 1–3 sentence note, and any traditional/cultural aliases beyond the catalog IDs.

## Prerequisites

The tile catalog must be built so `dist/tiles/notable.json` exists:

```sh
python3 scripts/build-catalog.py /path/to/athyg_v33.csv data/augmentations.json dist/tiles/
```

If `dist/tiles/notable.json` is missing, the audit script will fail with a clear error.

## Workflow

### 1. Audit: find the gaps

```sh
python3 scripts/audit-notable.py            # human-readable summary
python3 scripts/audit-notable.py --json     # machine-readable gap list
```

The JSON output is a list of objects shaped like:

```json
{
  "name": "Canopus",
  "mag": -0.62,
  "dist_ly": 309.2,
  "spect": "A9II",
  "aug_key": null,
  "missing": ["wikipedia", "notes", "traditional-alias"],
  "aliases": ["Alp Car", "HIP 30438", "HD 45348", "HR 2326"]
}
```

`missing` is one or more of `wikipedia`, `notes`, `traditional-alias`. `aug_key` is the current augmentation entry key if one exists, otherwise null.

### 2. Split into batches

Research agents work best on ~20 stars at a time. Dump the gap list and slice it:

```sh
python3 scripts/audit-notable.py --json > /tmp/drake-gaps.json
python3 -c "
import json
g = json.load(open('/tmp/drake-gaps.json'))
batch_size = 22
for i in range(0, len(g), batch_size):
    with open(f'/tmp/drake-batch-{i // batch_size}.json', 'w') as f:
        json.dump(g[i:i + batch_size], f, indent=2)
print(f'wrote {(len(g) + batch_size - 1) // batch_size} batches')
"
```

### 3. Dispatch research agents in parallel

Launch one subagent per batch **in the same message** so they run concurrently. Each batch typically completes in 1–3 minutes; running 12 in parallel keeps the whole run under ~5 minutes.

Prompt template (customize the batch file path for each agent):

```
You are researching bright stars to populate augmentation metadata for the Drake stellar visualization project.

Read the batch of stars at /tmp/drake-batch-N.json. Each entry has: `name`, `mag`, `dist_ly`, `spect` (spectral class), `aliases` (auto-generated catalog IDs), `missing`.

For EACH star, produce an augmentation entry with these fields:
- `wikipedia`: canonical English Wikipedia URL (direct article, not a redirect or disambiguation page).
- `notes`: 1-3 concise sentences. Include constellation, distinctive physical properties (variability, multiplicity, exoplanet host, spectral oddities) and any strong cultural or historical significance. Shows in a detail panel sidebar — keep it tight.
- `aliases`: JSON array of traditional/cultural names and widely-used alternates NOT already in the input `aliases` field. Skip HIP/HD/HR/Bayer/Flamsteed/Gliese duplicates. Include traditional Arabic/Latin names, variable-star designations. Omit the field entirely if no extras exist.

Output format: a single JSON object where keys are star names (exactly matching the input `name` field) and values are augmentation objects.

Example output:
{
  "Sirius": {
    "wikipedia": "https://en.wikipedia.org/wiki/Sirius",
    "notes": "Brightest star in the night sky. A1V primary of a binary system; the white dwarf companion Sirius B orbits every ~50 years.",
    "aliases": ["Dog Star", "Canicula"]
  }
}

Use WebFetch to confirm every Wikipedia URL resolves. Disambiguate using spectral class / distance / magnitude when a name could refer to multiple stars.

Return ONLY the JSON object, no prose commentary. Your output will be merged into data/augmentations.json programmatically.
```

Run each agent with `run_in_background: true` so they execute concurrently instead of blocking on each other.

### 4. Merge batch outputs back into augmentations.json

Once all agents complete, collect their JSON outputs and merge. `augmentations.json` is keyed by Gliese/HIP/Sol AND (since build-catalog.py accepts proper-name keys as a fallback) by IAU proper name — so the research results can be merged as-is using the star names as keys.

Use a Python merge script so existing entries keep their non-overridden fields:

```sh
python3 scripts/merge-augmentations.py /tmp/drake-batch-*.results.json
```

Or inline:

```python
import json
from pathlib import Path
aug = json.load(open("data/augmentations.json"))
for p in sorted(Path("/tmp").glob("drake-batch-*.results.json")):
    for name, entry in json.load(open(p)).items():
        existing = aug.get(name, {})
        existing.update(entry)   # new fields overwrite, other fields preserved
        aug[name] = existing
json.dump(aug, open("data/augmentations.json", "w"), indent=2, ensure_ascii=False)
```

### 5. Rebuild and verify

```sh
python3 scripts/build-catalog.py /path/to/athyg_v33.csv data/augmentations.json dist/tiles/
python3 scripts/audit-notable.py     # should report far fewer gaps
```

Inspect a handful of results in the browser's detail panel to confirm Wikipedia links open the right article and notes render correctly.

## Notes & gotchas

- **Wikipedia disambiguation**: names like "Alcyone" refer to Pleiades member *and* other objects. Always use spectral class + magnitude + distance from the batch entry to pick the right article.
- **Multi-star systems**: Alpha Centauri A (Rigil Kentaurus), Alpha Centauri B (Toliman), and Proxima Centauri share a single Wikipedia article in some cases. Link each component to its most specific page; use the system article as a fallback with a component-pinned anchor (`#Alpha_Centauri_B`).
- **Traditional names**: many IAU names *are* the traditional name (Sirius, Vega). Don't echo them into `aliases`. Include OTHER names: Arabic transliterations, Chinese asterism names, historical designations, or common nicknames (Dog Star, Polestar).
- **Notes voice**: neutral, factual, compact. Don't mention which catalog the star's in or its Drake tier. Do mention one interesting thing a curious user would want to see in a detail panel.
- **Existing entries**: if an entry already has wikipedia/notes/system from a previous pass, leave those alone; the merge step preserves them. Only fill the fields listed in `missing`.
- **Re-run cadence**: after changing the tier-0 selection rule in `build-catalog.py` (magnitude threshold, notable flags) the notable set shifts and new gaps appear. Re-run this workflow.
