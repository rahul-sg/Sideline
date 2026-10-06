# Sideline Vision

Broadcast video → player positions on the field, replayable in the 3D app. Local and personal use.

## Pipeline

| Step | Model / method | File |
|---|---|---|
| Find the play in the video | **EasyOCR** reads the score bar's quarter and game clock every 0.5 s; the snap is where the clock first ticks below the play's snap time, minus ~0.8 s | `scoreboard.py`, `batch.py` |
| Start the camera fit | The main camera stays in one spot all game, so one calibrated wide shot is slid along the field to the new play's line of scrimmage, swept over pan and zoom, polished, and moved by whole 5-yard steps until the players' median stands on the line. Close-ups and frames inside a dissolve are rejected (players the wrong size for the fitted field) | `autoinit.py` |
| Find people | **YOLO11m** (Ultralytics, COCO "person"), 1280 px input, Apple GPU (MPS) | `pipeline.py` |
| Keep identities | **ByteTrack** | `pipeline.py` |
| Camera → field, every frame | A to-scale template of the paint (yard lines, sidelines, hash marks, ticks) fitted to a top-hat paint mask by optimizing an 8-parameter homography against a distance transform. Paint hidden behind players or the score bar is left out of the score rather than counted as a miss. ORB + RANSAC frame motion carries the camera through whip pans; ICP recovers big errors; fits that disagree with the motion are rejected and 5-yard aliasing is corrected | `field.py`, `pipeline.py` |
| Teams | K-means on torso color (Lab), 3 clusters | `pipeline.py` |
| Smoothing | Savitzky–Golay, resampled to 10 Hz | `pipeline.py` |
| Jersey numbers → names | Torso crops of each track's largest sightings, three contrast variants, **EasyOCR** digits, confidence-weighted vote. Only numbers of the 22 players on the field for that play are accepted (nflverse participation), each jersey color is tied to a team by which side of the line it starts on, officials are skipped, and a name needs ≥2 sightings and most of the votes | `jersey.py`, `export.py` |
| Export | Joins track pieces of the same player (the tracker loses people who leave the frame or pass behind others), keeps up to 11 a side, and writes a play the app lists as "Estimated from broadcast video"; players fade while off camera | `export.py` |
| Score against NFL tracking | Snap from motion onset, ±1 s time alignment, Hungarian matching | `evaluate.py`, `batch.py` |

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# One play, with a hand-made first-frame fit
.venv/bin/python -m sideline_vision.pipeline videos/game.mp4 --start 799 --end 809 \
    --init out/init.json --level nfl --out out/play1 --debug
.venv/bin/python -m sideline_vision.jersey out/play1/tracks.json videos/game.mp4 --play 2017090700 2756
.venv/bin/python -m sideline_vision.export out/play1/tracks.json --offense A --direction right \
    --home NE --away KC --offense-team KC --title "..." --nfl-play 2017090700 2756

# A whole game: read the score bar once, then find, fit, track and score every play
.venv/bin/python -m sideline_vision.scoreboard videos/game.mp4 --out out/scoreboard.csv
.venv/bin/python -m sideline_vision.batch videos/game.mp4 --scoreboard out/scoreboard.csv \
    --game 2017090700 --ref out/kcne_ref.json --out out/batch --limit 200
.venv/bin/python -m sideline_vision.batch ... --rescore      # re-score saved tracks without the models
.venv/bin/python -m sideline_vision.audit out/batch videos/game.mp4 --game 2017090700   # jersey contact sheet
```

`init.json` holds 4+ image points and the field points under them (yard line × hash intersections) for the first frame.
`ref.json` (for `batch`) is one calibrated wide shot: `H`, its line of scrimmage in video yards, the play's stadium direction and which way the offense moved on screen.
`--debug` writes `debug.mp4` with the fitted field drawn over the video and `minimap.png`.

Tests (no footage or models needed): `npm run test:vision` from the repo root.

## Measured results

All against the NFL's own tracking of the same plays (KC at NE, 2017 Week 1, NBC broadcast, condensed-game video). Error is the distance between each video position and the tracked player it's matched to (Hungarian matching at each 0.1 s), in yards.

**Whole game, no hand-made setup** (`batch.py`, one calibrated reference shot for the broadcast):

| | |
|---|---|
| Plays in the tracking data | 138 |
| Found in the video by the score bar | 68 (the rest were cut from the condensed broadcast) |
| Camera started automatically and play scored | **50 of 68** (18 had no usable wide shot near the snap) |
| Position error, all 50 plays pooled | median **1.51 yd** · mean 1.84 · 90th pct 3.91 |
| Median of the per-play medians | 1.66 yd (best plays 0.72 and 0.83 yd) |
| Video positions matched to a tracked player within 5 yd | 71% |

**One play, Smith → Hill 75-yd TD** (hand-made first-frame fit, 30 fps): median **0.63 yd**, mean 0.93, 90th pct 1.82, 95% matched. Before keeping hash marks in the paint mask and leaving hidden paint out of the fit score, the same play measured 1.84 yd median, 4.02 at the 90th percentile and 85% matched.

**Jersey numbers → names** (same 50 plays): 206 tracks got a name, about 4 per play; the rest stay "Unidentified". Checked three ways:

| Check | Result |
|---|---|
| By eye, 40 random names against their crops (`audit.py`) | 32 right, 3 wrong, 5 too blurry to tell: **91%** of the readable ones. One miss was a number both teams had on the field, a bug since fixed |
| Automatically, on the 9 plays placed best (median ≤ 1.3 yd, ≥ 85% matched) | 21 of 29 (72%) |
| Automatically, all plays | 43%: the check asks which real player stood where the track was, which needs sub-yard positions to tell neighbours apart, so it undercounts |

**Score bar reader**: the clock was read on 1,983 of the 2,098 half-second samples where the bar was on screen (95%).

Part of the remaining position gap is what each system measures: tracking chips sit in the shoulder pads, video uses the feet.

## Known limits

- Broadcast shows ~20–30 yards around the ball; deep players are often off-screen.
- Each play is followed until the first camera cut; replays and other angles aren't used.
- The automatic start needs one calibrated wide shot per broadcast (the main camera's position).
- During fast whip pans the paint blurs out; the camera is carried by frame-to-frame feature tracking and re-locked when the lines sharpen. Positions aren't recorded on frames without a confident fit.
- Jersey numbers are only readable when a player is big in frame (roughly 40 px tall or more); most players stay unnamed on a wide shot.
- No ball yet.

## Test footage

`videos/oregon_wsu_fox.webm`: "Oregon vs. Washington St – FOX College Football Highlights", FOX Sports, CC BY 3.0, via Wikimedia Commons.
