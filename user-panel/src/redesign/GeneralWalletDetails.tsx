// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The General wallet, explained (owner, 2026-10-15: "show a bit better how
 * much they can withdraw and proper detailed explanation with example").
 *
 * `unlockPlan` is a UI-only mirror (§11) of the unlock rule that
 * `database/repositories/promo.js` (`recordTurnoverWithin`) owns:
 *   • every bonus needs `turnoverMultiplier` × its amount played from General;
 *   • stakes count towards the OLDEST open bonus first;
 *   • a bonus whose play is complete moves up to its own amount from General
 *     into withdrawable winnings;
 *   • once no bonus is still open, everything left in General moves too.
 * It only reads the figures `GET /api/user/general` sends; it decides nothing.
 */
import React, { useState } from 'react';
import { fmt } from './format';
import type { GeneralSummary } from './ProfileSwitch';

type GrantRow = NonNullable<GeneralSummary['grants']>[number];

/** What a bonus is called on the player's screen, by `promo_grants.source`. */
export const SOURCE_LABEL: Record<string, string> = {
  REFERRAL: 'Referral bonus',
  FIRST_DEPOSIT: 'First deposit bonus',
};
export const sourceLabel = (source?: string) => SOURCE_LABEL[source ?? ''] ?? 'Bonus';

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface UnlockPlan {
  /** General money is never withdrawn as it stands: always 0, said plainly. */
  withdrawableNow: 0;
  /** Play left before ANY money moves, and how much the first move is. */
  next: { label: string; playLeft: number; unlocks: number } | null;
  /** Play left before everything in General is withdrawable. */
  playLeftForAll: number;
  /** Moved from General into winnings so far, across every bonus. */
  unlockedSoFar: number;
  /** Open bonuses, oldest first (the order play is counted in). */
  open: GrantRow[];
}

export function unlockPlan(general: GeneralSummary): UnlockPlan {
  const grants = general.grants ?? [];
  const open = grants
    .filter((g) => !g.completedAt && g.requiredTurnover > 0)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const oldest = open[0];
  return {
    withdrawableNow: 0,
    next: oldest
      ? {
          label: sourceLabel(oldest.source),
          playLeft: r2(Math.max(0, oldest.requiredTurnover - oldest.turnover)),
          // A single open bonus is also the last one: then the whole balance moves.
          unlocks: open.length === 1 ? general.promoBalance : Math.min(oldest.amount ?? 0, general.promoBalance),
        }
      : null,
    playLeftForAll: general.outstandingTurnover,
    unlockedSoFar: r2(grants.reduce((a, g) => a + (g.unlocked ?? 0), 0)),
    open,
  };
}

const stat = (label: string, value: string, note: string, tone = 'var(--text)') => (
  <div style={{ flex: '1 1 140px', minWidth: 0, padding: '10px 12px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--line)' }}>
    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)' }}>{label}</div>
    <div className="font-grotesk" style={{ fontSize: 20, fontWeight: 700, color: tone, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.4 }}>{note}</div>
  </div>
);

/** The figures that answer "how much can I withdraw, and when". */
export const GeneralWithdrawable: React.FC<{ general: GeneralSummary }> = ({ general }) => {
  const plan = unlockPlan(general);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      {stat('Withdrawable now', '₹0', 'General money is withdrawn only after it unlocks into your winnings.')}
      {plan.next
        ? stat('Unlocks next', `₹${fmt(plan.next.unlocks)}`,
            `after ₹${fmt(plan.next.playLeft)} more is bet from General (${plan.next.label.toLowerCase()}).`, 'var(--green)')
        : stat('Unlocks next', '—', 'No bonus is waiting to unlock.')}
      {plan.open.length > 1 && stat('Everything unlocks', `₹${fmt(plan.playLeftForAll)}`,
        'more to bet, then all of General moves to winnings.')}
      {plan.unlockedSoFar > 0 && stat('Unlocked so far', `₹${fmt(plan.unlockedSoFar)}`,
        'already moved to your winnings, which you can withdraw.', 'var(--gold-ink)')}
    </div>
  );
};

/** Each bonus with its play progress, newest first. */
export const GeneralBonusList: React.FC<{ general: GeneralSummary }> = ({ general }) => {
  const grants = (general.grants ?? []).slice(0, 6);
  if (grants.length === 0) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text2)', marginBottom: 6 }}>Your bonuses</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {grants.map((g, i) => {
          const pct = g.requiredTurnover > 0 ? Math.min(100, Math.floor((g.turnover / g.requiredTurnover) * 100)) : 100;
          return (
            <li key={g.grantId ?? i} style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                <span style={{ fontWeight: 800, color: 'var(--text)' }}>{sourceLabel(g.source)} · ₹{fmt(g.amount ?? 0)}</span>
                <span style={{ color: g.completedAt ? 'var(--green)' : 'var(--text3)', fontVariantNumeric: 'tabular-nums' }}>
                  {g.completedAt ? `Unlocked ₹${fmt(g.unlocked ?? 0)}` : `₹${fmt(g.turnover)} of ₹${fmt(g.requiredTurnover)} bet`}
                </span>
              </div>
              {!g.completedAt && (
                <div role="progressbar" aria-label={`${sourceLabel(g.source)} play progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
                  style={{ marginTop: 6, height: 6, borderRadius: 999, background: 'var(--surface3)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)' }} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** How General works, with a worked example in the admin's own multiplier. */
export const GeneralHowItWorks: React.FC<{ multiplier: number }> = ({ multiplier }) => {
  const [open, setOpen] = useState(false);
  const m = Math.max(1, multiplier || 1);
  const bonus = 100;
  const need = bonus * m;
  const li: React.CSSProperties = { marginBottom: 6 };
  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 800, color: 'var(--green)' }}>
        {open ? '▾' : '▸'} How General works and how your withdrawable amount is decided
      </button>
      {open && (
        <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6, marginTop: 8 }}>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            <li style={li}><strong>Bonuses land in General.</strong> Referral rewards and your first deposit bonus go into General, never into VIP. General money can be bet, but not withdrawn as it is.</li>
            <li style={li}><strong>Every bonus has the same {m}× rule.</strong> Before a bonus unlocks, you bet {m} times its amount from General. A bet counts when its round settles, win or lose.</li>
            <li style={li}><strong>Wins stay in General</strong> until they unlock, and you can bet them again. Those bets count too.</li>
            <li style={li}><strong>Oldest bonus first.</strong> With more than one bonus, your bets count towards the oldest one until it is done, then the next.</li>
            <li style={li}><strong>When a bonus is done</strong>, its amount moves from General into your winnings (or what General holds, if that is less). Winnings are what you can withdraw.</li>
            <li style={li}><strong>When no bonus is left to play</strong>, everything still in General moves into your winnings too.</li>
          </ol>
          <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--line)' }}>
            <div style={{ fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>Example</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li style={li}>You receive a ₹{fmt(bonus)} bonus. General shows ₹{fmt(bonus)}; withdrawable from it: ₹0. To unlock it you bet ₹{fmt(need)} in total ({m} × ₹{fmt(bonus)}).</li>
              <li style={li}>You bet ₹50 and win. The whole return goes back into General, and ₹50 of the ₹{fmt(need)} is done.</li>
              <li style={li}>You keep betting from General. Once ₹{fmt(need)} has been bet, the bonus is done. Say General then holds ₹180: everything in it, ₹180, moves into your winnings, because no other bonus is open, and you can withdraw it.</li>
              <li style={li}>If a second bonus were still open, only ₹{fmt(bonus)} would move now and the other ₹80 would follow when the second bonus is done.</li>
              <li style={li}>If General reaches ₹0 before ₹{fmt(need)} is bet, there is nothing left to unlock.</li>
            </ul>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)' }}>
            General and VIP players never play in the same pools. Buying tokens moves you back to your VIP wallet; your General balance stays where it is.
          </div>
        </div>
      )}
    </div>
  );
};
