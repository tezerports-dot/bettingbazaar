// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The cash pay link as a QR on a larger screen (owner, Phase A).
 *
 * What is asserted, and why each:
 *   - on a wide screen the link is drawn as a QR, in the browser, from the
 *     link itself: the drawing is the `qrcode` encoding of exactly that link,
 *     and a different link draws a different code;
 *   - on a narrow screen nothing is drawn (the PAY NOW button is the way);
 *   - the wallet's cash step keeps its PAY NOW button on every screen and adds
 *     the QR only on a wide one, with no image fetched from anywhere.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import QRCode from 'qrcode';
import PayLinkQr, { WIDE_SCREEN_QUERY } from './PayLinkQr';

const LINK = 'upi://pay?pa=atm.cash@icici&pn=ATM&am=1000.00&cu=INR&tr=ORDCASH9';

/** A viewport that answers `wide` to the QR's query, and no to anything else. */
const viewport = (wide: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: vi.fn((query: string) => ({
      matches: query === WIDE_SCREEN_QUERY ? wide : false,
      media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
};

/** How many dark modules `qrcode` puts in the code for `link`. */
const darkModules = (link: string) => {
  const { modules } = QRCode.create(link, { errorCorrectionLevel: 'M' });
  let n = 0;
  for (let r = 0; r < modules.size; r += 1) for (let c = 0; c < modules.size; c += 1) if (modules.get(r, c)) n += 1;
  return { n, size: modules.size };
};

afterEach(() => { delete (window as { matchMedia?: unknown }).matchMedia; });

describe('the pay link QR', () => {
  it('draws the link as a QR on a wide screen, with a line saying what to do', () => {
    viewport(true);
    render(<PayLinkQr link={LINK} amountLabel="₹1,000" />);
    const svg = screen.getByRole('img', { name: 'QR code to pay ₹1,000 in a UPI app' });
    expect(screen.getByText(/Scan with any UPI app/)).toBeInTheDocument();
    // The encoding of exactly this link: one square per dark module, and the
    // view box is the code plus its quiet zone.
    const { n, size } = darkModules(LINK);
    const d = svg.querySelector('path')?.getAttribute('d') ?? '';
    expect(d.match(/M/g)?.length).toBe(n);
    expect(svg.getAttribute('viewBox')).toBe(`-4 -4 ${size + 8} ${size + 8}`);
    // Drawn, not fetched: no image element anywhere.
    expect(document.querySelector('img')).toBeNull();
  });

  it('a different link draws a different code', () => {
    viewport(true);
    const { container: a } = render(<PayLinkQr link={LINK} amountLabel="₹1,000" />);
    const { container: b } = render(<PayLinkQr link={LINK.replace('1000.00', '5000.00')} amountLabel="₹5,000" />);
    const path = (el: HTMLElement) => el.querySelector('path')?.getAttribute('d');
    expect(path(a)).toBeTruthy();
    expect(path(a)).not.toBe(path(b));
  });

  it('draws nothing on a narrow screen', () => {
    viewport(false);
    const { container } = render(<PayLinkQr link={LINK} amountLabel="₹1,000" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing where the browser cannot answer the question', () => {
    const { container } = render(<PayLinkQr link={LINK} amountLabel="₹1,000" />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ── In the wallet's cash step ──────────────────────────────────────────────
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { get, post } }));
const { default: WalletPage } = await import('../pages/WalletPage');

const CASH_ORDER = {
  orderId: 'ORD-CASH-9', _id: 'ORD-CASH-9', type: 'DEPOSIT', status: 'PROCESSING', currency: 'INR',
  paymentMode: 'CASH_ATM', tokenAmount: 1000, fiatAmount: 1000,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
  payTo: { paymentLink: LINK, merchantRef: 'Merchant #9' },
};

const openWallet = async () => {
  get.mockImplementation((url: string) => {
    if (url === '/api/v1/system/config') return Promise.resolve({ success: true, config: {} });
    if (url.startsWith('/api/payment/orders')) return Promise.resolve({ success: true, orders: [CASH_ORDER] });
    return Promise.resolve({ success: true });
  });
  render(<WalletPage />);
  await screen.findByText('Complete payment');
};

describe('the wallet cash step', () => {
  it('on a laptop or tablet: the PAY NOW link AND the same link as a QR', async () => {
    viewport(true);
    await openWallet();
    const pay = screen.getByRole('link', { name: /in your UPI app/ });
    expect(pay).toHaveAttribute('href', LINK);
    await waitFor(() => expect(screen.getByRole('img', { name: /QR code to pay/ })).toBeInTheDocument());
  });

  it('on a phone: the PAY NOW link only', async () => {
    viewport(false);
    await openWallet();
    expect(screen.getByRole('link', { name: /in your UPI app/ })).toHaveAttribute('href', LINK);
    expect(screen.queryByRole('img', { name: /QR code to pay/ })).toBeNull();
  });
});
