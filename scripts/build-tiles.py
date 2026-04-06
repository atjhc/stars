#!/usr/bin/env python3
"""
Build binary octree tiles from the AT-HYG star catalog for streaming.

Each tile is a compact binary file containing star positions, colors, and
brightness packed for direct GPU upload.

Binary format per star (16 bytes):
  x, y, z: float32 × 3 (12 bytes) — scene-space position
  brightness: uint8 (1 byte) — 0-255 mapped from log luminosity
  r, g, b: uint8 × 3 (3 bytes) — star color from B-V index

Usage:
    python3 scripts/build-tiles.py /path/to/athyg_v33.csv dist/tiles/
"""

import csv
import json
import math
import os
import struct
import sys
from collections import defaultdict

SCALE = 3  # parsecs to scene units
MAX_STARS_PER_TILE = 50000
MAX_DEPTH = 6
MIN_DIST = 0  # include all stars — point cloud is the sole visual renderer
MAX_DIST = 1000  # parsecs — ~3260 ly

def bv_to_color(ci: float) -> tuple[int, int, int]:
    """Convert B-V color index to RGB bytes using Ballesteros + Helland."""
    if ci < -0.4: ci = -0.4
    if ci > 2.0: ci = 2.0
    temp = 4600.0 * (1.0 / (0.92 * ci + 1.7) + 1.0 / (0.92 * ci + 0.62))
    t = temp / 100.0

    if t <= 66: r = 1.0
    else: r = min(1, 329.698727446 * (t - 60) ** -0.1332047592 / 255)
    if t <= 66: g = min(1, max(0, (99.4708025861 * math.log(t) - 161.1195681661) / 255))
    else: g = min(1, 288.1221695283 * (t - 60) ** -0.0755148492 / 255)
    if t >= 66: b = 1.0
    elif t <= 19: b = 0.0
    else: b = min(1, max(0, (138.5177312231 * math.log(t - 10) - 305.0447927307) / 255))

    # Exaggerate saturation
    avg = (r + g + b) / 3
    sat = 1.8
    r = min(1, max(0, avg + (r - avg) * sat))
    g = min(1, max(0, avg + (g - avg) * sat))
    b = min(1, max(0, avg + (b - avg) * sat))

    return (int(r * 255), int(g * 255), int(b * 255))


def lum_to_brightness(mag: float, absmag: float) -> int:
    """Convert magnitude to a 0-255 brightness byte.
    Matches the billboard brightness formula: max(0.8, min(2.5, 0.9 + 0.35*log10(lum)))
    Divided by 2.5 to fit in 0-1 range, then multiplied by 255.
    The shader multiplies by 1.5 to recover the final brightness."""
    lum = 10 ** ((4.74 - absmag) / 2.5) if absmag < 20 else 0.001
    val = max(0.8, min(2.5, 0.9 + 0.35 * math.log10(max(lum, 0.001)))) / 2.5
    return int(val * 255)


class OctreeNode:
    def __init__(self, min_corner, max_corner, depth=0):
        self.min_corner = min_corner
        self.max_corner = max_corner
        self.depth = depth
        self.stars = []
        self.children = None

    @property
    def center(self):
        return tuple((a + b) / 2 for a, b in zip(self.min_corner, self.max_corner))

    def add(self, star):
        self.stars.append(star)

    def subdivide(self):
        """Split into 8 children."""
        cx, cy, cz = self.center
        mn = self.min_corner
        mx = self.max_corner
        self.children = []
        for i in range(8):
            x0 = mn[0] if (i & 1) == 0 else cx
            x1 = cx if (i & 1) == 0 else mx[0]
            y0 = mn[1] if (i & 2) == 0 else cy
            y1 = cy if (i & 2) == 0 else mx[1]
            z0 = mn[2] if (i & 4) == 0 else cz
            z1 = cz if (i & 4) == 0 else mx[2]
            self.children.append(OctreeNode((x0, y0, z0), (x1, y1, z1), self.depth + 1))

        for star in self.stars:
            self._place_in_child(star)
        self.stars = []

    def _place_in_child(self, star):
        cx, cy, cz = self.center
        x, y, z = star[0], star[1], star[2]
        idx = (1 if x >= cx else 0) | (2 if y >= cy else 0) | (4 if z >= cz else 0)
        self.children[idx].add(star)

    def build(self):
        """Recursively subdivide nodes that are too large."""
        if len(self.stars) <= MAX_STARS_PER_TILE or self.depth >= MAX_DEPTH:
            return
        self.subdivide()
        for child in self.children:
            child.build()

    def collect_tiles(self, tiles, path="0"):
        """Collect all leaf nodes as tiles."""
        if self.children is None:
            if self.stars:
                tiles[path] = {
                    "stars": self.stars,
                    "min": self.min_corner,
                    "max": self.max_corner,
                    "depth": self.depth,
                }
            return
        for i, child in enumerate(self.children):
            child.collect_tiles(tiles, f"{path}_{i}")


def pack_tile(stars) -> bytes:
    """Pack a list of stars into binary format (16 bytes each)."""
    buf = bytearray()
    for star in stars:
        x, y, z, brightness, r, g, b = star
        buf.extend(struct.pack("<fff", x, y, z))
        buf.extend(struct.pack("BBBB", brightness, r, g, b))
    return bytes(buf)


def main(input_csv: str, output_dir: str):
    os.makedirs(output_dir, exist_ok=True)

    print(f"Reading {input_csv}...")
    stars = []
    skipped = 0

    with open(input_csv) as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                dist_str = row.get("dist", "").strip()
                if not dist_str:
                    skipped += 1
                    continue
                dist = float(dist_str)
                if dist <= MIN_DIST or dist > MAX_DIST or dist >= 100000:
                    skipped += 1
                    continue

                x0 = row.get("x0", "").strip()
                y0 = row.get("y0", "").strip()
                z0 = row.get("z0", "").strip()
                if not x0 or not y0 or not z0:
                    skipped += 1
                    continue

                x = float(x0) * SCALE
                y = float(z0) * SCALE   # scene y = catalog z
                z = -float(y0) * SCALE  # scene z = -catalog y

                mag_str = row.get("mag", "").strip()
                absmag_str = row.get("absmag", "").strip()
                ci_str = row.get("ci", "").strip()

                mag = float(mag_str) if mag_str else 10.0
                absmag = float(absmag_str) if absmag_str else 10.0
                ci = float(ci_str) if ci_str else 0.656

                brightness = lum_to_brightness(mag, absmag)
                r, g, b = bv_to_color(ci)

                stars.append((x, y, z, brightness, r, g, b))
            except (ValueError, KeyError):
                skipped += 1

    print(f"Loaded {len(stars)} stars (skipped {skipped})")

    # Compute bounds
    min_x = min(s[0] for s in stars)
    max_x = max(s[0] for s in stars)
    min_y = min(s[1] for s in stars)
    max_y = max(s[1] for s in stars)
    min_z = min(s[2] for s in stars)
    max_z = max(s[2] for s in stars)

    # Expand to cube
    half = max(max_x - min_x, max_y - min_y, max_z - min_z) / 2 * 1.01
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2
    cz = (min_z + max_z) / 2

    print(f"Bounds: ({min_x:.0f},{min_y:.0f},{min_z:.0f}) to ({max_x:.0f},{max_y:.0f},{max_z:.0f})")
    print(f"Building octree (max {MAX_STARS_PER_TILE} stars/tile, max depth {MAX_DEPTH})...")

    root = OctreeNode(
        (cx - half, cy - half, cz - half),
        (cx + half, cy + half, cz + half),
    )
    for star in stars:
        root.add(star)
    root.build()

    tiles = {}
    root.collect_tiles(tiles)

    print(f"Generated {len(tiles)} tiles")

    # Write tiles
    meta = {
        "tileCount": len(tiles),
        "totalStars": len(stars),
        "bytesPerStar": 16,
        "format": "x:f32, y:f32, z:f32, brightness:u8, r:u8, g:u8, b:u8",
        "bounds": {
            "min": [cx - half, cy - half, cz - half],
            "max": [cx + half, cy + half, cz + half],
        },
        "tiles": {},
    }

    total_bytes = 0
    for path, tile in tiles.items():
        filename = f"tile_{path}.bin"
        data = pack_tile(tile["stars"])
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "wb") as f:
            f.write(data)
        total_bytes += len(data)

        meta["tiles"][path] = {
            "file": filename,
            "stars": len(tile["stars"]),
            "min": list(tile["min"]),
            "max": list(tile["max"]),
            "depth": tile["depth"],
        }

    meta_path = os.path.join(output_dir, "meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f)

    print(f"Written {total_bytes / 1024 / 1024:.1f} MB in {len(tiles)} tiles + meta.json")

    # Print distribution
    sizes = sorted([len(t["stars"]) for t in tiles.values()])
    print(f"Stars/tile: min={sizes[0]}, median={sizes[len(sizes)//2]}, max={sizes[-1]}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <athyg_v33.csv> <output_dir>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
