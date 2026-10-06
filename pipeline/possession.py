"""Who has the ball on every frame.

Raw ball tracking can't be trusted to stay in a player's hands: the 2017 release leaves
the ball at the line through the handoff, and the 2026 release has no ball at all
after the throw. Instead, possession is rebuilt from what the play record says
happened (snap, handoff, throw, catch, interception) and who did it (from the
play description and per-player flags). The renderer then puts the ball in the
carrier's hands, and only draws it free during the snap and a pass in flight.
"""
from __future__ import annotations

import re

import numpy as np

NAME = r"(?:\d+-)?([A-Z][a-z]{0,2}\.\s?[A-Z][A-Za-z'\-]+)"
RUSH_VERBS = r"(?:up the middle|left end|left tackle|left guard|right end|right tackle|right guard|scrambles|kneels|rushes|to the)"
SUFFIX = re.compile(r"\s+(jr|sr|ii|iii|iv|v)\.?$", re.I)


def _matches(token: str, full_name: str) -> bool:
    first, last = token.replace(" ", "").split(".", 1)
    parts = SUFFIX.sub("", full_name.strip()).split()
    if len(parts) < 2:
        return False
    return parts[-1].lower() == last.lower() and parts[0].lower().startswith(first.lower())


def find_player(token: str | None, people: list[dict], offense: bool | None = None) -> int | None:
    if not token:
        return None
    for i, p in enumerate(people):
        if (offense is None or p["off"] == offense) and _matches(token, p["name"]):
            return i
    return None


def _body(desc: str) -> str:
    """Description without the leading clock and formation notes."""
    return re.sub(r"^\s*(\([^)]*\)\s*)+", "", str(desc or ""))


def parse_roles(desc: str) -> dict:
    body = _body(desc)
    out: dict = {}
    m = re.search(NAME + r" (?:pass|sacked|spiked)", body)
    if m:
        out["passer"] = m.group(1)
    m = re.search(NAME + " " + RUSH_VERBS, body)
    if m:
        out["rusher"] = m.group(1)
    m = re.search(r"pass .*?(?:to|intended for) " + NAME, body)
    if m:
        out["receiver"] = m.group(1)
    m = re.search(r"INTERCEPTED by " + NAME, body)
    if m:
        out["interceptor"] = m.group(1)
    return out


def _nearest(people: list[dict], x: float, y: float, frame: int, pred) -> int | None:
    best, bi = 1e9, None
    for i, p in enumerate(people):
        if not pred(p):
            continue
        d = np.hypot(p["_x"][frame] - x, p["_y"][frame] - y)
        if d < best:
            best, bi = d, i
    return bi


def rebuild(people, events, snap, n, bx, by, pass_result, desc, throw, arrive):
    """Returns (carrier per frame, ball x, ball y). carrier is -1 while the ball is loose or in the air."""
    carrier = np.full(n, -1, dtype=int)
    bx, by = bx.copy(), by.copy()
    roles = parse_roles(desc)
    spot = (bx[snap], by[snap])  # ball on the ground at the snap

    qb = next((i for i, p in enumerate(people) if p["off"] and p["pos"] == "QB"), None)
    if roles.get("passer") or (roles.get("rusher") and qb is None):
        named = find_player(roles.get("passer") or roles.get("rusher"), people, offense=True)
        qb = named if named is not None else qb
    if qb is None:
        qb = _nearest(people, spot[0], spot[1], min(n - 1, snap + 5), lambda p: p["off"] and p["pos"] != "C")
    if qb is None:
        return carrier, bx, by

    # Snap: the ball leaves the center and reaches the QB's hands in ~0.3 s.
    exchange = min(n - 1, snap + 3)
    handoff = next((f for f, e in events if e == "handoff" and f >= snap), None)
    fumble = next((f for f, e in events if e.startswith("fumble") and f >= snap), None)
    end_qb = min(x for x in (throw, handoff, n) if x is not None)

    for f in range(snap, exchange):
        k = (f - snap) / max(1, exchange - snap)
        bx[f] = spot[0] + (people[qb]["_x"][f] - spot[0]) * k
        by[f] = spot[1] + (people[qb]["_y"][f] - spot[1]) * k
    carrier[exchange:end_qb] = qb

    if throw is not None:
        land = arrive if arrive is not None else min(n - 1, throw + 10)
        target = next((i for i, p in enumerate(people) if p["target"]), None)
        if target is None:
            target = find_player(roles.get("receiver"), people, offense=True)
        catch_x, catch_y = (people[target]["_x"][land], people[target]["_y"][land]) if target is not None else (bx[land], by[land])
        sx, sy = people[qb]["_x"][throw], people[qb]["_y"][throw]
        for f in range(throw, land + 1):
            k = (f - throw) / max(1, land - throw)
            bx[f] = sx + (catch_x - sx) * k
            by[f] = sy + (catch_y - sy) * k
        after = None
        if pass_result == "C":
            after = target
        elif pass_result == "IN":
            after = next((i for i, p in enumerate(people) if p["int"]), None)
            if after is None:
                after = find_player(roles.get("interceptor"), people, offense=False)
            if after is None:
                after = _nearest(people, catch_x, catch_y, land, lambda p: not p["off"])
        if after is not None:
            carrier[land + 1:] = after
        else:
            bx[land + 1:], by[land + 1:] = catch_x, catch_y  # incomplete: ball stays where it fell
    elif handoff is not None:
        rusher = next((i for i, p in enumerate(people) if p["rush"] and i != qb), None)
        if rusher is None:
            rusher = find_player(roles.get("rusher"), people, offense=True)
        if rusher is None or rusher == qb:
            look = min(n - 1, handoff + 2)
            rusher = _nearest(people, people[qb]["_x"][look], people[qb]["_y"][look], look,
                              lambda p: p["off"] and p["pos"] not in ("QB", "C", "G", "T"))
        if rusher is not None:
            carrier[handoff:] = rusher
    else:
        carrier[exchange:] = qb  # QB keeps it: scramble, sneak, sack, kneel

    # After a fumble, trust the tracked ball only when someone is right on it.
    if fumble is not None:
        for f in range(fumble, n):
            i = _nearest(people, bx[f], by[f], f, lambda p: True)
            carrier[f] = i if i is not None and np.hypot(people[i]["_x"][f] - bx[f], people[i]["_y"][f] - by[f]) < 1.2 else -1

    held = carrier >= 0
    for f in np.nonzero(held)[0]:
        bx[f], by[f] = people[carrier[f]]["_x"][f], people[carrier[f]]["_y"][f]
    return carrier, bx, by


def runs(carrier: np.ndarray) -> list[list[int]]:
    """Run-length encode: [[startFrame, playerIndex], ...]."""
    out: list[list[int]] = []
    for f, c in enumerate(carrier.tolist()):
        if not out or out[-1][1] != c:
            out.append([f, c])
    return out
