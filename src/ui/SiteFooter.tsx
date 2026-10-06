import { useStore, type Mode } from '../lib/store';
import { BrandMark } from './icons';

const LINKS: { mode: Mode; label: string }[] = [
  { mode: 'theater', label: 'Replay' },
  { mode: 'qb', label: 'QB Read' },
  { mode: 'draw', label: 'Route Finder' },
  { mode: 'week', label: 'This Week' },
  { mode: 'about', label: 'About the data' },
];

export function SiteFooter() {
  const setMode = useStore((s) => s.setMode);
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <div className="brand">
            <BrandMark />
            Sideline
          </div>
          <p>Real NFL plays, rebuilt in 3D from player-tracking data.</p>
        </div>
        <nav className="site-footer__links" aria-label="Pages">
          {LINKS.map((l) => (
            <button key={l.mode} onClick={() => setMode(l.mode)}>
              {l.label}
            </button>
          ))}
        </nav>
      </div>
      <p className="site-footer__legal">
        An independent project, not affiliated with or endorsed by the NFL, its teams or players. Tracking data: NFL Big Data Bowl (2023
        season, CC BY-NC 4.0) and the NFL’s public 2017 sample game. Play-by-play, rosters and schedules: nflverse.
      </p>
    </footer>
  );
}
