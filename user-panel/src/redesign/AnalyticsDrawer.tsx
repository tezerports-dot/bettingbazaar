// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * AnalyticsDrawer.tsx — pull-up "Results & Streak Analytics" drawer for the
 * redesigned game screen. Roadmap · Streak counts · Streak gaps · Probability.
 *
 * All figures are DESCRIPTIVE statistics of past results (see analytics.ts and
 * the disclaimer in the Probability tab). Presentation only — never used for
 * server-side validation (GOVERNANCE §10).
 */
import React, { useMemo, useState } from 'react';
import { analyticsFor, seqFromRuns, Side } from './analytics';
import { fmt } from './format';

interface Props {
  open: boolean;
  onClose: () => void;
  winnersByType: { '30_MIN': Side[]; FULL_DAY: Side[] };
}

const bead = (sd: Side) => ({ ch: sd === 'DELHI' ? 'D' : 'B', bg: sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)' });

const AnalyticsDrawer: React.FC<Props> = ({ open, onClose, winnersByType }) => {
  const [aCycle, setACycle] = useState<'30_MIN' | 'FULL_DAY'>('30_MIN');
  const [aTab, setATab] = useState<'roadmap' | 'streaks' | 'gaps' | 'predict'>('roadmap');

  const A = useMemo(() => analyticsFor(winnersByType[aCycle] || [], aCycle), [winnersByType, aCycle]);

  const aDPct = Math.round((A.delhiWins / Math.max(1, A.total)) * 100);
  const aBPct = 100 - aDPct;
  const cur = A.current;
  const contP = Math.round(A.cont(cur.len) * 100);
  const breakP = 100 - contP;

  const keys = ['2', '3', '4', '5', '6', '7+'];
  let maxCount = 1;
  keys.forEach(k => { maxCount = Math.max(maxCount, A.dist[k].D, A.dist[k].B); });
  const distRows = keys.map(k => ({ len: k, dCount: A.dist[k].D, bCount: A.dist[k].B, dW: Math.round((A.dist[k].D / maxCount) * 100) + '%', bW: Math.round((A.dist[k].B / maxCount) * 100) + '%' }));

  const gapRows: Array<{ side: string; len: string; avg: number | null; ago: string | number; last5: number[] }> = [];
  ['2', '3', '4', '5'].forEach(k => {
    (['D', 'B'] as const).forEach(sd => {
      const g = A.gaps[sd + k];
      if (g && g.count >= 2) gapRows.push({ side: sd === 'D' ? 'Delhi' : 'Bombay', len: k, avg: g.avg, ago: g.ago === 0 ? 'now' : (g.ago ?? '—'), last5: g.last5 });
    });
  });
  gapRows.sort((a, b) => Number(a.len) - Number(b.len));

  // next-winner descriptive signal (blend base rate + streak-break tendency)
  const baseD = A.delhiWins / Math.max(1, A.total);
  const pSame = A.cont(cur.len);
  let probDelhi = cur.side === 'DELHI' ? Math.round((0.5 * baseD + 0.5 * pSame) * 100) : Math.round((0.5 * baseD + 0.5 * (1 - pSame)) * 100);
  probDelhi = Math.max(8, Math.min(92, probDelhi));
  const probBombay = 100 - probDelhi;
  const favorSide = probDelhi >= probBombay ? 'DELHI' : 'BOMBAY';
  const favorColor = favorSide === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)';

  const aBeads = seqFromRuns(A.runs, 60).slice(0, 60).reverse().map(bead);

  if (!open) return null;

  const tab = (key: typeof aTab, label: string) => {
    const on = aTab === key;
    return (
      <button onClick={() => setATab(key)} style={{ flex: 'none', padding: '8px 14px', borderRadius: 10, border: `1px solid ${on ? 'var(--gold)' : 'var(--line)'}`, background: on ? 'var(--gold)' : 'transparent', color: on ? '#1a1200' : 'var(--text2)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>{label}</button>
    );
  };

  const cyBtn = (t: '30_MIN' | 'FULL_DAY', label: string) => {
    const on = aCycle === t;
    return <button onClick={() => setACycle(t)} style={{ padding: '5px 11px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 9, fontWeight: 800, background: on ? 'var(--gold)' : 'transparent', color: on ? '#1a1200' : 'var(--text2)' }}>{label}</button>;
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(2px)' }} />
      <div className="bb-rise" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 91, maxHeight: '90%', display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderTop: '1px solid var(--line2)', borderRadius: '22px 22px 0 0', boxShadow: '0 -20px 50px -12px rgba(0,0,0,.6)' }}>
        <div style={{ flex: 'none', padding: '10px 18px 12px' }}>
          <div onClick={onClose} style={{ width: 44, height: 5, borderRadius: 3, background: 'var(--line2)', margin: '0 auto 12px', cursor: 'pointer' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>Results &amp; Streak Analytics</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>Last window · {fmt(A.total)} {aCycle === '30_MIN' ? '30-min' : 'full-day'} cycles</span>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div style={{ display: 'flex', background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 999, padding: 3, gap: 2 }}>
                {cyBtn('FULL_DAY', 'FULL DAY')}
                {cyBtn('30_MIN', '30 MIN')}
              </div>
              <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}>✕</button>
            </div>
          </div>
          <div className="bb-noscroll" style={{ display: 'flex', gap: 6, marginTop: 14, overflowX: 'auto' }}>
            {tab('roadmap', 'Roadmap')}
            {tab('streaks', 'Streak counts')}
            {tab('gaps', 'Streak gaps')}
            {tab('predict', 'Probability')}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 18px 26px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 16 }}>
            <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 12, padding: '11px 12px' }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)' }}>Cycles</div>
              <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--text)' }}>{fmt(A.total)}</div>
            </div>
            <div style={{ background: 'color-mix(in srgb,var(--delhi) 10%,var(--surface3))', border: '1px solid color-mix(in srgb,var(--delhi) 26%,transparent)', borderRadius: 12, padding: '11px 12px' }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--delhi)' }}>Delhi</div>
              <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--text)' }}>{aDPct}%</div>
              <div style={{ fontSize: 9, color: 'var(--text3)' }}>{fmt(A.delhiWins)} wins</div>
            </div>
            <div style={{ background: 'color-mix(in srgb,var(--bombay) 10%,var(--surface3))', border: '1px solid color-mix(in srgb,var(--bombay) 26%,transparent)', borderRadius: 12, padding: '11px 12px' }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--bombay)' }}>Bombay</div>
              <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--text)' }}>{aBPct}%</div>
              <div style={{ fontSize: 9, color: 'var(--text3)' }}>{fmt(A.bombayWins)} wins</div>
            </div>
          </div>

          {aTab === 'roadmap' && (
            <>
              <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 14, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)' }}>Big road · newest right</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gold-ink)' }}>Current: {cur.side} ×{cur.len}</span>
                </div>
                <div className="bb-noscroll" style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(6,20px)', gap: 4, overflowX: 'auto', paddingBottom: 6 }}>
                  {aBeads.map((b, i) => (
                    <span key={i} style={{ width: 20, height: 20, borderRadius: '50%', background: b.bg, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{b.ch}</span>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 12, background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 14, padding: 14 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)' }}>Win distribution</span>
                <div style={{ height: 14, borderRadius: 8, overflow: 'hidden', display: 'flex', marginTop: 10, boxShadow: 'inset 0 1px 3px rgba(0,0,0,.3)' }}>
                  <div style={{ height: '100%', background: 'linear-gradient(90deg,var(--delhi),color-mix(in srgb,var(--delhi) 55%,#000))', width: aDPct + '%', display: 'flex', alignItems: 'center', paddingLeft: 8 }}><span style={{ fontSize: 9, fontWeight: 800, color: '#fff' }}>{aDPct}%</span></div>
                  <div style={{ height: '100%', flex: 1, background: 'linear-gradient(90deg,color-mix(in srgb,var(--bombay) 55%,#000),var(--bombay))', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8 }}><span style={{ fontSize: 9, fontWeight: 800, color: '#fff' }}>{aBPct}%</span></div>
                </div>
              </div>
            </>
          )}

          {aTab === 'streaks' && (
            <>
              <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 14, padding: '14px 14px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)' }}>How often each streak length occurs</span>
                  <span style={{ display: 'flex', gap: 12, fontSize: 9, fontWeight: 800 }}><span style={{ color: 'var(--delhi)' }}>● Delhi</span><span style={{ color: 'var(--bombay)' }}>● Bombay</span></span>
                </div>
                {distRows.map(r => (
                  <div key={r.len} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <span style={{ flex: 'none', width: 40, fontSize: 10, fontWeight: 800, color: 'var(--text2)' }}>×{r.len}</span>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ height: 11, borderRadius: 4, background: 'linear-gradient(90deg,var(--delhi),color-mix(in srgb,var(--delhi) 60%,#000))', width: r.dW, minWidth: 2 }} /><span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text3)' }}>{r.dCount}</span></div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ height: 11, borderRadius: 4, background: 'linear-gradient(90deg,var(--bombay),color-mix(in srgb,var(--bombay) 60%,#000))', width: r.bW, minWidth: 2 }} /><span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text3)' }}>{r.bCount}</span></div>
                    </div>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.5, margin: '12px 2px 0' }}>A "×3 streak" means the same side won 3 cycles in a row. Longer streaks are rarer — this is the historical count over the window.</p>
            </>
          )}

          {aTab === 'gaps' && (
            <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 14, padding: 14 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)' }}>Cycles between streaks of each length</span>
              <p style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.5, margin: '6px 0 12px' }}>Average gap, and the last 5 gaps (how many cycles passed between one such streak and the next).</p>
              {gapRows.length === 0 && <div style={{ fontSize: 11, color: 'var(--text3)', padding: '8px 0' }}>Not enough repeated streaks in this window yet.</div>}
              {gapRows.map((g, i) => (
                <div key={i} style={{ borderTop: '1px solid var(--line)', padding: '11px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)' }}>{g.side} streak ×{g.len}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>avg <b style={{ color: 'var(--gold-ink)' }}>{g.avg ?? '—'}</b> cyc · last {g.ago} ago</span>
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {g.last5.map((v, j) => <span key={j} style={{ fontSize: 10, fontWeight: 800, color: 'var(--text2)', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 7, padding: '3px 9px' }}>{v}</span>)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {aTab === 'predict' && (
            <>
              <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)' }}>Historical next-winner signal</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14 }}>
                  <div style={{ position: 'relative', width: 96, height: 96, flex: 'none', borderRadius: '50%', background: `conic-gradient(var(--delhi) 0 ${(probDelhi / 100) * 360}deg, var(--bombay) ${(probDelhi / 100) * 360}deg 360deg)` }}>
                    <div style={{ position: 'absolute', inset: 12, borderRadius: '50%', background: 'var(--surface3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: 8, fontWeight: 800, color: 'var(--text3)', letterSpacing: '.1em' }}>FAVORS</span>
                      <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: favorColor }}>{favorSide}</span>
                    </div>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontSize: 11, fontWeight: 800, color: 'var(--delhi)' }}>DELHI next</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--text)' }}>{probDelhi}%</span></div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontSize: 11, fontWeight: 800, color: 'var(--bombay)' }}>BOMBAY next</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--text)' }}>{probBombay}%</span></div>
                  </div>
                </div>
              </div>
              <div style={{ background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 14, padding: 14, marginTop: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text)' }}>Streak continuation</span>
                <p style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, margin: '8px 0 0' }}>Current run: <b style={{ color: favorColor }}>{cur.side} ×{cur.len}</b>. Historically a run this long extended one more in <b style={{ color: 'var(--green)' }}>{contP}%</b> of cases and broke in <b style={{ color: 'var(--red)' }}>{breakP}%</b>.</p>
                <div style={{ height: 11, borderRadius: 6, overflow: 'hidden', display: 'flex', marginTop: 10 }}>
                  <div style={{ height: '100%', background: 'var(--green)', width: contP + '%' }} />
                  <div style={{ height: '100%', flex: 1, background: 'var(--red)' }} />
                </div>
              </div>
              <p style={{ fontSize: 9, color: 'var(--text3)', lineHeight: 1.6, margin: '14px 2px 0', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.06em' }}>⚠ Descriptive statistics from past results only. Every cycle is independent — past outcomes do not affect future ones.</p>
            </>
          )}
        </div>
      </div>
    </>
  );
};

export default AnalyticsDrawer;
