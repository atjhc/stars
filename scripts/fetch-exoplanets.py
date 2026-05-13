#!/usr/bin/env python3
"""Fetch confirmed exoplanets from the NASA Exoplanet Archive and join
them against the AT-HYG host-star catalog by Gaia DR3 source ID.

Filter to planets with both physical radius (pl_rade) and orbital
semi-major axis (pl_orbsmax) so the runtime always has enough to
draw a body and an orbit. Mass is kept when available for the detail
card but isn't required.

Output: dist/tiles/exoplanets.json — keyed by Gaia DR3 numeric ID
(matches the AT-HYG `gaia` column). The runtime looks up planets
by the focused host star's gaia_id.
"""

import csv
import gzip
import io
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ARCHIVE_TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"

REPO = Path(__file__).resolve().parent.parent
ATHYG_PARTS = [
    REPO / "vendor/athyg/data/athyg_v33-1.csv.gz",
    REPO / "vendor/athyg/data/athyg_v33-2.csv.gz",
]
OUTPUT = REPO / "dist/tiles/exoplanets.json"

# Columns pulled from the Exoplanet Archive's PSCompPars view (one row
# per planet, populated with the discovery team's preferred values).
ARCHIVE_COLUMNS = [
    "pl_name", "hostname", "gaia_dr3_id",
    "pl_rade", "pl_bmasse",
    "pl_orbsmax", "pl_orbeccen", "pl_orbper", "pl_orbincl", "pl_orblper",
    "pl_eqt",
    "disc_year", "discoverymethod",
]


def fetch_archive_rows() -> list[dict]:
    cols = ",".join(ARCHIVE_COLUMNS)
    where = "pl_rade is not null and pl_orbsmax is not null and gaia_dr3_id is not null"
    query = f"select {cols} from pscomppars where {where}"
    url = f"{ARCHIVE_TAP}?{urllib.parse.urlencode({'query': query, 'format': 'csv'})}"
    print(f"Querying Exoplanet Archive...", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=180) as resp:
        text = resp.read().decode("utf-8")
    rows = list(csv.DictReader(io.StringIO(text)))
    print(f"  {len(rows)} planets", file=sys.stderr)
    return rows


def names_for(row: dict) -> list[str]:
    """Same name-resolution priority as scripts/build-catalog.py's
    `get_names`. The runtime matches against star.name + star.aliases,
    so we have to emit the identical set of strings the build
    pipeline will surface in the catalog."""
    names: list[str] = []
    proper = (row.get("proper") or "").strip()
    if proper:
        names.append(proper)
    bayer = (row.get("bayer") or "").strip()
    flam = (row.get("flam") or "").strip()
    con = (row.get("con") or "").strip()
    if bayer and con:
        names.append(f"{bayer} {con}")
    if flam and con:
        names.append(f"{flam} {con}")
    gl = (row.get("gl") or "").strip()
    if gl:
        names.append(gl)
    hip = (row.get("hip") or "").strip()
    if hip:
        names.append(f"HIP {hip}")
    hd = (row.get("hd") or "").strip()
    if hd:
        names.append(f"HD {hd}")
    hr = (row.get("hr") or "").strip()
    if hr:
        names.append(f"HR {hr}")
    return names


def build_gaia_index() -> dict[str, list[str]]:
    """Map Gaia DR3 source ID → list of names the runtime might see
    (LabelRow.name + LabelRow.aliases). Used to surface a host's
    planets after the user selects the star, since the runtime catalog
    doesn't carry the Gaia ID itself."""
    gaia_to_names: dict[str, list[str]] = {}
    for path in ATHYG_PARTS:
        with gzip.open(path, "rt") as f:
            reader = csv.DictReader(f) if path == ATHYG_PARTS[0] else csv.DictReader(
                f, fieldnames=ATHYG_PARTS_FIELDNAMES
            )
            for row in reader:
                gaia = (row.get("gaia") or "").strip()
                if not gaia:
                    continue
                ns = names_for(row)
                if ns:
                    gaia_to_names[gaia] = ns
    return gaia_to_names


# Part 2 has no header — column order matches part 1.
ATHYG_PARTS_FIELDNAMES = [
    "id", "tyc", "gaia", "hyg", "hip", "hd", "hr", "gl", "bayer", "flam",
    "con", "proper", "ra", "dec", "pos_src", "dist", "x0", "y0", "z0",
    "dist_src", "mag", "absmag", "ci", "mag_src", "rv", "rv_src",
    "pm_ra", "pm_dec", "pm_src", "vx", "vy", "vz", "spect", "spect_src",
]


def composition_class(radius_re: float) -> str:
    """Loose mass-radius bin used to pick colour + render style.
    Boundaries follow the conventional Fulton-gap / Neptune-desert cuts
    rather than anything atmospheric-spectrum based."""
    if radius_re < 1.6:
        return "rocky"
    if radius_re < 3.5:
        return "superEarth"
    if radius_re < 8.0:
        return "neptune"
    return "gasGiant"


def to_float(s: str) -> float | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_int(s: str) -> int | None:
    f = to_float(s)
    return int(f) if f is not None else None


def strip_gaia_prefix(s: str) -> str:
    s = s.strip()
    return s.split()[-1] if s.lower().startswith("gaia dr3 ") else s


def main() -> None:
    gaia_to_names = build_gaia_index()
    print(f"  AT-HYG: {len(gaia_to_names)} stars with Gaia DR3 IDs", file=sys.stderr)

    archive_rows = fetch_archive_rows()

    by_gaia: dict[str, dict] = {}
    matched = 0
    for r in archive_rows:
        gaia = strip_gaia_prefix(r["gaia_dr3_id"])
        names = gaia_to_names.get(gaia)
        if not names:
            continue
        matched += 1
        radius_re = to_float(r["pl_rade"])
        if radius_re is None:
            continue
        planet = {
            "name": r["pl_name"],
            "radius_re": radius_re,
            "mass_me": to_float(r["pl_bmasse"]),
            "a_au": to_float(r["pl_orbsmax"]),
            "e": to_float(r["pl_orbeccen"]),
            "period_days": to_float(r["pl_orbper"]),
            "incl_deg": to_float(r["pl_orbincl"]),
            "lper_deg": to_float(r["pl_orblper"]),
            "eqt_k": to_float(r["pl_eqt"]),
            "class": composition_class(radius_re),
            "disc_year": to_int(r["disc_year"]),
            "disc_method": (r["discoverymethod"] or "").strip() or None,
        }
        entry = by_gaia.setdefault(gaia, {"host": r["hostname"], "planets": []})
        entry["planets"].append(planet)

    for entry in by_gaia.values():
        entry["planets"].sort(key=lambda p: (p["a_au"] is None, p["a_au"]))

    aliases: dict[str, str] = {}
    for gaia in by_gaia:
        for name in gaia_to_names[gaia]:
            aliases.setdefault(name, gaia)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump({"by_gaia": by_gaia, "aliases": aliases}, f, separators=(",", ":"))

    n_planets = sum(len(e["planets"]) for e in by_gaia.values())
    print(f"  matched {matched} planets to {len(by_gaia)} host stars "
          f"({len(aliases)} aliases); wrote {n_planets} planets to "
          f"{OUTPUT.relative_to(REPO)}", file=sys.stderr)


if __name__ == "__main__":
    main()
