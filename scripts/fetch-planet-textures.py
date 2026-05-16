#!/usr/bin/env python3
"""Download equirectangular planet textures into dist/tiles/planets/.

The eight planets, Earth's moon, and Saturn's rings come from Solar
System Scope (CC-BY 4.0). Everything else uses real spacecraft data
mirrored on Wikimedia Commons or USGS Astrogeology:

  - Pluto: New Horizons global mosaic (CC-BY-SA 4.0, Wikimedia)
  - Ceres: NASA/JPL Dawn HAMO map (PD, Wikimedia; desaturated to
    luminance to strip false-colour polar artifacts)
  - Eros / Phobos / Deimos: Stooke/Askaniy grayscale maps
    (CC-BY-SA 3.0, Wikimedia)
  - Io: USGS Galileo SSI simple-cylindrical (PD, Wikimedia)
  - Ganymede / Callisto: Stooke/Askaniy maps (CC-BY-SA 3.0, Wikimedia)
  - Enceladus / Tethys / Dione / Rhea / Iapetus: USGS Astrogeology
    Cassini-Voyager simple-cylindrical mosaic previews (PD; non-HPF
    Enceladus variant)
  - Titan: NASA Photojournal PIA22770 photometrically-corrected ISS
    mosaic (PD; PIA19658 has visible flyby seams without haze model)
  - Mimas: NASA Photojournal PIA14926 unlabeled mosaic (PD); both
    Titan and Mimas → `downsample_2k` to 2048×1024 from 5760×2880
    source
  - Triton: Voyager 2 1989 PIA18668 mosaic (PD, Wikimedia)
  - Europa: USGS Voyager-Galileo 500 m mosaic 1024px preview (PD)
  - Charon: USGS LORRI+MVIC 300 m mosaic — full TIFF downsampled at
    fetch time to 2048×1024 JPEG via the `downsample_2k` post-process
  - Eris / Haumea / Makemake: SSS "fictional" maps because no
    spacecraft has resolved them

The runtime loads `tiles/planets/<name>.<ext>` per body and falls back
to flat grey for any body whose file is missing.

## Post-processing

Each `TEXTURES` entry has a 4th field, `post`, that names a build-time
post-process step run after the file is downloaded but before it's
written to its final location. Currently:

  - `None` — ship the downloaded bytes verbatim.
  - `"desaturate"` — drop chroma to luminance via PIL
    (`Image.convert("L").convert("RGB")`) and rewrite in place. Used
    for Ceres because its source is the *colour-enhanced* Dawn HAMO
    mosaic, where low-sun-angle filter compositing produces fake
    green/yellow polar tints that aren't real surface colour. Result
    is an ordinary RGB JPEG with R=G=B in every pixel; the runtime
    loader needs no special-case handling.
  - `"downsample_2k"` — Lanczos-resample the image to 2048×1024 and
    save as JPEG q=88. Used for Charon because USGS publishes only
    the 80 MB GeoTIFF — no smaller preview JPEG. The fetch downloads
    the TIFF as `<name>.jpg` (PIL identifies the format from content,
    not the extension), then this step rewrites it as a real
    2K-equirectangular JPEG. After one run the cached `<name>.jpg`
    skips on subsequent invocations; force a refresh by deleting it.
  - `"tint_titan"` — `downsample_2k` followed by per-pixel multiply
    by an orange tint `(1.000, 0.827, 0.330)` sampled from Cassini
    PIA06230's natural-colour disc view of Titan. The IR surface
    map underneath isn't what eyes would see (Titan's atmosphere is
    opaque in visible light); the tint shifts colour to roughly the
    real perception while preserving stylised surface detail.
  - `"fill_polar_gaps"` — replace every pixel below luminance 20
    with uniform medium grey `(128, 128, 128)`. Used for Europa
    because the USGS Voyager-Galileo mosaic has a feathered black
    band at the south pole. On a wrapped sphere the polar singularity
    compresses the cap to a small near-pole region, so flat grey
    reads as a slightly dimmer cap rather than a black hole.
  - `"fill_unmapped_matched"` — same idea but the fill grey is the
    mean luminance of the mapped pixels rather than a fixed 128.
    Used for the Uranian moon mosaics where Voyager 2 captured only
    the southern hemispheres; a fixed grey would be far too bright
    over a dark moon (Umbriel) and too dark over a bright one
    (Ariel), making the unmapped half visibly mismatched.

Post-processing is therefore baked into the asset — the runtime never
sees the raw download. Force a refresh by deleting the output file
(this script skips already-present targets). Pillow is required for
post-processed entries; pure-download entries have no extra deps.
"""

import os
import sys
import urllib.request

SSS_BASE = "https://www.solarsystemscope.com/textures/download"
WIKI_THUMB = "https://upload.wikimedia.org/wikipedia/commons/thumb"

# (output basename, output extension, source URL, post-process tag).
# Output is what src/planets.ts loads (`tiles/planets/<name>.<ext>`).
# `post` is None for raw download or a string the post-process pipeline
# below recognises (e.g. "desaturate").
TEXTURES = [
    ("mercury",     "jpg", f"{SSS_BASE}/2k_mercury.jpg",                        None),
    ("venus",       "jpg", f"{SSS_BASE}/2k_venus_atmosphere.jpg",               None),
    ("earth",       "jpg", f"{SSS_BASE}/2k_earth_daymap.jpg",                   None),
    # White-on-black cloud cover, sampled as a transparent shell over Earth.
    # JPG has no alpha channel; the runtime cloud shader derives alpha
    # from the texture's luminance.
    ("earth_clouds","jpg", f"{SSS_BASE}/2k_earth_clouds.jpg",                    None),
    # NASA Black Marble 2012 — public domain (US Government work). Used
    # as an emissive layer on Earth's dark side. 3600×1800 source is
    # downsampled to 2048×1024 to match the day map.
    ("earth_night", "jpg",
        "https://eoimages.gsfc.nasa.gov/images/imagerecords/79000/79765/dnb_land_ocean_ice.2012.3600x1800.jpg",
        "downsample_2k"),
    ("luna",        "jpg", f"{SSS_BASE}/2k_moon.jpg",                           None),
    ("mars",        "jpg", f"{SSS_BASE}/2k_mars.jpg",                           None),
    ("jupiter",     "jpg", f"{SSS_BASE}/2k_jupiter.jpg",                        None),
    ("saturn",      "jpg", f"{SSS_BASE}/2k_saturn.jpg",                         None),
    # Ring particles, alpha-encoded radial transparency. PNG, not JPEG.
    ("saturn_ring", "png", f"{SSS_BASE}/2k_saturn_ring_alpha.png",              None),
    ("uranus",      "jpg", f"{SSS_BASE}/2k_uranus.jpg",                         None),
    # Voyager 2 imaged only the southern hemispheres of the major
    # Uranian moons during its 1986 flyby (Uranus's south pole was
    # facing the sun); the upstream USGS/NASA mosaics fill the
    # unmapped north with black, which `fill_unmapped_matched`
    # replaces with each moon's surface-tone-matched neutral grey.
    ("miranda",     "jpg",
        f"{WIKI_THUMB}/9/91/Miranda_map.jpg"
        "/2048px-Miranda_map.jpg",                                                "fill_unmapped_matched"),
    ("ariel",       "jpg",
        f"{WIKI_THUMB}/7/74/Ariel_map_JPL_USGS.jpg"
        "/1440px-Ariel_map_JPL_USGS.jpg",                                         "fill_unmapped_matched"),
    ("umbriel",     "jpg",
        f"{WIKI_THUMB}/4/42/Umbriel_map_JPL_USGS.jpg"
        "/1440px-Umbriel_map_JPL_USGS.jpg",                                       "fill_unmapped_matched"),
    ("titania",     "jpg",
        f"{WIKI_THUMB}/8/85/Titania_map_JPL_USGS.jpg"
        "/1440px-Titania_map_JPL_USGS.jpg",                                       "fill_unmapped_matched"),
    ("oberon",      "jpg",
        f"{WIKI_THUMB}/1/1d/Oberon_map_JPL_USGS.jpg"
        "/1440px-Oberon_map_JPL_USGS.jpg",                                        "fill_unmapped_matched"),
    ("neptune",     "jpg", f"{SSS_BASE}/2k_neptune.jpg",                        None),
    # Real Dawn HAMO mosaic — public domain (NASA/JPL-Caltech). 2K
    # downsample of the 4000×2000 Wikimedia original. PIA20354 is the
    # *colour-enhanced* HAMO product: low-sun-angle filter compositing
    # at the poles produces strong green/yellow chrominance artifacts
    # that aren't real surface colour (Ceres is essentially monochromatic
    # — slightly reddish-grey). Post-process strips chroma to luminance
    # so the texture shows actual surface brightness without the tint.
    ("ceres",       "jpg",
        f"{WIKI_THUMB}/a/a2/PIA20354-Ceres-DwarfPlanet-MercatorMap-HAMO-20160322.jpg"
        "/2048px-PIA20354-Ceres-DwarfPlanet-MercatorMap-HAMO-20160322.jpg",
        "desaturate"),
    # Real New Horizons mosaic — CC-BY-SA 4.0. 2K downsample of the
    # 8192×4096 Wikimedia original.
    ("pluto",       "jpg",
        f"{WIKI_THUMB}/3/30/Pluto-map-sept-16-2015.jpg"
        "/2048px-Pluto-map-sept-16-2015.jpg",                                    None),
    # Stooke/Askaniy spacecraft-derived grayscale equirectangular maps
    # (CC-BY-SA 3.0) for the three irregular bodies that ship as real
    # shape models. 1920px is Wikimedia's largest available thumb;
    # PNG keeps high-contrast crater rims clean.
    ("eros",        "png",
        f"{WIKI_THUMB}/8/80/Eros_map_by_Askaniy.png"
        "/1920px-Eros_map_by_Askaniy.png",                                       None),
    ("phobos",      "png",
        f"{WIKI_THUMB}/3/30/Phobos_map_by_Askaniy.png"
        "/1920px-Phobos_map_by_Askaniy.png",                                     None),
    ("deimos",      "png",
        f"{WIKI_THUMB}/7/72/Deimos_map_by_Askaniy.png"
        "/1920px-Deimos_map_by_Askaniy.png",                                     None),
    # Eris/Haumea/Makemake have no real surface data — telescopes
    # only resolve a handful of pixels — so the SSS "fictional"
    # plausible-looking textures are the best we can do.
    ("eris",        "jpg", f"{SSS_BASE}/2k_eris_fictional.jpg",                  None),
    ("haumea",      "jpg", f"{SSS_BASE}/2k_haumea_fictional.jpg",                None),
    ("makemake",    "jpg", f"{SSS_BASE}/2k_makemake_fictional.jpg",              None),
    # Major moons — Wikimedia is the only source. SSS doesn't ship moon
    # maps. Mix of Wikimedia hosts:
    #   - Galilean Io: Galileo SSI simple-cylindrical mosaic via USGS
    #     PDS IMG (PD)
    #   - Galilean Ganymede / Callisto: Stooke/Askaniy spacecraft-derived
    #     equirectangular maps (CC-BY-SA 3.0)
    #   - Saturn moons: Schenk 2014 Cassini ISS color global mosaics —
    #     PIA18434 Dione, 18435 Enceladus, 18436 Iapetus, 18437 Mimas,
    #     18438 Rhea, 18439 Tethys (all PD-USGov).
    #   - Titan: 2009 USGS Cassini ISS+VIMS surface mosaic under haze (PD)
    #   - Triton: PIA18668 Voyager 2 1989 mosaic (PD)
    # Europa and Charon are absent — Wikimedia carries only annotated /
    # partial-coverage maps for them; they fall through to flat grey.
    ("io",          "jpg",
        f"{WIKI_THUMB}/b/bb/Io_modest_scale_map_Io_SSI-only_color_SIMP0_med.cub.jpg"
        "/1920px-Io_modest_scale_map_Io_SSI-only_color_SIMP0_med.cub.jpg",       None),
    # USGS Astrogeology hosts the official Voyager + Galileo SSI 500 m
    # simple-cylindrical mosaic (PD); only 1024×512 preview is available
    # short of the 184 MB GeoTIFF, but Europa's ice plains are smooth
    # enough that the lower resolution still reads as real surface detail.
    # The mosaic has a feathered black band at the south pole (no
    # spacecraft coverage); `fill_polar_gaps` replaces those pixels
    # with uniform medium grey so the wrapped sphere shows a slightly
    # dimmer cap rather than a black hole.
    ("europa",      "jpg",
        "https://astrogeology.usgs.gov/ckan/dataset/4080036f-afc5-422e-abe9-1c0c8e4f98ea"
        "/resource/3647e7b3-425e-4dcf-951b-cc4a22fb0129/download"
        "/europa_voyager_galileossi_global_mosaic_500m_1024.jpg",                "fill_polar_gaps"),
    ("ganymede",    "png",
        f"{WIKI_THUMB}/8/81/Ganymede_map_by_Askaniy.png"
        "/1920px-Ganymede_map_by_Askaniy.png",                                    None),
    ("callisto",    "png",
        f"{WIKI_THUMB}/a/a1/Callisto_map_by_Askaniy.png"
        "/1920px-Callisto_map_by_Askaniy.png",                                    None),
    # USGS Astrogeology hosts proper unannotated cylindrical mosaic
    # previews for 5 of the 6 Schenk-PIA Saturnian moons (1024×512
    # JPEG, simple-cylindrical, ~100 KB each). Mimas isn't catalogued
    # there yet, so it uses the NASA Photojournal PIA14926 unlabeled
    # 5760×2880 simple-cylindrical mosaic, downsampled to 2048×1024.
    ("mimas",       "jpg",
        "https://assets.science.nasa.gov/content/dam/science/psd/photojournal"
        "/pia/pia14/pia14926/PIA14926.jpg",                                       "downsample_2k"),
    # Use the non-HPF (high-pass filter) Enceladus mosaic — the HPF
    # variant flattens overall brightness for geological analysis,
    # which renders as a uniform grey ball at our scale.
    ("enceladus",   "jpg",
        "https://astrogeology.usgs.gov/ckan/dataset/30bff65e-56bb-4fd1-bd04-edd9bc2e77d0"
        "/resource/19ba2e14-9ceb-45e6-8cc8-e784e36ed4f0/download/full.jpg",       None),
    ("tethys",      "jpg",
        "https://astrogeology.usgs.gov/ckan/dataset/e40296c1-b4bf-46d8-86af-4b6cf0301b0c"
        "/resource/36d40203-d9b3-447e-9004-c3dc100bde04/download/full.jpg",       None),
    ("dione",       "jpg",
        "https://astrogeology.usgs.gov/ckan/dataset/acb98ae6-ec50-42df-9a74-142d177bbe6d"
        "/resource/8a6a8ada-42e1-4b92-b13e-c63493133efc/download/full.jpg",       None),
    ("rhea",        "jpg",
        "https://astrogeology.usgs.gov/ckan/dataset/22bc1015-d9c9-4212-86c3-e42061b204d4"
        "/resource/77fa77f8-6d6b-4072-9360-17138caa6e7d/download/full.jpg",       None),
    ("iapetus",     "jpg",
        "https://astrogeology.usgs.gov/ckan/dataset/6ac8ecfb-36e7-4113-8d16-c92ba857c3d7"
        "/resource/141c2d1e-aa01-4e2f-969a-e46a581db4b9/download/full.jpg",       None),
    # Cassini Phoebe cylindrical mosaic PIA07775 (PD-NASA). Wikimedia
    # hosts a pre-cropped 2048×1024 variant with the title strip and
    # most of the NASA caption already trimmed off (only a thin
    # residual band remains below −90° latitude, never sampled by
    # the spherical UV wrap). Hyperion has no equivalent published
    # cylindrical map — its real spacecraft mesh carries the visual
    # signature, so it stays untextured (flat grey fallback).
    ("phoebe",      "jpg",
        "https://upload.wikimedia.org/wikipedia/commons/d/d0/Phoebe_map_PIA07775_cropped.jpg",
        None),
    # Titan NASA Photojournal PIA22770 (2018) photometrically-
    # corrected ISS surface mosaic, downsampled and tinted with the
    # natural-colour orange sampled from Cassini PIA06230. The
    # underlying IR surface map isn't what eyes would see (Titan's
    # haze is opaque in visible light), but the tinted result is a
    # stylised compromise: realistic colour with surface detail
    # preserved through it. See `tint_titan` post-process.
    ("titan",       "jpg",
        "https://assets.science.nasa.gov/content/dam/science/psd/solar"
        "/2023/09/p/i/a/PIA22770-1.jpg",                                          "tint_titan"),
    # USGS Voyager 2 600m global color mosaic (PD), 1024×512 preview.
    # Voyager 2 imaged during Triton's southern summer so the north
    # hemisphere has no coverage and reads as black in the source —
    # `fill_polar_gaps` replaces those pixels with uniform medium grey.
    # The Wikimedia PIA18668 had baked-in feature labels.
    ("triton",      "jpg",
        "https://astrogeology.usgs.gov/ckan/dataset/445b4c39-e87a-4e4d-88a8-e48d8e755c5c"
        "/resource/de0ba9f1-303e-4e5f-a99a-3201fba9a764/download"
        "/triton_voyager2_clrmosaic_1024.jpg",                                    "fill_polar_gaps"),
    # USGS Astrogeology Charon mosaic (LORRI + MVIC, July 2017, 300 m).
    # No JPEG preview is published — only the 80 MB 8-bit TIFF — so the
    # fetch downloads it once and `downsample_2k` resamples to the same
    # 2048×1024 JPEG format we use elsewhere. New Horizons only mapped
    # the encounter hemisphere; the trailing side has no surface data
    # in the source and renders as the source's fill colour.
    ("charon",      "jpg",
        "https://planetarymaps.usgs.gov/mosaic/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif",
        "downsample_2k"),
]

UA = "drake-fetch-planet-textures/1.0 (+https://github.com/jamiec/drake)"


def download(url: str, dest: str) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    # 5-minute timeout: long enough for the 80 MB Charon TIFF on a slow
    # link without leaving small fetches hanging if a server stalls.
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read()
    with open(dest, "wb") as f:
        f.write(data)
    return len(data)


def post_process(dest: str, tag: str) -> None:
    """Apply tag-specific post-processing to a downloaded texture.

    Tags:
      - "desaturate": drop chroma to luminance via PIL
        (`Image.convert("L").convert("RGB")`) and rewrite as JPEG. Used
        for the colour-enhanced Ceres HAMO mosaic, where low-sun-angle
        filter compositing produces fake green/yellow polar tints.
      - "downsample_2k": resize a 2:1 equirectangular source to
        2048×1024 JPEG. Used when the upstream source is only available
        as a large TIFF (e.g., Charon's 80 MB New Horizons mosaic) and
        no smaller preview JPEG is published.

    The output always overwrites `dest` as a real JPEG regardless of
    the input format — PIL identifies input by content (TIFF / PNG /
    JPEG) and `save(format="JPEG")` forces JPEG output.
    """
    from PIL import Image

    def resize_2k_rgb(im: "Image.Image") -> "Image.Image":
        out = im.resize((2048, 1024), Image.Resampling.LANCZOS)
        return out if out.mode == "RGB" else out.convert("RGB")

    if tag == "desaturate":
        with Image.open(dest) as im:
            im.convert("L").convert("RGB").save(dest, format="JPEG", quality=92)
    elif tag == "downsample_2k":
        with Image.open(dest) as im:
            resize_2k_rgb(im).save(dest, format="JPEG", quality=88)
    elif tag == "fill_polar_gaps":
        # Spacecraft mosaics with patchy polar coverage (Voyager+Galileo
        # never imaged Europa's south pole) bake the gap into the
        # source as black pixels; replace them with uniform medium grey
        # so the wrapped sphere shows a dimmer cap, not a black hole.
        import numpy as np
        with Image.open(dest) as im:
            arr = np.array(im.convert("RGB"))
            arr[arr.mean(axis=2) < 20] = (128, 128, 128)
            Image.fromarray(arr).save(dest, format="JPEG", quality=88)
    elif tag == "fill_unmapped_matched":
        # Variant of fill_polar_gaps that samples the moon's actual
        # surface tone instead of using a fixed 128 grey. Uranian moon
        # mosaics are dominated by black northern hemispheres (Voyager
        # 2 only imaged the south); a fixed grey would render brighter
        # than the imaged surface for a dark moon like Umbriel and
        # darker than it for a bright one like Ariel. Mean luminance
        # of the mapped pixels gives a tone-matched neutral.
        import numpy as np
        with Image.open(dest) as im:
            arr = np.array(im.convert("RGB"))
            mapped = arr.mean(axis=2) >= 20
            if mapped.any():
                gray = int(round(arr[mapped].mean()))
                arr[~mapped] = (gray, gray, gray)
                Image.fromarray(arr).save(dest, format="JPEG", quality=88)
    elif tag == "tint_titan":
        # Tint sampled from Cassini PIA06230's natural-colour disc:
        # brightest sunlit pixels RGB(237,196,78) → multiplier
        # (1.000, 0.827, 0.330). The underlying IR surface map isn't
        # what eyes would see (Titan's haze is opaque in visible
        # light); the tint shifts colour toward real perception while
        # preserving stylised surface detail.
        import numpy as np
        TINT = np.array([1.000, 0.827, 0.330], dtype=np.float32)
        with Image.open(dest) as im:
            arr = np.array(resize_2k_rgb(im)).astype(np.float32) * TINT
            Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(dest, format="JPEG", quality=88)
    else:
        raise ValueError(f"unknown post-process tag: {tag}")


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "dist", "tiles", "planets")
    os.makedirs(out_dir, exist_ok=True)

    failures: list[str] = []
    for out_name, ext, url, post in TEXTURES:
        out_file = f"{out_name}.{ext}"
        dest = os.path.join(out_dir, out_file)
        if os.path.exists(dest):
            print(f"skip   {out_file} (already present)")
            continue
        try:
            size = download(url, dest)
            if post:
                post_process(dest, post)
                size = os.path.getsize(dest)
                print(f"fetch  {out_file}  ({size // 1024} KB, post: {post})")
            else:
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
