// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * "Payment never arrived — reject" is offered on a PAID buy, and on nothing
 * before it (owner, 2026-10-07).
 *
 * The button denies a payment the player CLAIMED. Before the player taps Paid
 * there is no claim: the server refuses it (400 NOT_PAID_YET, from the route,
 * the proof upload and the state machine), and the card must not offer what the
 * server refuses (§28). What it shows instead is the wait, and what happens next.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrderCard, type OrderActions } from './OrderCard';
import { OrderStatus } from '../types';

const actions = (): OrderActions => ({
  onAccept: vi.fn(), onReject: vi.fn(), onPaymentNotReceived: vi.fn(), onRelease: vi.fn(),
  onPayout: vi.fn(), onRedFlag: vi.fn(), onScanCashLink: vi.fn(), onOpen: vi.fn(),
});

const MERCHANT: any = {
  acceptedCurrencies: ['INR'],
  bankDetails: { accountNo: '50100123456789', ifsc: 'HDFC0000123', bankName: 'HDFC Bank', accountHolderName: 'Ravi Kumar' },
};

const bankBuy = (over: Record<string, unknown> = {}): any => ({
  _id: 'ORD-B1', id: 'ORD-B1', orderId: 'ORD-B1', type: 'DEPOSIT', status: OrderStatus.PROCESSING,
  paymentMode: 'P2P_UPI', fiatAmount: 50000, amount: 50000, tokenAmount: 50000, ...over,
});

const NOT_RECEIVED = { name: /Payment never arrived/ };

describe('payment not received, on the order card', () => {
  it('is not offered on an accepted buy the player has not paid; the card says what to wait for', () => {
    render(<OrderCard order={bankBuy()} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', NOT_RECEIVED)).toBeNull();
    // What it shows instead: the wait, and what the member does after the tap.
    expect(screen.getByText(/Waiting for the user to pay/)).toHaveTextContent(/Once they tap Paid.*never arrived/);
    expect(screen.getByText(/Waiting for the user to pay/)).toHaveTextContent(/expires on its own/);
  });

  it('is not offered on a buy still waiting for the member to accept, nor on a cash buy before its QR', () => {
    render(<OrderCard order={bankBuy({ status: OrderStatus.ASSIGNED })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    render(<OrderCard order={bankBuy({ _id: 'ORD-C1', orderId: 'ORD-C1', paymentMode: 'CASH_ATM', fiatAmount: 1000, amount: 1000, cashLink: null })}
      merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', NOT_RECEIVED)).toBeNull();
  });

  it('is offered once the player tapped Paid, and opens the dialog for that order', () => {
    // The opposite: the rejection the button exists for.
    const a = actions();
    const paid = bankBuy({ status: OrderStatus.PAID, utrNumber: '412345678901' });
    render(<OrderCard order={paid} merchant={MERCHANT} now={Date.now()} actions={a} />);
    fireEvent.click(screen.getByRole('button', NOT_RECEIVED));
    expect(a.onPaymentNotReceived).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ORD-B1', status: OrderStatus.PAID }));
    expect(screen.queryByText(/Waiting for the user to pay/)).toBeNull();
  });

  it('is not offered on a sell, paid or not', () => {
    render(<OrderCard order={bankBuy({ type: 'WITHDRAWAL', status: OrderStatus.PAID })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    render(<OrderCard order={bankBuy({ _id: 'ORD-S2', orderId: 'ORD-S2', type: 'WITHDRAWAL' })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', NOT_RECEIVED)).toBeNull();
  });
});
