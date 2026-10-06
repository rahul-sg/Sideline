"""Score video-derived positions against NFL tracking for the same play.

    python -m sideline_vision.evaluate out/hill/tracks.json --game 2017090700 --play 2756 --direction right

Time alignment: the snap is found in the video as the moment players start moving
together, then nudged (±1 s) to whatever offset best matches the tracking. At each
10 Hz instant, video positions are matched one-to-one to tracked players (Hungarian
assignment); matches within 5 yards count. Reports the distance error in yards.
"""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

ROOT = Path(__file__).resolve().parents[2]
FIELD_W = 160 / 3
GATE = 5.0


def load_truth(game: int, play: int):
    g = json.loads(gzip.decompress((ROOT / "public/data/games" / f"{game}.json.gz").read_bytes()))
    p = next(x for x in g["plays"] if x["playId"] == play)
    X = np.array(p["x"]) / 10
    Y = np.array(p["y"]) / 10
    return p, X, Y


def video_snap(res) -> float:
    """Snap = first instant the median player speed passes 2.5 yd/s and stays above 2 for
    half a second. Each track's first 0.3 s is ignored (new tracks jitter)."""
    grid = sorted({t for tr in res["tracks"] for t in tr["t"]})
    series = []
    for t in grid:
        v = []
        for tr in res["tracks"]:
            if t in tr["t"]:
                i = tr["t"].index(t)
                if i >= 3:
                    v.append(np.hypot(tr["x"][i] - tr["x"][i - 3], tr["y"][i] - tr["y"][i - 3]) * 10 / 3)
        series.append((t, float(np.median(v)) if len(v) >= 5 else 0.0))
    for k, (t, s) in enumerate(series):
        if s > 2.5 and all(x > 2.0 for _, x in series[k:k + 5]):
            return t - 0.3  # speed is measured over the previous 0.3 s
    return grid[0]


def positions_at(res, t, flip):
    pts = []
    for tr in res["tracks"]:
        if tr["team"] == "other":
            continue
        if tr["t"] and tr["t"][0] - 1e-6 <= t <= tr["t"][-1] + 1e-6:
            x = float(np.interp(t, tr["t"], tr["x"]))
            y = float(np.interp(t, tr["t"], tr["y"]))
            if flip:
                x, y = 120 - x, FIELD_W - y
            pts.append((x, y))
    return np.array(pts)


def score_offset(res, X, Y, snap_frame, snap_video, offset, flip):
    errs, matched, seen = [], 0, 0
    times = sorted({t for tr in res["tracks"] for t in tr["t"]})
    for t in times:
        f = snap_frame + (t - snap_video + offset) * 10
        if f < 0 or f > X.shape[1] - 1:
            continue
        vid = positions_at(res, t, flip)
        if not len(vid):
            continue
        fi = int(round(f))
        truth = np.c_[X[:, fi], Y[:, fi]]
        C = np.linalg.norm(vid[:, None, :] - truth[None, :, :], axis=2)
        r, c = linear_sum_assignment(C)
        d = C[r, c]
        seen += len(vid)
        good = d < GATE
        matched += good.sum()
        errs.extend(d[good].tolist())
    return np.array(errs), matched, seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tracks", type=Path)
    ap.add_argument("--game", type=int, required=True)
    ap.add_argument("--play", type=int, required=True)
    ap.add_argument("--direction", choices=["left", "right"], required=True, help="Offense direction on screen")
    a = ap.parse_args()

    res = json.loads(a.tracks.read_text())
    play, X, Y = load_truth(a.game, a.play)
    flip = a.direction == "left"
    sv = video_snap(res)
    best = None
    for off in np.arange(-1.0, 1.01, 0.1):  # small correction around the detected snap
        errs, m, n = score_offset(res, X, Y, play["snap"], sv, off, flip)
        if len(errs) and (best is None or (np.median(errs), -m) < (np.median(best[1]), -best[2])):
            best = (off, errs, m, n)
    off, errs, m, n = best
    print(f"{play['desc'][:80]}")
    print(f"video snap ≈ {sv:.1f}s (offset {off:+.1f}s); {n} video positions, {m} matched within {GATE} yd ({m / n:.0%})")
    print(f"error: median {np.median(errs):.2f} yd · mean {errs.mean():.2f} yd · 90th pct {np.percentile(errs, 90):.2f} yd")


if __name__ == "__main__":
    main()
