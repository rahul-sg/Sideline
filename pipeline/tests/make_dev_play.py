"""A synthetic 22-man pass play in Big Data Bowl format, used only to develop visuals
before real tracking data is downloaded. Not real NFL data."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
G, P, FPS = 1999010100, 1, 10
LOS, BY = 45.0, 26.65
N = 80  # frames
SNAP = 21  # frameId of snap
THROW, ARRIVE = SNAP + 26, SNAP + 34

def path(wps, n=N):
    """Waypoints [(frame, x, y)] -> per-frame x,y (linear), held before/after."""
    f = np.arange(1, n + 1)
    fr, xs, ys = zip(*wps)
    return np.interp(f, fr, xs), np.interp(f, fr, ys)

S = SNAP
players = []
def add(nid, name, pos, team, num, wps, h="6-2", w=210):
    x, y = path(wps); players.append((nid, name, pos, team, num, x, y, h, w))

# Offense (MIA) moving +x
add(1, "Test Quarterback", "QB", "MIA", 1, [(S, LOS-5, BY), (S+12, LOS-7.5, BY), (S+26, LOS-7.2, BY+0.3), (N, LOS-7.0, BY+0.3)], "6-1", 217)
for k, dy in enumerate([-2.6, -1.3, 0, 1.3, 2.6]):
    add(2+k, f"Test Lineman {k+1}", ["T","G","C","G","T"][k], "MIA", 70+k, [(S, LOS-0.8, BY+dy), (S+15, LOS-2.2, BY+dy*1.15), (N, LOS-2.5, BY+dy*1.15)], "6-5", 315)
add(7, "Test Running Back", "RB", "MIA", 23, [(S, LOS-5, BY+1.5), (S+10, LOS-4, BY+2.5), (S+22, LOS+1, BY+9), (N, LOS+3, BY+12)], "5-10", 205)
add(8, "Test Wideout X", "WR", "MIA", 10, [(S, LOS-0.5, 46), (S+40, LOS+33, 44), (N, LOS+40, 43)], "5-10", 191)
add(9, "Test Wideout Z", "WR", "MIA", 17, [(S, LOS-0.5, 8), (S+18, LOS+12, 8.5), (S+34, LOS+13, 22), (N, LOS+13.5, 30)], "6-0", 185)
add(10, "Test Slot", "WR", "MIA", 11, [(S, LOS-0.8, 36), (S+8, LOS+4, 36), (S+ARRIVE-SNAP, LOS+9, 29.5), (S+46, LOS+16, 26), (S+52, LOS+18, 25)], "6-0", 200)
add(11, "Test Tight End", "TE", "MIA", 82, [(S, LOS-0.8, 22.5), (S+15, LOS+9, 21.5), (S+30, LOS+20, 22), (N, LOS+25, 22)], "6-5", 250)
# Defense (BAL)
for k, y0 in enumerate([22, 25.3, 28, 31.3]):
    add(20+k, f"Test Rusher {k+1}", ["DE","DT","DT","DE"][k], "BAL", 90+k, [(S, LOS+0.9, y0), (S+18, LOS-4.5, BY + (y0-BY)*0.4), (N, LOS-5.5, BY + (y0-BY)*0.3)], "6-4", 285)
for k, y0 in enumerate([19.5, 26.6, 33.5]):
    add(24+k, f"Test Linebacker {k+1}", "ILB" if k == 1 else "OLB", "BAL", 50+k, [(S, LOS+5, y0), (S+20, LOS+9, y0 + (2 if k == 0 else -1)), (S+ARRIVE-SNAP+6, LOS+16, 25.5), (N, LOS+18, 25)], "6-2", 235)
add(27, "Test Corner Left", "CB", "BAL", 24, [(S, LOS+6, 45), (S+15, LOS+12, 45), (S+40, LOS+31, 43.5), (N, LOS+38, 43)], "6-0", 190)
add(28, "Test Corner Right", "CB", "BAL", 21, [(S, LOS+6, 9), (S+18, LOS+11, 10), (S+34, LOS+14, 20), (N, LOS+15, 27)], "5-11", 188)
add(29, "Test Nickel", "CB", "BAL", 26, [(S, LOS+5, 37), (S+12, LOS+7, 35), (S+ARRIVE-SNAP, LOS+10.5, 31.5), (S+50, LOS+18, 25.5), (N, LOS+18.5, 25.3)], "5-10", 190)
add(30, "Test Safety 1", "FS", "BAL", 32, [(S, LOS+13, 18), (S+25, LOS+16, 20), (S+48, LOS+18.5, 24), (N, LOS+19, 24.5)], "6-1", 205)
add(31, "Test Safety 2", "SS", "BAL", 14, [(S, LOS+13, 35), (S+25, LOS+18, 37), (N, LOS+24, 36)], "6-0", 200)

ball_x, ball_y = path([(S, LOS, BY), (S+2, LOS-5, BY), (S+12, LOS-7.5, BY), (THROW, LOS-7.0, BY+0.3), (ARRIVE, LOS+9, 29.5), (S+46, LOS+16, 26), (S+52, LOS+18, 25)])
games = pd.DataFrame([{"gameId": G, "season": 1999, "week": 1, "gameDate": "01/01/1999", "gameTimeEastern": "13:00:00", "homeTeamAbbr": "BAL", "visitorTeamAbbr": "MIA", "homeFinalScore": 0, "visitorFinalScore": 0}])
plays = pd.DataFrame([{"gameId": G, "playId": P, "playDescription": "SYNTHETIC TEST PLAY for visual development. Not real NFL data.", "quarter": 2, "down": 3, "yardsToGo": 6, "possessionTeam": "MIA", "defensiveTeam": "BAL", "gameClock": "08:41", "preSnapHomeScore": 10, "preSnapVisitorScore": 7, "passResult": "C", "yardsGained": 18, "expectedPointsAdded": 2.1, "preSnapHomeTeamWinProbability": 0.62, "homeTeamWinProbabilityAdded": -0.06, "offenseFormation": "SHOTGUN", "pff_passCoverage": "Cover-3", "pff_manZone": "Zone", "playAction": False, "dropbackType": "TRADITIONAL", "timeToThrow": 2.6, "isDropback": True, "playNullifiedByPenalty": "N", "qbSpike": False}])
pl = pd.DataFrame([{"nflId": p[0], "height": p[7], "weight": p[8], "position": p[2], "displayName": p[1]} for p in players])
routes = {7: "FLAT", 8: "GO", 9: "IN", 10: "SLANT", 11: "POST"}
pp = pd.DataFrame([{"gameId": G, "playId": P, "nflId": p[0], "wasRunningRoute": 1 if p[0] in routes else None, "routeRan": routes.get(p[0]), "wasTargettedReceiver": int(p[0] == 10), "pff_defensiveCoverageAssignment": None, "hadRushAttempt": 0, "hadPassReception": int(p[0] == 10), "hadInterception": 0} for p in players])
rows = []
ev = {SNAP: "ball_snap", THROW: "pass_forward", ARRIVE: "pass_arrived", ARRIVE + 1: "pass_outcome_caught", S + 52: "tackle"}
for nid, name, pos, team, num, x, y, *_ in players:
    vx, vy = np.gradient(x) * FPS, np.gradient(y) * FPS
    s = np.hypot(vx, vy)
    d = (np.degrees(np.arctan2(vx, vy)) + 360) % 360
    face = np.where(s > 0.5, d, 90.0 if team == "MIA" else 270.0)
    if pos in ("CB", "FS", "SS"):  # DBs keep eyes on the QB while backpedaling early
        face = np.where((np.arange(N) < S + 12) & (vx > 0), 270.0, face)
    for f in range(N):
        rows.append({"gameId": G, "playId": P, "nflId": nid, "displayName": name, "frameId": f + 1, "frameType": "SNAP" if f + 1 == SNAP else ("BEFORE_SNAP" if f + 1 < SNAP else "AFTER_SNAP"), "time": "", "jerseyNumber": num, "club": team, "playDirection": "right", "x": x[f], "y": y[f], "s": s[f], "a": 0, "dis": 0, "o": face[f], "dir": d[f], "event": ev.get(f + 1)})
for f in range(N):
    rows.append({"gameId": G, "playId": P, "nflId": np.nan, "displayName": "football", "frameId": f + 1, "frameType": "SNAP" if f + 1 == SNAP else "AFTER_SNAP", "time": "", "jerseyNumber": np.nan, "club": "football", "playDirection": "right", "x": ball_x[f], "y": ball_y[f], "s": 0, "a": 0, "dis": 0, "o": np.nan, "dir": np.nan, "event": ev.get(f + 1)})
games.to_csv(out / "games.csv", index=False); plays.to_csv(out / "plays.csv", index=False); pl.to_csv(out / "players.csv", index=False); pp.to_csv(out / "player_play.csv", index=False)
pd.DataFrame(rows).to_csv(out / "tracking_week_1.csv", index=False)
print("dev play written")
