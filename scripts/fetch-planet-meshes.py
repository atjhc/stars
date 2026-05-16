#!/usr/bin/env python3
"""Download and convert irregular-body shape models to Drake's runtime format.

Several small bodies in our planet set are nowhere near round and benefit
from real spacecraft-derived meshes instead of the triaxial-ellipsoid
approximation:

  - 433 Eros: Gaskell 2008 NEAR MSI shape model (Public Domain / CC0).
    https://sbn.psi.edu/pds/resource/doi/erosshape_1.1.html
  - Phobos:   Gaskell 2011 Viking + Phobos-2 shape model (Public Domain).
    https://sbn.psi.edu/pds/resource/phobosshape.html
  - Deimos:   Thomas 2000 Viking limb/control-point lat/lon/r grid
    (Public Domain). https://sbn.psi.edu/pds/shape-models/
  - Hyperion: Thomas 2007 Cassini limb-based shape, plate model
    derivative published as 30k-triangle OBJ (Public Domain).
    Hosted in PSI's small-bodies-node `sbn-psi/shape-models` GitHub
    repo (LFS-backed; fetch via `media.githubusercontent.com`).
  - Phoebe:   Gaskell 2013 Cassini ISS stereophotoclinometry vertex+facet
    shape model (Public Domain). PSI gaskell.phoebe.shape-model.

Inputs:
  - Eros/Phobos/Phoebe: vertex/facet TAB. Header line is either
    `nv nf` (Eros/Phobos) or just `nv` (Phoebe — second header with
    `nf` follows the vertex block). Then `i x y z` for nv vertices,
    then `i v1 v2 v3` for nf facets (1-indexed).
  - Deimos: lat/lon/radius rows on a 5° grid (37 × 73 = 2701). Coords
            are planetocentric, distance in km, lon -180..180.
  - Hyperion: Wavefront OBJ — `v x y z` then `f v1 v2 v3` (1-indexed,
              no `vt`/`vn`). Units km, planetocentric +Z = pole.

Output: `dist/tiles/planets/<name>.bin`, custom binary the runtime
parses with a single fetch + ArrayBuffer view:

  uint32 magic = 'DSHP' (0x50485344 little-endian)
  uint32 version = 1
  uint32 vertex_count
  uint32 index_count
  float32[vertex_count * 3]  // positions in km, body-fixed:
                             //   X = long equatorial axis
                             //   Y = intermediate equatorial
                             //   Z = rotation pole
                             // Runtime swaps Y/Z so mesh-local +Y is the
                             // pole, matching the existing qBase basis.
  uint32[index_count]        // CCW triangle indices

No UVs or normals shipped — runtime sets a zero UV attribute (texture
is a 1×1 fallback for these bodies anyway) and computes vertex normals
once at load via Three.js' BufferGeometry.computeVertexNormals().
"""

import os
import struct
import sys
import urllib.request

PSI = "https://sbnarchive.psi.edu/pds4/non_mission"
SBN_OBJ = "https://media.githubusercontent.com/media/sbn-psi/shape-models/master/originals"

# (output basename, source URL, parser kind)
MESHES = [
    ("eros",     f"{PSI}/gaskell.ast-eros.shape-model_V1_1/data/vertex/ver64q.tab",    "gaskell"),
    ("phobos",   f"{PSI}/gaskell.phobos.shape-model/data/phobos_ver64q.tab",           "gaskell"),
    ("phoebe",   f"{PSI}/gaskell.phoebe.shape-model/data/phoebe_ver64q.tab",           "gaskell"),
    ("deimos",   f"{PSI}/ast-sat.thomas.shape-models_V1_0/data/m2deimos.tab",          "thomas_grid"),
    # Hyperion: PSI's 30k-triangle plate model derived from Thomas 2007.
    # The 5° lat/lon grid in `ast-sat.thomas.shape-models_V1_0` is too
    # coarse (2,701 verts) to reproduce the sponge-like silhouette that
    # dominates NASA visualisations; the plate OBJ is 5.4× denser.
    ("hyperion", f"{SBN_OBJ}/hyperion/hyperion_30k_plt.obj",                           "obj"),
]

UA = "drake-fetch-planet-meshes/1.0 (+https://github.com/jamiec/drake)"
MAGIC = 0x50485344  # 'DSHP' little-endian
VERSION = 1


def download(url: str, dest: str) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    with open(dest, "wb") as f:
        f.write(data)
    return len(data)


def parse_gaskell(text: str) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    # Phoebe's PDS bundle has a trailing blank line that breaks index math.
    lines = [ln for ln in text.splitlines() if ln.strip()]
    header = [int(x) for x in lines[0].split()]
    nv = header[0]
    verts: list[tuple[float, float, float]] = []
    for i in range(1, 1 + nv):
        parts = lines[i].split()
        verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
    if len(header) > 1:
        nf = header[1]
        face_start = 1 + nv
    else:
        nf = int(lines[1 + nv].split()[0])
        face_start = 2 + nv
    tris: list[tuple[int, int, int]] = []
    for i in range(face_start, face_start + nf):
        parts = lines[i].split()
        # 1-indexed → 0-indexed
        tris.append((int(parts[1]) - 1, int(parts[2]) - 1, int(parts[3]) - 1))
    return verts, tris


def parse_thomas_grid(text: str) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    """Lat/lon/r rows on a 5° grid. Triangulate column-major.

    Pole rows (lat=±90) collapse to a single point, but the source
    file repeats them for every longitude — we keep the duplicates
    because the index pattern is simpler and the redundancy is tiny.
    """
    import math

    rows: list[tuple[float, float, float]] = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        lat_deg, lon_deg, r = (float(x) for x in s.split())
        rows.append((lat_deg, lon_deg, r))

    lats = sorted({r[0] for r in rows})
    lons = sorted({r[1] for r in rows})
    n_lat, n_lon = len(lats), len(lons)
    if n_lat * n_lon != len(rows):
        raise RuntimeError(f"thomas grid not rectangular: {n_lat}×{n_lon}={n_lat*n_lon} ≠ {len(rows)}")

    # (lat_idx, lon_idx) → flat vertex idx
    grid: dict[tuple[int, int], int] = {}
    verts: list[tuple[float, float, float]] = []
    for lat_idx, lat_deg in enumerate(lats):
        for lon_idx, lon_deg in enumerate(lons):
            r = next(rr for (la, lo, rr) in rows if la == lat_deg and lo == lon_deg)
            lat = math.radians(lat_deg)
            lon = math.radians(lon_deg)
            x = r * math.cos(lat) * math.cos(lon)
            y = r * math.cos(lat) * math.sin(lon)
            z = r * math.sin(lat)
            grid[(lat_idx, lon_idx)] = len(verts)
            verts.append((x, y, z))

    tris: list[tuple[int, int, int]] = []
    # File contains both lon=0 and lon=360 entries (duplicate ring) —
    # iterate to n_lon-1 in lon to avoid stitching the seam onto itself.
    for li in range(n_lat - 1):
        for lo in range(n_lon - 1):
            a = grid[(li,     lo    )]
            b = grid[(li,     lo + 1)]
            c = grid[(li + 1, lo + 1)]
            d = grid[(li + 1, lo    )]
            # CCW when viewed from outside (radius increases outward).
            tris.append((a, b, c))
            tris.append((a, c, d))
    return verts, tris


def parse_obj(text: str) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    """Minimal Wavefront OBJ — `v x y z` and `f v1 v2 v3` only.

    Ignores `vt`/`vn`/`vp` lines, comments, and groups. Quads or
    higher-degree faces are fan-triangulated.

    Indexing: OBJ spec is 1-indexed, but PSI's `sbn-psi/shape-models`
    Hyperion plate model writes 0-indexed faces. We detect by the min
    face index across the file: 0 → already 0-indexed, otherwise
    subtract 1.
    """
    verts: list[tuple[float, float, float]] = []
    raw_faces: list[list[int]] = []
    for raw in text.splitlines():
        if not raw or raw[0] == "#":
            continue
        parts = raw.split()
        if not parts:
            continue
        tag = parts[0]
        if tag == "v":
            verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif tag == "f":
            raw_faces.append([int(p.split("/", 1)[0]) for p in parts[1:]])
    base = 0 if min(min(f) for f in raw_faces) == 0 else 1
    tris: list[tuple[int, int, int]] = []
    for f in raw_faces:
        idx = [i - base for i in f]
        for i in range(1, len(idx) - 1):
            tris.append((idx[0], idx[i], idx[i + 1]))
    return verts, tris


def write_drake_mesh(dest: str, verts: list[tuple[float, float, float]], tris: list[tuple[int, int, int]]) -> int:
    nv = len(verts)
    ni = len(tris) * 3
    with open(dest, "wb") as f:
        f.write(struct.pack("<IIII", MAGIC, VERSION, nv, ni))
        # Positions
        pos_buf = bytearray(nv * 12)
        struct.pack_into(f"<{nv * 3}f", pos_buf, 0, *(c for v in verts for c in v))
        f.write(pos_buf)
        # Indices
        idx_buf = bytearray(ni * 4)
        struct.pack_into(f"<{ni}I", idx_buf, 0, *(i for t in tris for i in t))
        f.write(idx_buf)
    return os.path.getsize(dest)


def process(name: str, url: str, kind: str, cache_dir: str, out_dir: str) -> tuple[int, int]:
    ext = os.path.splitext(url)[1] or ".tab"
    cache_path = os.path.join(cache_dir, f"{name}{ext}")
    if not os.path.exists(cache_path):
        size = download(url, cache_path)
        print(f"fetch  {name}{ext}  ({size // 1024} KB)")
    else:
        print(f"skip   {name}{ext} (cached)")
    with open(cache_path) as f:
        text = f.read()
    if kind == "gaskell":
        verts, tris = parse_gaskell(text)
    elif kind == "thomas_grid":
        verts, tris = parse_thomas_grid(text)
    elif kind == "obj":
        verts, tris = parse_obj(text)
    else:
        raise ValueError(f"unknown kind: {kind}")
    out_path = os.path.join(out_dir, f"{name}.bin")
    out_size = write_drake_mesh(out_path, verts, tris)
    print(f"write  {name}.bin  ({len(verts)} verts, {len(tris)} tris, {out_size // 1024} KB)")
    return len(verts), len(tris)


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cache_dir = os.path.join(root, "data", "cache", "planet-meshes")
    out_dir = os.path.join(root, "dist", "tiles", "planets")
    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    failures: list[str] = []
    for name, url, kind in MESHES:
        try:
            process(name, url, kind, cache_dir, out_dir)
        except Exception as exc:
            print(f"FAIL   {name} <- {url}: {exc}", file=sys.stderr)
            failures.append(name)

    if failures:
        print(f"\n{len(failures)} mesh(es) failed: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"\nWrote meshes to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
