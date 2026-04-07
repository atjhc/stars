#!/usr/bin/env python3
"""
Merge research-agent output JSON files into data/augmentations.json.

Each input file is expected to contain a single JSON object whose keys are
star names (exactly matching the `name` field emitted by audit-notable.py)
and whose values are partial augmentation entries (wikipedia / notes /
aliases / etc.). Merging is per-key: new fields overwrite, other fields
on the existing entry are preserved.

Usage:
    python3 scripts/merge-augmentations.py <file1.json> [file2.json ...]

Paths may be globs when passed through the shell.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUG_PATH = ROOT / "data" / "augmentations.json"


def main(paths: list[str]):
    if not paths:
        print(f"usage: {sys.argv[0]} <file1.json> [file2.json ...]", file=sys.stderr)
        sys.exit(1)

    with open(AUG_PATH) as f:
        aug = json.load(f)

    merged = 0
    new_entries = 0
    for path in paths:
        p = Path(path)
        if not p.exists():
            print(f"skip: {p} does not exist", file=sys.stderr)
            continue
        with open(p) as f:
            batch = json.load(f)
        for name, entry in batch.items():
            if not isinstance(entry, dict):
                print(f"skip: {p}::{name} is not an object", file=sys.stderr)
                continue
            if name not in aug:
                new_entries += 1
            existing = aug.get(name, {})
            existing.update(entry)
            aug[name] = existing
            merged += 1

    with open(AUG_PATH, "w") as f:
        json.dump(aug, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"merged {merged} entries ({new_entries} new) into {AUG_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main(sys.argv[1:])
