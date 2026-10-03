// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Scanning the cash machine's QR for a cash buy (Step 2d).
 *
 * What is pinned:
 *   • a member whose camera will not start can still photograph the QR, and is
 *     told why the camera is unavailable;
 *   • there is no way to TYPE a link: what the player pays is a machine's QR;
 *   • what was read is shown back (amount and payee) before it is sent, and a
 *     QR for another amount is refused here, while the member is still at the
 *     machine, with the amount to choose;
 *   • the order card asks for the scan on a cash buy, offers it again until
 *     the player taps, and on a bank-transfer buy shows the member's account
 *     and never their UPI handle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CashLinkScanner from './CashLinkScanner';
import { OrderCard, type OrderActions } from './OrderCard';
import { readCashLink } from '../utils/cashLink';
import { OrderStatus } from '../types';

const LINK = 'upi://pay?pa=atm.cash@icici&pn=ICICI%20ATM&am=1000.00&cu=INR&tr=ATM88123';

const cashOrder = (over: Record<string, unknown> = {}): any => ({
  _id: 'ORD-C1', id: 'ORD-C1', orderId: 'ORD-C1', type: 'DEPOSIT', status: OrderStatus.PROCESSING,
  paymentMode: 'CASH_ATM', fiatAmount: 1000, amount: 1000, tokenAmount: 1000, cashLink: null, ...over,
});

/** A browser with a QR detector that reads `raw` from whatever it is shown. */
const detectorReading = (raw: string) => {
  (globalThis as any).BarcodeDetector = class { async detect() { return [{ rawValue: raw }]; } };
  (globalThis as any).createImageBitmap = vi.fn(async () => ({ width: 800, height: 800, close() {} }));
};

const photo = () => new File(['x'], 'qr.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  // jsdom has no camera: the scanner must say so and offer the photo.
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});
afterEach(() => {
  delete (globalThis as any).BarcodeDetector;
  delete (globalThis as any).createImageBitmap;
});

describe('the cash machine scanner', () => {
  it('says why the camera is unavailable, and offers a photo instead', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
      configurable: true,
    });
    render(<CashLinkScanner order={cashOrder()} busy={false} onClose={vi.fn()} onSend={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Camera permission was refused.*photo/);
    expect(screen.getByRole('button', { name: /Take a photo of the QR instead/ })).toBeInTheDocument();
  });

  it('offers no way to type a link', () => {
    const { container } = render(<CashLinkScanner order={cashOrder()} busy={false} onClose={vi.fn()} onSend={vi.fn()} />);
    expect(container.querySelector('input:not([type="file"]), textarea')).toBeNull();
  });

  it('reads a photographed QR, shows the amount and payee, and sends exactly that link', async () => {
    detectorReading(LINK);
    const onSend = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(<CashLinkScanner order={cashOrder()} busy={false} onClose={onClose} onSend={onSend} />);
    fireEvent.change(screen.getByLabelText("Photo of the machine's QR"), { target: { files: [photo()] } });

    expect(await screen.findByText('₹1,000')).toBeInTheDocument();
    expect(screen.getByText('to atm.cash@icici')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Send to the player/ }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ORD-C1' }), LINK));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('refuses a QR for another amount while the member is still at the machine', async () => {
    detectorReading(LINK.replace('am=1000.00', 'am=5000.00'));
    const onSend = vi.fn();
    render(<CashLinkScanner order={cashOrder()} busy={false} onClose={vi.fn()} onSend={onSend} />);
    fireEvent.change(screen.getByLabelText("Photo of the machine's QR"), { target: { files: [photo()] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/₹5,000.*this order is ₹1,000/);
    expect(screen.queryByRole('button', { name: /Send to the player/ })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    // And the way back is a fresh scan.
    fireEvent.click(screen.getByRole('button', { name: /Scan again/ }));
    expect(screen.getByRole('button', { name: /Take a photo of the QR instead/ })).toBeInTheDocument();
  });

  it('keeps the scanner open when the server refuses, so the member can scan again', async () => {
    detectorReading(LINK);
    const onClose = vi.fn();
    render(<CashLinkScanner order={cashOrder()} busy={false} onClose={onClose} onSend={vi.fn().mockResolvedValue(false)} />);
    fireEvent.change(screen.getByLabelText("Photo of the machine's QR"), { target: { files: [photo()] } });
    fireEvent.click(await screen.findByRole('button', { name: /Send to the player/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Send to the player/ })).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('reading a decoded QR', () => {
  it('accepts the order amount, in either spelling', () => {
    expect(readCashLink(LINK, 1000)).toMatchObject({ ok: true, payee: 'atm.cash@icici', amountRupees: 1000, link: LINK });
    expect(readCashLink('UPI://PAY?pa=a@b&am=1000', 1000).ok).toBe(true);
  });

  it('refuses anything that is not a UPI payment QR, or has no amount', () => {
    expect(readCashLink('https://example.com', 1000)).toMatchObject({ ok: false, message: expect.stringMatching(/not a UPI payment QR/) });
    expect(readCashLink('upi://pay?pa=a@b', 1000)).toMatchObject({ ok: false, message: expect.stringMatching(/no amount.*₹1,000/) });
    expect(readCashLink('upi://pay?am=1000', 1000)).toMatchObject({ ok: false, message: expect.stringMatching(/no payee/) });
    // A person's QR, not a machine's: the player would see their number.
    expect(readCashLink('upi://pay?pa=9876543210@ybl&am=1000', 1000)).toMatchObject({ ok: false, message: expect.stringMatching(/mobile number/) });
    expect(readCashLink('upi://pay?pa=atm@sbi&am=1000&pn=Ravi%2098765%2043210', 1000)).toMatchObject({ ok: false, message: expect.stringMatching(/name or note/) });
    expect(readCashLink('upi://pay?pa=atm@sbi&am=1000&pn=SBI%20ATM%20123456', 1000).ok).toBe(true);
  });
});

describe('the order card', () => {
  const actions = (): OrderActions => ({
    onAccept: vi.fn(), onReject: vi.fn(), onPaymentNotReceived: vi.fn(), onRelease: vi.fn(),
    onPayout: vi.fn(), onRedFlag: vi.fn(), onScanCashLink: vi.fn(), onOpen: vi.fn(),
  });
  const MERCHANT: any = {
    acceptedCurrencies: ['INR'],
    bankDetails: { upiId: '9876501234@ybl', accountNo: '50100123456789', ifsc: 'HDFC0000123', bankName: 'HDFC Bank', accountHolderName: 'Ravi Kumar' },
  };

  it('asks for the accept first: nothing is scanned for an order the member may still decline', () => {
    render(<OrderCard order={cashOrder({ status: OrderStatus.ASSIGNED })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.queryByRole('button', { name: /Scan/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Accept/ })).toBeInTheDocument();
  });

  it('asks for the scan on an accepted cash buy, and calls it', () => {
    const a = actions();
    render(<OrderCard order={cashOrder()} merchant={MERCHANT} now={Date.now()} actions={a} />);
    expect(screen.getByText('Scan the cash machine')).toBeInTheDocument();
    // Nothing for the player to pay yet, so no "waiting for the user" either.
    expect(screen.queryByText(/Waiting for the user to pay/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Scan the machine's QR/ }));
    expect(a.onScanCashLink).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'ORD-C1' }));
    // A cash buy is paid to the machine, never to the member.
    expect(document.body.innerHTML).not.toContain('50100123456789');
  });

  it('offers the scan again once sent, until the player taps', () => {
    render(<OrderCard order={cashOrder({ cashLink: LINK, cashLinkAt: new Date().toISOString() })} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.getByText('QR sent to the player')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scan again/ })).toBeInTheDocument();
    const paid = cashOrder({ status: OrderStatus.PAID, cashLink: LINK });
    render(<OrderCard order={paid} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.getAllByRole('button', { name: /Scan again/ })).toHaveLength(1);
  });

  it('shows a bank-transfer buy the member\'s own account, never their UPI handle', () => {
    const order = cashOrder({ paymentMode: 'P2P_UPI', fiatAmount: 50000, amount: 50000, tokenAmount: 50000 });
    render(<OrderCard order={order} merchant={MERCHANT} now={Date.now()} actions={actions()} />);
    expect(screen.getByText('Your bank account — user transfers here')).toBeInTheDocument();
    expect(screen.getByText('50100123456789')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('9876501234');
    expect(screen.queryByRole('button', { name: /Scan/ })).toBeNull();
  });
});
