// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * MyBetsPage.tsx — 2026 "Bazaar" redesign. Personal bet slips split into Active
 * (pending) and Settled (won/lost), driven by GameContext.userBets.
 */
import React, { useMemo, useState } from 'react';
import { useGame } from '../services/GameContext';
import { fmt, ago } from '../redesign/format';
import ScreenShell, { card } from '../redesign/Screen';

const MyBetsPage: React.FC = () => {
  const { userBets } = useGame();
  const [tab, setTab] = useState<'active' | 'settled'>('active');

  const { active, settled } = useMemo(() => {
    const all = (userBets || []).slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return {
      active: all.filter(b => b.status === 'PENDING'),
      settled: all.filter(b => b.status === 'WON' || b.status === 'LOST' || b.status === 'REFUNDED'),
    };
  }, [userBets]);

  const rows = tab === 'active' ? active : settled;

  const statusColor = (s: string) => s === 'WON' ? 'var(--green)' : s === 'LOST' ? 'var(--red)' : s === 'PENDING' ? 'var(--bombay)' : 'var(--text3)';

  const tabBtn = (k: 'active' | 'settled', label: string) => {
    const on = tab === k;
    return <button onClick={() => setTab(k)} style={{ padding: '9px 18px', borderRadius: 11, cursor: 'pointer', border: `1px solid ${on ? 'var(--line2)' : 'transparent'}`, background: on ? 'var(--surface3)' : 'transparent', color: on ? 'var(--text)' : 'var(--text3)', fontSize: 12, fontWeight: 800 }}>{label}</button>;
  };

  return (
    <ScreenShell icon="📜" title="My Bets" sub="Active and settled bet slips">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {tabBtn('active', `Active${active.length ? ` · ${active.length}` : ''}`)}
        {tabBtn('settled', 'Settled')}
      </div>

      {rows.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: '36px 16px', color: 'var(--text3)' }}>
          <div style={{ fontSize: 30, marginBottom: 8, opacity: .6 }}>🎯</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>{tab === 'active' ? 'No active bets' : 'No settled bets yet'}</div>
          <div style={{ fontSize: 11, marginTop: 4 }}>Place a bet on the game screen to see it here.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(b => {
            const side = b.side === 'DELHI' ? 'DELHI' : 'BOMBAY';
            const won = b.status === 'WON';
            return (
              <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 12, ...card, padding: '13px 15px' }}>
                <span className="font-grotesk" style={{ width: 34, height: 34, flex: 'none', borderRadius: '50%', background: 'var(--surface3)', border: '1px solid var(--line2)', color: side === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{side.charAt(0)}</span>
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{side.charAt(0)}{side.slice(1).toLowerCase()} Bazaar</span>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>{ago(b.timestamp)}{won && b.payout ? ` · won ₹${fmt(b.payout)}` : ''}</span>
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginRight: 4 }}>
                  <span style={{ fontSize: 9, color: 'var(--text3)' }}>Stake</span>
                  <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>₹{fmt(b.amount)}</span>
                </span>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', padding: '5px 10px', borderRadius: 999, color: '#fff', background: statusColor(b.status) }}>{b.status === 'PENDING' ? 'LIVE' : b.status}</span>
              </div>
            );
          })}
        </div>
      )}
    </ScreenShell>
  );
};

export default MyBetsPage;
