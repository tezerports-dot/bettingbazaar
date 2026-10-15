// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * RunsAndGaps.tsx — the Runs & Gaps tab of the Analytics page (owner,
 * 2026-10-15): Delhi and Bombay side by side over one board's real results.
 *
 *   • Run strip         — the newest results grouped into runs (D D B B B B D)
 *   • Run-length table  — runs of 1, 2, 3, 4, 5, 6+ per side, and the longest
 *   • Gap view          — rounds since each side last won, and its past gaps
 *   • Progression calc  — a start bet and a factor give the ladder, the total
 *                          at risk, the profit if the last step wins, and how
 *                          often that ladder would have run out in this history
 *
 * Every figure is descriptive (`analytics.ts`). Each round is drawn on its
 * own, so the page says plainly that the past does not predict the next round
 * and never calls the progression a way to win: the ran-out count is shown
 * beside the ladder, not under it.
 *
 * The payout used for "profit if it wins" is the server's own
 * `payoutMultiplier` and `winningsFeePercent` (system config); until it has
 * arrived the profit is not shown rather than guessed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Side, RUN_WINDOWS, RUN_BUCKETS, LADDER_MAX_STEPS,
  runsOf, runLengthTable, gapSummary, ladderPlan, ladderBacktest, winReturn,
} from './analytics';
import { fmt } from './format';
import { inputStyle, fieldLabel } from './Screen';
import { getBackend } from '../services/backend.service';
import { Board } from '../types';

const backend = getBackend();

const SIDES: Side[] = ['DELHI', 'BOMBAY'];
const sideName = (sd: Side) => (sd === 'DELHI' ? 'Delhi' : 'Bombay');
const sideColor = (sd: Side) => (sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)');
const bucketLabel = (b: number) => (b === RUN_BUCKETS[RUN_BUCKETS.length - 1] ? `${b}+` : String(b));

export const box: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 };
export const heading: React.CSSProperties = { fontSize: 12, fontWeight: 800, color: 'var(--text)' };
const note: React.CSSProperties = { fontSize: 11, color: 'var(--text3)', lineHeight: 1.6, margin: '6px 0 0' };
const th: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: 'var(--text3)', textAlign: 'right', padding: '6px 8px', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--text)', textAlign: 'right', padding: '7px 8px', borderTop: '1px solid var(--line)' };

/** The one line every part of this tab stands under. */
export const PAST_DOES_NOT_PREDICT = 'Past results do not predict the next round. Each round is decided on its own, so a long run does not make the other side more likely to win next.';

/** The payout rules the server is running, or null until they arrive. */
function usePayout(): ((stake: number) => number) | null {
  const [rules, setRules] = useState<{ multiplier: number; fee: number } | null>(null);
  useEffect(() => {
    let live = true;
    backend.getSystemConfig().then((c) => {
      if (!live) return;
      const multiplier = Number(c.payoutMultiplier);
      const fee = Number(c.winningsFeePercent);
      if (Number.isFinite(multiplier) && multiplier > 0 && Number.isFinite(fee)) setRules({ multiplier, fee });
    }).catch(() => { /* the profit lines say they are waiting */ });
    return () => { live = false; };
  }, []);
  return useMemo(() => (rules ? (stake: number) => winReturn(stake, rules.multiplier, rules.fee) : null), [rules]);
}

interface Props {
  board?: Board;
  /** The board's real winners, newest first. */
  winners: Side[];
}

const RunsAndGaps: React.FC<Props> = ({ board, winners }) => {
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
  // The strip: the newest 40 results as runs, oldest on the left.
  const strip = useMemo(() => {
    const runs = runsOf(winners.slice(0, 40));
    return runs.reverse();
  }, [winners]);

  const payout = usePayout();

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
          <span style={heading}>Run strip · newest on the right</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)' }}>last {Math.min(40, winners.length)} results</span>
        </div>
        <div className="bb-noscroll" style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '12px 0 2px' }}>
          {strip.map((r, i) => (
            <div key={i} title={`${sideName(r.side)} ×${r.len}`} style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ display: 'flex', gap: 2 }}>
                {Array.from({ length: r.len }, (_, k) => (
                  <span key={k} style={{ width: 18, height: 22, borderRadius: 4, background: sideColor(r.side), color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{r.side === 'DELHI' ? 'D' : 'B'}</span>
                ))}
              </div>
              <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--text3)' }}>×{r.len}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Window picker, shared by the table, the gaps and the calculator */}
      <div role="radiogroup" aria-label="How many results to look back over" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', marginRight: 4 }}>Look back over</span>
        {windows.map((w) => {
          const on = w === lookBack;
          return (
            <button key={w} type="button" role="radio" aria-checked={on} onClick={() => setPickedWindow(w)} style={{ padding: '6px 12px', borderRadius: 999, border: `1px solid ${on ? 'var(--gold)' : 'var(--line2)'}`, background: on ? 'var(--gold)' : 'var(--surface2)', color: on ? '#1a1200' : 'var(--text2)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
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

      <ProgressionCalculator board={board} winners={winners} lookBack={lookBack} payout={payout} />
    </div>
  );
};

interface CalcProps {
  board?: Board;
  winners: Side[];
  lookBack: number;
  payout: ((stake: number) => number) | null;
}

/** Parses a typed number; '' and junk are null so the field can be cleared while typing. */
const num = (v: string): number | null => {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
};

const ProgressionCalculator: React.FC<CalcProps> = ({ board, winners, lookBack, payout }) => {
  const [startText, setStartText] = useState('10');
  const [factorText, setFactorText] = useState('3');
  const [stepsText, setStepsText] = useState('5');
  const [side, setSide] = useState<Side>('DELHI');

  const start = num(startText);
  const factor = num(factorText);
  const steps = num(stepsText);
  const problem =
    start === null || start < 1 ? 'Enter a starting bet of at least 1.'
      : factor === null || factor < 1 || factor > 10 ? 'Enter a multiplier from 1 to 10.'
        : steps === null || !Number.isInteger(steps) || steps < 1 || steps > LADDER_MAX_STEPS ? `Enter between 1 and ${LADDER_MAX_STEPS} steps.`
          : '';

  const plan = useMemo(
    () => (problem ? [] : ladderPlan(start as number, factor as number, steps as number, payout)),
    [problem, start, factor, steps, payout],
  );
  const stakes = useMemo(() => plan.map((p) => p.stake), [plan]);
  const test = useMemo(() => ladderBacktest(winners, side, stakes, lookBack, payout), [winners, side, stakes, lookBack, payout]);
  const last = plan[plan.length - 1];
  const overMax = board?.maxBet ? plan.filter((p) => p.stake > board.maxBet).length : 0;

  const ids = { start: 'bb-calc-start', factor: 'bb-calc-factor', steps: 'bb-calc-steps' };

  return (
    <section style={box} aria-label="Progression calculator">
      <span style={heading}>Progression calculator</span>
      <p style={note}>Start with a bet and multiply it after each loss. This shows what that costs and how often it would have run out of steps on this board. It is not a way to win.</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 12 }}>
        <div>
          <label htmlFor={ids.start} style={fieldLabel}>Starting bet (₹)</label>
          <input id={ids.start} type="number" inputMode="decimal" min={1} value={startText} onChange={(e) => setStartText(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label htmlFor={ids.factor} style={fieldLabel}>Multiply after a loss</label>
          <input id={ids.factor} type="number" inputMode="decimal" min={1} max={10} step="0.5" value={factorText} onChange={(e) => setFactorText(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label htmlFor={ids.steps} style={fieldLabel}>Steps</label>
          <input id={ids.steps} type="number" inputMode="numeric" min={1} max={LADDER_MAX_STEPS} value={stepsText} onChange={(e) => setStepsText(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <span style={fieldLabel}>Backing</span>
          <div role="radiogroup" aria-label="Side backed" style={{ display: 'flex', gap: 6 }}>
            {SIDES.map((sd) => {
              const on = side === sd;
              return (
                <button key={sd} type="button" role="radio" aria-checked={on} onClick={() => setSide(sd)} style={{ flex: 1, height: 46, borderRadius: 12, border: `1px solid ${on ? sideColor(sd) : 'var(--line2)'}`, background: on ? `color-mix(in srgb,${sideColor(sd)} 22%,var(--surface2))` : 'var(--surface2)', color: on ? 'var(--text)' : 'var(--text2)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>{sideName(sd)}</button>
              );
            })}
          </div>
        </div>
      </div>

      {problem ? (
        <p role="alert" style={{ ...note, color: 'var(--red)', marginTop: 12 }}>{problem}</p>
      ) : (
        <>
          <div aria-label="The ladder" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
            {plan.map((p, i) => (
              <span key={i} style={{ padding: '6px 10px', borderRadius: 9, background: 'var(--surface2)', border: `1px solid ${board?.maxBet && p.stake > board.maxBet ? 'var(--red)' : 'var(--line)'}`, fontSize: 12, fontWeight: 800, color: 'var(--text)' }}>
                <span style={{ fontSize: 9, color: 'var(--text3)', marginRight: 5 }}>#{i + 1}</span>₹{fmt(p.stake)}
              </span>
            ))}
          </div>
          {overMax > 0 && (
            <p style={{ ...note, color: 'var(--red)' }}>
              {overMax} step{overMax === 1 ? '' : 's'} above this board's largest bet of ₹{fmt(board?.maxBet ?? 0)}; {overMax === 1 ? 'it' : 'they'} could not be placed.
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 12 }}>
            <Stat label="Total at risk" value={`₹${fmt(last.atRisk)}`} sub={`lost if all ${plan.length} step${plan.length === 1 ? '' : 's'} lose`} tone="var(--red)" />
            <Stat label="Profit if the last step wins" value={last.profitIfWins === null ? '…' : `₹${fmt(last.profitIfWins)}`} sub={payout ? 'after the winnings fee' : 'waiting for the payout rules'} />
            <Stat label="Times it ran out" value={fmt(test.ranOut)} sub={`in the last ${fmt(test.rounds)} results, backing ${sideName(side)}`} tone={test.ranOut ? 'var(--red)' : undefined} />
            <Stat label="Net over these results" value={test.net === null ? '…' : `${test.net < 0 ? '−' : '+'}₹${fmt(Math.abs(test.net))}`} sub={`${fmt(test.won)} ladder${test.won === 1 ? '' : 's'} won, ${fmt(test.ranOut)} lost in full`} tone={test.net !== null && test.net < 0 ? 'var(--red)' : undefined} />
          </div>

          {payout && (
            <div className="bb-noscroll" style={{ overflowX: 'auto', marginTop: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Step</th>
                    <th style={th}>Bet</th>
                    <th style={th}>Staked so far</th>
                    <th style={th}>Profit if it wins</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((p, i) => (
                    <tr key={i}>
                      <td style={{ ...td, textAlign: 'left', color: 'var(--text2)' }}>{i + 1}</td>
                      <td style={td}>₹{fmt(p.stake)}</td>
                      <td style={td}>₹{fmt(p.atRisk)}</td>
                      <td style={{ ...td, color: (p.profitIfWins ?? 0) < 0 ? 'var(--red)' : 'var(--text)' }}>{(p.profitIfWins ?? 0) < 0 ? '−' : ''}₹{fmt(Math.abs(p.profitIfWins ?? 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <p style={{ ...note, marginTop: 12 }}>
        A long run against the side you back loses every step at once. {PAST_DOES_NOT_PREDICT.split('. ')[0]}.
      </p>
    </section>
  );
};

const Stat: React.FC<{ label: string; value: string; sub: string; tone?: string }> = ({ label, value, sub, tone }) => (
  <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px' }}>
    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)' }}>{label}</div>
    <div className="font-grotesk" style={{ fontSize: 19, fontWeight: 700, color: tone ?? 'var(--text)', marginTop: 2 }}>{value}</div>
    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{sub}</div>
  </div>
);

export default RunsAndGaps;
