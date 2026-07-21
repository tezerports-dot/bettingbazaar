// C-03 fix: brand colors use CSS variables — GOVERNANCE §3: no hex literals for brand colors.
// Replace: style={{color:'var(--brand-primary)'}} → style={{color: 'var(--brand-primary)'}}
// Replace: className="text-[#D4AF37]" → className="text-[color:var(--brand-primary)]"
// Full sweep is done by scripts/apply-brand-variables.sh (generated in this patch).
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { memo, useMemo } from 'react';
import { useGame } from '../../services/GameContext';
import { BettingSide, GameState } from '../../types';
import { Show } from '../ui/Show';
import { getAssetUrl, getCdnBaseUrl } from '../../services/backend.service';
import { BETTING_ALLOWED } from '../../GAME_CORE';

interface BettingCardProps {
  onPlaceBet: (side: BettingSide) => void;
  selectedAmount: number | null;
  isMerged?: boolean;
}

// ── Particle generator — renders inside the winning card only ───────────────
const WinnerParticles: React.FC<{ color: string }> = memo(({ color }) => {
  // Pre-calculate particle positions on mount (stable across re-renders)
  const particles = useMemo(() => {
    return Array.from({ length: 48 }, (_, i) => {
      const angle    = (i / 48) * 360 + Math.random() * 10;
      const dist     = 40 + Math.random() * 100;
      const tx       = (Math.cos((angle * Math.PI) / 180) * dist).toFixed(1) + 'px';
      const ty       = (Math.sin((angle * Math.PI) / 180) * dist).toFixed(1) + 'px';
      const delay    = (Math.random() * 1.8).toFixed(2) + 's';
      const size     = (Math.random() * 6 + 2).toFixed(1) + 'px';
      const duration = (1.0 + Math.random() * 1.5).toFixed(2) + 's';
      // Mix in gold sparks, white sparks and the team color
      const rng = Math.random();
      const particleColor = rng > 0.6 ? color : rng > 0.3 ? '#FFD700' : '#FFFFFF';
      return { tx, ty, delay, size, duration, color: particleColor, key: i };
    });
  }, []); // empty deps — generate once

  return (
    <>
      {particles.map(p => (
        <div
          key={p.key}
          className="firework-particle will-change-transform"
          style={{
            left: '50%',
            top: '50%',
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            '--fx': p.tx,
            '--fy': p.ty,
            animationDelay: p.delay,
            animationDuration: p.duration,
          } as React.CSSProperties}
        />
      ))}
    </>
  );
});

// useCdnTick — re-renders when CDN URL becomes available after branding SSE arrives
function useCdnTick(): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const handler = () => setTick(n => n + 1);
    window.addEventListener('cdn_url_updated', handler);
    return () => window.removeEventListener('cdn_url_updated', handler);
  }, []);
  return tick;
}

const BettingCard: React.FC<BettingCardProps> = memo(({ onPlaceBet, isMerged }) => {
  const { gameState, userBets, currentCycle } = useGame();
  const _cdnTick = useCdnTick(); // eslint-disable-line @typescript-eslint/no-unused-vars

  const currentCycleBets = userBets.filter(
    b => b.cycleId === currentCycle.id && b.status === 'PENDING'
  );

  const myBetDelhi  = currentCycleBets
    .filter(b => b.side === BettingSide.DELHI)
    .reduce((acc, b) => acc + b.amount, 0);

  const myBetBombay = currentCycleBets
    .filter(b => b.side === BettingSide.BOMBAY)
    .reduce((acc, b) => acc + b.amount, 0);

  // Lock state comes from GAME_CORE.BETTING_ALLOWED — do not edit inline
  const isClosed          = gameState === GameState.CLOSED;
  const isResultDeclared  = gameState === GameState.RESULT_DECLARED;
  const isLocked          = BETTING_ALLOWED.uiLocked(gameState);
  const winner            = currentCycle.winner;

  const handleCardClick = (side: BettingSide) => {
    if (isLocked) return;
    onPlaceBet(side);
  };

  // DYNAMIC IMAGES
  const delhiImg  = getAssetUrl('delhi.jpg',  'https://images.unsplash.com/photo-1587474260584-136574528ed5?auto=format&fit=crop&q=80&w=600');
  const bombayImg = getAssetUrl('bombay.jpg', 'https://images.unsplash.com/photo-1570168007204-dfb528c6958f?auto=format&fit=crop&q=80&w=600');

  // ── Card side renderer ─────────────────────────────────────────────────────
  const renderSide = (
    side: BettingSide,
    imgSrc: string,
    imgAlt: string,
    labelColor: string,
    bgColor: string,
    overlayColor: string,
    myBet: number,
  ) => {
    const isWinner  = isResultDeclared && winner === side;
    const isLoser   = isResultDeclared && winner !== undefined && winner !== side;

    return (
      <button
        className={`
          w-1/2 h-full relative flex flex-col items-center justify-between py-5
          transition-all duration-300 overflow-hidden will-change-transform
          ${bgColor}
          ${isLocked && !isResultDeclared ? 'grayscale opacity-40 cursor-not-allowed' : ''}
          ${!isLocked && !isResultDeclared ? 'hover:brightness-110 active:brightness-125' : ''}
          ${isLoser ? 'grayscale opacity-25' : ''}
          ${isWinner ? 'z-20' : ''}
          ${isWinner ? 'animate-winner-border' : ''}
        `}
        onClick={() => handleCardClick(side)}
        disabled={isLocked}
        aria-label={`Bet on ${side}`}
      >
        {/* ── Background image ─────────────────────────────────────── */}
        <div className="absolute inset-0 pointer-events-none">
          <img
            src={imgSrc}
            alt={imgAlt}
            className={`w-full h-full object-cover transition-transform duration-700
              ${!isLocked && !isResultDeclared ? 'hover:scale-110' : ''}
              ${isWinner ? 'scale-105' : ''}
            `}
            loading="lazy"
          />
          <div
            className="absolute inset-0 mix-blend-multiply pointer-events-none"
            style={{
              background: `linear-gradient(to bottom, rgba(0,0,0,0.80), ${overlayColor}, rgba(0,0,0,0.90))`,
            }}
          />

          {/* ── WINNER FX (shown when RESULT_DECLARED) ───────────── */}
          {isWinner && (
            <>
              {/* Colour overlay pulse */}
              <div
                className="absolute inset-0 animate-winner-glow mix-blend-overlay pointer-events-none"
                style={{ backgroundColor: `${overlayColor.replace('0.30', '0.55')}` }}
              />

              {/* Deep glow border layer */}
              <div
                className="absolute inset-0 animate-pulse pointer-events-none"
                style={{
                  boxShadow: `inset 0 0 40px 8px ${overlayColor.replace('0.30', '0.6')}`,
                }}
              />

              {/* Shimmer light sweep — first pass */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div
                  className="absolute top-0 bottom-0 w-1/4 animate-winner-shimmer pointer-events-none"
                  style={{
                    background: 'linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.45) 50%, transparent 80%)',
                  }}
                />
              </div>

              {/* Shimmer light sweep — second pass (delayed) */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div
                  className="absolute top-0 bottom-0 w-1/4 pointer-events-none"
                  style={{
                    background: 'linear-gradient(105deg, transparent 20%, rgba(255,215,0,0.3) 50%, transparent 80%)',
                    animation: 'winner-shimmer 2.2s ease-in-out infinite',
                    animationDelay: '1.1s',
                  }}
                />
              </div>

              {/* Top edge glow bar */}
              <div
                className="absolute top-0 left-0 right-0 h-1 animate-pulse pointer-events-none"
                style={{
                  background: `linear-gradient(to right, transparent, ${labelColor}, #FFD700, ${labelColor}, transparent)`,
                  boxShadow: `0 0 12px 2px ${labelColor}`,
                }}
              />

              {/* Bottom edge glow bar */}
              <div
                className="absolute bottom-0 left-0 right-0 h-1 animate-pulse pointer-events-none"
                style={{
                  background: `linear-gradient(to right, transparent, ${labelColor}, #FFD700, ${labelColor}, transparent)`,
                  boxShadow: `0 0 12px 2px ${labelColor}`,
                }}
              />

              {/* Fireworks particles — contained inside card */}
              <div className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none">
                <WinnerParticles color={labelColor} />
              </div>
            </>
          )}
        </div>

        {/* ── Label ─────────────────────────────────────────────────── */}
        <span
          className={`
            relative z-10 font-black text-xl uppercase tracking-widest
            drop-shadow-[0_2px_4px_rgba(0,0,0,1)] transition-all duration-500
            ${isWinner
              ? 'animate-winner-text text-[#FFD700]'
              : `${labelColor.startsWith('#') ? '' : 'text-inherit'}`
            }
            ${isMerged && !isResultDeclared ? 'opacity-50' : ''}
          `}
          style={{ color: isWinner ? '#FFD700' : labelColor }}
        >
          {isWinner
            ? `🏆 ${side === BettingSide.DELHI ? 'DELHI' : 'BOMBAY'} WINS!`
            : side === BettingSide.DELHI ? 'Delhi' : 'Bombay'}
        </span>

        {/* ── My bet badge ──────────────────────────────────────────── */}
        {myBet > 0 && (
          <div
            className="text-white text-[10px] font-bold px-3 py-1 rounded-full z-10 border border-white/20"
            style={{
              backgroundColor: labelColor,
              boxShadow: `0 0 15px ${labelColor}`,
            }}
          >
            You: ₹{myBet.toLocaleString()}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="flex-1 w-full flex flex-col items-center justify-center px-4 relative z-10 py-4 min-h-[180px]">
      <div className="relative w-full h-full max-h-[230px] max-w-[500px] perspective-1000">

        {/* ── Main card container ──────────────────────────────────────── */}
        <div
          className={`
            absolute inset-0 rounded-2xl shadow-[0_25px_50px_-12px_rgba(0,0,0,0.7)]
            bg-[#0B0E14] flex overflow-hidden
            border transition-all duration-500
            ${isResultDeclared
              ? 'border-[#D4AF37] border-2 shadow-[0_0_60px_rgba(var(--brand-primary-rgb,212,175,55),0.5)]'
              : 'border-[#D4AF37]/30'
            }
          `}
        >
          {/* Delhi */}
          {renderSide(
            BettingSide.DELHI,
            delhiImg,
            'India Gate',
            '#E53935',   // label / particle colour
            'bg-[#1A0505]',
            'rgba(229,57,53,0.30)',
            myBetDelhi,
          )}

          {/* Divider */}
          <div className="w-[1px] h-full bg-gradient-to-b from-transparent via-[#D4AF37] to-transparent z-20 shadow-[0_0_10px_#D4AF37]" />

          {/* Bombay */}
          {renderSide(
            BettingSide.BOMBAY,
            bombayImg,
            'Gateway of India',
            '#1E88E5',
            'bg-[#050A1A]',
            'rgba(30,136,229,0.30)',
            myBetBombay,
          )}
        </div>

        {/* ── BETS CLOSED OVERLAY ───────────────────────────────────────── */}
        {gameState === GameState.CLOSED && !isResultDeclared && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/70 backdrop-blur-[2px] rounded-2xl border border-red-500/50 animate-in fade-in duration-300 pointer-events-none">
            <div className="w-16 h-16 rounded-full bg-red-600/20 border-2 border-red-500 flex items-center justify-center mb-3 shadow-[0_0_30px_rgba(220,38,38,0.5)] animate-bounce-slight">
              <span className="text-3xl">🔒</span>
            </div>
            <h3 className="text-2xl font-black text-red-500 tracking-widest uppercase drop-shadow-md">BETS CLOSED</h3>
            <div className="text-[#D4AF37] text-xs font-bold mt-2 animate-pulse">RESULT PENDING...</div>
          </div>
        )}

        {/* ── POOLS MERGED OVERLAY (pointer-events-none so clicks pass through to bet) ── */}
        {gameState === GameState.MERGED && !isResultDeclared && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center pointer-events-none">
            <div className="bg-black/75 px-4 py-2 rounded-xl border border-[#D4AF37] shadow-[0_0_24px_rgba(var(--brand-primary-rgb,212,175,55),0.5)] backdrop-blur-sm">
              <h3 className="text-lg font-black text-[#D4AF37] tracking-widest uppercase animate-pulse text-center">⚡ POOLS MERGED</h3>
              <div className="text-[9px] text-orange-300 text-center font-bold mt-0.5">BLIND BETTING · POOLS HIDDEN</div>
            </div>
          </div>
        )}

        {/* ── VS BADGE ─────────────────────────────────────────────────── */}
        {!isClosed && !isResultDeclared && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 bg-[#0B0E14] rounded-full border-[2px] border-[#D4AF37] flex items-center justify-center z-30 shadow-[0_0_20px_rgba(var(--brand-primary-rgb,212,175,55),0.6)]">
            <span className="text-[#D4AF37] font-black italic text-lg leading-none pt-0.5">VS</span>
          </div>
        )}



      </div>
    </div>
  );
});

export default BettingCard;
