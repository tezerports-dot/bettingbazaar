// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Save, TestTube, RefreshCw, ToggleLeft, ToggleRight, ChevronDown, ChevronUp,
         Gamepad2, Trophy, Zap, Activity, Plus, Trash2, X } from 'lucide-react';
import api from '../../services/api';
import { Toolbar } from '../../components/design';
import toast from 'react-hot-toast';

const CATEGORY_META: Record<string, { label: string; icon: React.ReactNode; color: string; desc: string }> = {
  casino:  { label: 'Live Casino',     icon: <Gamepad2 size={18}/>, color: 'text-purple-400', desc: 'Live dealer tables — Roulette, Blackjack, Baccarat, Teen Patti' },
  crash:   { label: 'Crash Games',    icon: <Zap size={18}/>,      color: 'text-orange-400', desc: 'Aviator, JetX and instant-win crash games' },
  sports:  { label: 'Sports Betting', icon: <Trophy size={18}/>,   color: 'text-green-400',  desc: 'Full sportsbook with live in-play betting' },
  slots:   { label: 'Slots',          icon: <Activity size={18}/>, color: 'text-yellow-400', desc: 'Slot game library' },
};

const CATEGORIES = ['casino', 'crash', 'sports', 'slots'];

const Field = ({ label, value, onChange, type = 'text', placeholder = '', help = '' }: any) => (
  <div>
    <label className="text-xs text-gray-400 mb-1 block">{label}</label>
    <input
      type={type} value={value || ''} onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2 text-sm text-white focus:border-yellow-500/50 outline-none"
    />
    {help && <p className="text-[10px] text-gray-600 mt-0.5">{help}</p>}
  </div>
);

const EMPTY_NEW = { key: '', name: '', category: 'casino', description: '', logoUrl: '',
                    apiUrl: '', apiKey: '', apiSecret: '', merchantId: '', webhookSecret: '' };

const GENERIC_FIELDS = [
  { key: 'apiUrl',        label: 'API Base URL',          ph: 'https://api.provider.com',      help: 'Provided by the game provider after partnership' },
  { key: 'merchantId',    label: 'Operator / Merchant ID',ph: 'OP_XXX' },
  { key: 'apiKey',        label: 'API Key',               ph: 'key_...' },
  { key: 'apiSecret',     label: 'API Secret',            ph: 'secret_...', secret: true },
  { key: 'webhookSecret', label: 'Webhook Secret',        ph: 'whsec_...',  secret: true, help: 'Used to verify wallet callbacks from provider' },
  { key: 'logoUrl',       label: 'Logo URL',              ph: 'https://cdn.example.com/logo.png' },
  { key: 'description',   label: 'Description',           ph: 'Short description shown to users' },
];

export const GameProviders: React.FC = () => {
  const [providers, setProviders] = useState<any[]>([]);
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [edits, setEdits]         = useState<Record<string, any>>({});
  const [saving, setSaving]       = useState<string | null>(null);
  const [testing, setTesting]     = useState<string | null>(null);
  const [deleting, setDeleting]   = useState<string | null>(null);
  const [showAdd, setShowAdd]     = useState(false);
  const [newProv, setNewProv]     = useState({ ...EMPTY_NEW });
  const [adding, setAdding]       = useState(false);

  const load = async () => {
    try {
      const r = await api.get('/api/game/admin/game-providers');
      if (r.data.success) {
        setProviders(r.data.providers);
        const init: Record<string, any> = {};
        for (const p of r.data.providers) init[p.key] = { ...p };
        setEdits(init);
      }
    } catch { toast.error('Failed to load providers'); }
  };

  useEffect(() => { load(); }, []);

  const set = (key: string, field: string, val: any) =>
    setEdits(e => ({ ...e, [key]: { ...e[key], [field]: val } }));

  const save = async (key: string) => {
    setSaving(key);
    try {
      const r = await api.put(`/api/game/admin/game-providers/${key}`, edits[key]);
      if (r.data.success) { toast.success(`${edits[key].name} saved!`); load(); }
    } catch { toast.error('Save failed'); } finally { setSaving(null); }
  };

  const test = async (key: string) => {
    setTesting(key);
    try {
      const r = await api.post(`/api/game/admin/game-providers/${key}/test`);
      toast[r.data.success ? 'success' : 'error'](r.data.message);
    } catch (e: any) { toast.error(e.response?.data?.message || 'Test failed'); } finally { setTesting(null); }
  };

  const deleteProvider = async (key: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setDeleting(key);
    try {
      const r = await api.delete(`/api/game/admin/game-providers/${key}`);
      if (r.data.success) { toast.success(`${name} deleted`); load(); }
    } catch (e: any) { toast.error(e.response?.data?.message || 'Delete failed'); } finally { setDeleting(null); }
  };

  const addProvider = async () => {
    if (!newProv.key || !newProv.name || !newProv.category) {
      toast.error('Key, name, and category are required'); return;
    }
    setAdding(true);
    try {
      const r = await api.post('/api/game/admin/game-providers', newProv);
      if (r.data.success) {
        toast.success(`${newProv.name} added!`);
        setShowAdd(false); setNewProv({ ...EMPTY_NEW }); load();
      }
    } catch (e: any) { toast.error(e.response?.data?.message || 'Add failed'); } finally { setAdding(false); }
  };

  const grouped = providers.reduce((acc: any, p: any) => {
    if (!acc[p.category]) acc[p.category] = [];
    acc[p.category].push(p);
    return acc;
  }, {} as Record<string, any[]>);

  return (
    <div className="om-fade space-y-6">
      <Toolbar actions={[
        { label: 'Refresh', icon: RefreshCw, onClick: load },
        { label: 'Add Provider', icon: Plus, primary: true, onClick: () => setShowAdd(true) },
      ]} />

      <div className="card border border-blue-500/20 bg-blue-500/5 text-sm text-gray-300 space-y-1">
        <p className="font-semibold text-white">How it works</p>
        <p>1. Sign a commercial agreement with the provider and receive API credentials.</p>
        <p>2. Enter credentials below, click <strong className="text-yellow-400">Save</strong>, then toggle <strong className="text-green-400">ON</strong>.</p>
        <p>3. Section goes live immediately. Webhook URL: <code className="text-yellow-300 text-xs">/api/game/wallet/:providerKey</code></p>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={(e)=>{if(e.target===e.currentTarget)setShowAdd(false);}}>
          <div className="bg-dark-800 border border-dark-600 rounded-xl w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Add New Provider</h2>
              <button onClick={() => setShowAdd(false)} className="text-gray-400 hover:text-white"><X size={20}/></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Provider Key (unique slug)" value={newProv.key}
                onChange={(v: string) => setNewProv(p => ({ ...p, key: v.toLowerCase().replace(/[^a-z0-9_-]/g,'_') }))}
                placeholder="e.g. evolution" help="Lowercase, letters/numbers/underscores only" />
              <Field label="Display Name" value={newProv.name}
                onChange={(v: string) => setNewProv(p => ({ ...p, name: v }))} placeholder="e.g. Evolution Gaming" />
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Category</label>
                <select value={newProv.category}
                  onChange={e => setNewProv(p => ({ ...p, category: e.target.value }))}
                  className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm text-white outline-none">
                  {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_META[c]?.label || c}</option>)}
                </select>
              </div>
              <Field label="API Base URL" value={newProv.apiUrl}
                onChange={(v: string) => setNewProv(p => ({ ...p, apiUrl: v }))} placeholder="https://api.provider.com" />
              <Field label="API Key" value={newProv.apiKey}
                onChange={(v: string) => setNewProv(p => ({ ...p, apiKey: v }))} placeholder="key_..." />
              <Field label="Merchant / Operator ID" value={newProv.merchantId}
                onChange={(v: string) => setNewProv(p => ({ ...p, merchantId: v }))} placeholder="OP_XXX" />
            </div>
            <Field label="Description (shown to users)" value={newProv.description}
              onChange={(v: string) => setNewProv(p => ({ ...p, description: v }))}
              placeholder="Short description of what this provider offers" />
            <div className="flex gap-3 pt-2">
              <button onClick={addProvider} disabled={adding} className="btn-primary flex items-center gap-2">
                <Plus size={14}/>{adding ? 'Adding…' : 'Add Provider'}
              </button>
              <button onClick={() => setShowAdd(false)} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {Object.entries(grouped).map(([category, catProviders]) => {
        const meta = CATEGORY_META[category] || { label: category, icon: null, color: 'text-white', desc: '' };
        return (
          <div key={category} className="space-y-3">
            <div className="flex items-center gap-3">
              <span className={meta.color}>{meta.icon}</span>
              <div>
                <h2 className="font-semibold text-lg">{meta.label}</h2>
                <p className="text-xs text-gray-500">{meta.desc}</p>
              </div>
            </div>
            {(catProviders as any[]).map((p: any) => {
              const edit   = edits[p.key] || p;
              const isOpen = expanded === p.key;
              const isReady = edit.apiUrl && edit.apiKey && edit.merchantId;
              return (
                <div key={p.key} className={`card border transition-all ${edit.enabled ? 'border-green-500/30' : 'border-dark-600'}`}>
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="font-semibold">{p.name}</h3>
                        <span className="text-xs font-mono text-gray-600">{p.key}</span>
                        {edit.enabled
                          ? <span className="px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400 font-medium">● LIVE</span>
                          : <span className="px-2 py-0.5 rounded text-xs bg-dark-600 text-gray-500">○ Coming Soon</span>}
                        {isReady && !edit.enabled && <span className="text-xs text-yellow-400">Credentials set — toggle ON to go live</span>}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{p.description}</p>
                    </div>
                    <button onClick={() => set(p.key, 'enabled', !edit.enabled)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${edit.enabled ? 'border-green-500 bg-green-500/10 text-green-400' : 'border-dark-600 text-gray-500 hover:border-dark-500'}`}>
                      {edit.enabled ? <><ToggleRight size={14}/> ON</> : <><ToggleLeft size={14}/> OFF</>}
                    </button>
                    <button onClick={() => deleteProvider(p.key, p.name)} disabled={deleting === p.key}
                      className="text-gray-600 hover:text-red-400 p-1 transition-colors" title="Delete provider">
                      <Trash2 size={16}/>
                    </button>
                    <button onClick={() => setExpanded(isOpen ? null : p.key)} className="text-gray-400 hover:text-white p-1">
                      {isOpen ? <ChevronUp size={18}/> : <ChevronDown size={18}/>}
                    </button>
                  </div>
                  {isOpen && (
                    <div className="mt-4 pt-4 border-t border-dark-600 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        {GENERIC_FIELDS.map(f => (
                          <Field key={f.key} label={f.label} value={edit[f.key]}
                            onChange={(v: string) => set(p.key, f.key, v)}
                            placeholder={f.ph} help={(f as any).help}
                            type={(f as any).secret ? 'password' : 'text'} />
                        ))}
                      </div>
                      <div className="p-3 bg-dark-800 rounded-lg text-xs text-gray-500 font-mono">
                        Wallet webhook URL: <span className="text-yellow-300">{window.location.origin}/api/game/wallet/{p.key}</span>
                      </div>
                      <div className="flex gap-3 items-center">
                        <button onClick={() => save(p.key)} disabled={saving === p.key} className="btn-primary flex items-center gap-2">
                          <Save size={14}/>{saving === p.key ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => test(p.key)} disabled={testing === p.key || !edit.apiUrl} className="btn-secondary flex items-center gap-2">
                          <TestTube size={14}/>{testing === p.key ? 'Testing…' : 'Test Connection'}
                        </button>
                        {!isReady && <span className="text-xs text-gray-600">Fill API URL, Key, Merchant ID to test</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
