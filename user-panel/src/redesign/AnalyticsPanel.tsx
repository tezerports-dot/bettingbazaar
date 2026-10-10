// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * AnalyticsPanel.tsx — the results & streak analytics, inline under the result
 * strip: a scrollable bar of named buttons over horizontally swipeable slides
 * (owner, 2026-10-10: "instead of clicking the tab to show up"). It replaces
 * the pull-up drawer that hid all of this behind one button.
 *
 * Slides: Previous results · Continuous streaks · Streak gaps · Win share ·
 * Probability. A button scrolls to its slide; a swipe moves the button.
 *
 * All figures are DESCRIPTIVE statistics of past results (analytics.ts).
 * Presentation only — never used for server-side validation (§11).
 *
 * A board with too little history says so rather than showing a filled-in
 * chart: `analytics.ts` does not pad a thin window, so `A.sample` is the real
 * count and `A.sufficient` gates the parts that generalise from it. The
 * Probability slide is withheld below the threshold — a "DELHI next 67%" off
 * four results is noise wearing the costume of a signal.
 *
 * The deep window (1,440 results for a repeating board) is requested only once
 * the panel is actually on screen, per board: connect carries 50 rows because
 * every visitor pays for it, and most never scroll this far.
 */
import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { analyticsFor, seqFromRuns, MIN_SAMPLE, Side } from './analytics';
import { fmt } from './format';
import { Board, CycleType } from '../types';

interface Props {
  /** The board whose history is shown. */
  board?: Board;
  /** That board's real winners, newest first. */
  winners: Side[];
  /** Requests one board's full analytics window. See GameContext. */
  loadCycleHistory: (type: CycleType) => void;
}

const SLIDES = [
  { key: 'results', label: 'Previous results' },
  { key: 'streaks', label: 'Continuous streaks' },
  { key: 'gaps', label: 'Streak gaps' },
  { key: 'share', label: 'Win share' },
  { key: 'predict', label: 'Probability' },
] as const;

const bead = (sd: Side) => ({ ch: sd === 'DELHI' ? 'D' : 'B', bg: sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)' });

const box: React.CSSProperties = { background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 14, padding: 14 };
const heading: React.CSSProperties = { fontSize: 11, fontWeight: 800, color: 'var(--text)' };

const AnalyticsPanel = forwardRef<HTMLElement, Props>(({ board, winners, loadCycleHistory }, ref) => {
  const rootRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  const boardKey = board?.key ?? '';

  // Ask for the deep window once the panel is in view, once per board.
  const loaded = useRef(new Set<string>());
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !boardKey || loaded.current.has(boardKey)) return undefined;
    const load = () => { loaded.current.add(boardKey); loadCycleHistory(boardKey); };
    if (typeof IntersectionObserver === 'undefined') { load(); return undefined; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [boardKey, loadCycleHistory]);

  const A = useMemo(() => analyticsFor(winners, board), [winners, board]);

  const goTo = (i: number) => {
    const t = trackRef.current;
    setActive(i);
    if (t) t.scrollTo({ left: i * t.clientWidth, behavior: 'smooth' });
  };
  const onTrackScroll = () => {
    const t = trackRef.current;
    if (!t || !t.clientWidth) return;
    const i = Math.round(t.scrollLeft / t.clientWidth);
    if (i !== active) setActive(i);
  };
  // Keep the active button visible in its own bar without scrolling the page.
  useEffect(() => {
    const bar = tabsRef.current;
    const btn = bar?.children[active] as HTMLElement | undefined;
    if (!bar || !btn) return;
    const left = btn.offsetLeft - bar.offsetLeft;
    if (left < bar.scrollLeft || left + btn.offsetWidth > bar.scrollLeft + bar.clientWidth) {
      bar.scrollTo({ left: Math.max(0, left - 12), behavior: 'smooth' });
    }
  }, [active]);

  // Share of wins. With no results at all, say nothing rather than 0% / 100%.
  const aDPct = A.total ? Math.round((A.delhiWins / A.total) * 100) : 0;
  const aBPct = A.total ? 100 - aDPct : 0;
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

  // Descriptive next-winner signal (blend of base rate and streak-break tendency).
  const baseD = A.delhiWins / Math.max(1, A.total);
  const pSame = A.cont(cur.len);
  let probDelhi = cur.side === 'DELHI' ? Math.round((0.5 * baseD + 0.5 * pSame) * 100) : Math.round((0.5 * baseD + 0.5 * (1 - pSame)) * 100);
  probDelhi = Math.max(8, Math.min(92, probDelhi));
  const probBombay = 100 - probDelhi;
  const favorSide = probDelhi >= probBombay ? 'DELHI' : 'BOMBAY';
  const favorColor = favorSide === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)';

  const aBeads = seqFromRuns(A.runs, 60).slice(0, 60).reverse().map(bead);
  const recent = A.seq.slice(0, 12);

  const empty = A.sample === 0;
  const thin = !A.sufficient;
  const sampleNote = empty
    ? 'No results on this board yet — this fills in as cycles settle.'
    : `Based on ${A.sample} result${A.sample === 1 ? '' : 's'} so far. Streak statistics need at least ${MIN_SAMPLE} to mean anything; they firm up as this board builds history.`;
  const shortfall = (
    <div style={{ ...box, border: '1px dashed var(--line2)', padding: 18, textAlign: 'center' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2)', marginBottom: 6 }}>Not enough history yet</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>{sampleNote}</div>
    </div>
  );

  const slide = (key: string): React.ReactNode => {
    switch (key) {
      case 'results':
        return (
          <>
            <div style={box}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={heading}>Big road · newest right</span>
                {!empty && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gold-ink)' }}>Current: {cur.side} ×{cur.len}</span>}
              </div>
              {empty ? (
                <div style={{ fontSize: 11, color: 'var(--text3)', padding: '14px 0', textAlign: 'center' }}>No results on this board yet.</div>
              ) : (
                <div className="bb-noscroll" style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(6,20px)', gap: 4, overflowX: 'auto', paddingBottom: 6 }}>
                  {aBeads.map((b, i) => (
                    <span key={i} style={{ width: 20, height: 20, borderRadius: '50%', background: b.bg, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{b.ch}</span>
                  ))}
                </div>
              )}
            </div>
            {!empty && (
              <div style={{ ...box, marginTop: 10 }}>
                <span style={heading}>Last {recent.length} results · newest first</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {recent.map((sd, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px 4px 4px', borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 10, fontWeight: 800, color: 'var(--text2)' }}>
                      <span style={{ width: 16, height: 16, borderRadius: '50%', background: bead(sd).bg, color: '#fff', fontSize: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{bead(sd).ch}</span>
                      {sd === 'DELHI' ? 'Delhi' : 'Bombay'}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      case 'streaks':
        return thin ? shortfall : (
          <>
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
                <span style={heading}>How often each streak length occurs</span>
                <span style={{ display: 'flex', gap: 10, fontSize: 9, fontWeight: 800 }}><span style={{ color: 'var(--delhi)' }}>● Delhi</span><span style={{ color: 'var(--bombay)' }}>● Bombay</span></span>
              </div>
              {distRows.map(r => (
                <div key={r.len} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ flex: 'none', width: 32, fontSize: 10, fontWeight: 800, color: 'var(--text2)' }}>×{r.len}</span>
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
        return thin ? shortfall : (
          <div style={box}>
            <span style={heading}>Cycles between streaks of each length</span>
            <p style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.5, margin: '6px 0 10px' }}>Average gap, and the last 5 gaps between one such streak and the next.</p>
            {gapRows.length === 0 && <div style={{ fontSize: 11, color: 'var(--text3)', padding: '8px 0' }}>Not enough repeated streaks in this window yet.</div>}
            {gapRows.map((g, i) => (
              <div key={i} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                  <span style={heading}>{g.side} streak ×{g.len}</span>
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
        return thin ? shortfall : (
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
    <section
      ref={(el) => { rootRef.current = el; if (typeof ref === 'function') ref(el); else if (ref) ref.current = el; }}
      aria-label="Results and streak analytics"
      style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, padding: '12px 0 14px', boxShadow: 'var(--shadow-sm)', scrollMarginTop: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '0 14px 10px' }}>
        <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>Results &amp; Streak Analytics</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{fmt(A.total)} {board?.name ?? ''} cycles</span>
      </div>
      <div ref={tabsRef} role="tablist" aria-label="Analytics" className="bb-noscroll" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 14px 12px' }}>
        {SLIDES.map((s, i) => {
          const on = active === i;
          return (
            <button key={s.key} role="tab" aria-selected={on} aria-controls={`bb-an-${s.key}`} onClick={() => goTo(i)} style={{ flex: 'none', padding: '8px 14px', borderRadius: 999, border: `1px solid ${on ? 'var(--gold)' : 'var(--line2)'}`, background: on ? 'linear-gradient(180deg,var(--gold2),var(--gold))' : 'var(--surface2)', color: on ? '#1a1200' : 'var(--text2)', fontSize: 11, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: on ? '0 0 14px -4px var(--glow)' : 'none' }}>{s.label}</button>
          );
        })}
      </div>
      <div ref={trackRef} onScroll={onTrackScroll} className="bb-noscroll" style={{ display: 'flex', alignItems: 'flex-start', overflowX: 'auto', scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain' }}>
        {SLIDES.map((s, i) => (
          <div key={s.key} id={`bb-an-${s.key}`} role="tabpanel" aria-label={s.label} aria-hidden={active !== i} style={{ flex: '0 0 100%', minWidth: 0, boxSizing: 'border-box', padding: '0 14px', scrollSnapAlign: 'start' }}>
            {slide(s.key)}
          </div>
        ))}
      </div>
    </section>
  );
});

AnalyticsPanel.displayName = 'AnalyticsPanel';

export default AnalyticsPanel;
