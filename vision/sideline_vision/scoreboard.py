"""Read the broadcast score bar (quarter and game clock) through a video, so each play
in the tracking data can be found in the footage.

    python -m sideline_vision.scoreboard videos/game.mp4 --out out/scoreboard.csv

The score bar sits in a fixed spot for a whole broadcast; `--box` gives its quarter/clock
region as x0,y0,x1,y1 (default: NBC 2017 layout at 1280x720).
"""
from __future__ import annotations

import argparse
import csv
import time
from pathlib import Path

import cv2
import numpy as np

QUARTERS = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "OT": 5}
# Common EasyOCR misreads of the quarter label.
FIX = {"lst": "1st", "Ist": "1st", "Tst": "1st", "st": "1st", "3rcl": "3rd", "nd": "2nd", "rd": "3rd", "th": "4th", "0T": "OT"}


def parse(text: str):
    """'3rd 9:28 :01' → (3, 568). Accepts a dropped colon ('927') and ':13' under a minute."""
    toks = text.split()
    for i, tok in enumerate(toks[:-1]):
        q = QUARTERS.get(FIX.get(tok, tok))
        if q is None:
            continue
        c = toks[i + 1].replace(".", ":").replace("O", "0")
        if ":" in c:
            mm, _, ss = c.partition(":")
            if len(ss) != 2 or not ss.isdigit() or (mm and not mm.isdigit()):
                return None
            mm = int(mm or 0)
        elif c.isdigit() and len(c) in (3, 4):
            mm, ss = int(c[:-2]), c[-2:]
        else:
            return None
        ss = int(ss)
        if mm > 15 or ss > 59 or (mm == 15 and ss):
            return None
        return q, mm * 60 + ss
    return None


def load(path: Path) -> list[dict]:
    """Rows of {t, quarter, clock} from a scan, re-parsed from the raw text.

    Under a minute the bar shows ':34', which OCR often reads as '834'; when the clock
    read under a minute shortly before, an 8:xx reading is taken as 0:xx."""
    rows, last = [], None
    with Path(path).open() as f:
        for r in csv.DictReader(f):
            p = parse(r["text"])
            if not p:
                continue
            t, (q, c) = float(r["t"]), p
            if 480 <= c < 540 and last and last[1] == q and last[2] < 60 and t - last[0] < 30:
                c -= 480
            rows.append({"t": t, "quarter": q, "clock": c})
            last = (t, q, c)
    return rows


def main():
    import easyocr

    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", type=Path, default=Path("out/scoreboard.csv"))
    ap.add_argument("--every", type=float, default=0.5, help="seconds between samples")
    ap.add_argument("--box", default="590,640,760,672")
    a = ap.parse_args()
    x0, y0, x1, y1 = map(int, a.box.split(","))

    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    cap = cv2.VideoCapture(a.video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    step = max(1, round(fps * a.every))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    rows, k, t0 = [], 0, time.time()
    while True:
        ok = cap.grab()
        if not ok:
            break
        if k % step == 0:
            _, frame = cap.retrieve()
            crop = cv2.resize(frame[y0:y1, x0:x1], None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
            text = " ".join(reader.readtext(crop, detail=0, allowlist="0123456789:stndrdhOT "))
            p = parse(text)
            rows.append({"t": round(k / fps, 2), "quarter": p[0] if p else "", "clock": p[1] if p else "", "text": text})
        k += 1
    with a.out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["t", "quarter", "clock", "text"])
        w.writeheader()
        w.writerows(rows)
    ok_rows = sum(1 for r in rows if r["quarter"] != "")
    print(f"{len(rows)} samples, {ok_rows} read ({ok_rows / max(1, len(rows)):.0%}) in {time.time() - t0:.0f}s → {a.out}")


if __name__ == "__main__":
    main()
