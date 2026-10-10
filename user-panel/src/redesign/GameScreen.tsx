// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * GameScreen.tsx — the redesigned Delhi vs Bombay Bazaar game experience.
 *
 * Live data from GameContext (server-authoritative via SSE/WS):
 *   • cycle timer   — derived from currentCycle.endTime (pure math, no drift)
 *   • phase/status  — currentCycle.status (OPEN/MERGED/CLOSED/RESULT_DECLARED)
 *   • pools         — subscribeToVolume(cycleType) → {totalDelhi,totalBombay,totalPool,poolsHidden}
 *   • my bets       — userBets for the current cycle, summed per side
 *   • roadmap/stats — winners from pastCycles (analytics.ts), real results only
 *
 * GOVERNANCE §2/§3: the min bet, chip bounds, close offset and tabs come from
 * the board (`GET /api/v1/boards`, server authority), never a hardcoded number.
 * Chip denominations are UI-only (§11, constants.chipsFor): the 10 · 30 · 90 ·
 * 270 · 810 ladder, scaled by the 10× switch beside the chips.
 * §3: gold/accent hues resolve from brand CSS variables via the theme tokens.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useGame } from '../services/GameContext';
import { BettingSide, GameState } from '../types';
import { CHIP_SCALE_STEP, chipScales, chipsFor } from '../constants';
import { useShell } from './RedesignShell';
import { useViewport } from './useViewport';
import { useToast } from '../components/ui/Toast';
import { fmt, timeStr } from './format';
import { analyticsFor, Side } from './analytics';
import AnalyticsPanel from './AnalyticsPanel';
import VsStrip from './VsStrip';
import { getAssetUrl } from '../services/backend.service';
import { canPlaceBet } from '../GAME_CORE';
import { BoardRulesModal } from './BoardRules';

// UI-only chip face palette (GOVERNANCE §10 — presentation, not validation).
const CHIP_STYLES = [
  { colorHex: '#C62828', gFrom: '#B71C1C', gTo: '#E53935', txt: '#fff' },
  { colorHex: '#2E7D32', gFrom: '#1B5E20', gTo: '#43A047', txt: '#fff' },
  { colorHex: '#1565C0', gFrom: '#0D47A1', gTo: '#1E88E5', txt: '#fff' },
  { colorHex: '#6A1B9A', gFrom: '#4A148C', gTo: '#8E24AA', txt: '#fff' },
  { colorHex: '#212121', gFrom: '#000000', gTo: '#424242', txt: '#F1CE7E' },
];

const bead = (sd: Side) => ({ ch: sd === 'DELHI' ? 'D' : 'B', bg: sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)' });

const GameScreen: React.FC = () => {
  const {
    currentCycle, gameState, cycleType, setCycleType, placeBet, placePhantomBet, boards, currentBoard,
    userBets, isGhostMode, toggleGhostMode, user, isAuthenticated, pastCycles, loadCycleHistory, subscribeToVolume, getCurrentVolume, serverTimeOffset,
  } = useGame();

  // Phantom-manager access (ghost mode). Only users granted phantomAccess for the
  // active cycle type see the toggle; enabling it routes bets through
  // placePhantomBet (equalizer bets that balance the display pool, never paid out).
  const canUseGhostMode = (() => {
    const access = (user as any)?.phantomAccess as string | undefined;
    if (!access || access === 'NONE') return false;
    // 'BOTH' predates the 1-minute block and means EVERY type — the server gate
    // reads it the same way (backend/domains/markets/bet.routes.js).
    if (access === 'BOTH') return true;
    // Otherwise the access value IS the single type the agent is scoped to, so
    // this compares rather than branching per type.
    return access === (cycleType as string);
  })();
  const { openAuth } = useShell();
  const { desktop, mobile, vh } = useViewport();
  const { addToast } = useToast();

  const [selectedChip, setSelectedChip] = useState<number | null>(null);
  const [manualInput, setManualInput] = useState('');
  const analyticsRef = useRef<HTMLElement | null>(null);
  const showAnalytics = () => analyticsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Re-render the countdown every second (endTime is authoritative).
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(id); }, []);

  // Reset selection when switching cycle type.
  useEffect(() => { setSelectedChip(null); setManualInput(''); }, [cycleType]);

  // Live pools for the active cycle type.
  const [pools, setPools] = useState(() => getCurrentVolume(cycleType));
  useEffect(() => {
    setPools(getCurrentVolume(cycleType));
    const unsub = subscribeToVolume(cycleType, setPools);
    return () => unsub();
  }, [cycleType, subscribeToVolume, getCurrentVolume]);

  const poolDelhi = pools?.totalDelhi ?? currentCycle?.totalDelhi ?? 0;
  const poolBombay = pools?.totalBombay ?? currentCycle?.totalBombay ?? 0;
  // From the merge until the result the server sends the total alone.
  const poolsHidden = pools ? pools.poolsHidden : !!currentCycle?.poolsHidden;
  const total = poolsHidden ? (pools?.totalPool ?? currentCycle?.totalPool ?? 0) : poolDelhi + poolBombay;
  const dPct = total ? Math.round((poolDelhi / total) * 100) : 50;

  // Phase flags.
  // True phase (agrees with the server) vs. whether a tap right now would still
  // land in time — see canPlaceBet. Kept separate so the countdown and the
  // MERGED/CLOSED labels stay truthful while the bet buttons close early.
  const betOpen = !!currentCycle?.endTime
    && !!currentBoard
    && canPlaceBet(currentBoard.phases.closeBeforeEndSec, Date.now() + serverTimeOffset, currentCycle.endTime);
  const isOpen = gameState === GameState.OPEN;
  const isMerged = gameState === GameState.MERGED;
  const isClosed = gameState === GameState.CLOSED;
  const isResult = gameState === GameState.RESULT_DECLARED;
  const winner = currentCycle?.winner;
  const showMerged = isMerged || (poolsHidden && !isResult);

  const secondsLeft = currentCycle?.endTime ? Math.max(0, Math.floor((currentCycle.endTime - Date.now()) / 1000)) : 0;

  // My open bets this cycle.
  const cycleBets = (userBets || []).filter(b => b.cycleId === currentCycle?.id && b.status === 'PENDING' && !b.isPhantom);
  const myBetDelhi = cycleBets.filter(b => b.side === BettingSide.DELHI).reduce((a, b) => a + (b.amount || 0), 0);
  const myBetBombay = cycleBets.filter(b => b.side === BettingSide.BOMBAY).reduce((a, b) => a + (b.amount || 0), 0);
  // Both sides may be backed in one cycle (owner, 2026-10-10); only one side
  // can win, so the return is stated per side, never summed. Whether the
  // platform refuses a second side is the server's (`riskRules.
  // blockOppositeSideBetting`, admin, default off): its refusal reaches the
  // player as the server's own message.
  const returnIfDelhi = myBetDelhi * 2;
  const returnIfBombay = myBetBombay * 2;

  // Winner sequences from real history (newest first), by board. Keyed by
  // every board, so a tab cannot fall through to another board's history.
  const winnersByType = useMemo(() => {
    const out: Record<string, Side[]> = {};
    for (const c of [...(pastCycles || [])].sort((a, b) => (b.endTime || 0) - (a.endTime || 0))) {
      if (c.winner !== 'DELHI' && c.winner !== 'BOMBAY') continue;
      (out[c.type] ??= []).push(c.winner as Side);
    }
    for (const b of boards) out[b.key] ??= [];
    return out;
  }, [pastCycles, boards]);

  const panelWinners = useMemo(() => winnersByType[cycleType] ?? [], [winnersByType, cycleType]);

  const Ag = useMemo(
    () => analyticsFor(winnersByType[cycleType] ?? [], currentBoard),
    [winnersByType, cycleType, currentBoard],
  );
  const seqGame = Ag.seq;
  const stripBeads = seqGame.slice(0, mobile ? 14 : 26).map(bead);
  const roadmapBeads = [...seqGame.slice(0, 60)].reverse().map(bead);

  // Effective bet amount from chip or manual entry.
  const manualNum = parseInt(manualInput, 10);
  const betAmount = manualInput !== '' && !isNaN(manualNum) && manualNum > 0 ? manualNum : selectedChip;
  // The board's own minimum; 0 while the boards load (the server still holds it).
  const minBet = currentBoard?.minBet ?? 0;

  // The 10× switch: a power of CHIP_SCALE_STEP, held to what this board's
  // stake bounds allow, back at its lowest on every board change.
  const scales = chipScales(currentBoard);
  const [chipScale, setChipScale] = useState(0);
  useEffect(() => { setChipScale(scales?.min ?? 0); setSelectedChip(null); }, [cycleType, scales?.min]);
  const scale = scales ? Math.max(scales.min, Math.min(scales.max, chipScale)) : 0;
  const canScaleUp = !!scales && scale < scales.max;
  const canScaleDown = !!scales && scale > scales.min;
  const rescale = (dir: 1 | -1) => {
    if (dir === 1 ? !canScaleUp : !canScaleDown) return;
    setChipScale(scale + dir);
    // A picked chip follows the switch, so the stake shown is the stake placed.
    setSelectedChip(prev => (prev && manualInput === '' ? (dir === 1 ? prev * CHIP_SCALE_STEP : prev / CHIP_SCALE_STEP) : prev));
  };
  // 2,700 reads as 2.7K on a chip face; the stake itself is the full number.
  const chipLabel = (v: number) => (v >= 1000 ? `${v / 1000}K` : String(v));

  const chips = chipsFor(currentBoard, scale).map((v, i) => {
    const st = CHIP_STYLES[i % 5];
    const sel = selectedChip === v && manualInput === '';
    return {
      value: v, colorHex: st.colorHex, gFrom: st.gFrom, gTo: st.gTo, txt: st.txt, sel,
      label: chipLabel(v),
      font: chipLabel(v).length >= 4 ? 12 : 15,
    };
  });

  const onChip = (v: number) => { setSelectedChip(prev => (prev === v ? null : v)); setManualInput(''); };
  const onManual = (val: string) => {
    if (val.includes('-') || val.includes('e')) return;
    setManualInput(val);
    setSelectedChip(null);
  };

  const handleBet = (side: BettingSide) => {
    if (!isAuthenticated) { openAuth('login'); return; }
    if (isClosed || isResult) return;
    // Stop offering the bet slightly before the server's cutoff. A stake tapped
    // at T-5.2s does not ARRIVE at T-5.2s — it crosses a mobile network first
    // and lands after the deadline, where the server correctly rejects it. The
    // player would see an open board and an error for a bet they placed in
    // time. See BET_SUBMIT_MARGIN_MS; the server gate remains the only control.
    if (!betOpen) { addToast('Bets just closed for this cycle', 'error'); return; }
    if (!betAmount) { addToast('Pick a chip or enter an amount first', 'error'); return; }
    if (betAmount < minBet) { addToast(`Minimum bet for this cycle is ₹${minBet}`, 'error'); return; }
    if (navigator.vibrate) navigator.vibrate(40);
    if (isGhostMode) placePhantomBet(betAmount, side); else placeBet(betAmount, side);
  };

  const phaseLabel = isOpen ? 'NEXT RESULT IN' : isMerged ? '⚡ POOLS MERGED' : isClosed ? '🔒 BETS CLOSED' : '🎉 WINNER DECLARED';
  const phaseColor = isOpen ? 'var(--green)' : isMerged ? '#FB8C00' : isClosed ? 'var(--red)' : 'var(--gold)';

  const cardMaxW = desktop ? 560 : 520;
  const cardH = desktop
    ? Math.max(196, Math.min(296, Math.round((vh || 760) * 0.29)))
    : Math.max(160, Math.min(296, Math.round((vh || 760) * 0.33)));
  const sideFont = mobile ? 20 : 24;

  // Admin-configurable bet-card backgrounds (Branding → CDN, GOVERNANCE §12).
  // Empty ⇒ default themed gradient. Read from app_branding like the other
  // branding consumers (PromoPage/RulesPage); getAssetUrl resolves CDN paths.
  const brand = (() => { try { return JSON.parse(localStorage.getItem('app_branding') || '{}'); } catch { return {}; } })();
  const cardImg: Record<string, string> = {
    [BettingSide.DELHI]: getAssetUrl(brand.betCardDelhiImageUrl || ''),
    [BettingSide.BOMBAY]: getAssetUrl(brand.betCardBombayImageUrl || ''),
  };

  const sideStyle = (side: BettingSide): React.CSSProperties => {
    const isWinner = isResult && winner === side;
    // Only result/closed states dim a card; a bet on the other side does not
    // lock this one (both sides allowed, owner 2026-10-10).
    // `!betOpen` dims the cards for the ~1.5s before the true close, so the
    // board stops inviting a tap it can no longer deliver. The phase LABEL
    // still flips at the real cutoff — that clock is the server's, not ours.
    const opacity = isResult && winner !== side ? .35 : (isClosed || !betOpen) ? .6 : 1;
    const filter = isResult && winner !== side ? 'grayscale(.7)' : 'none';
    const cursor = (isClosed || isResult || !betOpen) ? 'not-allowed' : 'pointer';
    const gradient = side === BettingSide.DELHI
      ? 'linear-gradient(160deg,#2A0A0A,#140406 55%,#050203)'
      : 'linear-gradient(160deg,#07172E,#04101F 55%,#020814)';
    const img = cardImg[side];
    // Admin-set CDN image (if any) is the card: only a light top and bottom
    // fade keeps the labels legible over it. Otherwise the themed gradient.
    const background = img
      ? `linear-gradient(180deg, rgba(4,3,6,.42) 0%, rgba(4,3,6,0) 32%, rgba(4,3,6,0) 62%, rgba(4,3,6,.55) 100%), url("${img}") center/cover no-repeat`
      : gradient;
    return {
      width: '50%', height: '100%', position: 'relative', border: 'none', cursor, overflow: 'hidden',
      background,
      opacity, filter, transition: 'opacity .3s, filter .3s', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'space-between', padding: '16px 8px',
      ...(isWinner ? {} : {}),
    };
  };

  const sectionCard: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-sm)' };
  const labelCap: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--text2)' };

  // ── side panels (desktop) ────────────────────────────────────────────────
  // The Refer & Earn card takes the side column's top slot (owner,
  // 2026-10-10); the pools moved above the VS strip on every screen size.
  // Its image is Branding's `referPromoImageUrl` (admin › Branding, CDN);
  // with none uploaded it is a styled card saying the same thing.
  const referImg = getAssetUrl(brand.referPromoImageUrl || '');
  const openReferrals = () => { window.location.hash = '#/referrals'; };
  const leftPanel = (
    <aside className="bb-noscroll" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
      <button type="button" onClick={openReferrals} aria-label="Refer and earn: invite friends" style={{ ...sectionCard, padding: 0, overflow: 'hidden', cursor: 'pointer', textAlign: 'left', display: 'block', width: '100%' }}>
        {referImg ? (
          <img src={referImg} alt="Refer and earn" style={{ display: 'block', width: '100%', height: 'auto' }} />
        ) : (
          <div style={{ padding: 18, background: 'radial-gradient(120% 100% at 100% 0,color-mix(in srgb,var(--gold) 28%,transparent),transparent 60%),linear-gradient(160deg,var(--surface2),var(--surface))' }}>
            <div style={{ fontSize: 34, lineHeight: 1 }} aria-hidden="true">🎁</div>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 18, color: 'var(--text)', marginTop: 10 }}>Refer &amp; Earn</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5, marginTop: 4 }}>Invite friends and get a bonus for each one who joins and verifies.</div>
            <div style={{ display: 'inline-block', marginTop: 12, padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 800, color: 'var(--bg)', background: 'linear-gradient(180deg,var(--gold2),var(--gold))' }}>Invite now</div>
          </div>
        )}
      </button>
      <div style={sectionCard}>
        <div style={{ ...labelCap, marginBottom: 12 }}>Payout</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>Winning bet</span>
          <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 20, color: 'var(--gold-ink)' }}>2.00×</span>
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text3)' }}>The side with fewer real bets wins. Winners are paid 2× their stake.</div>
      </div>
      <div style={{ ...sectionCard, padding: '14px 16px' }}>
        <div style={{ ...labelCap, marginBottom: 10 }}>Total pool</div>
        <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 24, color: 'var(--gold-ink)' }}>₹{fmt(total)}</div>
      </div>
    </aside>
  );

  const rightPanel = (
    <aside className="bb-noscroll" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
      <div style={sectionCard}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={labelCap}>Roadmap</span>
          <button onClick={showAnalytics} style={{ fontSize: 9, fontWeight: 800, color: 'var(--gold-ink)', background: 'none', border: '1px solid var(--line2)', borderRadius: 999, padding: '3px 10px', cursor: 'pointer' }}>FULL ANALYSIS</button>
        </div>
        {roadmapBeads.length === 0 ? (
          // Real results only (analytics.ts no longer pads a thin window), so a
          // board with no settled cycles genuinely has nothing to plot.
          <div style={{ fontSize: 10, color: 'var(--text3)', padding: '10px 0', textAlign: 'center' }}>No results on this board yet.</div>
        ) : (
          <div className="bb-noscroll" style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(6,18px)', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
            {roadmapBeads.map((b, i) => <span key={i} style={{ width: 18, height: 18, borderRadius: '50%', background: b.bg, color: '#fff', fontSize: 8, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{b.ch}</span>)}
          </div>
        )}
      </div>
      <div style={sectionCard}>
        <span style={labelCap}>My open bets · this cycle</span>
        {(myBetDelhi > 0 || myBetBombay > 0) ? (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {myBetDelhi > 0 && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'color-mix(in srgb,var(--delhi) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--delhi) 30%,transparent)', borderRadius: 10, padding: '9px 12px' }}><span style={{ fontSize: 11, fontWeight: 800, color: 'var(--delhi)' }}>DELHI</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--text)' }}>₹{fmt(myBetDelhi)}</span></div>}
            {myBetBombay > 0 && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'color-mix(in srgb,var(--bombay) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--bombay) 30%,transparent)', borderRadius: 10, padding: '9px 12px' }}><span style={{ fontSize: 11, fontWeight: 800, color: 'var(--bombay)' }}>BOMBAY</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--text)' }}>₹{fmt(myBetBombay)}</span></div>}
            {myBetDelhi > 0 && myBetBombay > 0 ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px 0' }}><span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>If Delhi wins</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--gold-ink)' }}>₹{fmt(returnIfDelhi)}</span></div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}><span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>If Bombay wins</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--gold-ink)' }}>₹{fmt(returnIfBombay)}</span></div>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px 0' }}><span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>Potential return</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--gold-ink)' }}>₹{fmt(returnIfDelhi + returnIfBombay)}</span></div>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 0' }}>
            <span style={{ fontSize: 26, opacity: .5 }}>🎯</span>
            <span style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.5 }}>Pick a chip, then tap<br />Delhi or Bombay to bet</span>
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <div style={{ minHeight: '100%', display: desktop ? 'grid' : 'flex', gridTemplateColumns: desktop ? '286px minmax(0,1fr) 300px' : undefined, gap: 14, padding: desktop ? 16 : '6px 12px 10px', flexDirection: 'column', justifyContent: 'safe center', alignItems: 'stretch', width: '100%', maxWidth: 1360, margin: '0 auto' }}>
      {desktop && leftPanel}

      <section style={{ minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {/* Cycle control */}
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 4px 10px' }}>
          <div style={{ display: 'flex', background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 999, padding: 3, gap: 3, boxShadow: 'var(--shadow-sm)' }}>
            {boards.map(b => ({ t: b.key, l: b.name.toUpperCase() })).map(o => {
              const on = cycleType === o.t;
              return <button key={o.t} onClick={() => setCycleType(o.t)} style={{ padding: '7px 15px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 800, letterSpacing: '.06em', background: on ? 'linear-gradient(180deg,var(--gold2),var(--gold))' : 'transparent', color: on ? '#1a1200' : 'var(--text3)', boxShadow: on ? 'var(--shadow-sm)' : 'none' }}>{o.l}</button>;
            })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
            <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: phaseColor, marginBottom: 2 }}>{phaseLabel}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: phaseColor, boxShadow: `0 0 8px ${phaseColor}` }} />
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, letterSpacing: '.04em', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{isResult ? '00:00' : timeStr(secondsLeft)}</span>
            </div>
          </div>
        </div>

        {/* Title + inline pools */}
        <div style={{ flex: 'none', textAlign: 'center', padding: '2px 0 8px' }}>
          <h2 className="font-grotesk" style={{ margin: 0, fontWeight: 700, fontSize: 15, letterSpacing: '.02em', color: 'var(--text)' }}>DELHI BAZAAR <span style={{ color: 'var(--gold-ink)', fontStyle: 'italic', fontWeight: 700 }}>vs</span> BOMBAY BAZAAR</h2>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 26, marginTop: 5 }}>
            {showMerged ? (
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--gold-ink)', textShadow: '0 0 14px var(--glow)' }}>POOL ₹{fmt(total)}</span>
            ) : (
              <>
                <span className="font-grotesk" style={{ fontWeight: 700, fontSize: desktop ? 16 : 13, color: 'var(--delhi)', fontVariantNumeric: 'tabular-nums' }}>₹{fmt(poolDelhi)}</span>
                <span className="font-grotesk" style={{ fontWeight: 700, fontSize: desktop ? 16 : 13, color: 'var(--bombay)', fontVariantNumeric: 'tabular-nums' }}>₹{fmt(poolBombay)}</span>
              </>
            )}
          </div>
        </div>

        {/* VS strip: live share of the pool, BLIND BETTING once merged */}
        <div style={{ flex: 'none', width: '100%', maxWidth: cardMaxW, margin: '4px auto 8px', padding: '0 2px' }}>
          <VsStrip delhiPct={dPct} blind={showMerged} empty={!showMerged && poolDelhi + poolBombay === 0} compact={mobile} />
        </div>

        {/* Stage */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 0' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: cardMaxW, height: cardH, borderRadius: 20, boxShadow: 'var(--shadow)' }}>
            <div className={isResult ? 'bb-pulse' : ''} style={{ position: 'absolute', inset: 0, borderRadius: 20, overflow: 'hidden', display: 'flex', border: '1.5px solid var(--line2)' }}>
              {/* Delhi */}
              <button onClick={() => handleBet(BettingSide.DELHI)} aria-disabled={isClosed || isResult} style={sideStyle(BettingSide.DELHI)}>
                {!cardImg[BettingSide.DELHI] && <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 82% at 50% 128%, rgba(229,72,76,.55), transparent 62%)' }} />}
                {!cardImg[BettingSide.DELHI] && <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 2px, transparent 2px 30px)', opacity: .5 }} />}
                {isResult && winner === BettingSide.DELHI && <div className="bb-shimmer" />}
                <span style={{ position: 'relative', zIndex: 2, fontSize: 9, fontWeight: 800, letterSpacing: '.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,.55)' }}>India Gate</span>
                <span className="font-grotesk" style={{ position: 'relative', zIndex: 2, fontWeight: 700, fontSize: sideFont, letterSpacing: '.08em', textTransform: 'uppercase', color: isResult && winner === BettingSide.DELHI ? '#FFD700' : 'var(--delhi)', textShadow: '0 2px 12px rgba(0,0,0,.9)' }}>{isResult && winner === BettingSide.DELHI ? '🏆 DELHI' : 'Delhi'}</span>
                {myBetDelhi > 0 ? <span style={{ position: 'relative', zIndex: 2, background: 'var(--delhi)', color: '#fff', fontSize: 10, fontWeight: 800, padding: '3px 11px', borderRadius: 999, boxShadow: '0 0 16px var(--delhi)' }}>You ₹{fmt(myBetDelhi)}</span> : <span />}
              </button>
              <div style={{ width: 1.5, height: '100%', background: 'linear-gradient(180deg,transparent,var(--gold),transparent)', boxShadow: '0 0 12px var(--gold)', zIndex: 3 }} />
              {/* Bombay */}
              <button onClick={() => handleBet(BettingSide.BOMBAY)} aria-disabled={isClosed || isResult} style={sideStyle(BettingSide.BOMBAY)}>
                {!cardImg[BettingSide.BOMBAY] && <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 82% at 50% 128%, rgba(46,134,222,.55), transparent 62%)' }} />}
                {!cardImg[BettingSide.BOMBAY] && <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 2px, transparent 2px 30px)', opacity: .5 }} />}
                {isResult && winner === BettingSide.BOMBAY && <div className="bb-shimmer" />}
                <span style={{ position: 'relative', zIndex: 2, fontSize: 9, fontWeight: 800, letterSpacing: '.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,.55)' }}>Gateway of India</span>
                <span className="font-grotesk" style={{ position: 'relative', zIndex: 2, fontWeight: 700, fontSize: sideFont, letterSpacing: '.08em', textTransform: 'uppercase', color: isResult && winner === BettingSide.BOMBAY ? '#FFD700' : 'var(--bombay)', textShadow: '0 2px 12px rgba(0,0,0,.9)' }}>{isResult && winner === BettingSide.BOMBAY ? '🏆 BOMBAY' : 'Bombay'}</span>
                {myBetBombay > 0 ? <span style={{ position: 'relative', zIndex: 2, background: 'var(--bombay)', color: '#fff', fontSize: 10, fontWeight: 800, padding: '3px 11px', borderRadius: 999, boxShadow: '0 0 16px var(--bombay)' }}>You ₹{fmt(myBetBombay)}</span> : <span />}
              </button>
            </div>

            {!isClosed && !isResult && (
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 50, height: 50, borderRadius: '50%', background: 'var(--bg)', border: '2px solid var(--gold)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4, boxShadow: '0 0 22px var(--glow)' }}>
                <span className="font-grotesk" style={{ fontWeight: 700, fontStyle: 'italic', fontSize: 17, color: 'var(--gold-ink)' }}>VS</span>
              </div>
            )}
            {isClosed && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(0,0,0,.62)', backdropFilter: 'blur(2px)', borderRadius: 20, border: '1px solid rgba(239,74,74,.4)' }}>
                <span style={{ fontSize: 30 }}>🔒</span>
                <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 20, letterSpacing: '.14em', color: 'var(--red)' }}>BETS CLOSED</span>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.2em', color: 'var(--gold-ink)' }}>RESULT PENDING…</span>
              </div>
            )}
          </div>
        </div>

        {/* Bet controls */}
        <div style={{ flex: 'none', padding: '6px 0 2px' }}>
          {canUseGhostMode && (
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
              <button onClick={() => { toggleGhostMode(); setSelectedChip(null); setManualInput(''); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 10, fontWeight: 800, letterSpacing: '.04em', padding: '5px 14px', borderRadius: 999, cursor: 'pointer', border: `1px solid ${isGhostMode ? '#a78bfa' : 'var(--line2)'}`, background: isGhostMode ? 'rgba(139,111,224,.22)' : 'var(--surface2)', color: isGhostMode ? '#c4b5fd' : 'var(--text3)', boxShadow: isGhostMode ? '0 0 16px -4px rgba(139,111,224,.6)' : 'none' }}>
                <span>👻 GHOST MODE</span><span>{isGhostMode ? 'ON' : 'OFF'}</span>
              </button>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: mobile ? 8 : 16, padding: '10px 6px 4px', background: isGhostMode ? 'rgba(139,111,224,.07)' : 'transparent', border: isGhostMode ? '1px solid rgba(139,111,224,.28)' : '1px solid transparent', borderRadius: 14, transition: 'background .2s' }}>
            {chips.map(chip => {
              const size = mobile ? 48 : desktop ? 60 : 56;
              return (
                <button key={chip.value} onClick={() => onChip(chip.value)} aria-label={`Chip ₹${chip.value}`} aria-pressed={chip.sel} style={{ flex: 'none', position: 'relative', width: size, height: size, border: 'none', background: 'none', cursor: 'pointer', transform: chip.sel ? 'translateY(-10px) scale(1.08)' : 'translateY(0) scale(1)', zIndex: chip.sel ? 5 : 1, transition: 'transform .16s ease-out' }}>
                  <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'linear-gradient(to top right,var(--brand-secondary, #B8860B),var(--brand-accent, #F5C77A) 50%,var(--brand-secondary, #B8860B))', boxShadow: chip.sel ? '0 16px 24px -6px rgba(0,0,0,.7)' : '0 5px 10px -4px rgba(0,0,0,.5)', border: '1px solid #8A7018' }} />
                  <span style={{ position: 'absolute', inset: '4%', borderRadius: '50%', background: `repeating-conic-gradient(from 0deg, ${chip.colorHex} 0deg 45deg, transparent 45deg 60deg)`, opacity: .92 }} />
                  <span style={{ position: 'absolute', inset: '4%', borderRadius: '50%', boxShadow: 'inset 0 2px 4px rgba(0,0,0,.4)', pointerEvents: 'none' }} />
                  <span style={{ position: 'absolute', inset: '18%', borderRadius: '50%', background: 'linear-gradient(to bottom,#FFFACD,var(--brand-primary, #D4AF37) 55%,var(--brand-secondary, #B8860B))', padding: 2, boxShadow: '0 1px 3px rgba(0,0,0,.6)' }}>
                    <span style={{ width: '100%', height: '100%', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', background: `linear-gradient(to bottom right, ${chip.gFrom}, ${chip.gTo})`, boxShadow: 'inset 0 2px 4px rgba(0,0,0,.35)' }}>
                      <span style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '45%', background: 'rgba(255,255,255,.16)', borderBottom: '1px solid rgba(255,255,255,.06)', borderRadius: '50% 50% 42% 42%' }} />
                      <span className="font-grotesk" style={{ fontWeight: 800, fontSize: chip.font, color: chip.txt, textShadow: '0 2px 2px rgba(0,0,0,.8)', position: 'relative', zIndex: 2, letterSpacing: '-.02em' }}>{chip.label}</span>
                    </span>
                  </span>
                  <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden', pointerEvents: 'none' }}><span className="bb-chipshine" style={{ position: 'absolute', top: '-50%', left: '-50%', width: '200%', height: '200%', background: 'linear-gradient(to right,transparent,rgba(255,255,255,.32),transparent)' }} /></span>
                  {chip.sel && <span style={{ position: 'absolute', inset: 1, borderRadius: '50%', border: '2px solid var(--gold)', boxShadow: '0 0 12px var(--glow)', pointerEvents: 'none' }} />}
                </button>
              );
            })}
            {scales && scales.max > scales.min && (
              <div role="group" aria-label="Chip size" style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: 3, borderRadius: 14, background: 'var(--surface2)', border: '1px solid var(--line2)', boxShadow: 'var(--shadow-sm)' }}>
                <button onClick={() => rescale(1)} disabled={!canScaleUp} aria-label="Chips 10 times bigger" style={{ width: 34, height: 20, border: 'none', borderRadius: 9, cursor: canScaleUp ? 'pointer' : 'not-allowed', background: canScaleUp ? 'linear-gradient(180deg,var(--gold2),var(--gold))' : 'transparent', color: canScaleUp ? '#1a1200' : 'var(--text3)', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>▲</button>
                <span className="font-grotesk" style={{ fontSize: 11, fontWeight: 800, color: 'var(--gold-ink)', letterSpacing: '.02em' }}>10×</span>
                <button onClick={() => rescale(-1)} disabled={!canScaleDown} aria-label="Chips 10 times smaller" style={{ width: 34, height: 20, border: 'none', borderRadius: 9, cursor: canScaleDown ? 'pointer' : 'not-allowed', background: canScaleDown ? 'linear-gradient(180deg,var(--gold2),var(--gold))' : 'transparent', color: canScaleDown ? '#1a1200' : 'var(--text3)', fontSize: 10, fontWeight: 900, lineHeight: 1 }}>▼</button>
              </div>
            )}
          </div>
          <div style={{ position: 'relative', width: '100%', maxWidth: 360, margin: '8px auto 0', padding: '0 8px' }}>
            <input type="number" min={1} placeholder={`Or type amount (min ₹${minBet})`} value={manualInput} onChange={e => onManual(e.target.value)} className="font-grotesk" style={{ width: '100%', height: 42, background: 'var(--surface2)', border: `1px solid ${betAmount && manualInput !== '' ? 'var(--gold)' : 'var(--line2)'}`, borderRadius: 12, padding: '0 44px 0 15px', color: 'var(--text)', fontSize: 13, fontWeight: 700, outline: 'none' }} />
            <span style={{ position: 'absolute', right: 20, top: '50%', transform: 'translateY(-50%)', color: 'var(--gold-ink)', fontWeight: 800, fontSize: 12, pointerEvents: 'none' }}>₹</span>
            {isGhostMode && (
              <div style={{ textAlign: 'center', fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: '#c4b5fd', marginTop: 8 }}>👻 GHOST MODE ACTIVE · phantom bets balance the pool and are never paid out</div>
            )}
          </div>
        </div>

        {/* Result strip, then the analytics inline beneath it */}
        <div style={{ flex: 'none', padding: '8px 0 4px' }}>
          <div style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--line)', borderTop: '1px solid var(--line2)', borderRadius: 16, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: 'var(--shadow-sm)' }}>
            <span style={{ flex: 'none', fontSize: 9, fontWeight: 800, letterSpacing: '.1em', color: 'var(--text3)' }}>{currentBoard?.name ?? ''}</span>
            <div style={{ flex: 1, display: 'flex', gap: 5, overflow: 'hidden', alignItems: 'center' }}>
              {stripBeads.length === 0
                ? <span style={{ fontSize: 9, color: 'var(--text3)' }}>No results yet</span>
                : stripBeads.map((b, i) => <span key={i} style={{ flex: 'none', width: 20, height: 20, borderRadius: '50%', background: b.bg, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-sm)' }}>{b.ch}</span>)}
            </div>
          </div>
        </div>
        <div style={{ flex: 'none', padding: '6px 0 4px' }}>
          <AnalyticsPanel ref={analyticsRef} board={currentBoard} winners={panelWinners} loadCycleHistory={loadCycleHistory} />
        </div>
      </section>

      {desktop && rightPanel}

      <BoardRulesModal isAuthenticated={!!isAuthenticated} />
    </div>
  );
};

export default GameScreen;
