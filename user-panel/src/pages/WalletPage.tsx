// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * WalletPage.tsx — 2026 "Bazaar" redesign.
 *
 * P2P token exchange (fixed 1:1, 1 BB token = ₹1). The data layer is UNCHANGED —
 * every apiClient endpoint, the order state machine, polling, the UPI link and UTR flow
 * and dispute handling are preserved exactly. Only the presentation is rebuilt on
 * the redesign theme tokens (dark/light) to match the handoff prototype.
 *
 * GOVERNANCE §1: no USDT sell rail exists for users — the "pay with" rail is UPI
 * (INR) only. Token conversion is the fixed 1:1 constant (Phase 006).
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import apiClient from '../services/apiClient';
import { PAYMENT_STATE_LABELS, PAYMENT_STATE_COLOR, isActive, type PaymentOrderState } from '../services/paymentStateMachine';
// M-05: WalletTransactionDTO normalizer — GOVERNANCE §4: this module must have consumers.
import { normalizeTransaction } from '../services/walletTransactionDTO';
import ScreenShell, { card, capLabel } from '../redesign/Screen';
// A cash withdrawal too large for one denomination becomes several separate
// withdrawals. This shows a player which ones came from the same request.
import WithdrawalBatchParts from '../components/WithdrawalBatchParts';
// The USDT rail: two fixed amounts, served by a merchant, on the network the
// player chooses.
import UsdtBuyPanel from '../components/UsdtBuyPanel';

// ── Types ──────────────────────────────────────────────────────────────────────
interface Balances { depositBalance: number; winningsBalance: number; lockedBalance: number; reserveBalance: number; }

/**
 * What the server says this wallet can actually stake right now.
 *
 * Fetched rather than computed here on purpose. The reserve is not freely
 * spendable — only `reservePercent` of a stake may come from it — so the
 * ceiling is a money rule, and a second copy of it in the panel would drift
 * from the one bet.routes enforces. GET /api/user/bet-limits runs the same
 * function the bet route does.
 */
interface BetLimits {
  maxStake: number;
  reservePercent: number;
  reserveLocked: number;
  total: number;
}
// `txId`, which is what the server sends (backend/domains/wallet/playerLedgerView.js).
// This named `_id`, which it never has, so every row's React key was undefined (§23).
interface LedgerEntry { txId: string; type: string; field: string; amount: number; balanceBefore: number; balanceAfter: number; reason: string; createdAt: string; }
// A credit the player received outside an order — today, a credit from support.
// The shape is `toPlayerBonus` in playerLedgerView.js; the admin's note is never in it.
interface BonusRecord { bonusId: string; type: string; label: string; amount: number; createdAt: string; }
interface PaymentOrder {
  _id: string; orderId: string; type: 'DEPOSIT' | 'WITHDRAWAL'; status: string;
  tokenAmount: number; fiatAmount: number; rateUsed: number; createdAt: string;
  expiresAt?: string; paidAt?: string;
  /**
   * Where to pay, and nothing about who is being paid.
   *
   * This was `merchantSnapshot`, which carried the merchant's UPI handle, their
   * QR, and their bank account number, IFSC and account-holder name. A field the
   * panel's type names is a field somebody will render — and this one was
   * rendered, with a Copy button. The server sends `payTo` now:
   * backend/domains/payment/playerOrderView.js is the only shape a player gets.
   */
  payTo?: { paymentLink?: string; merchantRef?: string; expiresAt?: string } | null;
  utrNumber?: string; proofScreenshot?: string;
  // The rail this order runs on, stamped by the server at creation from the
  // order's own size and currency (`paymentModeFor`, database/repositories/
  // orderRails.js) and frozen by trigger. There is no platform-wide switch, so
  // this — never the current config — is what decides how an EXISTING order is
  // rendered: a ₹5,000 buy placed before an operator changed anything is still
  // the cash order it was created as.
  paymentMode?: 'P2P_UPI' | 'CASH_ATM';
  // What the order settles in. A USDT buy is drawn by `UsdtBuyPanel`, never by
  // the INR payment step, whose "Pay ₹…" would name 500 USDT as ₹500 (trap 15).
  currency?: 'INR' | 'USDT';
  // The label grouping the separate withdrawals that came from one request.
  // Null on an ordinary withdrawal, so the expander only appears where there is
  // something to expand. It is a LABEL: nothing here decides anything by it.
  withdrawalBatchRef?: string | null;
  userBankDetails?: { accountNumber?: string; ifscCode?: string; bankName?: string; accountHolderName?: string; };
  // No `upiId` and no `cashLinkId`. The first is in PLAYER_FORBIDDEN_ORDER_FIELDS
  // and the server has never sent it to a player; the second named the cash-link
  // queue, which was removed with its routes (§23 — a type naming a field the
  // server never sends typechecks every read and is `undefined` at runtime).
}
interface UserProfile {
  id: string; username: string;
  bankDetails?: { upiId?: string; accountNumber?: string; ifscCode?: string; bankName?: string; accountHolderName?: string; };
}
type TabKey = 'exchange' | 'ledger' | 'bonuses' | 'payments';
type BuyStep = 'amount' | 'pay_now' | 'waiting';
type SellStep = 'amount' | 'waiting';

// ── Helpers ────────────────────────────────────────────────────────────────────
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const fmtINR = (n: number) => `₹${r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
// NOTE THE UNIT: this appends " T" itself, so a caller must never add another.
// Two did — the max-stake tile and the reserve-locked sentence — and both
// rendered "1,000 T T" to the player. Named for what it returns, not for the
// number it takes, so the next caller sees it.
const fmtT = (n: number) => `${r2(n).toLocaleString('en-IN')} T`;
const fmtDate = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const STATE_HEX: Record<string, string> = { yellow: 'var(--gold-ink)', blue: 'var(--bombay)', green: 'var(--green)', red: 'var(--red)', orange: '#FB8C00' };
function statusChip(status: string): React.CSSProperties {
  const col = STATE_HEX[PAYMENT_STATE_COLOR[status as PaymentOrderState] ?? 'yellow'] ?? 'var(--gold-ink)';
  return { fontSize: 9, fontWeight: 800, letterSpacing: '.06em', padding: '4px 10px', borderRadius: 999, color: col, background: `color-mix(in srgb, ${col} 16%, transparent)` };
}

const inputBox: React.CSSProperties = { width: '100%', height: 48, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '0 15px', color: 'var(--text)', fontSize: 15, fontWeight: 700, outline: 'none' };

// ── CountdownTimer ──────────────────────────────────────────────────────────────
function CountdownTimer({ expiresAt, onExpire }: { expiresAt?: string; onExpire?: () => void }) {
  const [timeLeft, setTimeLeft] = useState(0);
  const firedRef = useRef(false);
  useEffect(() => {
    if (!expiresAt) return;
    const update = () => {
      const left = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      setTimeLeft(left);
      if (left === 0 && !firedRef.current) { firedRef.current = true; onExpire?.(); }
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpire]);
  if (!expiresAt) return null;
  const m = Math.floor(timeLeft / 60000);
  const s = Math.floor((timeLeft % 60000) / 1000);
  const urgent = timeLeft < 5 * 60 * 1000 && timeLeft > 0;
  return (
    <span className="font-grotesk" style={{ color: urgent ? 'var(--red)' : 'var(--gold-ink)', fontWeight: 800, fontSize: 12 }}>
      {timeLeft === 0 ? '⏰ Expired' : `⏱ ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`}
    </span>
  );
}

// ── Buy Payment UI (restyled; logic unchanged) ──────────────────────────────────
/**
 * Exported for its own test. The buy flow is where a player's money leaves the
 * platform's sight, and it had no coverage while it collected a screenshot no
 * decision read and rendered a QR through a third-party service.
 */
export function BuyPaymentUI({ order, onPaid, onExpire, onExpiryExtended }: {
  order: PaymentOrder;
  /**
   * The server accepted the payment report. Handed what it now says about the
   * order — its own response when it sent one — so the screen above moves on
   * from the facts, not from a guess: on the cash rail the tap leaves the order
   * PAID with no reference, which is exactly the state that asks for one.
   */
  onPaid: (patch: Partial<PaymentOrder>) => void;
  onExpire: () => void;
  /**
   * The server granted the player extra time to submit their UTR, and the
   * deadline moved. The screen above owns the order, so it is the one that has
   * to hear about it — a countdown still running on the old deadline would
   * expire the order on screen while the server considers it live.
   */
  onExpiryExtended?: (expiresAt: string) => void;
}) {
  // Where to pay, and nothing about who is being paid. `payTo` carries a
  // per-order payment link, an opaque reference and the deadline — see
  // backend/domains/payment/playerOrderView.js.
  const payTo = order.payTo;
  // The ORDER's rail, stamped at creation — never the amount re-judged here and
  // never anything in the current config. See `PaymentOrder.paymentMode`.
  const onCashRail = order.paymentMode === 'CASH_ATM';
  const [utr, setUtr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [disputeVisible, setDisputeVisible] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  /**
   * The link this player pays. Handed over by the server, never assembled here.
   *
   * ── Why this stopped being built on the client ────────────────────────────
   * It used to be constructed from `merchantSnapshot.upiId` and
   * `merchantSnapshot.merchantName`, which meant the panel had to be GIVEN the
   * merchant's UPI handle — and the response that carried it also carried their
   * QR, their bank account number, their IFSC and the name on the account. A
   * player could read and keep all of it from one deposit, and the row below
   * used to put the handle on screen with a Copy button.
   *
   * Now the server builds the intent (backend/domains/payment/paymentLink.js)
   * and sends only the link, so the panel has nothing to build it from. That is
   * what makes "a player never sees the merchant's details" true rather than a
   * thing the screen politely refrains from rendering.
   *
   * The amount formatting moved with it, which is the other half: `am` must be
   * two decimals or a UPI app rejects it, and `fiatAmount` arithmetic produces
   * floats like 100.10000000000001. That belongs on the side an attacker
   * holding the handset cannot edit.
   *
   * ONE source on both rails. The cash rail used to read a second link, from a
   * queue of links merchants supplied at a machine; that queue and its routes
   * are gone, and a cash order is paid to the link in `payTo` that the server
   * builds for the member serving it — used verbatim, like every other.
   */
  const intentString = payTo?.paymentLink ?? '';

  useEffect(() => {
    if (order.status === 'PAID' && order.paidAt) {
      const elapsed = Date.now() - new Date(order.paidAt).getTime();
      if (elapsed >= 10 * 60 * 1000) setDisputeVisible(true);
    }
  }, [order.status, order.paidAt]);

  /**
   * On the CASH rail the payment and the reference are TWO steps.
   *
   * The merchant is standing at an ATM whose session times out. Making them
   * wait while the player reads a twelve-character reference off a banking app
   * loses the machine, so the tap is what reaches PAID and unblocks them, and
   * the reference follows. `awaitingReference` is that in-between state: paid,
   * not yet evidenced, and the merchant's Confirm refuses until it is.
   *
   * On every other rail there is no machine and no clock, so the reference is
   * still submitted with the payment — one step, as before.
   */
  const awaitingReference = onCashRail && order.status === 'PAID' && !order.utrNumber;
  const tapToPay = onCashRail && order.status !== 'PAID';

  /** "I have paid" — the CASH tap. No reference yet, deliberately. */
  const handleTapPaid = async () => {
    setSubmitting(true); setError('');
    try {
      const res: any = await apiClient.post(`/api/payment/order/${order.orderId}/mark-paid`, {});
      // The server's order when it sent one; it says PAID with no reference.
      onPaid({ status: 'PAID', ...(res?.order ?? {}) });
    } catch (err: any) { setError(err?.message || 'Failed to submit. Try again.'); }
    finally { setSubmitting(false); }
  };

  const handleSubmitPayment = async () => {
    if (utr.trim().length < 12) { setError('UTR must be at least 12 characters'); return; }
    setSubmitting(true); setError('');
    try {
      // The UTR alone. A screenshot proved nothing — trivially forged, read by
      // no approval, and the merchant matches this reference against their own
      // bank statement.
      //
      // Two routes, because they are two different things: `mark-paid` reports
      // the payment, `payment-reference` evidences one already reported. On the
      // cash rail the order is already PAID by the time this runs.
      //
      // Written out rather than interpolated. `${order.orderId}/${path}` is one
      // string to a reader and TWO unresolvable segments to
      // `check:ui-coverage`, which reported it as a dead button — correctly,
      // since a gate that cannot see which route a call reaches cannot tell you
      // the route exists (§28).
      const res: any = awaitingReference
        ? await apiClient.post(`/api/payment/order/${order.orderId}/payment-reference`, { utrNumber: utr.trim() })
        : await apiClient.post(`/api/payment/order/${order.orderId}/mark-paid`, { utrNumber: utr.trim() });
      // The reference is on the order now. Without it the cash rail would read
      // as still awaiting one until the next status poll.
      onPaid({ status: 'PAID', utrNumber: utr.trim(), ...(res?.order ?? {}) });
    } catch (err: any) { setError(err?.message || 'Failed to submit. Try again.'); }
    finally { setSubmitting(false); }
  };

  /**
   * Ask for the minute, once.
   *
   * `asked` is a local guard against re-firing on every focus, not the rule —
   * the rule is the server's, decided in one statement, because a client-side
   * flag is not something a merchant's held capacity should depend on.
   *
   * A failure is SILENT on purpose. The player has not lost anything they had:
   * the deadline is whatever it already was, the countdown on screen is still
   * driven by the order, and an error toast here would be alarming noise at the
   * exact moment they are trying to type a reference.
   */
  const askedForGrace = useRef(false);
  const [graceNote, setGraceNote] = useState('');
  const claimGrace = async () => {
    if (askedForGrace.current) return;
    askedForGrace.current = true;
    try {
      const res: any = await apiClient.post(`/api/payment/order/${order.orderId}/utr-grace`, {});
      if (res?.expiresAt && new Date(res.expiresAt).getTime() > new Date(order.expiresAt || 0).getTime()) {
        setGraceNote('Extra time added to submit your UTR.');
        onExpiryExtended?.(res.expiresAt);
      }
    } catch { /* the deadline is unchanged; the countdown already shows it */ }
  };

  const handleDispute = async () => {
    if (!disputeReason.trim()) { setError('Please enter a dispute reason'); return; }
    try {
      await apiClient.post(`/api/payment/order/${order.orderId}/dispute`, { reason: disputeReason.trim() });
      alert('Dispute raised. Admin will review shortly.');
    } catch (err: any) { setError(err?.message || 'Failed to raise dispute'); }
  };

  // ── Nobody to pay yet ────────────────────────────────────────────────────
  // An order is created before a member is free to take it, and `payTo` only
  // exists once one has. Until then there is nothing the player CAN have paid,
  // so neither rail offers the controls that report a payment: on the cash rail
  // the "I've paid" tap would mark PAID a payment nobody could receive, and on
  // the UPI rail a UTR field invites a reference for a transfer to no one. Say
  // what is actually happening instead (§32 S22 — a control that does nothing).
  if (!intentString && order.status !== 'PAID') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div role="status" style={{ textAlign: 'center', padding: '12px 8px' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
          <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>
            Waiting for merchant details…
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.5, margin: '6px 0 0' }}>
            A merchant is being assigned to your {fmtINR(order.fiatAmount)} purchase. The link to pay
            appears here the moment one is — there is nothing to pay until then.
          </div>
          {order.expiresAt && (
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
              <CountdownTimer expiresAt={order.expiresAt} onExpire={onExpire} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // `awaitingReference` is a PAID order too, so this must not answer for it.
  // It did: this branch sat above the reference step and returned first, so a
  // cash buy tapped as paid showed "Payment submitted" with an empty UTR, the
  // reference field was never reachable, and the merchant's Confirm refused
  // until the sweep sent the order to an admin (§32 S34 — an early return above
  // the question it must not pre-empt).
  if (order.status === 'PAID' && !awaitingReference) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ textAlign: 'center', padding: '12px 8px' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
          <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>Payment submitted</div>
          <div style={{ fontSize: 12, color: 'var(--text3)', margin: '6px 0 4px' }}>UTR <b style={{ color: 'var(--text)' }}>{order.utrNumber}</b></div>
          <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.5 }}>Waiting for the merchant to confirm.<br />Tokens are credited on confirmation.</div>
        </div>
        {disputeVisible && (
          <div style={{ background: 'color-mix(in srgb,#FB8C00 10%,transparent)', border: '1px solid color-mix(in srgb,#FB8C00 30%,transparent)', borderRadius: 12, padding: 12 }}>
            <p style={{ fontSize: 11, color: '#FB8C00', margin: '0 0 8px' }}>Merchant not responding?</p>
            <input value={disputeReason} onChange={e => setDisputeReason(e.target.value)} placeholder="Describe the issue" style={{ ...inputBox, height: 42, fontSize: 13, fontWeight: 400, marginBottom: 8 }} />
            <button onClick={handleDispute} style={{ width: '100%', background: '#FB8C00', color: '#1a1200', fontWeight: 800, padding: 10, borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13 }}>Raise Dispute</button>
          </div>
        )}
        {error && <p style={{ color: 'var(--red)', fontSize: 11, textAlign: 'center' }}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: 'color-mix(in srgb,var(--gold) 10%,var(--surface2))', border: '1px solid var(--line2)', borderRadius: 12, padding: 12, textAlign: 'center' }}>
        {awaitingReference ? (
          // Already paid — the cash tap was made. Asking them to "pay exactly"
          // again, with the link, is an invitation to pay twice. And no
          // countdown: a PAID order is not expired by its window, so a timer
          // reaching zero here would close a screen that is still owed a UTR.
          <>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700 }}>You reported paying</div>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 26, color: 'var(--gold-ink)' }}>{fmtINR(order.fiatAmount)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>add the UTR below to receive {fmtT(order.tokenAmount)}</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700 }}>Pay exactly</div>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 26, color: 'var(--gold-ink)' }}>{fmtINR(order.fiatAmount)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>to receive {fmtT(order.tokenAmount)} · <CountdownTimer expiresAt={order.expiresAt} onExpire={onExpire} /></div>
          </>
        )}
      </div>

      {/* Past the two early returns above, a link exists unless the reference
          is what is owed — and then the payment has already been made, so the
          link is not offered again. */}
      {!awaitingReference && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <a href={intentString} style={{ width: '100%', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', color: '#1a1200', fontWeight: 800, padding: '15px 12px', borderRadius: 13, fontSize: 15, textAlign: 'center', display: 'block', textDecoration: 'none' }}>
            Pay {fmtINR(order.fiatAmount)} in your UPI app
          </a>
          <p style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
            Opens with the amount already filled in. Come back with the UTR.
          </p>
          {/* ── The merchant's UPI row is GONE, and this is why ────────────
              It rendered `Merchant UPI · <name>` with the handle underneath and
              a Copy button. The comment that used to be here argued it was
              needed on the UPI rail as a fallback and for support — and it is
              the exact thing the privacy rule forbids in the other direction: a
              player is not to learn who they are paying.

              The response it read from carried more than the handle. It carried
              the merchant's QR, their bank account number, their IFSC and the
              name on the account, on every deposit, and the player could read
              and keep all of it. That is now stripped server-side by
              `playerOrderView.js`, so there is nothing left here to render even
              if somebody added the markup back.

              What honestly remains: tapping the link opens the player's own UPI
              app, which shows them the payee it is about to pay. That is the UPI
              protocol, not this screen — and it is a very different thing from
              handing them an account number to keep. */}
        </div>
      )}

      {/* While the cash tap is all that is being asked for, the reference field
          is not on screen: showing an input the player cannot fill yet — they
          are at the machine — is what makes them hunt for a number instead of
          pressing the button that frees the merchant. It appears once the
          order is PAID and the reference is what is actually owed. */}
      {tapToPay ? (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: 12, fontSize: 11.5, color: 'var(--text2)' }}>
          This is a cash purchase: the merchant is at a cash machine. Press
          this as soon as you have paid — they need to know now so they can
          finish at the ATM. We will ask for the reference next.
        </div>
      ) : (
      <div>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 6 }}>UTR / UPI Ref No. <span style={{ color: 'var(--text3)', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>(min 12 chars)</span></label>
        <input
          value={utr}
          onChange={e => setUtr(e.target.value)}
          /* ── Claiming the minute to fetch the reference ──────────────────
             The order's own timer IS the UTR deadline, so a player who starts
             entering the reference with seconds left would watch the order
             expire while they go and read it off their bank app — cancelling a
             payment they have already made.

             Touching this field is the "I am entering it now" moment, so it is
             what claims the window. Safe to fire on every focus: the server
             grants it ONCE and only ever moves the deadline outward, so a
             re-focus is a refusal that changes nothing. */
          onFocus={() => { void claimGrace(); }}
          placeholder="Enter after paying"
          className="font-grotesk"
          style={{ ...inputBox, height: 44, fontSize: 13 }}
        />
        {utr.length > 0 && utr.length < 12 && <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 700 }}>{12 - utr.length} more characters needed</span>}
        {graceNote && <span style={{ fontSize: 10.5, color: 'var(--green)', fontWeight: 700 }}>{graceNote}</span>}
        {awaitingReference && (
          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text3)', marginTop: 4 }}>
            The merchant has been told you paid. They cannot release your tokens
            until this reference arrives.
          </span>
        )}
      </div>
      )}

      {error && <p style={{ color: 'var(--red)', fontSize: 11, textAlign: 'center' }}>{error}</p>}

      <button onClick={tapToPay ? handleTapPaid : handleSubmitPayment}
        disabled={submitting || (!tapToPay && utr.trim().length < 12)}
        style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: (tapToPay || utr.trim().length >= 12) ? '#1a1200' : 'var(--text3)', background: (tapToPay || utr.trim().length >= 12) ? 'linear-gradient(135deg,var(--gold2),var(--gold))' : 'var(--surface3)' }}>
        {submitting ? '⏳ Submitting…'
          : tapToPay ? "✅ I've Paid — tell the merchant"
          : awaitingReference ? '✅ Submit reference'
          : "✅ I've Paid"}
      </button>
    </div>
  );
}

// ── Main WalletPage ───────────────────────────────────────────────────────────
const WalletPage: React.FC = () => {
  const [balances, setBalances]         = useState<Balances>({ depositBalance: 0, winningsBalance: 0, lockedBalance: 0, reserveBalance: 0 });
  const [limits, setLimits]             = useState<BetLimits | null>(null);
  const [userProfile, setUserProfile]   = useState<UserProfile | null>(null);
  const [ledger, setLedger]             = useState<LedgerEntry[]>([]);
  const [paymentOrders, setPaymentOrders] = useState<PaymentOrder[]>([]);
  // Which split withdrawal, if any, has its parts open. One at a time — a
  // player is looking at one withdrawal, and every list open at once is noise.
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [tab, setTab]                   = useState<TabKey>('exchange');
  const [side, setSide]                 = useState<'buy' | 'sell'>('buy');
  const [loading, setLoading]           = useState(true);
  const [ledgerPage, setLedgerPage]     = useState(1);
  const [hasMore, setHasMore]           = useState(true);
  const [bonuses, setBonuses]           = useState<BonusRecord[]>([]);
  const [bonusTotal, setBonusTotal]     = useState(0);
  const [bonusPage, setBonusPage]       = useState(1);
  const [bonusState, setBonusState]     = useState<'loading' | 'ready' | 'error'>('loading');

  const [buyStep, setBuyStep]           = useState<BuyStep>('amount');
  const [buyTokens, setBuyTokens]       = useState('');
  // What the SERVER says is buyable. Never a list written here: the app ships
  // as an APK containing this bundle, so a client-side list is one an attacker
  // can edit — and one that drifts from the gate is a player offered an amount
  // that will be refused.
  //
  // There is no platform-wide rail in it. A buy's rail follows from its own
  // size: up to `maxCashBuy` it is a cash order and must be one of
  // `buyDenominations`; above it, UPI/bank (backend/domains/configuration/
  // systemConfigPayload.js, the same rule `paymentModeFor` stamps the order with).
  const [rail, setRail]                 = useState<{
    buyDenominations: number[];
    /** The largest buy paid in cash. Null until the config has loaded. */
    maxCashBuy: number | null;
    // The USDT rail's two amounts and the networks it is served on. From the
    // server, for the same reason the INR denominations are: both are money
    // rules, and a panel holding its own copy offers what the gate refuses.
    usdtBuyDenominations: number[];
    /** How many tokens one USDT buys. Null until an admin sets a rate. */
    usdtTokensPerUnit: number | null;
    usdtChains: { chain: string; label: string }[];
  }>({
    buyDenominations: [], maxCashBuy: null,
    usdtBuyDenominations: [], usdtTokensPerUnit: null, usdtChains: [],
  });
  const [activeBuyOrder, setActiveBuyOrder] = useState<PaymentOrder | null>(null);
  const [buyLoading, setBuyLoading]     = useState(false);
  const [buyError, setBuyError]         = useState('');

  const [sellStep, setSellStep]         = useState<SellStep>('amount');
  const [sellTokens, setSellTokens]     = useState('');
  const [activeSellOrder, setActiveSellOrder] = useState<PaymentOrder | null>(null);
  const [sellLoading, setSellLoading]   = useState(false);
  const [sellError, setSellError]       = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMeta = useCallback(async () => {
    try {
      const prof: any = await apiClient.get('/api/v1/user/profile');
      const u = prof?.user;
      if (u) {
        setUserProfile({ id: u._id || u.id, username: u.username || u.mobile || 'User', bankDetails: u.bankDetails });
      }

      // Balances come from the LIMITS endpoint, not the profile: it reads all
      // four pockets straight from the wallet and returns the stake ceiling
      // computed by the same rule the bet route enforces. Taking the numbers
      // and the ceiling from one response also means they cannot disagree with
      // each other on screen.
      // The amounts each rail allows, from the one payload that owns them
      // (domains/configuration/systemConfigPayload.js).
      const sys: any = await apiClient.get('/api/v1/system/config');
      if (sys?.config) {
        setRail({
          buyDenominations: sys.config.buyDenominations ?? [],
          maxCashBuy: sys.config.maxCashBuy ?? null,
          usdtBuyDenominations: sys.config.usdtBuyDenominations ?? [],
          usdtTokensPerUnit: sys.config.usdtTokensPerUnit ?? null,
          usdtChains: sys.config.usdtChains ?? [],
        });
      }

      const lim: any = await apiClient.get('/api/user/bet-limits');
      if (lim?.success) {
        setBalances({
          depositBalance: lim.deposit ?? 0, winningsBalance: lim.winnings ?? 0,
          lockedBalance: lim.locked ?? 0, reserveBalance: lim.reserve ?? 0,
        });
        setLimits({
          maxStake: lim.maxStake ?? 0,
          reservePercent: lim.reservePercent ?? 0,
          reserveLocked: lim.reserveLocked ?? 0,
          total: lim.total ?? 0,
        });
      }
    } catch (err: unknown) { console.error('[WalletPage/loadMeta]', err instanceof Error ? err.message : err); }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const res: any = await apiClient.get('/api/payment/orders?limit=20');
      const orders = Array.isArray(res?.orders) ? res.orders : [];
      setPaymentOrders(orders);
      // An INR buy only. A USDT buy in flight is `activeUsdtOrder`, drawn by
      // UsdtBuyPanel; taken here it replaced that panel with the INR payment
      // step, which named the USDT amount in rupees and offered no address.
      const activeDeposit = orders.find((o: PaymentOrder) => o.type === 'DEPOSIT' && o.currency !== 'USDT' && ['ASSIGNED', 'PROCESSING', 'PAID'].includes(o.status));
      const activeWithdrawal = orders.find((o: PaymentOrder) => o.type === 'WITHDRAWAL' && ['ASSIGNED', 'PROCESSING', 'PAID'].includes(o.status));
      if (activeDeposit && buyStep === 'amount') { setActiveBuyOrder(activeDeposit); setBuyStep('pay_now'); setSide('buy'); }
      if (activeWithdrawal && sellStep === 'amount') { setActiveSellOrder(activeWithdrawal); setSellStep('waiting'); setSide('sell'); }
    } catch (err: unknown) { console.error('[WalletPage/loadOrders]', err instanceof Error ? err.message : err); }
  }, [buyStep, sellStep]);

  const loadLedger = useCallback(async (pg: number, reset = false) => {
    setLoading(true);
    try {
      const res: any = await apiClient.get(`/api/v1/wallet/ledger?page=${pg}&limit=25`);
      // M-05: DTO normalizer is the canonical shape; we validate each row through
      // it (single consumer) but render the raw CREDIT/DEBIT ledger fields, which
      // carry the +/− sign the DTO flattens away.
      const items: LedgerEntry[] = Array.isArray(res?.entries)
        ? res.entries.filter((e: any) => { normalizeTransaction(e); return true; })
        : [];
      setLedger(prev => reset ? items : [...prev, ...items]);
      setHasMore(items.length === 25);
    } catch (err: unknown) { console.error('[WalletPage/loadLedger]', err instanceof Error ? err.message : err); }
    finally { setLoading(false); }
  }, []);

  /**
   * Credits from support, newest first (`GET /api/bonuses/my`). The route was
   * built and no screen called it (route coverage, 2026-10-01). A failed load
   * says so rather than showing "none", which would be a refusal read as a fact.
   */
  const loadBonuses = useCallback(async (pg: number, reset = false) => {
    setBonusState('loading');
    try {
      const res: any = await apiClient.get(`/api/bonuses/my?page=${pg}&limit=25`);
      const items: BonusRecord[] = Array.isArray(res?.records) ? res.records : [];
      setBonuses(prev => reset ? items : [...prev, ...items]);
      setBonusTotal(Number(res?.total ?? 0));
      setBonusState('ready');
    } catch (err: unknown) {
      console.error('[WalletPage/loadBonuses]', err instanceof Error ? err.message : err);
      setBonusState('error');
    }
  }, []);

  useEffect(() => { loadMeta(); loadOrders(); }, [loadMeta, loadOrders]);
  useEffect(() => { if (tab === 'ledger') { setLedgerPage(1); loadLedger(1, true); } }, [tab, loadLedger]);
  useEffect(() => { if (tab === 'bonuses') { setBonusPage(1); loadBonuses(1, true); } }, [tab, loadBonuses]);

  useEffect(() => {
    const activeOrderId = activeBuyOrder?.orderId || activeSellOrder?.orderId;
    if (!activeOrderId) { if (pollRef.current) clearInterval(pollRef.current); return; }
    pollRef.current = setInterval(async () => {
      try {
        const res: any = await apiClient.get(`/api/payment/order/${activeOrderId}/status`);
        if (activeBuyOrder) {
          // The poll carries `payTo` on both rails (payment.routes.js, the
          // status route), so a link that arrives after the order — nobody was
          // free when it was created — lands here like any other change.
          setActiveBuyOrder(prev => prev ? { ...prev, ...res } : prev);
          if (res.status === 'COMPLETED') { resetBuy(); loadMeta(); loadOrders(); }
          if (res.status === 'CANCELLED' || res.status === 'FAILED') { resetBuy(); loadOrders(); }
        }
        if (activeSellOrder) {
          setActiveSellOrder(prev => prev ? { ...prev, ...res } : prev);
          if (res.status === 'COMPLETED') { resetSell(); loadMeta(); loadOrders(); }
          if (res.status === 'CANCELLED' || res.status === 'FAILED') { resetSell(); loadOrders(); }
        }
      } catch (_) { /* transient */ }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBuyOrder?.orderId, activeSellOrder?.orderId]);

  const cancelOrder = async (orderId: string) => {
    try { await apiClient.post('/api/payment/order/cancel', { orderId }); loadOrders(); }
    catch (e: any) { alert(e?.message || 'Failed to cancel'); }
  };

  /**
   * Try an order that nobody served, again.
   *
   * The new order goes to the FRONT of the queue. Everything else about it is
   * ordinary — the server runs the same creation path, so the same limit,
   * denomination and escrow rules apply as to a first attempt.
   *
   * The order id is remembered locally so the button disappears immediately
   * rather than waiting for a reload. That is presentation only: the server
   * allows one retry per order and is what actually enforces it.
   */
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retriedAway, setRetriedAway] = useState<string[]>([]);
  const retryOrder = async (orderId: string) => {
    setRetrying(orderId);
    try {
      await apiClient.post(`/api/payment/order/${orderId}/retry`, {});
      setRetriedAway(prev => [...prev, orderId]);
      await loadOrders();
      await loadMeta();
    } catch (e: any) {
      alert(e?.message || 'Could not try that order again');
    } finally {
      setRetrying(null);
    }
  };

  const resetBuy = () => { setBuyStep('amount'); setBuyTokens(''); setActiveBuyOrder(null); setBuyError(''); };
  const handleBuySubmit = async () => {
    const amt = parseInt(buyTokens);
    if (!amt || amt < 1) { setBuyError('Enter a valid token amount'); return; }
    setBuyLoading(true); setBuyError('');
    try {
      const res: any = await apiClient.post('/api/payment/deposit/create', { tokenAmount: amt });
      const order = res?.order;
      if (!order) throw new Error('No order returned');
      setActiveBuyOrder(order); setBuyStep('pay_now'); loadMeta();
    } catch (err: any) { setBuyError(err?.message || 'Failed to create order'); }
    finally { setBuyLoading(false); }
  };

  const resetSell = () => { setSellStep('amount'); setSellTokens(''); setActiveSellOrder(null); setSellError(''); };
  const handleSellSubmit = async () => {
    const amt = parseInt(sellTokens);
    if (!amt || amt < 1) { setSellError('Enter a valid token amount'); return; }
    if (amt > balances.winningsBalance) { setSellError(`Insufficient winnings balance (${fmtT(balances.winningsBalance)} available)`); return; }
    setSellLoading(true); setSellError('');
    try {
      const res: any = await apiClient.post('/api/payment/withdrawal/create', { tokenAmount: amt });
      const order = res?.order;
      if (!order) throw new Error('No order returned');
      setActiveSellOrder({ ...order, userBankDetails: res.order.userBankDetails });
      setSellStep('waiting'); loadMeta();
    } catch (err: any) { setSellError(err?.message || 'Failed to create order'); }
    finally { setSellLoading(false); }
  };

  // What the player OWNS, all four pockets. Distinct from what they can stake
  // right now, which is `limits.maxStake` — conflating the two is the bug this
  // screen exists to stop repeating.
  const total = r2(balances.depositBalance + balances.winningsBalance + balances.reserveBalance);

  // ── Which rail THIS amount is on ─────────────────────────────────────────
  // Derived from the amount, as the server derives it (`paymentModeFor`): up to
  // `maxCashBuy` a buy is a CASH order — served by a merchant at a cash machine,
  // so it must be one of the amounts a machine deals in — and above it a
  // UPI/bank order. The ceiling and the amounts both come from the SERVER; a
  // number written here would be a second owner of a money rule (§3).
  //
  // Null while the config has not loaded, or nothing is typed: the screen then
  // claims no rail at all rather than guessing one, and the server decides.
  const buyAmount = parseInt(buyTokens) || 0;
  const buyRail: 'CASH' | 'UPI' | null = rail.maxCashBuy === null || buyAmount <= 0
    ? null
    : (buyAmount <= rail.maxCashBuy ? 'CASH' : 'UPI');
  // An amount on the cash rail that no machine dispenses. The server refuses it
  // (NOT_A_DENOMINATION), so the button that would send it is not offered, and
  // the sentence below says which amounts are.
  const cashAmountRefused = buyRail === 'CASH' && !rail.buyDenominations.includes(buyAmount);
  const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

  // The USDT purchase in flight, if there is one. Found by CURRENCY on the
  // orders already loaded rather than by a second request: one list, one truth
  // about what this player has open.
  const activeUsdtOrder = paymentOrders.find(
    (o: any) => o.currency === 'USDT' && o.type === 'DEPOSIT'
      && ['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID'].includes(o.status),
  ) ?? null;
  const maxStake = limits?.maxStake ?? 0;
  const reserveLocked = limits?.reserveLocked ?? 0;

  const tabBtn = (k: TabKey, label: string) => (
    <button onClick={() => setTab(k)} aria-pressed={tab === k} style={{ flex: 'none', padding: '9px 16px', borderRadius: 11, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, background: tab === k ? 'var(--gold)' : 'var(--surface3)', color: tab === k ? '#1a1200' : 'var(--text2)' }}>{label}</button>
  );

  return (
    <ScreenShell icon="💳" title="Wallet" sub="Buy & sell tokens · P2P exchange">
      {/* Balance hero */}
      <div style={{ borderRadius: 18, padding: 18, background: 'linear-gradient(135deg,#1a1205,#0c0a06 60%),radial-gradient(120% 140% at 100% 0,rgba(var(--brand-primary-rgb), .25),transparent 55%)', border: '1px solid var(--line2)', boxShadow: 'var(--shadow)', position: 'relative', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', color: '#C9A94A' }}>Token balance</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: '#9c9484', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 999, padding: '3px 9px' }}>1 T = ₹1</span>
        </div>
        <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 38, color: '#F5E6BD', textShadow: '0 2px 20px rgba(var(--brand-primary-rgb), .3)', margin: '2px 0 2px' }}>{r2(total).toLocaleString('en-IN')} <span style={{ fontSize: 20, color: '#C9A94A' }}>T</span></div>

        {/* ── What you can actually stake, stated separately ─────────────────
            The headline above is what the player OWNS. It is not what they can
            bet: only `reservePercent` of a stake may come from the reserve, so
            a wallet holding 1,000 with most of it in reserve may have a
            two-figure ceiling. Showing only the total is what sent players into
            a refused bet and a support ticket. */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#9c9484' }}>Available to bet</span>
          <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: maxStake > 0 ? '#8ff0b6' : '#e08a8a' }}>
            {limits ? fmtT(maxStake) : '—'}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
          <div style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 11, padding: '9px 11px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#9c9484' }}>DEPOSIT</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: '#EAE3CE' }}>{fmtT(balances.depositBalance)}</div></div>
          <div style={{ background: 'rgba(49,196,110,.1)', border: '1px solid rgba(49,196,110,.25)', borderRadius: 11, padding: '9px 11px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#4bd486' }}>WINNINGS</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: '#8ff0b6' }}>{fmtT(balances.winningsBalance)}</div></div>
          {/* Its own tile, never folded into DEPOSIT — they spend differently. */}
          <div style={{ background: 'rgba(120,150,255,.09)', border: '1px solid rgba(120,150,255,.25)', borderRadius: 11, padding: '9px 11px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#93a8f0' }}>RESERVE</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: '#b9c8ff' }}>{fmtT(balances.reserveBalance)}</div></div>
          <div style={{ background: 'rgba(var(--brand-primary-rgb), .1)', border: '1px solid rgba(var(--brand-primary-rgb), .25)', borderRadius: 11, padding: '9px 11px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#e0c060' }}>IN PLAY</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: '#f0d488' }}>{fmtT(balances.lockedBalance)}</div></div>
        </div>

        {/* Only when it actually bites. A player whose reserve is fully usable
            does not need a paragraph explaining a limit they will never hit. */}
        {reserveLocked > 0 && (
          <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 11, background: 'rgba(120,150,255,.07)', border: '1px solid rgba(120,150,255,.18)', fontSize: 11, lineHeight: 1.55, color: '#a9b6e0' }}>
            <strong style={{ color: '#c3cdf5' }}>{fmtT(reserveLocked)}</strong> of your reserve is not available for betting yet.
            Each bet may draw only {limits?.reservePercent}% from reserve — the rest comes from deposit and winnings, so
            adding to your deposit raises this limit.
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="bb-noscroll" style={{ display: 'flex', gap: 8, margin: '14px 0', overflowX: 'auto' }}>
        {tabBtn('exchange', 'Exchange')}
        {tabBtn('ledger', 'History')}
        {tabBtn('bonuses', 'Bonuses')}
        {tabBtn('payments', 'Payment Orders')}
      </div>

      {/* EXCHANGE */}
      {tab === 'exchange' && (
        <>
          <div style={card}>
            <div style={{ display: 'flex', background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: 4, gap: 4, marginBottom: 16 }}>
              <button onClick={() => { setSide('buy'); }} aria-pressed={side === 'buy'} style={{ flex: 1, padding: 11, borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, background: side === 'buy' ? 'linear-gradient(180deg,var(--gold2),var(--gold))' : 'transparent', color: side === 'buy' ? '#1a1200' : 'var(--text2)' }}>⬇️ BUY TOKENS</button>
              <button onClick={() => { setSide('sell'); }} aria-pressed={side === 'sell'} style={{ flex: 1, padding: 11, borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, background: side === 'sell' ? 'linear-gradient(180deg,#8ff0b6,var(--green))' : 'transparent', color: side === 'sell' ? '#052018' : 'var(--text2)' }}>⬆️ SELL TOKENS</button>
            </div>

            {side === 'buy' ? (
              buyStep === 'amount' ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 11, padding: 11, marginBottom: 14 }}>
                    <span style={{ fontSize: 18, color: 'var(--gold-ink)' }}>📲</span>
                    <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>INR · paid from your UPI app</span><span style={{ fontSize: 9, color: 'var(--text3)' }}>A verified merchant is assigned to every order</span></span>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 9 }}>Tokens to buy</div>
                  {/* ── Two rails, chosen by the amount ─────────────────────
                      Up to the cash ceiling a buy is served by a merchant at a
                      cash machine, which dispenses one of a fixed set — so the
                      tiles offer exactly those, from the SERVER's list. Above
                      the ceiling a buy is UPI/bank and any amount within the
                      deposit limits is fine, so it is typed.

                      Both are on screen at once rather than behind a switch: a
                      player does not pick a rail, they pick an amount, and the
                      sentence under the field says which rail that amount is. */}
                  {rail.buyDenominations.length > 0 && rail.maxCashBuy !== null && (
                    <>
                      <div id="buy-cash-amounts" style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                        Cash amounts, up to {rupees(rail.maxCashBuy)}
                      </div>
                      <div role="radiogroup" aria-labelledby="buy-cash-amounts" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 10 }}>
                        {rail.buyDenominations.map((amount) => {
                          const on = buyTokens === String(amount);
                          return (
                            <button
                              key={amount} type="button" role="radio" aria-checked={on}
                              onClick={() => setBuyTokens(String(amount))}
                              className="font-grotesk"
                              style={{
                                padding: '14px 10px', borderRadius: 12, cursor: 'pointer', fontWeight: 800, fontSize: 15,
                                border: on ? '2px solid var(--gold)' : '1px solid var(--line)',
                                background: on ? 'var(--gold-soft, rgba(var(--brand-primary-rgb), .12))' : 'transparent',
                                color: on ? 'var(--gold-ink)' : 'var(--text)',
                              }}
                            >
                              {rupees(amount)}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                  <label htmlFor="buy-tokens" style={{ display: 'block', fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                    {rail.maxCashBuy !== null && rail.buyDenominations.length > 0
                      ? `Or type an amount — above ${rupees(rail.maxCashBuy)} is paid by UPI`
                      : 'Amount'}
                  </label>
                  <div style={{ position: 'relative', marginBottom: 6 }}>
                    <input id="buy-tokens" value={buyTokens} onChange={e => setBuyTokens(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="e.g. 500" className="font-grotesk" style={{ ...inputBox, padding: '0 44px 0 15px' }} />
                    <span style={{ position: 'absolute', right: 15, top: '50%', transform: 'translateY(-50%)', color: 'var(--gold-ink)', fontWeight: 800, fontSize: 13 }}>T</span>
                  </div>
                  {/* Which rail this amount is on, said as it is typed. A
                      `status` region so a screen reader hears it too — the
                      refusal case most of all (§32 S44). */}
                  <div role="status" style={{ fontSize: 11, lineHeight: 1.5, marginBottom: 8, color: cashAmountRefused ? 'var(--red)' : 'var(--text3)' }}>
                    {buyRail === 'CASH' && !cashAmountRefused && rail.maxCashBuy !== null && (
                      <><b style={{ color: 'var(--text)' }}>Cash purchase.</b> Buys up to {rupees(rail.maxCashBuy)} are served by a merchant at a cash machine: pay their link, tap “I’ve paid” straight away, then add the UTR.</>
                    )}
                    {cashAmountRefused && rail.maxCashBuy !== null && (
                      <>Up to {rupees(rail.maxCashBuy)} a purchase is paid in cash at an ATM, which only deals in {rail.buyDenominations.map(rupees).join(', ')}. Choose one of those — or more than {rupees(rail.maxCashBuy)}, which is paid by UPI.</>
                    )}
                    {buyRail === 'UPI' && rail.maxCashBuy !== null && (
                      <><b style={{ color: 'var(--text)' }}>UPI purchase.</b> Buys above {rupees(rail.maxCashBuy)} are paid to a merchant from your UPI app, then you submit the UTR.</>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 14 }}>You pay <b style={{ color: 'var(--gold-ink)' }}>{fmtINR(buyAmount)}</b> · 1 token = ₹1</div>
                  {buyError && <p role="alert" style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10 }}>{buyError}</p>}
                  {/* Disabled, never hidden, on an amount the cash rail cannot
                      serve: the sentence above says why and what to choose
                      instead, so the button is not a dead end with no reason. */}
                  <button onClick={handleBuySubmit} disabled={!buyTokens || buyLoading || cashAmountRefused} style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', boxShadow: '0 8px 22px -8px var(--glow)', opacity: (!buyTokens || buyLoading || cashAmountRefused) ? .5 : 1 }}>{buyLoading ? '⏳ Creating order…' : 'Continue to payment'}</button>

                  {/* The USDT rail, as its own block rather than a mode this
                      screen switches into. The two rails serve DIFFERENT
                      amounts — nothing serves the gap between them — so
                      presenting them side by side is what makes that visible
                      instead of a player discovering it through refusals. */}
                  {rail.usdtBuyDenominations.length > 0 && (
                    <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
                      <UsdtBuyPanel
                        denominations={rail.usdtBuyDenominations}
                        tokensPerUsdt={rail.usdtTokensPerUnit}
                        chains={rail.usdtChains}
                        order={activeUsdtOrder as any}
                        onChanged={() => { loadMeta(); loadOrders(); }}
                      />
                    </div>
                  )}
                </>
              ) : activeBuyOrder ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}><span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Complete payment</span><button onClick={resetBuy} style={{ fontSize: 11, color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer' }}>✕ Cancel</button></div>
                  <BuyPaymentUI
                    order={activeBuyOrder}
                    onPaid={(patch) => setActiveBuyOrder(prev => prev ? { ...prev, ...patch } : prev)}
                    onExpire={() => { resetBuy(); loadOrders(); }}
                    /* The countdown reads `order.expiresAt`. Without this the
                       screen would keep counting down to the OLD deadline and
                       expire an order the server has just extended. */
                    onExpiryExtended={(expiresAt) => setActiveBuyOrder(prev => prev ? { ...prev, expiresAt } : prev)}
                  />
                </>
              ) : null
            ) : (
              sellStep === 'amount' ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(49,196,110,.09)', border: '1px solid rgba(49,196,110,.22)', borderRadius: 11, padding: '11px 13px', marginBottom: 14 }}><span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>Sellable (winnings only)</span><span className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--green)' }}>{fmtT(balances.winningsBalance)}</span></div>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 9 }}>Tokens to sell</div>
                  <div style={{ position: 'relative', marginBottom: 6 }}>
                    <input value={sellTokens} onChange={e => setSellTokens(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="e.g. 500" className="font-grotesk" style={{ ...inputBox, padding: '0 44px 0 15px' }} />
                    <span style={{ position: 'absolute', right: 15, top: '50%', transform: 'translateY(-50%)', color: 'var(--green)', fontWeight: 800, fontSize: 13 }}>T</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 14 }}>You receive <b style={{ color: 'var(--green)' }}>{fmtINR(parseInt(sellTokens) || 0)}</b></div>
                  {sellError && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10 }}>{sellError}</p>}
                  <button onClick={handleSellSubmit} disabled={!sellTokens || sellLoading} style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: '#052018', background: 'linear-gradient(135deg,#8ff0b6,var(--green))', opacity: (!sellTokens || sellLoading) ? .5 : 1 }}>{sellLoading ? '⏳ Creating order…' : 'Sell tokens'}</button>
                  <p style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.5, margin: '11px 2px 0' }}>Payout goes to your saved bank/UPI from Profile. A merchant is auto-assigned and sends your money within the 15-min window.</p>
                </>
              ) : activeSellOrder ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>Sell order in progress</span><CountdownTimer expiresAt={activeSellOrder.expiresAt} onExpire={() => { resetSell(); loadOrders(); }} /></div>
                  <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 11, padding: '11px 13px', fontSize: 12, color: 'var(--text2)' }}>
                    Merchant will send <b style={{ color: 'var(--green)' }}>{fmtINR(activeSellOrder.fiatAmount)}</b> to your saved account.
                    {activeSellOrder.userBankDetails?.accountNumber && <div style={{ marginTop: 6, color: 'var(--text3)' }}>{activeSellOrder.userBankDetails.bankName} ••••{activeSellOrder.userBankDetails.accountNumber.slice(-4)}</div>}
                  </div>
                  <div style={{ background: 'color-mix(in srgb,var(--bombay) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--bombay) 30%,transparent)', borderRadius: 11, padding: 11, textAlign: 'center', fontSize: 11, color: 'var(--bombay)' }}>{['ASSIGNED', 'PROCESSING'].includes(activeSellOrder.status) ? '⏳ Merchant processing your payout…' : '✅ Payment sent. Waiting for final confirmation…'}</div>
                  <button onClick={resetSell} style={{ width: '100%', padding: 11, borderRadius: 11, border: 'none', background: 'var(--surface3)', color: 'var(--text2)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>Back to overview</button>
                </div>
              ) : null
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, background: 'color-mix(in srgb,var(--gold) 7%,var(--surface))', border: '1px solid var(--line)', borderRadius: 13, padding: 13, marginTop: 12 }}>
            <span style={{ fontSize: 16 }}>🛡️</span><span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text2)' }}>P2P exchange: a verified merchant is auto-assigned per order. Buy = pay the merchant from the pre-filled link, submit the UTR, tokens credit on confirm. Sell = merchant pays your bank/UPI. Raise a dispute from Payment Orders if something goes wrong.</span>
          </div>
        </>
      )}

      {/* HISTORY (ledger) */}
      {tab === 'ledger' && (
        <div style={{ ...card, padding: '6px 16px' }}>
          {loading && ledger.length === 0 ? (
            Array.from({ length: 5 }).map((_, i) => <div key={i} className="bb-skel" style={{ height: 48, borderRadius: 10, background: 'var(--skel)', margin: '10px 0' }} />)
          ) : ledger.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)' }}><div style={{ fontSize: 30, marginBottom: 6 }}>📭</div>No transactions yet</div>
          ) : (
            <>
              {ledger.map(entry => {
                const isCredit = entry.type === 'CREDIT';
                return (
                  <div key={entry.txId} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{entry.reason || entry.type}</span><span style={{ fontSize: 10, color: 'var(--text3)' }}>{fmtDate(entry.createdAt)} · {entry.field === 'depositBalance' ? 'Deposit' : 'Winnings'} wallet</span></span>
                    <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: isCredit ? 'var(--green)' : 'var(--red)' }}>{isCredit ? '+' : '−'}{fmtT(entry.amount)}</span>
                  </div>
                );
              })}
              {hasMore && !loading && <button onClick={() => { const n = ledgerPage + 1; setLedgerPage(n); loadLedger(n); }} style={{ width: '100%', padding: 12, margin: '10px 0', background: 'var(--surface3)', borderRadius: 11, border: 'none', color: 'var(--text2)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Load more</button>}
            </>
          )}
        </div>
      )}

      {/* BONUSES */}
      {tab === 'bonuses' && (
        <div style={{ ...card, padding: '6px 16px' }} aria-label="Bonuses">
          {bonusState === 'loading' && bonuses.length === 0 ? (
            Array.from({ length: 3 }).map((_, i) => <div key={i} className="bb-skel" style={{ height: 48, borderRadius: 10, background: 'var(--skel)', margin: '10px 0' }} />)
          ) : bonusState === 'error' && bonuses.length === 0 ? (
            <div role="alert" style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)' }}>
              Could not load your bonuses.{' '}
              <button onClick={() => loadBonuses(1, true)} style={{ color: 'var(--gold-ink)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>Try again</button>
            </div>
          ) : bonuses.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)' }}><div style={{ fontSize: 30, marginBottom: 6 }}>🎁</div>No bonuses yet</div>
          ) : (
            <>
              {bonuses.map(b => (
                <div key={b.bonusId} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{b.label}</span><span style={{ fontSize: 10, color: 'var(--text3)' }}>{fmtDate(b.createdAt)}</span></span>
                  <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: 'var(--green)' }}>+{fmtT(b.amount)}</span>
                </div>
              ))}
              {bonuses.length < bonusTotal && bonusState !== 'loading' && <button onClick={() => { const n = bonusPage + 1; setBonusPage(n); loadBonuses(n); }} style={{ width: '100%', padding: 12, margin: '10px 0', background: 'var(--surface3)', borderRadius: 11, border: 'none', color: 'var(--text2)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Load more</button>}
            </>
          )}
        </div>
      )}

      {/* PAYMENT ORDERS */}
      {tab === 'payments' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={loadOrders} style={{ fontSize: 11, color: 'var(--gold-ink)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>↻ Refresh</button>
          {paymentOrders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)' }}><div style={{ fontSize: 30, marginBottom: 6 }}>📋</div>No payment orders yet</div>
          ) : paymentOrders.map(order => {
            const canCancel = order.status === 'PENDING_QUEUE';
            // An order that ended without ever being served can be tried again,
            // at the FRONT of the queue. Nothing happened on it — no assignment
            // means no transaction and nobody is liable — but the player still
            // wants their tokens, and going to the back of the queue that just
            // failed them is how somebody waits twice and gets nothing twice.
            //
            // `retriedAway` hides the button once they have used it: the server
            // allows one retry per order and a button that 409s is worse than
            // no button.
            const canRetry = ['CANCELLED', 'FAILED', 'REJECTED'].includes(order.status)
              && !retriedAway.includes(order.orderId || order._id);
            return (
              <div key={order._id} style={{ ...card, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={statusChip(order.status)}>{PAYMENT_STATE_LABELS[order.status as PaymentOrderState] ?? order.status}</span>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>{fmtDate(order.createdAt)}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div><div style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700 }}>Type</div><div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{order.type === 'DEPOSIT' ? '⬇️ Buy' : '⬆️ Sell'}</div></div>
                  <div><div style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700 }}>Tokens</div><div className="font-grotesk" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{fmtT(order.tokenAmount)}</div></div>
                  <div><div style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700 }}>{order.type === 'DEPOSIT' ? 'You pay' : 'You receive'}</div><div className="font-grotesk" style={{ fontSize: 13, fontWeight: 700, color: 'var(--gold-ink)' }}>{fmtINR(order.fiatAmount)}</div></div>
                </div>
                {order.utrNumber && <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>UTR: <span className="font-grotesk" style={{ color: 'var(--text2)' }}>{order.utrNumber}</span></div>}
                {order.expiresAt && ['ASSIGNED', 'PROCESSING'].includes(order.status) && <div style={{ marginBottom: 8 }}><CountdownTimer expiresAt={order.expiresAt} /></div>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 9 }}>
                  <span style={{ fontSize: 9, color: 'var(--text3)' }}>Order {order.orderId || order._id}</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    {/* Only where there is something to expand. An expander on
                        every withdrawal would promise siblings that do not exist. */}
                    {order.withdrawalBatchRef && (
                      <button
                        onClick={() => setExpandedOrderId(expandedOrderId === (order.orderId || order._id) ? null : (order.orderId || order._id))}
                        style={{ fontSize: 10, fontWeight: 800, color: 'var(--gold-ink)', background: 'none', border: '1px solid color-mix(in srgb,var(--gold-ink) 40%,transparent)', borderRadius: 999, padding: '4px 11px', cursor: 'pointer' }}
                      >
                        {expandedOrderId === (order.orderId || order._id) ? 'Hide parts' : 'Show parts'}
                      </button>
                    )}
                    {canCancel && <button onClick={() => cancelOrder(order.orderId || order._id)} style={{ fontSize: 10, fontWeight: 800, color: 'var(--red)', background: 'none', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 999, padding: '4px 11px', cursor: 'pointer' }}>Cancel</button>}
                    {canRetry && (
                      <button
                        onClick={() => retryOrder(order.orderId || order._id)}
                        disabled={retrying === (order.orderId || order._id)}
                        style={{ fontSize: 10, fontWeight: 800, color: 'var(--gold-ink)', background: 'none', border: '1px solid color-mix(in srgb,var(--gold-ink) 45%,transparent)', borderRadius: 999, padding: '4px 11px', cursor: 'pointer' }}
                      >
                        {retrying === (order.orderId || order._id) ? 'Retrying…' : 'Try again'}
                      </button>
                    )}
                  </span>
                </div>
                {order.withdrawalBatchRef && expandedOrderId === (order.orderId || order._id) && (
                  <WithdrawalBatchParts
                    orderId={order.orderId || order._id}
                    onChanged={() => { void loadOrders(); void loadMeta(); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </ScreenShell>
  );
};

export default WalletPage;
