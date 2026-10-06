"""Big Data Bowl 2026 (2023 season, pass plays) → the 2025 layout build.py expects.

What the release contains, and what this adapter fills in:
  - input_2023_wNN.csv: every tracked player from the start of the play to the throw.
  - output_2023_wNN.csv: x/y after the throw, only for players the competition asked
    to predict (targeted receiver and defenders in coverage).
  - supplementary_data.csv: game and play context.
Not in the data, so modelled here and flagged in the output:
  - Players with no post-throw tracking coast to a stop over ~1 s (they're drawn faded).
  - The ball is with the passer until the throw, then travels to ball_land_x/y.
  - Jersey numbers come from nflverse weekly rosters, matched by the NFL player id (the
    tracking's nflId is the rosters' gsis_it_id), falling back to team and name.
"""
from __future__ import annotations

import re
import time
import unicodedata
import urllib.request
from pathlib import Path
from typing import Iterator

import numpy as np
import pandas as pd

from build import RAW, Chunk, Source, clean, height_in

ZIP_NAMES = ["nfl-big-data-bowl-2026-analytics.zip", "nfl-big-data-bowl-2026-prediction.zip"]
CANDIDATES = [RAW / "bdb2026", *(Path.home() / "Downloads" / z.removesuffix(".zip") for z in ZIP_NAMES),
              *(RAW / z for z in ZIP_NAMES), *(Path.home() / "Downloads" / z for z in ZIP_NAMES)]
ROSTERS = "https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{season}.csv"
COAST_TAU = 0.6  # seconds; untracked players slow to a stop after the throw


def find_bdb2026() -> Source | None:
    for p in CANDIDATES:
        if p.exists():
            src = Source(p)
            if any(re.fullmatch(r"input_\d{4}_w\d+\.csv", n) for n in src.names()):
                return src
    return None


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s)
    return re.sub(r"[^a-z]", "", s)


def _jerseys(season: int) -> dict:
    """Lookups for jersey numbers: (week, nflId), nflId in any week, and (week, team, name).
    Ids matter: tracking names are often nicknames ("Tank Dell" is "Nathaniel Dell")."""
    out = {"id": {}, "any": {}, "name": {}}
    f = RAW / f"roster_weekly_{season}.csv"
    if not f.exists():
        try:
            urllib.request.urlretrieve(ROSTERS.format(season=season), f)
        except Exception as e:
            print(f"  no nflverse rosters ({e}); jersey numbers left blank")
            return out
    r = pd.read_csv(f, low_memory=False)
    r = r.dropna(subset=["jersey_number"])
    for row in r.itertuples(index=False):
        w, j = int(row.week), int(row.jersey_number)
        out["name"][(w, row.team, _norm(row.full_name))] = j
        gid = getattr(row, "gsis_it_id", None)
        if gid is not None and not pd.isna(gid):
            out["id"][(w, int(float(gid)))] = j
            out["any"][int(float(gid))] = j
    return out


def _jersey(jerseys: dict, week: int, nid: int, club: str, name: str) -> int | None:
    for v in (jerseys["id"].get((week, nid)), jerseys["name"].get((week, club, _norm(name))), jerseys["any"].get(nid)):
        if v is not None:
            return v  # 0 is a real number since 2023
    return None


def _final_scores() -> dict:
    f = RAW / "games.csv"
    if not f.exists():
        try:
            urllib.request.urlretrieve("https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv", f)
        except Exception:
            return {}
    g = pd.read_csv(f, usecols=["old_game_id", "home_score", "away_score"]).dropna()
    return {int(r.old_game_id): (int(r.home_score), int(r.away_score)) for r in g.itertuples()}


def _find(src: Source, pattern: str) -> list[str]:
    return sorted(n for n in src.names() if re.fullmatch(pattern, n))


def _los_x(p: pd.DataFrame, offense: str, direction: str) -> float | None:
    """Line of scrimmage in raw x. absolute_yardline_number should be it; check it against the
    front of the offense at the first frame, and fall back to the mirrored value if that fits better."""
    if "absolute_yardline_number" not in p:
        return None
    a = float(p.absolute_yardline_number.iloc[0])
    first = p[(p.frame_id == p.frame_id.min()) & p.player_side.str.lower().str.startswith("off")]
    if first.empty:
        return a
    front = first.x.min() if direction == "left" else first.x.max()
    return min((a, 120 - a), key=lambda c: abs(c - front))


def chunks_bdb2026(src: Source, weeks: list[int] | None) -> Iterator[Chunk]:
    supp_name = next((n for n in src.names() if "supplement" in n.lower()), None)
    if not supp_name:
        print("  supplementary_data.csv not found in the 2026 release")
        return
    supp = src.read(supp_name, low_memory=False)
    season = int(supp.season.iloc[0])
    jerseys = _jerseys(season)

    g = supp.drop_duplicates("game_id")
    finals = _final_scores()
    games = pd.DataFrame({
        "gameId": g.game_id, "season": g.season, "week": g.week, "gameDate": g.game_date,
        "gameTimeEastern": g.game_time_eastern, "homeTeamAbbr": g.home_team_abbr,
        "visitorTeamAbbr": g.visitor_team_abbr,
        # Final scores aren't in this release; nflverse schedules have them.
        "homeFinalScore": [finals.get(int(x), (None, None))[0] for x in g.game_id],
        "visitorFinalScore": [finals.get(int(x), (None, None))[1] for x in g.game_id],
    }).set_index("gameId")
    s = supp
    plays = pd.DataFrame({
        "gameId": s.game_id, "playId": s.play_id, "playDescription": s.play_description, "quarter": s.quarter,
        "down": s.down, "yardsToGo": s.yards_to_go, "possessionTeam": s.possession_team,
        "defensiveTeam": s.defensive_team, "gameClock": s.game_clock, "preSnapHomeScore": s.pre_snap_home_score,
        "preSnapVisitorScore": s.pre_snap_visitor_score, "passResult": s.pass_result, "yardsGained": s.yards_gained,
        "expectedPointsAdded": s.expected_points_added,
        "preSnapHomeTeamWinProbability": s.pre_snap_home_team_win_probability,
        "homeTeamWinProbabilityAdded": s.home_team_win_probability_added, "offenseFormation": s.offense_formation,
        "pff_passCoverage": s.team_coverage_type, "pff_manZone": s.team_coverage_man_zone,
        "playAction": s.play_action, "dropbackType": s.dropback_type, "timeToThrow": None, "isDropback": True,
        "playNullifiedByPenalty": s.play_nullified_by_penalty, "qbSpike": False,
        "_route": s.route_of_targeted_receiver,
    }).set_index(["gameId", "playId"]).sort_index()

    inputs = _find(src, r"input_\d{4}_w\d+\.csv")
    if weeks:
        inputs = [n for n in inputs if int(re.findall(r"w(\d+)", n)[0]) in weeks]
    for name in inputs:
        tw = time.time()
        wk = re.findall(r"w(\d+)", name)[0]
        inp = src.read(name, low_memory=False)
        out_name = name.replace("input_", "output_")
        out = src.read(out_name, low_memory=False) if out_name in src.names() else inp.iloc[0:0][["game_id", "play_id", "nfl_id", "frame_id", "x", "y"]]
        print(f"{name}: {len(inp):,} rows, {len(out):,} post-throw rows ({time.time() - tw:.0f}s)")
        yield _week_chunk(name, int(wk), inp, out, games, plays, jerseys)


def _week_chunk(name, week, inp, out, games, plays, jerseys) -> Chunk:
    roster, pp_rows, frames = {}, [], []
    out_by = {k: v.sort_values("frame_id") for k, v in out.groupby(["game_id", "play_id", "nfl_id"])}
    for (gid, pid), p in inp.groupby(["game_id", "play_id"], sort=True):
        key = (int(gid), int(pid))
        if key not in plays.index:
            continue
        info = plays.loc[key]
        n_in = int(p.frame_id.max())
        n_out = int(p.num_frames_output.max()) if "num_frames_output" in p else 0
        direction = p.play_direction.iloc[0]
        land = (float(p.ball_land_x.iloc[0]), float(p.ball_land_y.iloc[0]))
        result = clean(info.passResult)
        passer_xy = None

        for nid, pl in p.groupby("nfl_id", sort=False):
            pl = pl.sort_values("frame_id")
            nid = int(nid)
            off = str(pl.player_side.iloc[0]).lower().startswith("off")
            club = info.possessionTeam if off else info.defensiveTeam
            role = str(pl.player_role.iloc[0])
            pname = str(pl.player_name.iloc[0])
            roster.setdefault(nid, {"pos": clean(pl.player_position.iloc[0]), "h": height_in(pl.player_height.iloc[0]),
                                    "w": clean(pl.player_weight.iloc[0])})
            num = _jersey(jerseys, week, nid, club, pname)
            x, y = pl.x.to_numpy(float), pl.y.to_numpy(float)
            sp, o = pl.s.to_numpy(float), pl.o.to_numpy(float)
            fid = pl.frame_id.to_numpy(int)
            tracked_after = (key[0], key[1], nid) in out_by
            if tracked_after:
                po = out_by[(key[0], key[1], nid)]
                px, py = po.x.to_numpy(float), po.y.to_numpy(float)
                prev = np.r_[x[-1], px]
                prey = np.r_[y[-1], py]
                ps = np.hypot(np.diff(prev), np.diff(prey)) * 10
                heading = (np.degrees(np.arctan2(np.diff(prev), np.diff(prey))) + 360) % 360
                po_o = np.where(ps > 1.0, heading, o[-1])
                pf = n_in + po.frame_id.to_numpy(int)
            else:
                # Coast to a stop along the last direction of travel.
                k = np.arange(1, n_out + 1) / 10
                dist = sp[-1] * COAST_TAU * (1 - np.exp(-k / COAST_TAU))
                d = np.radians(pl.dir.to_numpy(float)[-1])
                px, py = x[-1] + np.sin(d) * dist, y[-1] + np.cos(d) * dist
                ps = sp[-1] * np.exp(-k / COAST_TAU)
                po_o = np.full(n_out, o[-1])
                pf = n_in + np.arange(1, n_out + 1)
            if role.lower() == "passer":
                passer_xy = (x, y, o)
            frames.append(pd.DataFrame({
                "gameId": key[0], "playId": key[1], "nflId": float(nid), "displayName": pname,
                "frameId": np.r_[fid, pf], "frameType": None, "jerseyNumber": float(num) if num is not None else np.nan,
                "club": club, "playDirection": direction, "x": np.r_[x, px], "y": np.r_[y, py],
                "s": np.r_[sp, ps], "o": np.r_[o, po_o], "event": None,
            }))
            target = role.lower().startswith("targeted")
            pp_rows.append({
                "gameId": key[0], "playId": key[1], "nflId": nid,
                "wasRunningRoute": 1 if role.lower() in ("targeted receiver", "other route runner") else None,
                "routeRan": clean(info._route) if target else None,
                "wasTargettedReceiver": int(target), "pff_defensiveCoverageAssignment": None,
                "hadRushAttempt": 0, "hadPassReception": int(target and result == "C"),
                "hadInterception": 0, "trackedAfterThrow": int(tracked_after),
            })

        # Ball: snapped from the line, with the passer until the release, then to where the pass landed.
        if passer_xy is None:
            continue
        bx_in, by_in, po_ = passer_xy
        fwd = np.radians(po_)
        bx = bx_in + np.sin(fwd) * 0.35
        by = by_in + np.cos(fwd) * 0.35
        los = _los_x(p, info.possessionTeam, direction)
        if los is not None:
            k_snap = np.clip(np.arange(len(bx)) / 4, 0, 1)  # ~0.4 s exchange
            bx = los + (bx - los) * k_snap
        k = np.arange(1, n_out + 1) / max(1, n_out)
        fx = bx[-1] + (land[0] - bx[-1]) * k
        fy = by[-1] + (land[1] - by[-1]) * k
        n_total = n_in + n_out
        events = [None] * n_total
        events[0] = "ball_snap"
        events[n_in - 1] = "pass_forward"
        if n_out:
            events[n_total - 1] = {"C": "pass_outcome_caught", "IN": "pass_outcome_interception"}.get(result, "pass_arrived")
        frames.append(pd.DataFrame({
            "gameId": key[0], "playId": key[1], "nflId": np.nan, "displayName": "football",
            "frameId": np.arange(1, n_total + 1), "frameType": None, "jerseyNumber": np.nan, "club": "football",
            "playDirection": direction, "x": np.r_[bx, fx], "y": np.r_[by, fy], "s": 0.0, "o": np.nan, "event": None,
        }))
        # Events go on every row of their frame, as in the other releases.
        ev = pd.Series(events, index=np.arange(1, n_total + 1))
        for f in frames[-(p.nfl_id.nunique() + 1):]:
            f["event"] = ev.reindex(f.frameId.to_numpy()).to_numpy()

    tracking = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    pp = pd.DataFrame(pp_rows)
    pp_by_play = {k: v for k, v in pp.groupby(["gameId", "playId"])} if len(pp) else {}
    return Chunk(name, games, plays, pp_by_play, roster, tracking)
