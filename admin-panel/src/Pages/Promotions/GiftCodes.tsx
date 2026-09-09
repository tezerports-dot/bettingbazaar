// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Gift codes, and the two things that happen after one is redeemed.
 *
 * `/admin/giftcodes/unpaid` finds redemptions with NO matching wallet_ledger
 * row: a player who redeemed a code and was never actually credited. That is
 * money owed, and until this panel existed nothing on any screen could show it
 * — the operator would only learn of it from the player. It is rendered first,
 * loudly, because a quiet list of debts is not a control.
 *
 * `/admin/giftcodes/:code/redemptions` is who used a given code. Both endpoints
 * were built and unreachable.
 */
import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Eye, RefreshCw, Gift, Copy, AlertTriangle } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import { Kpis, Toolbar } from '../../components/design';
import toast from 'react-hot-toast';

interface Redemption {
  id: number; code: string; userId: string;
  amount: number; amountPaise: number; redeemedAt: string; txId: string;
}

export const GiftCodes: React.FC = () => {
  const [codes, setCodes] = useState<any[]>([]);
  const [form, setForm] = useState({ code:'', amount:'', bonusType:'DEPOSIT_BALANCE', maxUses:'1', expiresAt:'', note:'' });
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unpaid, setUnpaid] = useState<Redemption[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);

  // These live under /api/giftcode (routes/giftcode.routes.js is mounted there),
  // not /api/admin — the router simply happens to declare admin-only paths.
  // The panel called /api/admin/giftcodes until 2026-08-24, so listing,
  // creating and deleting gift codes all 404'd.
  const load = async () => { setLoading(true); try { const r = await api.get('/api/giftcode/admin/giftcodes'); if(r.data.success) setCodes(r.data.codes); } catch{} finally{setLoading(false)}; };
  /** Redemptions the ledger has no credit for — money the platform owes. */
  const loadUnpaid = async () => {
    try {
      const r = await api.get<any>('/api/giftcode/admin/giftcodes/unpaid');
      if (r.data?.success) setUnpaid(r.data.unpaid || []);
    } catch { /* the panel simply does not render */ }
  };

  const viewRedemptions = async (code: string) => {
    setViewing(code); setRedemptions([]); setRedemptionsLoading(true);
    try {
      const r = await api.get<any>(`/api/giftcode/admin/giftcodes/${encodeURIComponent(code)}/redemptions`);
      setRedemptions(r.data?.redemptions || []);
    } catch { toast.error('Failed to load redemptions'); }
    finally { setRedemptionsLoading(false); }
  };

  useEffect(() => { load(); loadUnpaid(); }, []);

  const generate = () => setForm(f => ({ ...f, code: Math.random().toString(36).slice(2,10).toUpperCase() }));

  const create = async () => {
    if (!form.code || !form.amount) return toast.error('Code and amount required');
    try {
      const r = await api.post('/api/giftcode/admin/giftcodes', { ...form, amount: Number(form.amount), maxUses: Number(form.maxUses) });
      if (r.data.success) { toast.success('Gift code created!'); setShowForm(false); setForm({code:'',amount:'',bonusType:'DEPOSIT_BALANCE',maxUses:'1',expiresAt:'',note:''}); load(); }
    } catch (e:any) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this code?')) return;
    await api.delete(`/api/giftcode/admin/giftcodes/${id}`);
    load(); toast.success('Deleted');
  };

  const copy = (code: string) => { navigator.clipboard.writeText(code); toast.success('Copied!'); };

  return (
    <div className="om-fade space-y-6">
      <Kpis min={200} items={[
        { label: 'Total Codes', value: codes.length },
        { label: 'Active', value: codes.filter((c) => c.isActive && c.usedCount < c.maxUses).length, tone: 'var(--success)' },
        { label: 'Redeemed', value: codes.reduce((s, c) => s + (c.usedCount || 0), 0) },
      ]} />
      {unpaid.length > 0 && (
        <div className="card border border-red-500/40 bg-red-500/5 space-y-3">
          <div className="flex items-center gap-2 text-red-400 font-semibold">
            <AlertTriangle size={16} />
            {unpaid.length} redemption{unpaid.length === 1 ? '' : 's'} with no matching ledger credit
          </div>
          <p className="text-xs text-gray-400">
            The player redeemed the code and the tokens never landed. Each row is money owed —
            the ledger is the authority, so a redemption without an entry was never paid.
          </p>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {unpaid.map(u => (
              <div key={u.id} className="flex items-center justify-between bg-dark-800 rounded-lg px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="font-mono font-bold text-yellow-400">{u.code}</span>
                  <span className="text-gray-400 ml-3">player {u.userId}</span>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-semibold text-red-300">{formatters.currency(u.amount)}</p>
                  <p className="text-xs text-gray-500">{formatters.datetime(u.redeemedAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Toolbar actions={[
        { label: 'Refresh', icon: RefreshCw, onClick: () => { load(); loadUnpaid(); } },
        { label: 'New Code', icon: Plus, primary: true, onClick: () => setShowForm(true) },
      ]} />

      {showForm && (
        <div className="card space-y-4 border border-yellow-500/30">
          <h3 className="font-semibold">Create Gift Code</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Code</label>
              <div className="flex gap-2">
                <input value={form.code} onChange={e=>setForm(f=>({...f,code:e.target.value.toUpperCase()}))} className="flex-1 input" placeholder="SUMMER25"/>
                <button onClick={generate} className="btn-secondary text-xs">Auto</button>
              </div>
            </div>
            <div><label className="text-xs text-gray-400 mb-1 block">Amount (₹)</label><input type="number" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} className="input w-full" placeholder="100"/></div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Credits to</label>
              <select value={form.bonusType} onChange={e=>setForm(f=>({...f,bonusType:e.target.value}))} className="input w-full">
                <option value="DEPOSIT_BALANCE">Deposit Balance</option>
                <option value="WINNINGS_BALANCE">Winnings Balance</option>
                <option value="TOKENS">Tokens</option>
              </select>
            </div>
            <div><label className="text-xs text-gray-400 mb-1 block">Max Uses</label><input type="number" value={form.maxUses} onChange={e=>setForm(f=>({...f,maxUses:e.target.value}))} className="input w-full" placeholder="1"/></div>
            <div><label className="text-xs text-gray-400 mb-1 block">Expires At (optional)</label><input type="datetime-local" value={form.expiresAt} onChange={e=>setForm(f=>({...f,expiresAt:e.target.value}))} className="input w-full"/></div>
            <div><label className="text-xs text-gray-400 mb-1 block">Note (internal)</label><input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} className="input w-full" placeholder="e.g. Diwali promotion"/></div>
          </div>
          <div className="flex gap-3">
            <button onClick={create} className="btn-primary">Create Code</button>
            <button onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-dark-600 text-gray-400 text-xs">
            <th className="text-left py-2">Code</th><th>Amount</th><th>Type</th><th>Uses</th><th>Expires</th><th>Status</th><th>Actions</th>
          </tr></thead>
          <tbody>
            {codes.map(c => (
              <tr key={c._id} className="border-b border-dark-700">
                <td className="py-3 flex items-center gap-2">
                  <Gift size={14} className="text-yellow-400"/>
                  <span className="font-mono font-bold">{c.code}</span>
                  <button onClick={() => copy(c.code)} className="text-gray-500 hover:text-white"><Copy size={12}/></button>
                </td>
                <td className="text-center text-green-400 font-semibold">₹{c.amount}</td>
                <td className="text-center text-xs text-gray-400">{c.bonusType.replace('_',' ')}</td>
                <td className="text-center">{c.usedCount}/{c.maxUses}</td>
                <td className="text-center text-xs text-gray-400">{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : '—'}</td>
                <td className="text-center"><span className={`px-2 py-0.5 rounded-sm text-xs ${c.isActive && (!c.expiresAt||new Date(c.expiresAt)>new Date()) && c.usedCount<c.maxUses ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{c.isActive&&c.usedCount<c.maxUses?'Active':'Exhausted'}</span></td>
                <td className="text-center">
                  <div className="flex items-center justify-center gap-3">
                    <button onClick={() => viewRedemptions(c.code)} title="Who redeemed this" className="text-gray-400 hover:text-white"><Eye size={14}/></button>
                    <button onClick={() => del(c._id)} className="text-red-400 hover:text-red-300"><Trash2 size={14}/></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {codes.length === 0 && !loading && <div className="text-center py-10 text-gray-500"><Gift size={40} className="mx-auto mb-2 opacity-30"/>No gift codes yet</div>}
      </div>

      {viewing && (
        <Modal isOpen onClose={() => setViewing(null)} title={`Redemptions — ${viewing}`} size="lg">
          {redemptionsLoading ? (
            <p className="text-sm text-gray-400 py-6 text-center">Loading…</p>
          ) : redemptions.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">Nobody has redeemed this code.</p>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {redemptions.map(r => (
                <div key={r.id} className="flex items-center justify-between bg-dark-700 rounded-lg px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="text-gray-200">player {r.userId}</p>
                    {/* The idempotency key the credit was written under — what an
                        operator needs to find the ledger entry, or prove it is absent. */}
                    <p className="text-xs text-gray-500 font-mono truncate">{r.txId}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-semibold text-green-400">{formatters.currency(r.amount)}</p>
                    <p className="text-xs text-gray-500">{formatters.datetime(r.redeemedAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
};
