// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * AnalyticsView.tsx — one board's results and streak analytics, as part of the
 * page it sits on: under the game across the board screen's full width, and
 * on Results (owner, 2026-10-15: "not locked in a card", "part of that page
 * below the game", no separate page or button). The tabs wrap rather than
 * scroll sideways and one section fills the width; nothing slides.
 *
 *   Runs & Gaps · Previous results · Continuous streaks · Streak gaps ·
 *   Win share · Probability
 *
 * All figures are DESCRIPTIVE statistics of past results (analytics.ts).
 * Presentation only — never used for server-side validation (§11).
 *
 * Demo results (owner, 2026-10-15): while a board has fewer than its window
 * of real results, the rest is filled with demo ones before the oldest real
 * one, faded on screen (DemoResults.tsx). Every section reads the whole
 * window, demo results included, the Probability section too (owner,
 * 2026-10-15).
 *
 * Nothing here is held back for a thin board any more: the streak and gap
 * figures are shown from the first result with the real count beside them
 * (`A.sample`), never padded. The one exception is the Probability section,
 * which stays withheld below MIN_SAMPLE — a "DELHI next 67%" off four results
 * is noise wearing the costume of a signal.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { analyticsFor, MIN_SAMPLE, Side } from './analytics';
import { analyticsWindowFor } from '../constants';
import { useDemoResults, withDemoResults, DEMO_STYLE } from './DemoResults';
import { fmt } from './format';
import RunsAndGaps, { box, heading, LATEST_RING, LatestTag } from './RunsAndGaps';
import { Board, CycleType } from '../types';

interface Props {
  /** The board whose history is shown. */
  board?: Board;
  /** That board's real winners, newest first. */
  winners: Side[];
  /** Requests one board's full analytics window. See GameContext. */
  loadCycleHistory?: (type: CycleType) => void;
}

export const SECTIONS = [
  { key: 'runs', label: 'Runs & Gaps' },
  { key: 'results', label: 'Previous results' },
  { key: 'streaks', label: 'Continuous streaks' },
  { key: 'gaps', label: 'Streak gaps' },
  { key: 'share', label: 'Win share' },
  { key: 'predict', label: 'Probability' },
] as const;
export type SectionKey = typeof SECTIONS[number]['key'];

const bead = (sd: Side) => ({ ch: sd === 'DELHI' ? 'D' : 'B', bg: sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)' });

const AnalyticsView: React.FC<Props> = ({ board, winners, loadCycleHistory }) => {
  const [active, setActive] = useState<SectionKey>('runs');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const boardKey = board?.key ?? '';

  // The deep window (1,440 results for a repeating board) is asked for once
  // this is on screen, once per board: the stream's open carries 50 rows
  // because every visitor pays for it, and most never scroll this far.
  const loaded = useRef(new Set<string>());
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !boardKey || !loadCycleHistory || loaded.current.has(boardKey)) return undefined;
    const load = () => { loaded.current.add(boardKey); loadCycleHistory(boardKey); };
    if (typeof IntersectionObserver === 'undefined') { load(); return undefined; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [boardKey, loadCycleHistory]);
  const demoCfg = useDemoResults();
  const filled = useMemo(
    () => withDemoResults(winners, boardKey, analyticsWindowFor(board), !!demoCfg?.on),
    [winners, boardKey, board, demoCfg],
  );
  const A = useMemo(() => analyticsFor(filled.winners, board), [filled, board]);

  // Share of wins. With no results at all, say nothing rather than 0% / 100%.
  const aDPct = A.total ? Math.round((A.delhiWins / A.total) * 100) : 0;
  const aBPct = A.total ? 100 - aDPct : 0;
  const cur = A.current;
  const contP = Math.round(A.cont(cur.len) * 100);
  const breakP = 100 - contP;

  const keys = A.lengths.map(String);
  let maxCount = 1;
  keys.forEach(k => { maxCount = Math.max(maxCount, A.dist[k].D, A.dist[k].B); });
  const distRows = keys.map(k => ({ len: k, dCount: A.dist[k].D, bCount: A.dist[k].B, dW: Math.round((A.dist[k].D / maxCount) * 100) + '%', bW: Math.round((A.dist[k].B / maxCount) * 100) + '%' }));

  const gapRows: Array<{ side: string; len: string; avg: number | null; ago: string | number; last5: number[] }> = [];
  keys.forEach(k => {
    (['D', 'B'] as const).forEach(sd => {
      const g = A.gaps[sd + k];
      if (g && g.count >= 2) gapRows.push({ side: sd === 'D' ? 'Delhi' : 'Bombay', len: k, avg: g.avg, ago: g.ago === 0 ? 'now' : (g.ago ?? '—'), last5: g.last5 });
    });
  });
  gapRows.sort((a, b) => Number(a.len) - Number(b.len));

  // Descriptive next-winner signal (blend of base rate and streak-break tendency).
  const baseD = A.delhiWins / Math.max(1, A.total);
  const pSame = A.cont(A.current.len);
  let probDelhi = A.current.side === 'DELHI' ? Math.round((0.5 * baseD + 0.5 * pSame) * 100) : Math.round((0.5 * baseD + 0.5 * (1 - pSame)) * 100);
  probDelhi = Math.max(8, Math.min(92, probDelhi));
  const probBombay = 100 - probDelhi;
  const favorSide = probDelhi >= probBombay ? 'DELHI' : 'BOMBAY';
  const favorColor = favorSide === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)';

  // Every result in the window, newest first from the top left (owner,
  // 2026-10-17); index i is demo from `filled.real`.
  const aBeads = A.seq.map((sd, i) => ({ ...bead(sd), demo: i >= filled.real }));
  const recent = A.seq.slice(0, 12);

  const empty = A.sample === 0;
  const thin = !A.sufficient;
  const predictThin = !A.sufficient;
  const emptyCard = (
    <div style={{ ...box, border: '1px dashed var(--line2)', padding: 18, textAlign: 'center' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2)', marginBottom: 6 }}>No results on this board yet</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>This fills in as rounds settle.</div>
    </div>
  );
  // Shown, never hidden: a thin window says how thin it is beside its figures.
  const thinNote = thin && !empty ? (
    <p style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6, margin: '0 0 10px' }}>
      Based on {A.sample} result{A.sample === 1 ? '' : 's'} so far. With fewer than {MIN_SAMPLE} these counts move a lot from one round to the next.
    </p>
  ) : null;
  const predictShortfall = (
    <div style={{ ...box, border: '1px dashed var(--line2)', padding: 18, textAlign: 'center' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2)', marginBottom: 6 }}>Shown from {MIN_SAMPLE} results</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>This board has {A.sample} so far. A split worked out from fewer would read as a signal and be noise.</div>
    </div>
  );

  const slide = (key: string): React.ReactNode => {
    switch (key) {
      case 'results':
        return (
          <>
            <div style={box}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={heading}>Big road · all {fmt(A.total)} · newest top left, slide right for older</span>
                {!empty && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gold-ink)' }}>Current: {cur.side} ×{cur.len}</span>}
              </div>
              {empty ? (
                <div style={{ fontSize: 11, color: 'var(--text3)', padding: '14px 0', textAlign: 'center' }}>No results on this board yet.</div>
              ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <LatestTag />
                  <div data-testid="big-road" style={{ flex: 1, minWidth: 0, display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(6,20px)', gridAutoColumns: '20px', gap: 4, overflowX: 'auto', padding: '3px 3px 6px', scrollSnapType: 'x proximity', WebkitOverflowScrolling: 'touch' }}>
                    {aBeads.map((b, i) => (
                      <span key={i} data-demo={b.demo ? '' : undefined} data-latest={i === 0 ? '' : undefined} style={{ width: 20, height: 20, borderRadius: '50%', background: b.bg, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(b.demo ? DEMO_STYLE : null), ...(i === 0 ? LATEST_RING : null) }}>{b.ch}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {!empty && (
              <div style={{ ...box, marginTop: 10 }}>
                <span style={heading}>Last {recent.length} results · newest first, left to right</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' }}>
                  <LatestTag />
                  {recent.map((sd, i) => (
                    <span key={i} data-latest={i === 0 ? '' : undefined} style={{ ...(i === 0 ? LATEST_RING : null), display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px 4px 4px', borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 10, fontWeight: 800, color: 'var(--text2)' }}>
                      <span style={{ width: 16, height: 16, borderRadius: '50%', background: bead(sd).bg, color: '#fff', fontSize: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{bead(sd).ch}</span>
                      {sd === 'DELHI' ? 'Delhi' : 'Bombay'}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      case 'runs':
        return <RunsAndGaps board={board} winners={filled.winners} real={filled.real} />;
      case 'streaks':
        return empty ? emptyCard : (
          <>
            {thinNote}
            <div style={{ ...box, marginBottom: 10 }}>
              <span style={heading}>Current streak</span>
              <p style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, margin: '8px 0 0' }}>
                <b style={{ color: cur.side === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)' }}>{cur.side} ×{cur.len}</b>. Historically a run this long extended one more in <b style={{ color: 'var(--green)' }}>{contP}%</b> of cases and broke in <b style={{ color: 'var(--red)' }}>{breakP}%</b>.
              </p>
              <div style={{ height: 9, borderRadius: 6, overflow: 'hidden', display: 'flex', marginTop: 10 }}>
                <div style={{ height: '100%', background: 'var(--green)', width: contP + '%' }} />
                <div style={{ height: '100%', flex: 1, background: 'var(--red)' }} />
              </div>
            </div>
            <div style={{ ...box, padding: '14px 14px 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={heading}>Streaks that reached each length</span>
                <span style={{ display: 'flex', gap: 10, fontSize: 9, fontWeight: 800 }}><span style={{ color: 'var(--delhi)' }}>● Delhi</span><span style={{ color: 'var(--bombay)' }}>● Bombay</span></span>
              </div>
              {distRows.map(r => (
                <div key={r.len} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ flex: 'none', width: 32, fontSize: 10, fontWeight: 800, color: 'var(--text2)' }}>×{r.len}+</span>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ height: 10, borderRadius: 4, background: 'linear-gradient(90deg,var(--delhi),color-mix(in srgb,var(--delhi) 60%,#000))', width: r.dW, minWidth: 2 }} /><span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text3)' }}>{r.dCount}</span></div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ height: 10, borderRadius: 4, background: 'linear-gradient(90deg,var(--bombay),color-mix(in srgb,var(--bombay) 60%,#000))', width: r.bW, minWidth: 2 }} /><span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text3)' }}>{r.bCount}</span></div>
                  </div>
                </div>
              ))}
            </div>
          </>
        );
      case 'gaps':
        return empty ? emptyCard : (
          <div style={box}>
            {thinNote}
            <span style={heading}>Cycles between streaks reaching each length</span>
            <p style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.5, margin: '6px 0 10px' }}>Average gap, and the last 5 gaps between one streak reaching that length and the next. A ×3 also counts as reaching ×2.</p>
            {gapRows.length === 0 && <div style={{ fontSize: 11, color: 'var(--text3)', padding: '8px 0' }}>Not enough repeated streaks in this window yet.</div>}
            {gapRows.map((g, i) => (
              <div key={i} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                  <span style={heading}>{g.side} streak ×{g.len}+</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>avg <b style={{ color: 'var(--gold-ink)' }}>{g.avg ?? '—'}</b> cyc · last {g.ago} ago</span>
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {g.last5.map((v, j) => <span key={j} style={{ fontSize: 10, fontWeight: 800, color: 'var(--text2)', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 7, padding: '3px 9px' }}>{v}</span>)}
                </div>
              </div>
            ))}
          </div>
        );
      case 'share':
        return (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 10 }}>
              <div style={{ ...box, padding: '11px 12px' }}>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)' }}>Cycles</div>
                <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--text)' }}>{fmt(A.total)}</div>
              </div>
              <div style={{ ...box, padding: '11px 12px', background: 'color-mix(in srgb,var(--delhi) 10%,var(--surface3))', border: '1px solid color-mix(in srgb,var(--delhi) 26%,transparent)' }}>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--delhi)' }}>Delhi</div>
                <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--text)' }}>{empty ? '—' : `${aDPct}%`}</div>
                <div style={{ fontSize: 9, color: 'var(--text3)' }}>{fmt(A.delhiWins)} wins</div>
              </div>
              <div style={{ ...box, padding: '11px 12px', background: 'color-mix(in srgb,var(--bombay) 10%,var(--surface3))', border: '1px solid color-mix(in srgb,var(--bombay) 26%,transparent)' }}>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--bombay)' }}>Bombay</div>
                <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--text)' }}>{empty ? '—' : `${aBPct}%`}</div>
                <div style={{ fontSize: 9, color: 'var(--text3)' }}>{fmt(A.bombayWins)} wins</div>
              </div>
            </div>
            {!empty && (
              <div style={box}>
                <span style={heading}>Win distribution</span>
                <div style={{ height: 14, borderRadius: 8, overflow: 'hidden', display: 'flex', marginTop: 10, boxShadow: 'inset 0 1px 3px rgba(0,0,0,.3)' }}>
                  <div style={{ height: '100%', background: 'linear-gradient(90deg,var(--delhi),color-mix(in srgb,var(--delhi) 55%,#000))', width: aDPct + '%', display: 'flex', alignItems: 'center', paddingLeft: 8 }}><span style={{ fontSize: 9, fontWeight: 800, color: '#fff' }}>{aDPct}%</span></div>
                  <div style={{ height: '100%', flex: 1, background: 'linear-gradient(90deg,color-mix(in srgb,var(--bombay) 55%,#000),var(--bombay))', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8 }}><span style={{ fontSize: 9, fontWeight: 800, color: '#fff' }}>{aBPct}%</span></div>
                </div>
              </div>
            )}
          </>
        );
      default:
        return predictThin ? predictShortfall : (
          <>
            <div style={{ ...box, padding: 16 }}>
              <span style={heading}>Historical next-winner signal</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12 }}>
                <div style={{ position: 'relative', width: 88, height: 88, flex: 'none', borderRadius: '50%', background: `conic-gradient(var(--delhi) 0 ${(probDelhi / 100) * 360}deg, var(--bombay) ${(probDelhi / 100) * 360}deg 360deg)` }}>
                  <div style={{ position: 'absolute', inset: 11, borderRadius: '50%', background: 'var(--surface3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 8, fontWeight: 800, color: 'var(--text3)', letterSpacing: '.1em' }}>FAVORS</span>
                    <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 12, color: favorColor }}>{favorSide}</span>
                  </div>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontSize: 11, fontWeight: 800, color: 'var(--delhi)' }}>DELHI next</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--text)' }}>{probDelhi}%</span></div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontSize: 11, fontWeight: 800, color: 'var(--bombay)' }}>BOMBAY next</span><span className="font-grotesk" style={{ fontWeight: 700, color: 'var(--text)' }}>{probBombay}%</span></div>
                </div>
              </div>
            </div>
            <p style={{ fontSize: 9, color: 'var(--text3)', lineHeight: 1.6, margin: '12px 2px 0', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.06em' }}>⚠ Descriptive statistics from past results only. Every cycle is independent — past outcomes do not affect future ones.</p>
          </>
        );
    }
  };

  return (
    <div ref={rootRef} aria-label={`${board?.name ?? ''} results and streak analytics`} style={{ width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', margin: '4px 0 10px' }}>
        <h2 className="font-grotesk" style={{ margin: 0, fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>Results &amp; Streak Analytics</h2>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)' }}>{fmt(A.total)} {board?.name ?? ''} results</span>
      </div>
      <div style={{ margin: '0 0 12px' }}>
        {/* One swipeable strip, drawn like the game tabs above (owner,
            2026-10-15: "single slidable strip ... as we are doing for games
            button above"): flat names, the open one lit with an underline. */}
        <div role="tablist" aria-label="Analytics" className="bb-noscroll bb-gametabs" style={{ display: 'flex', gap: 2, overflowX: 'auto', borderBottom: '1px solid var(--line)', scrollSnapType: 'x proximity', margin: '0 -4px' }}>
          {SECTIONS.map((s) => {
            const on = active === s.key;
            return (
              <button key={s.key} type="button" role="tab" id={`bb-an-tab-${s.key}`} aria-selected={on} aria-controls={`bb-an-${s.key}`}
                onClick={(e) => { setActive(s.key); e.currentTarget.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); }}
                className={`bb-gametab${on ? ' bb-gametab--on' : ''}`}>
                <span className="font-grotesk bb-gametab__name">{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div id={`bb-an-${active}`} role="tabpanel" aria-labelledby={`bb-an-tab-${active}`}>
        {slide(active)}
      </div>
    </div>
  );
};


// GameContext re-renders its consumers every second for the countdown; this
// view's props do not change with it, so it is not rebuilt once a second.
export default React.memo(AnalyticsView);
