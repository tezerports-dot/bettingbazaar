// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * WinnersPage.tsx — RESTORED + REDESIGNED
 * 3D podium for Top-3, ranked list for Top-10.
 * Data from GET /api/v1/winners (backend-managed: real bets + admin-curated).
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

const GOLD = '#D4AF37';
const SILVER = '#9CA3AF';
const BRONZE = '#CD7F32';

interface Winner {
  displayName: string;
  profilePic?: string;
  amount: number;
  betAmount?: number;
  game?: string;
  isReal?: boolean;
  source?: string;
}

function Avatar({ name, pic, size = 48 }: { name: string; pic?: string; size?: number }) {
  const [err, setErr] = useState(false);
  const initials = name.slice(0, 2).toUpperCase();
  if (pic && !err) {
    return <img src={pic} alt={name} onError={() => setErr(true)}
      style={{ width: size, height: size }} className="rounded-full object-cover border-2 border-white/20" />;
  }
  return (
    <div style={{ width: size, height: size, background: 'linear-gradient(135deg,#1a1f2e,#2a3349)', fontSize: size / 3 }}
      className="rounded-full flex items-center justify-center text-white font-black border-2 border-white/10">
      {initials}
    </div>
  );
}

function PodiumStand({ winner, rank, height, color }: { winner: Winner; rank: number; height: number; color: string }) {
  const icons = { 1: '👑', 2: '🥈', 3: '🥉' } as Record<number, string>;
  return (
    <div className="flex flex-col items-center" style={{ flex: 1 }}>
      {/* Avatar + badge */}
      <div className="relative mb-2">
        <Avatar name={winner.displayName} pic={winner.profilePic} size={rank === 1 ? 64 : 52} />
        <span className="absolute -top-2 -right-1 text-lg">{icons[rank]}</span>
      </div>
      {/* Name */}
      <p className="text-white font-bold text-xs mb-0.5 truncate max-w-[70px] text-center">{winner.displayName}</p>
      {/* Win amount */}
      <p className="font-black text-sm mb-2" style={{ color }}>₹{winner.amount.toLocaleString('en-IN')}</p>
      {/* Stand */}
      <div className="w-full rounded-t-lg flex flex-col items-center justify-center py-3 shadow-lg"
        style={{ height, background: `linear-gradient(180deg, ${color}22, ${color}11)`, border: `1.5px solid ${color}44` }}>
        <span className="font-black text-2xl" style={{ color }}>#{rank}</span>
        {winner.betAmount ? (
          <p className="text-[9px] text-white/40 mt-0.5">bet ₹{winner.betAmount.toLocaleString('en-IN')}</p>
        ) : null}
      </div>
    </div>
  );
}

export default function WinnersPage() {
  const navigate = useNavigate();
  const [winners, setWinners]   = useState<Winner[]>([]);
  const [loading, setLoading]   = useState(true);
  const [period, setPeriod]     = useState<'today'|'week'>('today');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/v1/winners?limit=10&period=${period}`)
      .then(r => r.json())
      .then(d => { if (d.success) setWinners(d.winners || d.data || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [period]);

  const top3   = winners.slice(0, 3);
  const rest   = winners.slice(3, 10);
  const [p2, p1, p3] = [top3[1], top3[0], top3[2]]; // podium order: 2nd left, 1st centre, 3rd right

  return (
    <div className="flex flex-col h-full bg-[#080B12] text-white overflow-y-auto pb-6">
      {/* Header */}
      <div className="relative px-4 pt-5 pb-4"
        style={{ background: 'linear-gradient(180deg,#0d1120 0%,#080b12 100%)' }}>
        <button onClick={() => navigate(-1)} className="text-slate-500 text-xs mb-3 block">← Back</button>
        <h1 className="text-2xl font-black tracking-wider" style={{ color: GOLD }}>🏆 TOP WINNERS</h1>
        {/* Period toggle */}
        <div className="flex gap-2 mt-3">
          {(['today','week'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${period === p ? 'text-black' : 'text-white/50 bg-white/5'}`}
              style={period === p ? { background: GOLD } : {}}>
              {p === 'today' ? 'Today' : 'This Week'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-10 h-10 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: GOLD, borderTopColor: 'transparent' }} />
        </div>
      ) : winners.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-white/30">
          <span className="text-5xl">🎯</span>
          <p className="font-semibold">No winners data yet</p>
          <p className="text-xs">Place bets to appear on the podium!</p>
        </div>
      ) : (
        <>
          {/* ── 3D Podium ─────────────────────────────────────────────────── */}
          {top3.length >= 2 && (
            <div className="mx-4 mt-4 mb-2">
              {/* Spotlight glow */}
              <div className="absolute inset-x-0 top-32 h-32 pointer-events-none opacity-30"
                style={{ background: `radial-gradient(ellipse 60% 40% at 50% 0%, ${GOLD}66, transparent)` }} />
              <div className="flex items-end gap-1 px-2 relative">
                {/* 2nd place — left */}
                {p2 && <PodiumStand winner={p2} rank={2} height={80} color={SILVER} />}
                {/* 1st place — centre (tallest) */}
                {p1 && <PodiumStand winner={p1} rank={1} height={110} color={GOLD} />}
                {/* 3rd place — right */}
                {p3 && <PodiumStand winner={p3} rank={3} height={60} color={BRONZE} />}
              </div>
              {/* Podium base */}
              <div className="h-2 rounded-b-xl mx-2"
                style={{ background: `linear-gradient(90deg, ${SILVER}33, ${GOLD}55, ${BRONZE}33)` }} />
            </div>
          )}

          {/* ── Top 4-10 list ─────────────────────────────────────────────── */}
          {rest.length > 0 && (
            <div className="mx-4 mt-4 space-y-2">
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-bold mb-2">Runners Up</p>
              {rest.map((w, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl px-4 py-3"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <span className="text-white/30 font-black text-sm w-5 text-right">#{i + 4}</span>
                  <Avatar name={w.displayName} pic={w.profilePic} size={36} />
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm truncate">{w.displayName}</p>
                    {w.game && <p className="text-[10px] text-white/30">{w.game}</p>}
                  </div>
                  <div className="text-right">
                    <p className="font-black text-sm" style={{ color: GOLD }}>₹{w.amount.toLocaleString('en-IN')}</p>
                    {w.betAmount ? <p className="text-[9px] text-white/25">bet ₹{w.betAmount.toLocaleString('en-IN')}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
