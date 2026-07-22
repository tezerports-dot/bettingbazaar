// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** Shared display formatters for the redesigned user panel. Presentation only. */

/** Indian-grouping integer formatter (₹ amounts, token counts). */
export const fmt = (n: number | undefined | null): string =>
  (n || 0).toLocaleString('en-IN');

/** Seconds → mm:ss or h:mm:ss countdown string. */
export const timeStr = (sl: number): string => {
  if (sl <= 0) return '00:00';
  const h = Math.floor(sl / 3600);
  const m = Math.floor((sl % 3600) / 60);
  const s = sl % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
};

/** Short relative time from a ms timestamp (e.g. "2m ago", "3h ago", "5d ago"). */
export const ago = (tsMs: number): string => {
  if (!tsMs) return '';
  const diff = Math.max(0, Date.now() - tsMs);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};
