#!/usr/bin/env python3
"""
Extract notable stars beyond the billboard range (50 ly) from AT-HYG.
These are stars with IAU proper names that will be searchable and selectable
in the point cloud layer.

Usage:
    python3 scripts/extract-notable.py /path/to/athyg_v33.csv src/notable-stars.json
"""

import csv
import json
import math
import sys

SCALE = 3
MIN_DIST = 15.33  # parsecs (~50 ly) — billboard stars handle closer ones
MAX_DIST = 1000   # parsecs


def bv_to_rgb(ci: float) -> list[float]:
    """B-V to RGB, same algorithm as the main extraction."""
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

    avg = (r + g + b) / 3
    sat = 1.8
    r = min(1, max(0, avg + (r - avg) * sat))
    g = min(1, max(0, avg + (g - avg) * sat))
    b = min(1, max(0, avg + (b - avg) * sat))
    return [round(r, 3), round(g, 3), round(b, 3)]


def main(input_csv: str, output_json: str):
    stars = []

    with open(input_csv) as f:
        reader = csv.DictReader(f)
        for row in reader:
            proper = row.get("proper", "").strip()
            if not proper:
                continue

            try:
                dist = float(row.get("dist", "").strip())
            except (ValueError, TypeError):
                continue

            if dist < MIN_DIST or dist >= MAX_DIST:
                continue

            x0 = row.get("x0", "").strip()
            y0 = row.get("y0", "").strip()
            z0 = row.get("z0", "").strip()
            if not x0 or not y0 or not z0:
                continue

            mag_str = row.get("mag", "").strip()
            absmag_str = row.get("absmag", "").strip()
            ci_str = row.get("ci", "").strip()
            spect = row.get("spect", "").strip()

            mag = float(mag_str) if mag_str else 10.0
            absmag = float(absmag_str) if absmag_str else 10.0
            ci = float(ci_str) if ci_str else 0.656
            lum = 10 ** ((4.74 - absmag) / 2.5) if absmag < 20 else 0.001

            bayer = row.get("bayer", "").strip()
            flam = row.get("flam", "").strip()
            con = row.get("con", "").strip()
            hip = row.get("hip", "").strip()
            hd = row.get("hd", "").strip()
            hr = row.get("hr", "").strip()

            # Build aliases
            aliases = []
            if bayer and con:
                aliases.append(f"{bayer} {con}")
            if flam and con:
                aliases.append(f"{flam} {con}")
            if hip:
                aliases.append(f"HIP {hip}")
            if hd:
                aliases.append(f"HD {hd}")
            if hr:
                aliases.append(f"HR {hr}")

            entry = {
                "name": proper,
                "x": round(float(x0), 6),
                "y": round(float(y0), 6),
                "z": round(float(z0), 6),
                "dist": round(dist, 4),
                "mag": round(mag, 2),
                "absmag": round(absmag, 2),
                "ci": round(ci, 3),
                "spect": spect,
                "lum": round(lum, 4),
            }
            if aliases:
                entry["aliases"] = aliases

            stars.append(entry)

    stars.sort(key=lambda s: s["mag"])

    with open(output_json, "w") as f:
        json.dump(stars, f, indent=2)

    print(f"Extracted {len(stars)} notable stars to {output_json}")
    print(f"Brightest: {stars[0]['name']} (mag {stars[0]['mag']})")
    print(f"Faintest: {stars[-1]['name']} (mag {stars[-1]['mag']})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <athyg_v33.csv> <output.json>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
