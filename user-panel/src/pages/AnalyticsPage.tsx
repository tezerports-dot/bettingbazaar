// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * AnalyticsPage.tsx — Results & streak analytics as its own page, `/analytics`
 * (owner, 2026-10-15: not a card under the board, the whole screen, open to
 * everyone). No sign-in: it is the public results history every visitor's
 * stream already carries.
 *
 * The board shown is `?board=<key>` (the board screen links here with the one
 * being played), else the board in play, else the first in the admin's order;
 * the picker changes it here without touching the board screen's choice.
 *
 * The full analytics window (`analyticsWindowFor` rows) is asked for once per
 * board on arrival: the stream's open carries 50 rows per board because every
 * visitor pays for it, and only this page needs the rest.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useGame } from '../services/GameContext';
import { winnersByBoard, Side } from '../redesign/analytics';
import AnalyticsView from '../redesign/AnalyticsView';
import ScreenShell from '../redesign/Screen';

const NO_WINNERS: Side[] = [];

const AnalyticsPage: React.FC = () => {
  const { pastCycles, boards, cycleType, loadCycleHistory } = useGame();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const asked = params.get('board') ?? '';
  const board = boards.find((b) => b.key === asked) ?? boards.find((b) => b.key === cycleType) ?? boards[0];
  const winners = useMemo(() => winnersByBoard(pastCycles, boards), [pastCycles, boards]);

  const loaded = useRef(new Set<string>());
  useEffect(() => {
    if (!board || loaded.current.has(board.key)) return;
    loaded.current.add(board.key);
    loadCycleHistory(board.key);
  }, [board, loadCycleHistory]);

  return (
    <ScreenShell icon="📈" title="Analytics" sub="Results, runs and gaps for each board" maxWidth={1280}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" onClick={() => navigate('/')} style={{ padding: '7px 13px', borderRadius: 999, border: '1px solid var(--line2)', background: 'var(--surface2)', color: 'var(--text2)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>← Back to the board</button>
        <div role="radiogroup" aria-label="Board" className="bb-noscroll" style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
          {boards.map((b) => {
            const on = board?.key === b.key;
            return (
              <button key={b.key} type="button" role="radio" aria-checked={on} onClick={() => setParams({ board: b.key }, { replace: true })} style={{ flex: 'none', padding: '7px 14px', borderRadius: 999, border: `1px solid ${on ? 'var(--gold)' : 'var(--line2)'}`, cursor: 'pointer', fontSize: 11, fontWeight: 800, background: on ? 'var(--gold)' : 'var(--surface2)', color: on ? '#1a1200' : 'var(--text2)' }}>{b.name}</button>
            );
          })}
        </div>
      </div>
      {boards.length === 0
        ? <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)', fontSize: 12 }}>Loading the boards…</div>
        : <AnalyticsView board={board} winners={(board && winners[board.key]) || NO_WINNERS} />}
    </ScreenShell>
  );
};

export default AnalyticsPage;
