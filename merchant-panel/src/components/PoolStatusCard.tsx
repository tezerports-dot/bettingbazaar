// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The big card at the top of Home (owner, 2026-10-22): the pool's tokens out
// of its size ("1 / 100"), a bar of that share which can pass 100%, and under
// it four small cards: locked in open buys, locked in disputes (buy and sell
// together), incoming from sells, and today's earnings.
//
// The size is the security deposit: the tokens bought from the platform, and
// nothing else makes it bigger (`toPoolStanding`, teamPools.js). Commission
// and the sells a merchant pays back come into the balance, so it can stand
// above 100%; buy orders then come first, which is how that profit is taken
// out. Below 100%, the part used is what sells can come in for.
//
// Every figure is the server's (GET /merchant/stats `money`, GET
// /merchant/earnings); the words under the bar are display only (§11).
import React from 'react';
import { formatTokens } from '../utils/rail';
import type { MerchantMoney } from '../types';
import { cardStyle } from './ui';

const tokensOf = (paise: number) => formatTokens((Number(paise) || 0) / 100);

/** What the bar's share means for the orders this pool gets. §11: words only; routing is the server's. */
export function poolMeaning(standing: { sizePaise: number; leftPercent: number; sellRoomPaise: number }): string {
  if (!(standing.sizePaise > 0)) return 'Buy tokens from the admin to set your pool size and start taking orders.';
  if (standing.leftPercent > 100) {
    return 'Above your pool size: buy orders come to you first, so your profit goes out to players and you collect it in cash.';
  }
  if (standing.sellRoomPaise > 0) {
    return `You can receive up to ${tokensOf(standing.sellRoomPaise)} in sell orders now. To take bigger orders, buy more tokens from the admin.`;
  }
  return 'Your pool is full: buy orders come to you, and sells come once your buys have used some of it.';
}

const SubCard: React.FC<{ label: string; value: string; hint: string; tone?: string }> = ({ label, value, hint, tone }) => (
  <div style={{ background: 'var(--surface-2)', borderRadius: 13, padding: 12, minWidth: 0 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{label}</div>
    <div className="bb-mono" style={{ fontSize: 17, fontWeight: 800, color: tone ?? 'var(--text)', marginTop: 3 }}>{value}</div>
    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.35 }}>{hint}</div>
  </div>
);

export interface PoolStatusCardProps {
  pool: MerchantMoney['pool'] | null | undefined;
  /** Today's commission, in tokens (GET /merchant/earnings `todayEarned`); null while unknown. */
  todayEarned: number | null;
  /** Why today's earnings read what they do (§26), or null. */
  earningsNote: string | null;
  /** Shown where there is no pool: why, and where to go. */
  noPoolLine: string;
  /** The online switch, drawn in the card's corner. */
  status: React.ReactNode;
}

export const PoolStatusCard: React.FC<PoolStatusCardProps> = ({ pool, todayEarned, earningsNote, noPoolLine, status }) => {
  const standing = pool?.standing ?? null;
  const exposure = pool?.exposure ?? null;
  const percent = standing ? standing.leftPercent : 0;
  const over = percent > 100;
  const barColor = over ? 'var(--ok)' : percent >= 40 ? 'var(--dep)' : percent >= 15 ? 'var(--warn)' : 'var(--danger)';
  const disputedPaise = exposure ? exposure.heldDisputedPaise + exposure.sellsDisputedPaise : 0;

  return (
    <section
      aria-label="Pool status"
      style={{ ...cardStyle, padding: 20, minHeight: '33vh', display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            Pool tokens
          </div>
          {standing ? (
            <div className="bb-mono" style={{ fontSize: 30, fontWeight: 800, color: 'var(--text)', letterSpacing: '-1px', marginTop: 4 }}>
              {tokensOf(standing.leftPaise)}
              <span style={{ fontSize: 18, color: 'var(--muted)', fontWeight: 700 }}> / {tokensOf(standing.sizePaise)}</span>
            </div>
          ) : (
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-2)', marginTop: 6 }}>{noPoolLine}</div>
          )}
        </div>
        {status}
      </div>

      {standing && (
        <div>
          <div
            role="progressbar"
            aria-label="Pool balance against pool size"
            aria-valuemin={0}
            aria-valuemax={Math.max(100, percent)}
            aria-valuenow={percent}
            style={{ height: 12, borderRadius: 7, background: 'var(--surface-2)', overflow: 'hidden', border: '1px solid var(--border-2)' }}
          >
            <div style={{ width: `${Math.min(100, Math.max(0, percent))}%`, height: '100%', background: barColor, borderRadius: 7, transition: 'width .4s ease' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 6, fontSize: 12, fontWeight: 700 }}>
            <span style={{ color: barColor }}>{percent}% of your pool size</span>
            <span style={{ color: 'var(--muted)' }}>Pool size {tokensOf(standing.sizePaise)}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6, lineHeight: 1.45 }}>{poolMeaning(standing)}</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 'auto' }}>
        {exposure && (<>
          <SubCard label="Locked in open buys" value={tokensOf(exposure.heldOpenPaise)}
            hint={`${exposure.openBuys} open buy order${exposure.openBuys === 1 ? '' : 's'}; paid out when each completes`} />
          <SubCard label="Locked in disputes" value={tokensOf(disputedPaise)}
            hint="Buys and sells in dispute; released when an admin decides"
            tone={disputedPaise > 0 ? 'var(--warn)' : undefined} />
          <SubCard label="Incoming from sells" value={tokensOf(exposure.sellsSettlingPaise)}
            hint="Sells you paid; added to the pool when the hold window ends" />
        </>)}
        <SubCard label="Today's earnings" value={todayEarned === null ? '—' : formatTokens(todayEarned)}
          hint={earningsNote ?? 'Commission, added when each order completes'} tone="var(--dep)" />
      </div>
    </section>
  );
};

export default PoolStatusCard;
