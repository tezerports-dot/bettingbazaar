// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player screen's extras (owner, 2026-10-10), each behind its own switch
 * in Admin › Player Screen (`SystemConfig.boardExtras`, served in
 * `system_config`):
 *
 *   • `ClosingChip`       — timer tone, "Closing 0:09" chip on the cards
 *   • `ResultCelebration` — the winning side large, and this player's whole
 *                            round in one line (`round_result`, then the
 *                            `payout_success` credit)
 *   • `useHomeCards`      — the published HOME cards (Admin › Page Slides),
 *                            beside the game on a laptop (`BoardArt.tsx`),
 *                            in `PromoCarousel` under the header on a phone
 *   • `UnlockBar`         — the General wallet's unlock progress
 *
 * None of them shows a figure the platform does not already send this player.
 */
import React, { useEffect, useRef, useState } from 'react';
import { MY_PAYOUT_EVENT, MY_ROUND_EVENT } from '../services/GameContext';
import { getBackend } from '../services/backend.service';
import { PromoCard, type HomeCard } from './BoardArt';
import { fmt } from './format';
import { useViewport } from './useViewport';
import type { HomePromoCard, PromoDevice } from '../types';

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

/**
 * The closing chip, only inside the warning. It sits ON the betting cards, not
 * in the timer row: the LIVE pill that used to stand there made the board
 * switch wrap onto two lines (owner, 2026-10-10: "we dont need that").
 */
export const ClosingChip: React.FC<{ open: boolean; secondsToClose: number; warnSeconds: number }> = ({ open, secondsToClose, warnSeconds }) => {
  if (!open || warnSeconds <= 0 || secondsToClose > warnSeconds) return null;
  return (
    <span role="status" style={{ padding: '3px 10px', borderRadius: 999, background: 'color-mix(in srgb,var(--bg) 70%,transparent)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 10, fontWeight: 900, letterSpacing: '.06em', fontVariantNumeric: 'tabular-nums', backdropFilter: 'blur(4px)' }}>
      Closing {mmss(Math.max(0, secondsToClose))}
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

/** How long a result that lands after the round has rolled over stays up. */
export const LATE_PAYOUT_MS = 6000;

/** This player's round: what they staked, what it returns, what has been credited. */
interface Mine { cycleId: string; winner: string | null; staked: number; payout: number; paid: number; at: number }

/**
 * What the pop-up says for this player: won (the credited amount once
 * `payout_success` lands, the declared one until then), lost (a stake with
 * nothing back), or nothing (no bet on this round).
 */
export function roundOutcome(m: Mine | null): { kind: 'won' | 'lost' | 'none'; amount: number } {
  if (!m) return { kind: 'none', amount: 0 };
  const won = m.paid > 0 ? m.paid : m.payout;
  if (won > 0) return { kind: 'won', amount: won };
  if (m.staked > 0) return { kind: 'lost', amount: m.staked };
  return { kind: 'none', amount: 0 };
}

/**
 * Over the board on the result: who won, large, and ONE line for this player's
 * whole round (owner, 2026-10-10: one pop-up per player per cycle, however
 * many bets). The figure is `round_result`, which the server sends the moment
 * the winner is declared, summed over all their bets and net of the fee; the
 * `payout_success` settlement sends later replaces it with what was credited.
 * A result that lands after a short board has opened its next round shows on
 * its own, for `LATE_PAYOUT_MS`, with the winner it names.
 */
export const ResultCelebration: React.FC<{ cycleId?: string; result: { cycleId?: string; winner?: string | null } | null }> = ({ cycleId, result }) => {
  const [mine, setMine] = useState<Mine | null>(null);
  const [, tick] = useState(0);
  const cycleRef = useRef(cycleId);
  cycleRef.current = cycleId;
  useEffect(() => {
    const onRound = (e: Event) => {
      const d = (e as CustomEvent).detail as { cycleId: string; winner?: string | null; staked: number; payout: number } | undefined;
      if (!d || d.cycleId !== cycleRef.current) return;
      e.preventDefault(); // shown here, so no toast as well
      setMine(prev => ({
        cycleId: d.cycleId, winner: d.winner ?? null, staked: d.staked, payout: d.payout, at: Date.now(),
        paid: prev && prev.cycleId === d.cycleId ? prev.paid : 0,
      }));
    };
    const onPaid = (e: Event) => {
      const d = (e as CustomEvent).detail as { cycleId: string; amount: number; winner?: string | null } | undefined;
      if (!d || !(d.amount > 0)) return;
      setMine(prev => prev && prev.cycleId === d.cycleId
        ? { ...prev, paid: prev.paid + d.amount }
        : { cycleId: d.cycleId, winner: d.winner ?? null, staked: 0, payout: 0, paid: d.amount, at: Date.now() });
    };
    window.addEventListener(MY_ROUND_EVENT, onRound);
    window.addEventListener(MY_PAYOUT_EVENT, onPaid);
    return () => {
      window.removeEventListener(MY_ROUND_EVENT, onRound);
      window.removeEventListener(MY_PAYOUT_EVENT, onPaid);
    };
  }, []);
  // Take the late banner down when its time is up.
  useEffect(() => {
    if (!mine) return;
    const id = setTimeout(() => tick(n => n + 1), LATE_PAYOUT_MS + 50);
    return () => clearTimeout(id);
  }, [mine]);

  const late = mine && Date.now() - mine.at < LATE_PAYOUT_MS ? mine : null;
  const winner = result?.winner === 'DELHI' || result?.winner === 'BOMBAY' ? result.winner : (late && !result ? late.winner : null);
  const outcome = roundOutcome(result
    ? (mine && result.cycleId && mine.cycleId === result.cycleId ? mine : null)
    : late);
  const shown = useCountUp(outcome.kind === 'won' ? outcome.amount : 0);
  if (winner !== 'DELHI' && winner !== 'BOMBAY') return null;
  const tone = winner === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)';
  return (
    <div role="status" aria-live="polite" style={{ position: 'absolute', inset: 0, zIndex: 7, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 20, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(2px)', pointerEvents: 'none', textAlign: 'center', padding: 12 }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.22em', color: 'rgba(255,255,255,.7)' }}>{result ? 'RESULT' : 'LAST ROUND'}</span>
      <span className="font-grotesk" style={{ fontWeight: 800, fontSize: 34, letterSpacing: '.08em', color: tone, textShadow: '0 2px 18px rgba(0,0,0,.8)' }}>
        🏆 {winner === 'DELHI' ? 'DELHI' : 'BOMBAY'} {result ? 'WINS' : 'WON'}
      </span>
      {outcome.kind === 'won' && (
        <>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.16em', color: 'var(--green)', marginTop: 6 }}>YOU WON</span>
          <span className="font-grotesk" style={{ fontWeight: 800, fontSize: 40, color: 'var(--green)', fontVariantNumeric: 'tabular-nums' }}>₹{fmt(shown)}</span>
        </>
      )}
      {outcome.kind === 'lost' && (
        <>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.16em', color: 'rgba(255,255,255,.7)', marginTop: 6 }}>NOT THIS ROUND</span>
          <span className="font-grotesk" style={{ fontWeight: 800, fontSize: 22, color: 'rgba(255,255,255,.85)', fontVariantNumeric: 'tabular-nums' }}>Your ₹{fmt(outcome.amount)} bet did not win</span>
        </>
      )}
    </div>
  );
};

// ── Promo cards ──────────────────────────────────────────────────────────────
/** The screen a width belongs to, from the server's list; null if none. */
export function promoDeviceFor(vw: number, devices: PromoDevice[]): PromoDevice | null {
  return devices.find(d => vw >= d.minWidth && (d.maxWidth === null || vw <= d.maxWidth)) ?? null;
}

/**
 * The published home cards that have an image for THIS screen, most important
 * first, each with that image and the screen's frame; [] when off. A card with
 * no image for this screen is not shown here (owner, 2026-10-10: each device
 * its own design). Follows the width as the window is resized or turned.
 */
export function useHomeCards(enabled: boolean): HomeCard[] {
  const { vw } = useViewport();
  const [data, setData] = useState<{ cards: HomePromoCard[]; devices: PromoDevice[] }>({ cards: [], devices: [] });
  useEffect(() => {
    if (!enabled) { setData({ cards: [], devices: [] }); return; }
    let alive = true;
    getBackend().getHomeCards()
      .then(d => { if (alive) setData(d); })
      .catch(() => { if (alive) setData({ cards: [], devices: [] }); });
    return () => { alive = false; };
  }, [enabled]);
  const device = promoDeviceFor(vw, data.devices);
  if (!enabled || !device) return [];
  return data.cards
    .filter(c => c.images?.[device.key])
    .map(c => ({ promoId: c.promoId, title: c.title, linkUrl: c.linkUrl, image: c.images[device.key], ratio: device.ratio }));
}

/**
 * Tablet, phone and small phone: the cards as a carousel right under the
 * header (owner, 2026-10-10). One card fills the width in its screen's own
 * frame; the next one is seen only by swiping. The dots sit on the card and
 * take you to one.
 */
export const PromoCarousel: React.FC<{ cards: HomeCard[] }> = ({ cards }) => {
  const track = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState(0);
  if (cards.length === 0) return null;
  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    setAt(Math.max(0, Math.min(cards.length - 1, Math.round(el.scrollLeft / el.clientWidth))));
  };
  const goTo = (i: number) => {
    const el = track.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };
  return (
    <section aria-label="Promotions" style={{ flex: 'none', padding: '10px 14px 4px' }}>
      <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line)', boxShadow: 'var(--shadow-sm)' }}>
        <div ref={track} onScroll={onScroll} className="bb-noscroll" style={{
          display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain', WebkitOverflowScrolling: 'touch',
        }}>
          {cards.map((c, i) => (
            <div key={c.promoId ?? c.id ?? i} style={{ flex: '0 0 100%', scrollSnapAlign: 'start', scrollSnapStop: 'always' }}>
              <PromoCard card={c} rounded={false} />
            </div>
          ))}
        </div>
        {cards.length > 1 && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 6, display: 'flex', justifyContent: 'center', gap: 5, pointerEvents: 'none' }}>
            {cards.map((c, i) => (
              <button key={c.promoId ?? c.id ?? i} type="button" onClick={() => goTo(i)} aria-label={`Promotion ${i + 1} of ${cards.length}`} aria-current={i === at ? 'true' : undefined}
                style={{ pointerEvents: 'auto', width: i === at ? 16 : 6, height: 6, padding: 0, border: 'none', borderRadius: 999, cursor: 'pointer', background: i === at ? 'var(--gold)' : 'rgba(255,255,255,.55)', boxShadow: '0 0 4px rgba(0,0,0,.6)', transition: 'width .2s' }} />
            ))}
          </div>
        )}
      </div>
    </section>
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
