"""Shared helpers for the Sideline data pipeline."""
from __future__ import annotations

import gzip
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "pipeline" / "raw"
OUT = ROOT / "public" / "data"

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"


def write_json(path: Path, obj, gz: bool = False) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(obj, separators=(",", ":"), allow_nan=False).encode()
    if gz:
        data = gzip.compress(data, compresslevel=9, mtime=0)
    path.write_bytes(data)
    return len(data)


def clean(v):
    """Convert pandas/numpy scalars to JSON-safe Python values (NaN -> None)."""
    if v is None:
        return None
    try:
        import math
        if isinstance(v, float) and math.isnan(v):
            return None
    except Exception:
        pass
    if hasattr(v, "item"):
        v = v.item()
        if isinstance(v, float) and v != v:
            return None
    return v


def team_colors() -> dict:
    import pandas as pd

    t = pd.read_csv(RAW / "teams_colors_logos.csv")
    out = {}
    for r in t.itertuples():
        out[r.team_abbr] = {
            "name": r.team_name,
            "nick": r.team_nick,
            "primary": r.team_color,
            "secondary": r.team_color2,
            "tertiary": clean(r.team_color3),
        }
    return out
