// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import React, { useCallback, useEffect, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { getPaymentMode } from '../services/api';
import sseService from '../services/sse';
import type { PaymentModeView } from '../types';
import { cardStyle } from './ui';

const formatWindow = (seconds?: number | null): string => {
  if (!seconds || !Number.isFinite(seconds)) return '—';
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60} min`;
  return `${seconds}s`;
};

export const SettlementRailBanner: React.FC = () => {
  const [mode, setMode] = useState<PaymentModeView | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async (markChanged = false) => {
    try {
      const next = await getPaymentMode();
      setMode(next);
      if (markChanged) setChanged(true);
    } catch {
      // A failed read leaves the previous answer on screen rather than
      // replacing it with a wrong one. The merchant is not blocked by this.
    }
  }, []);

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
        borderColor: changed ? 'var(--warn, #b8860b)' : undefined,
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
