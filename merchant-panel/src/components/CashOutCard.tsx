// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A pool's cash out (owner, 2026-10-21; the rule is
 * database/repositories/teamCashOut.js). While it runs the pool gets buy
 * orders only, before other pools, so its tokens turn into cash; the sells and
 * disputes already open stay with it. It ends by itself once the pool cannot
 * cover the smallest buy and no buy is open, or when stopped; then nothing new
 * reaches the pool, and it buys no tokens, for `pauseHours`.
 *
 * Shared by a merchant account's Pool page and a supervisor's team. The card
 * keeps no rule of its own: what it shows is the server's `cashOut`.
 */
import React, { useState } from 'react';
import { Banknote } from 'lucide-react';
import toast from 'react-hot-toast';
import type { CashOut } from '../types';
import { Banner, Button, Card, CardTitle } from './ui';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

export const CashOutCard: React.FC<{
  cashOut: CashOut;
  /** Whether this person may start and stop it (the owner, or the supervisor). */
  canAct: boolean;
  change: (start: boolean) => Promise<unknown>;
  onChanged: () => Promise<void> | void;
}> = ({ cashOut, canAct, change, onChanged }) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');
  const hours = cashOut.pauseHours;

  const run = async (start: boolean) => {
    setBusy(true); setRefusal('');
    try {
      await change(start);
      toast.success(start ? 'Cash out started: buy orders only from now.' : `Cash out stopped. The ${hours}-hour pause has started.`);
      setConfirming(false);
      await onChanged();
    } catch (err: any) {
      setRefusal(err?.message || 'Could not change the cash out.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardTitle title="Cash out" sub="Turn the tokens in this pool into cash by serving buy orders only." />
      {cashOut.active ? (
        <Banner tone="warn" title={`Cashing out since ${when(cashOut.startedAt)}`}>
          Only buy orders come to this pool now, before other pools. Sell orders and disputes you already have stay
          with you to finish. It ends by itself when the pool cannot cover the smallest buy and no buy is open, and
          then no new orders come for {hours} hours.
        </Banner>
      ) : cashOut.pausedUntil ? (
        <Banner tone="info" title={`Paused until ${when(cashOut.pausedUntil)}`}>
          After a cash out, no new orders come to this pool and it buys no tokens for {hours} hours.
        </Banner>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          From the moment you start, no new sell orders come to this pool and its buy orders go first. Your open
          sells and disputes stay with you. When the pool is used up it stops by itself, and then no new orders come
          for {hours} hours.
        </div>
      )}
      {refusal && <div role="alert" style={{ marginTop: 10 }}><Banner tone="danger">{refusal}</Banner></div>}
      {canAct && !cashOut.pausedUntil && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {cashOut.active ? (
            <Button variant="outline" tone="danger" busy={busy} onClick={() => void run(false)}>
              <Banknote size={15} /> Stop cash out (pause starts now)
            </Button>
          ) : confirming ? (
            <>
              <Button tone="danger" busy={busy} onClick={() => void run(true)}>Yes, start the cash out</Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Not now</Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setConfirming(true)}>
              <Banknote size={15} /> Start cash out
            </Button>
          )}
        </div>
      )}
    </Card>
  );
};
