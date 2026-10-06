"""Read jersey numbers for video tracks, and name players from the roster.

    python -m sideline_vision.jersey out/hill/tracks.json videos/game.mp4 [--play GAME PLAY]
    python -m sideline_vision.jersey ... --truth GAME PLAY --direction right   # also score the reads

For each track, the frames where the player is largest are cropped to the torso
(front or back number), upscaled, and read with EasyOCR (digits only). Readings are
voted across frames, weighted by confidence. With --truth, each read is checked against the
real player standing where the track was at the moments the number was read.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

MIN_H = 40        # px; smaller players' numbers are unreadable at broadcast resolution
MIN_CONF = 0.35


def torso(frame, box):
    x0, y0, x1, y1 = box
    h, w = y1 - y0, x1 - x0
    c = frame[int(y0 + 0.12 * h): int(y0 + 0.62 * h), int(x0 + 0.1 * w): int(x1 - 0.1 * w)]
    if c.size == 0:
        return None
    scale = 120 / max(1, c.shape[0])
    return cv2.resize(c, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def variants(crop):
    """The crop as-is, contrast-boosted, and inverted (white-on-dark and dark-on-white numbers)."""
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(4, 4)).apply(lab[:, :, 0])
    boosted = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
    gray = cv2.cvtColor(boosted, cv2.COLOR_BGR2GRAY)
    return [crop, boosted, cv2.cvtColor(255 - gray, cv2.COLOR_GRAY2BGR)]


def ocr_votes(tracks: dict, video: str, reader, valid: set[int] | None = None) -> dict:
    """track id → number → [summed confidence, sightings, times]: every reading of every
    track's large boxes. valid: numbers that can appear (e.g. the 22 on the field)."""
    by_time = defaultdict(list)
    for tr in tracks["tracks"]:
        for t, *box in tr.get("boxes", []):
            if box[3] - box[1] >= MIN_H:
                by_time[round(t, 3)].append((tr["id"], box))
    cap = cv2.VideoCapture(video)
    votes: dict = defaultdict(dict)
    for t in sorted(by_time):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        for tid, box in by_time[t]:
            crop = torso(frame, box)
            if crop is None:
                continue
            for img in variants(crop):
                for _, text, conf in reader.readtext(img, allowlist="0123456789", detail=1):
                    if conf < MIN_CONF or not (1 <= len(text) <= 2) or (len(text) == 2 and text[0] == "0"):
                        continue
                    if valid is not None and int(text) not in valid:
                        continue  # no such number on the field
                    v = votes[tid].setdefault(int(text), [0.0, 0, []])
                    v[0] += float(conf)
                    v[1] += 1
                    if t not in v[2]:
                        v[2].append(t)
    return dict(votes)


def cluster_teams(tracks: dict, los: float, offense_right: bool, offense: str, defense: str,
                  window: float = 0.6) -> dict:
    """Color cluster → team, from which side of the line each cluster starts on: at the
    snap the offense is behind the line of scrimmage, so the cluster with more of its
    tracks behind it is the offense. los in the tracks' (video) yards; offense_right: the
    offense moves right on screen. Empty when the two clusters don't clearly differ."""
    starts = [tr["t"][0] for tr in tracks["tracks"] if tr["t"]]
    if not starts:
        return {}
    t0, side = min(starts), defaultdict(lambda: [0, 0])
    for tr in tracks["tracks"]:
        xs = [x for t, x in zip(tr["t"], tr["x"]) if t <= t0 + window]
        if tr["team"] == "other" or not xs:
            continue
        side[tr["team"]][0 if (np.median(xs) < los) == offense_right else 1] += 1
    behind = {c: a / (a + b) for c, (a, b) in side.items()}
    if len(behind) != 2:
        return {}
    d, o = sorted(behind, key=behind.get)
    return {o: offense, d: defense} if behind[o] - behind[d] >= 0.2 else {}


def decide(votes: dict, tracks: dict, teams: dict[int, set[str]] | None = None,
           cluster_team: dict[str, str] | None = None) -> dict:
    """track id → {number, team, votes, reads, confidence, times} from ocr_votes output.

    teams: number → the teams wearing it (export.number_teams). With cluster_team (color cluster → team, see cluster_teams) each
    track may only take its own team's numbers; without it the clusters are tied to teams
    by the reads themselves, which is shaky when there are only a few."""
    cluster = {tr["id"]: tr["team"] for tr in tracks["tracks"]}
    votes = {int(tid): {int(n): v for n, v in nv.items()} for tid, nv in votes.items()}
    own = cluster_team or {}
    if teams and not own:
        side: dict = defaultdict(lambda: defaultdict(float))
        for tid, nv in votes.items():
            for n, v in nv.items():
                if len(teams.get(n, ())) == 1:  # a number only one side has
                    side[cluster.get(tid, "other")][next(iter(teams[n]))] += v[0]
        own = {c: max(t.items(), key=lambda kv: kv[1])[0] for c, t in side.items() if c != "other"}
        if not len(set(own.values())) == len(own) == 2:  # both clusters landed on one team
            own = {}
    out = {}
    for tid, nv in votes.items():
        if cluster.get(tid) == "other":
            continue  # officials and sideline staff wear numbers too
        team = own.get(cluster.get(tid))
        if teams and team:
            nv = {n: v for n, v in nv.items() if team in teams.get(n, ())}
        if not nv:
            continue
        num, (w, count, times) = max(nv.items(), key=lambda kv: kv[1][0])
        if team is None and teams and len(teams.get(num, ())) == 1:
            team = next(iter(teams[num]))
        out[tid] = {"number": num, "team": team, "votes": round(w, 2), "reads": count,
                    "confidence": round(w / sum(v[0] for v in nv.values()), 2), "times": sorted(times)}
    return out


def read_numbers(tracks: dict, video: str, reader, valid: set[int] | None = None,
                 teams: dict[int, set[str]] | None = None, cluster_team: dict[str, str] | None = None) -> dict:
    """ocr_votes + decide."""
    return decide(ocr_votes(tracks, video, reader, valid), tracks, teams, cluster_team)


def check_reads(res, nums, X, Y, teams, snap_frame, snap_video, offset, flip, max_dist=4.0, margin=1.0) -> dict:
    """track id → index of the real player standing where the track was at the moments its
    number was read (majority over those moments). Each color cluster is first tied to the
    team its tracks mostly sit on, and only that team's players are candidates, so a guard is
    not confused with the tackle across from him. Moments when two teammates are about
    equally close are skipped, and tracks too far from anyone are left out."""
    teams = np.array(teams)

    def at(tr, t):
        f = int(round(snap_frame + (t - snap_video + offset) * 10))
        if not (0 <= f < X.shape[1]) or not (tr["t"][0] <= t <= tr["t"][-1]):
            return None
        x, y = float(np.interp(t, tr["t"], tr["x"])), float(np.interp(t, tr["t"], tr["y"]))
        if flip:
            x, y = 120 - x, 160 / 3 - y
        d = np.hypot(X[:, f] - x, Y[:, f] - y)
        d[np.isnan(d)] = 1e9
        return d

    side: dict = defaultdict(lambda: defaultdict(int))
    for tr in res["tracks"]:
        for t in tr["t"][::5]:
            d = at(tr, t)
            if d is not None and d.min() <= max_dist:
                side[tr["team"]][teams[d.argmin()]] += 1
    own = {c: max(v.items(), key=lambda kv: kv[1])[0] for c, v in side.items() if c != "other"}
    tracks = {tr["id"]: tr for tr in res["tracks"]}
    out = {}
    for tid, n in nums.items():
        tr = tracks.get(tid)
        if tr is None:
            continue
        who = defaultdict(int)
        # Reads after the tracking data ends (celebrations, replays of the tackle) fall back
        # to who the track followed over its whole life.
        times = [t for t in n["times"] if at(tr, t) is not None] or tr["t"]
        for t in times:
            d = at(tr, t)
            if d is None:
                continue
            if tr["team"] in own:
                d = np.where(teams == own[tr["team"]], d, 1e9)
            near = np.sort(d)
            # Count a moment only when one player is clearly the closest.
            if near[0] <= max_dist and near[1] - near[0] >= margin:
                who[int(d.argmin())] += 1
        if who:
            out[tid] = max(who.items(), key=lambda kv: kv[1])[0]
    return out


def main():
    import easyocr

    from .evaluate import load_truth, score_offset, video_snap

    ap = argparse.ArgumentParser()
    ap.add_argument("tracks", type=Path)
    ap.add_argument("video")
    ap.add_argument("--truth", type=int, nargs=2, metavar=("GAME", "PLAY"))
    ap.add_argument("--direction", choices=["left", "right"], default="right")
    ap.add_argument("--play", type=int, nargs=2, metavar=("GAME", "PLAY"),
                    help="NFL game and play id: only accept numbers of the 22 players on the field")
    ap.add_argument("--roster", nargs=4, metavar=("SEASON", "WEEK", "TEAM1", "TEAM2"),
                    help="Only accept numbers on these teams' nflverse rosters that week")
    a = ap.parse_args()

    res = json.loads(a.tracks.read_text())
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    valid, field = None, {}
    if a.truth or a.play:
        from .export import game_info, load_on_field, number_teams

        gid, pid = a.truth or a.play
        g = game_info(gid)
        field = load_on_field(g["season"], g["week"], gid, pid)
        valid = {n for _, n in field} or None
    if a.roster and not valid:
        from .export import load_roster

        season, week, t1, t2 = int(a.roster[0]), int(a.roster[1]), a.roster[2], a.roster[3]
        valid = {n for (team, n) in load_roster(season, week) if team in (t1, t2)}
        print(f"{len(valid)} jersey numbers on the {t1}/{t2} rosters")
    raw = ocr_votes(res, a.video, reader, valid)
    (a.tracks.parent / "jerseys_raw.json").write_text(json.dumps({"votes": raw}))
    nums = decide(raw, res, number_teams(field) if field else None)
    print(f"read a number for {len(nums)} of {len(res['tracks'])} tracks")
    if not a.truth:
        print(json.dumps(nums, indent=1))
        return
    play, X, Y = load_truth(*a.truth)
    flip = a.direction == "left"
    sv = video_snap(res)
    best = min((score_offset(res, X, Y, play["snap"], sv, off, flip) + (off,) for off in np.arange(-1, 1.01, 0.1)),
               key=lambda r: np.median(r[0]) if len(r[0]) else 99)
    ident = check_reads(res, nums, X, Y, [q["team"] for q in play["players"]], play["snap"], sv, best[3], flip)
    right = wrong = 0
    for tid, n in nums.items():
        if tid not in ident:
            continue
        truth = play["players"][ident[tid]]
        ok = truth["num"] == n["number"]
        right += ok
        wrong += not ok
        print(f"track {tid:4d}: read #{n['number']:<3} ({n['confidence']:.0%})  truth #{truth['num']} {truth['name']}  {'✓' if ok else '✗'}")
    print(f"\ncorrect {right}/{right + wrong} ({right / max(1, right + wrong):.0%}) of the reads that could be checked")
    (a.tracks.parent / "jerseys.json").write_text(json.dumps({str(k): v for k, v in nums.items()}))


if __name__ == "__main__":
    main()
