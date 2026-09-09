// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The USDT rail, from the operator's side.
 *
 * ── The one failure nothing automatic can fix ──────────────────────────────
 * A player sends USDT, BTCPay confirms it, and the credit does not happen —
 * because the supply cap refused the mint, or the process died between the
 * settle and the wallet write. The row is left SETTLED with no `creditedAt`.
 *
 * That state exists precisely so a PERSON can find it. Without this screen it
 * is invisible until the player complains: no error, no red test, no stack
 * trace — the same shape as the five dead admin buttons this codebase shipped
 * while every check was green. So the uncredited queue is the first thing here,
 * and it is loud when it is not empty.
 *
 * ── Reconcile READS, it does not credit ────────────────────────────────────
 * "What does BTCPay say?" is the only way to tell a dropped webhook from a
 * player who never paid. It asks the payment processor and reports whether the
 * two agree. It does not move money: crediting from an admin click would be a
 * second money path beside the webhook, and two paths for one credit is exactly
 * how `moveDepositMoney` came to exist.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle, Search } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface UsdtDeposit {
  depositId: string;
  userId: string;
  invoiceId: string | null;
  tokenAmount: number;
  usdtAmount: number | null;
  usdtRateInr: number | null;
  state: string;
  settledAt?: string | null;
  creditedAt?: string | null;
  failureReason?: string | null;
  createdAt?: string;
}

const STATES = ['', 'AWAITING_PAYMENT', 'PROCESSING', 'SETTLED', 'EXPIRED', 'INVALID'];

const STATE_CLASS: Record<string, string> = {
  AWAITING_PAYMENT: 'text-gray-400',
  PROCESSING: 'text-yellow-400',
  SETTLED: 'text-green-400',
  EXPIRED: 'text-gray-500',
  INVALID: 'text-red-400',
};

export const UsdtDepositsPanel: React.FC = () => {
  const [deposits, setDeposits] = useState<UsdtDeposit[]>([]);
  const [uncredited, setUncredited] = useState<UsdtDeposit[]>([]);
  const [state, setState] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, owed] = await Promise.all([
        // The path is a literal and the filter is a param. Interpolating into
        // the path itself hides the route from `check:ui-coverage`, which reads
        // panel call sites as text — and a call the gate cannot see is a call
        // nothing proves reaches a route.
        api.get('/api/admin/usdt-deposits', { params: state ? { state } : {} }),
        api.get('/api/admin/usdt-deposits/uncredited'),
      ]);
      setDeposits(all.data?.deposits || []);
      setUncredited(owed.data?.deposits || []);
    } catch {
      // Said out loud. A caught error that renders an empty list is
      // indistinguishable from "no USDT deposits", and on this screen that
      // reads as "nobody is owed money".
      toast.error('Failed to load USDT deposits');
    } finally { setLoading(false); }
  }, [state]);

  useEffect(() => { load(); }, [load]);

  const reconcile = async (depositId: string) => {
    setChecking(depositId);
    try {
      const r = await api.get(`/api/admin/usdt-deposits/${depositId}/invoice`);
      const { invoice, agrees } = r.data || {};
      if (invoice === null) toast('No invoice was ever created for this deposit.');
      else if (agrees) toast.success(`BTCPay agrees: ${invoice.status}`);
      else toast.error(`BTCPay says ${invoice.status} — this row disagrees. A callback was lost.`);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Could not reach BTCPay');
    } finally { setChecking(null); }
  };

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold flex items-center gap-2">USDT Deposits</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Purchases above the INR ceiling, paid to the platform through BTCPay Server. No merchant is party to one.
          </p>
        </div>
        <div className="flex gap-2">
          <select value={state} onChange={(e) => setState(e.target.value)} className="input text-sm">
            {STATES.map((s) => <option key={s || 'all'} value={s}>{s || 'All states'}</option>)}
          </select>
          <button onClick={load} className="btn-secondary flex items-center gap-2">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh
          </button>
        </div>
      </div>

      {/* Paid, and not credited. This list must be empty. */}
      {uncredited.length > 0 && (
        <div className="border border-red-500/40 bg-red-500/5 rounded-xl p-4">
          <h4 className="font-semibold text-red-400 flex items-center gap-2 mb-2">
            <AlertTriangle size={16} />
            {uncredited.length} player{uncredited.length === 1 ? ' has' : 's have'} paid and been credited nothing
          </h4>
          <p className="text-xs text-gray-400 mb-3">
            The invoice settled and the wallet did not move — the supply cap refused the mint, or the process
            stopped between the two. These are owed.
          </p>
          <div className="space-y-1">
            {uncredited.map((d) => (
              <div key={d.depositId} className="flex items-center justify-between text-sm font-mono">
                <span className="text-gray-300">{d.depositId}</span>
                <span className="text-gray-400">user {String(d.userId).slice(-8)}</span>
                <span className="text-white">{Number(d.tokenAmount).toLocaleString('en-IN')} tokens</span>
                <span className="text-gray-500">{d.settledAt ? new Date(d.settledAt).toLocaleString() : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!loading && uncredited.length === 0 && (
        <div className="text-xs text-green-400 flex items-center gap-2">
          <CheckCircle size={14} />Every settled USDT deposit has been credited.
        </div>
      )}

      {deposits.length === 0 && !loading ? (
        <p className="text-sm text-gray-500">No USDT deposits{state ? ` in ${state}` : ''}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-gray-400 text-xs uppercase">
              <tr>
                <th className="text-left py-2">Deposit</th>
                <th className="text-left">Player</th>
                <th className="text-right">Tokens</th>
                <th className="text-right">USDT</th>
                <th className="text-right">Rate</th>
                <th className="text-left pl-4">State</th>
                <th className="text-left">Credited</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.depositId} className="border-t border-dark-700">
                  <td className="py-2 font-mono text-xs text-gray-300">{d.depositId.slice(-12)}</td>
                  <td className="font-mono text-xs text-gray-400">{String(d.userId).slice(-8)}</td>
                  <td className="text-right">{Number(d.tokenAmount).toLocaleString('en-IN')}</td>
                  <td className="text-right">{d.usdtAmount ?? '—'}</td>
                  <td className="text-right text-gray-400">
                    {d.usdtRateInr ? `₹${d.usdtRateInr}` : '—'}
                  </td>
                  <td className={`pl-4 font-medium ${STATE_CLASS[d.state] ?? ''}`}>{d.state}</td>
                  <td className="text-xs text-gray-400">
                    {d.creditedAt ? new Date(d.creditedAt).toLocaleString() : '—'}
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => reconcile(d.depositId)}
                      disabled={checking === d.depositId}
                      className="btn-secondary text-xs flex items-center gap-1"
                      title="Ask BTCPay what it thinks. Reads only — it moves no money."
                    >
                      <Search size={12} />{checking === d.depositId ? 'Checking…' : 'Reconcile'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default UsdtDepositsPanel;
