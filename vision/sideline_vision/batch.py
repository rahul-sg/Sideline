"""Run the video model on many plays of one game and score each against NFL tracking.

    python -m sideline_vision.batch videos/game.mp4 --scoreboard out/scoreboard.csv \\
        --game 2017090700 --ref out/kcne_ref.json --out out/batch --limit 40

Per play:
  1. Find it in the video: the score bar's quarter/clock reaches the play's snap clock,
     and ticks one second lower about a second after the snap.
  2. Work out direction on screen: the broadcast camera stays on one sideline, so it
     follows from the play's stadium direction and one reference play.
  3. Start the camera automatically (autoinit.py) on the best wide frame around the snap.
  4. Run the pipeline, then evaluate against the tracking.
  5. Read jersey numbers (jersey.py) and check them against who each track really is.
Writes per-play results and a summary to <out>/results.json.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np

from .autoinit import auto_init
from .evaluate import load_truth, score_offset, video_snap
from .jersey import check_reads, cluster_teams, decide, ocr_votes
from .pipeline import is_cut, run, small_gray
from . import scoreboard

FIELD_W = 160 / 3


def clock_secs(c: str) -> int:
    m, s = c.split(":")[:2]
    return int(m) * 60 + int(s)


def find_snap(rows, quarter: int, clock: int) -> float | None:
    """Video time of the snap: ~0.8 s before the clock first reads one second less."""
    seen = None
    for r in rows:
        if r["quarter"] != quarter:
            continue
        if r["clock"] == clock and seen is None:
            seen = r["t"]
        elif seen is not None and r["clock"] == clock - 1 and r["t"] - seen < 60:
            return r["t"] - 0.8
        elif seen is not None and r["t"] - seen > 60:
            seen = None
    return None


def grab(video, t):
    cap = cv2.VideoCapture(video)
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, frame = cap.read()
    return frame if ok else None


def find_cuts(video, t0, t1) -> list[float]:
    """Times of camera cuts between t0 and t1 (frame to frame, as the pipeline checks)."""
    cap = cv2.VideoCapture(video)
    cap.set(cv2.CAP_PROP_POS_MSEC, t0 * 1000)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    prev, cuts, k = None, [], 0
    while t0 + k / fps <= t1:
        ok, frame = cap.read()
        if not ok:
            break
        g = small_gray(frame)
        if prev is not None and is_cut(prev, g):
            cuts.append(t0 + k / fps)
        prev, k = g, k + 1
    return cuts


def score_play(res, p, game: int, snap: float, flip: bool) -> dict | None:
    """Position error against NFL tracking. The clip is aligned to the tracking by the snap:
    motion onset in the video, or the score bar's snap time when the clip starts after the
    snap (condensed broadcasts often cut in late); ±1 s around each, best kept."""
    _, X, Y = load_truth(game, p["playId"])
    sv = video_snap(res)
    cands = []
    for anchor in (sv, snap):
        for off in np.arange(-1.0, 1.01, 0.1):
            off = float(off + anchor - sv)
            errs, m, n = score_offset(res, X, Y, p["snap"], sv, off, flip)
            if len(errs):
                cands.append((off, errs, m, n))
    if not cands:
        return None
    # Lowest median among alignments that overlap most of the clip (a sliver of overlap
    # can look accurate by chance).
    most = max(c[3] for c in cands)
    off, errs, m, n = min((c for c in cands if c[3] >= 0.6 * most), key=lambda c: (np.median(c[1]), -c[2]))
    return {"playId": p["playId"], "status": "ok", "desc": p["desc"][:90], "videoSnap": round(sv, 2),
            "offset": round(off, 2), "positions": int(n), "matched": int(m),
            "median": round(float(np.median(errs)), 2), "mean": round(float(errs.mean()), 2),
            "p90": round(float(np.percentile(errs, 90)), 2), "errors": [round(float(e), 2) for e in errs],
            "fitError": round(res["fitError"], 2), "flip": flip}


def check_jerseys(res, nums: dict, p, game: int, r: dict) -> list[dict]:
    _, X, Y = load_truth(game, p["playId"])
    ident = check_reads(res, nums, X, Y, [q["team"] for q in p["players"]], p["snap"], r["videoSnap"],
                        r["offset"], r["flip"])
    return [{"track": tid, "read": v["number"], "reads": v["reads"], "confidence": v["confidence"],
             "truth": p["players"][ident[tid]]["num"] if tid in ident else None} for tid, v in nums.items()]


def jersey_names(res, raw: dict, field: dict, p, r: dict) -> dict:
    """Decide each track's number: on-field numbers only, each color cluster tied to a team
    by which side of the line it starts on. field: (team, number) → (name, position)."""
    from .export import number_teams

    teams = number_teams(field)
    own = cluster_teams(res, r["losVideo"], not r["flip"], p["offense"], p["defense"])
    return decide(raw, res, teams or None, own or None)


def summarize(results: list[dict]) -> dict:
    ok = [r for r in results if r["status"] == "ok"]
    pooled = np.concatenate([np.array(r["errors"]) for r in ok]) if ok else np.array([])
    summary = {
        "plays": len(results), "scored": len(ok),
        "notFound": sum(r["status"] == "not found in video" for r in results),
        "noWideShot": sum(r["status"] == "no wide shot" for r in results),
        "pooledMedian": round(float(np.median(pooled)), 2) if len(pooled) else None,
        "pooledMean": round(float(pooled.mean()), 2) if len(pooled) else None,
        "pooledP90": round(float(np.percentile(pooled, 90)), 2) if len(pooled) else None,
        "medianOfPlayMedians": round(float(np.median([r["median"] for r in ok])), 2) if ok else None,
        "matchRate": round(sum(r["matched"] for r in ok) / max(1, sum(r["positions"] for r in ok)), 3),
    }
    if any("jerseys" in r for r in ok):
        # precision: named tracks whose name is right; perPlay: distinct real players named right, of 22.
        summary["jerseys"] = {}
        for cut, need in ((0.0, 1), (0.6, 2)):
            kept = [[j for j in r.get("jerseys", []) if j["truth"] is not None and j["confidence"] >= cut and j["reads"] >= need]
                    for r in ok]
            flat = [j for k in kept for j in k]
            right = sum(j["read"] == j["truth"] for j in flat)
            players = [len({j["truth"] for j in k if j["read"] == j["truth"]}) for k in kept]
            summary["jerseys"][f"conf>={cut},reads>={need}"] = {
                "checked": len(flat), "right": right, "precision": round(right / max(1, len(flat)), 3),
                "playersNamedPerPlay": round(float(np.mean(players)), 2)}
    return summary


def rescore(a, game, rows) -> None:
    """Re-score saved tracks (and jersey reads) without running the models again."""
    from .export import load_on_field, roster_from_json

    old = {r["playId"]: r for r in json.loads((a.out / "results.json").read_text())["plays"]}
    results = []
    for p in game["plays"]:
        if p["playId"] not in old:
            continue
        r, tracks = old[p["playId"]], a.out / str(p["playId"]) / "tracks.json"
        if r["status"] == "ok" and tracks.exists():
            res = json.loads(tracks.read_text())
            snap = find_snap(rows, p["quarter"], clock_secs(p["clock"]))
            r2 = score_play(res, p, a.game, snap, r["flip"]) or r
            r2["losVideo"] = r.get("losVideo")
            jfile = tracks.parent / "jerseys_raw.json"
            if jfile.exists() and r2["losVideo"] is not None:
                saved = json.loads(jfile.read_text())
                field = load_on_field(p["season"], p["week"], a.game, p["playId"]) or roster_from_json(saved["field"])
                nums = jersey_names(res, saved["votes"], field, p, r2)
                r2["jerseys"] = check_jerseys(res, nums, p, a.game, r2)
            r2["seconds"] = r.get("seconds")
            r = r2
        results.append(r)
    summary = summarize(results)
    (a.out / "results.json").write_text(json.dumps({"summary": summary, "plays": results}, indent=1))
    print(json.dumps(summary, indent=1))


def main():
    import gzip

    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--scoreboard", type=Path, required=True)
    ap.add_argument("--game", type=int, required=True)
    ap.add_argument("--ref", type=Path, required=True, help="JSON: H, los (video x), rawDirection of a calibrated play")
    ap.add_argument("--out", type=Path, default=Path("out/batch"))
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--plays", type=int, nargs="*")
    ap.add_argument("--no-jerseys", action="store_true")
    ap.add_argument("--rescore", action="store_true", help="re-score saved tracks in --out without running models")
    a = ap.parse_args()

    rows = scoreboard.load(a.scoreboard)
    ref = json.loads(a.ref.read_text())
    H_ref = np.array(ref["H"], float)
    root = Path(__file__).resolve().parents[2]
    game = json.loads(gzip.decompress((root / "public/data/games" / f"{a.game}.json.gz").read_bytes()))
    if a.rescore:
        return rescore(a, game, rows)

    from ultralytics import YOLO

    det = YOLO("yolo11m.pt")
    reader = None
    if not a.no_jerseys:
        import easyocr

        from .export import load_on_field, load_roster, roster_to_json

        reader = easyocr.Reader(["en"], gpu=True, verbose=False)
        p0 = game["plays"][0]
        dressed = {n for (team, n) in load_roster(p0["season"], p0["week"]) if team in (p0["home"], p0["away"])}
    a.out.mkdir(parents=True, exist_ok=True)
    results = []
    plays = [p for p in game["plays"] if (not a.plays or p["playId"] in a.plays)]
    for p in plays[: a.limit if not a.plays else None]:
        t0 = time.time()
        label = f"{p['playId']} Q{p['quarter']} {p['clock']}"
        snap = find_snap(rows, p["quarter"], clock_secs(p["clock"]))
        if snap is None:
            results.append({"playId": p["playId"], "status": "not found in video"})
            print(f"{label}: not found in video")
            continue
        # Same stadium direction as the reference play → same direction on screen.
        same = p["rawDirection"] == ref["rawDirection"]
        on_screen_right = ref["onScreen"] == "right" if same else ref["onScreen"] != "right"
        los_video = p["los"] if on_screen_right else 120 - p["los"]
        # Start frames: before the snap if possible; condensed broadcasts often cut into the
        # wide shot right at the snap, so up to a second after it too (slightly penalised).
        cuts = find_cuts(a.video, snap - 3.5, snap + 2.0)
        # Not within 0.15 s after a cut, and not within 1 s before one (the run would stop at once).
        starts = [snap + dt for dt in (-2.0, -1.0, -2.5, -1.5, -0.5, 0.3, 0.7)
                  if not any(-0.15 < c - (snap + dt) < 1.0 for c in cuts)]
        H0, fit, t_start, best_cost = None, None, None, 1e9
        for ts in starts:
            frame = grab(a.video, ts)
            if frame is None:
                continue
            boxes = det.predict(frame, classes=[0], conf=0.25, imgsz=1280, device="mps", verbose=False)[0].boxes.xyxy.cpu().numpy()
            H, s, cost = auto_init(frame, H_ref, ref["los"], los_video, boxes)
            cost += 0.3 * (ts > snap)
            if fit is None or s < fit:
                fit = s
            if H is not None and cost < best_cost:
                H0, t_start, best_cost, fit = H, ts, cost, s
        if H0 is None:
            results.append({"playId": p["playId"], "status": "no wide shot", "fit": fit})
            print(f"{label}: no wide pre-snap shot (best fit {fit if fit is None else round(fit, 1)}px)")
            continue
        out = a.out / str(p["playId"])
        try:
            res = run(a.video, t_start, snap + 6.0, {"H": H0.tolist()}, "nfl", out, "yolo11m.pt", False, analyze_fps=15)
        except SystemExit as e:
            results.append({"playId": p["playId"], "status": f"pipeline: {e}"})
            continue
        if not res["tracks"]:
            results.append({"playId": p["playId"], "status": "no tracks"})
            print(f"{label}: no tracks")
            continue
        r = score_play(res, p, a.game, snap, not on_screen_right)
        if r is None:
            results.append({"playId": p["playId"], "status": "no overlap with tracking"})
            continue
        r["losVideo"] = round(los_video, 2)
        if reader is not None:
            # Only numbers that were on the field for this play (both teams' active roster if unknown).
            field = load_on_field(p["season"], p["week"], a.game, p["playId"])
            raw = ocr_votes(res, a.video, reader, {n for _, n in field} or dressed)
            (out / "jerseys_raw.json").write_text(json.dumps({"votes": raw, "field": roster_to_json(field)}))
            r["jerseys"] = check_jerseys(res, jersey_names(res, raw, field, p, r), p, a.game, r)
        r["seconds"] = round(time.time() - t0)
        results.append(r)
        jl = ""
        if "jerseys" in r:
            js = [j for j in r["jerseys"] if j["truth"] is not None]
            jl = f", jerseys {sum(j['read'] == j['truth'] for j in js)}/{len(js)} right"
        print(f"{label}: median {r['median']} yd, {r['matched']}/{r['positions']} matched{jl}, {r['seconds']}s")
        (a.out / "results.json").write_text(json.dumps({"plays": results}))

    summary = summarize(results)
    (a.out / "results.json").write_text(json.dumps({"summary": summary, "plays": results}, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
