"""Broadcast video → player positions on the field (yards), 10 times a second.

    python -m sideline_vision.pipeline VIDEO --start 0 --end 6 --init init.json --level ncaa --out out/play1

init.json gives a rough camera for the first frame: 4+ image points and the field
points they sit on (yard-line/hash intersections). Everything after that is automatic:

  1. YOLO11 finds people; ByteTrack keeps an ID on each across frames.
  2. Field registration (field.py) follows the camera through pans and zooms by fitting
     the painted lines, starting from the previous frame's homography.
  3. Each player's feet (bottom-center of the box) go through the inverse homography
     into field yards. People off the field (sideline, crowd) are dropped.
  4. Jersey colors are clustered into two teams plus everyone else (officials).
  5. Tracks are smoothed and resampled to 10 Hz, the rate NFL tracking uses.

A shot change (cut to a replay or close-up) shows up as a jump in the registration
error; the segment stops there.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
import pandas as pd
from scipy.signal import savgol_filter
from sklearn.cluster import KMeans

from .field import FIELD_W, distance_map, draw_overlay, field_template, from_points, icp, project, refine, score, to_field, white_line_mask

BAD_FIT = 8.0          # mean px error above which a frame's camera fit is rejected
MAX_BAD = 60           # consecutive rejected frames (2 s) before giving up on the shot
HZ = 10


def small_gray(frame):
    g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    g = g[: int(g.shape[0] * 0.85)]  # leave out the score bar
    return cv2.resize(g, (g.shape[1] // 4, g.shape[0] // 4)).astype(np.float32)


def is_cut(a, b) -> bool:
    """A real camera cut changes the whole picture, not just its position."""
    ha = cv2.calcHist([a.astype(np.uint8)], [0], None, [32], [0, 256])
    hb = cv2.calcHist([b.astype(np.uint8)], [0], None, [32], [0, 256])
    return cv2.compareHist(ha, hb, cv2.HISTCMP_CORREL) < 0.7


_orb = cv2.ORB_create(1500)
_bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)


def frame_motion(a, b, boxes) -> np.ndarray | None:
    """Camera motion between consecutive frames (pan, zoom, roll) as an image homography,
    from ORB features on everything except the players. Works through motion blur better
    than the painted lines do, because the crowd and stadium keep texture."""
    mask = np.full(a.shape, 255, np.uint8)
    for x0, y0, x1, y1 in boxes:
        mask[max(0, int(y0) // 4):int(y1) // 4 + 1, max(0, int(x0) // 4):int(x1) // 4 + 1] = 0
    ka, da = _orb.detectAndCompute(a.astype(np.uint8), mask)
    kb, db = _orb.detectAndCompute(b.astype(np.uint8), mask)
    if da is None or db is None or len(ka) < 30 or len(kb) < 30:
        return None
    m = _bf.match(da, db)
    if len(m) < 30:
        return None
    pa = np.float32([ka[x.queryIdx].pt for x in m]) * 4
    pb = np.float32([kb[x.trainIdx].pt for x in m]) * 4
    G, inl = cv2.findHomography(pa, pb, cv2.RANSAC, 3.0)
    if G is None or inl.sum() < 25:
        return None
    G = G / G[2, 2]
    # Broadcast cameras can't jump much in 1/30 s: reject implausible estimates.
    zoom = np.sqrt(abs(np.linalg.det(G[:2, :2])))
    if not (0.85 < zoom < 1.15) or abs(G[0, 2]) > 250 or abs(G[1, 2]) > 150 or np.abs(G[2, :2]).max() > 2e-4:
        return None
    return G


def pan_shift(a, b) -> np.ndarray:
    """Image translation between consecutive frames (phase correlation), as a homography."""
    (dx, dy), _ = cv2.phaseCorrelate(a, b)
    return np.array([[1, 0, dx * 4], [0, 1, dy * 4], [0, 0, 1]], float)


def jersey_color(frame: np.ndarray, box) -> np.ndarray | None:
    """Mean Lab color of the torso, ignoring turf-green pixels."""
    x0, y0, x1, y1 = [int(v) for v in box]
    h, w = y1 - y0, x1 - x0
    if h < 20 or w < 8:
        return None
    crop = frame[y0 + int(0.18 * h): y0 + int(0.5 * h), x0 + int(0.25 * w): x1 - int(0.25 * w)]
    if crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    keep = ~((hsv[:, 0] > 30) & (hsv[:, 0] < 90) & (hsv[:, 1] > 40))
    if keep.sum() < 10:
        return None
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).reshape(-1, 3)[keep]
    return np.median(lab, axis=0).astype(float)


def run(video: str, start: float, end: float, init: dict, level: str, out: Path, model_name: str, debug: bool,
        trace: list | None = None, analyze_fps: float = 30, quiet: bool = False, det_cache: Path | None = None):
    """det_cache: a .npz of per-frame detections; reused when it exists (same clip and
    frame rate), written otherwise. Lets the camera fit be re-run without the detector."""
    from ultralytics import YOLO

    out.mkdir(parents=True, exist_ok=True)
    cached = dict(np.load(det_cache, allow_pickle=True)) if det_cache and Path(det_cache).exists() else None
    fresh: dict = {}
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    step = max(1, round(fps / analyze_fps))
    model = YOLO(model_name)
    tpl = field_template(level)
    H = np.array(init["H"], float) if "H" in init else from_points(init["image"], init["field"])

    rows, colors, scores = [], {}, []
    prev_gray, last_gray, bad = None, None, 0
    # Camera motion is chained frame by frame, also across frames that aren't analysed:
    # over two frames a whip pan moves too far for the feature match to hold.
    motion, last_boxes = np.eye(3), np.zeros((0, 4))
    writer = None
    k = 0
    t0 = time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = start + k / fps
        k += 1
        if t > end:
            break
        # Cuts are checked on every frame: across skipped frames a whip pan changes the
        # picture enough to look like one.
        gray = small_gray(frame)
        if last_gray is not None:
            if is_cut(last_gray, gray):
                print(f"  camera cut at {t:.2f}s; stopping")
                break
            g = frame_motion(last_gray, gray, last_boxes)
            motion = (pan_shift(last_gray, gray) if g is None else g) @ motion
        last_gray = gray
        if (k - 1) % step:
            continue
        key = f"{t:.3f}"
        if cached is not None and key in cached:
            det = cached[key]
            boxes, ids = det[:, :4], det[:, 4].astype(int)
        else:
            res = model.track(frame, persist=True, classes=[0], conf=0.2, imgsz=1280, device="mps",
                              tracker="bytetrack.yaml", verbose=False)[0]
            boxes = res.boxes.xyxy.cpu().numpy() if res.boxes is not None else np.zeros((0, 4))
            ids = res.boxes.id.cpu().numpy().astype(int) if res.boxes is not None and res.boxes.id is not None else np.full(len(boxes), -1)
        fresh[key] = np.c_[boxes, ids].astype(float) if len(boxes) else np.zeros((0, 5))

        hidden = [tuple(map(int, b)) for b in boxes]
        mask = white_line_mask(frame, ignore=hidden)
        dist = distance_map(mask, ignore=hidden)
        # Predict the camera from frame-to-frame motion, then lock onto the painted lines.
        G = None if prev_gray is None else motion
        motion, last_boxes = np.eye(3), boxes
        pred = H if G is None else G @ H
        prev_gray = gray
        starts = [pred] if G is None else [pred, H]
        best = min((refine(h0, tpl, dist, reach=3.0) for h0 in starts), key=lambda r: r[1])
        if best[1] > BAD_FIT:
            # Far off (fast pan, zoom): snap to the paint with ICP, then polish.
            best = min(best, refine(icp(pred, tpl, mask), tpl, dist, reach=3.0), key=lambda r: r[1])
        # A fit must agree with where camera motion says we are. Yard lines repeat every
        # 5 yards, so a fit that's off by a multiple of 5 is shifted back and re-checked.
        # The longer we've coasted on motion alone, the more drift we tolerate.
        if best[1] <= BAD_FIT and G is not None:
            probe = np.array([[frame.shape[1] * f, frame.shape[0] * g] for f in (0.25, 0.75) for g in (0.3, 0.7)])
            tol = 2.5 + 0.05 * bad
            off = to_field(best[0], probe) - to_field(pred, probe)
            lines = round(float(np.median(off[:, 0])) / 5)  # whole yard lines (5 yd) off
            if lines and abs(np.median(off[:, 0]) - 5 * lines) < tol:
                shifted = best[0] @ np.array([[1, 0, 5 * lines], [0, 1, 0], [0, 0, 1]], float)
                best = refine(shifted, tpl, dist, reach=2.0)
                off = to_field(best[0], probe) - to_field(pred, probe)
            if np.abs(off).max() > tol:
                best = (best[0], BAD_FIT + 1)
        if trace is not None:
            c = to_field(best[0] if best[1] <= BAD_FIT else pred, np.array([[frame.shape[1] / 2, frame.shape[0] / 2]]))[0]
            trace.append((round(t, 2), round(best[1], 2), best[1] <= BAD_FIT, round(float(c[0]), 1), round(float(c[1]), 1)))
        if best[1] > BAD_FIT:
            # Lines unreadable (blur, zoom): carry the motion prediction forward and skip this frame.
            H = pred
            bad += 1
            if debug:
                cv2.imwrite(str(out / f"bad_{t:.2f}.jpg"), draw_overlay(frame, H, level))
                np.save(out / f"bad_{t:.2f}.npy", H)
            if bad > MAX_BAD:
                print(f"  lost the field at {t:.2f}s; stopping")
                break
            continue
        bad = 0
        H, s = best
        scores.append(s)

        feet = np.c_[(boxes[:, 0] + boxes[:, 2]) / 2, boxes[:, 3]] if len(boxes) else np.zeros((0, 2))
        field = to_field(H, feet) if len(feet) else feet
        for b, tid, (fx, fy) in zip(boxes, ids, field):
            if tid < 0 or not (-1 <= fy <= FIELD_W + 1 and -2 <= fx <= 122):
                continue
            rows.append({"t": t, "id": int(tid), "x": float(fx), "y": float(fy), "box_h": float(b[3] - b[1]),
                         "box": [round(float(v), 1) for v in b]})
            c = jersey_color(frame, b)
            if c is not None:
                colors.setdefault(int(tid), []).append(c)

        if debug:
            vis = draw_overlay(frame, H, level)
            for b, tid in zip(boxes.astype(int), ids):
                cv2.rectangle(vis, tuple(b[:2]), tuple(b[2:]), (0, 255, 255), 1)
                cv2.putText(vis, str(tid), (b[0], b[1] - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
            if writer is None:
                writer = cv2.VideoWriter(str(out / "debug.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), 30 / 1, (vis.shape[1], vis.shape[0]))
            writer.write(vis)

    if writer:
        writer.release()
    if det_cache and cached is None:
        np.savez_compressed(det_cache, **fresh)
    elapsed = time.time() - t0
    print(f"  {len(scores)} frames in {elapsed:.0f}s ({len(scores) / max(elapsed, 1e-6):.1f} fps), mean fit error {np.mean(scores):.2f}px")

    df = pd.DataFrame(rows)
    if df.empty:
        raise SystemExit("No players found on the field")

    # Teams: cluster each track's median jersey color.
    tid_color = {tid: np.median(np.array(c), axis=0) for tid, c in colors.items() if len(c) >= 3}
    team = {}
    if len(tid_color) >= 3:
        X = np.array(list(tid_color.values()))
        km = KMeans(n_clusters=3, n_init=10, random_state=0).fit(X)
        sizes = np.bincount(km.labels_, minlength=3)
        order = np.argsort(-sizes)  # two biggest clusters are the teams
        names = {order[0]: "A", order[1]: "B", order[2]: "other"}
        team = {tid: names[l] for tid, l in zip(tid_color, km.labels_)}
    df["team"] = df.id.map(team).fillna("other")

    # Smooth and resample each track to 10 Hz.
    grid = np.arange(df.t.min(), df.t.max() + 1e-9, 1 / HZ)
    tracks = []
    for tid, g in df.groupby("id"):
        g = g.sort_values("t")
        if g.t.max() - g.t.min() < 1.0:
            continue
        x, y = g.x.to_numpy(), g.y.to_numpy()
        if len(g) >= 9:
            x, y = savgol_filter(x, 9, 2), savgol_filter(y, 9, 2)
        span = (grid >= g.t.min()) & (grid <= g.t.max())
        # Keep the biggest boxes (best chance to read a jersey number later).
        big = g.nlargest(16, "box_h")
        tracks.append({"id": int(tid), "team": team.get(int(tid), "other"),
                       "color": [round(float(v), 1) for v in tid_color[int(tid)]] if int(tid) in tid_color else None,
                       "boxes": [[round(float(r.t), 3), *r.box] for r in big.itertuples()],
                       "t": grid[span].round(2).tolist(),
                       "x": np.interp(grid[span], g.t, x).round(2).tolist(),
                       "y": np.interp(grid[span], g.t, y).round(2).tolist()})
    result = {"video": Path(video).name, "start": start, "end": float(df.t.max()), "level": level,
              "fitError": float(np.mean(scores)), "tracks": tracks}
    (out / "tracks.json").write_text(json.dumps(result))
    np.save(out / "H_last.npy", H)
    print(f"  {len(tracks)} tracks ({sum(t['team'] != 'other' for t in tracks)} on teams) → {out / 'tracks.json'}")
    return result


def minimap(result: dict, out: Path, scale: int = 8):
    """Top-down plot of every track, for a quick sanity check."""
    W, Hh = int(120 * scale), int(FIELD_W * scale)
    img = np.full((Hh, W, 3), (40, 110, 50), np.uint8)
    for x in range(10, 111, 5):
        cv2.line(img, (x * scale, 0), (x * scale, Hh), (230, 230, 230), 1)
    colors = {"A": (255, 255, 255), "B": (40, 40, 40), "other": (0, 200, 255)}
    for tr in result["tracks"]:
        pts = np.c_[np.array(tr["x"]) * scale, (FIELD_W - np.array(tr["y"])) * scale].astype(np.int32)
        cv2.polylines(img, [pts], False, colors[tr["team"]], 2)
        cv2.circle(img, tuple(pts[-1]), 4, colors[tr["team"]], -1)
    cv2.imwrite(str(out / "minimap.png"), img)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--end", type=float, default=1e9)
    ap.add_argument("--init", required=True, help="JSON with 'image' and 'field' point lists for the first frame")
    ap.add_argument("--level", default="nfl", choices=["nfl", "ncaa"])
    ap.add_argument("--model", default="yolo11m.pt")
    ap.add_argument("--out", type=Path, default=Path("out/play"))
    ap.add_argument("--debug", action="store_true", help="write debug.mp4 with the registration overlay")
    ap.add_argument("--det-cache", type=Path, help=".npz of detections to reuse (written if missing)")
    a = ap.parse_args()
    res = run(a.video, a.start, a.end, json.loads(Path(a.init).read_text()), a.level, a.out, a.model, a.debug,
              det_cache=a.det_cache)
    minimap(res, a.out)


if __name__ == "__main__":
    main()

# TRACE hook: run(..., trace=[]) collects (t, fit px, accepted, center x, center y) per frame.
