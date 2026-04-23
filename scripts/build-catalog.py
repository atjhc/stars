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
import gzip
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

# Physical radius baked into the tile binary. Matches src/color.ts's
# starRadiusScene so the renderer can use it directly as an instance
# attribute (no B-V → temp derivation needed at runtime).
T_SUN = 5778
R_SUN_SCENE = 2.254e-8 * SCALE     # solar radius in scene units (~6.76e-8)


def radius_scene(absmag: float, ci: float) -> float:
    """Physical stellar radius in scene units via Stefan-Boltzmann."""
    lum = max(10 ** ((4.74 - absmag) / 2.5) if absmag < 20 else 0.001, 1e-6)
    ci_clamped = max(-0.4, min(2.0, ci))
    temp = 4600.0 * (1.0 / (0.92 * ci_clamped + 1.7) + 1.0 / (0.92 * ci_clamped + 0.62))
    r_solar = math.sqrt(lum) / (temp / T_SUN) ** 2
    return r_solar * R_SUN_SCENE


def f32(x: float) -> float:
    """Round a Python float to its Float32 representation. JSON serializes
    the result with enough decimal digits that JS's Float64 parse can
    recover the exact same Float32 value when uploaded to the GPU — so
    anchor positions (from notable.json) match the corresponding instance
    positions (from the tile binary) bit-for-bit. At Tau Ceti's ~11-unit
    world distance, a 4-decimal round introduces ~1 AU of error, which
    jitters as the camera orbits; this avoids that."""
    return struct.unpack("<f", struct.pack("<f", x))[0]

# Absolute-magnitude buckets. Each bucket gets its own tileset with its own
# runtime cull distance, chosen so that stars in the bucket stay visible
# (apparent mag ≤ NAKED_EYE_MAG) out to the cull distance. Bright stars have
# huge visibility radii but are rare, so the "bright" bucket is tiny enough
# to ship as a single always-loaded file (no spatial subdivision, no cull).
BRIGHT_ABSMAG = 0.0                # M < 0 → bright bucket
NAKED_EYE_MAG = 6.5                # below this apparent mag → visible

# Medium bucket cull distance: d = 10 pc · 10^((m - M)/5)
# For M=NAKED_EYE_MAG, distance where a star becomes invisible is 10 pc.
# The brightest medium star has M=BRIGHT_ABSMAG=0, so
#   d_max = 10 · 10^((6.5 - 0)/5) ≈ 199.5 pc.
# In scene units (SCALE=3 per pc): 199.5 · 3 ≈ 598.
MEDIUM_CULL_UNITS = round(10 * 10 ** ((NAKED_EYE_MAG - BRIGHT_ABSMAG) / 5) * SCALE)

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


def bprp_to_bv(bprp: float) -> float:
    """Convert Gaia BP-RP color to Johnson B-V (Riello et al. 2021 polynomial)."""
    bprp = max(-0.5, min(5.0, bprp))
    return -0.0085 + 0.4728 * bprp + 0.0847 * bprp**2 - 0.0102 * bprp**3


def brightness_byte(absmag: float) -> int:
    """The point vertex shader recovers absmag from this byte and computes
    apparent magnitude per-frame from the camera distance. Linear encoding
    (byte = (absmag + 10) * 10) covers M ∈ [-10, +15.5] at 0.1-mag resolution."""
    return max(0, min(255, round((absmag + 10.0) * 10.0)))


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


def open_csv(path: str):
    return gzip.open(path, "rt") if path.endswith(".gz") else open(path)


def iter_concatenated_rows(paths: list[str]):
    """AT-HYG ships its full catalog split across multiple files: part 1 has
    the CSV header, subsequent parts are pure data continuations. We must
    treat them as a single logical stream so DictReader sees one header."""
    def line_stream():
        for p in paths:
            with open_csv(p) as f:
                yield from f

    return csv.DictReader(line_stream())


def main(aug_path: str, out_dir: str, csv_paths: list[str]):
    with open(aug_path) as f:
        augmentations: dict = json.load(f)

    stars: list[dict] = []
    skipped = 0

    print(f"Reading {len(csv_paths)} file(s): {', '.join(csv_paths)}")
    for row in iter_concatenated_rows(csv_paths):
        try:
            d = row.get("dist", "").strip()
            if not d:
                skipped += 1
                continue
            dist = float(d)
            if dist < 0 or dist > MAX_DIST_PC or dist >= 100000:
                skipped += 1
                continue
            # Derive equatorial cartesian from ra/dec/dist directly rather
            # than using AT-HYG's `x0`/`y0`/`z0` columns, which are rounded
            # to 3 decimals of parsec (~4.8 AU precision) — coarser than
            # the separation of tight binaries like Alpha Cen A/B (~25 AU
            # apart), which then collapse to the same stored cartesian.
            # The `ra`/`dec` fields are preserved at 8-decimal precision,
            # so this recovers the real Hipparcos astrometry.
            ra_raw = row.get("ra", "").strip()
            dec_raw = row.get("dec", "").strip()
            if not (ra_raw and dec_raw):
                skipped += 1
                continue
            ra_rad = math.radians(float(ra_raw) * 15.0)
            dec_rad = math.radians(float(dec_raw))
            cos_dec = math.cos(dec_rad)
            cx = dist * cos_dec * math.cos(ra_rad)
            cy = dist * cos_dec * math.sin(ra_rad)
            cz = dist * math.sin(dec_rad)
            sx = cx * SCALE
            sy = cz * SCALE
            sz = -cy * SCALE

            # Data correction: AT-HYG stores Sol at (0.000005 pc, 0, 0) — a
            # ~1 AU offset from the heliocentric origin. Force Sol to (0,0,0)
            # so its point-cloud rendering aligns with the notable billboard.
            # See docs/data-corrections.md.
            proper = row.get("proper", "").strip()
            if proper == "Sol":
                sx = sy = sz = 0.0

            mag = float(row.get("mag", "").strip() or 10.0)
            absmag = float(row.get("absmag", "").strip() or 10.0)
            ci = float(row.get("ci", "").strip() or 0.656)

            key = get_key(row)
            # Proper-name augmentation entries win over catalog-key ones so a
            # curated Vega entry takes precedence over a stale Gliese-keyed one.
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

            for extra in aug.get("aliases", []) or []:
                if extra and extra != primary and extra not in aliases:
                    aliases.insert(0, extra)

            # Manual position offset (AU, equatorial cartesian). Escape
            # hatch for edge cases where the catalog position needs a
            # nudge. See docs/data-corrections.md.
            offset_au = aug.get("pos_offset_au")
            if offset_au and len(offset_au) == 3:
                au_to_scene = (1.0 / 206265.0) * SCALE  # AU → pc → scene
                sx += offset_au[0] * au_to_scene
                sy += offset_au[1] * au_to_scene
                sz += offset_au[2] * au_to_scene

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
                "gaia_id": row.get("gaia", "").strip(),
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
    stars_by_name = {s["name"]: s for s in stars if s.get("name")}
    synth_count = 0
    AU_TO_PC = 1.0 / 206265.0
    for key, aug in augmentations.items():
        synth = aug.get("synthetic")
        if not synth or key in existing_keys:
            continue

        # Position can be specified three ways, in order of preference:
        # 1. parent + offset_au: offset (AU, equatorial cartesian) from
        #    a named primary star. Used for companions of wide binaries
        #    like Sirius B or 40 Eridani B/C where AT-HYG lacks the
        #    component entries — position stays consistent with the
        #    primary's real catalog astrometry.
        # 2. ra + dec + dist: standard astronomical coords, derived the
        #    same way as AT-HYG entries.
        # 3. x + y + z: explicit equatorial cartesian in parsecs.
        if "parent" in synth:
            parent = stars_by_name.get(synth["parent"])
            if not parent:
                print(f"WARNING: synthetic {key!r} parent {synth['parent']!r} not found; skipping", file=sys.stderr)
                continue
            # Recover the parent's equatorial-cartesian coords from its
            # scene coords (inverse of the sx/sy/sz swap below), offset
            # in AU, then let the normal swap re-derive scene coords.
            pcx = parent["sx"] / SCALE
            pcy = -parent["sz"] / SCALE
            pcz = parent["sy"] / SCALE
            offset = synth.get("offset_au", [0, 0, 0])
            cx = pcx + offset[0] * AU_TO_PC
            cy = pcy + offset[1] * AU_TO_PC
            cz = pcz + offset[2] * AU_TO_PC
        elif "ra" in synth and "dec" in synth and "dist" in synth:
            ra_rad = math.radians(float(synth["ra"]) * 15.0)
            dec_rad = math.radians(float(synth["dec"]))
            d = float(synth["dist"])
            cos_d = math.cos(dec_rad)
            cx = d * cos_d * math.cos(ra_rad)
            cy = d * cos_d * math.sin(ra_rad)
            cz = d * math.sin(dec_rad)
        else:
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

    # Inject cluster members from Hunt & Reffert (2023) astrometry.
    # Stars in the membership list that aren't already in AT-HYG are added
    # as tier-2 point-cloud entries so clusters appear visually complete.
    astro_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "data", "cluster-members", "hunt2023-astro.json",
    )
    if os.path.exists(astro_path):
        with open(astro_path) as f:
            astro_data = json.load(f)
        existing_gaia = {s["gaia_id"] for s in stars if s.get("gaia_id")}
        cluster_synth = 0
        for gaia_id, info in astro_data.items():
            if gaia_id in existing_gaia:
                continue
            plx = info.get("plx")
            if not plx or plx <= 0.1:
                continue
            dist = 1000.0 / plx
            if dist > MAX_DIST_PC or dist < 0:
                continue
            ra_rad = math.radians(info["ra"])
            dec_rad = math.radians(info["dec"])
            cos_dec = math.cos(dec_rad)
            x0 = dist * cos_dec * math.cos(ra_rad)
            y0 = dist * cos_dec * math.sin(ra_rad)
            z0 = dist * math.sin(dec_rad)
            sx = x0 * SCALE
            sy = z0 * SCALE
            sz = -y0 * SCALE
            gmag = info.get("gmag", 15.0)
            bprp = info.get("bprp", 0.8)
            ci = bprp_to_bv(bprp)
            absmag = gmag - 5 * math.log10(dist / 10.0)
            stars.append({
                "sx": sx, "sy": sy, "sz": sz,
                "dist": dist, "mag": gmag, "absmag": absmag, "ci": ci,
                "spect": "", "key": f"Gaia DR3 {gaia_id}",
                "gaia_id": gaia_id, "name": None, "aliases": [],
                "tier": 2, "wikipedia": None, "notes": None,
                "system": None, "synthetic": True,
            })
            cluster_synth += 1
        print(f"Injected {cluster_synth} synthetic cluster members from Hunt & Reffert")
    else:
        print("No hunt2023-astro.json found; skipping synthetic cluster members")

    # Resolve star clusters (data/clusters.json). For each cluster, compute
    # the centroid from its seed stars (looked up by proper name in the
    # loaded catalog), then find every catalog star within `radius_pc` of
    # that centroid and assign them to the cluster as its `system`. Cluster
    # membership overrides any prior system assignment (clusters dominate
    # binary systems for label collapse purposes).
    data_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    clusters_path = os.path.join(data_dir, "data", "clusters.json")
    members_path = os.path.join(data_dir, "data", "cluster-members", "hunt2023.json")
    cluster_meta: dict[str, dict] = {}
    if os.path.exists(clusters_path):
        with open(clusters_path) as f:
            clusters_raw = json.load(f)

        # Load Gaia DR3 membership from Hunt & Reffert (2023) if available.
        # Falls back to spatial-radius heuristic if the membership file is
        # missing, but precise membership is strongly preferred.
        gaia_members: dict[str, set[str]] = {}
        if os.path.exists(members_path):
            with open(members_path) as f:
                raw_members = json.load(f)
            for cname, ids in raw_members.items():
                gaia_members[cname] = set(ids)
            print(f"Loaded cluster membership: {', '.join(f'{k}={len(v)}' for k,v in gaia_members.items())}")

        stars_by_gaia: dict[str, dict] = {}
        for s in stars:
            gid = s.get("gaia_id", "")
            if gid:
                stars_by_gaia[gid] = s

        for cname, cdef in clusters_raw.items():
            member_ids = gaia_members.get(cname)
            sum_x = sum_y = sum_z = 0.0
            member_count = 0

            if member_ids:
                # Precise membership via Gaia DR3 source IDs, supplemented
                # by hand-curated seed stars (bright stars often have poor
                # Gaia astrometry and get excluded from automated clustering).
                stars_by_name = {s["name"]: s for s in stars if s.get("name")}
                seed_names = set(cdef.get("seed_stars", []))
                for s in stars:
                    gid = s.get("gaia_id", "")
                    is_gaia_member = gid and gid in member_ids
                    is_seed = s.get("name") in seed_names
                    if not is_gaia_member and not is_seed:
                        continue
                    s["system"] = cname
                    sum_x += s["sx"]
                    sum_y += s["sy"]
                    sum_z += s["sz"]
                    member_count += 1
            else:
                # Fallback: spatial radius around seed star centroid.
                stars_by_name = {s["name"]: s for s in stars if s.get("name")}
                seeds = [stars_by_name.get(n) for n in cdef.get("seed_stars", [])]
                seeds = [s for s in seeds if s]
                if not seeds:
                    print(f"WARNING: cluster {cname!r} has no resolvable seed stars; skipping", file=sys.stderr)
                    continue
                cx = sum(s["sx"] for s in seeds) / len(seeds)
                cy = sum(s["sy"] for s in seeds) / len(seeds)
                cz = sum(s["sz"] for s in seeds) / len(seeds)
                r = cdef["radius_pc"] * SCALE
                r_sq = r * r
                for s in stars:
                    dx, dy, dz = s["sx"] - cx, s["sy"] - cy, s["sz"] - cz
                    if dx * dx + dy * dy + dz * dz > r_sq:
                        continue
                    s["system"] = cname
                    sum_x += s["sx"]
                    sum_y += s["sy"]
                    sum_z += s["sz"]
                    member_count += 1

            if member_count > 0:
                cx = sum_x / member_count
                cy = sum_y / member_count
                cz = sum_z / member_count
            else:
                cx = cy = cz = 0.0

            cluster_meta[cname] = {
                "kind": "cluster",
                "type": cdef.get("type", "open"),
                "aliases": cdef.get("aliases", []),
                "wikipedia": cdef.get("wikipedia"),
                "notes": cdef.get("notes"),
                "centroid": [round(cx, 4), round(cy, 4), round(cz, 4)],
            }
            src = "Gaia DR3" if member_ids else "spatial"
            print(f"Cluster {cname!r}: {member_count} members ({src})")

    # Promote every named member of a multi-star (binary/trinary) system to
    # tier-0. Cluster members are NOT mass-promoted — only members that
    # already independently qualify as tier-0 (IAU proper name + bright)
    # stay notable; the rest stream in as tier-1 when their tile loads.
    members_by_system: dict[str, list[dict]] = defaultdict(list)
    for s in stars:
        if s.get("system"):
            members_by_system[s["system"]].append(s)
    for sys_name, sys_members in members_by_system.items():
        if sys_name in cluster_meta:
            continue
        if not any(m["tier"] == 0 for m in sys_members):
            continue
        for m in sys_members:
            if m["tier"] == 2 and not m.get("name"):
                continue
            if m["tier"] != 0:
                m["tier"] = 0

    min_xyz = [min(s["s" + a] for s in stars) for a in "xyz"]
    max_xyz = [max(s["s" + a] for s in stars) for a in "xyz"]
    half = max(max_xyz[i] - min_xyz[i] for i in range(3)) / 2 * 1.01
    cnt = [(min_xyz[i] + max_xyz[i]) / 2 for i in range(3)]
    print(f"Bounds: ({min_xyz[0]:.0f},{min_xyz[1]:.0f},{min_xyz[2]:.0f}) to ({max_xyz[0]:.0f},{max_xyz[1]:.0f},{max_xyz[2]:.0f})")

    # Split stars into brightness buckets. The bright bucket (M < 0) is small
    # and visible out to the full catalog radius, so it ships as a single
    # always-loaded file. The medium bucket (M >= 0) is octree-tiled with the
    # distance-based streaming pipeline.
    bright_stars = [s for s in stars if s["absmag"] < BRIGHT_ABSMAG]
    medium_stars = [s for s in stars if s["absmag"] >= BRIGHT_ABSMAG]
    print(f"Bucket split: bright={len(bright_stars)}  medium={len(medium_stars)}")

    tiles: dict = {}

    # Bright bucket: one flat tile, path key "bright".
    tiles["bright"] = {
        "stars": bright_stars,
        "min": (min_xyz[0], min_xyz[1], min_xyz[2]),
        "max": (max_xyz[0], max_xyz[1], max_xyz[2]),
        "depth": 0,
        "bucket": "bright",
    }

    # Medium bucket: octree as before.
    print(f"Building medium octree (max {MAX_STARS_PER_TILE} stars/tile, max depth {MAX_DEPTH})...")
    root = OctreeNode(
        tuple(cnt[i] - half for i in range(3)),
        tuple(cnt[i] + half for i in range(3)),
    )
    for s in medium_stars:
        root.add(s)
    root.build()
    med_tiles: dict = {}
    root.collect(med_tiles)
    for path, tile in med_tiles.items():
        tile["bucket"] = "medium"
        tiles[path] = tile
    print(f"Generated {len(tiles)} tiles total (bright: 1, medium: {len(med_tiles)})")

    os.makedirs(out_dir, exist_ok=True)

    meta = {
        "tileCount": len(tiles),
        "totalStars": len(stars),
        "bytesPerStar": 20,
        "format": "x:f32, y:f32, z:f32, brightness:u8, r:u8, g:u8, b:u8, radius:f32",
        "labelTierVisibility": {
            "0": NOTABLE_VISIBILITY_UNITS,
            "1": NAMED_VISIBILITY_UNITS,
        },
        # cullDist: null means always-loaded (bright bucket). Otherwise a
        # scene-unit distance at which the tile's bounding sphere must be
        # closer than the camera for it to stream in.
        "buckets": {
            "bright": {"cullDist": None},
            "medium": {"cullDist": MEDIUM_CULL_UNITS},
        },
        "bounds": {
            "min": [cnt[i] - half for i in range(3)],
            "max": [cnt[i] + half for i in range(3)],
        },
        "tiles": {},
    }

    notable: list[dict] = []
    # Flat global search index over every named (tier 0 or 1) star. Short
    # field names keep the JSON payload small; the runtime fetches it once
    # at boot and treats it as a plain POJO array.
    search_index: list[dict] = []
    systems_members: dict[str, list] = defaultdict(list)
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
            rscene = radius_scene(s["absmag"], s["ci"])
            # 20 bytes: pos (12) + brightness byte (1) + color rgb (3) +
            # radius f32 (4). The renderer uses radius directly as an
            # instance attribute for physical angular-size computation.
            buf.extend(struct.pack("<fff", s["sx"], s["sy"], s["sz"]))
            buf.extend(struct.pack("BBBB", br, r, g, b))
            buf.extend(struct.pack("<f", rscene))

            has_augmentation = s.get("wikipedia") or s.get("notes")
            if s["tier"] >= 2 and not has_augmentation:
                continue
            if s["tier"] >= 2:
                # Augmented tier-2 stars: add to search index but not label rows
                search_entry: dict = {
                    "n": s["name"],
                    "t": path,
                    "i": i,
                    "p": [f32(s["sx"]), f32(s["sy"]), f32(s["sz"])],
                    "mg": round(s["mag"], 2),
                    "M": round(s["absmag"], 2),
                    "d": round(s["dist"], 4),
                }
                if s["spect"]:
                    search_entry["sp"] = s["spect"]
                if s["aliases"]:
                    search_entry["a"] = s["aliases"]
                if s["system"]:
                    search_entry["sy"] = s["system"]
                search_index.append(search_entry)
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
                    "pos": [f32(s["sx"]), f32(s["sy"]), f32(s["sz"])],
                })

            search_entry: dict = {
                "n": s["name"],
                "t": path,
                "i": i,
                "p": [f32(s["sx"]), f32(s["sy"]), f32(s["sz"])],
                "mg": round(s["mag"], 2),
                "M": round(s["absmag"], 2),
                "d": round(s["dist"], 4),
            }
            if s["spect"]:
                search_entry["sp"] = s["spect"]
            if s["aliases"]:
                search_entry["a"] = s["aliases"]
            if s["system"]:
                search_entry["sy"] = s["system"]
            search_index.append(search_entry)

            if s["system"]:
                systems_members[s["system"]].append({"tile": path, "i": i, "name": s["name"]})

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
            "bucket": tile["bucket"],
            "labelCounts": labels_in_tile,
        }

    # Assemble the new systems.json shape: every system entry carries its
    # members PLUS optional top-level metadata (wikipedia, notes, kind,
    # aliases). Clusters have all the metadata; binary systems typically
    # have only members.
    systems: dict[str, dict] = {}
    for name, members in systems_members.items():
        entry: dict = {"members": members}
        meta_for = cluster_meta.get(name)
        if meta_for:
            entry.update({k: v for k, v in meta_for.items() if v is not None})
        systems[name] = entry
    # Ensure every cluster has an entry even if no named members resolved.
    for cname, cmeta in cluster_meta.items():
        if cname not in systems:
            systems[cname] = {"members": [], **{k: v for k, v in cmeta.items() if v is not None}}

    # Emit one synthetic search entry per cluster so "Pleiades" and "M45"
    # return the cluster directly (no per-member dedup needed).
    for cname, cmeta in cluster_meta.items():
        centroid = cmeta["centroid"]
        search_index.append({
            "n": cname,
            "k": "c",
            "sy": cname,
            "p": centroid,
            "mg": 0,
            "M": 0,
            "d": 0,
            "a": cmeta.get("aliases") or [],
        })

    # Nebulae: load data/nebulae.json, convert galactic Cartesian positions
    # to scene coordinates, and add to the search index.
    nebulae_path = os.path.join(data_dir, "data", "nebulae.json")
    nebulae_count = 0
    if os.path.exists(nebulae_path):
        with open(nebulae_path) as f:
            nebulae_raw = json.load(f)
        # Galactic → equatorial rotation matrix (same as in dust.ts)
        import numpy as np
        ra_ngp = np.radians(192.85948)
        dec_ngp = np.radians(27.12835)
        l_ncp = np.radians(122.93192)
        cos_ra, sin_ra = np.cos(ra_ngp), np.sin(ra_ngp)
        cos_dec, sin_dec = np.cos(dec_ngp), np.sin(dec_ngp)
        cos_l, sin_l = np.cos(l_ncp), np.sin(l_ncp)
        R = np.array([
            [-sin_ra*sin_l - cos_ra*sin_dec*cos_l,  sin_ra*cos_l - cos_ra*sin_dec*sin_l,  cos_ra*cos_dec],
            [ cos_ra*sin_l - sin_ra*sin_dec*cos_l, -cos_ra*cos_l - sin_ra*sin_dec*sin_l,  sin_ra*cos_dec],
            [ cos_dec*cos_l,                         cos_dec*sin_l,                         sin_dec       ]
        ])
        P = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]])
        M = P @ R
        for nname, ndef in nebulae_raw.items():
            gal = np.array(ndef["pos_pc"])
            scene_pos = (M @ gal) * SCALE
            search_index.append({
                "n": nname,
                "k": "n",
                "p": [round(float(scene_pos[0]), 2), round(float(scene_pos[1]), 2), round(float(scene_pos[2]), 2)],
                "mg": 0, "M": 0,
                "d": round(float(np.linalg.norm(gal)), 1),
                "a": ndef.get("aliases", []),
            })
            nebulae_count += 1
        print(f"Nebulae:  {nebulae_count} in search index")
        # Write nebulae with baked scene positions for runtime labels
        nebulae_out = {}
        for nname, ndef in nebulae_raw.items():
            gal = np.array(ndef["pos_pc"])
            scene_pos = (M @ gal) * SCALE
            nebulae_out[nname] = {
                **ndef,
                "scene_pos": [round(float(scene_pos[0]), 2), round(float(scene_pos[1]), 2), round(float(scene_pos[2]), 2)],
                "dist_pc": round(float(np.linalg.norm(gal)), 1),
            }
        with open(os.path.join(out_dir, "nebulae.json"), "w") as f:
            json.dump(nebulae_out, f)

    # Black holes: convert RA/Dec to scene coordinates
    bh_path = os.path.join(data_dir, "data", "blackholes.json")
    bh_count = 0
    if os.path.exists(bh_path):
        with open(bh_path) as f:
            bh_raw = json.load(f)
        bh_out = {}
        for bname, bdef in bh_raw.items():
            ra_rad = math.radians(bdef["ra"])
            dec_rad = math.radians(bdef["dec"])
            dist = bdef["dist_pc"]
            x = dist * math.cos(dec_rad) * math.cos(ra_rad)
            y = dist * math.cos(dec_rad) * math.sin(ra_rad)
            z = dist * math.sin(dec_rad)
            sx, sy, sz = x * SCALE, z * SCALE, -y * SCALE
            scene_pos = [round(sx, 2), round(sy, 2), round(sz, 2)]
            search_index.append({
                "n": bname, "k": "b",
                "p": scene_pos,
                "mg": 0, "M": 0,
                "d": round(dist, 1),
                "a": bdef.get("aliases", []),
            })
            bh_out[bname] = {**bdef, "scene_pos": scene_pos}
            bh_count += 1
        with open(os.path.join(out_dir, "blackholes.json"), "w") as f:
            json.dump(bh_out, f)
        print(f"Black holes: {bh_count} in search index")

    # Neutron stars: same RA/Dec → scene transform. Tagged as k="ns"
    # in the search index so the runtime can dispatch to the dedicated
    # neutron-star handler (labels + lensing). Either "ins" (isolated
    # neutron star, Magnificent Seven style) or "pulsar" in data.
    ns_path = os.path.join(data_dir, "data", "neutronstars.json")
    ns_count = 0
    if os.path.exists(ns_path):
        with open(ns_path) as f:
            ns_raw = json.load(f)
        ns_out = {}
        for nsname, nsdef in ns_raw.items():
            ra_rad = math.radians(nsdef["ra"])
            dec_rad = math.radians(nsdef["dec"])
            dist = nsdef["dist_pc"]
            x = dist * math.cos(dec_rad) * math.cos(ra_rad)
            y = dist * math.cos(dec_rad) * math.sin(ra_rad)
            z = dist * math.sin(dec_rad)
            sx, sy, sz = x * SCALE, z * SCALE, -y * SCALE
            scene_pos = [round(sx, 2), round(sy, 2), round(sz, 2)]
            search_index.append({
                "n": nsname, "k": "ns",
                "p": scene_pos,
                "mg": 0, "M": 0,
                "d": round(dist, 1),
                "a": nsdef.get("aliases", []),
            })
            ns_out[nsname] = {**nsdef, "scene_pos": scene_pos}
            ns_count += 1
        with open(os.path.join(out_dir, "neutronstars.json"), "w") as f:
            json.dump(ns_out, f)
        print(f"Neutron stars: {ns_count} in search index")

    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f)
    with open(os.path.join(out_dir, "notable.json"), "w") as f:
        json.dump(notable, f)
    with open(os.path.join(out_dir, "systems.json"), "w") as f:
        json.dump(systems, f)
    with open(os.path.join(out_dir, "names.json"), "w") as f:
        json.dump(search_index, f, separators=(",", ":"))

    # Constellations: copy data/constellations.json into the tile output dir
    # so it ships alongside the rest of the catalog. Validate every star
    # reference resolves to a known notable name; warn on any that don't.
    cons_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "constellations.json")
    constellations = {}
    cons_lines = 0
    if os.path.exists(cons_path):
        with open(cons_path) as f:
            constellations = json.load(f)
        notable_names = {s["name"] for s in notable}
        unresolved = set()
        for cname, cdata in constellations.items():
            for a, b in cdata.get("lines", []):
                if a not in notable_names: unresolved.add(a)
                if b not in notable_names: unresolved.add(b)
                cons_lines += 1
        if unresolved:
            print(f"WARNING: {len(unresolved)} unresolved constellation star refs: {sorted(unresolved)}", file=sys.stderr)
        with open(os.path.join(out_dir, "constellations.json"), "w") as f:
            json.dump(constellations, f)

    print(f"Geometry: {total_bin_bytes / 1024 / 1024:.1f} MB across {len(tiles)} tiles")
    print(f"Labels:   {total_lbl_bytes / 1024 / 1024:.2f} MB across {tiles_with_labels} tile label files")
    print(f"Notable:  {len(notable)} tier-0 stars")
    print(f"Search:   {len(search_index)} named stars in names.json ({os.path.getsize(os.path.join(out_dir, 'names.json')) / 1024:.0f} KB)")
    print(f"Systems:  {len(systems)} groupings")
    print(f"Constellations: {len(constellations)} ({cons_lines} lines)")

    sizes = sorted(len(t["stars"]) for t in tiles.values())
    print(f"Stars/tile: min={sizes[0]}, median={sizes[len(sizes)//2]}, max={sizes[-1]}")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(f"Usage: {sys.argv[0]} <augmentations.json> <output_dir> <athyg_v33.csv[.gz]>...", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
