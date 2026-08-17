// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, RefreshCw, Bell } from 'lucide-react';
import api from '../../services/api';
import { Toolbar } from '../../components/design';
import toast from 'react-hot-toast';

export const AnnouncementsPage: React.FC = () => {
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState({ title:'', body:'', type:'INFO', priority:'0', expiresAt:'' });
  const [editId, setEditId] = useState<string|null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = async () => { try { const r = await api.get('/api/admin/announcements'); if(r.data.success) setItems(r.data.announcements); } catch {} };
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      const payload = { ...form, priority: Number(form.priority), expiresAt: form.expiresAt || undefined };
      if (editId) { await api.put(`/api/admin/announcements/${editId}`, payload); toast.success('Updated!'); }
      else { await api.post('/api/admin/announcements', payload); toast.success('Created!'); }
      setShowForm(false); setEditId(null); setForm({title:'',body:'',type:'INFO',priority:'0',expiresAt:''});
      load();
    } catch { toast.error('Error'); }
  };

  const del = async (id: string) => { if(!confirm('Delete?')) return; await api.delete(`/api/admin/announcements/${id}`); load(); };

  const startEdit = (item: any) => { setForm({title:item.title,body:item.body,type:item.type,priority:String(item.priority),expiresAt:item.expiresAt?new Date(item.expiresAt).toISOString().slice(0,16):''}); setEditId(item._id); setShowForm(true); };

  const typeColor: Record<string,string> = { INFO:'bg-blue-500/20 text-blue-400', WARNING:'bg-yellow-500/20 text-yellow-400', PROMO:'bg-green-500/20 text-green-400', MAINTENANCE:'bg-red-500/20 text-red-400' };

  return (
    <div className="om-fade space-y-6">
      <Toolbar actions={[
        { label: 'Refresh', icon: RefreshCw, onClick: load },
        { label: 'New', icon: Plus, primary: true, onClick: () => { setShowForm(true); setEditId(null); } },
      ]} />

      {showForm && (
        <div className="card space-y-4 border border-blue-500/30">
          <h3 className="font-semibold">{editId ? 'Edit' : 'New'} Announcement</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2"><label className="text-xs text-gray-400 mb-1 block">Title</label><input value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} className="input w-full" placeholder="Maintenance on Sunday..."/></div>
            <div className="col-span-2"><label className="text-xs text-gray-400 mb-1 block">Body</label><textarea value={form.body} onChange={e=>setForm(f=>({...f,body:e.target.value}))} className="input w-full h-24 resize-none" placeholder="Full message text..."/></div>
            <div><label className="text-xs text-gray-400 mb-1 block">Type</label><select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))} className="input w-full"><option>INFO</option><option>WARNING</option><option>PROMO</option><option>MAINTENANCE</option></select></div>
            <div><label className="text-xs text-gray-400 mb-1 block">Priority (higher = shown first)</label><input type="number" value={form.priority} onChange={e=>setForm(f=>({...f,priority:e.target.value}))} className="input w-full"/></div>
            <div><label className="text-xs text-gray-400 mb-1 block">Expires At (optional)</label><input type="datetime-local" value={form.expiresAt} onChange={e=>setForm(f=>({...f,expiresAt:e.target.value}))} className="input w-full"/></div>
          </div>
          <div className="flex gap-3"><button onClick={save} className="btn-primary">Save</button><button onClick={()=>setShowForm(false)} className="btn-secondary">Cancel</button></div>
        </div>
      )}

      <div className="space-y-3">
        {items.map(item => (
          <div key={item._id} className="card flex items-start gap-4">
            <Bell size={20} className="text-yellow-400 mt-0.5 shrink-0"/>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="font-semibold">{item.title}</span>
                <span className={`px-2 py-0.5 rounded-sm text-xs ${typeColor[item.type]||typeColor.INFO}`}>{item.type}</span>
                <span className={`px-2 py-0.5 rounded-sm text-xs ${item.isActive?'bg-green-500/20 text-green-400':'bg-gray-500/20 text-gray-400'}`}>{item.isActive?'Active':'Inactive'}</span>
              </div>
              <p className="text-sm text-gray-400">{item.body}</p>
              <p className="text-xs text-gray-600 mt-1">{new Date(item.createdAt).toLocaleString()}{item.expiresAt&&` · Expires ${new Date(item.expiresAt).toLocaleString()}`}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={()=>startEdit(item)} className="text-blue-400 hover:text-blue-300"><Edit2 size={14}/></button>
              <button onClick={()=>del(item._id)} className="text-red-400 hover:text-red-300"><Trash2 size={14}/></button>
            </div>
          </div>
        ))}
        {items.length===0&&<div className="text-center py-10 text-gray-500"><Bell size={40} className="mx-auto mb-2 opacity-30"/>No announcements</div>}
      </div>
    </div>
  );
};
