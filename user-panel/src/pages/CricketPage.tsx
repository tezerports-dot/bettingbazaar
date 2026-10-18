// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * CricketPage.tsx — cricket opinion polls, sportsbook style (owner,
 * 2026-10-18; docs/reference/CRICKET_OPINION_DESIGN.md). The published
 * matches in the admin's order; on a match: the result, toss and man-of-the-
 * match polls, and for next ball and overs only the last settled, the live
 * one and the next. Odds move live (`cricket_odds`, at most once a second).
 *
 * A bet: tap odds → stake → "Get exact odds" asks the server → Confirm sends
 * those odds as the minimum → the server waits the in-play delay and places it
 * or answers with the new odds. A claim works the same way with a total.
 * Each position's live value is worked out here from the broadcast pools
 * (`cricketValue.ts`, a §11 display mirror); the server's quote is the figure.
 * Cricket plays the VIP wallet only.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import ScreenShell, { card, capLabel, goldButton, inputStyle } from '../redesign/Screen';
import { cricket as api } from '../services/api';
import type { CricketBet, CricketMatch, CricketOption, CricketPoll, ClaimQuote } from '../services/api/cricket';
import { getBackend } from '../services/backend.service';
import { useCricketSettings, useGame } from '../services/GameContext';
import { useShell } from '../redesign/RedesignShell';
import { useToast } from '../components/ui/Toast';
import { positionValuePaise } from '../redesign/cricketValue';
import { useHeaderLogo } from '../services/brandAssets';

const tokens = (paise: number) => (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const odds = (x100: number) => (x100 / 100).toFixed(2);
const newKey = () => {
  try { if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID(); } catch { /* older webview */ }
  return `ck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};
/** The server's sentence for a refusal, and the new figure when it sent one. */
const refusalOf = (e: any): { message: string; code?: string; quote?: any } => ({
  message: e?.data?.message || e?.message || 'That did not go through. Please try again.',
  code: e?.data?.code, quote: e?.data?.quote,
});

const Logo: React.FC<{ src: string | null; name: string; code?: string | null; size?: number }> = ({ src, name, code, size = 34 }) => (src
  ? <img src={src} alt="" width={size} height={size} style={{ width: size, height: size, objectFit: 'contain' }} loading="lazy" />
  : <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', background: 'var(--surface3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size / 2.6, fontWeight: 800, color: 'var(--text2)' }}>{(code || name.slice(0, 3)).toUpperCase()}</span>);

const scoreLine = (m: CricketMatch) => (m.score?.innings ?? [])
  .map((i) => `${i.team === 'A' ? (m.teamA.code ?? m.teamA.name) : (m.teamB.code ?? m.teamB.name)} ${i.runs}/${i.wickets} (${i.overs})`).join(' · ');
const isLive = (m: CricketMatch) => m.status === 'LIVE' || m.status === 'INNINGS_BREAK';

// ── Odds button ──────────────────────────────────────────────────────────────
const OddsButton: React.FC<{ option: CricketOption; poll: CricketPoll; onPick: (p: CricketPoll, o: CricketOption) => void }> = ({ option, poll, onPick }) => {
  const won = poll.status === 'SETTLED' && poll.winningOption === option.key;
  const open = poll.status === 'OPEN';
  return (
    <button type="button" disabled={!open} onClick={() => onPick(poll, option)} aria-label={`${option.label} at ${odds(option.oddsX100)}`}
      style={{
        flex: '1 1 92px', minWidth: 0, padding: '8px 6px', borderRadius: 10, cursor: open ? 'pointer' : 'default',
        border: `1px solid ${won ? 'var(--green)' : 'var(--line2)'}`,
        background: won ? 'color-mix(in srgb,var(--green) 18%,var(--surface2))' : 'var(--surface2)',
        opacity: open || won ? 1 : 0.55, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', gap: 2,
      }}>
      <span style={{ fontSize: 11, lineHeight: 1.25, color: 'var(--text2)', textAlign: 'center', overflowWrap: 'anywhere', maxWidth: '100%' }}>{option.label}</span>
      <span style={{ fontSize: 15, fontWeight: 800, color: won ? 'var(--green)' : 'var(--gold-ink)' }}>{open ? odds(option.oddsX100) : won ? 'Won' : '—'}</span>
    </button>
  );
};

const PollCard: React.FC<{ poll: CricketPoll | null; tag: string; placeholder?: string; onPick: (p: CricketPoll, o: CricketOption) => void }> = ({ poll, tag, placeholder, onPick }) => (
  <div style={{ ...card, padding: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{poll?.title ?? placeholder}</span>
      <span style={{ ...capLabel, color: tag === 'Live' ? 'var(--red)' : tag === 'Settled' ? 'var(--text3)' : 'var(--gold)' }}>{tag}</span>
    </div>
    {poll
      ? (
        <>
          {poll.status === 'VOID' && <p style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--text3)' }}>Void: {poll.voidReason}. Stakes returned.</p>}
          {poll.status === 'CLOSED' && <p style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--text3)' }}>Bets closed. The result settles it.</p>}
          {PLAYER_KINDS.has(poll.kind)
            ? byTeam(poll.options).map(([team, options]) => (
              <div key={team} style={{ marginBottom: 8 }}>
                <div style={{ ...capLabel, fontSize: 10, margin: '2px 0 6px' }}>{team}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(96px,1fr))', gap: 6 }}>
                  {options.map((o) => <OddsButton key={o.key} option={o} poll={poll} onPick={onPick} />)}
                </div>
              </div>
            ))
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {poll.options.map((o) => <OddsButton key={o.key} option={o} poll={poll} onPick={onPick} />)}
              </div>
            )}
        </>
      )
      : <p style={{ margin: 0, fontSize: 12, color: 'var(--text3)' }}>Opens when the live one is decided.</p>}
  </div>
);

/** The polls with one option per player, labelled "Name (Team)" by the server: drawn by team, name only. */
const PLAYER_KINDS = new Set(['MOM', 'TOP_BATSMAN', 'TOP_BOWLER']);
function byTeam(options: CricketOption[]): [string, CricketOption[]][] {
  const groups = new Map<string, CricketOption[]>();
  for (const o of options) {
    const m = /^(.*) \(([^()]*)\)$/.exec(o.label);
    const team = m ? m[2] : '';
    groups.set(team, [...(groups.get(team) ?? []), m ? { ...o, label: m[1] } : o]);
  }
  return [...groups.entries()];
}

/** For next ball and overs: the last settled, the live one and the next (owner, 2026-10-18). */
function threeOf(polls: CricketPoll[], kind: 'BALL' | 'OVER') {
  const mine = polls.filter((p) => p.kind === kind);
  const ended = mine.filter((p) => p.status === 'SETTLED' || p.status === 'VOID')[0] ?? null;
  if (kind === 'BALL') {
    return { settled: ended, live: mine.find((p) => p.status === 'OPEN' || p.status === 'CLOSED') ?? null, next: null };
  }
  return {
    settled: ended,
    live: mine.find((p) => p.status === 'CLOSED') ?? null,
    next: mine.find((p) => p.status === 'OPEN') ?? null,
  };
}

// ── Bet slip ─────────────────────────────────────────────────────────────────
type SlipState = { poll: CricketPoll; option: CricketOption };
const BetSlip: React.FC<{ slip: SlipState; onClose: () => void; onPlaced: () => void }> = ({ slip, onClose, onPlaced }) => {
  const settings = useCricketSettings();
  const { addToast } = useToast();
  const [stake, setStake] = useState(String(Math.max(settings.minStake, 100)));
  const [quote, setQuote] = useState<{ oddsX100: number; potentialPaise: number } | null>(null);
  const [busy, setBusy] = useState<'quote' | 'place' | null>(null);
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  const amount = Math.floor(Number(stake) || 0);
  const chips = [settings.minStake, 100, 500, 1000, 5000].filter((c, i, a) => c >= settings.minStake && c <= settings.maxStake && a.indexOf(c) === i);

  const getQuote = async () => {
    setBusy('quote'); setError(''); setQuote(null);
    try { setQuote(await api.quoteBet(slip.poll.pollId, slip.option.key, amount)); }
    catch (e) { setError(refusalOf(e).message); }
    finally { setBusy(null); }
  };
  const confirm = async () => {
    if (!quote) return;
    setBusy('place'); setError('');
    try {
      const r = await api.placeBet({ pollId: slip.poll.pollId, optionKey: slip.option.key, stake: amount, minOdds: quote.oddsX100, idempotencyKey: key });
      addToast(`Bet placed at ${odds(r.bet.oddsX100)}`, 'success');
      onPlaced(); onClose();
    } catch (e) {
      const r = refusalOf(e);
      setError(r.message);
      if (r.quote?.oddsX100) setQuote({ oddsX100: r.quote.oddsX100, potentialPaise: r.quote.potentialPaise });
      else setQuote(null);
    } finally { setBusy(null); }
  };

  return (
    <div role="dialog" aria-label="Bet slip" style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: '100%', maxWidth: 480, borderRadius: '18px 18px 0 0', padding: 18, paddingBottom: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <div style={capLabel}>{slip.poll.title}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>{slip.option.label}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, color: 'var(--text3)' }}>Live odds</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--gold-ink)' }}>{odds(slip.option.oddsX100)}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close the bet slip"
              style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--line)', background: 'transparent', color: 'var(--text2)', fontSize: 16, cursor: 'pointer' }}>✕</button>
          </div>
        </div>
        <label htmlFor="cricket-stake" style={{ ...capLabel, display: 'block', marginTop: 14, marginBottom: 6 }}>Stake (tokens)</label>
        <input id="cricket-stake" inputMode="numeric" style={inputStyle} value={stake}
          onChange={(e) => { setStake(e.target.value.replace(/\D/g, '')); setQuote(null); }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {chips.map((c) => (
            <button key={c} type="button" onClick={() => { setStake(String(c)); setQuote(null); }}
              style={{ padding: '6px 12px', borderRadius: 999, border: '1px solid var(--line2)', background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' }}>{c}</button>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: '8px 0 0' }}>
          {settings.minStake} to {settings.maxStake.toLocaleString('en-IN')} tokens, from your VIP wallet. Odds on screen are live and may move;
          you confirm the exact odds, and the bet is placed {settings.inPlayDelaySec} s later at those odds or better.
        </p>
        {quote && (
          <div role="status" style={{ marginTop: 12, padding: 12, borderRadius: 12, background: 'var(--surface2)', border: '1px solid var(--line2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: 'var(--text2)' }}>Exact odds now</span><b style={{ color: 'var(--gold-ink)' }}>{odds(quote.oddsX100)}</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 4 }}>
              <span style={{ color: 'var(--text2)' }}>Pays if it wins (before the {settings.winningsFeePercent}% winnings fee)</span><b style={{ color: 'var(--text)' }}>{tokens(quote.potentialPaise)}</b>
            </div>
          </div>
        )}
        {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 12, margin: '10px 0 0' }}>{error}</p>}
        <div style={{ marginTop: 14 }}>
          {!quote
            ? <button type="button" style={goldButton} disabled={busy !== null || amount < settings.minStake || amount > settings.maxStake} onClick={getQuote}>{busy === 'quote' ? 'Checking…' : 'Get exact odds'}</button>
            : <button type="button" style={goldButton} disabled={busy !== null} onClick={confirm}>{busy === 'place' ? `Placing… (${settings.inPlayDelaySec} s in-play check)` : `Confirm at ${odds(quote.oddsX100)}`}</button>}
        </div>
      </div>
    </div>
  );
};

// ── Positions and Claim all ──────────────────────────────────────────────────
const Positions: React.FC<{ match: CricketMatch; bets: CricketBet[]; onClaimed: () => void }> = ({ match, bets, onClaimed }) => {
  const settings = useCricketSettings();
  const { addToast } = useToast();
  const [quote, setQuote] = useState<ClaimQuote | null>(null);
  const [busy, setBusy] = useState<'quote' | 'claim' | null>(null);
  const [error, setError] = useState('');
  const pollsById = useMemo(() => new Map(match.polls.map((p) => [p.pollId, p])), [match.polls]);

  const open = bets.filter((b) => b.status === 'OPEN');
  const rows = open.map((b) => {
    const poll = pollsById.get(b.pollId);
    const claimable = poll?.status === 'OPEN';
    const value = claimable ? positionValuePaise(poll.options, b, settings.claimMarginPercent, settings.winningsFeePercent) : null;
    return { b, claimable, value };
  });
  const claimableRows = rows.filter((r) => r.claimable);
  const net = claimableRows.reduce((t, r) => t + (r.value ?? 0) - r.b.stakePaise, 0);
  // One group per poll, so each poll's positions can be claimed on their own.
  const groups = useMemo(() => {
    const byPoll = new Map<string, { pollId: string; title: string; items: CricketBet[] }>();
    for (const b of bets) {
      const g = byPoll.get(b.pollId) ?? { pollId: b.pollId, title: b.pollTitle, items: [] };
      g.items.push(b);
      byPoll.set(b.pollId, g);
    }
    return [...byPoll.values()];
  }, [bets]);

  const getQuote = async (betIds?: string[]) => {
    setBusy('quote'); setError('');
    try {
      const q = await api.quoteClaim(betIds ? { betIds } : { matchId: match.matchId });
      // A bet placed moments ago is left out of the quote until the hold passes.
      if (!q.lines.length) { setQuote(null); setError(`A new bet can be claimed ${settings.claimHoldSec} s after it is placed. Try again in a moment.`); }
      else setQuote(q);
    }
    catch (e) { setError(refusalOf(e).message); }
    finally { setBusy(null); }
  };
  const confirm = async () => {
    if (!quote) return;
    setBusy('claim'); setError('');
    const betIds = quote.lines.map((l) => l.betId);
    try {
      const r = await api.claim({ betIds, minTotalPaise: quote.totalNetPaise });
      addToast(`Claimed ${tokens(r.totalNetPaise)} tokens`, 'success');
      setQuote(null); onClaimed();
    } catch (e) {
      const r = refusalOf(e);
      setError(r.message);
      setQuote(r.quote?.lines ? { ...r.quote, delaySec: settings.inPlayDelaySec } : null);
    } finally { setBusy(null); }
  };

  if (!bets.length) return null;
  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div>
          <div style={capLabel}>Your positions on this match</div>
          {claimableRows.length > 0 && (
            <div aria-live="polite">
              <div style={{ fontSize: 20, fontWeight: 800, color: net >= 0 ? 'var(--green)' : 'var(--red)' }}>{net >= 0 ? '+' : ''}{tokens(net)}</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>profit or loss if you claim everything now (live estimate)</div>
            </div>
          )}
        </div>
        {claimableRows.length > 0 && !quote && (
          <button type="button" onClick={() => getQuote()} disabled={busy !== null}
            style={{ ...goldButton, width: 'auto', padding: '10px 16px', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}>{busy === 'quote' ? 'Checking…' : 'Claim all'}</button>
        )}
      </div>
      {quote && (
        <div role="status" style={{ marginTop: 12, padding: 12, borderRadius: 12, background: 'var(--surface2)', border: '1px solid var(--line2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: 'var(--text2)' }}>You get now ({quote.lines.length} position{quote.lines.length === 1 ? '' : 's'}, after the fee)</span>
            <b style={{ color: 'var(--gold-ink)' }}>{tokens(quote.totalNetPaise)}</b>
          </div>
          <div style={{ fontSize: 12, color: quote.totalNetPaise - quote.totalStakePaise >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 4 }}>
            {quote.totalNetPaise - quote.totalStakePaise >= 0 ? 'Profit' : 'Loss'} {tokens(Math.abs(quote.totalNetPaise - quote.totalStakePaise))} on {tokens(quote.totalStakePaise)} staked
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={{ ...goldButton, padding: 11, fontSize: 13 }} disabled={busy !== null} onClick={confirm}>
              {busy === 'claim' ? `Claiming… (${settings.inPlayDelaySec} s check)` : `Confirm ${tokens(quote.totalNetPaise)}`}
            </button>
            <button type="button" onClick={() => setQuote(null)} style={{ padding: '0 14px', borderRadius: 12, border: '1px solid var(--line)', background: 'transparent', color: 'var(--text2)', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 12, margin: '10px 0 0' }}>{error}</p>}
      {settings.claimHoldSec > 0 && !error && (
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: '8px 0 0' }}>A new bet can be claimed {settings.claimHoldSec} s after it is placed.</p>
      )}
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {groups.map(({ pollId, title, items }) => {
          const claimIds = items.filter((b) => rows.find((r) => r.b.betId === b.betId)?.claimable).map((b) => b.betId);
          const groupValue = rows.filter((r) => r.claimable && r.b.pollId === pollId).reduce((t, r) => t + (r.value ?? 0), 0);
          return (
            <div key={pollId} style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', minWidth: 0 }}>{title}</span>
                {claimIds.length > 0 && !quote && (
                  <button type="button" onClick={() => getQuote(claimIds)} disabled={busy !== null} aria-label={`Claim ${title}`}
                    style={{ padding: '5px 12px', borderRadius: 999, border: '1px solid var(--gold)', background: 'transparent', color: 'var(--gold-ink)', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    Claim {tokens(groupValue)}
                  </button>
                )}
              </div>
              {items.map((b) => {
                const row = rows.find((r) => r.b.betId === b.betId);
                const pl = row?.value !== null && row?.value !== undefined ? row.value - b.stakePaise : null;
                return (
                  <div key={b.betId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, paddingTop: 3 }}>
                    <span style={{ color: 'var(--text2)', minWidth: 0 }}>
                      <b style={{ color: 'var(--text)' }}>{b.optionLabel}</b> · {tokens(b.stakePaise)} @ {odds(b.oddsX100)}
                    </span>
                    <span style={{ whiteSpace: 'nowrap', fontWeight: 700, color: b.status === 'OPEN' ? (pl === null ? 'var(--text3)' : pl >= 0 ? 'var(--green)' : 'var(--red)') : b.status === 'LOST' ? 'var(--red)' : 'var(--green)' }}>
                      {b.status === 'OPEN' ? (pl === null ? 'Awaiting result' : `${pl >= 0 ? '+' : ''}${tokens(pl)}`)
                        : b.status === 'LOST' ? 'Lost' : b.status === 'VOID' ? 'Returned' : `${b.status === 'CLAIMED' ? 'Claimed' : 'Won'} ${tokens(b.paidPaise)}`}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── Match ────────────────────────────────────────────────────────────────────
const MatchHeader: React.FC<{ m: CricketMatch; onClick?: () => void }> = ({ m, onClick }) => {
  const result = m.polls.find((p) => p.kind === 'MATCH_RESULT');
  return (
    <div style={{ ...card, padding: 14, cursor: onClick ? 'pointer' : 'default' }} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) onClick(); }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
        <span>{m.seriesName ?? m.format}</span>
        {isLive(m)
          ? <span style={{ color: 'var(--red)', fontWeight: 800 }}>● LIVE</span>
          : <span>{m.result ? 'Finished' : new Date(m.startsAt).toLocaleString('en-IN', { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><Logo src={m.teamA.logo} name={m.teamA.name} code={m.teamA.code} /><b style={{ color: 'var(--text)', fontSize: 14 }}>{m.teamA.name}</b></div>
        <span style={{ color: 'var(--text3)', fontSize: 12 }}>v</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexDirection: 'row-reverse' }}><Logo src={m.teamB.logo} name={m.teamB.name} code={m.teamB.code} /><b style={{ color: 'var(--text)', fontSize: 14 }}>{m.teamB.name}</b></div>
      </div>
      {scoreLine(m) && <div style={{ fontSize: 12, color: 'var(--gold-ink)', marginTop: 8, textAlign: 'center' }}>{scoreLine(m)}</div>}
      {m.toss && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, textAlign: 'center' }}>{(m.toss.winner === 'A' ? m.teamA : m.teamB).name} won the toss and chose to {m.toss.elected === 'BAT' ? 'bat' : 'bowl'}</div>}
      {m.result && (
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--green)', marginTop: 8, textAlign: 'center' }}>
          {m.result === 'A' ? `${m.teamA.name} won` : m.result === 'B' ? `${m.teamB.name} won` : m.result === 'TIE' ? 'Match tied' : m.result === 'DRAW' ? 'Match drawn' : 'No result'}
        </div>
      )}
      {onClick && result && !m.result && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {result.options.map((o) => (
            <div key={o.key} style={{ flex: 1, textAlign: 'center', padding: '6px 4px', borderRadius: 9, background: 'var(--surface2)', border: '1px solid var(--line)' }}>
              <div style={{ fontSize: 10, color: 'var(--text3)' }}>{o.key === 'A' ? '1' : o.key === 'B' ? '2' : o.label}</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--gold-ink)' }}>{result.status === 'OPEN' ? odds(o.oddsX100) : '—'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section style={{ marginBottom: 16 }}>
    <h2 style={{ ...capLabel, margin: '0 0 8px' }}>{title}</h2>
    <div style={{ display: 'grid', gap: 8, alignItems: 'start', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))' }}>{children}</div>
  </section>
);

const MatchView: React.FC<{ m: CricketMatch; bets: CricketBet[]; onPick: (p: CricketPoll, o: CricketOption) => void; onBack: () => void; reloadBets: () => void }> = ({ m, bets, onPick, onBack, reloadBets }) => {
  const byKind = (k: string) => m.polls.find((p) => p.kind === k) ?? null;
  const ball = threeOf(m.polls, 'BALL');
  const over = threeOf(m.polls, 'OVER');
  const players = (['MOM', 'TOP_BATSMAN', 'TOP_BOWLER'] as const).map(byKind).filter((p): p is CricketPoll => p !== null);
  const playerTag = (p: CricketPoll) => (p.status === 'OPEN' ? 'Open' : p.status === 'CLOSED' ? 'Awaiting' : p.status === 'VOID' ? 'Void' : 'Settled');
  return (
    <div>
      <button type="button" onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 13, marginBottom: 10, padding: 0 }}>← All matches</button>
      <MatchHeader m={m} />
      <div style={{ height: 14 }} />
      <Positions match={m} bets={bets.filter((b) => b.matchId === m.matchId)} onClaimed={reloadBets} />
      {(ball.settled || ball.live) && (
        <Section title="Next ball">
          {ball.settled && <PollCard poll={ball.settled} tag="Settled" onPick={onPick} />}
          <PollCard poll={ball.live} tag="Live" placeholder="Next ball" onPick={onPick} />
          <PollCard poll={null} tag="Next" placeholder="The ball after" onPick={onPick} />
        </Section>
      )}
      {(over.settled || over.live || over.next) && (
        <Section title="Overs: odd, even or zero">
          {over.settled && <PollCard poll={over.settled} tag="Settled" onPick={onPick} />}
          {over.live && <PollCard poll={over.live} tag="Live" onPick={onPick} />}
          <PollCard poll={over.next} tag="Next" placeholder="The next over" onPick={onPick} />
        </Section>
      )}
      <Section title="Match">
        {byKind('MATCH_RESULT') && <PollCard poll={byKind('MATCH_RESULT')} tag={byKind('MATCH_RESULT')!.status === 'OPEN' ? 'Open' : 'Settled'} onPick={onPick} />}
        {byKind('TOSS') && <PollCard poll={byKind('TOSS')} tag={byKind('TOSS')!.status === 'OPEN' ? 'Open' : 'Settled'} onPick={onPick} />}
      </Section>
      {players.length > 0 && (
        <Section title="Players">
          {players.map((p) => <PollCard key={p.pollId} poll={p} tag={playerTag(p)} onPick={onPick} />)}
        </Section>
      )}
    </div>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────
const CricketLive: React.FC = () => {
  const navigate = useNavigate();
  const settings = useCricketSettings();
  const { isAuthenticated } = useGame();
  const { openAuth } = useShell();
  const { addToast } = useToast();
  const [matches, setMatches] = useState<CricketMatch[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [bets, setBets] = useState<CricketBet[]>([]);
  const [slip, setSlip] = useState<SlipState | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setMatches((await api.matches()).matches ?? []); setError(''); }
    catch (e) { setError(refusalOf(e).message); setMatches((m) => m ?? []); }
  }, []);
  const loadBets = useCallback(async () => {
    if (!isAuthenticated) { setBets([]); return; }
    try { setBets((await api.myBets()).bets ?? []); } catch { /* shown again on the next refresh */ }
  }, [isAuthenticated]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadBets(); }, [loadBets]);
  useEffect(() => getBackend().subscribeToCricket(
    (d: any) => {
      if (!d?.matchId) return;
      setMatches((all) => all?.map((m) => (m.matchId === d.matchId
        ? { ...m, status: d.status ?? m.status, score: d.score ?? m.score, toss: d.toss ?? m.toss, result: d.result ?? m.result, polls: Array.isArray(d.polls) ? d.polls : m.polls }
        : m)) ?? all);
    },
    (d: any) => {
      if (d?.status === 'SETTLED' && d.paidPaise > 0) addToast(`Cricket: you won ${tokens(d.paidPaise)} tokens`, 'success');
      else if (d?.status === 'VOID') addToast('Cricket: a poll was void; your stake is back', 'info');
      void loadBets();
    },
  ), [addToast, loadBets]);

  const pick = (poll: CricketPoll, option: CricketOption) => {
    if (!isAuthenticated) { openAuth(); return; }
    setSlip({ poll, option });
  };
  const current = matches?.find((m) => m.matchId === openId) ?? null;

  return (
    <ScreenShell icon="🏏" title="Cricket" sub="Back your opinion on live matches. Odds move with the pools.">
      {matches === null && <p style={{ color: 'var(--text3)', fontSize: 13 }}>Loading matches…</p>}
      {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
      {matches && matches.length === 0 && (
        <div style={{ ...card, textAlign: 'center', padding: 28 }}>
          <div style={{ fontSize: 34 }}>🏏</div>
          <p style={{ color: 'var(--text2)', fontSize: 14, margin: '8px 0 14px' }}>No matches are open right now. Check back closer to the next game.</p>
          <button type="button" onClick={() => navigate('/')} style={{ ...goldButton, width: 'auto', padding: '10px 18px', fontSize: 13 }}>Back to the boards</button>
        </div>
      )}
      {current
        ? <MatchView m={current} bets={bets} onPick={pick} onBack={() => setOpenId(null)} reloadBets={loadBets} />
        : (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,320px),1fr))' }}>
            {matches?.map((m) => <MatchHeader key={m.matchId} m={m} onClick={() => setOpenId(m.matchId)} />)}
          </div>
        )}
      {matches && matches.length > 0 && (
        <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 16 }}>
          Cricket is played from your VIP wallet. Shown odds are live and for reference; you confirm exact odds before a bet, and a winning payout pays the {settings.winningsFeePercent}% winnings fee.
        </p>
      )}
      {slip && <BetSlip slip={slip} onClose={() => setSlip(null)} onPlaced={() => { void loadBets(); }} />}
    </ScreenShell>
  );
};

// ── Coming soon (the game switched off, the tab kept; owner, 2026-10-18) ─────
/**
 * The admin's full-screen picture (Branding.cricketComingSoonImageUrl, set on
 * Admin › Images), drawn over the whole screen with a way back; with none, a
 * plain line says it is coming.
 */
const COMING_POLLS = ['Toss', 'Match result', 'Next ball', 'Every over', 'Man of the match', 'Best batsman', 'Best bowler'];

const ComingSoon: React.FC = () => {
  const navigate = useNavigate();
  const headerLogo = useHeaderLogo();
  const imageUrl: string = (() => {
    try { return String(JSON.parse(localStorage.getItem('app_branding') || '{}').cricketComingSoonImageUrl || ''); } catch { return ''; }
  })();
  const [broken, setBroken] = useState(false);
  const back = (
    <button type="button" onClick={() => navigate('/')} aria-label="Back to the boards"
      style={{ position: 'absolute', top: 'max(12px, env(safe-area-inset-top))', left: 12, zIndex: 1, padding: '8px 14px', borderRadius: 999, border: '1px solid var(--pill-line)', background: 'var(--pill)', color: 'var(--gold-ink)', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: 'var(--shadow-sm)' }}>
      ← Back
    </button>
  );
  if (imageUrl && !broken) {
    return (
      <div role="dialog" aria-label="Cricket is coming soon" style={{ position: 'fixed', inset: 0, zIndex: 110, background: 'var(--bg)' }}>
        {back}
        <img src={imageUrl} alt="Cricket is coming soon" onError={() => setBroken(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
    );
  }
  // No picture set: the same full screen, drawn in the site's own theme.
  return (
    <div role="dialog" aria-label="Cricket is coming soon"
      style={{ position: 'fixed', inset: 0, zIndex: 110, background: 'var(--app-bg)', backgroundColor: 'var(--bg)', overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '72px 20px 32px' }}>
      {back}
      <div style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
        <img src={headerLogo} alt="" style={{ display: 'block', height: 44, maxWidth: '80%', objectFit: 'contain', margin: '0 auto 28px' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        <div aria-hidden style={{ width: 132, height: 132, margin: '0 auto', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 64,
          background: 'radial-gradient(circle at 50% 40%, rgba(var(--brand-primary-rgb), .28), rgba(var(--brand-primary-rgb), .04) 70%)',
          border: '1px solid var(--line2)', boxShadow: '0 0 60px -10px var(--glow)' }}>🏏</div>
        <h1 style={{ margin: '26px 0 0', fontSize: 40, fontWeight: 900, letterSpacing: '.08em', lineHeight: 1.05,
          background: 'var(--gold-metal)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>CRICKET</h1>
        <div style={{ ...capLabel, marginTop: 10, fontSize: 13, letterSpacing: '.32em', color: 'var(--gold-ink)' }}>Coming soon</div>
        <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.5, margin: '18px 0 20px' }}>
          Back your opinion on live matches, ball by ball. Odds move with every bet, and you can cash out before the result.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: 26 }}>
          {COMING_POLLS.map((t) => (
            <span key={t} style={{ padding: '6px 11px', borderRadius: 999, border: '1px solid var(--pill-line)', background: 'var(--pill)', color: 'var(--text)', fontSize: 12, fontWeight: 600 }}>{t}</span>
          ))}
        </div>
        <button type="button" onClick={() => navigate('/')} style={{ ...goldButton, width: 'auto', padding: '12px 26px', fontSize: 14 }}>Play Delhi Bazaar meanwhile</button>
      </div>
    </div>
  );
};

const CricketPage: React.FC = () => (useCricketSettings().enabled ? <CricketLive /> : <ComingSoon />);

export default CricketPage;
