"""Start the camera fit without hand-picked points.

The main broadcast camera stays in one place all game, panning and zooming. So a single
calibrated wide shot (a reference homography) is a good starting point for any other
play: slide it along the field to that play's line of scrimmage, try neighbouring
yard-line alignments (the paint repeats every 5 yards), snap each guess to the paint with
ICP, polish, and keep the one that fits best and puts the players around the line.
"""
from __future__ import annotations

import cv2
import numpy as np

from .field import HUD, blur_seen, distance_map, field_template, icp, project, refine, score, to_field, white_line_mask

FIELD_W = 160 / 3


def shift_x(H: np.ndarray, dx: float) -> np.ndarray:
    """Camera that sees the field moved by dx yards: field point p appears where p - dx did."""
    return H @ np.array([[1, 0, -dx], [0, 1, 0], [0, 0, 1]], float)


def zoom(H: np.ndarray, z: float, w: int, h: int, tilt: float = 0.0) -> np.ndarray:
    """Same camera zoomed by z about the image centre, and tilted (picture moved down by
    `tilt` px)."""
    S = np.array([[z, 0, w / 2 * (1 - z)], [0, z, h / 2 * (1 - z) + tilt], [0, 0, 1]], float)
    return S @ H


def yard_px(H: np.ndarray, x: float) -> float:
    """Image length of one yard along the field at yard line x, mid-field: the zoom level."""
    p = project(H, np.array([[x, FIELD_W / 2], [x + 1, FIELD_W / 2]]))
    return float(np.linalg.norm(p[1] - p[0]))


def height_ratio(H: np.ndarray, boxes: np.ndarray) -> float:
    """Median player box height in yards of field at the player's feet. Standing and
    crouched players come out around 1.3-1.8 on a correct wide-shot fit; a close-up forced
    onto the field template gives 5+."""
    feet = np.c_[(boxes[:, 0] + boxes[:, 2]) / 2, boxes[:, 3]]
    f = to_field(H, feet)
    yard = np.linalg.norm(project(H, f + [1, 0]) - project(H, f), axis=1)
    return float(np.median((boxes[:, 3] - boxes[:, 1]) / np.maximum(yard, 1e-6)))


def auto_init(frame, H_ref, los_ref: float, los_new: float, boxes, level="nfl", max_fit=5.5, max_zoom=1.8,
              heights=(0.9, 2.6)):
    """Returns (H, fit px, cost); H is None when nothing fits well. Lower cost = better start.

    The main camera sits in one spot all game, so another play's view is roughly the
    reference view panned along the field, zoomed and tilted. Candidates come from a sweep
    over pan, zoom and tilt (scored against the paint) plus ICP from the slid reference; each is
    polished, then moved by whole 5-yard steps until the players' median sits on the line
    of scrimmage (the paint repeats every 5 yards; players stand on the line before the
    snap). Fits far from the reference zoom, or where the players are the wrong size for
    the fitted field, are rejected (close-ups, frames inside a dissolve)."""
    tpl = field_template(level)
    hidden = [tuple(map(int, b)) for b in boxes]
    mask = white_line_mask(frame, ignore=hidden)
    dist = distance_map(mask, ignore=hidden)
    # Players for the checks: not the sideline staff standing in the score-bar strip.
    on_field = boxes[boxes[:, 3] < frame.shape[0] * (1 - HUD)] if len(boxes) else boxes
    feet = np.c_[(on_field[:, 0] + on_field[:, 2]) / 2, on_field[:, 3]] if len(on_field) else np.zeros((0, 2))
    if len(feet) < 6:
        return None, 1e9, 1e9
    base = shift_x(H_ref, los_new - los_ref)
    h, w = frame.shape[:2]
    ref_px = yard_px(H_ref, los_ref)

    soft = blur_seen(dist, 4)
    sweep = sorted(((score(zoom(shift_x(base, dx), z, w, h, ty * h), tpl, soft), dx, z, ty)
                    for z in (0.8, 0.9, 1.0, 1.12, 1.25) for ty in (-0.15, -0.075, 0.0, 0.075, 0.15)
                    for dx in np.arange(-7.5, 7.5, 0.25)))
    starts, used = [], []
    for _, dx, z, ty in sweep:                  # best few, at least 2 yards apart
        if all(abs(dx - u) >= 2 or (z, ty) != v for u, v in used):
            starts.append(zoom(shift_x(base, dx), z, w, h, ty * h))
            used.append((dx, (z, ty)))
        if len(starts) == 5:
            break
    for extra in (0, -5, 5):
        cv2.setRNGSeed(0)  # ICP's RANSAC: same frame, same answer
        starts.append(icp(shift_x(base, extra), tpl, mask))

    best = (None, 1e9, 1e9)
    for H0 in starts:
        H, s = refine(H0, tpl, dist)
        if not np.isfinite(H).all():
            continue
        z = yard_px(H, los_new) / ref_px
        if not 1 / max_zoom < z < max_zoom or not heights[0] < height_ratio(H, on_field) < heights[1]:
            continue
        off = float(np.median(to_field(H, feet)[:, 0])) - los_new
        steps = round(off / 5)
        if steps:
            H, s = refine(shift_x(H, -5 * steps), tpl, dist)
            off = float(np.median(to_field(H, feet)[:, 0])) - los_new
        cost = s + 0.3 * min(abs(off), 15)
        if cost < best[2]:
            best = (H, s, cost)
    H, s, cost = best
    return (H if H is not None and s <= max_fit else None), s, cost


__all__ = ["auto_init", "height_ratio", "shift_x", "yard_px", "zoom", "score"]
