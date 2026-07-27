// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Eye, RefreshCw, Gift, Copy } from 'lucide-react';
import api from '../../services/api';
import { Kpis, Toolbar } from '../../components/design';
import toast from 'react-hot-toast';

export const GiftCodes: React.FC = () => {
  const [codes, setCodes] = useState<any[]>([]);
  const [form, setForm] = useState({ code:'', amount:'', bonusType:'DEPOSIT_BALANCE', maxUses:'1', expiresAt:'', note:'' });
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => { setLoading(true); try { const r = await api.get('/api/admin/giftcodes'); if(r.data.success) setCodes(r.data.codes); } catch{} finally{setLoading(false)}; };
  useEffect(() => { load(); }, []);

  const generate = () => setForm(f => ({ ...f, code: Math.random().toString(36).slice(2,10).toUpperCase() }));

  const create = async () => {
    if (!form.code || !form.amount) return toast.error('Code and amount required');
    try {
      const r = await api.post('/api/admin/giftcodes', { ...form, amount: Number(form.amount), maxUses: Number(form.maxUses) });
      if (r.data.success) { toast.success('Gift code created!'); setShowForm(false); setForm({code:'',amount:'',bonusType:'DEPOSIT_BALANCE',maxUses:'1',expiresAt:'',note:''}); load(); }
    } catch (e:any) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this code?')) return;
    await api.delete(`/api/admin/giftcodes/${id}`);
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
      <Toolbar actions={[
        { label: 'Refresh', icon: RefreshCw, onClick: load },
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
                <td className="text-center"><span className={`px-2 py-0.5 rounded text-xs ${c.isActive && (!c.expiresAt||new Date(c.expiresAt)>new Date()) && c.usedCount<c.maxUses ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{c.isActive&&c.usedCount<c.maxUses?'Active':'Exhausted'}</span></td>
                <td className="text-center"><button onClick={() => del(c._id)} className="text-red-400 hover:text-red-300"><Trash2 size={14}/></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {codes.length === 0 && !loading && <div className="text-center py-10 text-gray-500"><Gift size={40} className="mx-auto mb-2 opacity-30"/>No gift codes yet</div>}
      </div>
    </div>
  );
};
