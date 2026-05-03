#!/usr/bin/env python3
"""Download all-sky Milky Way panorama backdrop into dist/tiles/.

Source: ESO/S. Brunier "The Milky Way panorama" (eso0932a, 2009),
6000×3000 px equirectangular in galactic coordinates (galactic plane =
horizontal middle row, galactic centre at u=0.5). CC-BY 4.0. Mirrored
on Wikimedia Commons.

Downsampled to 4096×2048 JPEG q=88, then run through a 9-pixel median
filter to erase resolved-star pinpoints. Drake renders its own
catalog stars in the foreground, and a panorama with embedded stars
produces visible double-stars wherever the two overlap. Median filter
size is large enough to swallow stellar PSFs (~2-3 px FWHM at this
scale) without blurring the diffuse galactic glow or the wide dust
lanes (tens of pixels across) that we want the backdrop to provide.

The runtime (`src/skybox.ts`) samples this with the inverse of the
equatorial-scene → galactic rotation already in `src/dust.ts`, so the
panorama's galactic plane registers exactly with the existing dust
volume.
"""

import io
import os
import sys
import urllib.request

URL = (
    "https://upload.wikimedia.org/wikipedia/commons/"
    "6/60/ESO_-_Milky_Way.jpg"
)
DEST = "dist/tiles/skybox.jpg"
SIZE = (4096, 2048)


def main() -> int:
    if os.path.exists(DEST):
        print(f"{DEST} already exists; delete to refetch")
        return 0
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    print(f"Fetching {URL} ...")
    req = urllib.request.Request(URL, headers={"User-Agent": "drake-fetch-skybox"})
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
    print(f"  got {len(data) // 1024} KB; resizing to {SIZE[0]}×{SIZE[1]}")
    from PIL import Image, ImageFilter
    import numpy as np
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert("RGB").resize(SIZE, Image.LANCZOS)
        print("  median-filtering to erase resolved stars (this takes a moment)")
        # Wrap-pad horizontally before filtering so the median sees real
        # neighbours across the longitude=±180° seam — without this, PIL's
        # default edge clamping gives the leftmost and rightmost columns
        # a different filter footprint than the interior, breaking wrap
        # continuity and leaving a visible meridian seam at runtime.
        pad = 32
        arr = np.array(im)
        padded = np.concatenate([arr[:, -pad:], arr, arr[:, :pad]], axis=1)
        padded_im = Image.fromarray(padded).filter(ImageFilter.MedianFilter(size=9))
        arr = np.array(padded_im)[:, pad:pad + SIZE[0]].astype(np.float32)

        # Feather-blend the leftmost and rightmost N columns so the
        # source panorama's residual wrap discontinuity (~0.9/255 after
        # median, vs ~0.15 baseline) collapses to zero at the seam.
        # Linear feather: the strip at distance t from the seam blends
        # (1 − 0.5t)·own + 0.5(1 − t)·opposite. At t=0 (seam) both sides
        # are exactly the average of the original left and right edges,
        # so they match. At t=1 (strip edge) the original content is
        # preserved.
        N = 16
        H, W, _ = arr.shape
        for i in range(N):
            t = i / N
            w = 0.5 * (1.0 - t)
            left_orig = arr[:, i].copy()
            right_orig = arr[:, W - 1 - i].copy()
            arr[:, i] = (1.0 - w) * left_orig + w * right_orig
            arr[:, W - 1 - i] = (1.0 - w) * right_orig + w * left_orig

        im = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
        # q=95 (vs the typical 88) keeps DCT quantization noise low
        # enough that the seam blend isn't undone — q=88 reintroduces
        # ~0.4/255 of column-to-column variation at the boundary that's
        # visible against a dark backdrop. The median filter already
        # stripped most of the high-frequency content the source panorama
        # had, so the file is still small (~400 KB at q=95).
        im.save(DEST, format="JPEG", quality=95)
    print(f"  wrote {DEST} ({os.path.getsize(DEST) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
