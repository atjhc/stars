#!/usr/bin/env python3
"""
Extract the nearest stars from the HYG v4.2 database into a JSON file
for the stellar neighborhood viewer.

Usage:
    # Download the HYG database first:
    curl -L -o hyg_v42.csv.gz \
      "https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v42.csv.gz"
    gunzip hyg_v42.csv.gz

    # Run the extraction:
    python3 scripts/extract-stars.py hyg_v42.csv src/stars.json

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


def extract(input_csv: str, output_json: str) -> None:
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

    def comp_suffix(row: dict) -> str:
        comp = row.get("comp", "").strip()
        return COMP_LETTER.get(comp, f" {comp}")

    def is_multistar(row: dict) -> bool:
        return row.get("base", "").strip() != ""

    def get_name(row: dict) -> str:
        proper = row.get("proper", "").strip()
        comp = row.get("comp", "").strip()
        multi = is_multistar(row)
        base = row.get("base", "").strip()

        if proper:
            if multi and base in dup_proper_systems:
                return proper + comp_suffix(row)
            return proper

        # Secondary components inherit primary's proper name
        if comp not in ("", "1"):
            primary_id = row.get("comp_primary", "").strip()
            primary = by_id.get(primary_id)
            if primary:
                primary_proper = primary.get("proper", "").strip()
                if primary_proper:
                    return primary_proper + comp_suffix(row)

        bf = parse_bf(row.get("bf", ""))
        if bf:
            if multi:
                return bf + comp_suffix(row)
            return bf

        # Gliese catalog ID (already includes component letter)
        gl = row.get("gl", "").strip()
        if gl:
            return gl

        hip = row.get("hip", "").strip()
        if hip:
            return f"HIP {hip}"

        hd = row.get("hd", "").strip()
        if hd:
            return f"HD {hd}"

        return f"HYG {row['id']}"

    def get_aliases(row: dict, primary_name: str) -> list[str]:
        """Collect alternative designations not already used as the primary name."""
        aliases = []
        multi = is_multistar(row)
        suffix = comp_suffix(row) if multi else ""

        # Proper name (if not primary)
        proper = row.get("proper", "").strip()
        if proper and proper != primary_name:
            aliases.append(proper)

        # Inherited proper name for secondaries
        comp = row.get("comp", "").strip()
        if comp not in ("", "1"):
            primary_id = row.get("comp_primary", "").strip()
            primary = by_id.get(primary_id)
            if primary:
                pp = primary.get("proper", "").strip()
                if pp:
                    inherited = pp + COMP_LETTER.get(comp, f" {comp}")
                    if inherited != primary_name and inherited not in aliases:
                        aliases.append(inherited)

        # Bayer/Flamsteed
        bf = parse_bf(row.get("bf", ""))
        if bf:
            bf_full = bf + suffix if multi else bf
            if bf_full != primary_name and bf_full not in aliases:
                aliases.append(bf_full)

        # Gliese
        gl = row.get("gl", "").strip()
        if gl and gl != primary_name:
            aliases.append(gl)

        # HIP
        hip = row.get("hip", "").strip()
        if hip:
            hip_name = f"HIP {hip}"
            if hip_name != primary_name:
                aliases.append(hip_name)

        # HD
        hd = row.get("hd", "").strip()
        if hd:
            hd_name = f"HD {hd}"
            if hd_name != primary_name:
                aliases.append(hd_name)

        return aliases

    results = []
    for row in nearest:
        try:
            ci = float(row["ci"]) if row["ci"] else 0.656
            name = get_name(row)
            aliases = get_aliases(row, name)
            entry = {
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
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <hyg_v42.csv> <output.json>", file=sys.stderr)
        sys.exit(1)
    extract(sys.argv[1], sys.argv[2])
