// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * BoardsManager.tsx — the board games (owner, 2026-10-08): create any number
 * of boards, each with its own timer, switch them on and off, and set their
 * order on the players' home page.
 *
 * Server: backend/routes/admin/boards.admin.routes.js over
 * database/repositories/boards.js, which checks every field and says which one
 * is wrong; this screen shows that sentence. The interval lengths offered are
 * the server's (`intervalMinutes`), never a list kept here (§32 S25).
 *
 * A board's key and timer kind never change once created (its rounds are named
 * by them), so the form offers them on creation only. A board is switched off,
 * never deleted: its open round still finishes and settles.
 */
import React, { useEffect, useState } from 'react';
import { Plus, Save, X, ArrowUp, ArrowDown, Power } from 'lucide-react';
import toast from 'react-hot-toast';
import { boards as boardsApi } from '../../services/api';
import type { Board } from '../../types';

type Phases = Board['phases'];
interface Form {
  key?: string;
  name: string;
  kind: 'INTERVAL' | 'DAILY';
  durationMin: number;
  anchorHourIst: number;
  phases: Phases;
  minBet: number;
  maxBet: number;
}

const PHASE_FIELDS: Array<[keyof Phases, string]> = [
  ['mergeBeforeEndSec', 'Merge'],
  ['equalizerBeforeEndSec', 'Equalizer'],
  ['closeBeforeEndSec', 'Bets close'],
  ['celebrateBeforeEndSec', 'Result'],
];

// A starting point for a new board only; the server checks every value.
const BLANK: Form = {
  name: '', kind: 'INTERVAL', durationMin: 5, anchorHourIst: 18,
  phases: { mergeBeforeEndSec: 40, equalizerBeforeEndSec: 30, closeBeforeEndSec: 20, celebrateBeforeEndSec: 5 },
  minBet: 10, maxBet: 100000,
};

const inp = 'w-full bg-[#0B0E14] border border-[#1e2736] rounded-lg p-2 text-sm text-white outline-hidden focus:border-yellow-500';
const lbl = 'text-[10px] text-slate-500 uppercase font-bold mb-1 block';
const whole = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

const timerText = (b: Board) => (b.kind === 'DAILY'
  ? `Daily from ${String(b.anchorHourIst).padStart(2, '0')}:00 IST`
  : `Every ${b.durationMin} min`);

export const BoardsManager: React.FC = () => {
  const [list, setList] = useState<Board[]>([]);
  const [intervals, setIntervals] = useState<number[]>([]);
  const [editing, setEditing] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await boardsApi.list();
      setList(r.boards ?? []);
      setIntervals(r.intervalMinutes ?? []);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to load boards'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing) return;
    setError('');
    const body = {
      name: editing.name,
      durationMin: editing.durationMin,
      phases: editing.phases,
      minBet: editing.minBet,
      maxBet: editing.maxBet,
      ...(editing.kind === 'DAILY' ? { anchorHourIst: editing.anchorHourIst } : {}),
    };
    try {
      if (editing.key) await boardsApi.update(editing.key, body);
      else await boardsApi.create({ ...body, kind: editing.kind });
      toast.success(editing.key ? 'Board saved' : 'Board created');
      setEditing(null);
      load();
    } catch (e: any) {
      // The server's sentence names the field (database/repositories/boards.js).
      setError(e?.response?.data?.message || 'Save failed');
    }
  };

  const toggle = async (b: Board) => {
    try {
      await boardsApi.update(b.key, { enabled: !b.enabled });
      toast.success(b.enabled ? `${b.name} switched off` : `${b.name} switched on`);
      load();
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed'); }
  };

  const move = async (i: number, by: -1 | 1) => {
    const keys = list.map((b) => b.key);
    const j = i + by;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    try { const r = await boardsApi.setOrder(keys); setList(r.boards ?? list); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to save the order'); }
  };

  const edit = (b: Board) => {
    setError('');
    setEditing({
      key: b.key, name: b.name, kind: b.kind, durationMin: b.durationMin,
      anchorHourIst: b.anchorHourIst ?? 0, phases: { ...b.phases }, minBet: b.minBet, maxBet: b.maxBet,
    });
  };

  return (
    <div className="om-fade space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          Players see the switched-on boards in this order on the home page. A changed timer
          applies from the board&apos;s next round.
        </p>
        <button onClick={() => { setError(''); setEditing({ ...BLANK }); }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500 text-black text-sm font-bold">
          <Plus size={16} /> New board
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase text-slate-500">
              <th className="p-2">Order</th><th className="p-2">Board</th><th className="p-2">Timer</th>
              <th className="p-2">Bets close</th><th className="p-2">Stake (₹)</th><th className="p-2">Status</th><th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="p-4 text-center text-slate-500">Loading…</td></tr>}
            {!loading && list.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-slate-500">No boards yet.</td></tr>}
            {list.map((b, i) => (
              <tr key={b.key} className="border-t border-[#1e2736]">
                <td className="p-2 whitespace-nowrap">
                  <button aria-label={`Move ${b.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="p-1 disabled:opacity-30"><ArrowUp size={14} /></button>
                  <button aria-label={`Move ${b.name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)} className="p-1 disabled:opacity-30"><ArrowDown size={14} /></button>
                </td>
                <td className="p-2"><div className="font-semibold text-white">{b.name}</div><div className="text-[10px] text-slate-500">{b.key}</div></td>
                <td className="p-2">{timerText(b)}</td>
                <td className="p-2">{b.phases.closeBeforeEndSec}s before the end</td>
                <td className="p-2">{b.minBet.toLocaleString('en-IN')} – {b.maxBet.toLocaleString('en-IN')}</td>
                <td className="p-2">
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${b.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'}`}>
                    {b.enabled ? 'On' : 'Off'}
                  </span>
                </td>
                <td className="p-2 whitespace-nowrap text-right">
                  <button onClick={() => edit(b)} className="px-2 py-1 text-xs rounded border border-[#1e2736] mr-2">Edit</button>
                  <button onClick={() => toggle(b)} aria-label={b.enabled ? `Switch ${b.name} off` : `Switch ${b.name} on`}
                    className="px-2 py-1 text-xs rounded border border-[#1e2736] inline-flex items-center gap-1">
                    <Power size={12} /> {b.enabled ? 'Switch off' : 'Switch on'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-xl bg-[#121722] border border-[#1e2736] p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">{editing.key ? `Edit ${editing.name}` : 'New board'}</h3>
              <button aria-label="Close" onClick={() => setEditing(null)}><X size={18} /></button>
            </div>

            <div>
              <label className={lbl} htmlFor="board-name">Name</label>
              <input id="board-name" className={inp} value={editing.name} maxLength={40}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl} htmlFor="board-kind">Timer</label>
                <select id="board-kind" className={inp} value={editing.kind} disabled={!!editing.key}
                  onChange={(e) => {
                    const kind = e.target.value as Form['kind'];
                    setEditing({ ...editing, kind, durationMin: kind === 'DAILY' ? 1440 : (intervals[0] ?? 1) });
                  }}>
                  <option value="INTERVAL">Repeating</option>
                  <option value="DAILY">Once a day</option>
                </select>
              </div>
              {editing.kind === 'INTERVAL' ? (
                <div>
                  <label className={lbl} htmlFor="board-duration">Round length</label>
                  <select id="board-duration" className={inp} value={editing.durationMin}
                    onChange={(e) => setEditing({ ...editing, durationMin: Number(e.target.value) })}>
                    {intervals.map((m) => <option key={m} value={m}>{m} min</option>)}
                  </select>
                </div>
              ) : (
                <div>
                  <label className={lbl} htmlFor="board-anchor">Starts at (IST)</label>
                  <select id="board-anchor" className={inp} value={editing.anchorHourIst}
                    onChange={(e) => setEditing({ ...editing, anchorHourIst: Number(e.target.value) })}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                  </select>
                </div>
              )}
            </div>

            <div>
              <span className={lbl}>Phases (seconds before the round ends)</span>
              <div className="grid grid-cols-4 gap-2">
                {PHASE_FIELDS.map(([field, name]) => (
                  <div key={field}>
                    <label className="text-xs text-slate-400" htmlFor={`board-${field}`}>{name}</label>
                    <input id={`board-${field}`} type="number" min={0} step={1} className={inp}
                      value={editing.phases[field]}
                      onChange={(e) => setEditing({ ...editing, phases: { ...editing.phases, [field]: whole(e.target.value) } })} />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-1">Each must be earlier than the last: merge, then equalizer, then bets close, then the result.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={lbl} htmlFor="board-min">Minimum bet (₹)</label>
                <input id="board-min" type="number" min={1} className={inp} value={editing.minBet}
                  onChange={(e) => setEditing({ ...editing, minBet: whole(e.target.value) })} />
              </div>
              <div>
                <label className={lbl} htmlFor="board-max">Maximum bet (₹)</label>
                <input id="board-max" type="number" min={1} className={inp} value={editing.maxBet}
                  onChange={(e) => setEditing({ ...editing, maxBet: whole(e.target.value) })} />
              </div>
            </div>

            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-3 py-2 rounded-lg border border-[#1e2736] text-sm">Cancel</button>
              <button onClick={save} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500 text-black text-sm font-bold">
                <Save size={16} /> {editing.key ? 'Save board' : 'Create board'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BoardsManager;
