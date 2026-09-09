// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// CashLinks — the ATM cash rail, from the merchant's side.
//
// A merchant stands at a machine, initiates a UPI cash withdrawal, and supplies
// the payment link it produces. A player pays that link, the ATM dispenses, and
// the merchant collects the notes.
//
// ── What this screen is careful about ──────────────────────────────────────
// An expired link earns nothing — no compensation, no money — so a wrong "yes,
// go to an ATM" costs the merchant a journey. Three consequences:
//
//   • `worthGoing` comes from the SERVER, never from `waiting > 0`. A merchant
//     without the tokens to serve the order cannot take it however close the
//     machine is, and the server is the only side that knows their balance.
//
//   • The countdown is real and prominent. A link they supplied minutes ago is
//     about to expire, and knowing that is the difference between waiting and
//     going back.
//
//   • "Not approved" and "no work right now" are shown as DIFFERENT states. An
//     empty queue and an unapproved merchant look identical if both render a
//     blank list, and this codebase has already shipped that mistake five times.
import React, { useCallback, useEffect, useState } from 'react';
import { Banknote, Clock, Info, RefreshCw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { cancelCashLink, getCashLinkState, supplyCashLink } from '../services/api';
import sseService from '../services/sse';
import { useNow, formatCountdown, secondsLeft } from '../hooks/useCountdown';
import type { CashLinkState } from '../types';
import { Card, CardTitle, Skeleton, cardStyle } from '../components/ui';

const CashLinks: React.FC = () => {
  const [state, setState] = useState<CashLinkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const load = useCallback(async () => {
    try {
      setState(await getCashLinkState());
    } catch {
      // A failed read leaves the previous answer on screen rather than
      // replacing it with a wrong one. The merchant is not blocked by this.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The server broadcasts when demand changes at this denomination. Re-read
  // rather than rendering the pushed payload: one owner for what is waiting,
  // and the push does not know this merchant's balance.
  useEffect(() => {
    const onDemand = () => { void load(); };
    sseService.on('cash_link_demand', onDemand);
    return () => sseService.off('cash_link_demand', onDemand);
  }, [load]);

  // A live link expires on its own. Re-read as it lapses so the form comes
  // back rather than the merchant staring at a dead countdown.
  const remaining = state?.live ? secondsLeft(state.live.expiresAt, now) : null;
  useEffect(() => {
    if (remaining !== null && remaining <= 0) void load();
  }, [remaining, load]);

  const supply = async () => {
    if (!link.trim()) return;
    setBusy(true);
    try {
      await supplyCashLink(link.trim());
      setLink('');
      toast.success('Link supplied. It will be handed to the next matching order.');
      await load();
    } catch (err: any) {
      // The server refuses with a NAMED reason — not approved, already live,
      // wrong rail — and each is something the merchant can act on standing at
      // the machine. A generic failure would throw that away.
      toast.error(err?.response?.data?.message || err?.message || 'Could not supply that link.');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (linkId: string) => {
    setBusy(true);
    try {
      await cancelCashLink(linkId);
      toast.success('Link withdrawn.');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || err?.message || 'Could not withdraw that link.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Skeleton height={160} />;
  if (!state) return null;

  // Not approved is its own state, said plainly. An empty queue would look the
  // same and tell them nothing about why.
  if (!state.approved) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Card>
          <CardTitle title="ATM cash rail" sub="Not enabled for this account" />
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
            You are not approved for the ATM cash rail. An admin sets the single
            denomination you serve — until then this screen has nothing to show
            you, and no orders on this rail will reach you.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <CardTitle
          title={`Your denomination: ₹${state.denomination?.toLocaleString()}`}
          sub="Every order you are offered is this amount, and no other"
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
          <Banknote size={18} aria-hidden />
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>
              {state.waiting}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {state.waiting === 1 ? 'order waiting for a link' : 'orders waiting for a link'}
            </div>
          </div>
        </div>

        <p role="status" style={{ display: 'flex', gap: 8, marginTop: 12, fontSize: 12.5 }}>
          <Info size={15} aria-hidden />
          <span style={{ color: 'var(--muted)' }}>
            {state.worthGoing
              ? 'Worth a trip — there is work at your denomination and you have the tokens to serve it.'
              : state.waiting > 0
                ? 'There is work waiting, but you cannot take it yet — your tokens are committed. This will clear as your held orders settle.'
                : 'Nothing waiting at your denomination right now. You will be told the moment there is.'}
          </span>
        </p>
      </Card>

      {state.live ? (
        <Card style={{ borderColor: remaining !== null && remaining < 30 ? 'var(--wd)' : undefined }}>
          <CardTitle title="Your link is waiting" sub="It will be given to the next matching order" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Clock size={16} aria-hidden />
            <strong style={{ fontSize: 18 }}>
              {remaining !== null && remaining > 0 ? formatCountdown(remaining) : 'expiring…'}
            </strong>
          </div>
          <div style={{ ...cardStyle, padding: 10, wordBreak: 'break-all', fontSize: 12 }}>
            {state.live.paymentLink}
          </div>
          <button
            type="button" disabled={busy}
            onClick={() => void withdraw(state.live!.linkId)}
            style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 7 }}
          >
            <Trash2 size={15} /> Withdraw this link
          </button>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
            Withdraw it if you have left the machine. A player given a link you
            cannot honour finds an empty ATM.
          </p>
        </Card>
      ) : (
        <Card>
          <CardTitle title="Supply a link" sub="Paste the payment link your ATM produced" />
          <label htmlFor="cash-link" className="label" style={{ fontSize: 12.5 }}>
            Payment link
          </label>
          <input
            id="cash-link" value={link} disabled={busy}
            onChange={(e) => setLink(e.target.value)}
            placeholder="upi://pay?..."
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          />
          <button
            type="button" disabled={busy || !link.trim()}
            onClick={() => void supply()}
            style={{ marginTop: 12 }}
          >
            Supply link
          </button>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
            The amount is your approved denomination and the lifetime is set by
            the platform — you only supply the link. You can hold one at a time.
          </p>
        </Card>
      )}
    </div>
  );
};

export default CashLinks;
