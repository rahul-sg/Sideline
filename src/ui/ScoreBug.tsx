import { useEffect, useRef } from 'react';
import { clockAt, downText, yardLineLabel } from '../lib/playMath';
import { useStore } from '../lib/store';
import { inkOn, team } from '../lib/teams';
import type { Play } from '../lib/types';

const QUARTER = ['', '1st', '2nd', '3rd', '4th', 'OT', '2OT'];

function TeamCell({ abbr, score, possession }: { abbr: string; score: number | null; possession: boolean }) {
  const t = team(abbr);
  return (
    <div className={`bug__team ${possession ? 'bug__team--poss' : ''}`} style={{ background: t.primary, color: inkOn(t.primary) }}>
      <span className="bug__abbr">{abbr}</span>
      <span className="bug__score">{score ?? '–'}</span>
    </div>
  );
}

export function ScoreBug({ play }: { play: Play }) {
  const clockRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      useStore.subscribe((s) => {
        if (clockRef.current && s.play === play) clockRef.current.textContent = clockAt(play, s.time);
      }),
    [play],
  );
  return (
    <div className="bug" role="group" aria-label="Game situation">
      <TeamCell abbr={play.away} score={play.awayScore} possession={play.offense === play.away} />
      <TeamCell abbr={play.home} score={play.homeScore} possession={play.offense === play.home} />
      <div className="bug__cell">{QUARTER[play.quarter] ?? `Q${play.quarter}`}</div>
      <div className="bug__cell" ref={clockRef}>
        {clockAt(play, useStore.getState().time)}
      </div>
      {play.down ? <div className="bug__cell bug__down">{downText(play.down, play.ytg, play.los)}</div> : null}
      <div className="bug__cell bug__spot">
        {yardLineLabel(play.los, play.offense, play.defense)}
      </div>
    </div>
  );
}
