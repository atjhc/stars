#!/usr/bin/env python3
"""
Build the unified Drake star catalog from AT-HYG v3.3 + augmentations.json.

Outputs (under <output_dir>):
  meta.json                — catalog manifest, label tier visibility radii
  notable.json             — all tier-0 labels (eager-loaded at runtime)
  systems.json             — system groupings by augmentation `system` field
  tile_<path>.bin          — 16-byte geometry per star (pos+brightness+rgb)
  tile_<path>.lbl.json     — sparse per-tile label rows (tier 0 + tier 1)

Tiers:
  0  notable   — has IAU proper name OR augmentation has wikipedia.
                 Label visible at all distances. Eagerly loaded.
  1  named     — has any catalog name (Bayer/Flamsteed/Gliese/HIP/HD/HR).
                 Label visible only when its tile is within close range.
  2  none      — no name. Pure point-cloud rendering, not interactive.

Synthetic companions: augmentation entries with a `synthetic` block create
brand-new stars (not in the source catalog) using the supplied position +
photometric data. Used for famous companions missing from AT-HYG (e.g. Sirius B).

Usage:
    python3 scripts/build-catalog.py /path/to/athyg_v33.csv data/augmentations.json dist/tiles/
"""

import csv
import json
import math
import os
import struct
import sys
from collections import defaultdict

SCALE = 3                          # parsecs to scene units
MAX_STARS_PER_TILE = 50000
MAX_DEPTH = 6
MAX_DIST_PC = 1000                 # ~3260 ly
NOTABLE_VISIBILITY_UNITS = 100000  # tier-0 labels: effectively always visible
NAMED_VISIBILITY_UNITS = 150       # tier-1 labels: ~50 ly close-only window

# Tier-0 (notable, always-visible label): IAU-named bright stars, plus any
# star explicitly marked `"notable": true` in augmentations.json, minus any
# marked `"notable": false`. Classification is independent of augmentation
# metadata (wikipedia/notes/aliases) — that data still merges onto whatever
# tier the star ends up in, so a tier-1 star can still have rich detail-panel
# data when selected.
NOTABLE_MAG_THRESHOLD = 4.0
NAMED_MAG_THRESHOLD = 6.0


def bv_to_color(ci: float) -> tuple[int, int, int]:
    """Convert B-V color index to saturated RGB bytes (Ballesteros + Helland)."""
    if ci < -0.4: ci = -0.4
    if ci > 2.0: ci = 2.0
    temp = 4600.0 * (1.0 / (0.92 * ci + 1.7) + 1.0 / (0.92 * ci + 0.62))
    t = temp / 100.0
    if t <= 66:
        r = 1.0
    else:
        r = min(1, 329.698727446 * (t - 60) ** -0.1332047592 / 255)
    if t <= 66:
        g = min(1, max(0, (99.4708025861 * math.log(t) - 161.1195681661) / 255))
    else:
        g = min(1, 288.1221695283 * (t - 60) ** -0.0755148492 / 255)
    if t >= 66:
        b = 1.0
    elif t <= 19:
        b = 0.0
    else:
        b = min(1, max(0, (138.5177312231 * math.log(t - 10) - 305.0447927307) / 255))
    avg = (r + g + b) / 3
    sat = 1.8
    r = min(1, max(0, avg + (r - avg) * sat))
    g = min(1, max(0, avg + (g - avg) * sat))
    b = min(1, max(0, avg + (b - avg) * sat))
    return (int(r * 255), int(g * 255), int(b * 255))


def lum_from_absmag(absmag: float) -> float:
    return 10 ** ((4.74 - absmag) / 2.5) if absmag < 20 else 0.001


def brightness_byte(absmag: float) -> int:
    """0-255 byte matching the billboard brightness curve."""
    lum = lum_from_absmag(absmag)
    val = max(0.8, min(2.5, 0.9 + 0.35 * math.log10(max(lum, 0.001)))) / 2.5
    return int(val * 255)


def get_key(row: dict) -> str:
    """Stable identifier matching augmentations.json keys."""
    gl = row.get("gl", "").strip()
    if gl:
        return gl
    hip = row.get("hip", "").strip()
    if hip:
        return f"HIP {hip}"
    if row.get("proper", "").strip() == "Sol":
        return "Sol"
    return f"HYG {row['id']}"


def get_names(row: dict) -> tuple[str | None, list[str], bool]:
    """Walk the naming hierarchy. Returns (primary, aliases, has_proper)."""
    candidates: list[str] = []
    proper = row.get("proper", "").strip()
    if proper:
        candidates.append(proper)
    bayer = row.get("bayer", "").strip()
    flam = row.get("flam", "").strip()
    con = row.get("con", "").strip()
    if bayer and con:
        candidates.append(f"{bayer} {con}")
    if flam and con:
        candidates.append(f"{flam} {con}")
    gl = row.get("gl", "").strip()
    if gl:
        candidates.append(gl)
    hip = row.get("hip", "").strip()
    if hip:
        candidates.append(f"HIP {hip}")
    hd = row.get("hd", "").strip()
    if hd:
        candidates.append(f"HD {hd}")
    hr = row.get("hr", "").strip()
    if hr:
        candidates.append(f"HR {hr}")
    return (candidates[0] if candidates else None, candidates[1:], bool(proper))


class OctreeNode:
    def __init__(self, mn, mx, depth=0):
        self.min = mn
        self.max = mx
        self.depth = depth
        self.stars: list[dict] = []
        self.children: list["OctreeNode"] | None = None

    @property
    def center(self):
        return tuple((a + b) / 2 for a, b in zip(self.min, self.max))

    def add(self, s):
        self.stars.append(s)

    def subdivide(self):
        cx, cy, cz = self.center
        mn, mx = self.min, self.max
        self.children = []
        for i in range(8):
            x0 = mn[0] if (i & 1) == 0 else cx
            x1 = cx if (i & 1) == 0 else mx[0]
            y0 = mn[1] if (i & 2) == 0 else cy
            y1 = cy if (i & 2) == 0 else mx[1]
            z0 = mn[2] if (i & 4) == 0 else cz
            z1 = cz if (i & 4) == 0 else mx[2]
            self.children.append(OctreeNode((x0, y0, z0), (x1, y1, z1), self.depth + 1))
        for s in self.stars:
            self._place(s)
        self.stars = []

    def _place(self, s):
        cx, cy, cz = self.center
        x, y, z = s["sx"], s["sy"], s["sz"]
        idx = (1 if x >= cx else 0) | (2 if y >= cy else 0) | (4 if z >= cz else 0)
        self.children[idx].add(s)

    def build(self):
        if len(self.stars) <= MAX_STARS_PER_TILE or self.depth >= MAX_DEPTH:
            return
        self.subdivide()
        for c in self.children:
            c.build()

    def collect(self, tiles, path="0"):
        if self.children is None:
            if self.stars:
                tiles[path] = {
                    "stars": self.stars,
                    "min": self.min,
                    "max": self.max,
                    "depth": self.depth,
                }
            return
        for i, c in enumerate(self.children):
            c.collect(tiles, f"{path}_{i}")


def main(csv_path: str, aug_path: str, out_dir: str):
    with open(aug_path) as f:
        augmentations: dict = json.load(f)

    print(f"Reading {csv_path}...")
    stars: list[dict] = []
    skipped = 0
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                d = row.get("dist", "").strip()
                if not d:
                    skipped += 1
                    continue
                dist = float(d)
                if dist < 0 or dist > MAX_DIST_PC or dist >= 100000:
                    skipped += 1
                    continue
                x0 = row.get("x0", "").strip()
                y0 = row.get("y0", "").strip()
                z0 = row.get("z0", "").strip()
                if not (x0 and y0 and z0):
                    skipped += 1
                    continue

                cx, cy, cz = float(x0), float(y0), float(z0)
                sx = cx * SCALE
                sy = cz * SCALE
                sz = -cy * SCALE

                mag = float(row.get("mag", "").strip() or 10.0)
                absmag = float(row.get("absmag", "").strip() or 10.0)
                ci = float(row.get("ci", "").strip() or 0.656)

                key = get_key(row)
                proper = row.get("proper", "").strip()
                # Merge catalog-key and proper-name augmentation entries so a
                # curated Vega entry keyed by proper name takes precedence over
                # a stale Gliese-keyed entry. Proper-name entry wins on conflict.
                aug = {}
                if key in augmentations:
                    aug.update(augmentations[key])
                if proper and proper in augmentations:
                    aug.update(augmentations[proper])
                primary, aliases, has_proper = get_names(row)

                if aug.get("name"):
                    if primary and primary != aug["name"]:
                        aliases.insert(0, primary)
                    primary = aug["name"]

                # Merge curator-supplied aliases (traditional/cultural names)
                # in front of the auto-generated catalog-ID aliases, skipping
                # duplicates and the primary name itself.
                for extra in aug.get("aliases", []) or []:
                    if extra and extra != primary and extra not in aliases:
                        aliases.insert(0, extra)

                explicit_notable = aug.get("notable")
                if explicit_notable is True:
                    tier = 0
                elif explicit_notable is False:
                    tier = 2
                elif has_proper and mag < NOTABLE_MAG_THRESHOLD:
                    tier = 0
                elif primary and (mag < NAMED_MAG_THRESHOLD or aug.get("system")):
                    tier = 1
                else:
                    tier = 2

                stars.append({
                    "sx": sx, "sy": sy, "sz": sz,
                    "dist": dist, "mag": mag, "absmag": absmag, "ci": ci,
                    "spect": row.get("spect", "").strip(),
                    "key": key,
                    "name": primary,
                    "aliases": aliases,
                    "tier": tier,
                    "wikipedia": aug.get("wikipedia"),
                    "notes": aug.get("notes"),
                    "system": aug.get("system"),
                    "synthetic": False,
                })
            except (ValueError, KeyError):
                skipped += 1
    print(f"Loaded {len(stars)} stars (skipped {skipped})")

    existing_keys = {s["key"] for s in stars}
    synth_count = 0
    for key, aug in augmentations.items():
        synth = aug.get("synthetic")
        if not synth or key in existing_keys:
            continue
        cx, cy, cz = synth["x"], synth["y"], synth["z"]
        sx = cx * SCALE
        sy = cz * SCALE
        sz = -cy * SCALE
        absmag = synth.get("absmag", 10.0)
        stars.append({
            "sx": sx, "sy": sy, "sz": sz,
            "dist": synth.get("dist", 0),
            "mag": synth.get("mag", 10.0),
            "absmag": absmag,
            "ci": synth.get("ci", 0.656),
            "spect": synth.get("spect", ""),
            "key": key,
            "name": aug.get("name", key),
            "aliases": [],
            "tier": 0 if aug.get("notable") else 1,
            "wikipedia": aug.get("wikipedia"),
            "notes": aug.get("notes"),
            "system": aug.get("system"),
            "synthetic": True,
        })
        synth_count += 1
    print(f"Injected {synth_count} synthetic companions")

    min_xyz = [min(s["s" + a] for s in stars) for a in "xyz"]
    max_xyz = [max(s["s" + a] for s in stars) for a in "xyz"]
    half = max(max_xyz[i] - min_xyz[i] for i in range(3)) / 2 * 1.01
    cnt = [(min_xyz[i] + max_xyz[i]) / 2 for i in range(3)]
    print(f"Bounds: ({min_xyz[0]:.0f},{min_xyz[1]:.0f},{min_xyz[2]:.0f}) to ({max_xyz[0]:.0f},{max_xyz[1]:.0f},{max_xyz[2]:.0f})")

    print(f"Building octree (max {MAX_STARS_PER_TILE} stars/tile, max depth {MAX_DEPTH})...")
    root = OctreeNode(
        tuple(cnt[i] - half for i in range(3)),
        tuple(cnt[i] + half for i in range(3)),
    )
    for s in stars:
        root.add(s)
    root.build()

    tiles: dict = {}
    root.collect(tiles)
    print(f"Generated {len(tiles)} tiles")

    os.makedirs(out_dir, exist_ok=True)

    meta = {
        "tileCount": len(tiles),
        "totalStars": len(stars),
        "bytesPerStar": 16,
        "format": "x:f32, y:f32, z:f32, brightness:u8, r:u8, g:u8, b:u8",
        "labelTierVisibility": {
            "0": NOTABLE_VISIBILITY_UNITS,
            "1": NAMED_VISIBILITY_UNITS,
        },
        "bounds": {
            "min": [cnt[i] - half for i in range(3)],
            "max": [cnt[i] + half for i in range(3)],
        },
        "tiles": {},
    }

    notable: list[dict] = []
    systems: dict[str, list] = defaultdict(list)
    total_bin_bytes = 0
    total_lbl_bytes = 0
    tiles_with_labels = 0

    for path, tile in tiles.items():
        bin_filename = f"tile_{path}.bin"
        lbl_filename = f"tile_{path}.lbl.json"

        buf = bytearray()
        label_rows: list[dict] = []
        labels_in_tile = {0: 0, 1: 0}

        for i, s in enumerate(tile["stars"]):
            br = brightness_byte(s["absmag"])
            r, g, b = bv_to_color(s["ci"])
            buf.extend(struct.pack("<fff", s["sx"], s["sy"], s["sz"]))
            buf.extend(struct.pack("BBBB", br, r, g, b))

            if s["tier"] >= 2:
                continue
            labels_in_tile[s["tier"]] += 1
            row: dict = {
                "i": i,
                "tier": s["tier"],
                "name": s["name"],
                "spect": s["spect"],
                "mag": round(s["mag"], 2),
                "absmag": round(s["absmag"], 2),
                "ci": round(s["ci"], 3),
                "lum": round(lum_from_absmag(s["absmag"]), 4),
                "dist": round(s["dist"], 4),
            }
            if s["aliases"]:
                row["aliases"] = s["aliases"]
            if s["wikipedia"]:
                row["wikipedia"] = s["wikipedia"]
            if s["notes"]:
                row["notes"] = s["notes"]
            if s["system"]:
                row["system"] = s["system"]
            if s["synthetic"]:
                row["synthetic"] = True
            label_rows.append(row)

            if s["tier"] == 0:
                notable.append({
                    **row,
                    "tile": path,
                    "pos": [round(s["sx"], 4), round(s["sy"], 4), round(s["sz"], 4)],
                })

            if s["system"]:
                systems[s["system"]].append({"tile": path, "i": i, "name": s["name"]})

        bin_path = os.path.join(out_dir, bin_filename)
        with open(bin_path, "wb") as f:
            f.write(buf)
        total_bin_bytes += len(buf)

        if label_rows:
            lbl_path = os.path.join(out_dir, lbl_filename)
            with open(lbl_path, "w") as f:
                json.dump({"labels": label_rows}, f)
            total_lbl_bytes += os.path.getsize(lbl_path)
            tiles_with_labels += 1

        meta["tiles"][path] = {
            "bin": bin_filename,
            "lbl": lbl_filename if label_rows else None,
            "stars": len(tile["stars"]),
            "min": list(tile["min"]),
            "max": list(tile["max"]),
            "depth": tile["depth"],
            "labelCounts": labels_in_tile,
        }

    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f)
    with open(os.path.join(out_dir, "notable.json"), "w") as f:
        json.dump(notable, f)
    with open(os.path.join(out_dir, "systems.json"), "w") as f:
        json.dump(systems, f)

    print(f"Geometry: {total_bin_bytes / 1024 / 1024:.1f} MB across {len(tiles)} tiles")
    print(f"Labels:   {total_lbl_bytes / 1024 / 1024:.2f} MB across {tiles_with_labels} tile label files")
    print(f"Notable:  {len(notable)} tier-0 stars")
    print(f"Systems:  {len(systems)} groupings")

    sizes = sorted(len(t["stars"]) for t in tiles.values())
    print(f"Stars/tile: min={sizes[0]}, median={sizes[len(sizes)//2]}, max={sizes[-1]}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <athyg_v33.csv> <augmentations.json> <output_dir>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
