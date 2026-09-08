// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The buy-token payment step: a pre-filled UPI link and a UTR. Nothing else.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 * Two things left this screen.
 *
 * The QR code was rendered by fetching api.qrserver.com — a THIRD PARTY handed
 * the merchant's UPI id, the merchant's name, the exact amount and the order id
 * on every single deposit, as a fallback that fired whenever the local encoder
 * failed to load. A link needs no such request, and works where these players
 * are: tapping it opens their UPI app, which scanning a QR on the same screen
 * cannot do.
 *
 * The screenshot upload proved nothing. It is trivially forged, no approval
 * read it, and the merchant matches the UTR against their own bank statement.
 * Collecting an identifying image that no decision reads is data a platform
 * should not hold — and it was a required field, so a player who could not
 * upload could not tell anyone they had paid.
 *
 * ── What is actually asserted ───────────────────────────────────────────────
 * The link's CONTENTS, field by field. A mistyped amount is the most common
 * cause of a deposit a merchant cannot match, and the whole point of a
 * pre-filled link is that there is nothing left to mistype. A test that only
 * checked "a link is rendered" would pass on a link with no amount in it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { post, get: vi.fn() } }));

import { BuyPaymentUI } from './WalletPage';

const ORDER: any = {
  orderId: 'ORD-77',
  status: 'ASSIGNED',
  fiatAmount: 1500.5,
  tokenAmount: 1500.5,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  merchantSnapshot: { merchantId: 'M1', merchantName: 'Ravi Traders', upiId: 'ravi@okhdfc' },
};

const renderUI = (order: any = ORDER) =>
  render(<BuyPaymentUI order={order} onPaid={vi.fn()} onExpire={vi.fn()} />);

const payLink = () => screen.getByRole('link', { name: /Pay .* in your UPI app/i }) as HTMLAnchorElement;

beforeEach(() => { post.mockReset(); post.mockResolvedValue({ success: true }); });

describe('the minute to fetch the UTR', () => {
  /**
   * The order's own timer IS the UTR deadline. A player who starts entering the
   * reference with seconds left would watch the order expire while they go and
   * read it off their bank app — cancelling a payment they have ALREADY MADE.
   *
   * Touching the field is the "I am entering it now" moment, so it is what
   * claims the window.
   */
  const utrField = () => screen.getByPlaceholderText('Enter after paying');

  it('claims the window when the player starts entering the reference', async () => {
    post.mockResolvedValue({
      success: true,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    renderUI();
    fireEvent.focus(utrField());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/order/ORD-77/utr-grace', {}));
  });

  it('tells the screen above, so the countdown stops running to the old deadline', async () => {
    const extended = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    post.mockResolvedValue({ success: true, expiresAt: extended });
    const onExpiryExtended = vi.fn();
    render(<BuyPaymentUI order={ORDER} onPaid={vi.fn()} onExpire={vi.fn()} onExpiryExtended={onExpiryExtended} />);

    fireEvent.focus(screen.getByPlaceholderText('Enter after paying'));
    // Without this the countdown keeps running to the OLD deadline and expires
    // an order the server has just extended — on screen only, which is worse
    // than not extending at all: the player abandons a live payment.
    await waitFor(() => expect(onExpiryExtended).toHaveBeenCalledWith(extended));
    expect(screen.getByText('Extra time added to submit your UTR.')).toBeTruthy();
  });

  it('asks once, however many times the field is touched', async () => {
    post.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    renderUI();
    const field = utrField();
    fireEvent.focus(field);
    fireEvent.blur(field);
    fireEvent.focus(field);
    fireEvent.focus(field);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it('says nothing when the deadline did not actually move', async () => {
    // An order with plenty of time left gets no extension — the deadline only
    // moves outward — and announcing "extra time added" when nothing changed
    // would be a lie the player might act on.
    post.mockResolvedValue({ success: true, expiresAt: ORDER.expiresAt });
    renderUI();
    fireEvent.focus(utrField());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.queryByText('Extra time added to submit your UTR.')).toBeNull();
  });

  it('stays silent when the claim fails — nothing was lost', async () => {
    // The player has exactly the deadline they already had, and an error at the
    // moment they are trying to type a reference is alarming noise.
    post.mockRejectedValue(new Error('Network down'));
    renderUI();
    fireEvent.focus(utrField());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.queryByText(/Network down/)).toBeNull();
    expect(screen.queryByText('Extra time added to submit your UTR.')).toBeNull();
  });
});

describe('the buy-token payment step', () => {
  it('builds a upi:// link with every field the payment needs', async () => {
    renderUI();
    const href = payLink().href;
    const url = new URL(href.replace('upi://', 'https://'));

    expect(href.startsWith('upi://pay?')).toBe(true);
    expect(url.searchParams.get('pa')).toBe('ravi@okhdfc');       // payee
    expect(url.searchParams.get('pn')).toBe('Ravi Traders');      // payee name
    expect(url.searchParams.get('cu')).toBe('INR');
    expect(url.searchParams.get('tn')).toBe('BettingBazaar-ORD-77'); // the note the merchant matches
  });

  it('fixes the amount to two decimals', () => {
    // UPI apps reject an amount with more, and `fiatAmount` arithmetic produces
    // exactly that: 1500.50000000000001 and the like.
    renderUI({ ...ORDER, fiatAmount: 1500.50000000000001 });
    const url = new URL(payLink().href.replace('upi://', 'https://'));
    expect(url.searchParams.get('am')).toBe('1500.50');
  });

  it('sends nothing to a third-party QR service', () => {
    // The old fallback fetched api.qrserver.com with the merchant's UPI id, the
    // amount and the order id in the query string, on every deposit.
    const { container } = renderUI();
    expect(container.innerHTML).not.toContain('qrserver');
    expect(container.querySelector('img[alt*="QR" i]')).toBeNull();
  });

  it('submits the UTR alone', async () => {
    renderUI();
    fireEvent.change(screen.getByPlaceholderText(/Enter after paying/), { target: { value: 'UTR123456789012' } });
    fireEvent.click(screen.getByRole('button', { name: /I've Paid/ }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/payment/order/ORD-77/mark-paid');
    // Exactly one key. A screenshot field would mean the upload came back.
    expect(Object.keys(body)).toEqual(['utrNumber']);
    expect(body.utrNumber).toBe('UTR123456789012');
  });

  it('offers no file input at all', () => {
    // The upload was REQUIRED: a player who could not upload could not tell
    // anyone they had paid.
    const { container } = renderUI();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/screenshot/i)).toBeNull();
  });

  it('enables the submit on a valid UTR with no other condition', async () => {
    renderUI();
    const button = screen.getByRole('button', { name: /I've Paid/ }) as HTMLButtonElement;
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Enter after paying/), { target: { value: 'SHORT' } });
    expect(button).toBeDisabled();  // under 12 characters

    fireEvent.change(screen.getByPlaceholderText(/Enter after paying/), { target: { value: 'UTR123456789012' } });
    expect(button).toBeEnabled();
  });

  it('keeps the merchant UPI id visible and copyable', async () => {
    // A handset with no UPI app registered for the link still has to be able to
    // pay, and support asks for this when a payment goes missing.
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    renderUI();

    expect(screen.getByText('ravi@okhdfc')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('ravi@okhdfc');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('offers no link at all until a merchant is assigned', () => {
    // A `upi://pay?pa=undefined` link takes a player to a payment they cannot
    // make, and the money would go nowhere recoverable.
    renderUI({ ...ORDER, merchantSnapshot: null });
    expect(screen.queryByRole('link', { name: /UPI app/i })).toBeNull();
    expect(screen.getByText(/Waiting for merchant details/)).toBeInTheDocument();
  });

  it('surfaces a rejected claim instead of pretending it landed', async () => {
    post.mockRejectedValue({ message: 'This UTR was already used. Contact support.' });
    renderUI();
    fireEvent.change(screen.getByPlaceholderText(/Enter after paying/), { target: { value: 'UTR123456789012' } });
    fireEvent.click(screen.getByRole('button', { name: /I've Paid/ }));

    expect(await screen.findByText(/already used/)).toBeInTheDocument();
    // Still submittable, so a player who mistyped can correct it.
    expect(screen.getByRole('button', { name: /I've Paid/ })).toBeEnabled();
  });
});

describe('the ATM cash rail', () => {
  /**
   * ── Two states that must not look alike ──────────────────────────────────
   * On this rail an order exists BEFORE any merchant has reached a machine, so
   * there is a real period with no link. Rendering the payment screen with an
   * empty link would show a "pay now" affordance that does nothing — the
   * empty-state-as-success failure this codebase has shipped repeatedly, where
   * a request fails, a component catches it, and the screen looks like "no
   * data".
   *
   * And when a link DOES arrive it must be used verbatim. It is what the ATM
   * agreed to dispense; building anything from it would change the amount the
   * machine is holding.
   */
  const CASH_ORDER: any = {
    orderId: 'ORD-CASH-1',
    status: 'ASSIGNED',
    fiatAmount: 5000,
    tokenAmount: 5000,
    paymentMode: 'CASH_ATM',
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    // Deliberately present: on the cash rail this must be IGNORED. Falling
    // back to a merchant UPI intent would send the player to pay a person
    // instead of the machine that is holding their cash.
    merchantSnapshot: { upiId: 'merchant@bank', merchantName: 'Someone' },
  };

  it('says a machine is being found, rather than showing a dead pay screen', () => {
    render(<BuyPaymentUI order={CASH_ORDER} cashLink={null} onPaid={() => {}} onExpire={() => {}} />);
    expect(screen.getByText(/Finding you a machine/i)).toBeInTheDocument();
    // No UTR field yet: there is nothing to have paid.
    expect(screen.queryByPlaceholderText(/UTR/i)).not.toBeInTheDocument();
  });

  it('uses the ATM link verbatim, and never the merchant UPI intent', () => {
    const atmLink = 'upi://pay?pa=atm-issuer&am=5000.00&tn=ATM-REF-99';
    render(
      <BuyPaymentUI
        order={CASH_ORDER}
        cashLink={{ paymentLink: atmLink, expiresAt: CASH_ORDER.expiresAt }}
        onPaid={() => {}}
        onExpire={() => {}}
      />,
    );
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === atmLink);
    expect(link).toBeTruthy();
    // The merchant's own UPI id must appear nowhere: the player pays the
    // machine, and never learns who the merchant is.
    expect(document.body.innerHTML).not.toContain('merchant@bank');
  });
});

