// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The home screen's swipeable cards (owner, 2026-10-21): the pool, what it can
// take in sells, the disputes, and the commission. Each says in a bar how full
// or how far along it is, and a line of profit or loss from the business
// ledger (`businessLedger`, merchantLedger.js), so the merchant reads the cards
// without adding anything up.
//
// Every figure is the server's: the pool's standing and exposure from GET
// /merchant/stats (`toPoolStanding`, `poolExposureSql`), the commission from
// `toSummary`, the ledger's totals from GET /merchant/reports/ledger (the
// last seven days, for those who may read reports). The bands that colour a
// bar are display only (§11).
import React, { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatTokens } from '../utils/rail';
import type { BusinessLedger, MerchantMoney, PaymentOrder, TeamCommissionSummary } from '../types';
import { PoolBreakdown } from './PoolBreakdown';
import { cardStyle } from './ui';

const tokensOf = (paise: number) => formatTokens((Number(paise) || 0) / 100);
const signedTokens = (paise: number) => `${paise > 0 ? '+' : paise < 0 ? '−' : ''}${tokensOf(Math.abs(paise))}`;

/** A share 0–100 of `part` in `whole`, 0 when there is no whole. */
export function percentOf(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 1000) / 10));
}

/** §11: display bands only; routing asks the server, never this. */
export function poolTone(leftPercent: number): { color: string; word: string } {
  if (leftPercent >= 40) return { color: 'var(--ok)', word: 'Healthy' };
  if (leftPercent >= 15) return { color: 'var(--warn)', word: 'Running low' };
  return { color: 'var(--danger)', word: 'Nearly empty' };
}

export const ProgressBar: React.FC<{ percent: number; color: string; label: string }> = ({ percent, color, label }) => (
  <div
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent}
    style={{ height: 10, borderRadius: 6, background: 'var(--surface-2)', overflow: 'hidden', border: '1px solid var(--border-2)' }}
  >
    <div style={{ width: `${percent}%`, height: '100%', background: color, borderRadius: 6, transition: 'width .4s ease' }} />
  </div>
);

/** The ledger's line on a card: what it gained or lost over the ledger's days. */
const LedgerLine: React.FC<{ label: string; paise: number | null }> = ({ label, paise }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, fontWeight: 700, marginTop: 12,
    paddingTop: 10, borderTop: '1px solid var(--border-2)' }}>
    <span style={{ color: 'var(--muted)' }}>{label} · last 7 days</span>
    <span className="bb-mono" style={{ color: paise === null ? 'var(--muted)' : paise >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
      {paise === null ? '—' : signedTokens(paise)}
    </span>
  </div>
);

interface HomeCard { key: string; title: string; body: React.ReactNode }

export interface HomeCardsProps {
  money: MerchantMoney | null | undefined;
  commission: TeamCommissionSummary | null | undefined;
  /** The last seven days of the ledger, or null for a sub-member who may not read reports. */
  ledger: BusinessLedger | null;
  /** The merchant's disputed orders, from the live queue. */
  disputes: PaymentOrder[];
  onOpenOrder: (order: PaymentOrder) => void;
}

export const HomeCards: React.FC<HomeCardsProps> = ({ money, commission, ledger, disputes, onOpenOrder }) => {
  const t = ledger?.totals ?? null;
  const pool = money?.pool ?? null;
  const standing = pool?.standing ?? null;
  const cards: HomeCard[] = [];

  if (pool && standing) {
    const tone = poolTone(standing.leftPercent);
    cards.push({
      key: 'pool', title: 'Pool status',
      body: (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span className="bb-mono" style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{tokensOf(standing.leftPaise)}</span>
            <span style={{ fontSize: 12, fontWeight: 800, color: tone.color }}>{tone.word} · {standing.leftPercent}% left</span>
          </div>
          <ProgressBar percent={standing.leftPercent} color={tone.color} label="Pool left" />
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', margin: '6px 0 12px' }}>
            Left of a {tokensOf(standing.sizePaise)} pool · {tokensOf(standing.heldPaise)} held for buys · {tokensOf(standing.consumedPaise)} paid out to players
          </div>
          <PoolBreakdown exposure={pool.exposure} availablePaise={pool.availablePaise} />
          {t && <LedgerLine label="Net profit" paise={t.netProfitPaise} />}
        </>
      ),
    });
    const sellUsed = percentOf(standing.sellsOwedPaise, standing.consumedPaise);
    cards.push({
      key: 'sells', title: 'Pool size and sell capacity',
      body: (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
            {[
              { label: 'Pool size', value: standing.sizePaise },
              { label: 'Consumed', value: standing.consumedPaise },
              { label: 'Sell room', value: standing.sellRoomPaise },
            ].map((f) => (
              <div key={f.label} style={{ background: 'var(--surface-2)', borderRadius: 11, padding: 10 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>{f.label}</div>
                <div className="bb-mono" style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>{tokensOf(f.value)}</div>
              </div>
            ))}
          </div>
          <ProgressBar percent={sellUsed} color={sellUsed >= 85 ? 'var(--warn)' : 'var(--wd)'} label="Sell capacity in use" />
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
            {sellUsed}% of what your buys paid out is already owed back by open sells ({tokensOf(standing.sellsOwedPaise)}).
            Sells first go to a pool whose room covers them, so {tokensOf(standing.sellRoomPaise)} more can come to you.
          </div>
          {t && <LedgerLine label="Net with players" paise={t.netUserPaise} />}
        </>
      ),
    });
  }

  const lost = ledger?.disputes.filter((d) => d.lostBy === 'MERCHANT').length ?? 0;
  const decided = ledger?.disputes.filter((d) => d.decision !== null).length ?? 0;
  const lockedInDisputes = (pool?.exposure.heldDisputedPaise ?? 0) + (pool?.exposure.sellsDisputedPaise ?? 0);
  cards.push({
    key: 'disputes', title: 'Disputes',
    body: (
      <>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
          <span className="bb-mono" style={{ fontSize: 22, fontWeight: 800, color: disputes.length ? 'var(--dispute)' : 'var(--text)' }}>
            {disputes.length} open
          </span>
          {pool && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>{tokensOf(lockedInDisputes)} locked</span>}
        </div>
        {ledger && (
          <>
            <ProgressBar percent={percentOf(decided - lost, decided)} color="var(--ok)" label="Disputes decided for you" />
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', margin: '6px 0 10px' }}>
              {decided === 0 ? 'No dispute decided in the last 7 days.' : `${decided - lost} of ${decided} decided for you in the last 7 days.`}
            </div>
          </>
        )}
        {disputes.length === 0 ? (
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>No order of yours is in dispute.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {disputes.slice(0, 4).map((order) => (
              <button
                key={String(order.orderId || order._id)}
                type="button"
                onClick={() => onOpenOrder(order)}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '9px 11px', borderRadius: 10,
                  border: '1px solid var(--border-2)', background: 'var(--dispute-bg)', cursor: 'pointer', textAlign: 'left' }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
                  {order.type === 'DEPOSIT' ? 'Buy' : 'Sell'} · {formatTokens(order.tokenAmount)}
                </span>
                <span className="bb-mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{order.orderId}</span>
              </button>
            ))}
          </div>
        )}
        {t && <LedgerLine label="Compensation paid" paise={-t.compensationPaise} />}
      </>
    ),
  });

  if (commission) {
    const earned = commission.paidPaise + commission.owedPaise;
    cards.push({
      key: 'commission', title: 'Commission',
      body: (
        <>
          <div className="bb-mono" style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>{tokensOf(commission.paidPaise)} paid</div>
          <ProgressBar percent={percentOf(commission.paidPaise, earned)} color="var(--dep)" label="Commission paid of earned" />
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
            {commission.owedPaise > 0
              ? `${tokensOf(commission.owedPaise)} earned and waiting for the platform's commission pool.`
              : 'Everything earned is paid into the pool.'}
            {' '}{commission.depositPercent}% of each completed buy, {commission.withdrawalPercent}% of each completed sell.
          </div>
          {t && <LedgerLine label="Net commission" paise={t.netCommissionPaise} />}
        </>
      ),
    });
  }

  return <Carousel cards={cards} />;
};

/** Cards side by side that a finger swipes (scroll snap), with arrows and dots for a mouse and a screen reader. */
const Carousel: React.FC<{ cards: HomeCard[] }> = ({ cards }) => {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const go = (next: number) => {
    const i = Math.max(0, Math.min(cards.length - 1, next));
    const el = track.current?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    setIndex(i);
  };
  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    const first = el.children[0] as HTMLElement | undefined;
    const step = (first?.offsetWidth ?? el.clientWidth) + 12;
    setIndex(Math.max(0, Math.min(cards.length - 1, Math.round(el.scrollLeft / step))));
  };
  const arrow = (dir: -1 | 1) => (
    <button
      type="button"
      aria-label={dir < 0 ? 'Previous card' : 'Next card'}
      disabled={dir < 0 ? index === 0 : index === cards.length - 1}
      onClick={() => go(index + dir)}
      style={{ width: 30, height: 30, borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)',
        color: 'var(--text)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {dir < 0 ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
    </button>
  );

  return (
    <section aria-roledescription="carousel" aria-label="Your pool at a glance">
      <div
        ref={track}
        onScroll={onScroll}
        style={{ display: 'flex', gap: 12, overflowX: 'auto', scrollSnapType: 'x mandatory', scrollbarWidth: 'none', paddingBottom: 2 }}
      >
        {cards.map((card, i) => (
          <div
            key={card.key}
            role="group"
            aria-roledescription="slide"
            aria-label={`${card.title}, ${i + 1} of ${cards.length}`}
            style={{ ...cardStyle, padding: 18, flex: '0 0 min(100%, 520px)', scrollSnapAlign: 'start', minWidth: 0 }}
          >
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)', marginBottom: 12 }}>{card.title}</div>
            {card.body}
          </div>
        ))}
      </div>
      {cards.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 10 }}>
          {arrow(-1)}
          <div style={{ display: 'flex', gap: 6 }}>
            {cards.map((card, i) => (
              <button
                key={card.key}
                type="button"
                aria-label={`Show ${card.title}`}
                aria-current={i === index}
                onClick={() => go(i)}
                style={{ width: i === index ? 18 : 8, height: 8, borderRadius: 4, border: 0, padding: 0, cursor: 'pointer',
                  background: i === index ? 'var(--brand)' : 'var(--border)', transition: 'width .2s ease' }}
              />
            ))}
          </div>
          {arrow(1)}
        </div>
      )}
    </section>
  );
};

export default HomeCards;
