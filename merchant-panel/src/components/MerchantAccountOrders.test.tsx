// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's orders (owner, 2026-10-11 — Phase B).
 *
 * What is pinned:
 *   • role gating on the order row: an auditor works nothing and is told why;
 *     a deposit verifier with the order's account assigned is offered ✓ on a
 *     paid buy, and one without that account is not (the server's
 *     `workRefusal`);
 *   • "Paid from account" is required on a merchant account's sell: no choice
 *     sends nothing and says so in an alert; a choice sends (UTR, account);
 *     the server's refusal is announced and the dialog stays open (S44);
 *   • a sub-member is offered only the accounts assigned to them for paying.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { OrderRow, type OrderActions } from './OrderRow';
import { PayoutFromAccountDialog } from './PayoutFromAccountDialog';
import { OrderStatus } from '../types';

const actions = (): OrderActions => ({
  onDecline: vi.fn(), onPaymentNotReceived: vi.fn(), onRelease: vi.fn(),
  onPayout: vi.fn(), onRedFlag: vi.fn(), onScanCashLink: vi.fn(), onOpen: vi.fn(),
});

const sub = (roles: string[], depositAccountIds: string[] = [], withdrawalAccountIds: string[] = []): any => ({
  acceptedCurrencies: ['INR'], isMerchantAccount: true,
  actor: { isOwner: false, staffId: 'mst_1', name: 'Asha', roles, depositAccountIds, withdrawalAccountIds },
});
const OWNER: any = { acceptedCurrencies: ['INR'], isMerchantAccount: true, actor: { isOwner: true } };

const account = (accountId: string, label: string, over: Record<string, unknown> = {}): any => ({
  accountId, merchantId: 'm-1', kind: 'BANK', label, holderName: 'Shop Ltd', accountNo: `1234567890${accountId.slice(-2)}`,
  ifsc: 'HDFC0001234', bankName: 'HDFC', acceptsDeposits: true, paysWithdrawals: true, status: 'ACTIVE', ...over,
});
const ACCOUNTS = [account('mpa_01', 'Counter'), account('mpa_02', 'Back office'), account('mpa_03', 'Paused one', { status: 'PAUSED' })];

const buy = (over: Record<string, unknown> = {}): any => ({
  _id: 'ORD-M1', id: 'ORD-M1', orderId: 'ORD-M1', type: 'DEPOSIT', status: OrderStatus.PAID, utrNumber: '412345678901', inrRouting: 'MERCHANTS',
  paymentMode: 'P2P_UPI', fiatAmount: 50000, amount: 50000, tokenAmount: 50000, payAccountId: 'mpa_01', ...over,
});
const sell = (over: Record<string, unknown> = {}): any => buy({ _id: 'ORD-M2', id: 'ORD-M2', orderId: 'ORD-M2', type: 'WITHDRAWAL', status: OrderStatus.PROCESSING, payAccountId: null, ...over });

describe('what a merchant account\'s order row offers, by role', () => {
  const RELEASE = { name: /confirm and release/ };

  it('an auditor is offered nothing on an open order and is told it is view-only', () => {
    render(<OrderRow order={buy()} merchant={sub(['AUDIT'])} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', RELEASE)).toBeNull();
    expect(screen.getByRole('button', { name: /Open deposit/ })).toHaveAttribute('title', expect.stringMatching(/View only/));
  });

  it('a deposit verifier with the order\'s account is offered ✓', () => {
    const a = actions();
    render(<OrderRow order={buy()} merchant={sub(['DEPOSITS'], ['mpa_01'])} now={Date.now()} actions={a} />);
    fireEvent.click(screen.getByRole('button', RELEASE));
    expect(a.onRelease).toHaveBeenCalled();
  });

  it('a deposit verifier without the order\'s account is not', () => {
    render(<OrderRow order={buy()} merchant={sub(['DEPOSITS'], ['mpa_02'])} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', RELEASE)).toBeNull();
  });

  it('the owner is offered ✓', () => {
    render(<OrderRow order={buy()} merchant={OWNER} now={Date.now()} actions={actions()} />);
    expect(screen.getByRole('button', RELEASE)).toBeInTheDocument();
  });
});

describe('Paid from account, on a merchant account\'s sell', () => {
  const fillUtr = () => fireEvent.change(screen.getByLabelText(/^UTR/), { target: { value: '412345678901' } });

  it('is required: without a choice nothing is sent and the alert says what to do', async () => {
    const submit = vi.fn();
    render(<PayoutFromAccountDialog order={sell()} merchant={OWNER} accounts={ACCOUNTS} onCancel={vi.fn()} onSubmit={submit} />);
    fillUtr();
    fireEvent.click(screen.getByRole('button', { name: /I've sent the money/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose the account you paid this withdrawal from.');
    expect(submit).not.toHaveBeenCalled();
  });

  it('sends the UTR and the chosen account', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<PayoutFromAccountDialog order={sell()} merchant={OWNER} accounts={ACCOUNTS} onCancel={vi.fn()} onSubmit={submit} />);
    fireEvent.change(screen.getByLabelText('Paid from account'), { target: { value: 'mpa_02' } });
    fillUtr();
    fireEvent.click(screen.getByRole('button', { name: /I've sent the money/ }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('412345678901', 'mpa_02'));
  });

  it('announces the server\'s refusal and stays open', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('That UTR is already recorded on another order.'));
    render(<PayoutFromAccountDialog order={sell()} merchant={OWNER} accounts={ACCOUNTS} onCancel={vi.fn()} onSubmit={submit} />);
    fireEvent.change(screen.getByLabelText('Paid from account'), { target: { value: 'mpa_01' } });
    fillUtr();
    fireEvent.click(screen.getByRole('button', { name: /I've sent the money/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That UTR is already recorded on another order.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers a sub-member only the active accounts assigned to them for paying', () => {
    render(<PayoutFromAccountDialog order={sell()} merchant={sub(['WITHDRAWALS'], [], ['mpa_02', 'mpa_03'])}
      accounts={ACCOUNTS} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    const options = within(screen.getByLabelText('Paid from account')).getAllByRole('option').map((o) => o.textContent);
    expect(options.some((o) => o?.includes('Back office'))).toBe(true);
    expect(options.some((o) => o?.includes('Counter'))).toBe(false);
    expect(options.some((o) => o?.includes('Paused one'))).toBe(false);
  });

  it('with no account that can pay, the button is off and the reason is shown', () => {
    render(<PayoutFromAccountDialog order={sell()} merchant={sub(['WITHDRAWALS'], [], [])}
      accounts={ACCOUNTS} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /I've sent the money/ })).toBeDisabled();
    expect(screen.getByText(/No account can pay this/)).toBeInTheDocument();
  });
});
