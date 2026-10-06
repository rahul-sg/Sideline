"""Write a tiny synthetic dataset in Big Data Bowl 2025 format, for pipeline tests only."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
G, P = 2022091800, 100
pd.DataFrame([{"gameId": G, "season": 2022, "week": 2, "gameDate": "09/18/2022", "gameTimeEastern": "13:00:00",
               "homeTeamAbbr": "BAL", "visitorTeamAbbr": "MIA", "homeFinalScore": 38, "visitorFinalScore": 42}]).to_csv(out / "games.csv", index=False)
pd.DataFrame([{"gameId": G, "playId": P, "playDescription": "TEST pass", "quarter": 1, "down": 3, "yardsToGo": 7,
               "possessionTeam": "MIA", "defensiveTeam": "BAL", "gameClock": "10:00", "preSnapHomeScore": 0,
               "preSnapVisitorScore": 0, "passResult": "C", "yardsGained": 12, "expectedPointsAdded": 1.2,
               "preSnapHomeTeamWinProbability": 0.6, "homeTeamWinProbabilityAdded": -0.03, "offenseFormation": "SHOTGUN",
               "pff_passCoverage": "Cover-3", "pff_manZone": "Zone", "playAction": False, "dropbackType": "TRADITIONAL",
               "timeToThrow": 2.5, "isDropback": True, "playNullifiedByPenalty": "N", "qbSpike": False}]).to_csv(out / "plays.csv", index=False)
ids = list(range(1, 23))
pd.DataFrame([{"nflId": i, "height": "6-2", "weight": 210, "position": ("QB" if i == 1 else "WR" if i <= 4 else "T" if i <= 11 else "CB"),
               "displayName": f"Player {i}"} for i in ids]).to_csv(out / "players.csv", index=False)
pd.DataFrame([{"gameId": G, "playId": P, "nflId": i, "wasRunningRoute": 1 if 2 <= i <= 4 else None,
               "routeRan": {2: "GO", 3: "SLANT", 4: "OUT"}.get(i), "wasTargettedReceiver": 1 if i == 3 else 0,
               "pff_defensiveCoverageAssignment": "3R" if i > 11 else None, "hadRushAttempt": 0,
               "hadPassReception": 1 if i == 3 else 0, "hadInterception": 0} for i in ids]).to_csv(out / "player_play.csv", index=False)
rows = []
frames = range(1, 81)  # snap at 21, throw at 46, arrive at 56
for f in frames:
    t = max(0, f - 21) / 10
    ev = {21: "ball_snap", 46: "pass_forward", 56: "pass_arrived"}.get(f)
    for i in ids:
        off = i <= 11
        x0 = 120 - 40 + (1 if off else -6)  # playDirection left: offense moves toward -x
        y0 = 53.3 - (10 + i * 1.5)
        x = x0 - (t * 6 if i in (2, 3, 4) else 0)
        rows.append({"gameId": G, "playId": P, "nflId": i, "displayName": f"Player {i}", "frameId": f,
                     "frameType": "SNAP" if f == 21 else ("BEFORE_SNAP" if f < 21 else "AFTER_SNAP"),
                     "time": "", "jerseyNumber": i, "club": "MIA" if off else "BAL", "playDirection": "left",
                     "x": x, "y": y0, "s": 6.0 if t > 0 and i in (2, 3, 4) else 0, "a": 0, "dis": 0,
                     "o": 270.0, "dir": 270.0, "event": ev})
    rows.append({"gameId": G, "playId": P, "nflId": np.nan, "displayName": "football", "frameId": f,
                 "frameType": "SNAP" if f == 21 else "AFTER_SNAP", "time": "", "jerseyNumber": np.nan, "club": "football",
                 "playDirection": "left", "x": 81.0, "y": 26.0, "s": 0, "a": 0, "dis": 0, "o": np.nan, "dir": np.nan, "event": ev})
pd.DataFrame(rows).to_csv(out / "tracking_week_2.csv", index=False)
print("fixture written to", out)
