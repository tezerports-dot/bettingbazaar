// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// CashReadyCard — a CASH team member's Ready switch, on the Dashboard
// (redesign Step 2c, PROJECT_STATUS §3.10).
//
// A cash buy needs a member standing at an ATM, so routing offers one only to a
// member who has pressed Ready, and the assignment that hands them one switches
// Ready OFF in the same transaction (`teamRouting.assignToTeam`). So:
//
//   - WHO sees it is the server's answer, from GET /api/merchant/team: an
//     APPROVED MEMBER of a team whose rail is CASH. Nobody else — Ready means
//     nothing on the other rails, and the server refuses it there (409).
//   - WHAT it shows is the profile's `cashReady` (formatMerchant), never a flag
//     kept here. The press sets it through PUT /api/merchant/cash-ready, and
//     the profile is re-read after the press and whenever an order is assigned
//     (`new_order`) or the private stream reconnects (`merchant_orders_snapshot`,
//     which is sent on every connect and so covers a `new_order` missed while
//     the stream was down). Being given a cash buy is exactly when the server
//     turns Ready off, and the switch must not go on saying Ready.
//   - A refusal is shown as the server worded it (§32 S14), announced
//     (role="alert", §32 S44).
//
// Colours are CSS variables only — `--brand*` for the switch, the panel's
// neutral tokens for text (§4: no hex literal in a component).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banknote, RefreshCw } from 'lucide-react';
import { useAuth } from '../services/AuthContext';
import { getMyTeam, setCashReady } from '../services/api';
import sseService from '../services/sse';
import type { MyTeam, Team } from '../types';
import { Button, Card, CardTitle } from './ui';

/** The one question that decides whether this card exists. */
function cashTeamOf(mine: MyTeam): Team | null {
  return mine.role === 'MEMBER' && mine.status === 'APPROVED' && mine.team.rail === 'CASH'
    ? mine.team
    : null;
}

type Load = { state: 'loading' } | { state: 'none' } | { state: 'failed' } | { state: 'cash'; team: Team };

export const CashReadyCard: React.FC = () => {
  const { merchant, refreshProfile } = useAuth();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [ready, setReady] = useState(merchant?.cashReady === true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');

  // The profile is the owner. Keyed on the OBJECT, not the flag: a refresh that
  // brings back the same value as before must still overwrite what the last
  // press set, or a Ready switched off by an assignment would stay lit.
  useEffect(() => { setReady(merchant?.cashReady === true); }, [merchant]);

  // `refreshProfile` is a new function on every provider render; holding it in
  // a ref keeps the stream subscription below from churning with it.
  const refreshRef = useRef(refreshProfile);
  refreshRef.current = refreshProfile;

  const loadTeam = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const team = cashTeamOf(await getMyTeam());
      setLoad(team ? { state: 'cash', team } : { state: 'none' });
    } catch {
      setLoad({ state: 'failed' });
    }
  }, []);

  useEffect(() => { void loadTeam(); }, [loadTeam]);

  const isCash = load.state === 'cash';
  useEffect(() => {
    if (!isCash) return undefined;
    const reread = () => { void refreshRef.current(); };
    sseService.on('new_order', reread);
    sseService.on('merchant_orders_snapshot', reread);
    return () => {
      sseService.off('new_order', reread);
      sseService.off('merchant_orders_snapshot', reread);
    };
  }, [isCash]);

  const press = async () => {
    setBusy(true);
    setRefusal('');
    try {
      setReady(await setCashReady(!ready));
      await refreshProfile();
    } catch (err) {
      setRefusal((err as Error)?.message || 'Ready could not be changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (load.state === 'loading' || load.state === 'none') return null;

  if (load.state === 'failed') {
    return (
      <Card style={{ padding: 14 }}>
        <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-2)' }}>
            Could not check whether you are in a cash team, so the Ready switch is not shown.
          </span>
          <Button variant="ghost" tone="neutral" onClick={() => void loadTeam()}>
            <RefreshCw size={14} /> Check again
          </Button>
        </div>
      </Card>
    );
  }

  const online = !!merchant?.isOnline;

  return (
    <Card>
      <CardTitle title="Ready for a cash buy" sub={`Cash team · ${load.team.name}`} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <button
          type="button"
          role="switch"
          aria-checked={ready}
          aria-label="Ready for a cash buy"
          disabled={busy}
          onClick={() => void press()}
          style={{
            display: 'flex', alignItems: 'center', gap: 9, padding: '12px 18px', borderRadius: 12,
            fontSize: 14, fontWeight: 800, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            border: `1.5px solid ${ready ? 'var(--brand)' : 'var(--border)'}`,
            background: ready ? 'var(--brand-bg)' : 'var(--surface-2)',
            color: ready ? 'var(--brand)' : 'var(--text-2)',
          }}
        >
          <Banknote size={17} aria-hidden />
          {ready ? 'Ready' : 'Not ready'}
        </button>
        <p style={{ flex: 1, minWidth: 220, margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>
          {ready
            ? 'You are Ready: the next cash buy can be given to you. Being given one switches Ready off, '
              + 'because you are busy at the machine with it. Press Ready again when you are free.'
            : 'Press Ready when you are at the ATM and free to take a cash buy. Cash buys go only to '
              + 'members who are Ready. Being given one switches Ready off; press it again when you are free.'}
        </p>
      </div>
      {ready && !online && (
        <p style={{ margin: '10px 0 0', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
          You are offline, so no cash buy reaches you even while Ready. Go online as well.
        </p>
      )}
      {refusal && (
        <p role="alert" style={{ margin: '10px 0 0', fontSize: 12.5, fontWeight: 700, color: 'var(--danger)' }}>
          {refusal}
        </p>
      )}
    </Card>
  );
};

