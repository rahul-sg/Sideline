import { useCallback, useEffect } from 'react';
import { loadPlay } from '../lib/data';
import { useStore } from '../lib/store';
import { useData } from '../lib/teams';
import { PlayBrowser } from '../ui/PlayBrowser';
import { PlayInspector } from '../ui/PlayInspector';
import { ScoreBug } from '../ui/ScoreBug';
import { CameraSwitch, Transport } from '../ui/Transport';
import { DataMissing } from './DataMissing';

export function useOpenPlay() {
  return useCallback(async (gameId: number, playId: number, opts: { selectNflId?: number; autoplay?: boolean } = {}) => {
    const st = useStore.getState();
    st.setPlaying(false);
    st.setLoadingPlay(true);
    const play = await loadPlay(gameId, playId);
    if (!play) {
      st.setLoadingPlay(false);
      return null;
    }
    const sel = opts.selectNflId != null ? play.players.findIndex((p) => p.id === opts.selectNflId) : -1;
    st.setPlay(play, { selected: sel >= 0 ? sel : null, autoplay: opts.autoplay ?? true });
    return play;
  }, []);
}

export function Theater() {
  const index = useData((s) => s.index);
  const ready = useData((s) => s.ready);
  const play = useStore((s) => s.play);
  const loading = useStore((s) => s.loadingPlay);
  const open = useOpenPlay();

  // Start on the first featured play (unless a linked play is on its way; if that link
  // turns out to be dead, this runs again once it gives up).
  useEffect(() => {
    if (!play && !loading && index?.featured.length) {
      const f = index.featured[0];
      void open(f.gameId, f.playId, { autoplay: false });
    }
  }, [index, play, loading, open]);

  // Leaving QB Read can leave its camera behind.
  useEffect(() => {
    const st = useStore.getState();
    if (st.camera === 'qb') st.setCamera('broadcast');
  }, []);

  if (ready && !index)
    return (
      <div className="view-overlay">
        <DataMissing />
      </div>
    );
  const featured = index?.featured.find((f) => f.id === play?.id) ?? null;

  return (
    <>
      <PlayBrowser onOpen={(g, p) => open(g, p)} />
      <div className="view-overlay">
        {loading && <div className="toast">Loading play…</div>}
        {play && <ScoreBug play={play} />}
        {play && <CameraSwitch />}
      </div>
      {play && (
        <div className="area-bar">
          <Transport play={play} />
        </div>
      )}
      {play && <PlayInspector play={play} featured={featured} />}
    </>
  );
}
