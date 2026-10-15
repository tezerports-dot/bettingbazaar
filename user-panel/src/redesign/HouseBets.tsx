// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * House bets on the board screen (owner, 2026-10-15).
 *
 * `HouseBetsNote`: the line beside the pool totals saying they include house
 * bets that are never paid out. The wording is the server's
 * (`SystemConfig.houseBetsLabel`, sent never blank by systemConfigPayload.js);
 * the panel keeps no copy.
 *
 * `AutoHouseBetsPanel`: a phantom agent's auto plan for this board, one per
 * side: a list of sizes bet one a second, in order and looped, until the
 * equalizer (backend/domains/markets/houseBets.js). Shown in ghost mode only.
 * The limits come with the plans (`GET /api/bet/phantom/auto`).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { player } from '../services/api';
import { getBackend } from '../services/backend.service';

/** The house-bets line, as the server says it; nothing until it has arrived. */
export function useHouseBetsLabel(): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    let live = true;
    getBackend().getSystemConfig()
      .then((c) => { if (live && typeof c.houseBetsLabel === 'string') setLabel(c.houseBetsLabel); })
      .catch(() => { /* the line appears once the config arrives */ });
    return () => { live = false; };
  }, []);
  return label;
}

export const HouseBetsNote: React.FC<{ label: string; style?: React.CSSProperties }> = ({ label, style }) => (
  label ? <div style={{ fontSize: 10, lineHeight: 1.4, color: 'var(--text3)', ...style }}>ⓘ {label}</div> : null
);

type Side = 'DELHI' | 'BOMBAY';
const SIDES: { side: Side; name: string }[] = [{ side: 'DELHI', name: 'Delhi' }, { side: 'BOMBAY', name: 'Bombay' }];

interface Plan { boardKey: string; side: Side; amounts: number[]; enabled: boolean }
interface Limits { maxSteps: number; minRupees: number; maxRupees: number }

/** "100, 250 50" → [100, 250, 50]; anything that is not a whole number is kept as NaN for the server to name. */
const parseSizes = (text: string): number[] =>
  text.split(/[\s,]+/).filter(Boolean).map((t) => (/^\d+$/.test(t) ? Number(t) : NaN));

const SideEditor: React.FC<{
  boardKey: string; side: Side; name: string; plan?: Plan; limits: Limits | null; onSaved: (p: Plan) => void;
}> = ({ boardKey, side, name, plan, limits, onSaved }) => {
  const [text, setText] = useState(plan ? plan.amounts.join(', ') : '');
  const [enabled, setEnabled] = useState(plan?.enabled ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => { setText(plan ? plan.amounts.join(', ') : ''); setEnabled(plan?.enabled ?? false); }, [plan]);

  const sizes = parseSizes(text);
  const save = async (nextEnabled: boolean) => {
    setError(''); setSaved('');
    if (sizes.length === 0) { setError('Type at least one bet size.'); return; }
    if (sizes.some((n) => !Number.isFinite(n))) { setError('Sizes are whole rupees, separated by commas or spaces.'); return; }
    setSaving(true);
    try {
      const res: any = await player.saveAutoHouseBets({ boardKey, side, amounts: sizes, enabled: nextEnabled });
      if (!res?.success) throw new Error(res?.message);
      setEnabled(res.plan.enabled);
      onSaved(res.plan);
      setSaved(res.plan.enabled ? 'Running: one bet a second from the next second.' : 'Stopped.');
    } catch (e: any) {
      setError(e?.message || 'Could not save this plan.');
    } finally {
      setSaving(false);
    }
  };

  const id = `auto-${boardKey}-${side}`;
  return (
    <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={id} style={{ fontSize: 11, fontWeight: 800, color: '#c4b5fd' }}>
        {name} · {enabled ? 'ON' : 'OFF'}
      </label>
      <textarea id={id} rows={2} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="e.g. 100, 250, 50, 500"
        style={{ width: '100%', resize: 'vertical', background: 'var(--surface2)', border: '1px solid rgba(139,111,224,.35)', borderRadius: 10, padding: '8px 10px', color: 'var(--text)', fontSize: 12, fontWeight: 600 }} />
      <div style={{ fontSize: 10, color: 'var(--text3)' }}>
        {sizes.length} {sizes.length === 1 ? 'size' : 'sizes'}
        {limits ? ` of at most ${limits.maxSteps.toLocaleString('en-IN')}` : ''} · one a second, looped, until the equalizer
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" disabled={saving} onClick={() => save(true)}
          style={{ flex: 1, height: 32, borderRadius: 9, border: 'none', cursor: saving ? 'wait' : 'pointer', fontSize: 11, fontWeight: 800, background: 'rgba(139,111,224,.85)', color: '#fff' }}>
          {enabled ? 'Save and keep running' : 'Start'}
        </button>
        {enabled && (
          <button type="button" disabled={saving} onClick={() => save(false)}
            style={{ height: 32, padding: '0 12px', borderRadius: 9, border: '1px solid var(--line2)', cursor: saving ? 'wait' : 'pointer', fontSize: 11, fontWeight: 800, background: 'var(--surface2)', color: 'var(--text2)' }}>
            Stop
          </button>
        )}
      </div>
      {error && <div role="alert" style={{ fontSize: 11, color: 'var(--danger, #f87171)' }}>{error}</div>}
      {saved && <div role="status" style={{ fontSize: 11, color: '#c4b5fd' }}>{saved}</div>}
    </div>
  );
};

export const AutoHouseBetsPanel: React.FC<{ boardKey: string; boardName: string }> = ({ boardKey, boardName }) => {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const res: any = await player.autoHouseBets();
      if (!res?.success) throw new Error(res?.message);
      setPlans(res.plans || []);
      setLimits(res.limits || null);
    } catch (e: any) {
      setError(e?.message || 'Could not load your auto bets.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onSaved = (p: Plan) => setPlans((all) => [...all.filter((x) => !(x.boardKey === p.boardKey && x.side === p.side)), p]);
  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: 14, border: '1px solid rgba(139,111,224,.28)', background: 'rgba(139,111,224,.07)' }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', color: '#c4b5fd', marginBottom: 8 }}>
        👻 AUTO HOUSE BETS · {boardName}
      </div>
      {error ? (
        <div role="alert" style={{ fontSize: 11, color: 'var(--danger, #f87171)' }}>
          {error} <button type="button" onClick={load} style={{ border: 'none', background: 'none', color: '#c4b5fd', fontWeight: 800, cursor: 'pointer' }}>Retry</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {SIDES.map(({ side, name }) => (
            <SideEditor key={`${boardKey}-${side}`} boardKey={boardKey} side={side} name={name} limits={limits}
              plan={plans.find((p) => p.boardKey === boardKey && p.side === side)} onSaved={onSaved} />
          ))}
        </div>
      )}
    </div>
  );
};
