#!/usr/bin/env python3
"""Snap nebula label positions to the nearest emission peak in the baked dust volume.

Reads data/nebulae.json and dist/tiles/dust_volume_rgba.bin, finds the
strongest emission peak within 150 pc of each label's current position,
and updates the position. Each label claims a unique peak (greedy by
emission strength) so no two labels overlap.

Run after bake-dust.py and before build-catalog.py.
"""

import json
import os
import numpy as np
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOLUME_PATH = os.path.join(ROOT, "dist", "tiles", "dust_volume_rgba.bin")
NEBULAE_PATH = os.path.join(ROOT, "data", "nebulae.json")
RES_PC = 10
HALF_XY = 100
HALF_Z = 40
SEARCH_RADIUS_PC = 80


def main():
    data = np.fromfile(VOLUME_PATH, dtype=np.uint8).reshape(81, 201, 201, 4)
    density = data[:, :, :, 0].astype(float)
    ion = data[:, :, :, 1].astype(float)
    scat = data[:, :, :, 2].astype(float)
    emission = (ion + scat) * density

    # Find all significant local peaks
    dilated = ndimage.maximum_filter(emission, size=7)
    peaks_mask = (emission == dilated) & (emission > 1000)
    zz, yy, xx = np.where(peaks_mask)
    vals = emission[peaks_mask]

    with open(NEBULAE_PATH) as f:
        nebulae = json.load(f)

    # Greedy assignment: each label claims the strongest unclaimed peak nearby
    claimed = set()
    for name, ndef in nebulae.items():
        gx, gy, gz = ndef["pos_pc"]
        ix = gx / RES_PC + HALF_XY
        iy = gy / RES_PC + HALF_XY
        iz = gz / RES_PC + HALF_Z

        candidates = []
        for pi in range(len(zz)):
            if pi in claimed:
                continue
            dx = (xx[pi] - ix) * RES_PC
            dy = (yy[pi] - iy) * RES_PC
            dz = (zz[pi] - iz) * RES_PC
            d = (dx * dx + dy * dy + dz * dz) ** 0.5
            if d > SEARCH_RADIUS_PC:
                continue
            candidates.append((vals[pi], d, pi))

        candidates.sort(key=lambda c: (-c[0], c[1]))
        if candidates:
            _, dist, pi = candidates[0]
            claimed.add(pi)
            new_pos = [
                int((xx[pi] - HALF_XY) * RES_PC),
                int((yy[pi] - HALF_XY) * RES_PC),
                int((zz[pi] - HALF_Z) * RES_PC),
            ]
            old = ndef["pos_pc"]
            moved = dist > 0
            ndef["pos_pc"] = new_pos
            status = f"moved {dist:.0f} pc" if moved else "unchanged"
            em = vals[pi]
            print(f"  {name:30s} ({old[0]:5d},{old[1]:5d},{old[2]:5d}) → ({new_pos[0]:5d},{new_pos[1]:5d},{new_pos[2]:5d})  em={em:.0f}  {status}")
        else:
            print(f"  {name:30s} — no peak within {SEARCH_RADIUS_PC} pc (keeping original)")

    # Check for duplicate positions
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
