// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * GamesManager.tsx — the Game Registry admin console.
 *
 * The single place to manage the game CATALOGUE (metadata) and CATEGORIES.
 * Games are DATA: create/edit here → the user-panel lobbies (Casino/Crash)
 * render them immediately from GET /api/game/games, no deploy. Providers are
 * managed separately on the Game Providers page (this page REFERENCES them);
 * launching reuses the existing provider/session/wallet spine.
 */
import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Save, X, Star, Gamepad2, Tag } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface Game {
  _id?: string; slug?: string; name: string; providerKey: string; categorySlug: string;
  launchStrategy: string; externalGameId: string; launchUrl: string;
  thumbnail: string; banner: string; badge: string; rtp: string; tags: string[] | string;
  minBet: number; maxBet: number; status: string; featured: boolean; order: number;
}
interface Category { _id?: string; slug?: string; name: string; icon: string; order: number; enabled: boolean; }
interface Provider { key: string; name: string; category: string; }

const BLANK_GAME: Game = {
  name: '', providerKey: '', categorySlug: '', launchStrategy: 'PROVIDER_GAME',
  externalGameId: '', launchUrl: '', thumbnail: '', banner: '', badge: '', rtp: '',
  tags: '', minBet: 0, maxBet: 0, status: 'ACTIVE', featured: false, order: 0,
};
const STRATEGIES = ['PROVIDER_GAME', 'PROVIDER_LOBBY', 'INTERNAL_ROUTE', 'EXTERNAL_URL'];
const STATUSES = ['ACTIVE', 'MAINTENANCE', 'INACTIVE'];

const inp = 'w-full bg-[#0B0E14] border border-[#1e2736] rounded-lg p-2 text-sm text-white outline-none focus:border-yellow-500';
const lbl = 'text-[10px] text-slate-500 uppercase font-bold mb-1 block';

export const GamesManager: React.FC = () => {
  const [games, setGames]           = useState<Game[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [providers, setProviders]   = useState<Provider[]>([]);
  const [tab, setTab]               = useState<'games' | 'categories'>('games');
  const [editing, setEditing]       = useState<Game | null>(null);
  const [catEditing, setCatEditing] = useState<Category | null>(null);
  const [loading, setLoading]       = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [g, c, p] = await Promise.all([
        api.get('/api/game/admin/games'),
        api.get('/api/game/admin/categories'),
        api.get('/api/game/admin/game-providers'),
      ]);
      if (g.data.success) setGames(g.data.games);
      if (c.data.success) setCategories(c.data.categories);
      if (p.data.success) setProviders(p.data.providers || []);
    } catch { toast.error('Failed to load registry'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // ── Game save/delete ───────────────────────────────────────────────────────
  const saveGame = async () => {
    if (!editing) return;
    if (!editing.name.trim()) return toast.error('Name is required');
    const body = {
      ...editing,
      tags: typeof editing.tags === 'string'
        ? editing.tags.split(',').map(t => t.trim()).filter(Boolean)
        : editing.tags,
      minBet: Number(editing.minBet) || 0,
      maxBet: Number(editing.maxBet) || 0,
      order: Number(editing.order) || 0,
    };
    try {
      const r = editing._id
        ? await api.put(`/api/game/admin/games/${editing._id}`, body)
        : await api.post('/api/game/admin/games', body);
      if (r.data.success) { toast.success(editing._id ? 'Game updated' : 'Game created'); setEditing(null); load(); }
      else toast.error(r.data.message || 'Save failed');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Save failed'); }
  };
  const deleteGame = async (g: Game) => {
    if (!g._id || !confirm(`Delete "${g.name}"?`)) return;
    try { const r = await api.delete(`/api/game/admin/games/${g._id}`); if (r.data.success) { toast.success('Deleted'); load(); } }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Delete failed'); }
  };

  // ── Category save/delete ─────────────────────────────────────────────────────
  const saveCat = async () => {
    if (!catEditing) return;
    if (!catEditing.name.trim()) return toast.error('Name is required');
    try {
      const r = catEditing._id
        ? await api.put(`/api/game/admin/categories/${catEditing._id}`, catEditing)
        : await api.post('/api/game/admin/categories', catEditing);
      if (r.data.success) { toast.success('Saved'); setCatEditing(null); load(); }
      else toast.error(r.data.message || 'Save failed');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Save failed'); }
  };
  const deleteCat = async (c: Category) => {
    if (!c._id || !confirm(`Delete category "${c.name}"?`)) return;
    try { const r = await api.delete(`/api/game/admin/categories/${c._id}`); if (r.data.success) { toast.success('Deleted'); load(); } }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Delete failed'); }
  };

  const catName = (slug: string) => categories.find(c => c.slug === slug)?.name || slug || '—';

  return (
    <div className="p-4 md:p-6 text-white max-w-6xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Gamepad2 className="text-yellow-400" /> Game Registry</h1>
        <button onClick={() => (tab === 'games' ? setEditing({ ...BLANK_GAME }) : setCatEditing({ name: '', icon: '', order: 0, enabled: true }))}
          className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-sm px-4 py-2 rounded-lg flex items-center gap-1">
          <Plus size={16} /> New {tab === 'games' ? 'Game' : 'Category'}
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        Games and categories are data — add one and it appears in the user panel immediately, no deploy.
        Providers are configured on the Game Providers page; this registry references them.
      </p>

      <div className="flex gap-2 mb-4">
        {(['games', 'categories'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold capitalize ${tab === t ? 'bg-yellow-500 text-black' : 'bg-[#1A1F2E] text-slate-400'}`}>
            {t === 'games' ? <Gamepad2 size={14} className="inline mr-1" /> : <Tag size={14} className="inline mr-1" />}{t}
          </button>
        ))}
      </div>

      {loading ? <p className="text-slate-500">Loading…</p> : tab === 'games' ? (
        <div className="overflow-x-auto rounded-lg border border-[#1e2736]">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-[#121826] text-slate-400 text-[11px] uppercase">
              <tr>
                <th className="text-left p-2">Game</th><th className="text-left p-2">Category</th>
                <th className="text-left p-2">Provider</th><th className="text-left p-2">Status</th>
                <th className="text-center p-2">Featured</th><th className="text-right p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {games.map(g => (
                <tr key={g._id} className="border-t border-[#1e2736] hover:bg-[#121826]/50">
                  <td className="p-2">
                    <div className="font-semibold">{g.name}</div>
                    <div className="text-[10px] text-slate-500">{g.slug} · {g.badge}</div>
                  </td>
                  <td className="p-2 text-slate-300">{catName(g.categorySlug)}</td>
                  <td className="p-2 text-slate-400">{g.providerKey || 'in-house'}</td>
                  <td className="p-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                      g.status === 'ACTIVE' ? 'bg-green-900/50 text-green-400' :
                      g.status === 'MAINTENANCE' ? 'bg-yellow-900/50 text-yellow-400' : 'bg-slate-800 text-slate-500'}`}>
                      {g.status}
                    </span>
                  </td>
                  <td className="p-2 text-center">{g.featured ? <Star size={14} className="inline text-yellow-400 fill-yellow-400" /> : ''}</td>
                  <td className="p-2 text-right whitespace-nowrap">
                    <button onClick={() => setEditing({ ...g, tags: Array.isArray(g.tags) ? g.tags.join(', ') : g.tags })}
                      className="text-yellow-400 hover:underline text-xs mr-3">Edit</button>
                    <button onClick={() => deleteGame(g)} className="text-red-400 hover:text-red-300"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
              {games.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-600">No games yet — create one.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-2">
          {categories.map(c => (
            <div key={c._id} className="flex items-center justify-between bg-[#121826] border border-[#1e2736] rounded-lg p-3">
              <div className="flex items-center gap-3">
                <span className="text-xl">{c.icon}</span>
                <div>
                  <div className="font-semibold">{c.name} {!c.enabled && <span className="text-[10px] text-slate-500">(hidden)</span>}</div>
                  <div className="text-[10px] text-slate-500">{c.slug} · order {c.order}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => setCatEditing(c)} className="text-yellow-400 hover:underline text-xs">Edit</button>
                <button onClick={() => deleteCat(c)} className="text-red-400 hover:text-red-300"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {categories.length === 0 && <p className="text-slate-600 text-center p-6">No categories yet.</p>}
        </div>
      )}

      {/* ── Game editor modal ── */}
      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setEditing(null)}>
          <div className="bg-[#1A1F2E] rounded-xl p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg">{editing._id ? 'Edit Game' : 'New Game'}</h3>
              <button onClick={() => setEditing(null)}><X size={18} className="text-slate-400" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className={lbl}>Name *</label>
                <input className={inp} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></div>
              <div><label className={lbl}>Category</label>
                <select className={inp} value={editing.categorySlug} onChange={e => setEditing({ ...editing, categorySlug: e.target.value })}>
                  <option value="">—</option>
                  {categories.map(c => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </select></div>
              <div><label className={lbl}>Provider</label>
                <select className={inp} value={editing.providerKey} onChange={e => setEditing({ ...editing, providerKey: e.target.value })}>
                  <option value="">in-house</option>
                  {providers.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                </select></div>
              <div><label className={lbl}>Launch Strategy</label>
                <select className={inp} value={editing.launchStrategy} onChange={e => setEditing({ ...editing, launchStrategy: e.target.value })}>
                  {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
                </select></div>
              <div><label className={lbl}>Status</label>
                <select className={inp} value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value })}>
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select></div>
              <div><label className={lbl}>Provider Game ID</label>
                <input className={inp} value={editing.externalGameId} onChange={e => setEditing({ ...editing, externalGameId: e.target.value })} placeholder="e.g. vs20sugardance" /></div>
              <div><label className={lbl}>Launch URL (internal/external)</label>
                <input className={inp} value={editing.launchUrl} onChange={e => setEditing({ ...editing, launchUrl: e.target.value })} placeholder="/  or  https://…" /></div>
              <div><label className={lbl}>Thumbnail URL</label>
                <input className={inp} value={editing.thumbnail} onChange={e => setEditing({ ...editing, thumbnail: e.target.value })} /></div>
              <div><label className={lbl}>Banner URL</label>
                <input className={inp} value={editing.banner} onChange={e => setEditing({ ...editing, banner: e.target.value })} /></div>
              <div><label className={lbl}>Badge</label>
                <input className={inp} value={editing.badge} onChange={e => setEditing({ ...editing, badge: e.target.value })} placeholder="🔴 Live" /></div>
              <div><label className={lbl}>RTP</label>
                <input className={inp} value={editing.rtp} onChange={e => setEditing({ ...editing, rtp: e.target.value })} placeholder="97.3%" /></div>
              <div><label className={lbl}>Tags (comma-sep)</label>
                <input className={inp} value={editing.tags as string} onChange={e => setEditing({ ...editing, tags: e.target.value })} placeholder="popular, live" /></div>
              <div><label className={lbl}>Min Bet</label>
                <input type="number" className={inp} value={editing.minBet} onChange={e => setEditing({ ...editing, minBet: Number(e.target.value) })} /></div>
              <div><label className={lbl}>Max Bet</label>
                <input type="number" className={inp} value={editing.maxBet} onChange={e => setEditing({ ...editing, maxBet: Number(e.target.value) })} /></div>
              <div><label className={lbl}>Sort Order</label>
                <input type="number" className={inp} value={editing.order} onChange={e => setEditing({ ...editing, order: Number(e.target.value) })} /></div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={editing.featured} onChange={e => setEditing({ ...editing, featured: e.target.checked })} />
                  <Star size={14} className="text-yellow-400" /> Featured
                </label>
              </div>
            </div>
            <button onClick={saveGame} className="mt-4 w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-2.5 rounded-lg flex items-center justify-center gap-2">
              <Save size={16} /> {editing._id ? 'Save changes' : 'Create game'}
            </button>
          </div>
        </div>
      )}

      {/* ── Category editor modal ── */}
      {catEditing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setCatEditing(null)}>
          <div className="bg-[#1A1F2E] rounded-xl p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg">{catEditing._id ? 'Edit Category' : 'New Category'}</h3>
              <button onClick={() => setCatEditing(null)}><X size={18} className="text-slate-400" /></button>
            </div>
            <div className="space-y-3">
              <div><label className={lbl}>Name *</label>
                <input className={inp} value={catEditing.name} onChange={e => setCatEditing({ ...catEditing, name: e.target.value })} /></div>
              <div><label className={lbl}>Icon (emoji)</label>
                <input className={inp} value={catEditing.icon} onChange={e => setCatEditing({ ...catEditing, icon: e.target.value })} placeholder="🎰" /></div>
              <div><label className={lbl}>Sort Order</label>
                <input type="number" className={inp} value={catEditing.order} onChange={e => setCatEditing({ ...catEditing, order: Number(e.target.value) })} /></div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={catEditing.enabled} onChange={e => setCatEditing({ ...catEditing, enabled: e.target.checked })} /> Enabled (visible)
              </label>
            </div>
            <button onClick={saveCat} className="mt-4 w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-2.5 rounded-lg flex items-center justify-center gap-2">
              <Save size={16} /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GamesManager;
