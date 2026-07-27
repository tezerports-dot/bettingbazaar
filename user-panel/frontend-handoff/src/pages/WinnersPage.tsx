// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * WinnersPage.tsx — 2026 "Bazaar" redesign. Hall of Champions podium + runners-up,
 * wired to GET /api/v1/winners (real bets + admin-curated), with a today/week toggle.
 */
import React, { useEffect, useState } from 'react';
import { fmt } from '../redesign/format';
import ScreenShell, { card, capLabel } from '../redesign/Screen';

interface Winner { displayName: string; profilePic?: string; amount: number; betAmount?: number; game?: string; }

const MEDAL: Record<number, { color: string; medal: string; podH: number; avSize: number }> = {
  1: { color: '#F5C77A', medal: '👑', podH: 92, avSize: 62 },
  2: { color: '#C7CBD1', medal: '🥈', podH: 70, avSize: 52 },
  3: { color: '#D9A066', medal: '🥉', podH: 54, avSize: 52 },
};

const COINS = [12, 26, 40, 54, 68, 82, 20, 48, 74, 90, 6, 60];

export default function WinnersPage() {
  const [winners, setWinners] = useState<Winner[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'today' | 'week'>('today');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/v1/winners?limit=10&period=${period}`)
      .then(r => r.json())
      .then(d => { if (d.success) setWinners(d.winners || d.data || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [period]);

  const top3 = winners.slice(0, 3);
  const rest = winners.slice(3, 10);
  const podium = [top3[1], top3[0], top3[2]].map((w, i) => w ? { ...w, rank: i === 1 ? 1 : i === 0 ? 2 : 3 } : null);

  return (
    <ScreenShell icon="🏆" title="Top Winners" sub="Biggest wins right now">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {(['today', 'week'] as const).map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ padding: '7px 16px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, background: period === p ? 'var(--gold)' : 'var(--surface3)', color: period === p ? '#1a1200' : 'var(--text2)' }}>{p === 'today' ? 'Today' : 'This Week'}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><span className="bb-spin" style={{ display: 'inline-block', width: 28, height: 28, border: '2px solid var(--line2)', borderTopColor: 'var(--gold)', borderRadius: '50%' }} /></div>
      ) : winners.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: '36px 16px' }}><div style={{ fontSize: 40, marginBottom: 8 }}>🎯</div><div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>No winners yet</div><div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Place bets to appear on the podium!</div></div>
      ) : (
        <>
          {/* Podium */}
          <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 20, background: 'radial-gradient(120% 90% at 50% -10%,rgba(212,175,55,.22),transparent 60%),linear-gradient(180deg,var(--surface2),var(--surface))', border: '1px solid var(--line2)', boxShadow: 'var(--shadow)', padding: '18px 10px 14px', marginBottom: 14 }}>
            <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
              {COINS.map((L, i) => <span key={i} style={{ position: 'absolute', top: -20, left: L + '%', width: 13 + (i % 3) * 4, height: 13 + (i % 3) * 4, borderRadius: '50%', background: 'radial-gradient(circle at 35% 30%,#FFF1B8,#D4AF37 55%,#9c7a15)', boxShadow: '0 0 6px rgba(212,175,55,.6)', animation: `bb-coinfall ${(2.8 + (i % 4) * 0.5).toFixed(1)}s linear ${(i * 0.5 % 3.2).toFixed(2)}s infinite` }} />)}
            </div>
            <div style={{ position: 'relative', textAlign: 'center', fontSize: 10, fontWeight: 800, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--gold-ink)', marginBottom: 10 }}>🏆 Hall of Champions</div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 8 }}>
              {podium.map((w, i) => {
                if (!w) return <div key={i} style={{ flex: 1, maxWidth: 120 }} />;
                const m = MEDAL[w.rank];
                return (
                  <div key={i} style={{ flex: 1, maxWidth: 120, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span className="font-grotesk" style={{ width: m.avSize, height: m.avSize, borderRadius: '50%', background: 'linear-gradient(135deg,var(--surface2),var(--surface3))', border: `2px solid ${m.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16, color: 'var(--text)', position: 'relative', boxShadow: `0 0 18px -4px ${m.color}`, overflow: 'visible' }}>
                      {w.profilePic ? <img src={w.profilePic} alt={w.displayName} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} /> : w.displayName.slice(0, 2).toUpperCase()}
                      <span style={{ position: 'absolute', top: -10, right: -4, fontSize: 16 }}>{m.medal}</span>
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginTop: 8, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.displayName}</span>
                    <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: m.color, marginBottom: 8 }}>₹{fmt(w.amount)}</span>
                    <div style={{ width: '100%', borderRadius: '10px 10px 0 0', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8, height: m.podH, background: `linear-gradient(180deg,color-mix(in srgb,${m.color} 26%,transparent),color-mix(in srgb,${m.color} 8%,transparent))`, border: `1px solid color-mix(in srgb,${m.color} 30%,transparent)` }}>
                      <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 20, color: m.color }}>#{w.rank}</span>
                      {w.betAmount ? <span style={{ fontSize: 8, color: 'var(--text3)', marginTop: 2 }}>bet ₹{fmt(w.betAmount)}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Runners up */}
          {rest.length > 0 && (
            <div style={{ ...card, padding: '6px 16px' }}>
              <div style={{ ...capLabel, fontSize: 9, color: 'var(--text3)', padding: '12px 0 4px' }}>Runners up</div>
              {rest.map((w, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderTop: '1px solid var(--line)' }}>
                  <span className="font-grotesk" style={{ width: 22, textAlign: 'right', fontWeight: 700, fontSize: 13, color: 'var(--text3)' }}>#{i + 4}</span>
                  <span style={{ width: 34, height: 34, flex: 'none', borderRadius: '50%', background: 'var(--surface3)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, overflow: 'hidden' }}>{w.profilePic ? <img src={w.profilePic} alt={w.displayName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : '👤'}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.displayName}</span>
                  <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: 'var(--gold-ink)' }}>₹{fmt(w.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </ScreenShell>
  );
}
