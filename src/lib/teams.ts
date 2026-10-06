import { create } from 'zustand';
import { loadIndex, loadTeams, setPreviewData } from './data';
import type { Team, Teams, TrackingIndex } from './types';

interface DataState {
  teams: Teams;
  index: TrackingIndex | null;
  ready: boolean;
  preview: boolean;
  init: () => Promise<void>;
  startPreview: () => Promise<void>;
}

export const useData = create<DataState>((set, get) => ({
  teams: {},
  index: null,
  ready: false,
  preview: false,
  init: async () => {
    if (get().ready) return;
    const [teams, index] = await Promise.all([loadTeams(), loadIndex()]);
    set({ teams: { ...(index?.teams ?? {}), ...(teams ?? {}) }, index, ready: true });
  },
  startPreview: async () => {
    setPreviewData(true);
    const index = await loadIndex();
    if (index) set({ index, preview: true });
    else setPreviewData(false);
  },
}));

const FALLBACK: Team = { name: 'Team', nick: 'Team', primary: '#4b5563', secondary: '#d1d5db', tertiary: null };

export function team(abbr: string | undefined | null): Team {
  if (!abbr) return FALLBACK;
  return useData.getState().teams[abbr] ?? { ...FALLBACK, name: abbr, nick: abbr };
}

function luminance(hex: string): number {
  const m = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Text color that reads on a team-colored background. */
export const inkOn = (bg: string) => (contrast(bg, '#ffffff') >= 3 ? '#ffffff' : '#0b0f17');

/** A team color that stays readable on the dark interface (primary, else secondary, else light grey). */
export function visibleColor(abbr: string, on = '#0b101a') {
  const t = team(abbr);
  if (contrast(t.primary, on) >= 2.2) return t.primary;
  if (contrast(t.secondary, on) >= 2.2) return t.secondary;
  return '#cbd5e1';
}

export interface Uniform {
  jersey: string;
  trim: string;
  number: string;
  helmet: string;
  pants: string;
}

const WHITE = '#f4f4f0';
const SILVER = '#c4c8cd';
const GOLD = '#c9a95c';

/** Teams that usually pair their home jersey with colored pants; everyone else wears white. */
const HOME_PANTS: Record<string, string> = {
  NO: GOLD, SF: GOLD, PIT: '#e8b42a', GB: '#e8b42a', WAS: '#e8b42a', LA: '#e8c66a',
  NE: SILVER, DAL: SILVER, LV: SILVER, SEA: SILVER, DET: SILVER, CHI: '#1b2944',
};

/** Home team in its color jersey, road team in white, as on most NFL Sundays. */
export function uniformColors(home: string, away: string): Record<string, Uniform> {
  const h = team(home);
  const a = team(away);
  const awayInk = contrast(a.primary, WHITE) > 1.6 ? a.primary : a.secondary;
  return {
    [home]: {
      jersey: h.primary,
      trim: h.secondary,
      number: inkOn(h.primary) === '#ffffff' ? '#ffffff' : h.secondary,
      helmet: h.primary,
      pants: HOME_PANTS[home] ?? WHITE,
    },
    [away]: { jersey: WHITE, trim: a.primary, number: awayInk, helmet: a.primary, pants: WHITE },
  };
}
