// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Images › Promo cards: the home promo cards, each with its OWN image for each
 * screen (owner, 2026-10-10: "make the tablet promo or other images as per
 * that size"). The screens, their sizes and where each card goes come from
 * the server (`devices`, database/spec/promoDevices.js) with the cards; this
 * page keeps no copy.
 *
 * A card is drawn on a screen only when it has that screen's image, so an
 * admin can run a card on phones alone. Every change is staged and previewed;
 * Save sends the card and its images in one request, which the server writes
 * in one transaction (`upsertPromo` / `updatePromo`).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Eye, EyeOff, Save, X, Laptop, Tablet, Smartphone } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { errorMessage } from '../../services/imageUpload';
import { ImageSlot } from './ImageSlot';

/** One screen, as the server describes it (spec/promoDevices.js). */
export interface PromoDevice {
  key: string; label: string; minWidth: number; maxWidth: number | null;
  ratio: { w: number; h: number }; upload: { w: number; h: number };
  where: string; examples: string;
}

export interface HomeCard {
  promoId: string; title: string; linkUrl: string | null; priority: number;
  status: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED'; images: Record<string, string>;
}

interface Draft { promoId: string | null; title: string; linkUrl: string; priority: number; live: boolean; images: Record<string, string> }

const EMPTY: Draft = { promoId: null, title: '', linkUrl: '', priority: 0, live: true, images: {} };

/** How wide each screen's preview is drawn on this page, in px. */
const PREVIEW_WIDTH: Record<string, number> = { LAPTOP: 300, TABLET: 560, PHONE: 390, SMALL_PHONE: 340 };

const deviceIcon = (key: string) => (key === 'LAPTOP' ? <Laptop size={14} /> : key === 'TABLET' ? <Tablet size={14} /> : <Smartphone size={key === 'SMALL_PHONE' ? 12 : 14} />);

const widthText = (d: PromoDevice) => (d.maxWidth === null ? `${d.minWidth} px and wider` : d.minWidth === 0 ? `up to ${d.maxWidth} px wide` : `${d.minWidth}–${d.maxWidth} px wide`);

export const PromoDeviceCards: React.FC = () => {
  const [cards, setCards] = useState<HomeCard[]>([]);
  const [devices, setDevices] = useState<PromoDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDel, setConfirmDel] = useState<HomeCard | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<any>('/api/admin/promo?location=HOME');
      setCards(res.data?.promos || []);
      setDevices(res.data?.devices || []);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not load the promo cards'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saved = (key: string) => (draft?.promoId ? cards.find((c) => c.promoId === draft.promoId)?.images?.[key] ?? '' : '');

  const edit = (c: HomeCard) => {
    setError('');
    setDraft({ promoId: c.promoId, title: c.title || '', linkUrl: c.linkUrl || '', priority: c.priority || 0, live: c.status === 'PUBLISHED', images: { ...c.images } });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true); setError('');
    // Every screen, so a removed image is sent as '' and removed.
    const images = Object.fromEntries(devices.map((d) => [d.key, draft.images[d.key] || '']));
    const body = {
      title: draft.title.trim(), linkUrl: draft.linkUrl.trim(), priority: Number(draft.priority) || 0,
      status: draft.live ? 'PUBLISHED' : 'DRAFT', images,
    };
    try {
      if (draft.promoId) await api.put(`/api/admin/promo/${draft.promoId}`, body);
      else await api.post('/api/admin/promo', { ...body, location: 'HOME', mediaType: 'IMAGE' });
      toast.success(draft.live ? 'Saved. Players see it now.' : 'Saved as hidden.');
      setDraft(null);
      await load();
    } catch (e) {
      setError(errorMessage(e, 'Save failed'));
    } finally { setSaving(false); }
  };

  const toggleLive = async (c: HomeCard) => {
    try {
      await api.put(`/api/admin/promo/${c.promoId}`, { status: c.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED' });
      await load();
    } catch (e) { toast.error(errorMessage(e, 'Could not change it')); }
  };

  const remove = async (c: HomeCard) => {
    try {
      await api.delete(`/api/admin/promo/${c.promoId}`);
      toast.success('Card removed');
      await load();
    } catch (e) { toast.error(errorMessage(e, 'Could not remove it')); }
    setConfirmDel(null);
  };

  if (loading) return <div className="card p-6 text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Home promo cards</h2>
            <p className="text-sm text-gray-400">Each card has its own image per screen. A card shows on a screen only when it has that screen's image.</p>
          </div>
          {!draft && (
            <button type="button" className="btn-primary flex items-center gap-1" onClick={() => { setError(''); setDraft({ ...EMPTY }); }}>
              <Plus size={14} />New card
            </button>
          )}
        </div>
        {/* The screens, their sizes and places, from the server. */}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {devices.map((d) => (
            <div key={d.key} className="rounded-md bg-dark-800 border border-dark-600 p-3 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-white">{deviceIcon(d.key)}{d.label}</div>
              <div className="font-mono text-gold-400 mt-1">{d.upload.w} × {d.upload.h} px · {d.ratio.w}:{d.ratio.h}</div>
              <div className="text-gray-400 mt-1">{widthText(d)}. {d.where}</div>
              <div className="text-gray-500 mt-1">{d.examples}</div>
            </div>
          ))}
        </div>
      </div>

      {draft && (
        <div className="card p-4 space-y-4" role="region" aria-label={draft.promoId ? 'Edit card' : 'New card'}>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{draft.promoId ? 'Edit card' : 'New card'}</h3>
            <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => setDraft(null)}><X size={13} />Close without saving</button>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label" htmlFor="card-title">Name (for you, and read aloud to screen readers)</label>
              <input id="card-title" className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Diwali offer" />
            </div>
            <div>
              <label className="label" htmlFor="card-link">Opens when tapped (optional)</label>
              <input id="card-link" className="input" value={draft.linkUrl} onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })} placeholder="/referrals or https://t.me/yourchannel" />
              <p className="text-xs text-gray-500 mt-1">A page of the app (/referrals, /wallet, /promo) or a full https:// link, which opens in a new tab.</p>
            </div>
            <div>
              <label className="label" htmlFor="card-priority">Order (higher shows first)</label>
              <input id="card-priority" type="number" className="input" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />
            </div>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {devices.map((d) => (
              <ImageSlot key={d.key} kind="promo"
                spec={{ label: `${d.label} image`, where: d.where, examples: `${widthText(d)} · ${d.examples}`, ratio: d.ratio, upload: d.upload, previewWidth: PREVIEW_WIDTH[d.key] ?? 360 }}
                saved={saved(d.key)} value={draft.images[d.key] || ''}
                onChange={(url) => setDraft({ ...draft, images: { ...draft.images, [d.key]: url } })} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input id="card-live" type="checkbox" checked={draft.live} onChange={(e) => setDraft({ ...draft, live: e.target.checked })} />
            <label htmlFor="card-live" className="text-sm">Show to players</label>
          </div>
          {error && <div role="alert" className="text-sm text-red-400">{error}</div>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary flex items-center gap-1 disabled:opacity-50" disabled={saving} onClick={save}>
              <Save size={14} />{saving ? 'Saving…' : 'Save card'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      {cards.length === 0 && !draft && (
        <div className="card p-6 text-sm text-gray-400">No promo cards yet. Without any, the board's side columns show the built-in artwork and phones show no banner.</div>
      )}

      <div className="space-y-3">
        {cards.map((c) => {
          const live = c.status === 'PUBLISHED';
          return (
            <div key={c.promoId} className="card p-4 flex flex-col lg:flex-row gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold truncate">{c.title || 'Untitled card'}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${live ? 'bg-green-500/20 text-green-300' : 'bg-dark-600 text-gray-400'}`}>{live ? 'SHOWING' : 'HIDDEN'}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1">Order {c.priority}{c.linkUrl ? ` · opens ${c.linkUrl}` : ' · not clickable'}</div>
                <div className="flex flex-wrap gap-3 mt-3">
                  {devices.map((d) => {
                    const url = c.images?.[d.key];
                    return (
                      <div key={d.key} className="text-[11px] text-gray-400" style={{ width: 120 }}>
                        <div className="flex items-center gap-1 mb-1">{deviceIcon(d.key)}{d.label}</div>
                        <div className="rounded border border-dark-600 bg-dark-900 overflow-hidden" style={{ aspectRatio: `${d.ratio.w} / ${d.ratio.h}` }}>
                          {url ? <img src={url} alt={`${c.title || 'Card'} on ${d.label}`} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-500">not shown</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="flex lg:flex-col gap-2 flex-none">
                <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => edit(c)}><Pencil size={13} />Edit</button>
                <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => toggleLive(c)}>
                  {live ? <><EyeOff size={13} />Hide</> : <><Eye size={13} />Show</>}
                </button>
                <button type="button" className="btn-secondary text-xs flex items-center gap-1 text-red-300" onClick={() => setConfirmDel(c)}><Trash2 size={13} />Delete</button>
              </div>
            </div>
          );
        })}
      </div>

      {confirmDel && (
        <ConfirmDialog isOpen title="Delete this card?" message={`"${confirmDel.title || 'Untitled card'}" and its images for every screen will be removed from the player app.`}
          confirmText="Delete" onConfirm={() => remove(confirmDel)} onClose={() => setConfirmDel(null)} type="danger" />
      )}
    </div>
  );
};

export default PromoDeviceCards;
