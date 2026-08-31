// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * GameScreen.tsx — the redesigned Delhi vs Bombay Bazaar game experience.
 *
 * Live data from GameContext (server-authoritative via SSE/WS):
 *   • cycle timer   — derived from currentCycle.endTime (pure math, no drift)
 *   • phase/status  — currentCycle.status (OPEN/MERGED/CLOSED/RESULT_DECLARED)
 *   • pools         — subscribeToVolume(cycleType) → {totalDelhi,totalBombay}
 *   • my bets       — userBets for the current cycle, summed per side
 *   • roadmap/stats — winners from pastCycles (analytics.ts), real results only
 *
 * GOVERNANCE §2/§3: min-bet comes from sysConfig (server authority), never a
 * hardcoded number. Chip denominations are UI-only (§10, constants.CHIP_VALUES).
 * §3: gold/accent hues resolve from brand CSS variables via the theme tokens.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useGame } from '../services/GameContext';
import { BettingSide, CycleType, GameState } from '../types';
import { CHIP_VALUES } from '../constants';
import { useShell } from './RedesignShell';
import { useViewport } from './useViewport';
import { useToast } from '../components/ui/Toast';
import { fmt, timeStr } from './format';
import { analyticsFor, Side } from './analytics';
import AnalyticsDrawer from './AnalyticsDrawer';
import { getAssetUrl } from '../services/backend.service';

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
    currentCycle, gameState, cycleType, setCycleType, placeBet, placePhantomBet,
    userBets, isGhostMode, toggleGhostMode, user, isAuthenticated, sysConfig, pastCycles, subscribeToVolume, getCurrentVolume,
  } = useGame();

  // Short label for the results strip, per cycle type. A map rather than a
  // ternary so a new tab shows its own label instead of borrowing another's.
  const CYCLE_TAB_LABEL: Record<string, string> = {
    [CycleType.ONE_MIN]:    '1M',
    [CycleType.THIRTY_MIN]: '30M',
    [CycleType.FULL_DAY]:   '24H',
  };

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
  const [drawerOpen, setDrawerOpen] = useState(false);

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
  const total = poolDelhi + poolBombay;
  const dPct = total ? Math.round((poolDelhi / total) * 100) : 50;
  const bPct = 100 - dPct;

  // Phase flags.
  const isOpen = gameState === GameState.OPEN;
  const isMerged = gameState === GameState.MERGED;
  const isClosed = gameState === GameState.CLOSED;
  const isResult = gameState === GameState.RESULT_DECLARED;
  const winner = currentCycle?.winner;
  const showMerged = isMerged;

  const secondsLeft = currentCycle?.endTime ? Math.max(0, Math.floor((currentCycle.endTime - Date.now()) / 1000)) : 0;

  // My open bets this cycle.
  const cycleBets = (userBets || []).filter(b => b.cycleId === currentCycle?.id && b.status === 'PENDING' && !b.isPhantom);
  const myBetDelhi = cycleBets.filter(b => b.side === BettingSide.DELHI).reduce((a, b) => a + (b.amount || 0), 0);
  const myBetBombay = cycleBets.filter(b => b.side === BettingSide.BOMBAY).reduce((a, b) => a + (b.amount || 0), 0);
  const lockD = myBetBombay > 0;
  const lockB = myBetDelhi > 0;
  const potentialReturn = (myBetDelhi + myBetBombay) * 2;

  // Winner sequences from real history (newest first), by cycle type.
  const winnersByType = useMemo(() => {
    const build = (t: CycleType): Side[] => (pastCycles || [])
      .filter(c => c.type === t && (c.winner === 'DELHI' || c.winner === 'BOMBAY'))
      .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
      .map(c => c.winner as Side);
    // Keyed by every CycleType, so a tab cannot fall through to another type's
    // history — which is what `cycleType === THIRTY_MIN ? '30_MIN' : 'FULL_DAY'`
    // did to any third type.
    return Object.fromEntries(
      Object.values(CycleType).map(t => [t, build(t)]),
    ) as Record<CycleType, Side[]>;
  }, [pastCycles]);

  const Ag = useMemo(
    () => analyticsFor(winnersByType[cycleType] ?? [], cycleType),
    [winnersByType, cycleType],
  );
  const seqGame = Ag.seq;
  const stripBeads = seqGame.slice(0, mobile ? 14 : 26).map(bead);
  const roadmapBeads = [...seqGame.slice(0, 60)].reverse().map(bead);

  // Effective bet amount from chip or manual entry.
  const manualNum = parseInt(manualInput, 10);
  const betAmount = manualInput !== '' && !isNaN(manualNum) && manualNum > 0 ? manualNum : selectedChip;
  const minBet = sysConfig?.minBet ?? 10; // schema default 10 (SystemConfig.betLimits.thirtyMin.min)

  const chips = (CHIP_VALUES[cycleType] ?? CHIP_VALUES[CycleType.THIRTY_MIN]).map((v, i) => {
    const st = CHIP_STYLES[i % 5];
    const sel = selectedChip === v && manualInput === '';
    return {
      value: v, colorHex: st.colorHex, gFrom: st.gFrom, gTo: st.gTo, txt: st.txt, sel,
      font: v >= 1000 ? 12 : 15,
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
    if (!betAmount) { addToast('Pick a chip or enter an amount first', 'error'); return; }
    if (betAmount < minBet) { addToast(`Minimum bet for this cycle is ₹${minBet}`, 'error'); return; }
    if (side === BettingSide.DELHI && myBetBombay > 0) { addToast('You already backed BOMBAY this cycle — one side per cycle', 'error'); return; }
    if (side === BettingSide.BOMBAY && myBetDelhi > 0) { addToast('You already backed DELHI this cycle — one side per cycle', 'error'); return; }
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
    const lock = side === BettingSide.DELHI ? lockD : lockB;
    // A bet on the OTHER side blocks placing here (handleBet), but this card stays
    // fully coloured — NO grey-out (owner UX). Only result/closed states dim.
    const opacity = isResult && winner !== side ? .35 : isClosed ? .6 : 1;
    const filter = isResult && winner !== side ? 'grayscale(.7)' : 'none';
    const cursor = (isClosed || isResult || lock) ? 'not-allowed' : 'pointer';
    const gradient = side === BettingSide.DELHI
      ? 'linear-gradient(160deg,#2A0A0A,#140406 55%,#050203)'
      : 'linear-gradient(160deg,#07172E,#04101F 55%,#020814)';
    const img = cardImg[side];
    // Admin-set CDN image (if any) under a dark scrim so the labels stay legible;
    // otherwise the default themed gradient (GOVERNANCE §12).
    const background = img
      ? `linear-gradient(160deg, rgba(4,3,6,.45), rgba(4,3,6,.72)), url("${img}") center/cover no-repeat`
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
  const leftPanel = (
    <aside className="bb-noscroll" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
      <div style={sectionCard}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={labelCap}>Live Pool</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, fontWeight: 800, color: 'var(--green)' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 8px var(--green)' }} />LIVE</span>
        </div>
        {!showMerged ? (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--delhi)' }}>DELHI</span>
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>₹{fmt(poolDelhi)}</span>
            </div>
            <div style={{ height: 9, borderRadius: 6, overflow: 'hidden', display: 'flex', background: 'color-mix(in srgb,var(--delhi) 18%, transparent)', marginBottom: 12 }}>
              <div style={{ height: '100%', background: 'linear-gradient(90deg,var(--delhi),color-mix(in srgb,var(--delhi) 60%,#000))', width: dPct + '%' }} />
              <div style={{ height: '100%', flex: 1, background: 'linear-gradient(90deg,color-mix(in srgb,var(--bombay) 60%,#000),var(--bombay))' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>₹{fmt(poolBombay)}</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--bombay)' }}>BOMBAY</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>
              <span>{dPct}% share</span><span>{bPct}% share</span>
            </div>
          </>
        ) : (
          <div style={{ padding: '2px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}><span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', color: '#F0A860' }}>⚡ POOLS MERGED</span><span style={{ fontSize: 8, fontWeight: 700, color: 'var(--text3)' }}>BLIND · HIDDEN</span></div>
            <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 26, color: 'var(--gold-ink)', textShadow: '0 0 16px var(--glow)' }}>₹{fmt(total)}</div>
          </div>
        )}
      </div>
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
          <button onClick={() => setDrawerOpen(true)} style={{ fontSize: 9, fontWeight: 800, color: 'var(--gold-ink)', background: 'none', border: '1px solid var(--line2)', borderRadius: 999, padding: '3px 10px', cursor: 'pointer' }}>FULL ANALYSIS</button>
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px 0' }}><span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>Potential return</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--gold-ink)' }}>₹{fmt(potentialReturn)}</span></div>
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
            {[{ t: CycleType.FULL_DAY, l: 'FULL DAY' }, { t: CycleType.THIRTY_MIN, l: '30 MIN' }, { t: CycleType.ONE_MIN, l: '1 MIN' }].map(o => {
              const on = cycleType === o.t;
              return <button key={o.l} onClick={() => setCycleType(o.t)} style={{ padding: '7px 15px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 800, letterSpacing: '.06em', background: on ? 'linear-gradient(180deg,var(--gold2),var(--gold))' : 'transparent', color: on ? '#1a1200' : 'var(--text3)', boxShadow: on ? 'var(--shadow-sm)' : 'none' }}>{o.l}</button>;
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
          {!desktop && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 26, marginTop: 5 }}>
              {showMerged ? (
                <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--gold-ink)', textShadow: '0 0 14px var(--glow)' }}>POOL ₹{fmt(total)}</span>
              ) : (
                <>
                  <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: 'var(--delhi)', fontVariantNumeric: 'tabular-nums' }}>₹{fmt(poolDelhi)}</span>
                  <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: 'var(--bombay)', fontVariantNumeric: 'tabular-nums' }}>₹{fmt(poolBombay)}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Stage */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 0' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: cardMaxW, height: cardH, borderRadius: 20, boxShadow: 'var(--shadow)' }}>
            <div className={isResult ? 'bb-pulse' : ''} style={{ position: 'absolute', inset: 0, borderRadius: 20, overflow: 'hidden', display: 'flex', border: '1.5px solid var(--line2)' }}>
              {/* Delhi */}
              <button onClick={() => handleBet(BettingSide.DELHI)} style={sideStyle(BettingSide.DELHI)}>
                <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 82% at 50% 128%, rgba(229,72,76,.55), transparent 62%)' }} />
                <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 2px, transparent 2px 30px)', opacity: .5 }} />
                {isResult && winner === BettingSide.DELHI && <div className="bb-shimmer" />}
                <span style={{ position: 'relative', zIndex: 2, fontSize: 9, fontWeight: 800, letterSpacing: '.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,.55)' }}>India Gate</span>
                <span className="font-grotesk" style={{ position: 'relative', zIndex: 2, fontWeight: 700, fontSize: sideFont, letterSpacing: '.08em', textTransform: 'uppercase', color: isResult && winner === BettingSide.DELHI ? '#FFD700' : 'var(--delhi)', textShadow: '0 2px 12px rgba(0,0,0,.9)' }}>{isResult && winner === BettingSide.DELHI ? '🏆 DELHI' : 'Delhi'}</span>
                {myBetDelhi > 0 ? <span style={{ position: 'relative', zIndex: 2, background: 'var(--delhi)', color: '#fff', fontSize: 10, fontWeight: 800, padding: '3px 11px', borderRadius: 999, boxShadow: '0 0 16px var(--delhi)' }}>You ₹{fmt(myBetDelhi)}</span> : <span />}
              </button>
              <div style={{ width: 1.5, height: '100%', background: 'linear-gradient(180deg,transparent,var(--gold),transparent)', boxShadow: '0 0 12px var(--gold)', zIndex: 3 }} />
              {/* Bombay */}
              <button onClick={() => handleBet(BettingSide.BOMBAY)} style={sideStyle(BettingSide.BOMBAY)}>
                <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 82% at 50% 128%, rgba(46,134,222,.55), transparent 62%)' }} />
                <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 2px, transparent 2px 30px)', opacity: .5 }} />
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
            {isMerged && (
              <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 6, background: 'rgba(0,0,0,.7)', border: '1px solid var(--gold)', borderRadius: 12, padding: '6px 14px', textAlign: 'center', backdropFilter: 'blur(4px)' }}>
                <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, letterSpacing: '.1em', color: 'var(--gold-ink)' }}>⚡ POOLS MERGED</div>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.08em', color: '#F0A860', marginTop: 1 }}>BLIND BETTING · POOLS HIDDEN</div>
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
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: mobile ? 11 : 18, padding: '8px 6px 4px', background: isGhostMode ? 'rgba(139,111,224,.07)' : 'transparent', border: isGhostMode ? '1px solid rgba(139,111,224,.28)' : '1px solid transparent', borderRadius: 14, transition: 'background .2s' }}>
            {chips.map(chip => {
              const size = mobile ? 52 : desktop ? 60 : 56;
              return (
                <button key={chip.value} onClick={() => onChip(chip.value)} style={{ position: 'relative', width: size, height: size, border: 'none', background: 'none', cursor: 'pointer', transform: chip.sel ? 'translateY(-10px) scale(1.08)' : 'translateY(0) scale(1)', zIndex: chip.sel ? 5 : 1, transition: 'transform .16s ease-out' }}>
                  <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'linear-gradient(to top right,#B8860B,#F5C77A 50%,#B8860B)', boxShadow: chip.sel ? '0 16px 24px -6px rgba(0,0,0,.7)' : '0 5px 10px -4px rgba(0,0,0,.5)', border: '1px solid #8A7018' }} />
                  <span style={{ position: 'absolute', inset: '4%', borderRadius: '50%', background: `repeating-conic-gradient(from 0deg, ${chip.colorHex} 0deg 45deg, transparent 45deg 60deg)`, opacity: .92 }} />
                  <span style={{ position: 'absolute', inset: '4%', borderRadius: '50%', boxShadow: 'inset 0 2px 4px rgba(0,0,0,.4)', pointerEvents: 'none' }} />
                  <span style={{ position: 'absolute', inset: '18%', borderRadius: '50%', background: 'linear-gradient(to bottom,#FFFACD,#D4AF37 55%,#B8860B)', padding: 2, boxShadow: '0 1px 3px rgba(0,0,0,.6)' }}>
                    <span style={{ width: '100%', height: '100%', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', background: `linear-gradient(to bottom right, ${chip.gFrom}, ${chip.gTo})`, boxShadow: 'inset 0 2px 4px rgba(0,0,0,.35)' }}>
                      <span style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '45%', background: 'rgba(255,255,255,.16)', borderBottom: '1px solid rgba(255,255,255,.06)', borderRadius: '50% 50% 42% 42%' }} />
                      <span className="font-grotesk" style={{ fontWeight: 800, fontSize: chip.font, color: chip.txt, textShadow: '0 2px 2px rgba(0,0,0,.8)', position: 'relative', zIndex: 2, letterSpacing: '-.02em' }}>{chip.value}</span>
                    </span>
                  </span>
                  <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden', pointerEvents: 'none' }}><span className="bb-chipshine" style={{ position: 'absolute', top: '-50%', left: '-50%', width: '200%', height: '200%', background: 'linear-gradient(to right,transparent,rgba(255,255,255,.32),transparent)' }} /></span>
                  {chip.sel && <span style={{ position: 'absolute', inset: 1, borderRadius: '50%', border: '2px solid var(--gold)', boxShadow: '0 0 12px var(--glow)', pointerEvents: 'none' }} />}
                </button>
              );
            })}
          </div>
          <div style={{ position: 'relative', width: '100%', maxWidth: 360, margin: '8px auto 0', padding: '0 8px' }}>
            <input type="number" min={1} placeholder={`Or type amount (min ₹${minBet})`} value={manualInput} onChange={e => onManual(e.target.value)} className="font-grotesk" style={{ width: '100%', height: 42, background: 'var(--surface2)', border: `1px solid ${betAmount && manualInput !== '' ? 'var(--gold)' : 'var(--line2)'}`, borderRadius: 12, padding: '0 44px 0 15px', color: 'var(--text)', fontSize: 13, fontWeight: 700, outline: 'none' }} />
            <span style={{ position: 'absolute', right: 20, top: '50%', transform: 'translateY(-50%)', color: 'var(--gold-ink)', fontWeight: 800, fontSize: 12, pointerEvents: 'none' }}>₹</span>
            {(myBetDelhi > 0 || myBetBombay > 0) && !isResult && (
              <div style={{ textAlign: 'center', fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: 'var(--gold-ink)', marginTop: 8 }}>🔒 One side per cycle — locked to {myBetDelhi > 0 ? 'DELHI' : 'BOMBAY'}</div>
            )}
            {isGhostMode && (
              <div style={{ textAlign: 'center', fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: '#c4b5fd', marginTop: 8 }}>👻 GHOST MODE ACTIVE · phantom bets balance the pool and are never paid out</div>
            )}
          </div>
        </div>

        {/* Result strip → analytics drawer */}
        <div style={{ flex: 'none', padding: '8px 0 4px' }}>
          <button onClick={() => setDrawerOpen(true)} style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--line)', borderTop: '1px solid var(--line2)', borderRadius: 16, padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, boxShadow: 'var(--shadow-sm)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', color: 'var(--text3)' }}>{CYCLE_TAB_LABEL[cycleType] ?? '30M'}</span>
            </span>
            <div style={{ flex: 1, display: 'flex', gap: 5, overflow: 'hidden', alignItems: 'center' }}>
              {stripBeads.length === 0
                ? <span style={{ fontSize: 9, color: 'var(--text3)' }}>No results yet</span>
                : stripBeads.map((b, i) => <span key={i} style={{ flex: 'none', width: 20, height: 20, borderRadius: '50%', background: b.bg, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-sm)' }}>{b.ch}</span>)}
            </div>
            <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--gold-ink)' }}>
              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em' }}>ANALYTICS</span>
              <span style={{ width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>▲</span>
            </span>
          </button>
        </div>
      </section>

      {desktop && rightPanel}

      <AnalyticsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} winnersByType={winnersByType} />
    </div>
  );
};

export default GameScreen;
