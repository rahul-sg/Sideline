"""Build 3D replay data from NFL tracking releases.

Sources (see adapters.py): NFL's public 2017 sample game (downloaded automatically),
the Big Data Bowl 2026 release (2023 season) if its zip is in ~/Downloads, and the
2025 release if you have a copy.

    python3 pipeline/build.py                  # everything found
    python3 pipeline/build.py --weeks 1 2      # a subset of weeks, for quick iteration
    python3 pipeline/build.py --source x.zip   # one release, format auto-detected

Outputs (all under public/data):
  index.json              games, featured plays, QB Read pool
  games/<gameId>.json.gz  every play in a game with per-frame tracking
  routes.bin/.json        route library for Draw & Find
"""
from __future__ import annotations

import argparse
import io
import json
import re
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np
import pandas as pd

import possession
from common import OUT, RAW, clean, team_colors, write_json

PRE_SNAP = 50          # frames (5.0 s) of pre-snap movement kept per play
ROUTE_FRAMES = 40      # route shape window after the snap (4.0 s)
ROUTE_STEP = 2         # sample every other frame (5 Hz) for the route library
FIELD_W = 160 / 3      # 53.33 yards

ZIP_NAME = "nfl-big-data-bowl-2025.zip"
SOURCES = [
    RAW / "bdb2025",
    Path.home() / "Downloads" / "nfl-big-data-bowl-2025",
    RAW / ZIP_NAME,
    Path.home() / "Downloads" / ZIP_NAME,
]

REQUIRED = {
    "games.csv": ["gameId", "week", "gameDate", "homeTeamAbbr", "visitorTeamAbbr", "homeFinalScore", "visitorFinalScore"],
    "plays.csv": ["gameId", "playId", "playDescription", "quarter", "down", "yardsToGo", "possessionTeam",
                  "defensiveTeam", "gameClock", "preSnapHomeScore", "preSnapVisitorScore", "passResult",
                  "yardsGained", "expectedPointsAdded", "preSnapHomeTeamWinProbability",
                  "homeTeamWinProbabilityAdded", "offenseFormation", "pff_passCoverage", "pff_manZone",
                  "playAction", "dropbackType", "timeToThrow", "isDropback", "playNullifiedByPenalty", "qbSpike"],
    "players.csv": ["nflId", "height", "weight", "position", "displayName"],
    "player_play.csv": ["gameId", "playId", "nflId", "wasRunningRoute", "routeRan", "wasTargettedReceiver",
                        "pff_defensiveCoverageAssignment", "hadRushAttempt", "hadPassReception", "hadInterception"],
}
TRACK_COLS = ["gameId", "playId", "nflId", "displayName", "frameId", "frameType", "jerseyNumber", "club",
              "playDirection", "x", "y", "s", "o", "event"]
TRACK_DTYPES = {"gameId": "int64", "playId": "int32", "nflId": "float64", "displayName": "category",
                "frameId": "int32", "frameType": "category", "jerseyNumber": "float32", "club": "category",
                "playDirection": "category", "x": "float32", "y": "float32", "s": "float32", "o": "float32",
                "event": "category"}

THROW_EVENTS = ("pass_forward", "autoevent_passforward", "pass_shovel")
ARRIVE_EVENTS = ("pass_arrived", "pass_outcome_caught", "pass_outcome_incomplete",
                 "pass_outcome_interception", "pass_outcome_touchdown", "autoevent_passinterrupted")
POS_ORDER = ["QB", "RB", "FB", "WR", "TE", "T", "G", "C", "DE", "DT", "NT", "OLB", "ILB", "MLB", "LB", "CB", "FS", "SS", "DB"]


class Source:
    """Reads Big Data Bowl CSVs from either the Kaggle zip or an unzipped folder."""

    def __init__(self, path: Path):
        self.path = path
        self.zip = zipfile.ZipFile(path) if path.suffix == ".zip" else None
        if self.zip:
            self._names = {Path(n).name: n for n in self.zip.namelist()}
        else:
            self._names = {p.name: p for p in path.rglob("*.csv")}

    def names(self):
        return sorted(self._names)

    def read(self, name: str, **kw) -> pd.DataFrame:
        if name not in self._names:
            raise SystemExit(f"Missing {name} in {self.path}")
        if self.zip:
            with self.zip.open(self._names[name]) as f:
                return pd.read_csv(io.BufferedReader(f), **kw)
        return pd.read_csv(self._names[name], **kw)


def find_bdb2025() -> Source | None:
    for p in SOURCES:
        if p.exists():
            return Source(p)
    return None


NO_DATA = (
    "No tracking data found. Options:\n"
    "  - NFL's public sample game downloads automatically (needs internet).\n"
    "  - Big Data Bowl 2026: join https://www.kaggle.com/competitions/nfl-big-data-bowl-2026-analytics,\n"
    "    download the data and leave the zip in ~/Downloads."
)


def check_columns(name: str, df: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED.get(name, []) if c not in df.columns]
    if missing:
        raise SystemExit(f"{name} is missing expected columns: {missing}")


def height_in(h) -> int | None:
    if isinstance(h, str) and "-" in h:
        ft, inch = h.split("-")
        return int(ft) * 12 + int(inch)
    return None


def num(v, nd=None):
    v = clean(v)
    if v is None:
        return None
    if nd is not None:
        return round(float(v), nd)
    return v


def flag(v) -> bool:
    """Interpret Big Data Bowl booleans, which arrive as TRUE/FALSE, Y/N, 1/0 or NaN."""
    v = clean(v)
    if isinstance(v, str):
        return v.strip().upper() in ("TRUE", "Y", "YES", "1")
    return bool(v)


def series(vals: np.ndarray, frame_idx: np.ndarray, n: int) -> np.ndarray:
    """Place values at their frame indices, then fill gaps forward/backward."""
    out = np.full(n, np.nan, dtype=np.float64)
    ok = (frame_idx >= 0) & (frame_idx < n)
    out[frame_idx[ok]] = vals[ok]
    return pd.Series(out).ffill().bfill().to_numpy()


def q(arr: np.ndarray, scale: float) -> list[int]:
    return np.round(np.nan_to_num(arr) * scale).astype(int).tolist()


def first_event(events: list[tuple[int, str]], names, after: int = -1) -> int | None:
    for i, e in events:
        if e in names and i > after:
            return i
    return None


def build_play(t: pd.DataFrame, play, pp: pd.DataFrame, roster: dict, game) -> dict | None:
    t = t.sort_values("frameId")
    snap_rows = t.loc[t.frameType == "SNAP", "frameId"]
    if snap_rows.empty:
        snap_rows = t.loc[t.event == "ball_snap", "frameId"]
    if snap_rows.empty:
        return None
    snap_f = int(snap_rows.min())
    start = max(int(t.frameId.min()), snap_f - PRE_SNAP)
    end = int(t.frameId.max())
    t = t[t.frameId >= start]
    n = end - start + 1
    flip = str(t.playDirection.iloc[0]) == "left"

    x = t.x.to_numpy(np.float64)
    y = t.y.to_numpy(np.float64)
    o = t.o.to_numpy(np.float64)
    if flip:  # normalize so the offense always moves toward +x
        x, y, o = 120 - x, FIELD_W - y, (o + 180) % 360
    fi = t.frameId.to_numpy() - start
    nfl = t.nflId.to_numpy()
    s = t.s.to_numpy(np.float64)

    ev = (t.loc[t.event.notna(), ["frameId", "event"]].drop_duplicates()
          .sort_values("frameId"))
    events = [(int(f) - start, str(e)) for f, e in ev.itertuples(index=False)]
    snap = snap_f - start

    ball_mask = np.isnan(nfl)
    if not ball_mask.any():
        return None
    bx = series(x[ball_mask], fi[ball_mask], n)
    by = series(y[ball_mask], fi[ball_mask], n)

    pp_play = pp.set_index("nflId") if not pp.empty else pp
    offense, defense = play.possessionTeam, play.defensiveTeam
    people = []
    for pid, idx in pd.Series(np.arange(len(t))[~ball_mask], index=nfl[~ball_mask]).groupby(level=0):
        rows = idx.to_numpy()
        first = t.iloc[rows[0]]
        info = roster.get(int(pid), {})
        r = pp_play.loc[pid] if (not pp.empty and pid in pp_play.index) else None
        club = str(first.club)
        people.append({
            "id": int(pid),
            "name": str(first.displayName),
            "num": int(first.jerseyNumber) if not np.isnan(first.jerseyNumber) else None,
            "team": club,
            "off": club == offense,
            "pos": info.get("pos"),
            "h": info.get("h"),
            "w": info.get("w"),
            "runner": bool(r is not None and flag(r.wasRunningRoute)),
            "route": clean(r.routeRan) if r is not None and flag(r.wasRunningRoute) else None,
            # Some releases stop tracking most players at the throw; later frames are modelled.
            "modelled": bool(r is not None and "trackedAfterThrow" in r and not flag(r.trackedAfterThrow)),
            "target": bool(r is not None and flag(r.wasTargettedReceiver)),
            "cov": clean(r.pff_defensiveCoverageAssignment) if r is not None else None,
            "rush": bool(r is not None and flag(r.hadRushAttempt)),
            "rec": bool(r is not None and flag(r.hadPassReception)),
            "int": bool(r is not None and flag(r.hadInterception)),
            "_x": series(x[rows], fi[rows], n),
            "_y": series(y[rows], fi[rows], n),
            "_o": series(o[rows], fi[rows], n),
            "_s": series(s[rows], fi[rows], n),
        })
    if len(people) < 6:
        return None

    rank = {p: i for i, p in enumerate(POS_ORDER)}
    people.sort(key=lambda p: (not p["off"], rank.get(p["pos"], 99), p["num"] or 0))

    los = float(bx[snap])
    ytg = num(play.yardsToGo) or 10
    throw = first_event(events, THROW_EVENTS)
    arrive = first_event(events, ARRIVE_EVENTS, after=throw if throw is not None else -1) if throw is not None else None
    carrier, bx, by = possession.rebuild(people, events, snap, n, bx, by, clean(play.passResult),
                                         play.playDescription, throw, arrive)
    home_score, away_score = num(play.preSnapHomeScore), num(play.preSnapVisitorScore)

    return {
        "id": f"{play.gameId}-{play.playId}",
        "gameId": int(play.gameId),
        "playId": int(play.playId),
        "season": int(game.season),
        "week": int(game.week),
        "home": game.homeTeamAbbr,
        "away": game.visitorTeamAbbr,
        "offense": offense,
        "defense": defense,
        "desc": play.playDescription,
        "quarter": int(play.quarter),
        "clock": play.gameClock,
        "down": num(play.down),
        "ytg": ytg,
        "homeScore": home_score,
        "awayScore": away_score,
        "los": round(los, 2),
        "firstDown": round(min(110.0, los + ytg), 2),
        "ballY": round(float(by[snap]), 2),
        "passResult": clean(play.passResult),
        "yards": num(play.yardsGained),
        "epa": num(play.expectedPointsAdded, 2),
        "homeWp": num(play.preSnapHomeTeamWinProbability, 3),
        "homeWpa": num(play.homeTeamWinProbabilityAdded, 3),
        "formation": clean(play.offenseFormation),
        "coverage": clean(play.pff_passCoverage),
        "manZone": clean(play.pff_manZone),
        "playAction": flag(play.playAction),
        "dropback": clean(play.dropbackType),
        "timeToThrow": num(play.timeToThrow, 2),
        "isPass": flag(play.isDropback) or throw is not None,
        "fps": 10,
        # Direction the offense moved in stadium coordinates, before normalizing to +x.
        "rawDirection": "left" if flip else "right",
        "n": n,
        "snap": snap,
        "throw": throw,
        "arrive": arrive,
        "events": events,
        "players": [{k: v for k, v in p.items() if not k.startswith("_")} for p in people],
        # Quantized tracks: x/y in 0.1 yd, orientation in degrees, speed in 0.1 yd/s.
        "x": [q(p["_x"], 10) for p in people],
        "y": [q(p["_y"], 10) for p in people],
        "o": [q(p["_o"], 1) for p in people],
        "s": [q(p["_s"], 10) for p in people],
        "bx": q(bx, 10),
        "by": q(by, 10),
        # Ball possession as [startFrame, playerIndex] runs; -1 = loose or in the air.
        "carrier": possession.runs(carrier),
        "_people": people,
    }


def route_shapes(play: dict) -> list[tuple[dict, np.ndarray]]:
    """Route runner trajectories relative to their snap position, outside = +y."""
    out = []
    s, n = play["snap"], play["n"]
    idx = np.minimum(np.arange(s, s + ROUTE_FRAMES + 1, ROUTE_STEP), n - 1)
    for p in play["_people"]:
        if not p["runner"]:
            continue
        x, y = p["_x"][idx], p["_y"][idx]
        side = 1.0 if p["_y"][s] >= play["ballY"] - 0.5 else -1.0
        dx, dy = x - x[0], (y - y[0]) * side
        out.append((p, np.stack([dx, dy], axis=1)))
    return out


@dataclass
class Chunk:
    """A batch of tracking in Big Data Bowl 2025 column layout, plus its lookup tables."""
    name: str
    games: pd.DataFrame          # indexed by gameId
    plays: pd.DataFrame          # indexed by (gameId, playId)
    pp_by_play: dict
    roster: dict
    tracking: pd.DataFrame


def chunks_bdb2025(src: Source, weeks: list[int] | None) -> Iterator[Chunk]:
    tables = {}
    for name in REQUIRED:
        df = src.read(name, low_memory=False)
        check_columns(name, df)
        tables[name] = df
    games, plays, players, pp = (tables[k] for k in REQUIRED)
    games = games.set_index("gameId")
    plays = plays.set_index(["gameId", "playId"]).sort_index()
    pp_by_play = {k: g for k, g in pp.groupby(["gameId", "playId"])}
    roster = {int(r.nflId): {"pos": r.position, "h": height_in(r.height), "w": clean(r.weight)}
              for r in players.itertuples()}
    week_files = sorted((n for n in src.names() if re.fullmatch(r"tracking_week_\d+\.csv", n)),
                        key=lambda n: int(re.findall(r"\d+", n)[0]))
    if weeks:
        week_files = [w for w in week_files if int(re.findall(r"\d+", w)[0]) in weeks]
    for wf in week_files:
        tw = time.time()
        track = src.read(wf, usecols=TRACK_COLS, dtype=TRACK_DTYPES)
        print(f"{wf}: {len(track):,} rows read in {time.time() - tw:.0f}s")
        yield Chunk(wf, games, plays, pp_by_play, roster, track)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks", type=int, nargs="*")
    ap.add_argument("--source", type=Path, help="One Big Data Bowl zip or folder, any release (default: every source found)")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--featured", type=Path, default=Path(__file__).parent / "featured.json")
    ap.add_argument("--label", default=None)
    args = ap.parse_args()
    out = args.out
    t0 = time.time()

    from adapters import available_sources, source_for  # noqa: E402  (adapters imports from this module)

    if args.source:
        sources = [source_for(args.source, args.weeks)]
    else:
        sources = available_sources(args.weeks)
    if not sources:
        raise SystemExit(NO_DATA)

    featured = json.loads(args.featured.read_text())
    featured_ids = {(f["gameId"], f["playId"]) for f in featured}
    found_featured: dict = {}

    game_index, qb_pool = [], []
    route_pts, route_meta = [], []
    route_types: list[str] = []
    route_players: dict[int, list] = {}
    game_order: dict[int, int] = {}
    labels: list[str] = []
    total_bytes, total_plays, skipped = 0, 0, 0

    for label, chunks in sources:
        labels.append(label)
        print(f"== {label}")
        for chunk in chunks:
            tw = time.time()
            for gid, gt in chunk.tracking.groupby("gameId", sort=True, observed=True):
                gid = int(gid)
                game = chunk.games.loc[gid]
                game_plays = []
                for pid, t in gt.groupby("playId", sort=True, observed=True):
                    key = (gid, int(pid))
                    if key not in chunk.plays.index:
                        skipped += 1
                        continue
                    play = chunk.plays.loc[key]
                    play = pd.Series({**play.to_dict(), "gameId": gid, "playId": int(pid)})
                    built = build_play(t, play, chunk.pp_by_play.get(key, pd.DataFrame()), chunk.roster, game)
                    if built is None:
                        skipped += 1
                        continue
                    built["source"] = label

                    gi = game_order.setdefault(gid, len(game_order))
                    route_list = route_shapes(built)
                    if built["isPass"] and not flag(play.playNullifiedByPenalty):
                        for p, pts in route_list:
                            rt = p["route"] or "OTHER"
                            if rt not in route_types:
                                route_types.append(rt)
                            route_pts.append(pts)
                            route_players.setdefault(p["id"], [p["name"], p["pos"]])
                            route_meta.append([gi, built["playId"], p["id"], route_types.index(rt),
                                               int(p["target"]), built["passResult"] or "", p["team"]])
                        targeted = [p for p in built["_people"] if p["target"]]
                        if (built["throw"] is not None and targeted and len(route_list) >= 3
                                and built["passResult"] in ("C", "I", "IN") and not flag(play.qbSpike)):
                            qb_pool.append([gid, built["playId"]])

                    if key in featured_ids:
                        found_featured[key] = built
                    del built["_people"]
                    game_plays.append(built)

                if not game_plays:
                    continue
                payload = {"gameId": gid, "season": int(game.season), "week": int(game.week), "date": game.gameDate,
                           "home": game.homeTeamAbbr, "away": game.visitorTeamAbbr, "plays": game_plays}
                total_bytes += write_json(out / "games" / f"{gid}.json.gz", payload, gz=True)
                total_plays += len(game_plays)
                game_index.append({
                    "gameId": gid, "season": int(game.season), "week": int(game.week), "date": game.gameDate,
                    "time": clean(game.gameTimeEastern), "home": game.homeTeamAbbr, "away": game.visitorTeamAbbr,
                    "homeScore": num(game.homeFinalScore), "awayScore": num(game.visitorFinalScore),
                    "plays": len(game_plays), "source": label,
                })
            print(f"  done {chunk.name} ({time.time() - tw:.0f}s, {total_plays:,} plays so far)")

    featured_out = []
    for f in featured:
        p = found_featured.get((f["gameId"], f["playId"]))
        if p is None:
            print(f"  featured play not in tracking data: {f['gameId']}-{f['playId']} {f['title']}")
            continue
        featured_out.append({**f, "id": p["id"], "season": p["season"], "week": p["week"], "offense": p["offense"],
                             "defense": p["defense"], "home": p["home"], "away": p["away"],
                             "quarter": p["quarter"], "clock": p["clock"], "yards": p["yards"]})

    # Route library: int16 points (0.1 yd), [route][point][dx, dy].
    pts = np.round(np.stack(route_pts) * 10).astype("<i2") if route_pts else np.zeros((0, 21, 2), "<i2")
    out.mkdir(parents=True, exist_ok=True)
    (out / "routes.bin").write_bytes(pts.tobytes())
    game_ids = sorted(game_order, key=game_order.get)
    write_json(out / "routes.json", {
        "count": len(route_meta), "points": int(pts.shape[1]) if len(pts) else 0, "stepSeconds": ROUTE_STEP / 10,
        "scale": 10, "games": game_ids, "routeTypes": route_types,
        "players": {str(k): v for k, v in route_players.items()},
        "columns": ["game", "playId", "nflId", "routeType", "targeted", "passResult", "team"],
        "rows": route_meta,
    })
    write_json(out / "index.json", {
        "source": args.label or " + ".join(labels),
        "builtAt": time.strftime("%Y-%m-%d %H:%M"),
        "games": sorted(game_index, key=lambda g: (-g["season"], g["week"], g["date"], g["gameId"])),
        "featured": featured_out,
        "qbPool": qb_pool,
        "routeCount": len(route_meta),
    })
    write_json(out / "teams.json", team_colors())
    print(f"\n{total_plays:,} plays in {len(game_index)} games ({total_bytes / 1e6:.0f} MB gz), "
          f"{len(route_meta):,} routes, {len(qb_pool):,} QB Read plays, {len(featured_out)}/{len(featured)} featured, "
          f"{skipped} skipped, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
