// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Mini App's few styles, in Telegram's own theme variables (with system
 * colours where Telegram sets none). One copy, for every screen of the page.
 */
import type React from 'react';

export const PAGE: React.CSSProperties = {
  minHeight: '100vh', boxSizing: 'border-box', padding: '20px 16px',
  background: 'var(--tg-theme-bg-color, Canvas)', color: 'var(--tg-theme-text-color, CanvasText)',
  fontFamily: 'system-ui, sans-serif', fontSize: 15, lineHeight: 1.5,
};
export const PRIMARY: React.CSSProperties = {
  width: '100%', height: 48, border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700,
  background: 'var(--tg-theme-button-color, Highlight)', color: 'var(--tg-theme-button-text-color, HighlightText)',
  cursor: 'pointer', marginTop: 10,
};
export const SECONDARY: React.CSSProperties = {
  ...PRIMARY, background: 'var(--tg-theme-secondary-bg-color, ButtonFace)', color: 'var(--tg-theme-text-color, ButtonText)',
};
export const HINT: React.CSSProperties = { color: 'var(--tg-theme-hint-color, GrayText)', fontSize: 13 };
