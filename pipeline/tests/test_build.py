"""Pipeline check on a tiny synthetic dataset: python3 pipeline/tests/test_build.py"""
import gzip
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    subprocess.run([sys.executable, HERE / "make_fixture.py", tmp / "src"], check=True, capture_output=True)
    subprocess.run([sys.executable, HERE.parent / "build.py", "--source", tmp / "src", "--out", tmp / "out"],
                   check=True, capture_output=True, cwd=HERE.parent)
    game = json.loads(gzip.decompress((tmp / "out/games/2022091800.json.gz").read_bytes()))
    play = game["plays"][0]
    # Fixture offense moves left; the pipeline must flip it to move toward +x.
    assert play["los"] == 39.0, play["los"]
    assert play["firstDown"] == 46.0
    assert (play["snap"], play["throw"], play["arrive"]) == (20, 45, 55)
    assert play["players"][0]["pos"] == "QB" and play["players"][0]["off"]
    assert play["o"][0][0] == 90, "orientation should be rotated 180° with the field"
    routes = json.loads((tmp / "out/routes.json").read_text())
    assert routes["routeTypes"] == ["GO", "SLANT", "OUT"]
    pts = np.frombuffer((tmp / "out/routes.bin").read_bytes(), "<i2").reshape(routes["count"], routes["points"], 2)
    assert pts[0][-1][0] == 240, "a 6 yd/s route should be 24 yards downfield after 4 s"
    index = json.loads((tmp / "out/index.json").read_text())
    assert index["qbPool"] == [[2022091800, 100]]
    # Possession: QB from just after the snap, nobody while the pass is in the air, receiver after.
    names = [play["players"][c]["pos"] if c >= 0 else None for _, c in play["carrier"]]
    starts = [f for f, _ in play["carrier"]]
    assert names == [None, "QB", None, "WR"], play["carrier"]
    assert starts[2] == play["throw"] and play["players"][play["carrier"][3][1]]["target"]
print("pipeline OK")

# Big Data Bowl 2026 layout: tracking stops for most players at the throw.
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    subprocess.run([sys.executable, HERE / "make_fixture_2026.py", tmp / "src"], check=True, capture_output=True)
    subprocess.run([sys.executable, HERE.parent / "build.py", "--source", tmp / "src", "--out", tmp / "out",
                    "--featured", HERE / "preview_featured.json"], check=True, capture_output=True, cwd=HERE.parent)
    play = json.loads(gzip.decompress((tmp / "out/games/2023091000.json.gz").read_bytes()))["plays"][0]
    assert play["los"] == 40.0, play["los"]
    assert (play["throw"], play["arrive"], play["n"]) == (24, 32, 33)
    target = next(p for p in play["players"] if p["target"])
    assert target["route"] == "POST" and not target["modelled"]
    assert any(p["modelled"] for p in play["players"]), "untracked players should be flagged"
    assert play["coverage"] == "COVER_3_ZONE"
print("2026 adapter OK")
