// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ResultsPage.tsx — 2026 "Bazaar" redesign. Latest winner, roadmap, and the
 * per-cycle result feed, driven by GameContext.pastCycles (real cycle history).
 */
import { LatestTag, LATEST_RING, NEWEST_LEFT } from '../redesign/LatestTag';
import React, { useMemo, useState } from 'react';
import { useGame } from '../services/GameContext';
import { ago } from '../redesign/format';
import { Side, winnersByBoard } from '../redesign/analytics';
import ScreenShell, { card, capLabel } from '../redesign/Screen';
import AnalyticsView from '../redesign/AnalyticsView';

const NO_WINNERS: Side[] = [];
const sideBg = (sd: string) => (sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)');

const ResultsPage: React.FC = () => {
  const { pastCycles, loadCycleHistory, boards } = useGame();
  const [picked, setPicked] = useState('');
  // The board picked here, or the first in the admin's order.
  const aBoard = boards.find(b => b.key === picked) ?? boards[0];
  const winnersByType = useMemo(() => winnersByBoard(pastCycles, boards), [pastCycles, boards]);

  const cycles = useMemo(() => (pastCycles || [])
    .filter(c => c.winner === 'DELHI' || c.winner === 'BOMBAY')
    .sort((a, b) => (b.endTime || 0) - (a.endTime || 0)), [pastCycles]);

  const boardName = (key: string) => boards.find(b => b.key === key)?.name ?? '';

  // Newest first: top-left, down each column, then right (`LatestTag.tsx`).
  const roadmapBeads = cycles.slice(0, 60).map(c => c.winner as Side).map(sd => ({ ch: sd === 'DELHI' ? 'D' : 'B', bg: sideBg(sd) }));
  const latest = cycles[0]?.winner as string | undefined;

  return (
    <ScreenShell icon="📊" title="Results" sub="Latest outcomes & the roadmap">
      {/* Latest winner hero */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 18, padding: 18, boxShadow: 'var(--shadow)', marginBottom: 14 }}>
        <span className="font-grotesk" style={{ width: 66, height: 66, flex: 'none', borderRadius: '50%', background: latest ? sideBg(latest) : 'var(--surface3)', color: '#fff', fontWeight: 700, fontSize: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: latest ? `0 0 24px -4px ${sideBg(latest)}` : 'none' }}>{latest ? (latest === 'DELHI' ? 'D' : 'B') : '—'}</span>
        <div style={{ flex: 1 }}><div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text3)' }}>Latest winner</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 26, color: 'var(--text)' }}>{latest ? `${latest.charAt(0)}${latest.slice(1).toLowerCase()} Bazaar` : 'Awaiting result'}</div></div>
      </div>

      {/* Analytics, per board, as part of this page (owner, 2026-10-15) */}
      {boards.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div role="radiogroup" aria-label="Board" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {boards.map(b => {
              const on = aBoard?.key === b.key;
              return <button key={b.key} type="button" role="radio" aria-checked={on} onClick={() => setPicked(b.key)} style={{ flex: 'none', padding: '6px 13px', borderRadius: 999, border: `1px solid ${on ? 'var(--gold)' : 'var(--line2)'}`, cursor: 'pointer', fontSize: 10, fontWeight: 800, background: on ? 'var(--gold)' : 'var(--surface2)', color: on ? 'var(--on-gold)' : 'var(--text2)' }}>{b.name.toUpperCase()}</button>;
            })}
          </div>
          <AnalyticsView board={aBoard} winners={(aBoard && winnersByType[aBoard.key]) || NO_WINNERS} loadCycleHistory={loadCycleHistory} />
        </div>
      )}

      {/* Roadmap */}
      <div style={{ ...card, marginBottom: 14 }}>
        <span style={capLabel}>Roadmap</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}><LatestTag /> {NEWEST_LEFT}</div>
        <div className="bb-noscroll" style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(6,20px)', gap: 4, overflowX: 'auto', padding: '12px 0 4px' }}>
          {roadmapBeads.length === 0 ? <span style={{ fontSize: 12, color: 'var(--text3)' }}>No results yet</span> : roadmapBeads.map((b, i) => <span key={i} aria-label={i === 0 ? 'Latest result' : undefined} style={{ width: 20, height: 20, borderRadius: '50%', background: b.bg, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(i === 0 ? LATEST_RING : null) }}>{b.ch}</span>)}
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
          return (
            <div key={c.id} style={{ borderTop: '1px solid var(--line)', padding: '13px 0' }}>
              {/* Who won, never how much was on each side (owner, 2026-10-14). */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span className="font-grotesk" style={{ width: 32, height: 32, flex: 'none', borderRadius: '50%', background: sideBg(sd), color: '#fff', fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{sd === 'DELHI' ? 'D' : 'B'}</span>
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{sd.charAt(0)}{sd.slice(1).toLowerCase()} won · {boardName(c.type)}</span><span style={{ display: 'block', fontSize: 10, color: 'var(--text3)' }}>{ago(c.endTime)}</span></span>
              </div>
            </div>
          );
        })}
      </div>

    </ScreenShell>
  );
};

export default ResultsPage;
