// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * CricketPage.tsx — cricket opinion polls, sportsbook style (owner,
 * 2026-10-18; docs/reference/CRICKET_OPINION_DESIGN.md). The published
 * matches in the admin's order; on a match: the result, toss and man-of-the-
 * match, best batsman and best bowler polls, and for next ball and overs only
 * the last settled, the live one and the next. Odds move live (`cricket_odds`,
 * at most once a second).
 *
 * Everything happens inside a poll's card (owner, 2026-10-18): its opinions on
 * the left, the bet box on the right (stake, odds, what it pays and the profit,
 * worked out as you type), and under them your bets on that poll with its own
 * Claim. Place bet asks the server's exact odds and places at them if they are
 * no worse than shown, else the player confirms the new odds; the server waits
 * the in-play delay first. A claim quotes, then confirms, the same way.
 * Each position's live value is worked out here from the broadcast pools
 * (`cricketValue.ts`, a §11 display mirror); the server's quote is the figure.
 * Cricket plays the VIP wallet only.
 *
 * Every odds button says what it is for (owner, 2026-10-19): the option's name
 * with its price, sportsbook style; a player poll is a list per team, the
 * favourites first, with "Any other player" last. A poll's title row says
 * whether it is open, closing, awaiting its result, settled (with its winner,
 * or the players sharing a dead heat) or void.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import ScreenShell, { card, capLabel, goldButton, inputStyle } from '../redesign/Screen';
import { cricket as api } from '../services/api';
import type { CricketBet, CricketMatch, CricketOption, CricketPoll, ClaimQuote } from '../services/api/cricket';
import { getBackend } from '../services/backend.service';
import { useCricketSettings, useGame } from '../services/GameContext';
import { useShell } from '../redesign/RedesignShell';
import { useToast } from '../components/ui/Toast';
import { betOddsX100, positionValuePaise } from '../redesign/cricketValue';
import { useHeaderLogo } from '../services/brandAssets';

const tokens = (paise: number) => (paise / 100).toLocaleString('en-IN', paise % 100 === 0 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// ── Odds buttons ─────────────────────────────────────────────────────────────
/**
 * Which way an option's odds just moved, for a moment after a broadcast
 * changes them (UI-only, §11): green ▲ longer, red ▼ shorter.
 */
function useOddsFlash(x100: number): 'up' | 'down' | null {
  const prev = useRef(x100);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (x100 === prev.current) return undefined;
    setDir(x100 > prev.current ? 'up' : 'down');
    prev.current = x100;
    const t = setTimeout(() => setDir(null), 1200);
    return () => clearTimeout(t);
  }, [x100]);
  return dir;
}

const winnersOf = (poll: CricketPoll) => (poll.status === 'SETTLED' ? poll.winningOptions ?? [] : []);
const Lock: React.FC = () => <span aria-hidden style={{ fontSize: 11, opacity: 0.8 }}>🔒</span>;

/**
 * One option: its name and its price in one button. `tile` (a few options):
 * the name above the price; `row` (a list of players): the name on the left,
 * the price on the right. Tapped, it stays lit while the bet box is open.
 */
const OddsButton: React.FC<{ option: CricketOption; poll: CricketPoll; picked: boolean; onPick: (o: CricketOption) => void; variant?: 'tile' | 'row'; name?: string; note?: string }> = ({
  option, poll, picked, onPick, variant = 'tile', name = option.label, note,
}) => {
  const won = winnersOf(poll).includes(option.key);
  const open = poll.status === 'OPEN';
  const flash = useOddsFlash(option.oddsX100);
  // Closed and waiting: a lock. Decided: the winner says Won, the rest keep their last price, faded.
  const price = open ? odds(option.oddsX100) : won ? 'Won' : poll.status === 'CLOSED' ? null : odds(option.oddsX100);
  const priceColor = won ? 'var(--green)' : picked ? 'var(--on-gold)' : open ? 'var(--gold-ink)' : 'var(--text3)';
  const priceBox = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 15, fontWeight: 800, color: priceColor, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
      {flash && open && <span aria-hidden style={{ fontSize: 9, color: picked ? 'var(--on-gold)' : flash === 'up' ? 'var(--green)' : 'var(--red)' }}>{flash === 'up' ? '▲' : '▼'}</span>}
      {price ?? <Lock />}
    </span>
  );
  const nameEl = (
    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: variant === 'row' ? 'flex-start' : 'center', gap: 1 }}>
      <span style={{ fontSize: variant === 'row' ? 13 : 12, fontWeight: 600, lineHeight: 1.25, color: picked ? 'var(--on-gold)' : 'var(--text)', textAlign: variant === 'row' ? 'left' : 'center', overflowWrap: 'anywhere' }}>{name}</span>
      {note && <span style={{ fontSize: 10, color: picked ? 'var(--on-gold)' : 'var(--text3)', letterSpacing: '.04em' }}>{note}</span>}
    </span>
  );
  return (
    <button type="button" disabled={!open} onClick={() => onPick(option)} aria-pressed={picked}
      aria-label={`${option.label} at ${open ? odds(option.oddsX100) : won ? 'won' : poll.status === 'CLOSED' ? 'closed' : `${odds(option.oddsX100)}, ${poll.status === 'VOID' ? 'void' : 'lost'}`}`}
      style={{
        minWidth: 0, minHeight: 48, padding: variant === 'row' ? '8px 12px' : '8px 6px', borderRadius: 10, cursor: open ? 'pointer' : 'default',
        border: `1px solid ${won ? 'var(--green)' : picked ? 'var(--gold)' : flash === 'up' ? 'var(--green)' : flash === 'down' ? 'var(--red)' : 'var(--line2)'}`,
        background: won ? 'color-mix(in srgb,var(--green) 18%,var(--surface2))' : picked ? 'var(--gold-metal)' : 'var(--surface2)',
        opacity: open || won ? 1 : 0.6, transition: 'border-color .3s',
        display: 'flex', flexDirection: variant === 'row' ? 'row' : 'column',
        alignItems: 'center', justifyContent: variant === 'row' ? 'space-between' : 'center', gap: variant === 'row' ? 10 : 4,
      }}>
      {nameEl}
      {priceBox}
    </button>
  );
};

/** The polls with one option per player: drawn as a list per team. */
const PLAYER_KINDS = new Set(['TOP_BATSMAN', 'TOP_BOWLER']);
/** The option a player poll keeps for a winner on neither squad (cricketPolls.js OTHER_PLAYER). */
const OTHER_KEY = 'OTHER';
/** How many players of a team are shown before "Show all" (UI-only, §11). */
const PLAYERS_SHOWN = 6;

interface PlayerOption { option: CricketOption; name: string; squad: boolean }
/**
 * A player poll's options by team, from the server's "Name (Team)" or
 * "Name (Team, squad)" labels: each team's favourites first, and "Any other
 * player" kept apart to go last.
 */
export function playerGroups(options: CricketOption[]): { teams: [string, PlayerOption[]][]; other: CricketOption | null } {
  const groups = new Map<string, PlayerOption[]>();
  let other: CricketOption | null = null;
  for (const o of options) {
    if (o.key === OTHER_KEY) { other = o; continue; }
    const m = /^(.*) \(([^()]*)\)$/.exec(o.label);
    const [team, mark] = m ? m[2].split(', ') : [''];
    groups.set(team, [...(groups.get(team) ?? []), { option: o, name: m ? m[1] : o.label, squad: mark === 'squad' }]);
  }
  for (const list of groups.values()) list.sort((x, y) => x.option.oddsX100 - y.option.oddsX100 || x.name.localeCompare(y.name));
  return { teams: [...groups.entries()], other };
}

const TeamList: React.FC<{ team: string; players: PlayerOption[]; poll: CricketPoll; picked: string | null; onPick: (o: CricketOption) => void; betBox?: React.ReactNode }> = ({
  team, players, poll, picked, onPick, betBox,
}) => {
  const [all, setAll] = useState(false);
  const pickedAt = players.findIndex((p) => p.option.key === picked);
  const shown = all || pickedAt >= PLAYERS_SHOWN ? players : players.slice(0, PLAYERS_SHOWN);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ ...capLabel, fontSize: 10, margin: '2px 0 6px' }}>{team}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,200px),1fr))', gap: 6 }}>
        {shown.map((p) => (
          <OddsButton key={p.option.key} option={p.option} poll={poll} picked={picked === p.option.key} onPick={onPick}
            variant="row" name={p.name} note={p.squad ? 'Squad' : undefined} />
        ))}
      </div>
      {players.length > PLAYERS_SHOWN && pickedAt < PLAYERS_SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all}
          style={{ marginTop: 6, minHeight: 36, background: 'none', border: 'none', color: 'var(--gold-ink)', fontSize: 12, fontWeight: 700, cursor: 'pointer', padding: '4px 0' }}>
          {all ? `Show fewer ${team} players` : `Show all ${players.length} ${team} players`}
        </button>
      )}
      {/* The bet box opens under the team of the player picked, so it is in view on a phone. */}
      {betBox && pickedAt >= 0 && <div style={{ marginTop: 8, maxWidth: 420 }}>{betBox}</div>}
    </div>
  );
};

const OptionGrid: React.FC<{ poll: CricketPoll; picked: string | null; onPick: (o: CricketOption) => void; betBox?: React.ReactNode }> = ({ poll, picked, onPick, betBox }) => {
  if (PLAYER_KINDS.has(poll.kind)) {
    const { teams, other } = playerGroups(poll.options);
    return (
      <div>
        {teams.map(([team, players]) => <TeamList key={team} team={team} players={players} poll={poll} picked={picked} onPick={onPick} betBox={betBox} />)}
        {other && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,200px),1fr))', gap: 6 }}>
              <OddsButton option={other} poll={poll} picked={picked === other.key} onPick={onPick} variant="row" note="Not on either squad" />
            </div>
            {betBox && picked === other.key && <div style={{ marginTop: 8, maxWidth: 420 }}>{betBox}</div>}
          </div>
        )}
      </div>
    );
  }
  const cols = poll.options.length <= 3 ? poll.options.length : poll.options.length === 4 ? 2 : 3;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: 6, alignContent: 'start' }}>
      {poll.options.map((o) => <OddsButton key={o.key} option={o} poll={poll} picked={picked === o.key} onPick={onPick} />)}
    </div>
  );
};

/** A settled poll's winner, or the options sharing a dead heat, by name. */
export function winnerLine(poll: CricketPoll): string | null {
  const keys = winnersOf(poll);
  if (!keys.length) return null;
  const names = keys.map((k) => poll.options.find((o) => o.key === k)?.label ?? k);
  return keys.length > 1 ? `Dead heat: ${names.join(' / ')}` : `Winner: ${names[0]}`;
}

/** Seconds ticking, while something on screen counts down. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** What a poll's title row says of it, and in which colour. */
function pollStatus(poll: CricketPoll, now: number): { text: string; color: string } {
  if (poll.status === 'OPEN') {
    const left = poll.closesAt ? Date.parse(poll.closesAt) - now : NaN;
    if (Number.isFinite(left) && left > 0 && left < 60 * 60 * 1000) {
      const s = Math.ceil(left / 1000);
      return { text: `Closes in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, color: 'var(--gold-ink)' };
    }
    return { text: 'Open', color: 'var(--green)' };
  }
  if (poll.status === 'CLOSED') return { text: 'Awaiting result', color: 'var(--text2)' };
  if (poll.status === 'VOID') return { text: 'Void', color: 'var(--text3)' };
  return { text: 'Settled', color: 'var(--text3)' };
}

const row = (label: React.ReactNode, value: React.ReactNode, color = 'var(--text)') => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, marginTop: 4 }}>
    <span style={{ color: 'var(--text2)' }}>{label}</span><b style={{ color, whiteSpace: 'nowrap' }}>{value}</b>
  </div>
);
const panel: React.CSSProperties = { padding: 12, borderRadius: 12, background: 'var(--surface2)', border: '1px solid var(--line2)', alignSelf: 'start' };
const smallGold: React.CSSProperties = { ...goldButton, padding: 11, fontSize: 13 };

// ── The bet box beside a poll's opinions ─────────────────────────────────────
/**
 * Pick an opinion, type a stake: the odds and what it pays are worked out
 * here as you type (`betOddsX100`, a display mirror). Place bet asks the
 * server for the exact odds and places at them if they are no worse than
 * shown; if they moved down, the player confirms the new odds first.
 */
const BetBox: React.FC<{ poll: CricketPoll; option: CricketOption | null; onPlaced: () => void; onClear: () => void }> = ({ poll, option, onPlaced, onClear }) => {
  const settings = useCricketSettings();
  const { isAuthenticated } = useGame();
  const { openAuth } = useShell();
  const { addToast } = useToast();
  const [stake, setStake] = useState(String(Math.max(settings.minStake, 100)));
  const [moved, setMoved] = useState<{ oddsX100: number; potentialPaise: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key, setKey] = useState(newKey);
  const amount = Math.floor(Number(stake) || 0);
  const inRange = amount >= settings.minStake && amount <= settings.maxStake;
  const estOdds = option ? betOddsX100(poll.options, poll.spreadBp, option.key, amount * 100) : 0;
  const estPays = Math.floor((amount * 100 * estOdds) / 100);
  const chips = [100, 500, 1000, 5000].filter((c) => c >= settings.minStake && c <= settings.maxStake);
  useEffect(() => { setMoved(null); setError(''); }, [option?.key, amount]);

  const place = async (minOdds: number) => {
    if (!option) return;
    if (!isAuthenticated) { openAuth(); return; }
    setBusy(true); setError('');
    try {
      const r = await api.placeBet({ pollId: poll.pollId, optionKey: option.key, stake: amount, minOdds, idempotencyKey: key });
      addToast(`Bet placed: ${option.label} at ${odds(r.bet.oddsX100)}`, 'success');
      setMoved(null); setKey(newKey()); onPlaced(); onClear();
    } catch (e) {
      const r = refusalOf(e);
      if (r.quote?.oddsX100) setMoved({ oddsX100: r.quote.oddsX100, potentialPaise: r.quote.potentialPaise });
      setError(r.message);
    } finally { setBusy(false); }
  };
  const start = async () => {
    if (!option) return;
    if (!isAuthenticated) { openAuth(); return; }
    setBusy(true); setError('');
    try {
      const q = await api.quoteBet(poll.pollId, option.key, amount);
      setBusy(false);
      if (q.oddsX100 >= estOdds) { await place(q.oddsX100); return; }
      setMoved({ oddsX100: q.oddsX100, potentialPaise: q.potentialPaise });
    } catch (e) { setError(refusalOf(e).message); setBusy(false); }
  };

  const shownOdds = moved?.oddsX100 ?? estOdds;
  const shownPays = moved?.potentialPaise ?? estPays;
  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={capLabel}>Your bet</span>
        {option && <button type="button" onClick={onClear} aria-label="Clear the pick" style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 12 }}>Clear</button>}
      </div>
      <div style={{ fontSize: 14, fontWeight: 800, color: option ? 'var(--text)' : 'var(--text3)', margin: '4px 0 8px' }}>
        {option?.label}
      </div>
      <label htmlFor={`stake-${poll.pollId}`} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Stake (tokens)</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input id={`stake-${poll.pollId}`} inputMode="numeric" value={stake} placeholder="Stake"
          onChange={(e) => setStake(e.target.value.replace(/\D/g, ''))}
          style={{ ...inputStyle, height: 40, flex: 1, minWidth: 0 }} />
      </div>
      <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
        {chips.map((c) => (
          <button key={c} type="button" onClick={() => setStake(String(c))}
            style={{ flex: '1 1 0', padding: '5px 0', borderRadius: 999, border: `1px solid ${amount === c ? 'var(--gold)' : 'var(--line2)'}`, background: 'transparent', color: amount === c ? 'var(--gold-ink)' : 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>{c.toLocaleString('en-IN')}</button>
        ))}
      </div>
      {option && inRange && (
        <div aria-live="polite" style={{ marginTop: 8 }}>
          {row(moved ? 'Odds moved to' : 'Odds', odds(shownOdds), 'var(--gold-ink)')}
          {row('Pays if it wins', tokens(shownPays))}
          {row('Profit if it wins', `+${tokens(shownPays - amount * 100)}`, 'var(--green)')}
        </div>
      )}
      {!inRange && amount > 0 && <p style={{ fontSize: 11, color: 'var(--text3)', margin: '8px 0 0' }}>Stake {settings.minStake} to {settings.maxStake.toLocaleString('en-IN')} tokens.</p>}
      {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 12, margin: '8px 0 0' }}>{error}</p>}
      <button type="button" style={{ ...smallGold, marginTop: 10, opacity: !option || !inRange ? 0.5 : 1 }} disabled={!option || !inRange || busy}
        onClick={() => (moved ? place(moved.oddsX100) : start())}>
        {busy ? `Placing… (${settings.inPlayDelaySec} s check)` : moved ? `Confirm at ${odds(moved.oddsX100)}` : option && inRange ? `Place bet · ${tokens(amount * 100)}` : 'Place bet'}
      </button>
    </div>
  );
};

// ── Claiming (one poll, or all of a match) ───────────────────────────────────
/** Ask the server's quote, then claim at it or better: one shared flow for a poll's Claim and Claim all. */
function useClaim(onClaimed: () => void) {
  const settings = useCricketSettings();
  const { addToast } = useToast();
  const [quote, setQuote] = useState<ClaimQuote | null>(null);
  const [busy, setBusy] = useState<'quote' | 'claim' | null>(null);
  const [error, setError] = useState('');
  const ask = async (target: { matchId: string } | { betIds: string[] }) => {
    setBusy('quote'); setError('');
    try {
      const q = await api.quoteClaim(target);
      // A bet placed moments ago is left out of the quote until the hold passes.
      if (!q.lines.length) { setQuote(null); setError(`A new bet can be claimed ${settings.claimHoldSec} s after it is placed. Try again in a moment.`); }
      else setQuote(q);
    } catch (e) { setError(refusalOf(e).message); } finally { setBusy(null); }
  };
  const confirm = async () => {
    if (!quote) return;
    setBusy('claim'); setError('');
    try {
      const r = await api.claim({ betIds: quote.lines.map((l) => l.betId), minTotalPaise: quote.totalNetPaise });
      addToast(`Claimed ${tokens(r.totalNetPaise)} tokens`, 'success');
      setQuote(null); onClaimed();
    } catch (e) {
      const r = refusalOf(e);
      setError(r.message);
      setQuote(r.quote?.lines ? { ...r.quote, delaySec: settings.inPlayDelaySec } : null);
    } finally { setBusy(null); }
  };
  return { quote, busy, error, ask, confirm, cancel: () => setQuote(null) };
}

const ClaimConfirm: React.FC<{ c: ReturnType<typeof useClaim> }> = ({ c }) => {
  const settings = useCricketSettings();
  if (!c.quote) return null;
  const pl = c.quote.totalNetPaise - c.quote.totalStakePaise;
  return (
    <div role="status" style={{ ...panel, marginTop: 8 }}>
      {row(`You get now (${c.quote.lines.length} bet${c.quote.lines.length === 1 ? '' : 's'}, after the fee)`, tokens(c.quote.totalNetPaise), 'var(--gold-ink)')}
      {row(pl >= 0 ? 'Profit' : 'Loss', `${pl >= 0 ? '+' : '−'}${tokens(Math.abs(pl))} on ${tokens(c.quote.totalStakePaise)} staked`, pl >= 0 ? 'var(--green)' : 'var(--red)')}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" style={smallGold} disabled={c.busy !== null} onClick={c.confirm}>
          {c.busy === 'claim' ? `Claiming… (${settings.inPlayDelaySec} s check)` : `Confirm ${tokens(c.quote.totalNetPaise)}`}
        </button>
        <button type="button" onClick={c.cancel} style={{ padding: '0 14px', borderRadius: 12, border: '1px solid var(--line)', background: 'transparent', color: 'var(--text2)', cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  );
};

/** A win shared in a dead heat is paid the odds on the stake ÷ the winners: said beside the amount. */
export const deadHeatNote = (b: Pick<CricketBet, 'status' | 'deadHeat'>) => (b.status === 'WON' && (b.deadHeat ?? 1) > 1 ? ` (dead heat, 1/${b.deadHeat} stake)` : '');

/** A poll's own bets, what they are worth now, and its Claim button. */
const PollPositions: React.FC<{ poll: CricketPoll; bets: CricketBet[]; onClaimed: () => void }> = ({ poll, bets, onClaimed }) => {
  const settings = useCricketSettings();
  const c = useClaim(onClaimed);
  const [, tick] = useState(0);
  const youngest = bets.reduce((t, b) => Math.max(t, Date.parse(b.placedAt) || 0), 0);
  useEffect(() => {
    const left = youngest + settings.claimHoldSec * 1000 - Date.now();
    if (left <= 0) return undefined;
    const t = setTimeout(() => tick((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [youngest, settings.claimHoldSec]);
  if (!bets.length) return null;
  const open = poll.status === 'OPEN';
  const live = bets.filter((b) => b.status === 'OPEN');
  const values = new Map(live.map((b) => [b.betId, open ? positionValuePaise(poll.options, b, settings.claimMarginPercent, settings.winningsFeePercent) : null]));
  const worth = live.reduce((t, b) => t + (values.get(b.betId) ?? 0), 0);
  const staked = live.reduce((t, b) => t + b.stakePaise, 0);
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={capLabel}>Your bets on this poll</div>
          {open && live.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
              Staked {tokens(staked)} · worth <b style={{ color: 'var(--gold-ink)' }}>{tokens(worth)}</b> now
              {' '}<span style={{ color: worth >= staked ? 'var(--green)' : 'var(--red)', whiteSpace: 'nowrap' }}>({worth >= staked ? '+' : '−'}{tokens(Math.abs(worth - staked))})</span>
            </div>
          )}
        </div>
        {open && live.length > 0 && !c.quote && (
          <button type="button" onClick={() => c.ask({ betIds: live.map((b) => b.betId) })} disabled={c.busy !== null} aria-label={`Claim ${poll.title}`}
            style={{ ...goldButton, width: 'auto', padding: '9px 16px', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {c.busy === 'quote' ? 'Checking…' : `Claim ${tokens(worth)}`}
          </button>
        )}
      </div>
      <ClaimConfirm c={c} />
      {c.error && <p role="alert" style={{ color: 'var(--red)', fontSize: 12, margin: '8px 0 0' }}>{c.error}</p>}
      <div style={{ marginTop: 6 }}>
        {bets.map((b) => {
          const v = values.get(b.betId);
          const pl = v !== null && v !== undefined ? v - b.stakePaise : null;
          return (
            <div key={b.betId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, paddingTop: 3 }}>
              <span style={{ color: 'var(--text2)', minWidth: 0 }}><b style={{ color: 'var(--text)' }}>{b.optionLabel.replace(/ \([^()]*\)$/, '')}</b> · {tokens(b.stakePaise)} @ {odds(b.oddsX100)} · pays {tokens(b.potentialPaise)}</span>
              <span style={{ whiteSpace: 'nowrap', fontWeight: 700, color: b.status === 'OPEN' ? (pl === null ? 'var(--text3)' : pl >= 0 ? 'var(--green)' : 'var(--red)') : b.status === 'LOST' ? 'var(--red)' : 'var(--green)' }}>
                {b.status === 'OPEN' ? (pl === null ? 'Awaiting result' : `${pl >= 0 ? '+' : ''}${tokens(pl)}`)
                  : b.status === 'LOST' ? 'Lost' : b.status === 'VOID' ? 'Returned' : `${b.status === 'CLAIMED' ? 'Claimed' : 'Won'} ${tokens(b.paidPaise)}${deadHeatNote(b)}`}
              </span>
            </div>
          );
        })}
      </div>
      {open && settings.claimHoldSec > 0 && !c.error && live.some((b) => Date.now() - Date.parse(b.placedAt) < settings.claimHoldSec * 1000) && (
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: '6px 0 0' }}>A new bet can be claimed {settings.claimHoldSec} s after it is placed.</p>
      )}
    </div>
  );
};

// ── A poll: its title and state, its opinions, the bet box, your bets ──────
const PollCard: React.FC<{ poll: CricketPoll | null; tag?: string; placeholder?: string; bets?: CricketBet[]; onChanged?: () => void }> = ({ poll, tag, placeholder, bets = [], onChanged = () => {} }) => {
  const [picked, setPicked] = useState<string | null>(null);
  const option = poll?.options.find((o) => o.key === picked) ?? null;
  const open = poll?.status === 'OPEN';
  const now = useNow(Boolean(open && poll?.closesAt));
  useEffect(() => { if (!open) setPicked(null); }, [open]);
  const togglePick = (o: CricketOption) => setPicked(o.key === picked ? null : o.key);
  const status = poll ? pollStatus(poll, now) : null;
  const winner = poll ? winnerLine(poll) : null;
  const player = poll ? PLAYER_KINDS.has(poll.kind) : false;
  return (
    <div style={{ ...card, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          {tag && <div style={{ ...capLabel, fontSize: 10, color: tag === 'Live' ? 'var(--red)' : 'var(--text3)', marginBottom: 2 }}>{tag === 'Live' ? '● Live' : tag}</div>}
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--text)', lineHeight: 1.3 }}>{poll?.title ?? placeholder}</h3>
        </div>
        {status && (
          <span role="status" style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: status.color, padding: '3px 9px', borderRadius: 999, border: '1px solid var(--line2)', background: 'var(--surface2)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {poll?.status === 'CLOSED' && <Lock />} {status.text}
          </span>
        )}
      </div>
      {poll
        ? (
          <>
            {winner && <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 800, color: 'var(--green)' }}>{winner}</p>}
            {poll.status === 'VOID' && <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text3)' }}>Void: {poll.voidReason}. Stakes returned.</p>}
            {poll.status === 'CLOSED' && <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text3)' }}>Bets are closed. The result settles it.</p>}
            {open && player && (
              <OptionGrid poll={poll} picked={picked} onPick={togglePick}
                betBox={option && <BetBox poll={poll} option={option} onPlaced={onChanged} onClear={() => setPicked(null)} />} />
            )}
            {open && !player && (
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: option ? 'repeat(auto-fit,minmax(min(100%,240px),1fr))' : '1fr', alignItems: 'start' }}>
                <OptionGrid poll={poll} picked={picked} onPick={togglePick} />
                {option && <BetBox poll={poll} option={option} onPlaced={onChanged} onClear={() => setPicked(null)} />}
              </div>
            )}
            {open && !option && <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text3)' }}>Tap an opinion to bet on it.</p>}
            {/* Ended, a long player list is noise: the winner line says it. */}
            {poll.status === 'CLOSED' && <OptionGrid poll={poll} picked={null} onPick={() => {}} />}
            {(poll.status === 'SETTLED' || poll.status === 'VOID') && !player && <OptionGrid poll={poll} picked={null} onPick={() => {}} />}
            <PollPositions poll={poll} bets={bets} onClaimed={onChanged} />
          </>
        )
        : <p style={{ margin: 0, fontSize: 12, color: 'var(--text3)' }}>Opens when the live one is decided.</p>}
    </div>
  );
};

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

// ── The match's total and Claim all ──────────────────────────────────────────
const MatchPositions: React.FC<{ match: CricketMatch; bets: CricketBet[]; onClaimed: () => void }> = ({ match, bets, onClaimed }) => {
  const settings = useCricketSettings();
  const c = useClaim(onClaimed);
  const pollsById = useMemo(() => new Map(match.polls.map((p) => [p.pollId, p])), [match.polls]);
  const claimable = bets.filter((b) => b.status === 'OPEN' && pollsById.get(b.pollId)?.status === 'OPEN');
  if (!claimable.length) return null;
  const worth = claimable.reduce((t, b) => t + positionValuePaise(pollsById.get(b.pollId)!.options, b, settings.claimMarginPercent, settings.winningsFeePercent), 0);
  const staked = claimable.reduce((t, b) => t + b.stakePaise, 0);
  const net = worth - staked;
  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div aria-live="polite" style={{ minWidth: 0 }}>
          <div style={capLabel}>All your open bets on this match</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--gold-ink)' }}>{tokens(worth)}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            yours if you claim everything now <span style={{ color: net >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700, whiteSpace: 'nowrap' }}>({net >= 0 ? '+' : '−'}{tokens(Math.abs(net))} on {tokens(staked)} staked)</span>
          </div>
        </div>
        {!c.quote && (
          <button type="button" onClick={() => c.ask({ matchId: match.matchId })} disabled={c.busy !== null}
            style={{ ...goldButton, width: 'auto', padding: '10px 16px', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}>{c.busy === 'quote' ? 'Checking…' : 'Claim all'}</button>
        )}
      </div>
      <ClaimConfirm c={c} />
      {c.error && <p role="alert" style={{ color: 'var(--red)', fontSize: 12, margin: '10px 0 0' }}>{c.error}</p>}
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
          {m.result === 'A' ? `${m.teamA.name} won` : m.result === 'B' ? `${m.teamB.name} won` : m.result === 'TIE' || m.result === 'DRAW' ? 'Match drawn' : 'No result'}
        </div>
      )}
      {onClick && result && !m.result && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {result.options.map((o) => (
            <div key={o.key} style={{ flex: 1, textAlign: 'center', padding: '6px 4px', borderRadius: 9, background: 'var(--surface2)', border: '1px solid var(--line)' }}>
              {/* What each price is for, by name: the team, or Draw. */}
              <div style={{ fontSize: 10, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.key === 'A' ? (m.teamA.code ?? m.teamA.name) : o.key === 'B' ? (m.teamB.code ?? m.teamB.name) : o.label}
              </div>
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
    <div style={{ display: 'grid', gap: 8, alignItems: 'start', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,520px),1fr))' }}>{children}</div>
  </section>
);

const MatchView: React.FC<{ m: CricketMatch; bets: CricketBet[]; onBack: () => void; reloadBets: () => void }> = ({ m, bets, onBack, reloadBets }) => {
  const mine = bets.filter((b) => b.matchId === m.matchId);
  const P = (poll: CricketPoll | null, tag?: string, placeholder?: string) => (
    <PollCard key={poll?.pollId ?? placeholder} poll={poll} tag={tag} placeholder={placeholder} bets={poll ? mine.filter((b) => b.pollId === poll.pollId) : []} onChanged={reloadBets} />
  );
  const byKind = (k: string) => m.polls.find((p) => p.kind === k) ?? null;
  const ball = threeOf(m.polls, 'BALL');
  const over = threeOf(m.polls, 'OVER');
  const players = (['TOP_BATSMAN', 'TOP_BOWLER'] as const).map(byKind).filter((p): p is CricketPoll => p !== null);
  const powerplays = m.polls.filter((p) => p.kind === 'POWERPLAY').sort((a, b) => a.innings - b.innings);
  const matchPolls = (['MATCH_RESULT', 'TOSS', 'MOST_SIXES'] as const).map(byKind).filter((p): p is CricketPoll => p !== null);
  return (
    <div>
      <button type="button" onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 13, marginBottom: 10, padding: '8px 0', minHeight: 40 }}>← All matches</button>
      <MatchHeader m={m} />
      <div style={{ height: 14 }} />
      <MatchPositions match={m} bets={mine} onClaimed={reloadBets} />
      {(ball.settled || ball.live) && (
        <Section title="Next ball">
          {ball.settled && P(ball.settled, 'Last ball')}
          {P(ball.live, 'Live', 'Next ball')}
          {P(null, 'Next', 'The ball after')}
        </Section>
      )}
      {(over.settled || over.live || over.next) && (
        <Section title="Overs: odd, even or zero">
          {over.settled && P(over.settled, 'Last over')}
          {over.live && P(over.live, 'Live')}
          {P(over.next, 'Next', 'The next over')}
        </Section>
      )}
      {matchPolls.length > 0 && <Section title="Match">{matchPolls.map((p) => P(p))}</Section>}
      {powerplays.length > 0 && <Section title="Powerplay">{powerplays.map((p) => P(p))}</Section>}
      {players.length > 0 && <Section title="Players">{players.map((p) => P(p))}</Section>}
    </div>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────
const CricketLive: React.FC = () => {
  const navigate = useNavigate();
  const settings = useCricketSettings();
  const { isAuthenticated } = useGame();
  const { addToast } = useToast();
  const [matches, setMatches] = useState<CricketMatch[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [bets, setBets] = useState<CricketBet[]>([]);
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
        ? <MatchView m={current} bets={bets} onBack={() => setOpenId(null)} reloadBets={loadBets} />
        : (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,320px),1fr))' }}>
            {matches?.map((m) => <MatchHeader key={m.matchId} m={m} onClick={() => setOpenId(m.matchId)} />)}
          </div>
        )}
      {matches && matches.length > 0 && (
        <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 16 }}>
          Cricket is played from your VIP wallet. Odds and payouts on screen are live estimates; a bet is placed at the exact odds the server gives (you confirm them if they moved), and a winning payout pays the {settings.winningsFeePercent}% winnings fee.
        </p>
      )}
    </ScreenShell>
  );
};

// ── Coming soon (the game switched off, the tab kept; owner, 2026-10-18) ─────
/**
 * Drawn inside the app like any other game tab (owner, 2026-10-19: no page
 * that covers the app), so the header, the game tabs and the bottom bar stay:
 * the admin's picture (Branding.cricketComingSoonImageUrl, set on Admin ›
 * Images) filling the content area, or with none, the same page in the site's
 * own theme.
 */
const COMING_POLLS = ['Toss', 'Match result', 'Next ball', 'Every over', 'Powerplay runs', 'Best batsman', 'Best bowler', 'Most sixes'];

const ComingSoon: React.FC = () => {
  const navigate = useNavigate();
  const headerLogo = useHeaderLogo();
  const imageUrl: string = (() => {
    try { return String(JSON.parse(localStorage.getItem('app_branding') || '{}').cricketComingSoonImageUrl || ''); } catch { return ''; }
  })();
  const [broken, setBroken] = useState(false);
  if (imageUrl && !broken) {
    return (
      <section aria-label="Cricket is coming soon" style={{ position: 'relative', flex: 1, minHeight: 'min(70vh, 640px)', background: 'var(--bg)' }}>
        <img src={imageUrl} alt="Cricket is coming soon" onError={() => setBroken(true)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </section>
    );
  }
  // No picture set: the same page, drawn in the site's own theme.
  return (
    <section aria-label="Cricket is coming soon"
      style={{ flex: 1, background: 'var(--app-bg)', backgroundColor: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 20px 40px' }}>
      <div style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
        <img src={headerLogo} alt="" style={{ display: 'block', height: 40, maxWidth: '80%', objectFit: 'contain', margin: '0 auto 22px' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        <div aria-hidden style={{ width: 120, height: 120, margin: '0 auto', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 58,
          background: 'radial-gradient(circle at 50% 40%, rgba(var(--brand-primary-rgb), .28), rgba(var(--brand-primary-rgb), .04) 70%)',
          border: '1px solid var(--line2)', boxShadow: '0 0 60px -10px var(--glow)' }}>🏏</div>
        <h1 style={{ margin: '22px 0 0', fontSize: 38, fontWeight: 900, letterSpacing: '.08em', lineHeight: 1.05,
          background: 'var(--gold-metal)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>CRICKET</h1>
        <div style={{ ...capLabel, marginTop: 10, fontSize: 13, letterSpacing: '.32em', color: 'var(--gold-ink)' }}>Coming soon</div>
        <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.5, margin: '16px 0 18px' }}>
          Back your opinion on live matches, ball by ball. Odds move with every bet, and you can cash out before the result.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: 24 }}>
          {COMING_POLLS.map((t) => (
            <span key={t} style={{ padding: '6px 11px', borderRadius: 999, border: '1px solid var(--pill-line)', background: 'var(--pill)', color: 'var(--text)', fontSize: 12, fontWeight: 600 }}>{t}</span>
          ))}
        </div>
        <button type="button" onClick={() => navigate('/')} style={{ ...goldButton, width: 'auto', padding: '12px 26px', fontSize: 14 }}>Play Delhi Bazaar meanwhile</button>
      </div>
    </section>
  );
};

const CricketPage: React.FC = () => (useCricketSettings().enabled ? <CricketLive /> : <ComingSoon />);

export default CricketPage;
