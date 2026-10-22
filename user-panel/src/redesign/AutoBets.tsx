// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * AutoBets.tsx — the Auto bets sheet (owner, 2026-10-22), opened by the Auto
 * button beside the amount box and by the calculator's "Run as auto bets".
 *
 * One plan per board and profile (VIP and General each their own): a side, a
 * first bet, a multiplier after each loss, the steps, a total budget and an
 * optional stop-loss and take-profit. The server places one bet a round
 * through the same checks as a tapped bet and stops the plan on its own
 * (backend/domains/markets/autoBets.js); the player can stop it any time.
 *
 * The ladder inputs are the progression calculator's (`ladderSettings.ts`),
 * so the two always show the same plan, and the backtest plays it through
 * the same past results the calculator reads, stops included
 * (`autoBacktest`). Every figure says past results do not predict the next
 * round. The plan's standing (step, net, rounds) is the server's, read again
 * every few seconds while the sheet is open.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { player } from '../services/api';
import { Board } from '../types';
import { Side, autoBacktest } from './analytics';
import { analyticsWindowFor } from '../constants';
import { useDemoResults, withDemoResults } from './DemoResults';
import { fmt } from './format';
import { inputStyle, fieldLabel } from './Screen';
import { box, heading, PAST_DOES_NOT_PREDICT } from './RunsAndGaps';
import { Audience, num, useLadderSettings } from './ladderSettings';
import {
  LadderInputs, Stat, WindowPicker, note, sideName, signed, useLadder, usePayoutRules, useWindows,
} from './ProgressionCalculator';

/** A plan as `GET /api/bet/auto` sends it (bet.routes.js `autoPlanView`). */
export interface AutoPlan {
  planId: string; boardKey: string; audience: Audience; side: Side;
  factor: number; stakes: number[]; budget: number; stopLoss: number; takeProfit: number;
  startedAt: string; stoppedAt: string | null; running: boolean;
  stopReason: string | null; stopText: string | null;
  played: number; won: number; pending: number; net: number; staked: number;
  step: number; nextStake: number; lastBetAt: string | null;
}

const REFRESH_MS = 5000;

/** The player's plans, read while `live`, every REFRESH_MS. */
export function useAutoPlans(live: boolean) {
  const [plans, setPlans] = useState<AutoPlan[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const res: any = await player.autoBets();
      setPlans(res?.plans ?? []);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load your auto bets.');
    }
  }, []);
  useEffect(() => {
    if (!live) return undefined;
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [live, load]);
  return { plans, error, reload: load, setPlans };
}

interface Props {
  board: Board;
  audience: Audience;
  /** The board's real winners, newest first (GameContext). */
  winners: Side[];
  onClose: () => void;
}

const AutoBetsSheet: React.FC<Props> = ({ board, audience, winners, onClose }) => {
  const { plans, error: loadError, reload, setPlans } = useAutoPlans(true);
  const mine = (plans ?? []).filter((p) => p.boardKey === board.key && p.audience === audience);
  const running = mine.find((p) => p.running) ?? null;
  const stopped = mine.filter((p) => !p.running).slice(0, 3);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'rgba(0,0,0,.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="auto-bets-title" style={{
        width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', padding: 16, borderRadius: '18px 18px 0 0',
        background: 'var(--bg)', border: '1px solid var(--line2)', boxShadow: 'var(--shadow)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 id="auto-bets-title" className="font-grotesk" style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>
            Auto bets · {board.name} · {audience === 'GENERAL' ? 'General' : 'VIP'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close auto bets" style={{ border: 'none', background: 'var(--surface2)', color: 'var(--text2)', width: 32, height: 32, borderRadius: 999, fontSize: 16, cursor: 'pointer' }}>×</button>
        </div>
        <p style={note}>One bet a round on this board, placed for you until a stop is reached or you press Stop. It keeps going when you close the app.</p>

        {loadError && <p role="alert" style={{ ...note, color: 'var(--red)' }}>{loadError}</p>}
        {plans === null && !loadError ? (
          <p role="status" style={note}>Loading…</p>
        ) : running ? (
          <RunningPlan plan={running} onStopped={(p) => setPlans((all) => (all ?? []).map((x) => (x.planId === p.planId ? p : x)))} />
        ) : (
          <NewPlan board={board} audience={audience} winners={winners} onStarted={reload} />
        )}

        {stopped.length > 0 && (
          <section style={{ marginTop: 14 }} aria-label="Stopped plans">
            <span style={heading}>Last stopped</span>
            {stopped.map((p) => (
              <div key={p.planId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--text2)' }}>
                <span>{sideName(p.side)} · {p.played} round{p.played === 1 ? '' : 's'} · {p.stopText}</span>
                <b style={{ color: p.net < 0 ? 'var(--red)' : 'var(--text)' }}>{signed(p.net)}</b>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
};

const RunningPlan: React.FC<{ plan: AutoPlan; onStopped: (p: AutoPlan) => void }> = ({ plan, onStopped }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stop = async () => {
    setBusy(true); setError('');
    try {
      const res: any = await player.stopAutoBets(plan.planId);
      onStopped(res.plan);
    } catch (e: any) {
      setError(e?.message || 'Could not stop your auto bets. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const left = plan.budget + plan.net;
  return (
    <section style={{ ...box, marginTop: 12 }} aria-label="Auto bets running">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={heading}><span aria-hidden style={{ color: 'var(--green)' }}>●</span> Running · backing {sideName(plan.side)}</span>
        <button type="button" onClick={stop} disabled={busy} style={{ padding: '9px 20px', borderRadius: 999, border: 'none', background: 'var(--red)', color: '#fff', fontSize: 12, fontWeight: 800, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      {error && <p role="alert" style={{ ...note, color: 'var(--red)' }}>{error}</p>}
      <div aria-label="The ladder" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
        {plan.stakes.map((s, i) => (
          <span key={i} aria-current={i === plan.step ? 'step' : undefined} style={{ padding: '6px 10px', borderRadius: 9, background: i === plan.step ? 'var(--gold)' : 'var(--surface2)', color: i === plan.step ? 'var(--on-gold)' : 'var(--text)', border: '1px solid var(--line)', fontSize: 12, fontWeight: 800 }}>
            <span style={{ fontSize: 9, opacity: 0.7, marginRight: 5 }}>#{i + 1}</span>₹{fmt(s)}
          </span>
        ))}
      </div>
      <div role="status" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 12 }}>
        <Stat label="Net so far" value={signed(plan.net)} sub={`${fmt(plan.played)} round${plan.played === 1 ? '' : 's'} played, ${fmt(plan.won)} won`} tone={plan.net < 0 ? 'var(--red)' : undefined} />
        <Stat label="Next bet" value={`₹${fmt(plan.nextStake)}`} sub={plan.pending ? 'waiting for this round\'s result' : `step ${plan.step + 1} of ${plan.stakes.length}`} />
        <Stat label="Budget left" value={`₹${fmt(Math.max(0, left))}`} sub={`of ₹${fmt(plan.budget)}`} />
        <Stat label="Stops at" value={[plan.stopLoss ? `−₹${fmt(plan.stopLoss)}` : null, plan.takeProfit ? `+₹${fmt(plan.takeProfit)}` : null].filter(Boolean).join(' / ') || 'budget only'} sub="stop-loss / take-profit" />
      </div>
    </section>
  );
};

const NewPlan: React.FC<{ board: Board; audience: Audience; winners: Side[]; onStarted: () => void }> = ({ board, audience, winners, onStarted }) => {
  const [s, set] = useLadderSettings(audience);
  const rules = usePayoutRules(audience);
  const { problem: ladderProblem, plan, stakes } = useLadder(audience, rules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The same past results the calculator reads: real, then any demo ones.
  const demoCfg = useDemoResults();
  const filled = useMemo(
    () => withDemoResults(winners, board.key, analyticsWindowFor(board), !!demoCfg?.on, board.demoResults?.[audience] ?? ''),
    [winners, board, demoCfg, audience],
  );
  const [windows, lookBack, setPicked] = useWindows(filled.winners.length);

  const start = num(s.start);
  const budget = num(s.budget);
  const stopLoss = s.stopLoss.trim() === '' ? 0 : num(s.stopLoss);
  const takeProfit = s.takeProfit.trim() === '' ? 0 : num(s.takeProfit);
  const overMax = board.maxBet ? stakes.findIndex((x) => x > board.maxBet) : -1;
  const problem = ladderProblem
    || (start !== null && start % rules.unit !== 0 ? `The first bet must be a whole multiple of ₹${rules.unit}.` : '')
    || (stakes[0] !== undefined && stakes[0] < board.minBet ? `The first bet must be at least ₹${fmt(board.minBet)} on this board.` : '')
    || (overMax !== -1 ? `Step ${overMax + 1} would be ₹${fmt(stakes[overMax])}, above this board's largest bet of ₹${fmt(board.maxBet)}.` : '')
    || (budget === null || !Number.isInteger(budget) || budget < (stakes[0] ?? 1) ? 'Enter a budget in whole rupees that covers at least the first bet.' : '')
    || (stopLoss === null || !Number.isInteger(stopLoss) || stopLoss < 0 ? 'The stop-loss is whole rupees, or leave it empty.' : '')
    || (takeProfit === null || !Number.isInteger(takeProfit) || takeProfit < 0 ? 'The take-profit is whole rupees, or leave it empty.' : '');

  const test = useMemo(
    () => (problem || !rules.payout ? null : autoBacktest(filled.winners, s.side, stakes, lookBack, rules.payout, { budget: budget as number, stopLoss, takeProfit })),
    [problem, rules.payout, filled.winners, s.side, stakes, lookBack, budget, stopLoss, takeProfit],
  );

  const startPlan = async () => {
    setBusy(true); setError('');
    try {
      await player.startAutoBets({
        boardKey: board.key, audience, side: s.side, start: start as number, factor: Number(s.factor), steps: plan.length,
        budget: budget as number, stopLoss: stopLoss || 0, takeProfit: takeProfit || 0,
      });
      onStarted();
    } catch (e: any) {
      setError(e?.message || 'Could not start auto bets. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const ids = { budget: 'bb-auto-budget', stopLoss: 'bb-auto-stoploss', takeProfit: 'bb-auto-takeprofit' };
  const stoppedText: Record<string, string> = {
    TAKE_PROFIT: 'take-profit reached', STOP_LOSS: 'stop-loss reached', BUDGET_USED: 'budget could not cover the next bet',
  };

  return (
    <>
      <LadderInputs audience={audience} idPrefix="bb-auto" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 10 }}>
        <div>
          <label htmlFor={ids.budget} style={fieldLabel}>Total budget (₹)</label>
          <input id={ids.budget} type="number" inputMode="numeric" min={1} value={s.budget} onChange={(e) => set({ budget: e.target.value })} placeholder="e.g. 5000" style={inputStyle} />
        </div>
        <div>
          <label htmlFor={ids.stopLoss} style={fieldLabel}>Stop when down (₹)</label>
          <input id={ids.stopLoss} type="number" inputMode="numeric" min={0} value={s.stopLoss} onChange={(e) => set({ stopLoss: e.target.value })} placeholder="optional" style={inputStyle} />
        </div>
        <div>
          <label htmlFor={ids.takeProfit} style={fieldLabel}>Stop when up (₹)</label>
          <input id={ids.takeProfit} type="number" inputMode="numeric" min={0} value={s.takeProfit} onChange={(e) => set({ takeProfit: e.target.value })} placeholder="optional" style={inputStyle} />
        </div>
      </div>

      {problem ? (
        <p role="alert" style={{ ...note, color: 'var(--red)', marginTop: 12 }}>{problem}</p>
      ) : (
        <div aria-label="The ladder" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          {plan.map((p, i) => (
            <span key={i} style={{ padding: '6px 10px', borderRadius: 9, background: 'var(--surface2)', border: '1px solid var(--line)', fontSize: 12, fontWeight: 800, color: 'var(--text)' }}>
              <span style={{ fontSize: 9, color: 'var(--text3)', marginRight: 5 }}>#{i + 1}</span>₹{fmt(p.stake)}
            </span>
          ))}
        </div>
      )}

      <section style={{ ...box, marginTop: 12 }} aria-label="Backtest">
        <span style={heading}>If you had run this on past results</span>
        {windows.length > 0 && <div style={{ marginTop: 10 }}><WindowPicker windows={windows} lookBack={lookBack} total={filled.winners.length} onPick={setPicked} label="Over" /></div>}
        {test ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 10 }}>
            <Stat label="Net" value={signed(test.net ?? 0)} sub={`${fmt(test.played)} of ${fmt(test.rounds)} rounds bet`} tone={(test.net ?? 0) < 0 ? 'var(--red)' : undefined} />
            <Stat label="Stopped" value={test.stoppedBy ? 'Yes' : 'No'} sub={test.stoppedBy ? stoppedText[test.stoppedBy] : 'ran to the newest result'} />
            <Stat label="Lowest point" value={signed(test.worst ?? 0)} sub="the most it was down" tone={(test.worst ?? 0) < 0 ? 'var(--red)' : undefined} />
            <Stat label="Times it ran out" value={fmt(test.ranOut)} sub={`all ${stakes.length} steps lost`} tone={test.ranOut ? 'var(--red)' : undefined} />
          </div>
        ) : (
          <p style={note}>{problem ? 'Fix the plan above to see it.' : filled.winners.length === 0 ? 'No results on this board yet.' : 'Waiting for the payout rules…'}</p>
        )}
        <p style={note}>{PAST_DOES_NOT_PREDICT}</p>
      </section>

      {error && <p role="alert" style={{ ...note, color: 'var(--red)' }}>{error}</p>}
      <button type="button" onClick={startPlan} disabled={!!problem || busy} style={{ width: '100%', height: 46, marginTop: 12, borderRadius: 12, border: 'none', background: problem ? 'var(--surface3)' : 'var(--gold-metal)', color: problem ? 'var(--text3)' : 'var(--on-gold)', fontSize: 13, fontWeight: 800, cursor: problem ? 'not-allowed' : busy ? 'wait' : 'pointer' }}>
        {busy ? 'Starting…' : `Start auto bets on ${sideName(s.side)}`}
      </button>
    </>
  );
};

export default AutoBetsSheet;
