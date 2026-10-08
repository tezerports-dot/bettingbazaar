// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A supervisor is never a member (CLAUDE.md §2): they run teams and take no
 * orders, so the panel offers them no online switch and no order directions.
 *
 * Driving the panel AS a supervisor (`BB_PROFILE=merchant-supervisor npm run
 * test:drive`) found "Go online" on the Dashboard, in the top bar and in the
 * sidebar, and "Accept deposit/withdrawal orders" on Profile, all offered and
 * all written. The server now refuses them (`SUPERVISOR_TAKES_NO_ORDERS`,
 * supervisorTakesNoOrdersPg.test.js); this file holds the screens to the same
 * answer, and holds the opposite: a member still has every one of them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const auth = vi.hoisted(() => ({ merchant: null as Record<string, unknown> | null }));
vi.mock('../services/AuthContext', () => ({
  useAuth: () => ({ merchant: auth.merchant, refreshProfile: vi.fn(), logout: vi.fn() }),
}));
vi.mock('../services/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));
vi.mock('../services/api', () => ({
  api: {
    getStats: vi.fn().mockResolvedValue({}),
    getEarnings: vi.fn().mockResolvedValue({ earnings: null }),
    getWeeklyEarnings: vi.fn().mockResolvedValue({ weekly: [] }),
    toggleOnlineStatus: vi.fn(),
    updatePreferences: vi.fn(),
    updateProfile: vi.fn(),
    twoFactorStatus: vi.fn().mockResolvedValue({ enabled: true }),
  },
}));
vi.mock('../hooks/useOrders', () => ({
  useOrders: () => ({ orders: [], state: 'ready', counts: {} }),
  needsAction: () => false,
}));
// Each has its own suite; here they are stand-ins so this file asserts only
// the switches.
vi.mock('../components/CashReadyCard', () => ({ CashReadyCard: () => null }));
vi.mock('../components/VerificationGate', () => ({ default: () => null }));
vi.mock('../components/TwoFactorEnrol', () => ({ default: () => null }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import Dashboard from './Dashboard';
import ProfileSettings from './ProfileSettings';
import Layout from '../components/Layout';

const SUPERVISOR = { id: 's-1', merchantId: 's-1', isSupervisor: true, isOnline: false, acceptedCurrencies: ['INR'], status: 'ACTIVE' };
const MEMBER = { id: 'm-1', merchantId: 'm-1', isSupervisor: false, isOnline: false, acceptedCurrencies: ['INR'], status: 'ACTIVE' };

const width = window.innerWidth;
const atDesktop = () => Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });

const show = (merchant: Record<string, unknown>, ui: React.ReactElement) => {
  auth.merchant = merchant;
  return render(<MemoryRouter initialEntries={['/dashboard']}>{ui}</MemoryRouter>);
};

const ONLINE_SWITCH = /^(Go online|Go offline|Online|Offline)$/;

describe('a supervisor is offered no online switch and no order directions', () => {
  beforeEach(atDesktop);
  afterEach(() => Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }));

  it('the Dashboard says what they are and links to their teams, with no "Go online"', async () => {
    show(SUPERVISOR, <Dashboard />);
    expect(await screen.findByText(/Supervisor · your members take the orders/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Go online|Go offline/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open your teams/ })).toBeInTheDocument();
  });

  it('the top bar and the sidebar carry no switch', () => {
    show(SUPERVISOR, <Layout><main>content</main></Layout>);
    expect(screen.queryAllByRole('button', { name: ONLINE_SWITCH })).toEqual([]);
    expect(screen.queryAllByTitle(/Go online|Go offline/)).toEqual([]);
    // What is shown instead: what they are, not a control.
    expect(screen.getByText('Supervisor · takes no orders')).toBeInTheDocument();
    expect(screen.getByText(/Your members go online from their own accounts/)).toBeInTheDocument();
  });

  it('Profile explains there are no order directions to choose, and offers none', () => {
    show(SUPERVISOR, <ProfileSettings />);
    expect(screen.queryByRole('switch', { name: /Accept (deposit|withdrawal) orders/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save preferences' })).not.toBeInTheDocument();
    expect(screen.getByText(/You are a supervisor: you run teams and take no orders yourself/)).toBeInTheDocument();
  });
});

describe('a member keeps every one of them (the opposite)', () => {
  beforeEach(atDesktop);
  afterEach(() => Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }));

  it('the Dashboard offers "Go online"', async () => {
    show(MEMBER, <Dashboard />);
    expect(await screen.findByText(/Offline · Not accepting/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go online/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open your teams/ })).not.toBeInTheDocument();
  });

  it('the top bar and the sidebar each carry the switch', () => {
    show(MEMBER, <Layout><main>content</main></Layout>);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: /Offline/ })).toBeInTheDocument();
    expect(screen.getByRole('complementary')).toHaveTextContent(/Go online/);
    expect(screen.queryByText('Supervisor · takes no orders')).not.toBeInTheDocument();
  });

  it('Profile offers both order directions and the save', () => {
    show(MEMBER, <ProfileSettings />);
    expect(screen.getByRole('switch', { name: 'Accept deposit orders' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Accept withdrawal orders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeInTheDocument();
  });
});
