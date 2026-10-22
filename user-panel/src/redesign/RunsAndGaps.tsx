// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * RunsAndGaps.tsx — the Runs & Gaps tab of the Analytics page (owner,
 * 2026-10-15): Delhi and Bombay side by side over one board's real results.
 *
 *   • Run strip         — the newest results grouped into runs (D D B B B B D)
 *   • Run-length table  — runs of 1, 2, 3, 4, 5, 6+ per side, and the longest
 *   • Gap view          — rounds since each side last won, and its past gaps
 *
 * The progression calculator is its own section under every tab
 * (ProgressionCalculator.tsx; owner, 2026-10-22).
 *
 * Every figure is descriptive (`analytics.ts`). Each round is drawn on its
 * own, so the page says plainly that the past does not predict the next round.
 */
import React, { useMemo, useState } from 'react';
import { Side, RUN_WINDOWS, RUN_BUCKETS, runsOf, runLengthTable, gapSummary } from './analytics';
import { fmt } from './format';
import { DEMO_STYLE } from './DemoResults';

const SIDES: Side[] = ['DELHI', 'BOMBAY'];
const sideName = (sd: Side) => (sd === 'DELHI' ? 'Delhi' : 'Bombay');
const sideColor = (sd: Side) => (sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)');
const bucketLabel = (b: number) => (b === RUN_BUCKETS[RUN_BUCKETS.length - 1] ? `${b}+` : String(b));

/**
 * Every results row reads newest first, left to right: the newest result is
 * the leftmost one, ringed and tagged "Latest", and older ones follow to the
 * right (owner, 2026-10-17).
 */
export const LATEST_RING: React.CSSProperties = { outline: '2px solid var(--gold)', outlineOffset: 2 };
export const LatestTag: React.FC = () => (
  <span data-testid="latest-tag" style={{ flex: 'none', alignSelf: 'center', padding: '2px 7px', borderRadius: 999, background: 'var(--gold)', color: 'var(--on-gold)', fontSize: 9, fontWeight: 800, letterSpacing: '.08em' }}>LATEST</span>
);

export const box: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 };
export const heading: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: 'var(--text)' };
const note: React.CSSProperties = { fontSize: 11, color: 'var(--text3)', lineHeight: 1.6, margin: '6px 0 0' };
const th: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: 'var(--text3)', textAlign: 'right', padding: '6px 8px', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--text)', textAlign: 'right', padding: '7px 8px', borderTop: '1px solid var(--line)' };

/** The one line every part of this tab stands under. */
export const PAST_DOES_NOT_PREDICT = 'Past results do not predict the next round. Each round is decided on its own, so a long run does not make the other side more likely to win next.';

interface Props {
  /** The board's winners, newest first: the real ones, then any demo ones (DemoResults.tsx). */
  winners: Side[];
  /** How many of `winners` are real; the rest are demo. All of them when absent. */
  real?: number;
}

const RunsAndGaps: React.FC<Props> = ({ winners, real }) => {
  const realCount = real ?? winners.length;
  // The windows that exist for this board; one longer than the history is cut to it.
  const windows = useMemo(() => {
    const out: number[] = [];
    for (const w of RUN_WINDOWS) {
      const n = Math.min(w, winners.length);
      if (n > 0 && !out.includes(n)) out.push(n);
    }
    return out;
  }, [winners.length]);
  const [pickedWindow, setPickedWindow] = useState<number>(RUN_WINDOWS[0]);
  const lookBack = windows.includes(pickedWindow) ? pickedWindow : (windows.filter((w) => w <= pickedWindow).pop() ?? windows[0] ?? 0);

  const table = useMemo(() => runLengthTable(winners, lookBack), [winners, lookBack]);
  const gaps = useMemo(() => ({ DELHI: gapSummary(winners, 'DELHI', lookBack), BOMBAY: gapSummary(winners, 'BOMBAY', lookBack) }), [winners, lookBack]);
  // The strip: every result in the window as runs, newest on the left; it
  // slides sideways for older (owner, 2026-10-15: all 1,440; 2026-10-17: newest left).
  const strip = useMemo(() => runsOf(winners), [winners]);

  if (winners.length === 0) {
    return (
      <div style={{ ...box, textAlign: 'center', padding: 24 }}>
        <div style={heading}>No results on this board yet</div>
        <p style={note}>Runs and gaps fill in as rounds settle.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p role="note" style={{ ...box, margin: 0, padding: '10px 14px', fontSize: 11, lineHeight: 1.6, color: 'var(--text2)', background: 'var(--surface2)' }}>
        ⚠ {PAST_DOES_NOT_PREDICT}
      </p>

      {/* Run strip */}
      <section style={box} aria-label="Run strip">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={heading}>Run strip · newest first</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>all {fmt(winners.length)} results · slide right for older</span>
        </div>
        <div data-testid="run-strip" style={{ display: 'flex', flexWrap: 'nowrap', gap: 8, padding: '12px 4px 6px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <LatestTag />
          {strip.map((r, i) => (
            <div key={i} title={`${sideName(r.side)} ×${r.len}`} style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ display: 'flex', gap: 2 }}>
                {Array.from({ length: r.len }, (_, k) => {
                  // Drawn newest first: box k of the run is result start + k.
                  const demo = r.start + k >= realCount;
                  const latest = i === 0 && k === 0;
                  return <span key={k} data-demo={demo ? '' : undefined} data-latest={latest ? '' : undefined} style={{ width: 18, height: 22, borderRadius: 4, background: sideColor(r.side), color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(demo ? DEMO_STYLE : null), ...(latest ? LATEST_RING : null) }}>{r.side === 'DELHI' ? 'D' : 'B'}</span>;
                })}
              </div>
              <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--text3)' }}>×{r.len}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Window picker, shared by the table and the gaps */}
      <div role="radiogroup" aria-label="How many results to look back over" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', marginRight: 4 }}>Look back over</span>
        {windows.map((w) => {
          const on = w === lookBack;
          return (
            <button key={w} type="button" role="radio" aria-checked={on} onClick={() => setPickedWindow(w)} style={{ padding: '6px 12px', borderRadius: 999, border: `1px solid ${on ? 'var(--gold)' : 'var(--line2)'}`, background: on ? 'var(--gold)' : 'var(--surface2)', color: on ? 'var(--on-gold)' : 'var(--text2)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
              {w === winners.length && !(RUN_WINDOWS as readonly number[]).includes(w) ? `All ${fmt(w)}` : `Last ${fmt(w)}`}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        {/* Run-length table */}
        <section style={box} aria-label="Run lengths">
          <span style={heading}>How long each side's runs were</span>
          <p style={note}>Runs of each length in the last {fmt(table.rounds)} results. The current run counts at its length so far.</p>
          <div className="bb-noscroll" style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Run of</th>
                  {SIDES.map((sd) => <th key={sd} style={{ ...th, color: sideColor(sd) }}>{sideName(sd)}</th>)}
                </tr>
              </thead>
              <tbody>
                {RUN_BUCKETS.map((b, i) => (
                  <tr key={b}>
                    <td style={{ ...td, textAlign: 'left', color: 'var(--text2)' }}>{bucketLabel(b)}</td>
                    {SIDES.map((sd) => <td key={sd} style={td}>{fmt(table[sd].buckets[i])}</td>)}
                  </tr>
                ))}
                <tr>
                  <td style={{ ...td, textAlign: 'left', color: 'var(--gold-ink)' }}>Longest</td>
                  {SIDES.map((sd) => <td key={sd} style={{ ...td, color: 'var(--gold-ink)' }}>{table[sd].longest ? `×${table[sd].longest}` : '—'}</td>)}
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Gap view */}
        <section style={box} aria-label="Gaps between wins">
          <span style={heading}>Gaps between wins</span>
          <p style={note}>Rounds in a row a side went without winning. Only gaps closed by a win on both ends are counted.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
            {SIDES.map((sd) => {
              const g = gaps[sd];
              return (
                <div key={sd} style={{ background: `color-mix(in srgb,${sideColor(sd)} 10%,var(--surface2))`, border: `1px solid color-mix(in srgb,${sideColor(sd)} 26%,transparent)`, borderRadius: 12, padding: '10px 12px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: sideColor(sd) }}>{sideName(sd)}</div>
                  <div className="font-grotesk" style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                    {g.sinceLast === null ? `${fmt(table.rounds)}+` : fmt(g.sinceLast)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                    {g.sinceLast === 0 ? 'won the latest round' : g.sinceLast === null ? 'rounds, no win in this window' : `round${g.sinceLast === 1 ? '' : 's'} since its last win`}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 6 }}>
                    avg gap <b>{g.avg ?? '—'}</b> · longest <b>{g.longest || '—'}</b>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="bb-noscroll" style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Gap of</th>
                  {SIDES.map((sd) => <th key={sd} style={{ ...th, color: sideColor(sd) }}>{sideName(sd)}</th>)}
                </tr>
              </thead>
              <tbody>
                {RUN_BUCKETS.map((b, i) => (
                  <tr key={b}>
                    <td style={{ ...td, textAlign: 'left', color: 'var(--text2)' }}>{bucketLabel(b)}</td>
                    {SIDES.map((sd) => <td key={sd} style={td}>{fmt(gaps[sd].buckets[i])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
};

export default RunsAndGaps;
