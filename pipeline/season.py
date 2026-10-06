"""Build the "This Week" dataset from nflverse play-by-play for the current season.

nflverse publishes play-by-play nightly during the season. It has no player
tracking, so this feeds scoreboards, win-probability charts, drive charts and
key plays rather than 3D replays.

    python3 pipeline/season.py            # downloads the latest file, then builds
    python3 pipeline/season.py --offline  # uses pipeline/raw as-is
"""
from __future__ import annotations

import argparse
import datetime as dt
import urllib.request

import pandas as pd

from common import NFLVERSE, OUT, RAW, clean, team_colors, write_json

SEASON = 2026
KEY_PLAYS = 6


def download(season: int) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    targets = {
        f"play_by_play_{season}.csv.gz": f"{NFLVERSE}/pbp/play_by_play_{season}.csv.gz",
        "games.csv": f"{NFLVERSE}/schedules/games.csv",
        "teams_colors_logos.csv": f"{NFLVERSE}/teams/teams_colors_logos.csv",
    }
    for name, url in targets.items():
        print(f"  downloading {name}")
        urllib.request.urlretrieve(url, RAW / name)


def play_label(r) -> str:
    """Short label for a play type, used as a tag in the UI."""
    if r.touchdown == 1:
        return "TD"
    if r.interception == 1:
        return "INT"
    if r.fumble_lost == 1:
        return "FUMBLE"
    if r.sack == 1:
        return "SACK"
    if r.play_type == "field_goal":
        return "FG"
    if r.play_type == "punt":
        return "PUNT"
    if r.play_type in ("pass", "run"):
        return r.play_type.upper()
    return str(r.play_type or "").upper()


def build_game(g: pd.DataFrame, sched: pd.Series) -> dict:
    g = g.sort_values(["game_seconds_remaining", "play_id"], ascending=[False, True])
    plays = g[g.play_type.notna() & (g.play_type != "no_play")]

    # Win-probability series: (seconds elapsed, home WP after the play).
    wp = []
    for r in plays.itertuples():
        if pd.isna(r.home_wp_post) or pd.isna(r.game_seconds_remaining):
            continue
        elapsed = 3600 - r.game_seconds_remaining if r.qtr <= 4 else 3600 + (600 - r.game_seconds_remaining)
        wp.append([round(float(elapsed)), round(float(r.home_wp_post), 4)])
    if not pd.isna(sched.result):
        wp.append([wp[-1][0] if wp else 3600, 1.0 if sched.result > 0 else 0.0 if sched.result < 0 else 0.5])

    scrimmage = plays[plays.play_type.isin(["pass", "run", "field_goal", "punt", "qb_kneel", "qb_spike"]) & plays.wpa.notna()]
    top = scrimmage.reindex(scrimmage.wpa.abs().sort_values(ascending=False).index).head(KEY_PLAYS)
    key = []
    for r in top.sort_values("game_seconds_remaining", ascending=False).itertuples():
        home_delta = r.wpa if r.posteam == r.home_team else -r.wpa
        key.append({
            "playId": int(r.play_id),
            "qtr": int(r.qtr),
            "clock": r.time,
            "team": r.posteam,
            "down": clean(r.down),
            "ytg": clean(r.ydstogo),
            "yardline100": clean(r.yardline_100),
            "yards": clean(r.yards_gained),
            "tag": play_label(r),
            "desc": r.desc,
            "homeWpa": round(float(home_delta), 4),
            "homeWpAfter": round(float(r.home_wp_post), 4) if not pd.isna(r.home_wp_post) else None,
            "epa": round(float(r.epa), 2) if not pd.isna(r.epa) else None,
        })

    # Drive extents from scrimmage snaps only; kickoffs and tries use other field references.
    snaps = plays[plays.play_type.isin(["pass", "run", "qb_kneel", "qb_spike", "field_goal", "punt"])
                  & plays.fixed_drive.notna() & plays.posteam.notna() & plays.yardline_100.notna()]
    drives = []
    for _, d in snaps.groupby("fixed_drive", sort=True):
        first, last = d.iloc[0], d.iloc[-1]
        result = clean(first.fixed_drive_result)
        if result == "Touchdown":
            end = 0.0
        else:
            gained = 0 if pd.isna(last.yards_gained) or last.play_type in ("punt", "field_goal") else last.yards_gained
            end = float(max(0, min(100, last.yardline_100 - gained)))
        drives.append({
            "team": first.posteam,
            "qtr": int(first.qtr),
            "start100": float(first.yardline_100),
            "end100": end,
            "plays": int(len(d)),
            "result": result,
        })

    return {
        "id": sched.game_id,
        "week": int(sched.week),
        "date": sched.gameday,
        "time": clean(sched.gametime),
        "home": sched.home_team,
        "away": sched.away_team,
        "homeScore": clean(sched.home_score),
        "awayScore": clean(sched.away_score),
        "final": not pd.isna(sched.result),
        "overtime": bool(sched.overtime == 1),
        "stadium": clean(sched.stadium),
        "roof": clean(sched.roof),
        "wp": wp,
        "keyPlays": key,
        "drives": drives,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--season", type=int, default=SEASON)
    args = ap.parse_args()

    if not args.offline:
        download(args.season)

    pbp = pd.read_csv(RAW / f"play_by_play_{args.season}.csv.gz", low_memory=False)
    sched = pd.read_csv(RAW / "games.csv")
    sched = sched[(sched.season == args.season) & (sched.game_type == "REG")]

    weeks = []
    for week, ws in sched.groupby("week"):
        games = []
        for s in ws.sort_values(["gameday", "gametime"]).itertuples(index=False):
            s = pd.Series(s._asdict())
            g = pbp[pbp.game_id == s.game_id]
            if g.empty:
                games.append({
                    "id": s.game_id, "week": int(s.week), "date": s.gameday, "time": clean(s.gametime),
                    "home": s.home_team, "away": s.away_team, "homeScore": None, "awayScore": None,
                    "final": False, "overtime": False, "stadium": clean(s.stadium), "roof": clean(s.roof),
                    "wp": [], "keyPlays": [], "drives": [],
                })
            else:
                games.append(build_game(g, s))
        weeks.append({"week": int(week), "games": games, "played": sum(g["final"] for g in games)})

    latest = max((w["week"] for w in weeks if w["played"]), default=1)
    payload = {
        "season": args.season,
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
        "latestWeek": latest,
        "weeks": weeks,
        "source": "nflverse play-by-play (nflfastR models)",
    }
    n = write_json(OUT / f"season{args.season}.json", payload)
    write_json(OUT / "teams.json", team_colors())
    print(f"season{args.season}.json: {len(weeks)} weeks, latest played week {latest}, {n/1e6:.2f} MB")


if __name__ == "__main__":
    main()
