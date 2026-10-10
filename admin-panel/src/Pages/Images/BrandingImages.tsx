// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Branding document's images, edited on the Images page and nowhere else
 * (owner, 2026-10-10: "make a part for all images in admin panel make a single
 * part nowhere else"). The values stay in `Branding` (§2, §13); this page is
 * their one editor and saves only the fields it shows, as a patch
 * (`PUT /api/admin/branding` merges), so it cannot overwrite a colour or a
 * name someone saved on the Branding page meanwhile.
 *
 * Each group lists only images a screen actually draws; the place named under
 * each is that screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { errorMessage } from '../../services/imageUpload';
import { ImageSlot, type SlotSpec } from './ImageSlot';

export interface BrandingImageField extends SlotSpec { key: string }

export const BOARD_IMAGES: BrandingImageField[] = [
  { key: 'betCardDelhiImageUrl', label: 'Delhi betting card', where: 'Background of the left (Delhi) betting card on the game board, every screen. Drawn to fill the card, so keep the subject in the middle.',
    examples: 'Laptop card about 280 × 250, phone card about 180 × 260', ratio: { w: 4, h: 5 }, upload: { w: 800, h: 1000 }, previewWidth: 200 },
  { key: 'betCardBombayImageUrl', label: 'Bombay betting card', where: 'Background of the right (Bombay) betting card on the game board, every screen. Drawn to fill the card, so keep the subject in the middle.',
    examples: 'Laptop card about 280 × 250, phone card about 180 × 260', ratio: { w: 4, h: 5 }, upload: { w: 800, h: 1000 }, previewWidth: 200 },
  { key: 'referPromoImageUrl', label: 'Refer & Earn card', where: 'Top of the left side column beside the game board; tapping it opens Refer & Earn. Shown whole, at its own shape.',
    examples: 'Laptops and desktops (1000 px and wider)', ratio: null, upload: { w: 572, h: 640 }, previewWidth: 286 },
];

export const LOGO_IMAGES: BrandingImageField[] = [
  { key: 'logo', label: 'Main logo', where: 'Top of every panel: the player app header, the admin and merchant panels. PNG with a transparent background.',
    ratio: null, upload: { w: 400, h: 120 }, previewWidth: 240 },
  { key: 'icon', label: 'App icon', where: 'Square mark used in notifications and where the logo does not fit.',
    ratio: { w: 1, h: 1 }, upload: { w: 512, h: 512 }, previewWidth: 96 },
  { key: 'favicon', label: 'Browser tab icon', where: 'The small icon in the browser tab.',
    ratio: { w: 1, h: 1 }, upload: { w: 32, h: 32 }, previewWidth: 96 },
];

export const PAGE_IMAGES: BrandingImageField[] = [
  { key: 'tricksTipsBannerUrl', label: 'Pro Tips page banner', where: 'Top of the Pro Tips page, above the slides. Shown whole, full width.',
    ratio: null, upload: { w: 1200, h: 400 }, previewWidth: 420 },
  { key: 'rulesPageImageUrl', label: 'Rules page banner', where: 'Top of the Rules & How to Play page. Shown whole, full width.',
    ratio: null, upload: { w: 1200, h: 400 }, previewWidth: 420 },
];

export const BrandingImages: React.FC<{ fields: BrandingImageField[]; title: string; intro: string }> = ({ fields, title, intro }) => {
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res: any = await api.branding.getCurrent();
      const doc = res?.data || {};
      const values = Object.fromEntries(fields.map((f) => [f.key, String(doc[f.key] ?? '')]));
      setSaved(values); setDraft(values);
    } catch (e) {
      setError(errorMessage(e, 'Could not load the images'));
    } finally { setLoading(false); }
  }, [fields]);

  useEffect(() => { load(); }, [load]);

  const changed = fields.filter((f) => (draft[f.key] ?? '') !== (saved[f.key] ?? ''));

  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.branding.update(Object.fromEntries(changed.map((f) => [f.key, draft[f.key] ?? ''])));
      setSaved({ ...draft });
      toast.success('Saved. Open player apps update now.');
    } catch (e) {
      setError(errorMessage(e, 'Save failed'));
    } finally { setSaving(false); }
  };

  if (loading) return <div className="card p-6 text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-gray-400">{intro}</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {fields.map((f) => (
          <ImageSlot key={f.key} kind="branding" spec={f} saved={saved[f.key] ?? ''} value={draft[f.key] ?? ''}
            onChange={(url) => setDraft((d) => ({ ...d, [f.key]: url }))} />
        ))}
      </div>
      {error && <div role="alert" className="text-sm text-red-400">{error}</div>}
      <div className="flex items-center gap-3">
        <button type="button" className="btn-primary flex items-center gap-1 disabled:opacity-50" disabled={saving || changed.length === 0} onClick={save}>
          <Save size={14} />{saving ? 'Saving…' : changed.length ? `Save ${changed.length} change${changed.length > 1 ? 's' : ''}` : 'Nothing to save'}
        </button>
        {changed.length > 0 && <button type="button" className="btn-secondary" onClick={() => setDraft({ ...saved })}>Discard changes</button>}
      </div>
    </div>
  );
};

export default BrandingImages;
