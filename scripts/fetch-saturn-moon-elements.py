#!/usr/bin/env python3
"""Fetch J2000 Saturn-centered ecliptic Keplerian elements for Saturn's
moons from JPL HORIZONS and emit a JSON snippet ready to splice into
`data/planets.json`.

Why: the elements that were originally hand-curated for the inner
Saturnian moons mixed reference frames — inclinations referenced
Saturn's orbital plane (26.73°) and ascending nodes referenced
Saturn's equatorial frame, while the runtime treats every body's
Keplerian elements as J2000 ecliptic. Result: inner moons appeared
in independently-tilted planes instead of a single coplanar ring.

This script replaces those values with the actual J2000 ecliptic
elements (Saturn-body-centered) so they're internally consistent
with how Drake propagates them.

The fetched mean motion (N, deg/day) is converted to a per-century
rate for `L_deg[1]`. All other elements are point-in-time values
with zero rate — short-period precession (apsidal/nodal) isn't
modelled, same as Earth's other moons in this dataset.

Usage:
    python3 scripts/fetch-saturn-moon-elements.py [--write]

Without `--write` the script prints a preview diff. With `--write`
it edits `data/planets.json` in place (preserving the rest of each
moon's record).
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

# HORIZONS body IDs and the display names we use in data/planets.json.
MOONS = [
    ("Mimas",     "601"),
    ("Enceladus", "602"),
    ("Tethys",    "603"),
    ("Dione",     "604"),
    ("Rhea",      "605"),
    ("Titan",     "606"),
    ("Hyperion",  "607"),
    ("Iapetus",   "608"),
    ("Phoebe",    "609"),
]

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
J2000_START = "2000-01-01 12:00"
J2000_STOP = "2000-01-01 12:01"
DAYS_PER_CENTURY = 36525


def fetch_elements(body_id: str) -> dict:
    """Returns dict with EC, IN, OM, W, MA, N, A keys (HORIZONS names).

    OM (Ω) is longitude of ascending node, W (ω) is argument of
    pericenter, MA is mean anomaly. CENTER='500@699' means
    Saturn-body-centered (599 would be Saturn barycenter, but 699 is
    the planet itself; for moon orbits the planet is the right focus).
    """
    params = {
        "format": "text",
        "COMMAND": f"'{body_id}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'ELEMENTS'",
        "CENTER": "'500@699'",
        "START_TIME": f"'{J2000_START}'",
        "STOP_TIME": f"'{J2000_STOP}'",
        "STEP_SIZE": "'1'",
        "REF_SYSTEM": "'ICRF'",
        "REF_PLANE": "'ECLIPTIC'",
        "OUT_UNITS": "'AU-D'",
    }
    url = HORIZONS + "?" + urllib.parse.urlencode(params)
    body = urllib.request.urlopen(url, timeout=60).read().decode()
    soe = re.search(r"\$\$SOE(.+?)\$\$EOE", body, re.DOTALL)
    if not soe:
        raise RuntimeError(f"HORIZONS returned no SOE block for body {body_id}")
    block = soe.group(1).split("\n\n")[0]
    out = {}
    for key in ("EC", "IN", "OM", "W", "MA", "N", "A"):
        m = re.search(rf"\b{key}\s*=\s*([0-9.+\-Ee]+)", block)
        if not m:
            raise RuntimeError(f"missing {key} for body {body_id}\n--block--\n{block}")
        out[key] = float(m.group(1))
    return out


def to_drake_elements(h: dict) -> dict:
    """Convert HORIZONS Keplerian to Drake's `data/planets.json` schema.

    Drake stores `long_peri = Ω + ω` and `L = Ω + ω + M` (longitudes of
    pericenter and mean longitude — the JPL Approximate Positions
    convention). `L_deg[1]` is rate per Julian century.
    """
    long_node = h["OM"] % 360
    long_peri = (h["OM"] + h["W"]) % 360
    L = (h["OM"] + h["W"] + h["MA"]) % 360
    L_rate = h["N"] * DAYS_PER_CENTURY
    return {
        "a_au": [round(h["A"], 8), 0.0],
        "e": [round(h["EC"], 6), 0.0],
        "i_deg": [round(h["IN"], 4), 0.0],
        "L_deg": [round(L, 4), round(L_rate, 1)],
        "long_peri_deg": [round(long_peri, 4), 0.0],
        "long_node_deg": [round(long_node, 4), 0.0],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="edit data/planets.json in place")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    planets_path = os.path.join(root, "data", "planets.json")
    with open(planets_path) as f:
        planets = json.load(f)

    updates: dict[str, dict] = {}
    for name, body_id in MOONS:
        if name not in planets:
            print(f"skip   {name} (not in planets.json)", file=sys.stderr)
            continue
        h = fetch_elements(body_id)
        elems = to_drake_elements(h)
        updates[name] = elems
        old = planets[name]["elements"]
        print(f"\n{name} (HORIZONS body {body_id})")
        for k in ("a_au", "e", "i_deg", "long_node_deg", "long_peri_deg", "L_deg"):
            o = old[k]
            n = elems[k]
            print(f"  {k:18s} {o[0]:>12.4f} {o[1]:>14.3f}   →   {n[0]:>12.4f} {n[1]:>14.3f}")

    if args.write:
        for name, elems in updates.items():
            planets[name]["elements"] = elems
        with open(planets_path, "w") as f:
            json.dump(planets, f, indent=2)
        print(f"\nWrote {planets_path}")
    else:
        print("\n(dry run — pass --write to apply)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
