// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ThemeContext.tsx — light/dark theme for the redesigned user panel.
 *
 * The 2026 "Bazaar" redesign introduces a light theme alongside the original
 * dark one. The active theme is stored as `data-theme` on <html> so the CSS
 * variable blocks in redesign/theme.css resolve correctly, and mirrored to the
 * legacy Tailwind `dark` class (darkMode:'class') so any remaining `dark:`
 * variants stay in sync. Preference persists in localStorage.
 */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export type ThemeMode = 'dark' | 'light';

interface ThemeContextValue {
  theme: ThemeMode;
  toggleTheme: () => void;
  setTheme: (t: ThemeMode) => void;
}

const STORAGE_KEY = 'bb_theme';
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const readInitialTheme = (): ThemeMode => {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* ignore */ }
  return 'dark'; // brand default is the dark bazaar theme
};

const applyTheme = (t: ThemeMode) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', t);
  // Keep Tailwind's class-based dark mode in sync for legacy `dark:` utilities.
  root.classList.toggle('dark', t === 'dark');
  // Match the mobile browser chrome to the active surface.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0A0E17' : '#F1EEE5');
};

export const ThemeProvider: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(readInitialTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState(prev => {
      const next: ThemeMode = prev === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
};
