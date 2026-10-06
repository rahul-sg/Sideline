"""Turn video-derived tracks into a play the 3D app can replay.

    python -m sideline_vision.export out/play1/tracks.json --offense B --direction left \\
        --home WSU --away ORE --offense-team WSU --title "Oregon at Washington State" --desc "..."

Writes public/data/games/<id>.json.gz and adds the play to public/data/video/index.json,
which the app merges into its play list labelled "Estimated from broadcast video".
Track pieces of the same player are joined (stitch), players seen for at least 1.5 s are
kept (11 a side at most), and the app fades them while they're off camera.
"""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "public" / "data"
FIELD_W = 160 / 3


def load_roster(season: int, week: int) -> dict:
    """(team, jersey number) → (name, position) from nflverse weekly rosters."""
    import csv
    import urllib.request

    cache = ROOT / "pipeline" / "raw" / f"roster_weekly_{season}.csv"
    if not cache.exists():
        url = f"https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{season}.csv"
        urllib.request.urlretrieve(url, cache)
    out = {}
    with cache.open() as f:
        for r in csv.DictReader(f):
            if r.get("week") and int(float(r["week"])) == week and r.get("jersey_number"):
                out[(r["team"], int(float(r["jersey_number"])))] = (r["full_name"], r.get("position") or None)
    return out


def _nflverse(name: str, url: str) -> Path:
    import urllib.request

    cache = ROOT / "pipeline" / "raw" / name
    if not cache.exists():
        urllib.request.urlretrieve(url, cache)
    return cache


def stitch(tracks: list[dict], numbers: dict[int, int] | None = None, max_gap: float = 1.5,
           speed: float = 9.0, slack: float = 1.5) -> list[dict]:
    """Join track pieces that are the same player. The tracker loses people when they
    leave the frame (the camera follows the ball) or pass behind others, and picks them up
    under a new id. A piece can continue another of the same team that ended up to `max_gap`
    s before it started (or overlaps it by a frame or two), no farther away than a sprinting
    player could get, and with no disagreeing jersey number. Links are made cheapest first
    (distance + 2 × gap), each piece getting at most one predecessor and one successor.
    Returns merged tracks (id of the first piece, `ids` of all)."""
    numbers = numbers or {}
    pieces = {t["id"]: t for t in tracks if t["team"] != "other" and len(t["t"]) >= 3}
    links = []
    for e in pieces.values():
        for s_ in pieces.values():
            gap = s_["t"][0] - e["t"][-1]
            if e is s_ or e["team"] != s_["team"] or not -0.2 <= gap <= max_gap or s_["t"][0] <= e["t"][0]:
                continue
            if e["id"] in numbers and s_["id"] in numbers and numbers[e["id"]] != numbers[s_["id"]]:
                continue
            d = float(np.hypot(s_["x"][0] - e["x"][-1], s_["y"][0] - e["y"][-1]))
            if d <= speed * max(gap, 0.1) + slack:
                links.append((d + 2 * max(gap, 0.0), e["id"], s_["id"]))
    nxt, prv = {}, {}
    for _, e, s_ in sorted(links):
        if e not in nxt and s_ not in prv:
            nxt[e], prv[s_] = s_, e
    out = []
    for head in (i for i in pieces if i not in prv):
        chain, i = [], head
        while i is not None:
            chain.append(pieces[i])
            i = nxt.get(i)
        t, x, y, last = [], [], [], -1e9
        for q in chain:  # drop the overlapping frames of the later piece
            keep = [k for k, v in enumerate(q["t"]) if v > last]
            t += [q["t"][k] for k in keep]
            x += [q["x"][k] for k in keep]
            y += [q["y"][k] for k in keep]
            last = t[-1] if t else last
        out.append({"id": head, "ids": [q["id"] for q in chain], "team": chain[0]["team"], "t": t, "x": x, "y": y})
    return out


def seen_runs(t: np.ndarray, grid: np.ndarray, gap: float = 0.25) -> list[list[int]]:
    """Frame ranges of the grid covered by observation times t (breaks longer than `gap` s split)."""
    runs: list[list[int]] = []
    for i, g in enumerate(grid):
        if np.min(np.abs(t - g)) <= gap:
            if runs and runs[-1][1] == i - 1:
                runs[-1][1] = i
            else:
                runs.append([i, i])
    return runs


def game_info(game_id: int) -> dict:
    """season, week, home, away for an NFL game id like 2017090700 (nflverse schedule)."""
    import csv

    games = _nflverse("games.csv", "https://github.com/nflverse/nfldata/raw/master/data/games.csv")
    with games.open() as f:
        for r in csv.DictReader(f):
            if r["old_game_id"] == str(game_id):
                return {"season": int(r["season"]), "week": int(r["week"]), "home": r["home_team"], "away": r["away_team"]}
    raise SystemExit(f"Game {game_id} not in the nflverse schedule")


MIN_READS, MIN_SHARE = 2, 0.6  # a name needs ≥2 sightings of the number and most of the votes


def name_tracks(jerseys: dict, track_team: dict, roster: dict) -> dict:
    """track id → (number, name, position), one track per player.

    jerseys: jersey.py output; track_team: track id → club; roster: (club, number) →
    (name, position). A number that isn't on that club's list is dropped, and when two
    tracks claim the same player the better-supported read wins."""
    best: dict = {}
    for tid, j in jerseys.items():
        tid = int(tid)
        club = track_team.get(tid)
        key = (club, j["number"])
        if j.get("reads", MIN_READS) < MIN_READS or j["confidence"] < MIN_SHARE or key not in roster:
            continue
        if key not in best or j["votes"] > best[key][1]:
            best[key] = (tid, j["votes"])
    return {tid: (num, *roster[(club, num)]) for (club, num), (tid, _) in best.items()}


def load_on_field(season: int, week: int, game_id: int, play_id: int) -> dict:
    """(team, jersey number) → (name, position) for the 22 players on the field for one
    play, from nflverse play participation (2016 on). Empty when the play isn't listed.
    Keyed by team too: both sides can have the same number on the field."""
    import csv

    part = _nflverse(f"pbp_participation_{season}.csv",
                     f"https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_{season}.csv")
    ids = []
    with part.open() as f:
        for r in csv.DictReader(f):
            if r["old_game_id"] == str(game_id) and r["play_id"] == str(play_id):
                ids = [x for x in (r["offense_players"] + ";" + r["defense_players"]).split(";") if x]
                break
    if not ids:
        return {}
    roster = _nflverse(f"roster_weekly_{season}.csv",
                       f"https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{season}.csv")
    out = {}
    with roster.open() as f:
        for r in csv.DictReader(f):
            if r["gsis_id"] in ids and r.get("week") and int(float(r["week"])) == week and r.get("jersey_number"):
                out[(r["team"], int(float(r["jersey_number"])))] = (r["full_name"], r.get("position") or None)
    return out


def number_teams(roster: dict) -> dict[int, set[str]]:
    """Jersey number → the teams that have it, from a (team, number) roster."""
    out: dict = {}
    for team, n in roster:
        out.setdefault(n, set()).add(team)
    return out


def roster_to_json(roster: dict) -> list:
    return [[team, n, name, pos] for (team, n), (name, pos) in roster.items()]


def roster_from_json(rows) -> dict:
    if isinstance(rows, dict):  # older saves: number → [team, name, position]
        return {(v[0], int(n)): (v[1], v[2]) for n, v in rows.items()}
    return {(team, int(n)): (name, pos) for team, n, name, pos in rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tracks", type=Path)
    ap.add_argument("--offense", required=True, help="Which color cluster has the ball: A or B")
    ap.add_argument("--direction", required=True, choices=["left", "right"], help="Direction the offense moves on screen")
    ap.add_argument("--home", required=True)
    ap.add_argument("--away", required=True)
    ap.add_argument("--offense-team", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--desc", default="")
    ap.add_argument("--min-seen", type=float, default=1.5,
                    help="Keep players seen for at least this many seconds (after joining track pieces)")
    ap.add_argument("--id", type=int, default=None)
    ap.add_argument("--colors", default="", help="Team colors for non-NFL teams: ABBR=Name:#primary:#secondary,...")
    ap.add_argument("--season", type=int, help="With --week: name players from nflverse rosters using read jersey numbers")
    ap.add_argument("--week", type=int)
    ap.add_argument("--nfl-play", type=int, nargs=2, metavar=("GAME", "PLAY"),
                    help="NFL game and play id: name players from the 22 who were on the field")
    a = ap.parse_args()

    res = json.loads(a.tracks.read_text())
    roster = {}
    if a.nfl_play:
        g = game_info(a.nfl_play[0])
        roster = load_on_field(g["season"], g["week"], *a.nfl_play)
    if not roster and a.season and a.week:
        roster = load_roster(a.season, a.week)
    defense_team = a.home if a.offense_team == a.away else a.away
    track_team = {tr["id"]: a.offense_team if tr["team"] == a.offense else defense_team
                  for tr in res["tracks"] if tr["team"] != "other"}
    raw_path, jerseys_path = a.tracks.parent / "jerseys_raw.json", a.tracks.parent / "jerseys.json"
    if raw_path.exists() and roster:
        # Raw reads: decide again knowing which color is which team.
        from .jersey import decide

        own = {tr["team"]: track_team[tr["id"]] for tr in res["tracks"] if tr["id"] in track_team}
        jerseys = decide(json.loads(raw_path.read_text())["votes"], res, number_teams(roster), own)
    else:
        jerseys = json.loads(jerseys_path.read_text()) if jerseys_path.exists() else {}
    names = name_tracks(jerseys, track_team, roster)
    grid = np.round(np.arange(res["start"], res["end"] + 1e-9, 0.1), 2)
    n = len(grid)
    flip = a.direction == "left"
    players, X, Y, O, S = [], [], [], [], []
    merged = stitch(res["tracks"], {tid: v[0] for tid, v in names.items()})
    merged = [m for m in merged if len(m["t"]) >= a.min_seen * 10]
    # At most 11 a side: the ones seen longest.
    merged = [m for team in ("A", "B") for m in sorted((m for m in merged if m["team"] == team),
                                                       key=lambda m: -len(m["t"]))[:11]]
    for tr in merged:
        t = np.array(tr["t"])
        x = np.interp(grid, t, tr["x"])
        y = np.interp(grid, t, tr["y"])
        if flip:
            x, y = 120 - x, FIELD_W - y
        dx, dy = np.gradient(x) * 10, np.gradient(y) * 10
        s = np.hypot(dx, dy)
        o = (np.degrees(np.arctan2(dx, dy)) + 360) % 360
        off = tr["team"] == a.offense
        o = np.where(s > 0.8, o, 90.0 if off else 270.0)
        club = a.offense_team if off else defense_team
        num, name, pos = next((names[i] for i in tr["ids"] if i in names), (None, "Unidentified", None))
        runs = seen_runs(t, grid)
        players.append({"id": 900000 + tr["id"], "name": name, "num": num,
                        "team": club, "off": off, "pos": pos,
                        "h": None, "w": None, "runner": False, "route": None, "target": False, "cov": None,
                        "rush": False, "rec": False, "int": False,
                        **({"seen": runs} if sum(b - a_ + 1 for a_, b in runs) < n else {})})
        X.append(np.round(x * 10).astype(int).tolist())
        Y.append(np.round(y * 10).astype(int).tolist())
        O.append(np.round(o).astype(int).tolist())
        S.append(np.round(s * 10).astype(int).tolist())
    if not players:
        raise SystemExit("No tracks cover enough of the clip")
    # Named players first in each team's list.
    order = sorted(range(len(players)), key=lambda i: (not players[i]["off"], players[i]["num"] is None))
    players, X, Y, O, S = ([seq[i] for i in order] for seq in (players, X, Y, O, S))
    from .evaluate import video_snap

    snap = int(np.clip(round((video_snap(res) - res["start"]) * 10), 0, n - 1))

    # The line of scrimmage sits between the two fronts at the first frame.
    x0 = np.array([xs[0] / 10 for xs in X])
    offx = x0[[p["off"] for p in players]]
    defx = x0[[not p["off"] for p in players]]
    los = float((offx.max() + defx.min()) / 2) if len(offx) and len(defx) else float(np.median(x0))
    gid = a.id or 9000000000 + int(abs(hash((res["video"], res["start"]))) % 1000000)
    play = {
        "id": f"{gid}-1", "gameId": gid, "playId": 1, "season": 0, "week": 0, "source": "Estimated from broadcast video",
        "home": a.home, "away": a.away, "offense": a.offense_team, "defense": defense_team,
        "desc": a.desc or f"{res['video']} {res['start']:.1f}-{res['end']:.1f}s",
        "quarter": 0, "clock": "", "down": None, "ytg": 10, "homeScore": None, "awayScore": None,
        "los": round(los, 2), "firstDown": round(los + 10, 2), "ballY": FIELD_W / 2,
        "passResult": None, "yards": None, "epa": None, "homeWp": None, "homeWpa": None,
        "formation": None, "coverage": None, "manZone": None, "playAction": False, "dropback": None,
        "timeToThrow": None, "isPass": False, "fps": 10, "n": n, "snap": snap, "throw": None, "arrive": None,
        "events": [], "noBall": True, "fitError": res["fitError"],
        "players": players, "x": X, "y": Y, "o": O, "s": S,
        "bx": [round(los * 10)] * n, "by": [round(FIELD_W / 2 * 10)] * n, "carrier": [[0, -1]],
    }
    (DATA / "games").mkdir(parents=True, exist_ok=True)
    (DATA / "games" / f"{gid}.json.gz").write_bytes(gzip.compress(json.dumps(
        {"gameId": gid, "season": 0, "week": 0, "date": "", "home": a.home, "away": a.away, "plays": [play]}).encode()))
    idx_path = DATA / "video" / "index.json"
    idx_path.parent.mkdir(parents=True, exist_ok=True)
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else {"games": [], "featured": []}
    idx["games"] = [g for g in idx["games"] if g["gameId"] != gid] + [{
        "gameId": gid, "season": 0, "week": 0, "date": "", "time": None, "home": a.home, "away": a.away,
        "homeScore": None, "awayScore": None, "plays": 1, "source": "Estimated from broadcast video"}]
    idx["featured"] = [f for f in idx["featured"] if f["gameId"] != gid] + [{
        "id": play["id"], "gameId": gid, "playId": 1, "title": a.title, "subtitle": "Estimated from broadcast video",
        "film": None, "season": 0, "week": 0, "offense": a.offense_team, "defense": defense_team,
        "home": a.home, "away": a.away, "quarter": 0, "clock": "", "yards": None}]
    for spec in filter(None, a.colors.split(",")):
        abbr, rest = spec.split("=")
        name, primary, secondary = rest.split(":")
        idx.setdefault("teams", {})[abbr] = {"name": name, "nick": name.split()[-1], "primary": primary,
                                              "secondary": secondary, "tertiary": None}
    idx_path.write_text(json.dumps(idx))
    print(f"{len(players)} players ({sum(p['num'] is not None for p in players)} named), {n} frames "
          f"→ games/{gid}.json.gz; listed in video/index.json")


if __name__ == "__main__":
    main()
