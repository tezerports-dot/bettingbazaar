// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's screens (owner, 2026-10-11 — Phase B).
 *
 * What is pinned:
 *   • who sees what: the Account nav for a merchant account's owner and
 *     sub-members, never for an agent; an agent keeps Team; an AUDIT
 *     sub-member gets no Sub-members tab and is told so on its route (S48),
 *     and is offered no account control;
 *   • the UPI scanner form: the scanned static QR and the bank details go to
 *     the server under the kind UPI_QR; a QR with an amount is refused before
 *     anything is sent; the server's refusal is announced (S44);
 *   • sub-members: the add form sends name, mobile (no password) and the ticked
 *     roles; ticking an account assigns it for that duty;
 *   • pool and reports: the request and the CSV download reach their calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const auth = vi.hoisted(() => ({ merchant: null as Record<string, unknown> | null }));
vi.mock('../../services/AuthContext', () => ({
  useAuth: () => ({ merchant: auth.merchant, refreshProfile: vi.fn(), logout: vi.fn() }),
}));
vi.mock('../../services/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));
const api = vi.hoisted(() => ({
  getMerchantAccount: vi.fn(),
  addPaymentAccount: vi.fn(),
  updatePaymentAccount: vi.fn(),
  removePaymentAccount: vi.fn(),
  setPaymentAccountSizes: vi.fn(),
  addSubMember: vi.fn(),
  setSubMemberRoles: vi.fn(),
  removeSubMember: vi.fn(),
  assignSubMemberAccount: vi.fn(),
  unassignSubMemberAccount: vi.fn(),
  requestMerchantPool: vi.fn(),
  cancelMerchantPoolRequest: vi.fn(),
  getMerchantReport: vi.fn(),
  getOrderReport: vi.fn(),
  downloadOrderReportCsv: vi.fn(),
  toggleOnlineStatus: vi.fn(),
}));
vi.mock('../../services/api', () => ({ api }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import PaymentAccountsPage from './PaymentAccountsPage';
import SubMembersPage from './SubMembersPage';
import PoolPage from './PoolPage';
import ReportsPage from './ReportsPage';
import Layout from '../../components/Layout';
import { ROUTES } from '../../constants';

const OWNER = { id: 'm-1', isOnline: true, status: 'ACTIVE', username: 'Shop', actor: { isOwner: true }, isMerchantAccount: true };
const AGENT = { id: 'a-1', isOnline: true, status: 'ACTIVE', username: 'Agent', actor: { isOwner: true }, isMerchantAccount: false };
const AUDITOR = {
  ...OWNER, isMerchantAccount: true,
  actor: { isOwner: false, staffId: 'mst_1', name: 'Asha', roles: ['AUDIT'], depositAccountIds: [], withdrawalAccountIds: [] },
};

const ACCOUNT = {
  accountId: 'mpa_1', merchantId: 'm-1', kind: 'BANK', label: 'Shop HDFC', upiId: null, upiName: null, upiLink: null,
  holderName: 'Shop Ltd', accountNo: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC',
  acceptsDeposits: true, paysWithdrawals: true, status: 'ACTIVE', lastUsedAt: null, createdAt: '', updatedAt: '', removedAt: null,
  buySizes: [50000, 100000], sellSizes: [50000, 100000],
};
const OVERVIEW = {
  success: true,
  team: {
    teamId: 't-d', kind: 'DIRECT', ownerMerchantId: 'm-1', ownerName: 'Shop', ownerRef: 'M1', ownerStatus: 'ACTIVE',
    ownerApproval: 'APPROVED', ownerOnline: true, routingPriority: 3, name: 'Shop', poolAvailablePaise: 500000, poolHeldPaise: 100000,
    poolExposure: { heldOpenPaise: 60000, heldDisputedPaise: 40000, openBuys: 1, sellsSettlingPaise: 250000, sellsDisputedPaise: 0, openSells: 1 },
    commission: { teamId: 't-d', buysPaise: 0, sellsPaise: 0, matchedPaise: 0, highPaise: 0, paidPaise: 0, owedPaise: 0, commissionPercent: 10, supervisorSharePercent: 0 },
    createdAt: '',
  },
  accounts: [ACCOUNT],
  sizes: { required: { DEPOSIT: [50000, 100000], WITHDRAWAL: [50000, 100000] }, uncovered: { DEPOSIT: [], WITHDRAWAL: [] } },
  staff: [{ staffId: 'mst_1', merchantId: 'm-1', userId: 'u-9', name: 'Ravi', mobile: '9876543210', roles: ['DEPOSITS'], status: 'ACTIVE', createdAt: '', removedAt: null, assignments: [] }],
  poolRequests: [],
  flags: [],
};

const STATIC_QR = 'upi://pay?pa=shop.hdfc@okhdfc&pn=Shop%20Ltd&cu=INR';

const at = (path: string, merchant: Record<string, unknown>, ui: React.ReactElement) => {
  auth.merchant = merchant;
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
};

const detectorReading = (raw: string) => {
  (globalThis as any).BarcodeDetector = class { async detect() { return [{ rawValue: raw }]; } };
  (globalThis as any).createImageBitmap = vi.fn(async () => ({ width: 800, height: 800, close() {} }));
};
const photo = () => new File(['x'], 'qr.jpg', { type: 'image/jpeg' });
const width = window.innerWidth;

beforeEach(() => {
  vi.clearAllMocks();
  api.getMerchantAccount.mockResolvedValue(OVERVIEW);
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});
afterEach(() => {
  delete (globalThis as any).BarcodeDetector;
  delete (globalThis as any).createImageBitmap;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
});

describe('who sees the merchant account screens', () => {
  const navLabels = () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    return screen.getAllByRole('button').map((b) => b.getAttribute('title')).filter(Boolean);
  };

  it('a merchant account owner gets Account and no Team', () => {
    at('/dashboard', OWNER, <Layout><div /></Layout>);
    const labels = navLabels();
    expect(labels).toContain('Account');
    expect(labels).not.toContain('Team');
  });

  it('an agent keeps Team and gets no Account', () => {
    at('/dashboard', AGENT, <Layout><div /></Layout>);
    const labels = navLabels();
    expect(labels).toContain('Team');
    expect(labels).not.toContain('Account');
  });

  it('a sub-member has no online switch: going online is the owner\'s', () => {
    at('/dashboard', AUDITOR, <Layout><div /></Layout>);
    expect(screen.queryByRole('button', { name: /^(Online|Offline)$/ })).toBeNull();
    expect(screen.getByText('Sub-member')).toBeInTheDocument();
  });

  it('an auditor gets no Sub-members tab, and its route says who it is for', async () => {
    at(ROUTES.ACCOUNT_SUB_MEMBERS, AUDITOR, <SubMembersPage />);
    const tabs = screen.getByRole('navigation', { name: 'Merchant account' });
    expect(within(tabs).queryByRole('button', { name: 'Sub-members' })).toBeNull();
    expect(within(tabs).getByRole('button', { name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/for the merchant account owner/);
    expect(api.addSubMember).not.toHaveBeenCalled();
  });

  it('an auditor reads the payment accounts and is offered no control on them', async () => {
    at(ROUTES.ACCOUNT_PAYMENT_ACCOUNTS, AUDITOR, <PaymentAccountsPage />);
    expect((await screen.findAllByText('Shop HDFC')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Add a UPI scanner|Add a bank account|Edit|Pause|Remove/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save sizes' })).toBeNull();
  });

  it('an agent opening an account screen is told these are for merchant accounts', () => {
    at(ROUTES.ACCOUNT_POOL, AGENT, <PoolPage />);
    expect(screen.getByRole('status')).toHaveTextContent(/for merchant accounts/);
  });
});

describe('adding a UPI scanner account', () => {
  const openForm = async () => {
    at(ROUTES.ACCOUNT_PAYMENT_ACCOUNTS, OWNER, <PaymentAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add a UPI scanner/ }));
  };
  const fillBank = () => {
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Counter QR' } });
    fireEvent.change(screen.getByLabelText('Account holder name'), { target: { value: 'Shop Ltd' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '998877665544' } });
    fireEvent.change(screen.getByLabelText('IFSC'), { target: { value: 'hdfc0001234' } });
    fireEvent.change(screen.getByLabelText('Bank name'), { target: { value: 'HDFC' } });
  };

  it('scans the static QR, then sends it with the bank details behind it', async () => {
    api.addPaymentAccount.mockResolvedValue({ ...ACCOUNT, accountId: 'mpa_2', kind: 'UPI_QR' });
    detectorReading(STATIC_QR);
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: /Scan your UPI QR/ }));
    fireEvent.change(screen.getByLabelText('Photo of your UPI QR'), { target: { files: [photo()] } });
    expect(await screen.findByText('shop.hdfc@okhdfc')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use this QR' }));
    fillBank();
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.addPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'UPI_QR', upiLink: STATIC_QR, label: 'Counter QR', accountNo: '998877665544', ifsc: 'HDFC0001234',
      acceptsDeposits: true, paysWithdrawals: true,
    })));
  });

  it('refuses a QR with a fixed amount before anything is sent', async () => {
    detectorReading(`${STATIC_QR}&am=500.00`);
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: /Scan your UPI QR/ }));
    fireEvent.change(screen.getByLabelText('Photo of your UPI QR'), { target: { files: [photo()] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/one fixed amount/));
    expect(screen.queryByRole('button', { name: 'Use this QR' })).toBeNull();
  });

  it('will not add a UPI scanner with no QR scanned, and says so', async () => {
    await openForm();
    fillBank();
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Scan your UPI QR first.');
    expect(api.addPaymentAccount).not.toHaveBeenCalled();
  });

  it('announces the server\'s refusal in its words', async () => {
    api.addPaymentAccount.mockRejectedValue(Object.assign(new Error('That UPI ID is already on another live account.'), { status: 409 }));
    detectorReading(STATIC_QR);
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: /Scan your UPI QR/ }));
    fireEvent.change(screen.getByLabelText('Photo of your UPI QR'), { target: { files: [photo()] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Use this QR' }));
    fillBank();
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That UPI ID is already on another live account.');
  });

  it('a bank account is a plain form, and its switches go with it', async () => {
    api.addPaymentAccount.mockResolvedValue(ACCOUNT);
    at(ROUTES.ACCOUNT_PAYMENT_ACCOUNTS, OWNER, <PaymentAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add a bank account/ }));
    expect(screen.queryByRole('button', { name: /Scan your UPI QR/ })).toBeNull();
    fillBank();
    fireEvent.click(screen.getByRole('switch', { name: 'Pay withdrawals' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.addPaymentAccount).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'BANK', acceptsDeposits: true, paysWithdrawals: false,
    })));
  });

  it('an existing account is paused and switched from its row', async () => {
    api.updatePaymentAccount.mockResolvedValue(ACCOUNT);
    at(ROUTES.ACCOUNT_PAYMENT_ACCOUNTS, OWNER, <PaymentAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Pause/ }));
    await waitFor(() => expect(api.updatePaymentAccount).toHaveBeenCalledWith('mpa_1', { status: 'PAUSED' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Accept deposits on Shop HDFC' }));
    await waitFor(() => expect(api.updatePaymentAccount).toHaveBeenCalledWith('mpa_1', { acceptsDeposits: false }));
  });
});

describe('sub-members', () => {
  it('the add form sends the ticked roles; ticking an account assigns it for that duty', async () => {
    api.addSubMember.mockResolvedValue(OVERVIEW.staff[0]);
    api.assignSubMemberAccount.mockResolvedValue(OVERVIEW.staff[0]);
    at(ROUTES.ACCOUNT_SUB_MEMBERS, OWNER, <SubMembersPage />);
    expect(await screen.findByText('Ravi')).toBeInTheDocument();
    // Nobody is shown another person's mobile (CLAUDE.md §24).
    expect(screen.queryByText(/9876543210/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Meera' } });
    fireEvent.change(screen.getByLabelText(/^Mobile/), { target: { value: '9123456789' } });
    // No password: a sub-member signs in with Telegram (owner, 2026-10-14).
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    fireEvent.click(document.getElementById('sm-new-role-WITHDRAWALS')!);
    fireEvent.click(document.getElementById('sm-new-role-AUDIT')!);
    fireEvent.click(screen.getByRole('button', { name: /Add sub-member/ }));
    await waitFor(() => expect(api.addSubMember).toHaveBeenCalledWith({
      mobile: '9123456789', name: 'Meera', roles: ['WITHDRAWALS', 'AUDIT'],
    }));

    fireEvent.click(screen.getByLabelText('Shop HDFC'));
    await waitFor(() => expect(api.assignSubMemberAccount).toHaveBeenCalledWith('mst_1', 'mpa_1', 'DEPOSIT'));
  });
});

describe('pool and reports', () => {
  it('the owner asks for tokens, in whole tokens', async () => {
    api.requestMerchantPool.mockResolvedValue('req-1');
    at(ROUTES.ACCOUNT_POOL, OWNER, <PoolPage />);
    expect(await screen.findByText('5,000 BB')).toBeInTheDocument();
    // Where the held tokens are, and what is on its way in (owner, 2026-10-14).
    expect(screen.getByText('Locked in open buys')).toBeInTheDocument();
    expect(screen.getByText('600 BB')).toBeInTheDocument();
    expect(screen.getByText('Locked in disputes')).toBeInTheDocument();
    expect(screen.getByText('400 BB')).toBeInTheDocument();
    expect(screen.getByText('Incoming from sells')).toBeInTheDocument();
    expect(screen.getByText('2,500 BB')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tokens (whole number)'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.requestMerchantPool).toHaveBeenCalledWith('BUY', 2000, ''));
  });

  it('the report shows the server\'s figures and the orders table and its CSV follow the same range', async () => {
    const zero = { orders: 0, completed: 0, completedPaise: 0, disputed: 0, disputesLost: 0 };
    api.getMerchantReport.mockResolvedValue({
      success: true, range: { from: null, to: null },
      totals: { deposits: { ...zero, orders: 7 }, withdrawals: zero },
      byAccount: [{ accountId: 'mpa_1', label: 'Shop HDFC', kind: 'BANK', status: 'ACTIVE', deposits: zero, withdrawals: zero }],
      bySubMember: [], unattributed: { deposits: zero, withdrawals: zero },
    });
    api.getOrderReport.mockResolvedValue({
      success: true, range: { from: null, to: null },
      rows: [{
        orderId: 'DEP_1', type: 'DEPOSIT', userId: 'u_9', utr: '612345678901', tokenAmount: 1000,
        state: 'COMPLETED', result: 'CONFIRMED', actedBy: { kind: 'STAFF', name: 'Desk 1' }, at: '2026-10-05T10:00:00Z',
      }],
      totals: { orders: 1, confirmed: 1, rejected: 0, confirmedBuyPaise: 100000, confirmedSellPaise: 0 },
      pagination: { total: 1, limit: 50, skip: 0 },
    });
    api.downloadOrderReportCsv.mockResolvedValue(undefined);
    at(ROUTES.ACCOUNT_REPORTS, AUDITOR, <ReportsPage />);
    expect(await screen.findByText('The last seven days')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Totals' })).toHaveTextContent('7');
    // The orders behind it, one row each, with who pressed ✓.
    expect(await screen.findByText('DEP_1')).toBeInTheDocument();
    expect(screen.getByText('612345678901')).toBeInTheDocument();
    expect(screen.getByText('Desk 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirmed')).toHaveTextContent('✓');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-07' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show report' }));
    await waitFor(() => expect(api.getMerchantReport).toHaveBeenLastCalledWith('2026-10-01', '2026-10-07'));
    // The table follows the range the figures were built for, and so does the CSV.
    await waitFor(() => expect(api.getOrderReport).toHaveBeenLastCalledWith(
      { from: '2026-10-01', to: '2026-10-07', type: '' }, { limit: 50, skip: 0 }));
    fireEvent.click(screen.getByRole('button', { name: /Download CSV/ }));
    await waitFor(() => expect(api.downloadOrderReportCsv).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-07', type: '' }));
  });
});

describe('which sizes go to which account', () => {
  const SECOND = { ...ACCOUNT, accountId: 'mpa_2', label: 'Shop ICICI', buySizes: [], sellSizes: [] };

  it('sends every account\'s ticks in one save, and shows a size with no account in red', async () => {
    api.getMerchantAccount.mockResolvedValue({ ...OVERVIEW, accounts: [ACCOUNT, SECOND] });
    api.setPaymentAccountSizes.mockResolvedValue([]);
    at(ROUTES.ACCOUNT_PAYMENT_ACCOUNTS, OWNER, <PaymentAccountsPage />);
    const tick = await screen.findByRole('checkbox', { name: /Buys of ₹1,00,000 on Shop HDFC/ });
    fireEvent.click(tick);
    // Nothing takes ₹1,00,000 buys now: said before anything is sent.
    expect(screen.getByRole('alert')).toHaveTextContent(/buy ₹1,00,000/);
    fireEvent.click(screen.getByRole('checkbox', { name: /Buys of ₹1,00,000 on Shop ICICI/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save sizes' }));
    await waitFor(() => expect(api.setPaymentAccountSizes).toHaveBeenCalledWith([
      { accountId: 'mpa_1', buySizes: [50000], sellSizes: [50000, 100000] },
      { accountId: 'mpa_2', buySizes: [100000], sellSizes: [] },
    ]));
  });

  it('says the server\'s refusal as it says it', async () => {
    api.getMerchantAccount.mockResolvedValue({ ...OVERVIEW, accounts: [ACCOUNT, SECOND] });
    api.setPaymentAccountSizes.mockRejectedValue(Object.assign(new Error('Every size must go to at least one of your accounts.'), { status: 409 }));
    at(ROUTES.ACCOUNT_PAYMENT_ACCOUNTS, OWNER, <PaymentAccountsPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Sells of ₹50,000 on Shop ICICI/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save sizes' }));
    expect(await screen.findByText('Every size must go to at least one of your accounts.')).toBeInTheDocument();
  });

  it('a sub-member sees the ticks and cannot change them', async () => {
    at(ROUTES.ACCOUNT_PAYMENT_ACCOUNTS, { ...AUDITOR, actor: { ...AUDITOR.actor, roles: ['WITHDRAWALS'] } }, <PaymentAccountsPage />);
    const tick = await screen.findByRole('checkbox', { name: /Buys of ₹50,000 on Shop HDFC/ });
    expect(tick).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save sizes' })).toBeNull();
  });
});
