// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The wallet modal — the only screen from which a player moves real money.
 *
 * ── What is worth testing on a component, and what is not ───────────────────
 * Not the styling, and not that React renders. What matters here is the set of
 * things this dialog REFUSES to do, because every one of them is a request the
 * server would otherwise have to reject: a withdrawal with no bank details on
 * file, an amount below the minimum, more than the player holds.
 *
 * The server refuses all of these too, and must. But a client that sends them
 * anyway turns a clear message into a failed request the player cannot explain,
 * and — for the balance check — leaks the fact that the guard exists only on one
 * side. Both sides is the correct answer.
 *
 * The API client is the ONE thing stubbed: this is a test of the dialog's
 * decisions, and a real HTTP call would be testing the network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../services/apiClient', () => ({
  default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const { default: WalletModal } = await import('./WalletModal');

/**
 * The CTA, not the tab.
 *
 * The tab switcher and the submit button carry the SAME words — the tab reads
 * "⬇️ Add Funds" and the button reads "Add Funds" — so a loose match finds two
 * elements and the test that clicks one is not the test anybody meant to write.
 * An exact name matches only the CTA; the tabs are reached through `tab()`.
 */
const cta = (name: 'Add Funds' | 'Withdraw') =>
  screen.getByRole('button', { name });

const tab = (which: 'buy' | 'sell') =>
  screen.getByRole('button', { name: which === 'buy' ? '⬇️ Add Funds' : '⬆️ Withdraw' });

/** The profile shape the modal reads its balances and bank details from. */
const profile = (over: Record<string, unknown> = {}) => ({
  user: {
    depositBalance: 1000,
    winningsBalance: 500,
    bankDetails: { upiId: 'player@bank' },
    ...over,
  },
});

describe('WalletModal', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue(profile());
  });

  const open = (props = {}) =>
    render(<WalletModal isOpen onClose={() => {}} {...props} />);

  it('renders nothing at all when closed', () => {
    const { container } = render(<WalletModal isOpen={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    // And it must not have fetched: a closed modal that still calls the profile
    // endpoint costs a request on every render of the page behind it.
    expect(get).not.toHaveBeenCalled();
  });

  it('shows both balances, formatted as money', async () => {
    open();
    await waitFor(() => expect(screen.getByText(/₹1,000/)).toBeInTheDocument());
    expect(screen.getByText(/₹500/)).toBeInTheDocument();
  });

  it('shows ZERO rather than blank when the profile fetch fails', async () => {
    // A balance that renders empty because a request failed reads as "you have
    // nothing", which is a different and alarming claim.
    get.mockRejectedValue(new Error('network down'));
    open();
    await waitFor(() => expect(screen.getAllByText(/₹0/).length).toBeGreaterThan(0));
  });

  it('disables the button until an amount is entered', async () => {
    open();
    await waitFor(() => expect(cta('Add Funds')).toBeDisabled());
  });

  it('creates a deposit order for a valid amount', async () => {
    post.mockResolvedValue({ orderId: 'ord-1' });
    open();
    await waitFor(() => expect(screen.getByPlaceholderText('0')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('0'), '250');
    await userEvent.click(cta('Add Funds'));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/payment/deposit/create', { tokenAmount: 250 },
    ));
  });

  it('REFUSES an amount below the minimum, and sends nothing', async () => {
    open();
    await waitFor(() => expect(screen.getByPlaceholderText('0')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('0'), '0.5');
    await userEvent.click(cta('Add Funds'));

    expect(await screen.findByText(/valid token amount/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('surfaces the server’s refusal message rather than a generic one', async () => {
    // The server knows why it refused — "daily limit reached", "account under
    // review". Replacing that with "something went wrong" is how a player ends
    // up contacting support about a rule the platform could have stated.
    post.mockRejectedValue({ data: { message: 'Daily deposit limit reached.' } });
    open();
    await waitFor(() => expect(screen.getByPlaceholderText('0')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('0'), '100');
    await userEvent.click(cta('Add Funds'));

    expect(await screen.findByText('Daily deposit limit reached.')).toBeInTheDocument();
  });

  it('falls back to a readable message when the server gives none', async () => {
    post.mockRejectedValue(new Error('socket hang up'));
    open();
    await waitFor(() => expect(screen.getByPlaceholderText('0')).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText('0'), '100');
    await userEvent.click(cta('Add Funds'));
    expect(await screen.findByText(/socket hang up|Failed to create deposit order/i)).toBeInTheDocument();
  });

  // ── The withdrawal side, where the refusals matter most ──────────────────
  it('refuses to withdraw with NO bank details, and disables the button', async () => {
    get.mockResolvedValue(profile({ bankDetails: null }));
    open({ initialTab: 'sell' });

    await waitFor(() => expect(screen.getByText(/No bank details saved/i)).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText('0'), '100');

    // Disabled, not merely refused on click: a withdrawal that cannot be paid
    // out should never look submittable.
    expect(cta('Withdraw')).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows which account a withdrawal would be paid to', async () => {
    open({ initialTab: 'sell' });
    // The player is about to send money somewhere. Naming the destination is
    // the difference between a confirmation and a guess.
    await waitFor(() => expect(screen.getByText(/player@bank/)).toBeInTheDocument());
  });

  it('REFUSES to withdraw more than the winnings balance, and sends nothing', async () => {
    open({ initialTab: 'sell' });
    await waitFor(() => expect(screen.getByPlaceholderText('0')).toBeInTheDocument());

    // 900 against a 500 winnings balance. The server refuses this too, under
    // the row lock — but a client that sends it turns a clear message into a
    // failed request.
    await userEvent.type(screen.getByPlaceholderText('0'), '900');
    await userEvent.click(cta('Withdraw'));

    expect(await screen.findByText(/Insufficient winnings/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('withdraws from WINNINGS only — the deposit balance is not spendable here', async () => {
    // Deposit is 1000 and winnings 500. An amount between the two must be
    // refused: deposited money is not withdrawable, and treating the two as one
    // pool is how a platform pays out money it never took.
    open({ initialTab: 'sell' });
    await waitFor(() => expect(screen.getByPlaceholderText('0')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('0'), '750');
    await userEvent.click(cta('Withdraw'));

    expect(await screen.findByText(/Insufficient winnings/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('creates a withdrawal order for an amount within the balance', async () => {
    post.mockResolvedValue({ orderId: 'wd-1' });
    open({ initialTab: 'sell' });
    await waitFor(() => expect(screen.getByPlaceholderText('0')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('0'), '400');
    await userEvent.click(cta('Withdraw'));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/payment/withdrawal/create', { tokenAmount: 400 },
    ));
    // The bank details are NOT re-sent from the client: the server reads them
    // from the profile, so a tampered payload cannot redirect a payout.
    expect(post.mock.calls[0][1]).not.toHaveProperty('bankDetails');
    expect(post.mock.calls[0][1]).not.toHaveProperty('upiId');
  });

  it('clears the amount and any error when the tab is switched', async () => {
    open();
    await waitFor(() => expect(screen.getByPlaceholderText('0')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText('0'), '0.5');
    await userEvent.click(cta('Add Funds'));
    expect(await screen.findByText(/valid token amount/i)).toBeInTheDocument();

    // An amount typed for a deposit must not survive into a withdrawal, where
    // the same number means something different.
    await userEvent.click(tab('sell'));
    expect(screen.getByPlaceholderText('0')).toHaveValue(null);
    expect(screen.queryByText(/valid token amount/i)).toBeNull();
  });

  it('closes when the close control is used', async () => {
    const onClose = vi.fn();
    open({ onClose });
    await waitFor(() => expect(screen.getByText('Wallet')).toBeInTheDocument());
    await userEvent.click(screen.getByText('✕'));
    expect(onClose).toHaveBeenCalled();
  });
});
