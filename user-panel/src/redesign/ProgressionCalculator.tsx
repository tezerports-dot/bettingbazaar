// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ProgressionCalculator.tsx — its own section under the analytics tabs, so it
 * shows whichever tab is open (owner, 2026-10-22: "visible on every slide not
 * just Runs and Gaps ... seprately below analytics").
 *
 * A start bet, a multiplier and a number of steps give the ladder, the total
 * at risk, the profit if a step wins, and how often that ladder would have run
 * out over this board's past results. It edits the same inputs as the Auto
 * bets sheet (`ladderSettings.ts`), and its "Run as auto bets" button opens
 * that sheet with them.
 *
 * Every figure is descriptive. Each round is drawn on its own, so it says
 * plainly that past results do not predict the next round and never calls the
 * progression a way to win: the ran-out count is shown beside the ladder.
 *
 * The payout is the server's own (`payoutMultiplier`, or
 * `generalPayoutMultiplier` on General rounds, and `winningsFeePercent`); until
 * it has arrived the profit is not shown rather than guessed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Side, RUN_WINDOWS, LADDER_MAX_STEPS, ladderPlan, ladderBacktest, winReturn } from './analytics';
import { fmt } from './format';
import { inputStyle, fieldLabel } from './Screen';
import { getBackend } from '../services/backend.service';
import { Board } from '../types';
import { box, heading, PAST_DOES_NOT_PREDICT } from './RunsAndGaps';
import { Audience, num, useLadderSettings } from './ladderSettings';

const backend = getBackend();

export const SIDES: Side[] = ['DELHI', 'BOMBAY'];
export const sideName = (sd: Side) => (sd === 'DELHI' ? 'Delhi' : 'Bombay');
export const sideColor = (sd: Side) => (sd === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)');
export const note: React.CSSProperties = { fontSize: 11, color: 'var(--text3)', lineHeight: 1.6, margin: '6px 0 0' };
const th: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: 'var(--text3)', textAlign: 'right', padding: '6px 8px', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--text)', textAlign: 'right', padding: '7px 8px', borderTop: '1px solid var(--line)' };

export interface PayoutRules {
  /** What a winning stake returns, after the fee; null until the rules arrive. */
  payout: ((stake: number) => number) | null;
  /** Every stake is a whole multiple of this (`betMultipleOf`). */
  unit: number;
}

/** The payout rules the server runs for this profile, and the bet step. */
export function usePayoutRules(audience: Audience): PayoutRules {
  const [rules, setRules] = useState<{ vip: number; general: number; fee: number; unit: number } | null>(null);
  useEffect(() => {
    let live = true;
    backend.getSystemConfig().then((c: any) => {
      if (!live) return;
      const vip = Number(c.payoutMultiplier);
      const general = Number(c.generalPayoutMultiplier);
      const fee = Number(c.winningsFeePercent);
      const unit = Number(c.betMultipleOf) || 10; // schema default: riskRules.enforceMultiplesOf10 = true
      if (Number.isFinite(vip) && vip > 0 && Number.isFinite(fee)) {
        setRules({ vip, general: Number.isFinite(general) && general > 0 ? general : vip, fee, unit });
      }
    }).catch(() => { /* the profit lines say they are waiting */ });
    return () => { live = false; };
  }, []);
  return useMemo(() => {
    if (!rules) return { payout: null, unit: 10 }; // schema default, as above
    const multiplier = audience === 'GENERAL' ? rules.general : rules.vip;
    return { payout: (stake: number) => winReturn(stake, multiplier, rules.fee), unit: rules.unit };
  }, [rules, audience]);
}

/** The ladder the inputs describe, or what is wrong with them. */
export function useLadder(audience: Audience, rules: PayoutRules) {
  const [s] = useLadderSettings(audience);
  const start = num(s.start);
  const factor = num(s.factor);
  const steps = num(s.steps);
  const problem =
    start === null || start < 1 ? 'Enter a starting bet of at least 1.'
      : factor === null || factor < 1 || factor > 10 ? 'Enter a multiplier from 1 to 10.'
        : steps === null || !Number.isInteger(steps) || steps < 1 || steps > LADDER_MAX_STEPS ? `Enter between 1 and ${LADDER_MAX_STEPS} steps.`
          : '';
  const plan = useMemo(
    () => (problem ? [] : ladderPlan(start as number, factor as number, steps as number, rules.payout, rules.unit)),
    [problem, start, factor, steps, rules],
  );
  return { problem, plan, stakes: useMemo(() => plan.map((p) => p.stake), [plan]) };
}

/** The look-back windows that exist for this many results. */
export function useWindows(count: number): [number[], number, (w: number) => void] {
  const windows = useMemo(() => {
    const out: number[] = [];
    for (const w of RUN_WINDOWS) {
      const n = Math.min(w, count);
      if (n > 0 && !out.includes(n)) out.push(n);
    }
    return out;
  }, [count]);
  const [picked, setPicked] = useState<number>(RUN_WINDOWS[RUN_WINDOWS.length - 1]);
  const lookBack = windows.includes(picked) ? picked : (windows.filter((w) => w <= picked).pop() ?? windows[windows.length - 1] ?? 0);
  return [windows, lookBack, setPicked];
}

export const WindowPicker: React.FC<{ windows: number[]; lookBack: number; total: number; onPick: (w: number) => void; label?: string }> = ({ windows, lookBack, total, onPick, label = 'Look back over' }) => (
  <div role="radiogroup" aria-label="How many results to look back over" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', marginRight: 4 }}>{label}</span>
    {windows.map((w) => {
      const on = w === lookBack;
      return (
        <button key={w} type="button" role="radio" aria-checked={on} onClick={() => onPick(w)} style={{ padding: '6px 12px', borderRadius: 999, border: `1px solid ${on ? 'var(--gold)' : 'var(--line2)'}`, background: on ? 'var(--gold)' : 'var(--surface2)', color: on ? 'var(--on-gold)' : 'var(--text2)', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
          {w === total && !(RUN_WINDOWS as readonly number[]).includes(w) ? `All ${fmt(w)}` : `Last ${fmt(w)}`}
        </button>
      );
    })}
  </div>
);

/** Starting bet, multiplier, steps and side: the inputs both screens share. */
export const LadderInputs: React.FC<{ audience: Audience; idPrefix: string }> = ({ audience, idPrefix }) => {
  const [s, set] = useLadderSettings(audience);
  const ids = { start: `${idPrefix}-start`, factor: `${idPrefix}-factor`, steps: `${idPrefix}-steps` };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 12 }}>
      <div>
        <label htmlFor={ids.start} style={fieldLabel}>Starting bet (₹)</label>
        <input id={ids.start} type="number" inputMode="decimal" min={1} value={s.start} onChange={(e) => set({ start: e.target.value })} style={inputStyle} />
      </div>
      <div>
        <label htmlFor={ids.factor} style={fieldLabel}>Multiply after a loss</label>
        <input id={ids.factor} type="number" inputMode="decimal" min={1} max={10} step="0.5" value={s.factor} onChange={(e) => set({ factor: e.target.value })} style={inputStyle} />
      </div>
      <div>
        <label htmlFor={ids.steps} style={fieldLabel}>Steps</label>
        <input id={ids.steps} type="number" inputMode="numeric" min={1} max={LADDER_MAX_STEPS} value={s.steps} onChange={(e) => set({ steps: e.target.value })} style={inputStyle} />
      </div>
      <div>
        <span style={fieldLabel}>Backing</span>
        <div role="radiogroup" aria-label="Side backed" style={{ display: 'flex', gap: 6 }}>
          {SIDES.map((sd) => {
            const on = s.side === sd;
            return (
              <button key={sd} type="button" role="radio" aria-checked={on} onClick={() => set({ side: sd })} style={{ flex: 1, height: 46, borderRadius: 12, border: `1px solid ${on ? sideColor(sd) : 'var(--line2)'}`, background: on ? `color-mix(in srgb,${sideColor(sd)} 22%,var(--surface2))` : 'var(--surface2)', color: on ? 'var(--text)' : 'var(--text2)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>{sideName(sd)}</button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const signed = (v: number) => `${v < 0 ? '−' : '+'}₹${fmt(Math.abs(v))}`;

interface Props {
  board?: Board;
  /** The board's winners, newest first, demo ones included (as the tabs above read them). */
  winners: Side[];
  audience: Audience;
  /** Opens the Auto bets sheet; absent where no bet can be placed (Results). */
  onAuto?: () => void;
}

const ProgressionCalculator: React.FC<Props> = ({ board, winners, audience, onAuto }) => {
  const [s] = useLadderSettings(audience);
  const rules = usePayoutRules(audience);
  const { problem, plan, stakes } = useLadder(audience, rules);
  const [windows, lookBack, setPicked] = useWindows(winners.length);
  const test = useMemo(() => ladderBacktest(winners, s.side, stakes, lookBack, rules.payout), [winners, s.side, stakes, lookBack, rules.payout]);
  const last = plan[plan.length - 1];
  const overMax = board?.maxBet ? plan.filter((p) => p.stake > board.maxBet).length : 0;

  return (
    <section style={{ ...box, marginTop: 14 }} aria-label="Progression calculator">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span style={heading}>Progression calculator</span>
        {onAuto && (
          <button type="button" onClick={onAuto} disabled={!!problem} style={{ padding: '7px 14px', borderRadius: 999, border: 'none', background: problem ? 'var(--surface3)' : 'var(--gold-metal)', color: problem ? 'var(--text3)' : 'var(--on-gold)', fontSize: 11, fontWeight: 800, cursor: problem ? 'not-allowed' : 'pointer' }}>
            Run as auto bets
          </button>
        )}
      </div>
      <p style={note}>Start with a bet and multiply it after each loss. This shows what that costs and how often it would have run out of steps on this board. It is not a way to win.</p>

      <LadderInputs audience={audience} idPrefix="bb-calc" />

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

          {windows.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <WindowPicker windows={windows} lookBack={lookBack} total={winners.length} onPick={setPicked} label="Test over" />
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 12 }}>
            <Stat label="Total at risk" value={`₹${fmt(last.atRisk)}`} sub={`lost if all ${plan.length} step${plan.length === 1 ? '' : 's'} lose`} tone="var(--red)" />
            <Stat label="Profit if the last step wins" value={last.profitIfWins === null ? '…' : `₹${fmt(last.profitIfWins)}`} sub={rules.payout ? 'after the winnings fee' : 'waiting for the payout rules'} />
            <Stat label="Times it ran out" value={fmt(test.ranOut)} sub={`in the last ${fmt(test.rounds)} results, backing ${sideName(s.side)}`} tone={test.ranOut ? 'var(--red)' : undefined} />
            <Stat label="Net over these results" value={test.net === null ? '…' : signed(test.net)} sub={`${fmt(test.won)} ladder${test.won === 1 ? '' : 's'} won, ${fmt(test.ranOut)} lost in full`} tone={test.net !== null && test.net < 0 ? 'var(--red)' : undefined} />
          </div>

          {rules.payout && (
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

export const Stat: React.FC<{ label: string; value: string; sub: string; tone?: string }> = ({ label, value, sub, tone }) => (
  <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px' }}>
    <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)' }}>{label}</div>
    <div className="font-grotesk" style={{ fontSize: 19, fontWeight: 700, color: tone ?? 'var(--text)', marginTop: 2 }}>{value}</div>
    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{sub}</div>
  </div>
);

export default ProgressionCalculator;
