"""Tiny synthetic dataset in Big Data Bowl 2026 layout, for pipeline tests only."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

out = Path(sys.argv[1]); (out / "train").mkdir(parents=True, exist_ok=True)
G, P, N_IN, N_OUT = 2023091000, 55, 25, 8
roles = [("Passer", "QB", "Offense")] + [("Other Route Runner", "WR", "Offense")] * 2 + [("Targeted Receiver", "WR", "Offense")] \
    + [("Other", "T", "Offense")] * 7 + [("Defensive Coverage", "CB", "Defense")] * 11
rows = []
for k, (role, pos, side) in enumerate(roles):
    nid = 100 + k
    off = side == "Offense"
    for f in range(1, N_IN + 1):
        t = (f - 1) / 10
        moving = role in ("Targeted Receiver", "Other Route Runner")
        x = 80 + (1 if off else -6) - (t * 7 if moving else 0)   # play_direction left
        rows.append({"game_id": G, "play_id": P, "player_to_predict": role == "Targeted Receiver" or k in (11, 12),
                     "nfl_id": nid, "frame_id": f, "play_direction": "left", "absolute_yardline_number": 80,
                     "player_name": f"Player {k}", "player_height": "6-1", "player_weight": 205,
                     "player_birth_date": "1999-01-01", "player_position": pos, "player_side": side, "player_role": role,
                     "x": x, "y": 10 + k * 1.5, "s": 7.0 if moving else 0.0, "a": 0, "o": 270.0, "dir": 270.0,
                     "num_frames_output": N_OUT, "ball_land_x": 55.0, "ball_land_y": 15.0})
inp = pd.DataFrame(rows)
outp = []
for nid in (103, 111, 112):
    last = inp[(inp.nfl_id == nid)].iloc[-1]
    for f in range(1, N_OUT + 1):
        outp.append({"game_id": G, "play_id": P, "nfl_id": nid, "frame_id": f, "x": last.x - f * 0.8, "y": last.y})
supp = pd.DataFrame([{
    "game_id": G, "season": 2023, "week": 1, "game_date": "09/10/2023", "game_time_eastern": "13:00:00",
    "home_team_abbr": "BAL", "visitor_team_abbr": "HOU", "home_final_score": 25, "visitor_final_score": 9,
    "play_id": P, "play_description": "TEST pass", "quarter": 1, "game_clock": "10:00", "down": 2, "yards_to_go": 7,
    "possession_team": "BAL", "defensive_team": "HOU", "yardline_side": "BAL", "yardline_number": 40,
    "pre_snap_home_score": 0, "pre_snap_visitor_score": 0, "pass_result": "C", "play_nullified_by_penalty": "N",
    "pass_length": 20, "offense_formation": "SHOTGUN", "receiver_alignment": "2x2", "route_of_targeted_receiver": "POST",
    "play_action": False, "dropback_type": "TRADITIONAL", "dropback_distance": 5, "pass_location_type": "INSIDE_BOX",
    "defenders_in_the_box": 6, "team_coverage_man_zone": "ZONE_COVERAGE", "team_coverage_type": "COVER_3_ZONE",
    "penalty_yards": 0, "pre_penalty_yards_gained": 25, "yards_gained": 25, "expected_points": 1.5,
    "expected_points_added": 1.9, "pre_snap_home_team_win_probability": 0.6, "pre_snap_visitor_team_win_probability": 0.4,
    "home_team_win_probability_added": 0.04, "visitor_team_win_probility_added": -0.04,
}])
inp.to_csv(out / "train" / "input_2023_w01.csv", index=False)
pd.DataFrame(outp).to_csv(out / "train" / "output_2023_w01.csv", index=False)
supp.to_csv(out / "supplementary_data.csv", index=False)
print("2026 fixture written")
