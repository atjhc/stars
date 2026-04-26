#!/usr/bin/env python3
"""Download equirectangular planet textures into dist/tiles/planets/.

Most maps come from Solar System Scope (CC-BY 4.0). Pluto and Ceres use
real spacecraft data hosted on Wikimedia Commons:

  - Pluto: New Horizons global mosaic (CC-BY-SA 4.0)
  - Ceres: NASA/JPL Dawn HAMO global map (Public Domain)

The runtime loads `tiles/planets/<name>.<ext>` per body and falls back
to flat grey for any body whose file is missing — Eros has no map at
all, and the dwarfs Eris/Haumea/Makemake stay on SSS "fictional" maps
because no spacecraft has surveyed them.
"""

import os
import sys
import urllib.request

SSS_BASE = "https://www.solarsystemscope.com/textures/download"
WIKI_THUMB = "https://upload.wikimedia.org/wikipedia/commons/thumb"

# (output basename, output extension, source URL).
# Output is what src/planets.ts loads (`tiles/planets/<name>.<ext>`).
TEXTURES = [
    ("mercury",     "jpg", f"{SSS_BASE}/2k_mercury.jpg"),
    ("venus",       "jpg", f"{SSS_BASE}/2k_venus_atmosphere.jpg"),
    ("earth",       "jpg", f"{SSS_BASE}/2k_earth_daymap.jpg"),
    ("luna",        "jpg", f"{SSS_BASE}/2k_moon.jpg"),
    ("mars",        "jpg", f"{SSS_BASE}/2k_mars.jpg"),
    ("jupiter",     "jpg", f"{SSS_BASE}/2k_jupiter.jpg"),
    ("saturn",      "jpg", f"{SSS_BASE}/2k_saturn.jpg"),
    # Ring particles, alpha-encoded radial transparency. PNG, not JPEG.
    ("saturn_ring", "png", f"{SSS_BASE}/2k_saturn_ring_alpha.png"),
    ("uranus",      "jpg", f"{SSS_BASE}/2k_uranus.jpg"),
    ("neptune",     "jpg", f"{SSS_BASE}/2k_neptune.jpg"),
    # Real Dawn HAMO mosaic — public domain (NASA/JPL-Caltech). 2K
    # downsample of the 4000×2000 Wikimedia original.
    ("ceres",       "jpg",
        f"{WIKI_THUMB}/a/a2/PIA20354-Ceres-DwarfPlanet-MercatorMap-HAMO-20160322.jpg"
        "/2048px-PIA20354-Ceres-DwarfPlanet-MercatorMap-HAMO-20160322.jpg"),
    # Real New Horizons mosaic — CC-BY-SA 4.0. 2K downsample of the
    # 8192×4096 Wikimedia original.
    ("pluto",       "jpg",
        f"{WIKI_THUMB}/3/30/Pluto-map-sept-16-2015.jpg"
        "/2048px-Pluto-map-sept-16-2015.jpg"),
    # Eros has no published global map; stays grey at runtime.
    # Eris/Haumea/Makemake have no real surface data — telescopes
    # only resolve a handful of pixels — so the SSS "fictional"
    # plausible-looking textures are the best we can do.
    ("eris",        "jpg", f"{SSS_BASE}/2k_eris_fictional.jpg"),
    ("haumea",      "jpg", f"{SSS_BASE}/2k_haumea_fictional.jpg"),
    ("makemake",    "jpg", f"{SSS_BASE}/2k_makemake_fictional.jpg"),
]

UA = "drake-fetch-planet-textures/1.0 (+https://github.com/jamiec/drake)"


def download(url: str, dest: str) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    with open(dest, "wb") as f:
        f.write(data)
    return len(data)


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "dist", "tiles", "planets")
    os.makedirs(out_dir, exist_ok=True)

    failures: list[str] = []
    for out_name, ext, url in TEXTURES:
        out_file = f"{out_name}.{ext}"
        dest = os.path.join(out_dir, out_file)
        if os.path.exists(dest):
            print(f"skip   {out_file} (already present)")
            continue
        try:
            size = download(url, dest)
            print(f"fetch  {out_file}  ({size // 1024} KB)")
        except Exception as exc:
            print(f"FAIL   {out_file} <- {url}: {exc}", file=sys.stderr)
            failures.append(out_name)

    if failures:
        print(f"\n{len(failures)} texture(s) failed: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"\nWrote textures to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
