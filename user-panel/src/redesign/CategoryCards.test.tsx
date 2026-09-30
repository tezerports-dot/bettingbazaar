// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * A category card is only offered when its destination has something behind it.
 *
 * ── Two dead cards on the player's home screen ──────────────────────────────
 * The shell rendered four hardcoded category cards. `CrashPage` and
 * `SportsPage` each end with
 *
 *     useEffect(() => { if (!anyCrash) navigate('/', { replace: true }); }, …)
 *
 * which is correct — an empty category should not have a page. But the card row
 * never asked, so with no crash or sports provider configured a player tapped a
 * prominent card and was silently returned to the screen they were already on.
 * `replace: true`, so it does not even leave a back entry to notice.
 *
 * Measured in a browser at phone width, before the fix:
 *
 *     taps "CASH OR CRASH"      ->  hash #/ stays #/      (nothing happened)
 *     taps "SPORTS Bet anytime" ->  hash #/ stays #/      (nothing happened)
 *     taps "CASINO Play to win" ->  hash #/ -> #/casino   (works)
 *
 * and after, with the providers enabled, all three reach their own page.
 *
 * S22, in the shape CLAUDE.md records for the Profile rows: two halves of one
 * hole, each looking like the other half's job. Nothing throws, no request
 * fails, so no gate below a browser can see it.
 *
 * The fix reads the SAME owner the destination pages read, so the row and the
 * page cannot disagree about whether a category exists (§2, §5).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const providers = vi.hoisted(() => ({
  anyCasino: true, anyCrash: true, anySports: true,
  enabledCasino: [], enabledCrash: [], enabledSports: [],
  providers: { casino: [], crash: [], sports: [] }, loading: false, refresh: vi.fn(),
}));
vi.mock('../services/GameProviderContext', () => ({
  useGameProviders: () => providers,
  GameProviderProvider: ({ children }: any) => children,
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async () => ({
  ...(await vi.importActual<any>('react-router')),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/' }),
}));

vi.mock('../services/GameContext', () => ({
  useGame: () => ({
    user: null, balances: { depositBalance: 0, winningsBalance: 0, reserveBalance: 0, lockedBalance: 0 },
    isOnline: true, logout: vi.fn(),
  }),
  spendableBalance: () => 0,
}));
vi.mock('./ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn(), toggle: vi.fn() }),
  ThemeProvider: ({ children }: any) => children,
}));
vi.mock('./useViewport', () => ({ useViewport: () => ({ isMobile: true, width: 400, height: 880 }) }));
vi.mock('../components/AnnouncementBanner', () => ({ default: () => null }));
vi.mock('../components/Modals/AuthModal', () => ({ default: () => null }));
vi.mock('../components/Modals/ShareModal', () => ({ default: () => null }));
vi.mock('../components/Modals/ChannelGateModal', () => ({ default: () => null }));
vi.mock('../components/Layout/NotificationBell', () => ({ default: () => null }));

const { default: RedesignShell } = await import('./RedesignShell');

const paint = () => render(<RedesignShell><div /></RedesignShell>);
const card = (name: RegExp) => screen.queryByRole('button', { name });

describe('the home category cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers.anyCasino = true; providers.anyCrash = true; providers.anySports = true;
  });

  it('offers every category that has a provider', () => {
    paint();
    expect(card(/CASH OR CRASH/i)).not.toBeNull();
    expect(card(/SPORTS/i)).not.toBeNull();
    expect(card(/CASINO/i)).not.toBeNull();
  });

  it('does NOT offer a card whose page would bounce the player straight back', () => {
    providers.anyCrash = false;
    providers.anySports = false;
    paint();
    expect(card(/CASH OR CRASH/i)).toBeNull();
    expect(card(/SPORTS Bet anytime/i)).toBeNull();
    // The one that still works is untouched.
    expect(card(/CASINO/i)).not.toBeNull();
  });

  it('keeps DELHI BAZAAR whatever the providers say — it is the platform\'s own board', () => {
    providers.anyCasino = false; providers.anyCrash = false; providers.anySports = false;
    paint();
    expect(card(/DELHI BAZAAR/i)).not.toBeNull();
    expect(card(/CASINO/i)).toBeNull();
  });
});
