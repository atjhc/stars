#!/usr/bin/env python3
"""Download astrometric data from VizieR for Hunt & Reffert (2023) cluster members.

Reads Gaia DR3 source IDs from data/cluster-members/hunt2023.json and queries
VizieR TAP for RA, Dec, parallax, magnitude, and color for each member.
Writes data/cluster-members/hunt2023-astro.json.
"""

import json
import os
import sys
import urllib.request
import urllib.parse
import csv
import io
import time

BATCH_SIZE = 200  # IDs per TAP query
TAP_URL = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"

def query_batch(gaia_ids: list[str]) -> list[dict]:
    ids_str = ",".join(f"'{gid}'" for gid in gaia_ids)
    query = f"""SELECT "GaiaDR3", "RA_ICRS", "DE_ICRS", "Plx", "Gmag", "BP-RP", "Prob"
FROM "J/A+A/673/A114/members"
WHERE "GaiaDR3" IN ({ids_str})"""

    post_data = urllib.parse.urlencode({
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "csv",
        "QUERY": query,
    }).encode("utf-8")
    req = urllib.request.Request(TAP_URL, data=post_data, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read().decode("utf-8")

    reader = csv.DictReader(io.StringIO(data))
    return list(reader)


def main():
    data_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hunt_path = os.path.join(data_dir, "data", "cluster-members", "hunt2023.json")
    out_path = os.path.join(data_dir, "data", "cluster-members", "hunt2023-astro.json")

    with open(hunt_path) as f:
        hunt = json.load(f)

    all_ids = set()
    for ids in hunt.values():
        all_ids.update(ids)
    all_ids = sorted(all_ids)
    print(f"Total unique Gaia IDs: {len(all_ids)}")

    astro: dict[str, dict] = {}
    batches = [all_ids[i:i + BATCH_SIZE] for i in range(0, len(all_ids), BATCH_SIZE)]
    for i, batch in enumerate(batches):
        print(f"  Batch {i + 1}/{len(batches)} ({len(batch)} IDs)...", end=" ", flush=True)
        try:
            rows = query_batch(batch)
            for r in rows:
                gid = r.get("GaiaDR3", "").strip()
                if not gid:
                    continue
                try:
                    entry: dict = {"ra": float(r["RA_ICRS"]), "dec": float(r["DE_ICRS"])}
                    if r.get("Plx"):
                        entry["plx"] = float(r["Plx"])
                    if r.get("Gmag"):
                        entry["gmag"] = float(r["Gmag"])
                    if r.get("BP-RP"):
                        entry["bprp"] = float(r["BP-RP"])
                    if r.get("Prob"):
                        entry["prob"] = float(r["Prob"])
                    astro[gid] = entry
                except (ValueError, KeyError):
                    pass
            print(f"{len(rows)} rows")
        except Exception as e:
            print(f"ERROR: {e}")
        if i < len(batches) - 1:
            time.sleep(1)  # rate limit

    print(f"\nTotal stars with astrometry: {len(astro)}")
    with_plx = sum(1 for v in astro.values() if v.get("plx") and v["plx"] > 0)
    print(f"With positive parallax: {with_plx}")

    with open(out_path, "w") as f:
        json.dump(astro, f, separators=(",", ":"))
    print(f"Wrote {out_path} ({os.path.getsize(out_path) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
