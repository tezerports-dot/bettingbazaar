// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// TokenSupply — where a merchant buys the float they trade with.
//
// A merchant funds player deposits out of their own token balance. That balance
// is bought from the platform with USDT, and an admin decides each request. The
// backend for this shipped and had no screen at all: five endpoints served, no
// panel calling any of them, which by CLAUDE.md §28 means it was not shipped.
//
// ── The order of operations is forced, and the screen has to say so ────────
// The transaction id is REQUIRED when the request is filed. Two rules make it
// so, and neither is negotiable from here:
//
//   • `merchant_token_orders_approved_has_hash` refuses to approve a purchase
//     that does not name the transaction that paid for it.
//   • `merchant_token_orders_one_per_day` allows ONE live request per merchant
//     per day, so a request filed without a hash cannot be re-filed with one.
//
// So the merchant sends the USDT first and files the request afterwards. That
// only works if they know the exact figure BEFORE they send, which is what the
// quote step is for — and why the quote is read from the server rather than
// computed here. The rate, the rounding to whole tens of USDT and the accepted
// band are one function in merchant.routes.js; a copy of that arithmetic in
// this file would drift the first time any of them moved (§5), and it decides
// how much real money leaves the merchant's wallet.
//
// One request per day is stated up front rather than discovered on a 429: a
// merchant who files for the wrong amount has spent their day.
import React, { useCallback, useEffect, useState } from 'react';
import { Coins, Info, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  createAdminTokenOrder,
  getAdminTokenOrders,
  quoteAdminTokenPurchase,
} from '../services/api';
import { useAuth } from '../services/AuthContext';
import type { AdminTokenOrder, AdminTokenQuote } from '../types';
import { Banner, Button, Card, CardTitle, Field, Skeleton, inputStyle } from '../components/ui';

/**
 * Token-order statuses are NOT P2P order statuses, so `StatusPill` is the wrong
 * component here: its map has no PENDING/APPROVED/REJECTED and falls back to
 * "Cancelled", which would label an approved purchase as a cancelled one.
 */
const STATUS_TONE: Record<AdminTokenOrder['status'], string> = {
  PENDING:   'warn',
  APPROVED:  'ok',
  REJECTED:  'danger',
  CANCELLED: 'muted',
};

const StatusTag: React.FC<{ status: AdminTokenOrder['status'] }> = ({ status }) => {
  const tone = STATUS_TONE[status] ?? 'muted';
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap',
      color: `var(--${tone})`,
      background: tone === 'muted' ? 'var(--surface-2)' : `var(--${tone}-bg)`,
    }}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
};

const when = (ts: string | null) => {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return String(ts); }
};

/** Enough of a hash to recognise, never the whole thing on a narrow screen. */
const shortHash = (hash: string | null) =>
  (!hash ? '—' : hash.length <= 18 ? hash : `${hash.slice(0, 10)}…${hash.slice(-6)}`);

const TokenSupply: React.FC = () => {
  const { merchant } = useAuth();
  const [orders, setOrders] = useState<AdminTokenOrder[] | null>(null);
  const [loading, setLoading] = useState(true);

  const [tokens, setTokens] = useState('');
  const [hash, setHash] = useState('');
  const [quote, setQuote] = useState<AdminTokenQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrders(await getAdminTokenOrders());
    } catch {
      // A failed read leaves the previous list up rather than replacing it with
      // an empty one — "you have no requests" is a different claim from "I
      // could not ask", and this codebase has shipped that confusion before.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A live request blocks another one today. Read off the list rather than
  // tracked separately: the server decides, and this is what it said.
  const openRequest = orders?.find((o) => o.status === 'PENDING') ?? null;

  const tokenAmount = Number(tokens);
  const amountLooksUsable = Number.isFinite(tokenAmount) && tokenAmount > 0;

  // The quote is dropped the moment the amount changes. A stale figure beside a
  // new amount is the one failure that costs the merchant real USDT.
  const setTokensAndClearQuote = (value: string) => {
    setTokens(value);
    setQuote(null);
  };

  const getQuote = async () => {
    if (!amountLooksUsable) return;
    setQuoting(true);
    try {
      setQuote(await quoteAdminTokenPurchase(tokenAmount));
    } catch (err: any) {
      toast.error(err?.message || 'Could not price that amount.');
    } finally {
      setQuoting(false);
    }
  };

  const submit = async () => {
    if (!quote?.ok || !hash.trim()) return;
    setSubmitting(true);
    try {
      const order = await createAdminTokenOrder(tokenAmount, hash.trim());
      // The created order's OWN figures are the contract, not the preview's. If
      // an admin edited the rate between the two, this is the number that was
      // recorded and the one the admin will check the transaction against.
      toast.success(`Request filed for ${order.tokenAmount.toLocaleString('en-IN')} tokens at ${order.usdtAmount} USDT.`);
      setTokensAndClearQuote('');
      setHash('');
      await load();
    } catch (err: any) {
      // Every refusal here is specific and actionable — the amount is outside
      // the band, that transaction already funded a purchase, you have already
      // filed today. A generic message would throw all of it away.
      toast.error(err?.message || 'Could not file that request.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Skeleton height={200} />;

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <CardTitle
          title="Your token float"
          sub="What you fund player deposits from"
          action={
            <button
              type="button" onClick={() => void load()} aria-label="Refresh"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}
            >
              <RefreshCw size={16} />
            </button>
          }
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Coins size={18} aria-hidden style={{ color: 'var(--brand)' }} />
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
              {(merchant?.tokenBalance ?? 0).toLocaleString('en-IN')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>tokens available</div>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle
          title="Buy tokens from the platform"
          sub="Paid in USDT · one request per day · an admin approves it"
        />

        <Banner tone="info" icon={<Info size={16} style={{ color: 'var(--info)', flexShrink: 0, marginTop: 1 }} />}>
          Price the amount first, send that exact USDT to the platform wallet,
          then file the request with the transaction ID. The ID is required —
          it is what the approval is checked against, and one transaction can
          fund only one purchase.
        </Banner>

        {openRequest && (
          <Banner tone="warn" style={{ marginTop: 12 }} title="You already have a request today">
            Filed {when(openRequest.requestedAt)} for{' '}
            {openRequest.tokenAmount.toLocaleString('en-IN')} tokens. Only one
            request per day is accepted, so wait for a decision on this one.
          </Banner>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
          <Field
            label="Tokens to buy"
            hint="Priced by the server at the platform's current USDT rate."
          >
            <input
              type="number" min={1} step={1} inputMode="numeric"
              value={tokens}
              disabled={!!openRequest}
              onChange={(e) => setTokensAndClearQuote(e.target.value)}
              placeholder="e.g. 100000"
              style={inputStyle}
            />
          </Field>

          {!quote ? (
            <Button
              onClick={() => void getQuote()}
              disabled={!amountLooksUsable || !!openRequest}
              busy={quoting}
              variant="outline"
            >
              Price this amount
            </Button>
          ) : quote.ok ? (
            <>
              <div style={{
                padding: 13, borderRadius: 12, background: 'var(--brand-bg)',
                display: 'flex', flexDirection: 'column', gap: 4,
              }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--brand)' }}>
                  Send {quote.usdtAmount} USDT
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)' }}>
                  for {tokenAmount.toLocaleString('en-IN')} tokens, at ₹{quote.usdtRate} per USDT.
                </div>
              </div>

              <Field
                label="USDT transaction ID"
                hint="From the transfer you just made. 64 hexadecimal characters, with or without a leading 0x."
              >
                <input
                  type="text"
                  value={hash}
                  onChange={(e) => setHash(e.target.value)}
                  placeholder="0x…"
                  autoComplete="off" spellCheck={false}
                  style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12.5 }}
                />
              </Field>

              <Button
                onClick={() => void submit()}
                disabled={!hash.trim() || !!openRequest}
                busy={submitting}
                full
              >
                File this request
              </Button>
            </>
          ) : (
            <Banner tone="danger" title="Not a purchase the platform will take">
              {quote.message}
            </Banner>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle title="Your requests" sub="The 30 most recent" />
        {!orders || orders.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            You have not bought tokens from the platform yet.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                  <th style={{ padding: '6px 10px 6px 0', fontWeight: 700 }}>Filed</th>
                  <th style={{ padding: '6px 10px 6px 0', fontWeight: 700 }}>Tokens</th>
                  <th style={{ padding: '6px 10px 6px 0', fontWeight: 700 }}>USDT</th>
                  <th style={{ padding: '6px 10px 6px 0', fontWeight: 700 }}>Transaction</th>
                  <th style={{ padding: '6px 10px 6px 0', fontWeight: 700 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 10px 9px 0', color: 'var(--text-2)' }}>{when(o.requestedAt)}</td>
                    <td style={{ padding: '9px 10px 9px 0', fontWeight: 700 }}>{o.tokenAmount.toLocaleString('en-IN')}</td>
                    <td style={{ padding: '9px 10px 9px 0' }}>{o.usdtAmount ?? '—'}</td>
                    <td style={{ padding: '9px 10px 9px 0', fontFamily: 'monospace', fontSize: 11.5, color: 'var(--muted)' }}>
                      {shortHash(o.usdtTxHash)}
                    </td>
                    <td style={{ padding: '9px 10px 9px 0' }}>
                      <StatusTag status={o.status} />
                      {/* A rejection the merchant cannot read the reason for is
                          one they cannot fix. The row requires the note; this
                          is the only place it is shown to them. */}
                      {o.status === 'REJECTED' && o.reviewNote && (
                        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)', maxWidth: 260 }}>
                          {o.reviewNote}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default TokenSupply;
