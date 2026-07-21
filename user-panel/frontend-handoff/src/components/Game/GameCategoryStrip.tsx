// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * GameCategoryStrip — horizontal swipeable game-category cards.
 * Always shows Delhi Bazaar (our main game).
 * Crash / Casino / Sports appear only when admin has enabled those providers.
 * Matches the dark-gold theme with chevron card shapes.
 */
import React, { useRef } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useGameProviders } from '../../services/GameProviderContext';

interface Card {
  key:      string;
  path:     string;
  title:    string;
  sub:      string;
  tagline:  string;
  icon:     string;
  grad:     [string, string];
  accent:   string;
}

const BASE_CARDS: Card[] = [
  {
    key:     'game',
    path:    '/',
    title:   'DELHI BAZAAR',
    sub:     'VS BOMBAY',
    tagline: 'Place your bet now!',
    icon:    '🎯',
    grad:    ['#1a0a00', '#2d1500'],
    accent:  '#D4AF37',
  },
  {
    key:     'crash',
    path:    '/crash',
    title:   'CASH OR CRASH',
    sub:     'Take the flight',
    tagline: 'Ship money to your pocket!',
    icon:    '✈️',
    grad:    ['#0a0f2a', '#0d1a3a'],
    accent:  '#60a5fa',
  },
  {
    key:     'casino',
    path:    '/casino',
    title:   'CASINO',
    sub:     'Any time, any where',
    tagline: 'Play to win big!',
    icon:    '🃏',
    grad:    ['#1a0a1a', '#2d0d2d'],
    accent:  '#a78bfa',
  },
  {
    key:     'sports',
    path:    '/sports',
    title:   'BET ANYTIME',
    sub:     'Win Anytime',
    tagline: 'Your winning ticket awaits!',
    icon:    '🏇',
    grad:    ['#001a0a', '#002d12'],
    accent:  '#34d399',
  },
];

const GameCategoryStrip: React.FC = () => {
  const navigate   = useNavigate();
  const location   = useLocation();
  const { anyCrash, anyCasino, anySports, loading } = useGameProviders();
  const stripRef   = useRef<HTMLDivElement>(null);

  if (loading) return null;

  const enabled: Record<string, boolean> = {
    game: true, crash: anyCrash, casino: anyCasino, sports: anySports,
  };
  const cards = BASE_CARDS.filter(c => enabled[c.key]);

  return (
    <div className="flex-none w-full overflow-hidden" style={{ background: '#080b12' }}>
      <div
        ref={stripRef}
        className="flex gap-2.5 px-3 py-2.5 overflow-x-auto"
        style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
      >
        {cards.map((card) => {
          const isActive = card.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(card.path);

          return (
            <button
              key={card.key}
              onClick={() => navigate(card.path)}
              className="flex-shrink-0 relative overflow-hidden active:scale-95 transition-transform"
              style={{
                width: '160px',
                height: '72px',
                borderRadius: '10px',
                background: `linear-gradient(135deg, ${card.grad[0]} 0%, ${card.grad[1]} 100%)`,
                border: `1.5px solid ${isActive ? card.accent : 'rgba(255,255,255,0.07)'}`,
                boxShadow: isActive
                  ? `0 0 16px ${card.accent}40, inset 0 0 20px rgba(0,0,0,0.3)`
                  : '0 2px 8px rgba(0,0,0,0.4)',
              }}
            >
              {/* Chevron right edge decoration */}
              <div className="absolute right-0 top-0 h-full w-8 opacity-20"
                style={{ background: `linear-gradient(to left, ${card.accent}40, transparent)` }} />

              {/* Active indicator bar */}
              {isActive && (
                <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-full"
                  style={{ background: `linear-gradient(90deg, transparent, ${card.accent}, transparent)` }} />
              )}

              {/* Content */}
              <div className="absolute inset-0 flex items-center justify-between px-3">
                <div className="text-left flex-1 min-w-0">
                  <p className="font-black text-[11px] leading-tight uppercase tracking-wide"
                    style={{ color: card.accent, textShadow: `0 0 8px ${card.accent}60` }}>
                    {card.title}
                  </p>
                  <p className="text-[9px] font-semibold text-white/70 leading-tight mt-0.5 truncate">
                    {card.sub}
                  </p>
                  <p className="text-[8px] text-white/40 leading-tight mt-0.5 truncate">
                    {card.tagline}
                  </p>
                </div>
                <div className="text-3xl ml-2 flex-shrink-0 leading-none"
                  style={{ filter: `drop-shadow(0 0 6px ${card.accent}80)` }}>
                  {card.icon}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {/* Bottom divider */}
      <div style={{ height: '1px', background: 'linear-gradient(90deg,transparent,rgba(212,175,55,0.25) 38.2%,rgba(212,175,55,0.25) 61.8%,transparent)' }} />
    </div>
  );
};

export default GameCategoryStrip;
