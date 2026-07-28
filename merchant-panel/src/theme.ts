// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Theme controller. The palettes themselves live in src/index.css keyed by the
// [data-theme] attribute — this module only decides which one is active and
// remembers the operator's choice. Nothing here holds a colour value.
import { STORAGE_KEYS } from './constants';

export type ThemeName = 'light' | 'dark';

const DEFAULT_THEME: ThemeName = 'light'; // the theme the design was drawn in

function isTheme(value: unknown): value is ThemeName {
  return value === 'light' || value === 'dark';
}

export function readStoredTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    if (isTheme(stored)) return stored;
    // No explicit choice yet — follow the operating system.
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch {
    /* private mode / storage disabled — fall through to the default */
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  } catch {
    /* persistence is a convenience, never a requirement */
  }
}
