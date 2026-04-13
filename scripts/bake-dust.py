#!/usr/bin/env python3
"""
Bake the Lallement/Vergely (2022) 3D extinction cube into the RGBA texture
consumed by Drake's volumetric dust renderer.

Input:  data/dust/cube_ext.fits.gz  (601×601×81 FITS, 10 pc/voxel)
Output: dist/tiles/dust_volume_rgba.bin  (201×201×81 RGBA uint8)
        dist/tiles/dust_meta.json

The source FITS is downloaded automatically if missing.

Pipeline:
  1. Extract ±1000 pc sub-cube (201×201×81) centered on Sol
  2. Threshold low-density voxels (Local Bubble cleanup)
  3. Compute hot-star illumination from O/B stars in the AT-HYG catalog
  4. Bake into RGBA: R=density, G=ionizing flux, B=scattering flux, A=255
"""

import os
import sys
import json
import math
import struct
import gzip
import csv
import urllib.request
import numpy as np

FITS_URL = "https://cdsarc.cds.unistra.fr/ftp/J/A+A/661/A147/cube_ext.fits.gz"
FITS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "data", "cache", "cube_ext.fits.gz")
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "dist", "tiles")

# Sub-cube: ±1000 pc = 201 voxels per axis at 10 pc resolution
# Full cube is 601×601×81 centered at origin, 10 pc/voxel
# X,Y range: -3000..+3000 pc → indices 0..600
# Z range:   -400..+400 pc  → indices 0..80
FULL_XY = 601
FULL_Z = 81
RES_PC = 10
SUB_HALF_XY = 100  # ±1000 pc = 100 voxels each side
SUB_XY = 2 * SUB_HALF_XY + 1  # 201
SUB_Z = FULL_Z  # keep full Z range (±400 pc)
CENTER_XY = FULL_XY // 2  # index 300 = Sol

# Illumination parameters
ILLUM_RADIUS_PC = 150  # max distance for hot-star flux contribution
ILLUM_RADIUS_VOXELS = ILLUM_RADIUS_PC // RES_PC


def equatorial_to_galactic_matrix():
    """Build rotation matrix from equatorial Cartesian to galactic Cartesian.

    AT-HYG x0/y0/z0 are equatorial: x→RA=0, y→RA=90°, z→Dec=+90°.
    Dust cube is galactic: X→GC, Y→rotation, Z→NGP.
    """
    ra_ngp = np.radians(192.85948)
    dec_ngp = np.radians(27.12835)
    l_ncp = np.radians(122.93192)
    cos_ra, sin_ra = np.cos(ra_ngp), np.sin(ra_ngp)
    cos_dec, sin_dec = np.cos(dec_ngp), np.sin(dec_ngp)
    cos_l, sin_l = np.cos(l_ncp), np.sin(l_ncp)
    # R: galactic → equatorial (from build-catalog.py)
    R = np.array([
        [-sin_ra * sin_l - cos_ra * sin_dec * cos_l,  sin_ra * cos_l - cos_ra * sin_dec * sin_l,  cos_ra * cos_dec],
        [ cos_ra * sin_l - sin_ra * sin_dec * cos_l, -cos_ra * cos_l - sin_ra * sin_dec * sin_l,  sin_ra * cos_dec],
        [ cos_dec * cos_l,                             cos_dec * sin_l,                             sin_dec          ],
    ])
    # Inverse: equatorial → galactic
    return R.T


def download_fits():
    """Download the FITS cube if not already cached."""
    if os.path.exists(FITS_PATH):
        print(f"Using cached {FITS_PATH}")
        return
    os.makedirs(os.path.dirname(FITS_PATH), exist_ok=True)
    print(f"Downloading {FITS_URL} ...")
    urllib.request.urlretrieve(FITS_URL, FITS_PATH)
    print(f"Saved to {FITS_PATH} ({os.path.getsize(FITS_PATH) / 1e6:.1f} MB)")


def load_fits_cube():
    """Load the extinction cube from the FITS file."""
    try:
        from astropy.io import fits
    except ImportError:
        print("ERROR: astropy is required. Install with: pip3 install astropy", file=sys.stderr)
        sys.exit(1)

    print("Loading FITS cube...")
    with fits.open(FITS_PATH) as hdul:
        cube = hdul[0].data.astype(np.float32)
    print(f"  Full cube shape: {cube.shape}")  # (81, 601, 601)
    return cube


def extract_subcube(cube):
    """Extract the ±1000 pc sub-cube centered on Sol."""
    x0 = CENTER_XY - SUB_HALF_XY
    x1 = CENTER_XY + SUB_HALF_XY + 1
    sub = cube[:, x0:x1, x0:x1].copy()
    print(f"  Sub-cube shape: {sub.shape}")  # (81, 201, 201)

    # Threshold: set values below 95th percentile of non-zero voxels to 0
    # This clears the Local Bubble (~50 pc around Sol)
    nonzero = sub[sub > 0]
    if len(nonzero) > 0:
        thresh = np.percentile(nonzero, 5)
        sub[sub < thresh] = 0
        print(f"  Threshold at {thresh:.4f} (5th percentile of non-zero)")

    # Normalize to 0..1
    maxval = sub.max()
    if maxval > 0:
        sub /= maxval
    print(f"  Density range after normalize: {sub.min():.3f} .. {sub.max():.3f}")
    return sub


def load_hot_stars(csv_paths):
    """Load O and B type stars from AT-HYG, converted to galactic Cartesian."""
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

        # Convert equatorial Cartesian → galactic Cartesian
        gal = eq_to_gal @ np.array([x, y, z])
        gx, gy, gz = float(gal[0]), float(gal[1]), float(gal[2])

        is_ionizing = first == "O" or (first == "B" and len(spect) > 1 and spect[1] in "012")

        # Weight by luminosity — UV flux scales with bolometric luminosity
        try:
            absmag = float(row.get("absmag", "").strip() or "10")
        except ValueError:
            absmag = 10.0
        luminosity = 10 ** ((4.74 - absmag) / 2.5)
        # UV fraction is higher for hotter stars; rough scaling
        uv_weight = luminosity ** 0.7

        stars.append((gx, gy, gz, is_ionizing, uv_weight))

    print(f"  Hot stars loaded: {len(stars)} ({sum(1 for s in stars if s[3])} ionizing)")
    return stars


def bake_illumination(density, hot_stars):
    """Compute ionizing and scattering flux for each dust voxel."""
    nz, ny, nx = density.shape
    ion_flux = np.zeros_like(density)
    scat_flux = np.zeros_like(density)

    for sx, sy, sz, is_ionizing, uv_weight in hot_stars:
        # Convert galactic Cartesian (pc) to voxel indices
        # Sub-cube covers ±1000 pc in X,Y; ±400 pc in Z
        vx = sx / RES_PC + SUB_HALF_XY  # 0..200
        vy = sy / RES_PC + SUB_HALF_XY
        vz = sz / RES_PC + (FULL_Z // 2)

        # Integer bounds for the search region
        ix0 = max(0, int(vx) - ILLUM_RADIUS_VOXELS)
        ix1 = min(nx, int(vx) + ILLUM_RADIUS_VOXELS + 1)
        iy0 = max(0, int(vy) - ILLUM_RADIUS_VOXELS)
        iy1 = min(ny, int(vy) + ILLUM_RADIUS_VOXELS + 1)
        iz0 = max(0, int(vz) - ILLUM_RADIUS_VOXELS)
        iz1 = min(nz, int(vz) + ILLUM_RADIUS_VOXELS + 1)

        for iz in range(iz0, iz1):
            for iy in range(iy0, iy1):
                for ix in range(ix0, ix1):
                    if density[iz, iy, ix] == 0:
                        continue
                    dx = ix - vx
                    dy = iy - vy
                    dz = iz - vz
                    r_sq = dx * dx + dy * dy + dz * dz
                    if r_sq < 1:
                        r_sq = 1
                    if r_sq > ILLUM_RADIUS_VOXELS * ILLUM_RADIUS_VOXELS:
                        continue
                    flux = uv_weight / r_sq
                    if is_ionizing:
                        ion_flux[iz, iy, ix] += flux
                    scat_flux[iz, iy, ix] += flux

    # Log-scale and normalize to 0..1
    for arr, name in [(ion_flux, "ionizing"), (scat_flux, "scattering")]:
        mask = arr > 0
        if mask.any():
            arr[mask] = np.log1p(arr[mask])
            arr[mask] /= arr[mask].max()
        print(f"  {name} flux: {mask.sum()} illuminated voxels")

    return ion_flux, scat_flux


def write_output(density, ion_flux, scat_flux):
    """Write RGBA binary and metadata JSON."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    nz, ny, nx = density.shape

    # Pack into RGBA uint8
    r = (density * 255).clip(0, 255).astype(np.uint8)
    g = (ion_flux * 255).clip(0, 255).astype(np.uint8)
    b = (scat_flux * 255).clip(0, 255).astype(np.uint8)
    a = np.full_like(r, 255)

    rgba = np.stack([r, g, b, a], axis=-1)  # (Z, Y, X, 4)
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
        "source": "Lallement/Vergely 2022, A&A 661, A147",
        "units": "normalized log extinction density",
        "format": "RGBA uint8: R=density, G=ionizing_flux, B=scattering_flux, A=255",
        "channels": 4,
    }
    meta_path = os.path.join(OUTPUT_DIR, "dust_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote {meta_path}")


def main():
    data_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # Find AT-HYG CSV files for hot-star illumination
    athyg_dir = os.path.join(data_dir, "vendor", "athyg", "data")
    csv_paths = sorted(
        [os.path.join(athyg_dir, f) for f in os.listdir(athyg_dir)
         if f.startswith("athyg_v33") and f.endswith(".csv.gz")],
    ) if os.path.isdir(athyg_dir) else []

    if not csv_paths:
        print("WARNING: No AT-HYG CSV files found in vendor/athyg/data/")
        print("  Hot-star illumination will be skipped (density-only bake)")

    download_fits()
    cube = load_fits_cube()
    density = extract_subcube(cube)

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
