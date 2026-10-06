const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const PlayIcon = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
  </svg>
);
export const PauseIcon = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);
export const RestartIcon = () => (
  <svg {...base}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);
export const StepBackIcon = () => (
  <svg {...base}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
export const StepFwdIcon = () => (
  <svg {...base}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const RouteIcon = () => (
  <svg {...base}>
    <path d="M5 20V12l7-6 7 3" />
    <circle cx="5" cy="20" r="1.5" />
  </svg>
);
export const PanelsIcon = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M8 4v16M16 4v16" />
  </svg>
);
export const LinkIcon = () => (
  <svg {...base} width={14} height={14}>
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1" />
  </svg>
);
export const ExternalIcon = () => (
  <svg {...base} width={14} height={14}>
    <path d="M14 4h6v6" />
    <path d="M20 4 10 14" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

/** Wordmark glyph: line of scrimmage and line to gain on a field tile. */
export function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 24 24" aria-hidden>
      <rect x="0.5" y="0.5" width="23" height="23" rx="3" fill="#0f1620" stroke="#2a3444" />
      <rect x="7" y="4" width="2.5" height="16" rx="0.5" fill="#2f8cff" />
      <rect x="14.5" y="4" width="2.5" height="16" rx="0.5" fill="#ffd400" />
    </svg>
  );
}
