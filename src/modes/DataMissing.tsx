import { useStore } from '../lib/store';
import { useData } from '../lib/teams';

export function DataMissing() {
  const setMode = useStore((s) => s.setMode);
  const startPreview = useData((s) => s.startPreview);
  return (
    <div className="card-center" role="dialog" aria-labelledby="missing-title">
      <p className="label">Tracking data not built yet</p>
      <h2 id="missing-title">Load the real plays</h2>
      <p>
        Run <code>npm run data</code>. It downloads a full real game the NFL published (Chiefs at Patriots, 2017) and adds the Big Data Bowl 2026
        release (every 2023 pass play) if you’ve downloaded it.
      </p>
      <ol>
        <li>
          For 2023: join{' '}
          <a href="https://www.kaggle.com/competitions/nfl-big-data-bowl-2026-analytics/data" target="_blank" rel="noreferrer">
            the Big Data Bowl 2026 hackathon
          </a>{' '}
          on Kaggle and click <strong>Download All</strong>.
        </li>
        <li>
          Leave the zip in your Downloads folder.
        </li>
        <li>
          Run <code>npm run data</code>, then refresh.
        </li>
      </ol>
      <div className="film-actions">
        <button className="btn btn--primary" onClick={() => setMode('week')}>
          See this week’s games
        </button>
        <button className="btn" onClick={() => void startPreview()}>
          Preview the 3D engine with a made-up play
        </button>
      </div>
    </div>
  );
}
