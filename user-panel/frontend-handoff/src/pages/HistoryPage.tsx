// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * HistoryPage.tsx — 2026 "Bazaar" redesign. Global cycle history (winners &
 * pools) with a cycle-type toggle. Fetches 100 of the selected type from the
 * cycle-history API (Markets Platform), falling back to the context cache.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useGame } from '../services/GameContext';
import { CycleType, GameCycle } from '../types';
import { getBackend } from '../services/backend.service';
import { fmt, ago } from '../redesign/format';
import ScreenShell, { card } from '../redesign/Screen';

const backend = getBackend();
const sideBg = (sd?: string) => (sd === 'DELHI' ? 'var(--delhi)' : sd === 'BOMBAY' ? 'var(--bombay)' : 'var(--surface3)');

const HistoryPage: React.FC = () => {
  const { pastCycles } = useGame();
  const [viewCycle, setViewCycle] = useState<CycleType>(CycleType.THIRTY_MIN);
  const [fetched, setFetched] = useState<GameCycle[] | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(async (type: CycleType) => {
    setLoading(true); setFetched(null);
    try {
      const typeParam = type === CycleType.THIRTY_MIN ? '30_MIN' : 'FULL_DAY';
      const res: any = await (backend as any).request(`/v1/game/cycles/history?type=${typeParam}&limit=100`);
      setFetched(((res?.cycles || []) as GameCycle[]).filter((c: any) => c && c.endTime));
    } catch {
      setFetched((pastCycles || []).filter(c => c.type === type));
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchHistory(viewCycle); }, [viewCycle, fetchHistory]);

  const rows = (fetched || (pastCycles || []).filter(c => c.type === viewCycle))
    .filter(c => c.winner === 'DELHI' || c.winner === 'BOMBAY')
    .sort((a, b) => (b.endTime || 0) - (a.endTime || 0));

  return (
    <ScreenShell icon="🕒" title="Game History" sub="Every cycle you have played">
      <div style={{ display: 'flex', background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 999, padding: 3, gap: 3, width: 'fit-content', marginBottom: 14, boxShadow: 'var(--shadow-sm)' }}>
        {[{ t: CycleType.THIRTY_MIN, l: '30 MIN' }, { t: CycleType.FULL_DAY, l: 'FULL DAY' }].map(o => {
          const on = viewCycle === o.t;
          return <button key={o.l} onClick={() => setViewCycle(o.t)} style={{ padding: '7px 18px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 800, letterSpacing: '.06em', background: on ? 'linear-gradient(180deg,var(--gold2),var(--gold))' : 'transparent', color: on ? '#1a1200' : 'var(--text3)' }}>{o.l}</button>;
        })}
      </div>

      <div style={{ ...card, overflow: 'hidden', padding: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, padding: '11px 15px', background: 'var(--surface3)', fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)' }}>
          <span>Cycle · Result</span><span style={{ textAlign: 'right' }}>Delhi pool</span><span style={{ textAlign: 'right' }}>Bombay pool</span>
        </div>
        {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Loading…</div>}
        {!loading && rows.length === 0 && <div style={{ padding: 28, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>No cycles yet.</div>}
        {!loading && rows.slice(0, 100).map(c => {
          const sd = c.winner as string;
          return (
            <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center', padding: '12px 15px', borderTop: '1px solid var(--line)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span className="font-grotesk" style={{ width: 28, height: 28, flex: 'none', borderRadius: '50%', background: sideBg(sd), color: '#fff', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{sd === 'DELHI' ? 'D' : 'B'}</span>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}><span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{sd.charAt(0)}{sd.slice(1).toLowerCase()} won</span><span style={{ fontSize: 10, color: 'var(--text3)' }}>{ago(c.endTime)}</span></span>
              </span>
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 12, color: sd === 'DELHI' ? 'var(--delhi)' : 'var(--text2)', textAlign: 'right' }}>₹{fmt(c.totalDelhi || 0)}</span>
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 12, color: sd === 'BOMBAY' ? 'var(--bombay)' : 'var(--text2)', textAlign: 'right' }}>₹{fmt(c.totalBombay || 0)}</span>
            </div>
          );
        })}
      </div>
    </ScreenShell>
  );
};

export default HistoryPage;
