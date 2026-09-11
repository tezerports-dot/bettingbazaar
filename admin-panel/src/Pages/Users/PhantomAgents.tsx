// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Phantom agents — every account that can place cosmetic bets, in one place.
 *
 * ── Why the roster needed a screen ─────────────────────────────────────────
 * Granting phantom access already had one: a button on each row of the Users
 * list. Reading it back had none. `GET /api/admin/phantom-agents` was served
 * and called by nothing, so the only way to answer "who can do this?" was to
 * page through every player looking at badges — which is to say it was not
 * answerable, and an access grant nobody can enumerate is one nobody revokes.
 * CLAUDE.md §28: built, merged, unreachable.
 *
 * ── What a grant is ────────────────────────────────────────────────────────
 * Phantom bets are display-only. They never win, never touch a real pool and
 * never move money — the phantom figures are the only pool numbers stored on
 * the cycle row at all (trap 4). So this is not a money permission. It is the
 * ability to move what players SEE, which is why it is scoped per cycle type:
 * an agent balancing the 1-minute board has no business on the full-day one.
 *
 * The grant path is the same route the Users list uses. One writer, two
 * callers — not a second way to set the field.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Ghost, RefreshCw, ShieldOff } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { Modal } from '../../components/Modal';
import { EmptyState } from '../../components/EmptyState';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { formatters } from '../../utils/formatters';
import type { CycleType } from '../../types';

/** Only the fields this screen renders, from the shared user mapper. */
interface PhantomAgent {
  userId: string;
  username: string;
  mobile: string;
  status: string;
  phantomAccess: CycleType | 'BOTH' | 'NONE';
  lastLogin: string | null;
}

/**
 * The levels the route accepts. It derives its own list from CYCLE_TYPE_VALUES
 * (`['NONE', ...CYCLE_TYPE_VALUES, 'BOTH']`) precisely so a new board is not
 * silently rejected — this is the frontend mirror of that, and §5 wants the
 * citation: backend/routes/admin/users.admin.routes.js, the `validLevels`
 * array, over CYCLE_TYPE_VALUES in domains/markets/cycleTypes.js. Adding a
 * cycle type means adding it here too (CLAUDE.md §18.2 item 5).
 */
const LEVELS: Array<{ value: string; label: string }> = [
  { value: 'NONE',     label: 'NONE — no phantom betting' },
  { value: '1_MIN',    label: '1_MIN — 1-minute cycles only' },
  { value: '30_MIN',   label: '30_MIN — 30-minute cycles only' },
  { value: 'FULL_DAY', label: 'FULL_DAY — full-day cycles only' },
  { value: 'BOTH',     label: 'BOTH — every cycle type' },
];

const LEVEL_CLASS: Record<string, string> = {
  BOTH:     'bg-yellow-500/20 text-yellow-400',
  '1_MIN':  'bg-blue-500/20 text-blue-400',
  '30_MIN': 'bg-blue-500/20 text-blue-400',
  FULL_DAY: 'bg-blue-500/20 text-blue-400',
};

const when = (ts: string | null) => {
  if (!ts) return 'never';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return String(ts); }
};

export const PhantomAgents: React.FC = () => {
  const [agents, setAgents] = useState<PhantomAgent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState<PhantomAgent | null>(null);
  const [level, setLevel] = useState('NONE');
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.subAdmins.listPhantomAgents();
      setAgents(res?.agents || []);
    } catch {
      toast.error('Failed to load phantom agents');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!editing) return;
    setIsSaving(true);
    try {
      await api.subAdmins.assignPhantomAccess(editing.userId, level as any);
      toast.success(
        level === 'NONE'
          ? `Phantom access revoked from ${editing.username}`
          : `${editing.username} set to ${level}`,
      );
      setEditing(null);
      // Setting NONE removes the row from this list entirely — the roster is
      // "phantom_access <> NONE" — so reload rather than patching state, or a
      // revoked agent would sit here looking granted until the next visit.
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Could not change phantom access');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
          <div className="flex items-center gap-2">
            <Ghost size={17} className="text-yellow-500" />
            <h2 className="text-base font-semibold">Accounts with phantom access</h2>
          </div>
          <button onClick={() => void load()} className="p-1.5 rounded-lg hover:bg-dark-700" aria-label="Refresh">
            <RefreshCw size={15} className="text-gray-400" />
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Phantom bets are cosmetic: they never win, never affect a real pool and
          never move money. They shape what players see on a board. Access is
          scoped to a cycle type on purpose — grant the narrowest one that does
          the job. New grants are made from the Users list; this is where you
          read them back and take them away.
        </p>

        {agents.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            <span className="text-xs px-2.5 py-1 rounded-lg bg-dark-700 text-gray-300">
              {agents.length} account{agents.length === 1 ? '' : 's'} with access
            </span>
            {agents.some((a) => a.phantomAccess === 'BOTH') && (
              <span className="text-xs px-2.5 py-1 rounded-lg bg-dark-700 text-yellow-400">
                {agents.filter((a) => a.phantomAccess === 'BOTH').length} on every cycle type
              </span>
            )}
          </div>
        )}

        {isLoading ? (
          <LoadingSpinner />
        ) : agents.length === 0 ? (
          <EmptyState
            icon={ShieldOff}
            title="Nobody has phantom access"
            description="No account can place cosmetic bets. Grant access from a player's row on the Users list."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-dark-600">
                  <th className="py-2 pr-3 font-medium">Account</th>
                  <th className="py-2 pr-3 font-medium">Mobile</th>
                  <th className="py-2 pr-3 font-medium">Scope</th>
                  <th className="py-2 pr-3 font-medium">Account status</th>
                  <th className="py-2 pr-3 font-medium">Last login</th>
                  <th className="py-2 font-medium text-right">Change</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.userId} className="border-b border-dark-700 last:border-0">
                    <td className="py-2.5 pr-3 font-medium">{a.username}</td>
                    <td className="py-2.5 pr-3 text-gray-400">{formatters.phone(a.mobile)}</td>
                    <td className="py-2.5 pr-3">
                      <span className={`text-xs px-2 py-0.5 rounded-lg ${LEVEL_CLASS[a.phantomAccess] || 'bg-gray-500/20 text-gray-400'}`}>
                        {a.phantomAccess}
                      </span>
                    </td>
                    {/* A blocked account keeping phantom access is not a bug,
                        but it is worth seeing: the grant outlives the block. */}
                    <td className="py-2.5 pr-3 text-xs text-gray-400">{a.status}</td>
                    <td className="py-2.5 pr-3 text-xs text-gray-500">{when(a.lastLogin)}</td>
                    <td className="py-2.5 text-right">
                      <button
                        onClick={() => { setEditing(a); setLevel(a.phantomAccess); }}
                        className="text-xs px-2.5 py-1 rounded-lg bg-dark-700 hover:bg-dark-600 text-yellow-400"
                      >
                        Change scope
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <Modal isOpen onClose={() => setEditing(null)} title="Phantom access">
          <div className="space-y-4">
            <div className="bg-dark-700 rounded-lg p-4 text-sm">
              <p className="text-gray-400">Account</p>
              <p className="font-semibold">{editing.username} — {formatters.phone(editing.mobile)}</p>
              <p className="text-xs text-gray-500 mt-1">Currently: {editing.phantomAccess}</p>
            </div>
            <div>
              <label className="label">Scope</label>
              <select value={level} onChange={(e) => setLevel(e.target.value)} className="input">
                {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <p className="text-xs text-yellow-400">
              NONE removes the account from this list. Phantom bets never win and
              never touch a real pool.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setEditing(null)} className="flex-1 btn-secondary">Cancel</button>
              <button
                onClick={() => void save()}
                disabled={isSaving || level === editing.phantomAccess}
                className="flex-1 btn-primary disabled:opacity-50"
              >
                {isSaving ? 'Saving…' : 'Save scope'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default PhantomAgents;
