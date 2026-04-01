#!/usr/bin/env python3
"""
Extract the nearest stars from the HYG v4.2 database into a JSON file
for the stellar neighborhood viewer.

Usage:
    # Download the HYG database first:
    curl -L -o hyg_v42.csv.gz \
      "https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v42.csv.gz"
    gunzip hyg_v42.csv.gz

    # Run the extraction (with augmentations):
    python3 scripts/extract-stars.py hyg_v42.csv src/stars.json data/augmentations.json

Data source: https://codeberg.org/astronexus/hyg (CC-BY-SA 4.0)

Star naming hierarchy:
    1. IAU proper name (e.g., "Sirius", "Proxima Centauri")
       - Component letters appended only if the same proper name appears
         on multiple components in a system (e.g., "p Eridani A/B")
       - Unique proper names kept as-is (e.g., "Toliman", "Rigil Kentaurus")
    2. Inherited proper name + component letter for secondaries without
       their own proper name (e.g., "Sirius B", "Ross 614 B")
    3. Bayer/Flamsteed designation, parsed to readable form
       (e.g., "61 Cygni A", "Epsilon Indi", "Tau Ceti")
       - Component letters appended for multi-star systems
    4. Gliese catalog ID, which already includes component letters
       (e.g., "Gl 65A", "GJ 1061")
    5. Hipparcos catalog ID (e.g., "HIP 82724")
    6. Henry Draper catalog ID (e.g., "HD 265866")
    7. HYG database ID as last resort (e.g., "HYG 12345")
"""

import csv
import json
import re
import sys
from collections import defaultdict

STAR_COUNT = 300

# IAU constellation abbreviations to Latin genitive form
CON_NAMES = {
    "And": "Andromedae", "Ant": "Antliae", "Aps": "Apodis", "Aqr": "Aquarii",
    "Aql": "Aquilae", "Ara": "Arae", "Ari": "Arietis", "Aur": "Aurigae",
    "Boo": "Bootis", "Cae": "Caeli", "Cam": "Camelopardalis", "Cnc": "Cancri",
    "CVn": "Canum Venaticorum", "CMa": "Canis Majoris", "CMi": "Canis Minoris",
    "Cap": "Capricorni", "Car": "Carinae", "Cas": "Cassiopeiae", "Cen": "Centauri",
    "Cep": "Cephei", "Cet": "Ceti", "Cha": "Chamaeleontis", "Cir": "Circini",
    "Col": "Columbae", "Com": "Comae Berenices", "CrA": "Coronae Australis",
    "CrB": "Coronae Borealis", "Crv": "Corvi", "Crt": "Crateris", "Cru": "Crucis",
    "Cyg": "Cygni", "Del": "Delphini", "Dor": "Doradus", "Dra": "Draconis",
    "Equ": "Equulei", "Eri": "Eridani", "For": "Fornacis", "Gem": "Geminorum",
    "Gru": "Gruis", "Her": "Herculis", "Hor": "Horologii", "Hya": "Hydrae",
    "Hyi": "Hydri", "Ind": "Indi", "Lac": "Lacertae", "Leo": "Leonis",
    "LMi": "Leonis Minoris", "Lep": "Leporis", "Lib": "Librae", "Lup": "Lupi",
    "Lyn": "Lyncis", "Lyr": "Lyrae", "Men": "Mensae", "Mic": "Microscopii",
    "Mon": "Monocerotis", "Mus": "Muscae", "Nor": "Normae", "Oct": "Octantis",
    "Oph": "Ophiuchi", "Ori": "Orionis", "Pav": "Pavonis", "Peg": "Pegasi",
    "Per": "Persei", "Phe": "Phoenicis", "Pic": "Pictoris", "Psc": "Piscium",
    "PsA": "Piscis Austrini", "Pup": "Puppis", "Pyx": "Pyxidis", "Ret": "Reticuli",
    "Sge": "Sagittae", "Sgr": "Sagittarii", "Sco": "Scorpii", "Scl": "Sculptoris",
    "Sct": "Scuti", "Ser": "Serpentis", "Sex": "Sextantis", "Tau": "Tauri",
    "Tel": "Telescopii", "Tri": "Trianguli", "TrA": "Trianguli Australis",
    "Tuc": "Tucanae", "UMa": "Ursae Majoris", "UMi": "Ursae Minoris",
    "Vel": "Velorum", "Vir": "Virginis", "Vol": "Volantis", "Vul": "Vulpeculae",
}

# Bayer Greek letter abbreviations to full names
GREEK = {
    "Alp": "Alpha", "Bet": "Beta", "Gam": "Gamma", "Del": "Delta",
    "Eps": "Epsilon", "Zet": "Zeta", "Eta": "Eta", "The": "Theta",
    "Iot": "Iota", "Kap": "Kappa", "Lam": "Lambda", "Mu": "Mu",
    "Nu": "Nu", "Xi": "Xi", "Omi": "Omicron", "Pi": "Pi",
    "Rho": "Rho", "Sig": "Sigma", "Tau": "Tau", "Ups": "Upsilon",
    "Phi": "Phi", "Chi": "Chi", "Psi": "Psi", "Ome": "Omega",
}

COMP_LETTER = {"1": " A", "2": " B", "3": " C", "4": " D", "5": " E", "6": " F"}


def parse_bf(bf: str) -> str | None:
    """Parse Bayer/Flamsteed designation like '9Alp CMa' or '61    Cyg' into readable form."""
    bf = bf.strip()
    if not bf:
        return None

    # Bayer: optional flamsteed number, greek abbreviation, optional numeric suffix, constellation
    m = re.match(r"^(\d+)?\s*([A-Za-z]{2,3})(\d*)?\s*([A-Z][A-Za-z]{1,2})$", bf)
    if m:
        greek_abbr, num_suffix, con_abbr = m.group(2), m.group(3), m.group(4)
        greek = GREEK.get(greek_abbr)
        if greek:
            con = CON_NAMES.get(con_abbr, con_abbr)
            name = greek
            if num_suffix:
                name += f" {num_suffix}"
            return f"{name} {con}"
        return None

    # Flamsteed-only: "61    Cyg"
    m = re.match(r"^(\d+)\s+([A-Z][A-Za-z]{1,2})$", bf)
    if m:
        flam, con_abbr = m.group(1), m.group(2)
        con = CON_NAMES.get(con_abbr, con_abbr)
        return f"{flam} {con}"

    return None


def extract(input_csv: str, output_json: str, augmentations_path: str | None = None) -> None:
    augmentations: dict = {}
    if augmentations_path:
        with open(augmentations_path) as f:
            augmentations = json.load(f)

    all_stars = []
    with open(input_csv) as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                dist = float(row["dist"])
            except ValueError:
                continue
            if dist >= 100000:
                continue
            all_stars.append(row)

    all_stars.sort(key=lambda r: float(r["dist"]))
    nearest = all_stars[:STAR_COUNT]
    by_id = {s["id"]: s for s in all_stars}

    # Find systems where multiple components share the same proper name
    systems: dict[str, list] = defaultdict(list)
    for s in nearest:
        base = s.get("base", "").strip()
        if base:
            systems[base].append(s)

    dup_proper_systems = set()
    for base, members in systems.items():
        propers = [m.get("proper", "").strip() for m in members if m.get("proper", "").strip()]
        if len(propers) != len(set(propers)):
            dup_proper_systems.add(base)

    def get_key(row: dict) -> str:
        """Stable identifier: Gliese ID, or HIP, or 'Sol'."""
        gl = row.get("gl", "").strip()
        if gl:
            return gl
        hip = row.get("hip", "").strip()
        if hip:
            return f"HIP {hip}"
        if row.get("proper", "").strip() == "Sol":
            return "Sol"
        return f"HYG {row['id']}"

    def comp_suffix(row: dict) -> str:
        comp = row.get("comp", "").strip()
        return COMP_LETTER.get(comp, f" {comp}")

    def is_multistar(row: dict) -> bool:
        return row.get("base", "").strip() != ""

    def get_names(row: dict) -> tuple[str, list[str]]:
        """Walk the naming hierarchy once, returning (primary_name, aliases)."""
        multi = is_multistar(row)
        comp = row.get("comp", "").strip()
        base = row.get("base", "").strip()
        suffix = comp_suffix(row) if multi else ""
        candidates: list[str] = []

        # Proper name
        proper = row.get("proper", "").strip()
        if proper:
            if multi and base in dup_proper_systems:
                candidates.append(proper + suffix)
            else:
                candidates.append(proper)

        # Secondary components inherit primary's proper name
        if comp not in ("", "1"):
            primary_id = row.get("comp_primary", "").strip()
            primary_row = by_id.get(primary_id)
            if primary_row:
                pp = primary_row.get("proper", "").strip()
                if pp:
                    inherited = pp + comp_suffix(row)
                    if inherited not in candidates:
                        candidates.append(inherited)

        # Bayer/Flamsteed
        bf = parse_bf(row.get("bf", ""))
        if bf:
            bf_full = bf + suffix if multi else bf
            if bf_full not in candidates:
                candidates.append(bf_full)

        # Gliese (already includes component letter)
        gl = row.get("gl", "").strip()
        if gl and gl not in candidates:
            candidates.append(gl)

        # HIP
        hip = row.get("hip", "").strip()
        if hip:
            candidates.append(f"HIP {hip}")

        # HD
        hd = row.get("hd", "").strip()
        if hd:
            candidates.append(f"HD {hd}")

        if not candidates:
            return f"HYG {row['id']}", []

        return candidates[0], candidates[1:]

    results = []
    for row in nearest:
        try:
            ci = float(row["ci"]) if row["ci"] else 0.656
            key = get_key(row)
            name, aliases = get_names(row)
            aug = augmentations.get(key, {})

            # Augmentation name override replaces the primary name;
            # move the old name into aliases if it's not already there
            if aug.get("name"):
                old_name = name
                name = aug["name"]
                if old_name not in aliases and old_name != name:
                    aliases.insert(0, old_name)

            entry: dict = {
                "name": name,
                "x": float(row["x"]),
                "y": float(row["y"]),
                "z": float(row["z"]),
                "dist": float(row["dist"]),
                "mag": float(row["mag"]),
                "absmag": float(row["absmag"]),
                "ci": ci,
                "spect": row.get("spect", ""),
                "lum": float(row["lum"]) if row.get("lum") else 1.0,
            }
            if aliases:
                entry["aliases"] = aliases
            if aug.get("wikipedia"):
                entry["wikipedia"] = aug["wikipedia"]
            if aug.get("notes"):
                entry["notes"] = aug["notes"]
            results.append(entry)
        except (ValueError, KeyError):
            continue

    names = [s["name"] for s in results]
    dupes = set(n for n in names if names.count(n) > 1)
    if dupes:
        print(f"WARNING: Duplicate names: {dupes}", file=sys.stderr)

    with open(output_json, "w") as f:
        json.dump(results, f)

    fallbacks = sum(1 for s in results if s["name"].startswith(("HIP ", "HD ", "HYG ")))
    print(f"Extracted {len(results)} stars to {output_json} ({fallbacks} with catalog-only names)")


if __name__ == "__main__":
    if len(sys.argv) < 3 or len(sys.argv) > 4:
        print(f"Usage: {sys.argv[0]} <hyg_v42.csv> <output.json> [augmentations.json]", file=sys.stderr)
        sys.exit(1)
    aug_path = sys.argv[3] if len(sys.argv) == 4 else None
    extract(sys.argv[1], sys.argv[2], aug_path)
