// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { PlusCircle, MinusCircle, RefreshCw, Search } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

export const BalanceAdjustment: React.FC = () => {
  const [form, setForm] = useState({ userId:'', type:'CREDIT', field:'depositBalance', amount:'', reason:'' });
  const [history, setHistory] = useState<any[]>([]);
  const [processing, setProcessing] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [selectedUser, setSelectedUser] = useState<any>(null);

  const loadHistory = async () => { try { const r = await api.get('/api/admin/balance-adjustments'); if(r.data.success) setHistory(r.data.adjustments); } catch{}; };
  useEffect(() => { loadHistory(); }, []);

  const searchUsers = async () => {
    if (!userSearch) return;
    try { const r = await api.get(`/api/admin/users?search=${userSearch}&limit=10`); if(r.data.success) setUsers(r.data.users||r.data.data||[]); }
    catch {}
  };

  const selectUser = (u: any) => { setSelectedUser(u); setForm(f => ({...f, userId: u._id})); setUsers([]); setUserSearch(''); };

  const submit = async () => {
    if (!form.userId || !form.amount || !form.reason) return toast.error('All fields required');
    setProcessing(true);
    try {
      const r = await api.post('/api/admin/balance-adjust', form);
      if (r.data.success) { toast.success(r.data.message); setForm(f => ({...f, amount:'', reason:''})); loadHistory(); }
      else toast.error(r.data.message);
    } catch (e:any) { toast.error(e.response?.data?.message||'Error'); } finally { setProcessing(false); }
  };

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold">Balance Adjustment</h1><p className="text-gray-400 text-sm">Manually credit or debit any user's balance with a reason</p></div>

      <div className="card space-y-4">
        <h3 className="font-semibold">New Adjustment</h3>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Search User</label>
          <div className="flex gap-2">
            <input value={userSearch} onChange={e=>setUserSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&searchUsers()} className="flex-1 input" placeholder="Username or mobile..."/>
            <button onClick={searchUsers} className="btn-secondary"><Search size={14}/></button>
          </div>
          {selectedUser&&<div className="mt-2 p-2 bg-green-500/10 border border-green-500/30 rounded text-sm text-green-400">Selected: {selectedUser.username} ({selectedUser.mobile})</div>}
          {users.length>0&&(
            <div className="mt-2 bg-dark-700 rounded-lg border border-dark-600 overflow-hidden">
              {users.map(u=><button key={u._id} onClick={()=>selectUser(u)} className="w-full text-left px-3 py-2 hover:bg-dark-600 text-sm border-b border-dark-600 last:border-0">{u.username} — {u.mobile} — Dep: ₹{u.depositBalance||0}</button>)}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Type</label>
            <div className="flex gap-2">
              {['CREDIT','DEBIT'].map(t=>(
                <button key={t} onClick={()=>setForm(f=>({...f,type:t}))} className={`flex-1 flex items-center justify-center gap-1 py-2 rounded-lg text-xs font-medium border transition-all ${form.type===t?(t==='CREDIT'?'border-green-500 bg-green-500/10 text-green-400':'border-red-500 bg-red-500/10 text-red-400'):'border-dark-600 text-gray-400'}`}>
                  {t==='CREDIT'?<PlusCircle size={12}/>:<MinusCircle size={12}/>}{t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Balance Field</label>
            <select value={form.field} onChange={e=>setForm(f=>({...f,field:e.target.value}))} className="input w-full">
              <option value="depositBalance">Deposit Balance</option>
              <option value="winningsBalance">Winnings Balance</option>
              <option value="tokenBalance">Token Balance</option>
            </select>
          </div>
          <div><label className="text-xs text-gray-400 mb-1 block">Amount (₹)</label><input type="number" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} className="input w-full" placeholder="500"/></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Reason</label><input value={form.reason} onChange={e=>setForm(f=>({...f,reason:e.target.value}))} className="input w-full" placeholder="Compensation for issue #123"/></div>
        </div>
        <button onClick={submit} disabled={processing} className="btn-primary w-full">{processing?'Processing…':'Apply Adjustment'}</button>
      </div>

      <div className="card">
        <h3 className="font-semibold mb-4">Adjustment History</h3>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-dark-600 text-gray-400 text-xs"><th className="text-left py-2">User</th><th>Type</th><th>Field</th><th>Amount</th><th>Before/After</th><th>Reason</th><th>Admin</th><th>Date</th></tr></thead>
          <tbody>
            {history.map(h=>(
              <tr key={h._id} className="border-b border-dark-700 text-xs">
                <td className="py-2">{h.userId?.username}</td>
                <td className="text-center"><span className={`px-1.5 py-0.5 rounded ${h.type==='CREDIT'?'bg-green-500/20 text-green-400':'bg-red-500/20 text-red-400'}`}>{h.type}</span></td>
                <td className="text-center text-gray-400">{h.field}</td>
                <td className={`text-center font-semibold ${h.type==='CREDIT'?'text-green-400':'text-red-400'}`}>{h.type==='CREDIT'?'+':'-'}₹{h.amount}</td>
                <td className="text-center text-gray-400">{h.beforeBalance?.toFixed(0)} → {h.afterBalance?.toFixed(0)}</td>
                <td className="max-w-32 truncate text-gray-400">{h.reason}</td>
                <td className="text-center text-gray-500">{h.adminId?.username}</td>
                <td className="text-gray-500">{new Date(h.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {history.length===0&&<div className="text-center py-8 text-gray-500">No adjustments yet</div>}
      </div>
    </div>
  );
};
