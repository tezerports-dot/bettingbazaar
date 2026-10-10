// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player screen's extras (owner, 2026-10-10), each behind its own switch
 * in Admin › Player Screen (`SystemConfig.boardExtras`, served in
 * `system_config`):
 *
 *   • `UrgencyChips`      — LIVE pill, timer tone, "Closing 0:09" chip
 *   • `ResultCelebration` — the winning side large, and this player's own
 *                            payout counting up (from their `payout_success`)
 *   • `PromoCardsRow`     — the published HOME cards (Admin › Page Slides)
 *   • `UnlockBar`         — the General wallet's unlock progress
 *
 * None of them shows a figure the platform does not already send this player.
 */
import React, { useEffect, useRef, useState } from 'react';
import { MY_PAYOUT_EVENT } from '../services/GameContext';
import { getAssetUrl, getBackend } from '../services/backend.service';
import type { PromoContent } from '../types';
import { fmt } from './format';

// ── Timer tone ───────────────────────────────────────────────────────────────
export type TimerTone = 'calm' | 'amber' | 'red';

/**
 * The timer's colour from the seconds left before bets CLOSE: red inside the
 * warning, amber for the same span again before it, calm otherwise. A warning
 * of 0 keeps the timer calm.
 */
export function timerTone(secondsToClose: number, warnSeconds: number): TimerTone {
  if (warnSeconds <= 0) return 'calm';
  if (secondsToClose <= warnSeconds) return 'red';
  if (secondsToClose <= warnSeconds * 2) return 'amber';
  return 'calm';
}

export const TONE_COLOR: Record<TimerTone, string> = { calm: 'var(--text)', amber: 'var(--gold-ink)', red: 'var(--red)' };

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The LIVE pill while bets are open, and the closing chip inside the warning. */
export const UrgencyChips: React.FC<{ open: boolean; secondsToClose: number; warnSeconds: number }> = ({ open, secondsToClose, warnSeconds }) => {
  if (!open) return null;
  const closing = warnSeconds > 0 && secondsToClose <= warnSeconds;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999, background: 'var(--red)', color: '#fff', fontSize: 9, fontWeight: 900, letterSpacing: '.12em' }}>
        <span className="bb-livedot" aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />LIVE
      </span>
      {closing && (
        <span role="status" style={{ padding: '2px 8px', borderRadius: 999, background: 'color-mix(in srgb,var(--gold) 22%,transparent)', border: '1px solid var(--gold)', color: 'var(--gold-ink)', fontSize: 9, fontWeight: 900, letterSpacing: '.06em', fontVariantNumeric: 'tabular-nums' }}>
          Closing {mmss(Math.max(0, secondsToClose))}
        </span>
      )}
    </span>
  );
};

// ── Result celebration ───────────────────────────────────────────────────────
/** Counts from 0 to `to` over `ms`, easing out; `to` alone when motion is reduced. */
function useCountUp(to: number, ms = 1200): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!to) { setV(0); return; }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setV(to); return; }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(Math.round(to * (1 - Math.pow(1 - k, 3)) * 100) / 100);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return v;
}

/** How long a payout that lands after the round has rolled over stays up. */
export const LATE_PAYOUT_MS = 6000;

interface Paid { cycleId: string; amount: number; winner: string | null; at: number }

/**
 * Over the board on the result: who won, large, and — for a player the
 * server just paid on this cycle — their own payout counting up. The payout
 * is the `payout_success` the server sends that player alone. Settlement can
 * land after a short board has already opened its next round, so a payout
 * also shows on its own, for `LATE_PAYOUT_MS`, with the winner it names.
 */
export const ResultCelebration: React.FC<{ result: { cycleId?: string; winner?: string | null } | null }> = ({ result }) => {
  const [paid, setPaid] = useState<Paid | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { cycleId: string; amount: number; winner?: string | null } | undefined;
      if (!d || !(d.amount > 0)) return;
      setPaid(prev => ({
        cycleId: d.cycleId, winner: d.winner ?? null, at: Date.now(),
        amount: prev && prev.cycleId === d.cycleId ? prev.amount + d.amount : d.amount,
      }));
    };
    window.addEventListener(MY_PAYOUT_EVENT, on);
    return () => window.removeEventListener(MY_PAYOUT_EVENT, on);
  }, []);
  // Take the late banner down when its time is up.
  useEffect(() => {
    if (!paid) return;
    const id = setTimeout(() => tick(n => n + 1), LATE_PAYOUT_MS + 50);
    return () => clearTimeout(id);
  }, [paid]);

  const late = paid && Date.now() - paid.at < LATE_PAYOUT_MS ? paid : null;
  const winner = result?.winner === 'DELHI' || result?.winner === 'BOMBAY' ? result.winner : (late && !result ? late.winner : null);
  const mine = result
    ? (paid && result.cycleId && paid.cycleId === result.cycleId ? paid.amount : 0)
    : (late ? late.amount : 0);
  const shown = useCountUp(mine);
  if (winner !== 'DELHI' && winner !== 'BOMBAY') return null;
  const tone = winner === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)';
  return (
    <div role="status" aria-live="polite" style={{ position: 'absolute', inset: 0, zIndex: 7, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 20, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)', pointerEvents: 'none', textAlign: 'center', padding: 12 }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.22em', color: 'rgba(255,255,255,.7)' }}>{result ? 'RESULT' : 'LAST ROUND'}</span>
      <span className="font-grotesk" style={{ fontWeight: 800, fontSize: 34, letterSpacing: '.08em', color: tone, textShadow: '0 2px 18px rgba(0,0,0,.8)' }}>
        🏆 {winner === 'DELHI' ? 'DELHI' : 'BOMBAY'} {result ? 'WINS' : 'WON'}
      </span>
      {mine > 0 && (
        <>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.16em', color: 'var(--green)', marginTop: 6 }}>YOU WON</span>
          <span className="font-grotesk" style={{ fontWeight: 800, fontSize: 40, color: 'var(--green)', fontVariantNumeric: 'tabular-nums' }}>₹{fmt(shown)}</span>
        </>
      )}
    </div>
  );
};

// ── Promo cards row ──────────────────────────────────────────────────────────
/** The published HOME cards, most important first; nothing at all when none. */
export const PromoCardsRow: React.FC = () => {
  const [cards, setCards] = useState<PromoContent[] | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    getBackend().getPublicContent('HOME').then(c => { if (alive.current) setCards(c.filter(x => x.fileUrl)); }).catch(() => { if (alive.current) setCards([]); });
    return () => { alive.current = false; };
  }, []);
  if (!cards || cards.length === 0) return null;
  return (
    <div role="list" aria-label="Promotions" className="bb-noscroll" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '2px 2px 10px', scrollSnapType: 'x mandatory' }}>
      {cards.map(c => (
        <div role="listitem" key={c.id} style={{ flex: '0 0 auto', width: 'min(78%, 300px)', scrollSnapAlign: 'start', position: 'relative', borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface)' }}>
          <img src={getAssetUrl(c.fileUrl)} alt={c.title || 'Promotion'} loading="lazy" style={{ display: 'block', width: '100%', aspectRatio: '16 / 7', objectFit: 'cover' }} />
          <span style={{ position: 'absolute', top: 8, left: 8, padding: '2px 8px', borderRadius: 999, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase' }}>
            {c.title || 'Promotion'}
          </span>
        </div>
      ))}
    </div>
  );
};

// ── General wallet unlock bar ────────────────────────────────────────────────
export interface Grant { requiredTurnover: number; turnover: number; completedAt?: string | null }

/** Done / required over the OPEN grants, in rupees; null when none is open. */
export function unlockProgress(grants: Grant[] | undefined): { done: number; required: number; pct: number } | null {
  const open = (grants || []).filter(g => !g.completedAt && g.requiredTurnover > 0);
  if (open.length === 0) return null;
  const required = open.reduce((a, g) => a + g.requiredTurnover, 0);
  const done = open.reduce((a, g) => a + Math.min(g.turnover, g.requiredTurnover), 0);
  return { done, required, pct: Math.max(0, Math.min(100, Math.floor((done / required) * 100))) };
}

export const UnlockBar: React.FC<{ grants?: Grant[] }> = ({ grants }) => {
  const p = unlockProgress(grants);
  if (!p) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 5 }}>
        <span>Bonus unlock</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>₹{fmt(p.done)} of ₹{fmt(p.required)} played · {p.pct}%</span>
      </div>
      <div role="progressbar" aria-label="Bonus unlock" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.pct} style={{ height: 8, borderRadius: 999, background: 'var(--surface3)', overflow: 'hidden', border: '1px solid var(--line)' }}>
        <div style={{ width: `${p.pct}%`, height: '100%', borderRadius: 999, background: 'var(--green)', transition: 'width .4s ease' }} />
      </div>
    </div>
  );
};
