"""Field registration: find the homography that maps the football field onto a video frame.

Field coordinates match the tracking data: x in yards along the field (0-120, goal lines
at 10 and 110), y in yards across it (0 = near sideline, 53.33 = far sideline).

How it works: a to-scale template of the white markings (yard lines, sidelines, hash
marks) is projected into the frame and scored against a distance transform of the white
pixels actually visible. Optimizing the 8 homography parameters pulls the template onto
the paint. Each frame starts from the previous frame's answer, so the camera's pans and
zooms are followed automatically after one rough initialization.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from scipy.optimize import minimize

FIELD_W = 160 / 3
HASH = {"nfl": (70.75 / 3, FIELD_W - 70.75 / 3), "ncaa": (20.0, FIELD_W - 20.0)}


@dataclass
class Template:
    pts: np.ndarray      # (N, 2) field points sampled along painted lines
    weight: np.ndarray   # (N,) long lines count more than tiny hash ticks


def field_template(level: str = "nfl", step: float = 0.35) -> Template:
    pts, w = [], []

    def seg(x0, y0, x1, y1, weight):
        n = max(2, int(np.hypot(x1 - x0, y1 - y0) / step))
        t = np.linspace(0, 1, n)
        pts.append(np.stack([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], 1))
        w.append(np.full(n, weight))

    for x in range(10, 111, 5):                       # yard lines and goal lines
        seg(x, 0, x, FIELD_W, 1.0)
    seg(0, 0, 120, 0, 0.6)                            # sidelines
    seg(0, FIELD_W, 120, FIELD_W, 0.6)
    for hy in HASH[level]:                            # hash marks, 2 ft long
        for x in range(11, 110):
            if x % 5:
                seg(x, hy - 0.33, x, hy + 0.33, 0.5)
    for x in range(11, 110):                          # sideline ticks
        if x % 5:
            seg(x, 0.3, x, 1.0, 0.3)
            seg(x, FIELD_W - 1.0, x, FIELD_W - 0.3, 0.3)
    return Template(np.concatenate(pts), np.concatenate(w))


HUD = 0.13  # bottom share of the frame covered by the broadcast score bar


def white_line_mask(frame: np.ndarray, ignore: list[tuple[int, int, int, int]] = (), hud: float = HUD) -> np.ndarray:
    """Painted lines: bright, unsaturated pixels on or next to green turf."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    green = ((h > 30) & (h < 90) & (s > 40) & (v > 40)).astype(np.uint8)
    turf = cv2.dilate(cv2.morphologyEx(green, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8)), np.ones((9, 9), np.uint8))
    # Paint is brighter than the turf right around it. Local contrast (top-hat) instead of a
    # fixed brightness cutoff copes with stadium shadows and motion blur.
    tophat = cv2.morphologyEx(v, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17)))
    white = ((tophat > 18) & (s < 90) & (v > 90)).astype(np.uint8) & turf
    for x0, y0, x1, y1 in ignore:                      # players, refs, graphics
        white[max(0, y0):y1, max(0, x0):x1] = 0
    hgt = white.shape[0]
    white[int(hgt * (1 - hud)):, :] = 0                # broadcast score bar
    # Lines are thin: drop compact mid-size blobs (pieces of painted numbers and logos,
    # jerseys that slipped through) but keep long lines and small marks: hash marks and
    # sideline ticks, which perspective squashes into near-square dots, are the only paint
    # that pins down position across the field when the sidelines are out of shot.
    n, lab, stats, _ = cv2.connectedComponentsWithStats(white, connectivity=8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        fill = area / max(1, bw * bh)
        mark = max(bw, bh) <= 16 or max(bw, bh) >= 2 * min(bw, bh)   # hash mark, tick or thin dash
        keep[i] = area >= 6 and (fill < 0.35 or max(bw, bh) > 40 or mark)
    return (keep[lab] * 255).astype(np.uint8)


def distance_map(mask: np.ndarray, cap: float = 15.0, ignore: list[tuple[int, int, int, int]] = (),
                 hud: float = HUD) -> np.ndarray:
    """Distance to the nearest paint, capped; -1 where paint can't be seen (behind players
    and the score bar). Template points landing there are left out of the score instead of
    counted as misses, which would reward pushing the field out from under them."""
    d = np.minimum(cv2.distanceTransform(255 - mask, cv2.DIST_L2, 3), cap).astype(np.float32)
    d[int(d.shape[0] * (1 - hud)):, :] = -1
    for x0, y0, x1, y1 in ignore:
        d[max(0, y0):y1, max(0, x0):x1] = -1
    return d


def blur_seen(dist: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur of a distance map that doesn't mix in the unseen (-1) pixels."""
    seen = (dist >= 0).astype(np.float32)
    out = cv2.GaussianBlur(dist * seen, (0, 0), sigma) / np.maximum(cv2.GaussianBlur(seen, (0, 0), sigma), 1e-6)
    out[dist < 0] = -1
    return out


def project(H: np.ndarray, pts: np.ndarray) -> np.ndarray:
    p = np.c_[pts, np.ones(len(pts))] @ H.T
    return p[:, :2] / p[:, 2:3]


def score(H: np.ndarray, tpl: Template, dist: np.ndarray) -> float:
    """Mean truncated distance from projected template points to visible paint. Points out
    of frame or where paint can't be seen (dist -1) are left out."""
    img = project(H, tpl.pts)
    h, w = dist.shape
    ok = (img[:, 0] >= 0) & (img[:, 0] < w - 1) & (img[:, 1] >= 0) & (img[:, 1] < h - 1)
    d = np.full(len(img), -1.0, np.float32)
    d[ok] = dist[img[ok, 1].astype(int), img[ok, 0].astype(int)]
    seen = d >= 0
    if seen.sum() < 200:
        return 1e3
    return float(np.average(d[seen], weights=tpl.weight[seen]))


def refine(H0: np.ndarray, tpl: Template, dist: np.ndarray, reach: float = 4.0) -> tuple[np.ndarray, float]:
    """Optimize H = H0 · (I + Δ) to fit the template to the paint.

    Parameters are scaled so one unit is a small, comparable change (2% scale/shear,
    0.5 yd shift, a little perspective), and bounded by `reach` units. The bound matters:
    yard lines repeat every 5 yards, so a free search can lock onto the wrong ones.
    """
    H0 = H0 / H0[2, 2]
    k = np.array([0.02, 0.02, 0.5, 0.02, 0.02, 0.5, 2e-4, 2e-4])

    def build(p):
        q = p * k
        D = np.array([[1 + q[0], q[1], q[2]], [q[3], 1 + q[4], q[5]], [q[6], q[7], 1.0]])
        return H0 @ D

    best = np.zeros(8)
    bounds = [(-reach, reach)] * 8
    for blur in (6, 0):
        d = blur_seen(dist, blur) if blur else dist
        r = minimize(lambda p: score(build(p), tpl, d), best, method="Powell", bounds=bounds,
                     options={"xtol": 1e-3, "ftol": 1e-4, "maxiter": 3000})
        best = r.x
    H = build(best)
    s1, s0 = score(H, tpl, dist), score(H0, tpl, dist)
    # The blurred first pass can wander; never hand back something worse than the start.
    return (H / H[2, 2], s1) if s1 <= s0 else (H0, s0)


def icp(H: np.ndarray, tpl: Template, mask: np.ndarray, iters: int = 20, radius: float = 60.0) -> np.ndarray:
    """Iterative closest point: snap projected template points to the nearest painted pixel,
    re-solve the homography (RANSAC), shrink the search radius, repeat. Recovers from much
    larger camera errors than the bounded local search, e.g. after a fast whip pan."""
    from scipy.spatial import cKDTree

    ys, xs = np.nonzero(mask)
    if len(xs) < 200:
        return H
    paint = np.c_[xs, ys].astype(np.float32)
    tree = cKDTree(paint)
    h, w = mask.shape
    r = radius
    for _ in range(iters):
        img = project(H, tpl.pts)
        inside = (img[:, 0] > -50) & (img[:, 0] < w + 50) & (img[:, 1] > -50) & (img[:, 1] < h + 50)
        d, idx = tree.query(img[inside], distance_upper_bound=r)
        ok = np.isfinite(d)
        if ok.sum() < 60:
            break
        src = tpl.pts[inside][ok].astype(np.float32)
        dst = paint[idx[ok]]
        Hn, _ = cv2.findHomography(src, dst, cv2.RANSAC, max(3.0, r / 4))
        if Hn is None:
            break
        H = Hn / Hn[2, 2]
        r = max(5.0, r * 0.75)
    return H


def from_points(img_pts, field_pts) -> np.ndarray:
    """Homography field → image from 4+ correspondences."""
    H, _ = cv2.findHomography(np.asarray(field_pts, np.float32), np.asarray(img_pts, np.float32))
    return H


def to_field(H: np.ndarray, img_pts: np.ndarray) -> np.ndarray:
    return project(np.linalg.inv(H), img_pts)


def draw_overlay(frame: np.ndarray, H: np.ndarray, level: str = "nfl") -> np.ndarray:
    """Projected field markings drawn over the frame, to check a registration by eye."""
    out = frame.copy()
    tpl = field_template(level, step=0.2)
    for x, y in project(H, tpl.pts).astype(int):
        if 0 <= x < out.shape[1] and 0 <= y < out.shape[0]:
            out[y, x] = (255, 0, 255)
    for yd in range(10, 111, 10):
        p = project(H, np.array([[yd, FIELD_W / 2]]))[0].astype(int)
        if 0 <= p[0] < out.shape[1] and 0 <= p[1] < out.shape[0]:
            label = str(yd - 10 if yd <= 60 else 110 - yd)
            cv2.putText(out, label, tuple(p), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 255), 2)
    return out
