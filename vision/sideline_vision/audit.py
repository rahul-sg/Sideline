"""Contact sheet of jersey reads for checking by eye.

    python -m sideline_vision.audit out/batch videos/game.mp4 --game 2017090700 --out out/jersey_audit.jpg

For each named track in a batch run (same rules as the app export: ≥2 sightings, most of
the votes), four of its largest crops are shown next to the number that was read.
"""
from __future__ import annotations

import argparse
import gzip
import json
import random
from pathlib import Path

import cv2
import numpy as np

from .export import MIN_READS, MIN_SHARE, load_on_field, roster_from_json

ROOT = Path(__file__).resolve().parents[2]


def main():
    from .batch import jersey_names

    ap = argparse.ArgumentParser()
    ap.add_argument("batch", type=Path)
    ap.add_argument("video")
    ap.add_argument("--game", type=int, required=True)
    ap.add_argument("--out", type=Path, default=Path("out/jersey_audit.jpg"))
    ap.add_argument("--n", type=int, default=30)
    a = ap.parse_args()

    plays = {p["playId"]: p for p in json.loads(gzip.decompress(
        (ROOT / "public/data/games" / f"{a.game}.json.gz").read_bytes()))["plays"]}
    results = json.loads((a.batch / "results.json").read_text())["plays"]
    named = []
    for r in results:
        raw = a.batch / str(r["playId"]) / "jerseys_raw.json"
        if r["status"] != "ok" or not raw.exists():
            continue
        res = json.loads((a.batch / str(r["playId"]) / "tracks.json").read_text())
        saved = json.loads(raw.read_text())
        p = plays[r["playId"]]
        field = load_on_field(p["season"], p["week"], a.game, p["playId"]) or roster_from_json(saved["field"])
        for tid, j in jersey_names(res, saved["votes"], field, plays[r["playId"]], r).items():
            if j["reads"] >= MIN_READS and j["confidence"] >= MIN_SHARE and (j["team"], j["number"]) in field:
                tr = next(t for t in res["tracks"] if t["id"] == tid)
                named.append((r["playId"], tid, j["number"], field[(j["team"], j["number"])][0], tr["boxes"]))
    random.Random(0).shuffle(named)
    cap = cv2.VideoCapture(a.video)
    rows = []
    for play, tid, num, name, boxes in named[: a.n]:
        tiles = []
        for t, *box in sorted(boxes, key=lambda b: b[4] - b[2])[-4:]:  # tallest
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
            if not ok:
                continue
            x0, y0, x1, y1 = map(int, box)
            crop = frame[max(0, y0):y1, max(0, x0):x1]
            tiles.append(cv2.resize(crop, (int(crop.shape[1] * 110 / max(1, crop.shape[0])), 110)))
        label = np.full((110, 230, 3), 255, np.uint8)
        cv2.putText(label, f"#{num}", (8, 45), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 200), 2)
        cv2.putText(label, f"{name[:18]}", (8, 75), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
        cv2.putText(label, f"play {play} trk {tid}", (8, 98), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (90, 90, 90), 1)
        rows.append(np.hstack([label] + tiles))
    w = max(r.shape[1] for r in rows)
    sheet = np.vstack([np.pad(r, ((0, 4), (0, w - r.shape[1]), (0, 0)), constant_values=255) for r in rows])
    cv2.imwrite(str(a.out), sheet)
    print(f"{len(named)} named tracks; {len(rows)} on the sheet → {a.out}")


if __name__ == "__main__":
    main()
