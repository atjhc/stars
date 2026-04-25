#!/usr/bin/env python3
"""
Bake the Edenhofer et al. (2024) 3D dust density cube into the RGBA texture
consumed by Drake's volumetric dust renderer.

Input:  data/cache/edenhofer2023_healpix.fits  (~3.25 GB HEALPix × distance)
Output: dist/tiles/dust_volume_rgba.bin         (RGBA uint8)
        dist/tiles/dust_meta.json

The source FITS is downloaded automatically if missing.

Pipeline:
  1. Load the HEALPix sphere stack (NSIDE pixels × radial distance bins)
  2. Resample onto a galactic Cartesian grid at RES_PC voxels via
     bilinear (angular, 4-neighbor) + linear (radial) interpolation.
     Optional intra-voxel supersampling smooths out aliasing.
  3. Threshold Local Bubble residuals.
  4. Compute hot-star illumination from O/B stars in the AT-HYG catalog.
  5. Bake into RGBA: R=density, G=ionizing flux, B=scattering flux, A=255
"""

import argparse
import os
import sys
import json
import gzip
import csv
import urllib.request
import numpy as np
import healpy as hp

_parser = argparse.ArgumentParser(description=__doc__)
_parser.add_argument("--res-pc", type=int, default=6,
                     help="Output voxel size in pc (default 6). Smaller = more detail + much bigger file.")
_parser.add_argument("--supersample", type=int, default=3,
                     help="Intra-voxel supersample factor per axis (default 3).")
_args, _ = _parser.parse_known_args()

# Edenhofer et al. 2024 (A&A 685, A82) — Zenodo record 8187943.
# HEALPix variant (3.25 GB) is 5× smaller than the pre-interpolated xyz
# variant (15.7 GB) and we resample to Cartesian ourselves.
FITS_URL = "https://zenodo.org/records/8187943/files/mean_and_std_healpix.fits"
FITS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "data", "cache", "edenhofer2023_healpix.fits")
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "dist", "tiles")

# Target bake: 6 pc voxels keeps the RGBA under ~25 MB gzipped while
# still well below the ~7 pc effective angular resolution at the edge
# of the map. Z extent stays at ±400 pc — no catalogued nebulae above.
RES_PC = _args.res_pc
HALF_XY_PC = 1000
HALF_Z_PC = 400

SUB_HALF_XY = HALF_XY_PC // RES_PC
SUB_HALF_Z = HALF_Z_PC // RES_PC
SUB_XY = 2 * SUB_HALF_XY + 1
SUB_Z = 2 * SUB_HALF_Z + 1

# Each output voxel averages SUPERSAMPLE**3 samples from the continuous
# HEALPix field. 3 ≈ matches what the xyz bake would have gotten from
# 3×3×3 block-averaging the 2 pc cube.
SUPERSAMPLE = _args.supersample

ILLUM_RADIUS_PC = 150
ILLUM_RADIUS_VOXELS = ILLUM_RADIUS_PC // RES_PC


def equatorial_to_galactic_matrix():
    ra_ngp = np.radians(192.85948)
    dec_ngp = np.radians(27.12835)
    l_ncp = np.radians(122.93192)
    cos_ra, sin_ra = np.cos(ra_ngp), np.sin(ra_ngp)
    cos_dec, sin_dec = np.cos(dec_ngp), np.sin(dec_ngp)
    cos_l, sin_l = np.cos(l_ncp), np.sin(l_ncp)
    R = np.array([
        [-sin_ra * sin_l - cos_ra * sin_dec * cos_l,  sin_ra * cos_l - cos_ra * sin_dec * sin_l,  cos_ra * cos_dec],
        [ cos_ra * sin_l - sin_ra * sin_dec * cos_l, -cos_ra * cos_l - sin_ra * sin_dec * sin_l,  sin_ra * cos_dec],
        [ cos_dec * cos_l,                             cos_dec * sin_l,                             sin_dec          ],
    ])
    return R.T


def download_fits():
    if os.path.exists(FITS_PATH):
        size_gb = os.path.getsize(FITS_PATH) / 1e9
        print(f"Using cached {FITS_PATH} ({size_gb:.2f} GB)")
        return
    os.makedirs(os.path.dirname(FITS_PATH), exist_ok=True)
    print(f"Downloading {FITS_URL} (~3.25 GB; Zenodo throttles — this is slow)")
    print("  For a much faster download, use the parallel curl script")
    print("  referenced in docs/data-sources.md.")
    urllib.request.urlretrieve(FITS_URL, FITS_PATH)
    print(f"Saved ({os.path.getsize(FITS_PATH) / 1e9:.2f} GB)")


def load_healpix_cube():
    """Load the HEALPix × distance cube and radial grid from the FITS."""
    try:
        from astropy.io import fits
    except ImportError:
        print("ERROR: astropy is required. pip3 install astropy", file=sys.stderr)
        sys.exit(1)

    print("Opening HEALPix FITS...")
    data = None
    radii = None
    nside = None
    nest = None
    with fits.open(FITS_PATH, memmap=True) as hdul:
        for hdu in hdul:
            nm = (hdu.name or "").lower()
            if data is None and nm == "mean":
                data = np.asarray(hdu.data, dtype=np.float32)
                nside = int(hdu.header["NSIDE"])
                nest = hdu.header["ORDERING"].lower().startswith("nest")
            elif radii is None and isinstance(hdu, fits.BinTableHDU) \
                    and "radial pixel centers" in hdu.data.names:
                radii = np.asarray(hdu.data["radial pixel centers"], dtype=np.float32)

    if data is None or radii is None or nside is None:
        print("ERROR: FITS missing expected HDUs (mean + radial pixel centers)", file=sys.stderr)
        sys.exit(1)

    print(f"  data shape: {data.shape} (expected n_radii × 12*nside^2 = {radii.size} × {12*nside*nside})")
    print(f"  NSIDE={nside}, ordering={'NESTED' if nest else 'RING'}")
    print(f"  radii: {radii.size} bins, {radii.min():.1f}..{radii.max():.1f} pc")
    return data, radii, nside, nest


def resample_to_cartesian(data, radii, nside, nest):
    """Resample HEALPix × radius stack onto Cartesian grid at RES_PC voxels."""
    print(f"Resampling to {SUB_Z}×{SUB_XY}×{SUB_XY} at {RES_PC} pc, {SUPERSAMPLE}³ supersample...")

    offs = (np.arange(SUPERSAMPLE) - (SUPERSAMPLE - 1) / 2) * (RES_PC / SUPERSAMPLE)
    gx = (np.arange(SUB_XY, dtype=np.float32) - SUB_HALF_XY) * RES_PC
    gy = (np.arange(SUB_XY, dtype=np.float32) - SUB_HALF_XY) * RES_PC
    gz = (np.arange(SUB_Z, dtype=np.float32) - SUB_HALF_Z) * RES_PC

    # Z-slab loop keeps peak memory modest; the supersample loop on the
    # outside lets us reuse the (SUB_XY, SUB_XY) X/Y broadcast arrays.
    out = np.zeros((SUB_Z, SUB_XY, SUB_XY), dtype=np.float32)
    for ox in offs:
        for oy in offs:
            for oz in offs:
                X = np.broadcast_to(gx[np.newaxis, :] + ox, (SUB_XY, SUB_XY))
                Y = np.broadcast_to(gy[:, np.newaxis] + oy, (SUB_XY, SUB_XY))
                for zi, zc in enumerate(gz):
                    Z = zc + oz
                    r = np.sqrt(X * X + Y * Y + Z * Z)
                    lon = np.degrees(np.arctan2(Y, X))
                    lat = np.degrees(np.arcsin(np.clip(Z / np.maximum(r, 1e-6), -1.0, 1.0)))
                    slab = _sample_sphere(data, radii, nside, nest,
                                          lon.ravel(), lat.ravel(), r.ravel())
                    out[zi] += slab.reshape(SUB_XY, SUB_XY)

    out /= SUPERSAMPLE ** 3
    return out


def _sample_sphere(data, radii, nside, nest, lon, lat, dist):
    """Bilinear angular + linear radial interpolation of the HEALPix cube.

    Mirrors `_interp_hpxr2lbd` from `dustmaps.edenhofer2023`, but clamps
    out-of-range distances to 0 instead of NaN so the Local Bubble /
    far-edge voxels stay dust-free instead of poisoning downstream math.
    """
    idx_pos, wgt_pos = hp.pixelfunc.get_interp_weights(
        nside, lon, lat, nest=nest, lonlat=True,
    )

    idx_r = np.searchsorted(radii, dist)
    idx_l = idx_r - 1
    out_of_range = (idx_l < 0) | (idx_r >= radii.size)
    idx_l = idx_l.clip(0, radii.size - 1)
    idx_r = idx_r.clip(0, radii.size - 1)

    r_lo = radii[idx_l]
    r_hi = radii[idx_r]
    denom = np.maximum(r_hi - r_lo, 1e-12)
    w_lo = (r_hi - dist) / denom
    w_hi = 1.0 - w_lo

    result = np.zeros(lon.size, dtype=np.float32)
    for k in range(4):
        p = idx_pos[k]
        wp = wgt_pos[k]
        v_lo = data[idx_l, p]
        v_hi = data[idx_r, p]
        result += wp * (w_lo * v_lo + w_hi * v_hi)

    result[out_of_range] = 0.0
    return result


def load_and_downsample():
    """Public wrapper matching the old interface; returns the density array."""
    data, radii, nside, nest = load_healpix_cube()
    density = resample_to_cartesian(data, radii, nside, nest)

    # Posterior mean can dip slightly negative in voids
    density = np.clip(density, 0, None)

    nonzero = density[density > 0]
    if len(nonzero) > 0:
        thresh = np.percentile(nonzero, 5)
        density[density < thresh] = 0
        print(f"  Threshold at {thresh:.5f} (5th percentile of non-zero)")

    # Edenhofer preserves sharp cloud cores that Lallement's 10 pc grid
    # blurred out, so the raw distribution is long-tailed: the median
    # non-zero voxel is ~1% of the max. Normalizing by max would quantize
    # every typical cloud voxel into the bottom 2-3 of 255 uint8 codes
    # and the runtime render would look nearly empty. Normalize against
    # the 99.5th percentile instead, clipping the brightest ~0.06% of
    # cloud cores. They saturate at 1.0 either way once the shader's
    # magnitude/opacity scaling hits; we lose essentially nothing and
    # the rest of the dynamic range opens up by ~10×.
    nonzero = density[density > 0]
    if len(nonzero) > 0:
        norm = np.percentile(nonzero, 99.5)
        density = (density / norm).clip(0, 1)
        print(f"  Normalize by 99.5th pct ({norm:.5f}); post-norm median = {np.median(density[density > 0]):.3f}")
    return density


def load_hot_stars(csv_paths):
    eq_to_gal = equatorial_to_galactic_matrix()

    def iter_rows(paths):
        first = True
        for p in paths:
            opener = gzip.open if p.endswith(".gz") else open
            with opener(p, "rt") as f:
                if first:
                    yield from f
                    first = False
                else:
                    next(f, None)
                    yield from f

    stars = []
    reader = csv.DictReader(iter_rows(csv_paths))
    for row in reader:
        spect = row.get("spect", "").strip()
        if not spect:
            continue
        first = spect[0]
        if first not in ("O", "B"):
            continue
        try:
            x = float(row.get("x0", "").strip() or "0")
            y = float(row.get("y0", "").strip() or "0")
            z = float(row.get("z0", "").strip() or "0")
            dist_pc = float(row.get("dist", "").strip() or "0")
        except ValueError:
            continue
        if dist_pc <= 0 or dist_pc > 1200:
            continue

        gal = eq_to_gal @ np.array([x, y, z])
        gx, gy, gz = float(gal[0]), float(gal[1]), float(gal[2])

        is_ionizing = first == "O" or (first == "B" and len(spect) > 1 and spect[1] in "012")

        try:
            absmag = float(row.get("absmag", "").strip() or "10")
        except ValueError:
            absmag = 10.0
        luminosity = 10 ** ((4.74 - absmag) / 2.5)
        uv_weight = luminosity ** 0.7

        stars.append((gx, gy, gz, is_ionizing, uv_weight))

    print(f"  Hot stars loaded: {len(stars)} ({sum(1 for s in stars if s[3])} ionizing)")
    return stars


def bake_illumination(density, hot_stars):
    nz, ny, nx = density.shape
    ion_flux = np.zeros_like(density)
    scat_flux = np.zeros_like(density)
    R = ILLUM_RADIUS_VOXELS
    R_sq = R * R

    for sx, sy, sz, is_ionizing, uv_weight in hot_stars:
        vx = sx / RES_PC + SUB_HALF_XY
        vy = sy / RES_PC + SUB_HALF_XY
        vz = sz / RES_PC + SUB_HALF_Z

        ix0 = max(0, int(vx) - R)
        ix1 = min(nx, int(vx) + R + 1)
        iy0 = max(0, int(vy) - R)
        iy1 = min(ny, int(vy) + R + 1)
        iz0 = max(0, int(vz) - R)
        iz1 = min(nz, int(vz) + R + 1)
        if ix0 >= ix1 or iy0 >= iy1 or iz0 >= iz1:
            continue

        sub_density = density[iz0:iz1, iy0:iy1, ix0:ix1]
        dz = np.arange(iz0, iz1, dtype=np.float32)[:, None, None] - vz
        dy = np.arange(iy0, iy1, dtype=np.float32)[None, :, None] - vy
        dx = np.arange(ix0, ix1, dtype=np.float32)[None, None, :] - vx
        r_sq = np.maximum(dx * dx + dy * dy + dz * dz, 1.0)

        mask = (sub_density > 0) & (r_sq <= R_sq)
        flux = np.where(mask, uv_weight / r_sq, 0.0).astype(np.float32)
        scat_flux[iz0:iz1, iy0:iy1, ix0:ix1] += flux
        if is_ionizing:
            ion_flux[iz0:iz1, iy0:iy1, ix0:ix1] += flux

    for arr, name in [(ion_flux, "ionizing"), (scat_flux, "scattering")]:
        mask = arr > 0
        if mask.any():
            arr[mask] = np.log1p(arr[mask])
            arr[mask] /= arr[mask].max()
        print(f"  {name} flux: {mask.sum()} illuminated voxels")

    return ion_flux, scat_flux


def write_output(density, ion_flux, scat_flux):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    nz, ny, nx = density.shape

    r = (density * 255).clip(0, 255).astype(np.uint8)
    g = (ion_flux * 255).clip(0, 255).astype(np.uint8)
    b = (scat_flux * 255).clip(0, 255).astype(np.uint8)
    a = np.full_like(r, 255)

    rgba = np.stack([r, g, b, a], axis=-1)
    out_path = os.path.join(OUTPUT_DIR, "dust_volume_rgba.bin")
    rgba.tofile(out_path)
    size_mb = os.path.getsize(out_path) / 1e6
    print(f"Wrote {out_path} ({size_mb:.1f} MB)")

    meta = {
        "shape": [nz, ny, nx],
        "resolution_pc": RES_PC,
        "center_pc": [0, 0, 0],
        "extent_pc": [nx * RES_PC, ny * RES_PC, nz * RES_PC],
        "axes": "Galactic Cartesian: X toward GC, Y toward rotation, Z toward NGP",
        "source": "Edenhofer et al. 2024, A&A 685, A82 (Zenodo 8187943, HEALPix variant)",
        "supersample": SUPERSAMPLE,
        "units": "normalized dust extinction density (posterior mean)",
        "format": "RGBA uint8: R=density, G=ionizing_flux, B=scattering_flux, A=255",
        "channels": 4,
    }
    meta_path = os.path.join(OUTPUT_DIR, "dust_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote {meta_path}")


def main():
    data_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    athyg_dir = os.path.join(data_dir, "vendor", "athyg", "data")
    csv_paths = sorted(
        [os.path.join(athyg_dir, f) for f in os.listdir(athyg_dir)
         if f.startswith("athyg_v33") and f.endswith(".csv.gz")],
    ) if os.path.isdir(athyg_dir) else []

    if not csv_paths:
        print("WARNING: No AT-HYG CSV files found in vendor/athyg/data/")
        print("  Hot-star illumination will be skipped (density-only bake)")

    download_fits()
    density = load_and_downsample()

    if csv_paths:
        print("Loading hot stars for illumination...")
        hot_stars = load_hot_stars(csv_paths)
        print("Baking illumination (this may take a few minutes)...")
        ion_flux, scat_flux = bake_illumination(density, hot_stars)
    else:
        ion_flux = np.zeros_like(density)
        scat_flux = np.zeros_like(density)

    write_output(density, ion_flux, scat_flux)
    print("Done.")


if __name__ == "__main__":
    main()
