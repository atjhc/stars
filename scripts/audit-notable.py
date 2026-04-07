#!/usr/bin/env python3
"""
Audit the tier-0 (notable) star set for metadata coverage.

Reads dist/tiles/notable.json + data/augmentations.json and reports which
notable stars are missing wikipedia links, aliases beyond the auto-generated
catalog IDs, or curator notes. Intended to generate a focused worklist for
filling gaps in data/augmentations.json.

Usage:
    python3 scripts/audit-notable.py [--json]

With --json, prints the gap list as a JSON array (useful for feeding into a
batch research workflow). Otherwise prints a human-readable summary.
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTABLE_PATH = ROOT / "dist" / "tiles" / "notable.json"
AUG_PATH = ROOT / "data" / "augmentations.json"


def load_json(path: Path):
    if not path.exists():
        print(f"error: {path} not found (run scripts/build-catalog.py first)", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def is_catalog_alias(alias: str) -> bool:
    """Bayer/Flamsteed/HIP/HD/HR/Gliese catalog designations — auto-generated from
    catalog columns, not curator-added. 'Aliases beyond catalog IDs' implies
    traditional names, variable-star designations, etc."""
    if not alias:
        return True
    prefixes = ("HIP ", "HD ", "HR ", "HYG ", "Gl ", "GJ ")
    if alias.startswith(prefixes):
        return True
    # Bayer forms like "Alp CMa" or "Alpha Canis Majoris"
    tokens = alias.split()
    bayer_abbr = {
        "Alp", "Bet", "Gam", "Del", "Eps", "Zet", "Eta", "The", "Iot", "Kap",
        "Lam", "Mu", "Nu", "Xi", "Omi", "Pi", "Rho", "Sig", "Tau", "Ups",
        "Phi", "Chi", "Psi", "Ome",
    }
    if len(tokens) == 2 and tokens[0] in bayer_abbr:
        return True
    if len(tokens) == 2 and tokens[0].isdigit():  # flamsteed "61 Cyg"
        return True
    return False


def audit(as_json: bool = False):
    notable = load_json(NOTABLE_PATH)
    augmentations = load_json(AUG_PATH)

    # Build a proper-name → augmentation-key index so we can check whether a
    # notable star has an augmentation entry (augmentations are keyed by
    # Gliese ID / HIP / "Sol", not by proper name).
    aug_by_name = {}
    for key, aug in augmentations.items():
        name = aug.get("name", "").strip()
        if name:
            aug_by_name[name] = (key, aug)

    gaps = []
    for star in notable:
        name = star.get("name", "").strip()
        aug_key, aug = aug_by_name.get(name, (None, {}))
        # also try the star's name directly as a key (e.g. if augmentations use
        # the proper name when there's no Gliese ID)
        if not aug_key:
            aug = augmentations.get(name, {})
            if aug:
                aug_key = name

        missing = []
        if not aug.get("wikipedia"):
            missing.append("wikipedia")
        if not aug.get("notes"):
            missing.append("notes")

        # Only flag missing traditional-alias when the star hasn't been
        # curated at all. A reviewed entry that legitimately has no
        # traditional names beyond its catalog designation is acceptable.
        if not aug:
            catalog_aliases = star.get("aliases", [])
            if not any(not is_catalog_alias(a) for a in catalog_aliases):
                missing.append("traditional-alias")

        if missing:
            gaps.append({
                "name": name,
                "mag": star.get("mag"),
                "dist_ly": round((star.get("dist") or 0) * 3.262, 1),
                "spect": star.get("spect", ""),
                "aug_key": aug_key,
                "missing": missing,
                "aliases": catalog_aliases,
            })

    gaps.sort(key=lambda g: (g["mag"] is None, g["mag"]))

    if as_json:
        json.dump(gaps, sys.stdout, indent=2)
        print()
        return

    total = len(notable)
    with_gaps = len(gaps)
    print(f"Notable stars: {total}")
    print(f"With gaps:     {with_gaps} ({with_gaps / total * 100:.0f}%)")
    print()

    missing_wiki = [g for g in gaps if "wikipedia" in g["missing"]]
    missing_notes = [g for g in gaps if "notes" in g["missing"]]
    missing_alias = [g for g in gaps if "traditional-alias" in g["missing"]]

    print(f"Missing wikipedia:         {len(missing_wiki)}")
    print(f"Missing notes:             {len(missing_notes)}")
    print(f"Missing traditional alias: {len(missing_alias)}")
    print()
    print("By star (sorted by apparent magnitude, brightest first):")
    print()

    for g in gaps:
        mag = f"mag {g['mag']:+.2f}" if g["mag"] is not None else "mag ?    "
        dist = f"{g['dist_ly']:6.1f} ly"
        miss = ", ".join(g["missing"])
        key = f"[{g['aug_key']}]" if g["aug_key"] else "[no aug entry]"
        print(f"  {mag}  {dist}  {g['name']:<28}  {key:<20}  missing: {miss}")


if __name__ == "__main__":
    audit(as_json=("--json" in sys.argv))
