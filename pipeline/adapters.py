"""Adapters that turn each Big Data Bowl release into the 2025 column layout build.py expects.

Releases differ in what they track:
  - 2019 (NFL's public GitHub sample): every snap of one game, all 22 players and the
    ball, but no body orientation, play direction or route labels. Those are derived here.
  - 2025: full plays with orientation, routes and coverage. Removed from Kaggle by the host.
  - 2026: pass plays only. All players until the throw; afterwards only the targeted
    receiver and nearby defenders. No ball coordinates beyond where the pass landed.
"""
from __future__ import annotations

import re
import urllib.request
from pathlib import Path
from typing import Iterator

import numpy as np
import pandas as pd

from build import RAW, Chunk, chunks_bdb2025, clean, find_bdb2025

SAMPLE_URL = "https://raw.githubusercontent.com/nfl-football-ops/Big-Data-Bowl/master/Data"
SAMPLE_DIR = RAW / "bdb2019"
SAMPLE_FILES = ["games.csv", "players.csv", "plays.csv", "tracking_gameId_2017090700.csv"]
NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"


def _download(url: str, dest: Path) -> bool:
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, dest)
        return True
    except Exception as e:  # offline or moved
        print(f"  could not download {url}: {e}")
        return False


def nflverse_pbp(season: int) -> pd.DataFrame | None:
    """Play-by-play for EPA and win probability, joined on old_game_id / play_id."""
    f = RAW / f"play_by_play_{season}.csv.gz"
    if not f.exists() and not _download(f"{NFLVERSE}/pbp/play_by_play_{season}.csv.gz", f):
        return None
    cols = ["old_game_id", "play_id", "posteam", "home_team", "epa", "wpa", "home_wp"]
    return pd.read_csv(f, usecols=cols, low_memory=False)


def _facing(x: np.ndarray, y: np.ndarray, s: np.ndarray, default: float) -> np.ndarray:
    """Facing from direction of travel (tracking convention: 0 = +y, clockwise). Held while standing."""
    dx = np.gradient(x)
    dy = np.gradient(y)
    ang = (np.degrees(np.arctan2(dx, dy)) + 360) % 360
    ang = np.where(s >= 0.6, ang, np.nan)
    out = pd.Series(ang).ffill().to_numpy()
    out[np.isnan(out)] = default
    return out


def _height(h) -> str | None:
    m = re.match(r"(\d+)'(\d+)", str(h))
    return f"{int(m.group(1))}-{int(m.group(2))}" if m else None


def chunks_sample2017(root: Path = SAMPLE_DIR, download: bool = True) -> Iterator[Chunk]:
    SAMPLE = root
    for f in SAMPLE_FILES if download else []:
        if not (SAMPLE / f).exists() and not _download(f"{SAMPLE_URL}/{f}", SAMPLE / f):
            return
    games = pd.read_csv(SAMPLE / "games.csv")
    plays = pd.read_csv(SAMPLE / "plays.csv")
    people = pd.read_csv(SAMPLE / "players.csv")
    roster = {int(r.nflId): {"pos": r.PositionAbbr, "h": None, "w": clean(r.Weight)} for r in people.itertuples()}
    for r in people.itertuples():
        h = _height(r.Height)
        if h:
            ft, inch = h.split("-")
            roster[int(r.nflId)]["h"] = int(ft) * 12 + int(inch)
    initial_last = {f"{r.FirstName[0]}.{r.LastName}": int(r.nflId) for r in people.itertuples() if isinstance(r.FirstName, str)}

    for tf in sorted(SAMPLE.glob("tracking_gameId_*.csv")):
        t = pd.read_csv(tf)
        gid = int(t.gameId.iloc[0])
        g = games[games.gameId == gid].iloc[0]
        home, away = g.homeTeamAbbr, g.visitorTeamAbbr
        pbp = nflverse_pbp(int(g.season))
        pbp = pbp[pbp.old_game_id == gid].set_index("play_id") if pbp is not None else None

        gp = plays[(plays.gameId == gid) & (plays.isSTPlay == False)].copy()  # noqa: E712
        rows, pp_rows = [], []
        for r in gp.itertuples():
            nv = pbp.loc[r.playId] if pbp is not None and r.playId in pbp.index else None
            home_wpa = None
            if nv is not None and not pd.isna(nv.wpa):
                home_wpa = nv.wpa if nv.posteam == home else -nv.wpa
            defense = away if r.possessionTeam == home else home
            no_play = bool(r.isPenalty) and "No Play" in str(r.playDescription)
            rows.append({
                "gameId": gid, "playId": int(r.playId), "playDescription": r.playDescription, "quarter": r.quarter,
                "down": r.down or None, "yardsToGo": r.yardsToGo, "possessionTeam": r.possessionTeam,
                "defensiveTeam": defense, "gameClock": str(r.GameClock)[:5],
                "preSnapHomeScore": r.HomeScoreBeforePlay, "preSnapVisitorScore": r.VisitorScoreBeforePlay,
                "passResult": clean(r.PassResult), "yardsGained": r.PlayResult,
                "expectedPointsAdded": None if nv is None else clean(nv.epa),
                "preSnapHomeTeamWinProbability": None if nv is None else clean(nv.home_wp),
                "homeTeamWinProbabilityAdded": home_wpa, "offenseFormation": clean(r.offenseFormation),
                "pff_passCoverage": None, "pff_manZone": None, "playAction": None, "dropbackType": None,
                "timeToThrow": None, "isDropback": not pd.isna(r.PassResult),
                "playNullifiedByPenalty": "Y" if no_play else "N", "qbSpike": "spike" in str(r.playDescription).lower(),
            })
            # Targets come from the description ("pass short right to R.Burkhead").
            m = re.search(r"pass .*?(?:to|intended for) ([A-Z]\.[A-Za-z'\-]+)", str(r.playDescription))
            target = initial_last.get(m.group(1)) if m else None
            for pid in t.loc[t.playId == r.playId, "nflId"].dropna().unique():
                pos = roster.get(int(pid), {}).get("pos")
                running = not pd.isna(r.PassResult) and pos in ("WR", "TE", "RB", "FB")
                pp_rows.append({"gameId": gid, "playId": int(r.playId), "nflId": int(pid),
                                "wasRunningRoute": 1 if running else None, "routeRan": None,
                                "wasTargettedReceiver": int(target == int(pid)),
                                "pff_defensiveCoverageAssignment": None, "hadRushAttempt": 0,
                                "hadPassReception": 0, "hadInterception": 0})

        tr = t[t.playId.isin(gp.playId)].rename(columns={"frame.id": "frameId"}).copy()
        tr["club"] = tr.team.map({"home": home, "away": away, "ball": "football"})
        tr["frameType"] = None
        tr["o"] = np.nan
        tr["playDirection"] = "right"
        pos_by_play = {int(r.playId): r.possessionTeam for r in gp.itertuples()}
        for pid, idx in tr.groupby("playId").groups.items():
            p = tr.loc[idx]
            snap = p.loc[p.event == "ball_snap", "frameId"]
            if snap.empty:
                continue
            at = p[p.frameId == snap.min()]
            ball_x = at.loc[at.club == "football", "x"].mean()
            off_x = at.loc[at.club == pos_by_play[int(pid)], "x"].mean()
            direction = "right" if off_x < ball_x else "left"
            tr.loc[idx, "playDirection"] = direction
            for nid, pidx in p[p.nflId.notna()].groupby("nflId").groups.items():
                pl = tr.loc[pidx].sort_values("frameId")
                off = pl.club.iloc[0] == pos_by_play[int(pid)]
                toward = 90.0 if (direction == "right") == off else 270.0
                tr.loc[pl.index, "o"] = _facing(pl.x.to_numpy(), pl.y.to_numpy(), pl.s.to_numpy(), toward)

        games_df = pd.DataFrame([{
            "gameId": gid, "season": int(g.season), "week": int(g.week), "gameDate": g.gameDate,
            "gameTimeEastern": g.gameTimeEastern, "homeTeamAbbr": home, "visitorTeamAbbr": away,
            "homeFinalScore": g.HomeScore, "visitorFinalScore": g.VisitorScore,
        }]).set_index("gameId")
        plays_df = pd.DataFrame(rows).set_index(["gameId", "playId"]).sort_index()
        pp = pd.DataFrame(pp_rows)
        yield Chunk(tf.name, games_df, plays_df, {k: v for k, v in pp.groupby(["gameId", "playId"])}, roster, tr)


def source_for(path: Path, weeks: list[int] | None):
    """Pick the adapter for a zip or folder by the files it contains."""
    from build import Source
    from adapters_2026 import chunks_bdb2026

    src = Source(path)
    names = src.names()
    if any(re.fullmatch(r"input_\d{4}_w\d+\.csv", n) for n in names):
        return ("Big Data Bowl 2026", chunks_bdb2026(src, weeks))
    if any(re.fullmatch(r"tracking_week_\d+\.csv", n) for n in names):
        return ("Big Data Bowl", chunks_bdb2025(src, weeks))
    if any(n.startswith("tracking_gameId_") for n in names):
        return ("NFL Big Data Bowl sample", chunks_sample2017(path, download=False))
    raise SystemExit(f"Don't recognize the files in {path}")


def available_sources(weeks: list[int] | None):
    """Every tracking release found on disk (or downloadable), newest season first."""
    from adapters_2026 import find_bdb2026, chunks_bdb2026

    sources = []
    src26 = find_bdb2026()
    if src26:
        sources.append(("Big Data Bowl 2026 · 2023 season", chunks_bdb2026(src26, weeks)))
    src25 = find_bdb2025()
    if src25:
        sources.append(("Big Data Bowl 2025 · 2022 season", chunks_bdb2025(src25, weeks)))
    sources.append(("NFL Big Data Bowl sample game · 2017", chunks_sample2017()))
    return sources
