// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useEffect, useId, useState } from 'react';
import { Plus, Trash2, Edit2, RefreshCw, Trophy, Eye, EyeOff } from 'lucide-react';
import api from '../../services/api';
import { Toolbar } from '../../components/design';
import toast from 'react-hot-toast';

const EMPTY = { displayName:'', profilePic:'', city:'', amount:'', game:'Delhi/Bombay', badge:'', isPublic:true, sortOrder:'0', displayTime:'' };

/**
 * ── This lives at module level, and that is the whole point ────────────────
 * It used to be `const F = …` INSIDE `FakeWinnersManager`. A component
 * declared inside another is a NEW COMPONENT TYPE on every parent render, so
 * React cannot reconcile it — it unmounts the old `<input>` and mounts a fresh
 * one. Typing calls `setForm`, which renders the parent, which remounts the
 * field, which takes the caret with it.
 *
 * Measured in a real browser before this was touched: typing "Rahul" into
 * Display Name left the field holding **"R"** with focus on `<body>`. Four of
 * five keystrokes went nowhere. The same test on `/game-providers`, whose
 * `Field` was already at module level, kept all five and kept focus — the
 * control case, so the cause is this and not the environment.
 *
 * No test could have caught it: it renders correctly, it has no failing
 * assertion to make, and every keystroke is "handled". It needs a browser and
 * more than one character (§28).
 */
const F = ({ label, value, onChange, type = 'text', ph = '' }: any) => {
  // Per instance, stable across renders — the labels here are the operator's
  // only way to tell eight identical text boxes apart, and a screen reader
  // needs the association to read them out at all.
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-xs text-gray-400 mb-1 block">{label}</label>
      <input id={id} type={type} value={value || ''} onChange={(e) => onChange(e.target.value)}
        placeholder={ph} className="input w-full text-sm"/>
    </div>
  );
};

export const FakeWinnersManager: React.FC = () => {
  const [winners, setWinners] = useState<any[]>([]);
  const [form, setForm]       = useState<any>(EMPTY);
  const [editId, setEditId]   = useState<string|null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving]   = useState(false);

  const load = async () => {
    try { const r = await api.get('/api/admin/fake-winners'); if(r.data.success) setWinners(r.data.winners); } catch {}
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.displayName || !form.amount) return toast.error('Name and amount required');
    setSaving(true);
    try {
      if (editId) {
        await api.put(`/api/admin/fake-winners/${editId}`, { ...form, amount: Number(form.amount), sortOrder: Number(form.sortOrder) });
        toast.success('Winner updated!');
      } else {
        await api.post('/api/admin/fake-winners', { ...form, amount: Number(form.amount), sortOrder: Number(form.sortOrder) });
        toast.success('Winner added!');
      }
      setForm(EMPTY); setEditId(null); setShowForm(false); load();
    } catch(e:any) { toast.error(e.response?.data?.message || 'Error'); } finally { setSaving(false); }
  };

  const del = async (id:string) => {
    if(!confirm('Delete this winner?')) return;
    await api.delete(`/api/admin/fake-winners/${id}`); load();
  };

  const edit = (w:any) => {
    setForm({ displayName:w.displayName, profilePic:w.profilePic||'', city:w.city||'', amount:String(w.amount),
      game:w.game||'Delhi/Bombay', badge:w.badge||'', isPublic:w.isPublic, sortOrder:String(w.sortOrder||0),
      displayTime: w.displayTime ? new Date(w.displayTime).toISOString().slice(0,16) : '' });
    setEditId(w._id); setShowForm(true);
  };

  const togglePublic = async (w:any) => {
    await api.put(`/api/admin/fake-winners/${w._id}`, { isPublic: !w.isPublic });
    load();
  };

  return (
    <div className="om-fade space-y-6">
      <Toolbar actions={[
        { label: 'Refresh', icon: RefreshCw, onClick: load },
        { label: 'Add Winner', icon: Plus, primary: true, onClick: () => { setForm(EMPTY); setEditId(null); setShowForm(true); } },
      ]} />

      {showForm && (
        <div className="card border border-yellow-500/30 space-y-4">
          <h3 className="font-semibold">{editId ? 'Edit' : 'Add'} Winner Entry</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <F label="Display Name" value={form.displayName} onChange={(v: string) => setForm((f: any) => ({ ...f, displayName: v }))} ph="Rahul K."/>
            <F label="Amount Won (₹)" value={form.amount} onChange={(v: string) => setForm((f: any) => ({ ...f, amount: v }))} type="number" ph="50000"/>
            <F label="City" value={form.city} onChange={(v: string) => setForm((f: any) => ({ ...f, city: v }))} ph="Mumbai"/>
            <F label="Game" value={form.game} onChange={(v: string) => setForm((f: any) => ({ ...f, game: v }))} ph="Delhi/Bombay"/>
            <F label="Badge Text" value={form.badge} onChange={(v: string) => setForm((f: any) => ({ ...f, badge: v }))} ph="Big Win 🔥"/>
            <F label="Sort Order (lower = first)" value={form.sortOrder} onChange={(v: string) => setForm((f: any) => ({ ...f, sortOrder: v }))} type="number" ph="0"/>
            <div className="col-span-2">
              <F label="Profile Picture URL (CDN/S3 link)" value={form.profilePic} onChange={(v: string) => setForm((f: any) => ({ ...f, profilePic: v }))} ph="https://cdn.example.com/avatar.jpg"/>
            </div>
            <div>
              <F label="Display Time (shown to users)" value={form.displayTime} onChange={(v: string) => setForm((f: any) => ({ ...f, displayTime: v }))} type="datetime-local"/>
            </div>
            <div className="flex items-center gap-3 pt-5">
              <label className="text-sm text-gray-300">Public:</label>
              <button onClick={()=>setForm((f:any)=>({...f,isPublic:!f.isPublic}))}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${form.isPublic?'border-green-500 text-green-400 bg-green-500/10':'border-dark-600 text-gray-500'}`}>
                {form.isPublic ? '● Visible' : '○ Hidden'}
              </button>
            </div>
          </div>
          {form.profilePic && <img src={form.profilePic} alt="" className="w-12 h-12 rounded-full object-cover border border-dark-600"/>}
          <div className="flex gap-3">
            <button onClick={save} disabled={saving} className="btn-primary">{saving?'Saving…':editId?'Update':'Add'}</button>
            <button onClick={()=>{setShowForm(false);setEditId(null);setForm(EMPTY);}} className="btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="space-y-2">
          {winners.map(w => (
            <div key={w._id} className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${w.isPublic?'border-dark-600 bg-dark-700':'border-dark-700 bg-dark-800 opacity-50'}`}>
              <div className="relative">
                {w.profilePic ? <img src={w.profilePic} alt="" className="w-10 h-10 rounded-full object-cover"/> : <div className="w-10 h-10 rounded-full bg-dark-600 flex items-center justify-center text-xl">🏆</div>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{w.displayName}</span>
                  {w.city && <span className="text-xs text-gray-500">📍{w.city}</span>}
                  {w.badge && <span className="text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded-sm">{w.badge}</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                  <span className="text-green-400 font-bold">₹{Number(w.amount).toLocaleString()}</span>
                  <span>{w.game}</span>
                  <span>Order: {w.sortOrder}</span>
                  <span>{new Date(w.displayTime||w.createdAt).toLocaleString()}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={()=>togglePublic(w)} className={`p-1.5 rounded-sm ${w.isPublic?'text-green-400 hover:text-green-300':'text-gray-600 hover:text-gray-400'}`}>
                  {w.isPublic ? <Eye size={15}/> : <EyeOff size={15}/>}
                </button>
                <button onClick={()=>edit(w)} className="p-1.5 rounded-sm text-blue-400 hover:text-blue-300"><Edit2 size={15}/></button>
                <button onClick={()=>del(w._id)} className="p-1.5 rounded-sm text-red-400 hover:text-red-300"><Trash2 size={15}/></button>
              </div>
            </div>
          ))}
          {winners.length===0 && <div className="text-center py-10 text-gray-500"><Trophy size={40} className="mx-auto mb-2 opacity-30"/>No winners yet. Add the first one.</div>}
        </div>
      </div>
    </div>
  );
};
