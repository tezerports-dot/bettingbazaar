// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Command Center appearance store — theme (dark/light), sidebar collapse and
// density. Persisted to localStorage and reflected onto <html data-theme> so
// the CSS-variable design system in globals.css switches instantly.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'dark' | 'light';
export type Density = 'comfortable' | 'compact';

interface ThemeState {
  theme: ThemeMode;
  collapsed: boolean;
  density: Density;
  toggleTheme: () => void;
  setTheme: (t: ThemeMode) => void;
  toggleCollapsed: () => void;
  setDensity: (d: Density) => void;
}

/** Reflect the current theme/density onto the document root so CSS vars flip. */
export function applyAppearance(theme: ThemeMode, density: Density = 'comfortable') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-density', density);
  root.style.colorScheme = theme;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      collapsed: false,
      density: 'comfortable',

      toggleTheme: () => {
        const theme: ThemeMode = get().theme === 'dark' ? 'light' : 'dark';
        applyAppearance(theme, get().density);
        set({ theme });
      },
      setTheme: (theme) => {
        applyAppearance(theme, get().density);
        set({ theme });
      },
      toggleCollapsed: () => set({ collapsed: !get().collapsed }),
      setDensity: (density) => {
        applyAppearance(get().theme, density);
        set({ density });
      },
    }),
    {
      name: 'admin-appearance',
      onRehydrateStorage: () => (state) => {
        // Apply persisted theme as soon as the store hydrates on boot.
        applyAppearance(state?.theme ?? 'dark', state?.density ?? 'comfortable');
      },
    }
  )
);
