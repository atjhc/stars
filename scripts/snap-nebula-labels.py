#!/usr/bin/env python3
"""Snap nebula label positions to the nearest emission peak in the baked dust volume.

Reads data/nebulae.json and dist/tiles/dust_volume_rgba.bin, finds the
strongest emission peak within SEARCH_RADIUS_PC of each label's current
position, and updates the position. Each label claims a unique peak
(greedy by emission strength) so no two labels overlap.

Run after bake-dust.py and before build-catalog.py.
"""

import json
import os
import numpy as np
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOLUME_PATH = os.path.join(ROOT, "dist", "tiles", "dust_volume_rgba.bin")
META_PATH = os.path.join(ROOT, "dist", "tiles", "dust_meta.json")
NEBULAE_PATH = os.path.join(ROOT, "data", "nebulae.json")
SEARCH_RADIUS_PC = 80
PEAK_SEPARATION_PC = 35


def main():
    with open(META_PATH) as f:
        meta = json.load(f)
    nz, ny, nx = meta["shape"]
    res_pc = meta["resolution_pc"]
    half_xy = (nx - 1) // 2
    half_z = (nz - 1) // 2

    data = np.fromfile(VOLUME_PATH, dtype=np.uint8).reshape(nz, ny, nx, 4)
    density = data[:, :, :, 0].astype(float)
    ion = data[:, :, :, 1].astype(float)
    scat = data[:, :, :, 2].astype(float)
    emission = (ion + scat) * density

    # Scale the maximum_filter footprint so the physical peak-separation
    # stays ~constant across bakes at different resolutions. `| 1` forces
    # an odd footprint so the filter window is symmetric.
    filter_size = max(3, int(round(PEAK_SEPARATION_PC / res_pc)) | 1)
    dilated = ndimage.maximum_filter(emission, size=filter_size)
    peaks_mask = (emission == dilated) & (emission > 1000)
    zz, yy, xx = np.where(peaks_mask)
    vals = emission[peaks_mask]

    with open(NEBULAE_PATH) as f:
        nebulae = json.load(f)

    claimed = set()
    for name, ndef in nebulae.items():
        gx, gy, gz = ndef["pos_pc"]
        ix = gx / res_pc + half_xy
        iy = gy / res_pc + half_xy
        iz = gz / res_pc + half_z

        candidates = []
        for pi in range(len(zz)):
            if pi in claimed:
                continue
            dx = (xx[pi] - ix) * res_pc
            dy = (yy[pi] - iy) * res_pc
            dz = (zz[pi] - iz) * res_pc
            d = (dx * dx + dy * dy + dz * dz) ** 0.5
            if d > SEARCH_RADIUS_PC:
                continue
            candidates.append((vals[pi], d, pi))

        candidates.sort(key=lambda c: (-c[0], c[1]))
        if candidates:
            _, dist, pi = candidates[0]
            claimed.add(pi)
            new_pos = [
                int((xx[pi] - half_xy) * res_pc),
                int((yy[pi] - half_xy) * res_pc),
                int((zz[pi] - half_z) * res_pc),
            ]
            old = ndef["pos_pc"]
            moved = dist > 0
            ndef["pos_pc"] = new_pos
            status = f"moved {dist:.0f} pc" if moved else "unchanged"
            em = vals[pi]
            print(f"  {name:30s} ({old[0]:5d},{old[1]:5d},{old[2]:5d}) → ({new_pos[0]:5d},{new_pos[1]:5d},{new_pos[2]:5d})  em={em:.0f}  {status}")
        else:
            print(f"  {name:30s} — no peak within {SEARCH_RADIUS_PC} pc (keeping original)")

    positions = {}
    for name, ndef in nebulae.items():
        key = tuple(ndef["pos_pc"])
        if key in positions:
            print(f"  WARNING: {name} and {positions[key]} share position {key}")
        positions[key] = name

    with open(NEBULAE_PATH, "w") as f:
        json.dump(nebulae, f, indent=2)
    print(f"Updated {NEBULAE_PATH}")


if __name__ == "__main__":
    main()
