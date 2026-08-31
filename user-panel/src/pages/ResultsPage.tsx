// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ResultsPage.tsx — 2026 "Bazaar" redesign. Latest winner, roadmap, and the
 * per-cycle result feed, driven by GameContext.pastCycles (real cycle history).
 */
import React, { useMemo, useState } from 'react';
import { useGame } from '../services/GameContext';
import { CycleType } from '../types';
import { fmt, ago } from '../redesign/format';
import { Side } from '../redesign/analytics';
import ScreenShell, { card, capLabel } from '../redesign/Screen';
import AnalyticsDrawer from '../redesign/AnalyticsDrawer';

const sideBg = (sd: string) => (sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)');

const ResultsPage: React.FC = () => {
  const { pastCycles, loadCycleHistory } = useGame();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const cycles = useMemo(() => (pastCycles || [])
    .filter(c => c.winner === 'DELHI' || c.winner === 'BOMBAY')
    .sort((a, b) => (b.endTime || 0) - (a.endTime || 0)), [pastCycles]);

  // Built from the enum, not a hand-written pair. The literal
  // `{ '30_MIN': …, FULL_DAY: … }` this replaces silently omitted 1_MIN, so
  // the drawer's 1-Min tab opened from THIS page showed an empty board however
  // much 1-minute history had arrived — the same omission the GameScreen copy
  // was already built from the enum to avoid.
  const winnersByType = useMemo(() => {
    const build = (t: CycleType): Side[] => cycles.filter(c => c.type === t).map(c => c.winner as Side);
    return Object.fromEntries(
      Object.values(CycleType).map(t => [t, build(t)]),
    ) as Record<CycleType, Side[]>;
  }, [cycles]);

  const roadmapBeads = cycles.slice(0, 60).map(c => c.winner as Side).reverse().map(sd => ({ ch: sd === 'DELHI' ? 'D' : 'B', bg: sideBg(sd) }));
  const latest = cycles[0]?.winner as string | undefined;

  return (
    <ScreenShell icon="📊" title="Results" sub="Latest outcomes & the roadmap">
      {/* Latest winner hero */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow)', marginBottom: 14 }}>
        <span className="font-grotesk" style={{ width: 66, height: 66, flex: 'none', borderRadius: '50%', background: latest ? sideBg(latest) : 'var(--surface3)', color: '#fff', fontWeight: 700, fontSize: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: latest ? `0 0 24px -4px ${sideBg(latest)}` : 'none' }}>{latest ? (latest === 'DELHI' ? 'D' : 'B') : '—'}</span>
        <div style={{ flex: 1 }}><div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text3)' }}>Latest winner</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 26, color: 'var(--text)' }}>{latest ? `${latest.charAt(0)}${latest.slice(1).toLowerCase()} Bazaar` : 'Awaiting result'}</div></div>
        <button onClick={() => setDrawerOpen(true)} style={{ flex: 'none', padding: '11px 15px', borderRadius: 12, border: '1px solid var(--line2)', background: 'color-mix(in srgb,var(--gold) 12%,transparent)', color: 'var(--gold-ink)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>📈 Analytics</button>
      </div>

      {/* Roadmap */}
      <div style={{ ...card, marginBottom: 14 }}>
        <span style={capLabel}>Roadmap · newest right</span>
        <div className="bb-noscroll" style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(6,20px)', gap: 4, overflowX: 'auto', padding: '12px 0 4px' }}>
          {roadmapBeads.length === 0 ? <span style={{ fontSize: 12, color: 'var(--text3)' }}>No results yet</span> : roadmapBeads.map((b, i) => <span key={i} style={{ width: 20, height: 20, borderRadius: '50%', background: b.bg, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{b.ch}</span>)}
        </div>
      </div>

      {/* Cycle results */}
      <div style={{ ...card, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={capLabel}>Cycle results</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)' }}>Winner = smaller pool</span>
        </div>
        {cycles.length === 0 && <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--text3)', fontSize: 12 }}>Results will appear here as cycles settle.</div>}
        {cycles.slice(0, 24).map(c => {
          const sd = c.winner as string;
          const dPool = c.totalDelhi || 0, bPool = c.totalBombay || 0, tot = dPool + bPool;
          const dW = tot ? Math.round((dPool / tot) * 100) : 50;
          const paidOut = Math.min(dPool, bPool) * 2;
          return (
            <div key={c.id} style={{ borderTop: '1px solid var(--line)', padding: '13px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 10 }}>
                <span className="font-grotesk" style={{ width: 32, height: 32, flex: 'none', borderRadius: '50%', background: sideBg(sd), color: '#fff', fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{sd === 'DELHI' ? 'D' : 'B'}</span>
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{sd.charAt(0)}{sd.slice(1).toLowerCase()} won · {c.type === CycleType.THIRTY_MIN ? '30M' : 'Full day'}</span><span style={{ display: 'block', fontSize: 10, color: 'var(--text3)' }}>{ago(c.endTime)} · pool ₹{fmt(tot)}</span></span>
                <span style={{ flex: 'none', textAlign: 'right' }}><span className="font-grotesk" style={{ display: 'block', fontWeight: 700, fontSize: 13, color: 'var(--green)' }}>₹{fmt(paidOut)}</span><span style={{ display: 'block', fontSize: 8, fontWeight: 800, letterSpacing: '.08em', color: 'var(--text3)' }}>PAID OUT</span></span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: 'color-mix(in srgb,var(--delhi) 9%,var(--surface3))', border: '1px solid color-mix(in srgb,var(--delhi) 26%,transparent)', borderRadius: 11, padding: '9px 11px' }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: 'var(--delhi)' }}>DELHI</div>
                  <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>₹{fmt(dPool)}</div>
                </div>
                <div style={{ background: 'color-mix(in srgb,var(--bombay) 9%,var(--surface3))', border: '1px solid color-mix(in srgb,var(--bombay) 26%,transparent)', borderRadius: 11, padding: '9px 11px' }}>
                  <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.06em', color: 'var(--bombay)' }}>BOMBAY</div>
                  <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>₹{fmt(bPool)}</div>
                </div>
              </div>
              <div style={{ height: 6, borderRadius: 4, overflow: 'hidden', display: 'flex', marginTop: 8 }}><span style={{ height: '100%', background: 'var(--delhi)', width: dW + '%' }} /><span style={{ height: '100%', flex: 1, background: 'var(--bombay)' }} /></div>
            </div>
          );
        })}
      </div>

      <AnalyticsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} winnersByType={winnersByType} loadCycleHistory={loadCycleHistory} />
    </ScreenShell>
  );
};

export default ResultsPage;
