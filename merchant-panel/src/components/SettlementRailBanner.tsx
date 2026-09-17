// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// SettlementRailBanner — which workflow this merchant is performing today.
//
// The platform runs one of two P2P settlement rails and an admin can switch
// between them at any moment. The two rails ask DIFFERENT things of a merchant:
// on the UPI rail they take a UTR against their own UPI, on the ATM cash rail
// they scan a cash-withdrawal QR and settle deposits at a CDM. A merchant still
// performing yesterday's workflow is a player waiting for a payment nobody is
// sending.
//
// So this reads the rail on mount, and again when the server pushes a change.
// The read is the part that guarantees correctness: a notification can be
// missed and a socket can drop, but the panel always loads.
//
// It renders NOTHING while the rail is unknown, rather than guessing a default.
// A banner that confidently names the wrong workflow is worse than no banner.
//
// ── And that applies to the USDT merchant, who is on NEITHER rail ──────────
// P2P_UPI and CASH_ATM are how an INR order settles. A USDT order settles by
// the player sending USDT straight to the merchant's own wallet address —
// there is no UPI handle in it and no cash machine — and a USDT merchant can
// never be given an INR order at all: every assignment path filters on
// `m.merchant_type = <the order's currency>`.
//
// This read the platform rail and nothing else, so on the day an admin switched
// to CASH_ATM every USDT merchant was told, in a banner headed "which workflow
// you are performing today", to go and scan a cash-withdrawal QR at an ATM.
// Seen on a real screen, which is the only reason it was noticed: the copy is
// correct for the rail and the rail is not theirs.
import React, { useCallback, useEffect, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { getPaymentMode } from '../services/api';
import sseService from '../services/sse';
import type { PaymentModeView } from '../types';
import { RAIL, type MerchantRail } from '../utils/rail';
import { cardStyle } from './ui';

const formatWindow = (seconds?: number | null): string => {
  if (!seconds || !Number.isFinite(seconds)) return '—';
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60} min`;
  return `${seconds}s`;
};

export const SettlementRailBanner: React.FC<{
  /**
   * The rail THIS merchant settles on. A prop rather than a `useAuth()` inside,
   * so the component keeps stating what it needs instead of reaching for it —
   * and so it can still be rendered on its own, which is how its own suite
   * tests it. Defaults to INR, which is the schema default for
   * `accepted_currencies` and therefore the same answer `railOf(null)` gives.
   */
  rail?: MerchantRail;
}> = ({ rail = RAIL.INR }) => {
  // A USDT merchant performs one workflow and it never changes, so there is no
  // "today's rail" to announce and neither INR rail is theirs to be told about.
  // Their own instructions live on the order and on Profile, beside the address
  // and its network.
  //
  // Decided ONCE, here, and used by both the fetch and the render — so the
  // banner does not poll a rail it will never show. Putting this only at the
  // render made every USDT merchant's dashboard load ask the server a question
  // whose answer could not change the page.
  const applies = rail !== RAIL.USDT;
  const [mode, setMode] = useState<PaymentModeView | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async (markChanged = false) => {
    if (!applies) return;
    try {
      const next = await getPaymentMode();
      setMode(next);
      if (markChanged) setChanged(true);
    } catch {
      // A failed read leaves the previous answer on screen rather than
      // replacing it with a wrong one. The merchant is not blocked by this.
    }
  }, [applies]);

  useEffect(() => { void load(); }, [load]);

  // The server broadcasts to every connected merchant when an admin switches,
  // so a merchant mid-shift is not left on the old workflow until their next
  // page load. The push carries the new rail, but this RE-READS rather than
  // rendering the payload: one owner for what the rail is, so a payload that
  // ever drifts from the policy cannot put the wrong workflow on screen.
  //
  // `payment_mode_changed` must also be in sse.ts's merchantEvents list —
  // subscribing here to a name the service does not register is a dead
  // subscription that never fires and never errors.
  useEffect(() => {
    const onChange = () => { void load(true); };
    sseService.on('payment_mode_changed', onChange);
    return () => sseService.off('payment_mode_changed', onChange);
  }, [load]);

  if (!applies) return null;
  if (!mode?.activeMode) return null;

  return (
    <div
      role="status"
      style={{
        ...cardStyle,
        padding: 14,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        // `--warn` is defined in index.css for both themes (#C2740A light,
        // #F5B34A dark). The fallback here was #b8860b — the BRAND's secondary
        // — standing in for a warning colour, so a rebrand would have tinted a
        // warning border and the fallback pointed at the wrong owner besides.
        borderColor: changed ? 'var(--warn)' : undefined,
      }}
    >
      <Info size={18} aria-hidden />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--text)' }}>
          {changed ? 'Settlement has just changed — ' : 'Settlement: '}
          {mode.label}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
          {mode.merchantMessage}
        </div>
        {mode.timers && (
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
            You have {formatWindow(mode.timers.processingWindowSeconds)} to act on an order you accept
            {mode.activeMode === 'CASH_ATM'
              && ` · a cash link stays valid for ${formatWindow(mode.timers.linkExpirySeconds)}`}
            .
          </div>
        )}
        {changed && (
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
            Orders you already hold keep the process they were created under.
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => void load()}
        aria-label="Re-check the settlement rail"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}
      >
        <RefreshCw size={15} />
      </button>
    </div>
  );
};

export default SettlementRailBanner;
