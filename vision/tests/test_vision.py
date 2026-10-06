"""Checks for the video tools that don't need footage or models: vision/.venv/bin/python vision/tests/test_vision.py"""
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sideline_vision.autoinit import auto_init, shift_x  # noqa: E402
from sideline_vision.batch import find_snap  # noqa: E402
from sideline_vision.export import name_tracks  # noqa: E402
from sideline_vision.jersey import cluster_teams, decide  # noqa: E402
from sideline_vision.field import field_template, project, to_field  # noqa: E402
from sideline_vision.scoreboard import load, parse  # noqa: E402

# Score bar text as EasyOCR returns it.
assert parse("3rd 9:28 :01") == (3, 568)
assert parse("3rd 927 :40") == (3, 567), "dropped colon"
assert parse("2nd :13 :40") == (2, 13), "under a minute"
assert parse("Tst 15:00 :25") == (1, 900), "1st misread as Tst"
assert parse("1st 44 :40") is None, "two digits are ambiguous"
assert parse("4th 15:30 :40") is None
assert parse("") is None and parse("Ohd") is None

with tempfile.TemporaryDirectory() as tmp:
    csv = Path(tmp) / "bar.csv"
    csv.write_text("t,quarter,clock,text\n10.0,,,2nd :38 :40\n10.5,,,2nd 834 :40\n200.0,,,2nd 834 :40\n")
    rows = load(csv)
    assert [r["clock"] for r in rows] == [38, 34, 514], "':34' read as '834' just after ':38' is 0:34"
print("score bar OK")

# The clock reads C until about a second after the snap, then C-1.
rows = [{"t": t, "quarter": 3, "clock": c} for t, c in [(100, 568), (100.5, 568), (101, 568), (101.5, 567), (102, 566)]]
assert find_snap(rows, 3, 568) == 101.5 - 0.8
assert find_snap(rows, 3, 700) is None
assert find_snap(rows, 2, 568) is None
print("snap finder OK")

# Names: only numbers on that club's list, one track per player, best-supported wins.
roster = {("KC", 10): ("Tyreek Hill", "WR"), ("NE", 24): ("Stephon Gilmore", "CB")}
reads = {"1": {"number": 10, "votes": 3.0, "reads": 3, "confidence": 0.9},
         "2": {"number": 10, "votes": 1.5, "reads": 2, "confidence": 0.8},
         "3": {"number": 24, "votes": 2.0, "reads": 2, "confidence": 0.9},   # NE number on a KC track
         "4": {"number": 10, "votes": 9.0, "reads": 1, "confidence": 1.0}}   # seen once: not enough
names = name_tracks(reads, {1: "KC", 2: "KC", 3: "KC", 4: "KC"}, roster)
assert names == {1: (10, "Tyreek Hill", "WR")}, names
print("naming OK")

# Jersey colors → teams by which side of the line they start on (offense moving right,
# line at 40: offense starts left of it), then each track only takes its team's numbers.
tracks = {"tracks": [
    {"id": 1, "team": "A", "t": [0.0, 0.1], "x": [37.0, 37.2]},
    {"id": 2, "team": "A", "t": [0.0, 0.1], "x": [38.5, 38.6]},
    {"id": 3, "team": "B", "t": [0.0, 0.1], "x": [41.0, 41.0]},
    {"id": 4, "team": "B", "t": [0.0], "x": [36.0]},       # a defender who crept up: B still defense
    {"id": 5, "team": "other", "t": [0.0], "x": [45.0]}]}   # the umpire
own = cluster_teams(tracks, 40.0, True, "KC", "NE")
assert own == {"A": "KC", "B": "NE"}, own
votes = {"1": {"10": [0.9, 1, [0.5]], "24": [2.0, 3, [0.5, 0.6, 0.7]]},   # 24 is NE: not for a KC track
         "3": {"24": [1.5, 2, [0.5, 0.6]]},
         "5": {"50": [9.0, 9, [0.5]]}}
nums = decide(votes, tracks, {10: {"KC"}, 24: {"NE"}, 50: {"NE"}}, own)
assert nums[1]["number"] == 10 and nums[3]["number"] == 24, nums
assert 5 not in nums, "officials are never named"
print("jersey teams OK")

# Auto-start on a drawn field: the reference camera is 4 yards off, and the paint alone
# can't tell yard lines 5 yards apart; players standing on the line of scrimmage must.
H_true = cv2.getPerspectiveTransform(
    np.float32([[28, 0], [52, 0], [28, 160 / 3], [52, 160 / 3]]),
    np.float32([[60, 700], [1220, 700], [380, 90], [900, 90]]))
img = np.zeros((720, 1280, 3), np.uint8)
img[:] = (40, 120, 45)
for x, y in project(H_true, field_template("nfl", step=0.05).pts).astype(int):
    cv2.circle(img, (int(x), int(y)), 2, (255, 255, 255), -1)
los = 40.0
feet_field = np.array([[los + dx, y] for dx in (-1.0, 1.0) for y in np.linspace(14, 40, 7)])
feet = project(H_true, feet_field)
boxes = np.c_[feet[:, 0] - 12, feet[:, 1] - 55, feet[:, 0] + 12, feet[:, 1]]
H_ref = shift_x(H_true, 4.0 - (los - 35.0))  # a calibrated play at los 35, aimed 4 yd off
H, fit, _ = auto_init(img, H_ref, 35.0, los, boxes)
assert H is not None, f"no start found (fit {fit:.1f}px)"
err = np.abs(to_field(H, feet) - feet_field).max()
assert err < 0.5, f"feet off by {err:.2f} yd"
print(f"auto-start OK (fit {fit:.1f}px, worst foot {err:.2f} yd)")
