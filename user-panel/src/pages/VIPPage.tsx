// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * VIPPage.tsx — 2026 "Bazaar" redesign. VIP tiers & progress wired to the real
 * VIP API (/api/vip/my + /api/vip/config); a static tier ladder is shown if no
 * config is configured so the page is never blank.
 */
import React, { useEffect, useState } from 'react';
import { fmt } from '../redesign/format';
import ScreenShell, { card } from '../redesign/Screen';
import { apiUrl } from '../services/apiUrl';

const FALLBACK_LEVELS = [
  { level: 0, name: 'Bronze', badgeIcon: '🥉', minTotalDeposit: 0, bonusPercent: 5, dailyWithdrawalLimit: 10000 },
  { level: 1, name: 'Silver', badgeIcon: '⭐', minTotalDeposit: 50000, bonusPercent: 8, dailyWithdrawalLimit: 50000 },
  { level: 2, name: 'Gold', badgeIcon: '🏅', minTotalDeposit: 200000, bonusPercent: 12, dailyWithdrawalLimit: 200000 },
  { level: 3, name: 'Platinum', badgeIcon: '💠', minTotalDeposit: 1000000, bonusPercent: 15, dailyWithdrawalLimit: 500000 },
  { level: 4, name: 'Diamond', badgeIcon: '💎', minTotalDeposit: 5000000, bonusPercent: 20, dailyWithdrawalLimit: 2000000 },
];

export default function VIPPage() {
  const [data, setData] = useState<any>({});
  const [config, setConfig] = useState<any>({ levels: [] });

  useEffect(() => {
    const token = localStorage.getItem('auth_token') || '';
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch(apiUrl('/api/vip/my'), { headers: h, credentials: 'include' }).then(r => r.json()).catch(() => ({})),
      fetch(apiUrl('/api/vip/config')).then(r => r.json()).catch(() => ({})),
    ]).then(([v, c]) => { if (v?.success) setData(v); if (c?.success) setConfig(c.config || { levels: [] }); });
  }, []);

  const levels = (config.levels && config.levels.length ? config.levels : FALLBACK_LEVELS);
  const myLevel = data.vip?.currentLevel || 0;
  const myDeposit = data.vip?.totalDeposited || 0;
  const current = levels.find((l: any) => l.level === myLevel) || levels[0] || {};
  const next = levels.find((l: any) => l.level === myLevel + 1);
  const progress = next ? Math.min(100, (myDeposit / (next.minTotalDeposit || 1)) * 100) : 100;

  return (
    <ScreenShell icon="💎" title="VIP Program" sub="Climb the tiers, earn more">
      {/* Current level hero */}
      <div style={{ borderRadius: 18, padding: 18, background: 'linear-gradient(135deg,#161228,#0c0a14),radial-gradient(120% 120% at 100% 0,rgba(167,139,250,.3),transparent 55%)', border: '1px solid rgba(167,139,250,.3)', boxShadow: 'var(--shadow)', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.1em', color: '#c4b5fd' }}>CURRENT · {(current.name || 'Bronze').toUpperCase()}</span>
          {next ? <span style={{ fontSize: 11, fontWeight: 700, color: '#c4b5fd' }}>Next: {next.name}</span> : <span style={{ fontSize: 11, fontWeight: 700, color: '#f5c77a' }}>🏆 Max tier</span>}
        </div>
        <div style={{ height: 12, borderRadius: 7, background: 'rgba(255,255,255,.1)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${progress}%`, borderRadius: 7, background: 'linear-gradient(90deg,#a78bfa,#f5c77a)' }} /></div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9, fontSize: 11, color: '#b9b2cf' }}>
          <span>₹{fmt(myDeposit)} wagered</span>
          {next && <span>₹{fmt(Math.max(0, (next.minTotalDeposit || 0) - myDeposit))} to {next.name}</span>}
        </div>
      </div>

      {/* Tier ladder */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {levels.map((lvl: any) => {
          const isCurrent = lvl.level === myLevel;
          const locked = lvl.level > myLevel;
          return (
            <div key={lvl.level} style={{ display: 'flex', alignItems: 'center', gap: 13, background: isCurrent ? 'color-mix(in srgb,var(--gold) 12%,var(--surface))' : 'var(--surface)', border: `1px solid ${isCurrent ? 'var(--gold)' : 'var(--line)'}`, borderRadius: 14, padding: '14px 15px', boxShadow: 'var(--shadow-sm)' }}>
              <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: isCurrent ? 'var(--gold)' : 'var(--surface3)', color: isCurrent ? '#1a1200' : 'var(--text3)', fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{lvl.badgeIcon || (locked ? '🔒' : '★')}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: locked ? 'var(--text3)' : 'var(--text)' }}>{lvl.name}{isCurrent ? ' · Current' : ''}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>+{lvl.bonusPercent || 0}% bonus · ₹{fmt(lvl.dailyWithdrawalLimit || 0)} daily</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textAlign: 'right', maxWidth: 110 }}>{lvl.minTotalDeposit ? `₹${fmt(lvl.minTotalDeposit)}+ wagered` : 'Entry level'}</span>
            </div>
          );
        })}
      </div>
    </ScreenShell>
  );
}
