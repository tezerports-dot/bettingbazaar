// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * One line per order (owner, 2026-10-17): the amount, the reference, the time
 * left, and only the ✓ / ✗ the order's state allows. There is no Accept:
 * routing starts an order as it hands it out.
 *
 * "Payment not received" denies a payment the player CLAIMED, so it is offered
 * on a PAID buy and nothing before it (owner, 2026-10-07; the server answers
 * 400 NOT_PAID_YET). A decline is offered only when the server says nobody can
 * have paid on the order yet (`canDecline`), and the row keeps no copy of that
 * rule (§28).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OrderRow, type OrderActions } from './OrderRow';
import { OrderStatus } from '../types';

const actions = (): OrderActions => ({
  onDecline: vi.fn(), onPaymentNotReceived: vi.fn(), onRelease: vi.fn(),
  onPayout: vi.fn(), onRedFlag: vi.fn(), onScanCashLink: vi.fn(), onOpen: vi.fn(),
});

// `upiId` is PLANTED: the server sends no UPI handle. It stays as an unknown
// key the row must not render.
const MERCHANT: any = {
  acceptedCurrencies: ['INR'],
  bankDetails: { upiId: '9876501234@ybl', accountNo: '50100123456789', ifsc: 'HDFC0000123', bankName: 'HDFC Bank', accountHolderName: 'Ravi Kumar' },
};

const bankBuy = (over: Record<string, unknown> = {}): any => ({
  _id: 'ORD-B1', id: 'ORD-B1', orderId: 'ORD-B1', type: 'DEPOSIT', status: OrderStatus.PROCESSING,
  paymentMode: 'P2P_UPI', fiatAmount: 50000, amount: 50000, tokenAmount: 50000, canDecline: false, ...over,
});
const cashBuy = (over: Record<string, unknown> = {}): any => bankBuy({
  _id: 'ORD-C1', orderId: 'ORD-C1', paymentMode: 'CASH_ATM', fiatAmount: 1000, amount: 1000, tokenAmount: 1000,
  cashLink: null, canDecline: true, ...over,
});
const sell = (over: Record<string, unknown> = {}): any => bankBuy({
  _id: 'ORD-S1', orderId: 'ORD-S1', type: 'WITHDRAWAL', canDecline: true, ...over,
});

const NOT_RECEIVED = { name: /Payment not received/ };
const RELEASE = { name: /confirm and release/ };
const DECLINE = { name: /Decline/ };

describe('the order row', () => {
  it('fits one order on one line: amount and reference, no destination and no Accept', () => {
    render(<OrderRow order={bankBuy({ status: OrderStatus.PAID, utrNumber: '412345678901' })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    const row = screen.getByTestId('order-row');
    expect(row).toHaveTextContent('₹50,000');
    expect(row).toHaveTextContent('412345678901');
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    // Where the money goes is in the details, never on the row, and no UPI handle anywhere.
    expect(document.body.innerHTML).not.toContain('50100123456789');
    expect(document.body.innerHTML).not.toContain('9876501234');
  });

  it('opens the details when the row is tapped', () => {
    const a = actions();
    render(<OrderRow order={bankBuy()} merchant={MERCHANT} now={Date.now()} actions={a} />);
    fireEvent.click(screen.getByRole('button', { name: /Open deposit ORD-B1/ }));
    expect(a.onOpen).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ORD-B1' }));
  });
});

describe('✓ and ✗ on a buy', () => {
  it('offers nothing on a started bank buy the player has not paid; the row says what it waits for', () => {
    render(<OrderRow order={bankBuy()} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', NOT_RECEIVED)).toBeNull();
    expect(screen.queryByRole('button', RELEASE)).toBeNull();
    expect(screen.queryByRole('button', DECLINE)).toBeNull();
    expect(screen.getByTestId('order-row')).toHaveTextContent('Waiting for payment');
  });

  it('offers ✓ and ✗ once the player tapped Paid with a reference, and each calls its action', () => {
    const a = actions();
    const paid = bankBuy({ status: OrderStatus.PAID, utrNumber: '412345678901' });
    render(<OrderRow order={paid} merchant={MERCHANT} now={Date.now()} actions={a} />);
    fireEvent.click(screen.getByRole('button', RELEASE));
    expect(a.onRelease).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ORD-B1' }));
    fireEvent.click(screen.getByRole('button', NOT_RECEIVED));
    expect(a.onPaymentNotReceived).toHaveBeenCalledWith(expect.objectContaining({ status: OrderStatus.PAID }));
    // A press on a button is not a tap on the row.
    expect(a.onOpen).not.toHaveBeenCalled();
  });

  it('holds ✓ back while a PAID buy has no reference yet, but still offers ✗', () => {
    render(<OrderRow order={bankBuy({ status: OrderStatus.PAID, utrNumber: '' })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', RELEASE)).toBeNull();
    expect(screen.getByRole('button', NOT_RECEIVED)).toBeInTheDocument();
    expect(screen.getByTestId('order-row')).toHaveTextContent('Waiting for UTR');
  });

  it('asks a cash buy for the machine QR, and offers the decline only while the server allows it', () => {
    const a = actions();
    render(<OrderRow order={cashBuy()} merchant={MERCHANT} now={Date.now()} actions={a} />);
    expect(screen.getByTestId('order-row')).toHaveTextContent('Scan the machine QR');
    fireEvent.click(screen.getByRole('button', { name: 'Scan the machine QR' }));
    expect(a.onScanCashLink).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', DECLINE));
    expect(a.onDecline).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ORD-C1' }));
  });

  it('offers no decline once the QR is scanned (the server says so), only a rescan', () => {
    render(<OrderRow order={cashBuy({ cashLink: 'upi://pay?pa=atm@icici&am=1000', canDecline: false })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', DECLINE)).toBeNull();
    expect(screen.getByRole('button', { name: /Scan the machine QR again/ })).toBeInTheDocument();
  });
});

describe('✓ and ✗ on a sell', () => {
  it('offers the payout and the decline on a started sell', () => {
    const a = actions();
    render(<OrderRow order={sell()} merchant={MERCHANT} now={Date.now()} actions={a} />);
    fireEvent.click(screen.getByRole('button', { name: /Payout sent/ }));
    expect(a.onPayout).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', DECLINE));
    expect(a.onDecline).toHaveBeenCalled();
    expect(screen.queryByRole('button', NOT_RECEIVED)).toBeNull();
  });

  it('offers nothing on a sell already marked paid: its status instead', () => {
    render(<OrderRow order={sell({ status: OrderStatus.PAID, canDecline: false })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.queryAllByRole('button')).toHaveLength(1); // the row itself
    expect(screen.getByText('Payment claimed')).toBeInTheDocument();
  });
});
