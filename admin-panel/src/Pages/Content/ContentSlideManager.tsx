// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ContentSlideManager.tsx
 *
 * Admin page to manage full-screen image slides for:
 *   - TRICKS_PAGE  → user Promo / Tips & Tricks page
 *   - RULES_PAGE   → user Rules / How to Play page
 *
 * Shown inside Images › Page banners & slides. Home promo cards are not slides:
 * each has an image per screen, set under Images › Promo cards
 * (PromoDeviceCards.tsx).
 *
 * Each slide = one PromoContent document with:
 *   location : TRICKS_PAGE | RULES_PAGE
 *   fileUrl  : CDN URL of the image, or on TRICKS_PAGE of a video of at most
 *              30 seconds (mediaType VIDEO): Pro Tips is a full-screen reel
 *              feed in the player app (owner, 2026-10-24)
 *   title    : caption shown below image (optional)
 *   priority : sort order (higher = shown first)
 *   status   : PUBLISHED | DRAFT (ACTIVE is read as PUBLISHED)
 *
 * Admin can:
 *   1. Upload images directly (presigned S3 URL flow)
 *   2. Paste an existing CDN URL
 *   3. Reorder with the arrows (priorities rewritten so the order is exact)
 *   4. Toggle active/inactive (hides from users without deleting)
 *   5. Delete
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Upload, Link2, Trash2, Eye, EyeOff, Plus, RefreshCw,
  ArrowUp, ArrowDown, Image as ImageIcon, BookOpen, Lightbulb,
} from 'lucide-react';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import api from '../../services/api';
import { errorMessage, mediaTypeOfUrl, uploadImage, uploadReelMedia } from '../../services/imageUpload';
import toast from 'react-hot-toast';
import { Toolbar } from '../../components/design';

type Location = 'TRICKS_PAGE' | 'RULES_PAGE';

interface Slide {
  _id: string;
  title?: string;
  fileUrl?: string;
  mediaType?: 'IMAGE' | 'VIDEO' | 'TEXT';
  priority: number;
  // The server answers its own vocabulary (`PUBLISHED`/`DRAFT`/`ARCHIVED`,
  // content.admin.routes.js `PROMO_STATUS`); `ACTIVE` is accepted as PUBLISHED.
  status: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED' | 'ACTIVE';
  location: Location;
  createdAt: string;
}

const isLive = (slide: Slide) => slide.status === 'PUBLISHED' || slide.status === 'ACTIVE';

/** Pro Tips takes videos too (reels); Rules takes images only (promoMedia.js). */
const takesVideo = (location: Location) => location === 'TRICKS_PAGE';

/** A slide's picture or video, filling its frame. */
const SlideMedia: React.FC<{ url: string; video: boolean; alt: string; className: string; controls?: boolean }> = ({ url, video, alt, className, controls }) =>
  video
    ? <video src={url} className={className} muted playsInline loop autoPlay={controls} controls={controls} preload="metadata" aria-label={alt} />
    : <img src={url} alt={alt} className={className} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />;

const TABS: { key: Location; label: string; icon: React.ReactNode }[] = [
  { key: 'TRICKS_PAGE', label: 'Tips & Tricks', icon: <Lightbulb size={15} /> },
  { key: 'RULES_PAGE',  label: 'Rules / How to Play', icon: <BookOpen size={15} /> },
];

export const ContentSlideManager: React.FC = () => {
  const [activeTab, setActiveTab]   = useState<Location>('TRICKS_PAGE');
  const [slides, setSlides]         = useState<Slide[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showAdd, setShowAdd]       = useState(false);
  const [confirmDel, setConfirmDel] = useState<Slide | null>(null);

  // Form state
  const emptyForm = { title: '', fileUrl: '', mediaType: 'IMAGE' as 'IMAGE' | 'VIDEO', urlMode: true };
  const [form, setForm] = useState(emptyForm);
  const [uploading, setUploading]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadSlides = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<any>(`/api/admin/promo?location=${activeTab}`);
      if (res.data?.success) {
        setSlides((res.data.promos || []).sort((a: Slide, b: Slide) => b.priority - a.priority));
      }
    } catch { toast.error('Failed to load slides'); }
    finally { setLoading(false); }
  }, [activeTab]);

  useEffect(() => { loadSlides(); }, [loadSlides]);

  const handleFileUpload = async (file: File) => {
    setUploading(true);
    try {
      // The one upload every admin image uses: it says why a failure happened
      // (the file refused, storage settings missing, or storage refusing it).
      // Pro Tips also takes a video of at most 30 seconds.
      const { url, mediaType } = takesVideo(activeTab)
        ? await uploadReelMedia(file)
        : { url: await uploadImage(file, 'promo'), mediaType: 'IMAGE' as const };
      setForm(f => ({ ...f, fileUrl: url, mediaType, urlMode: false }));
      toast.success(`${mediaType === 'VIDEO' ? 'Video' : 'Image'} uploaded. Click Save to publish.`);
    } catch (e) {
      toast.error(errorMessage(e, 'Upload failed'));
    } finally { setUploading(false); }
  };

  const handleSave = async () => {
    if (!form.fileUrl.trim()) { toast.error('Provide an image URL or upload a file'); return; }
    // A pasted link is a video when it ends in .mp4 or .webm.
    const mediaType = form.urlMode ? mediaTypeOfUrl(form.fileUrl.trim()) : form.mediaType;
    setSaving(true);
    try {
      await api.post('/api/admin/promo', {
        title:     form.title.trim() || undefined,
        fileUrl:   form.fileUrl.trim(),
        location:  activeTab,
        mediaType,
        // Last in the list: one below the lowest now shown.
        priority:  slides.length ? Math.min(...slides.map(s => s.priority)) - 1 : 0,
        status:    'PUBLISHED',
      });
      toast.success('Slide added');
      setShowAdd(false);
      setForm(emptyForm);
      loadSlides();
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to save slide'); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (slide: Slide) => {
    // Hiding sends DRAFT: the server has no INACTIVE, and answered the old
    // toggle with 400 "Unknown promo status", so a slide could not be hidden.
    const newStatus = isLive(slide) ? 'DRAFT' : 'PUBLISHED';
    try {
      await api.put(`/api/admin/promo/${slide._id}`, { status: newStatus });
      setSlides(prev => prev.map(s => s._id === slide._id ? { ...s, status: newStatus } : s));
      toast.success(newStatus === 'PUBLISHED' ? 'Slide published' : 'Slide hidden');
    } catch { toast.error('Failed to update status'); }
  };

  // Moves a slide one place and numbers the whole list again (top = highest),
  // so the order players see is exactly the order here. A ±1 nudge could tie
  // with a neighbour and leave the order to the creation time.
  const moveSlide = async (slide: Slide, step: -1 | 1) => {
    const order = [...slides];
    const from = order.findIndex(s => s._id === slide._id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    const renumbered = order.map((s, i) => ({ ...s, priority: order.length - i }));
    const changed = renumbered.filter(s => slides.find(o => o._id === s._id)?.priority !== s.priority);
    try {
      await Promise.all(changed.map(s => api.put(`/api/admin/promo/${s._id}`, { priority: s.priority })));
      setSlides(renumbered);
    } catch {
      toast.error('Failed to update order');
      loadSlides();
    }
  };

  const handleDelete = async (slide: Slide) => {
    try {
      await api.delete(`/api/admin/promo/${slide._id}`);
      toast.success('Slide deleted');
      loadSlides();
    } catch { toast.error('Failed to delete'); }
    finally { setConfirmDel(null); }
  };

  return (
    <div className="om-fade space-y-6">
      <Toolbar actions={[
        { label: 'Refresh', icon: RefreshCw, onClick: loadSlides },
        { label: 'Add Slide', icon: Plus, primary: true, onClick: () => setShowAdd(true) },
      ]} />

      {/* Tabs */}
      <div className="flex gap-2 bg-dark-800 p-1 rounded-lg w-fit">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            aria-pressed={activeTab === tab.key}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors
              ${activeTab === tab.key ? 'bg-dark-600 text-white' : 'text-gray-400 hover:text-white'}`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Slide count info */}
      <div className="text-xs text-gray-500">
        {slides.filter(isLive).length} active slide(s) •&nbsp;
        {slides.filter(s => !isLive(s)).length} hidden —&nbsp;
        {takesVideo(activeTab)
          ? 'players swipe through active reels full screen, top to bottom in this order; videos play by themselves'
          : 'users see active slides in this order'}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="aspect-9/16 bg-dark-700 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : slides.length === 0 ? (
        <div className="card text-center py-16 text-gray-500">
          <ImageIcon size={48} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No slides yet</p>
          <p className="text-xs mt-1">Add images that users will see on the {TABS.find(t => t.key === activeTab)?.label} page</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {slides.map((slide, idx) => (
            <div
              key={slide._id}
              className={`relative rounded-xl overflow-hidden border transition-all
                ${isLive(slide)
                  ? 'border-gold-500/40 shadow-[0_0_12px_rgba(var(--gold-rgb),0.15)]'
                  : 'border-dark-600 opacity-50 grayscale'}`}
            >
              {/* Image */}
              <div className="aspect-9/16 bg-dark-800">
                {slide.fileUrl ? (
                  <SlideMedia url={slide.fileUrl} video={slide.mediaType === 'VIDEO'}
                    alt={slide.title || `Slide ${idx + 1}`} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600">
                    <ImageIcon size={32} />
                  </div>
                )}
              </div>

              {/* Overlay controls */}
              <div className="absolute inset-0 bg-linear-to-t from-black/80 via-transparent to-transparent flex flex-col justify-end p-2 gap-1">
                {slide.title && (
                  <p className="text-white text-xs font-medium truncate">{slide.title}</p>
                )}
                <div className="flex items-center justify-between">
                  {/* Priority arrows */}
                  <div className="flex gap-0.5">
                    <button
                      onClick={() => moveSlide(slide, -1)}
                      disabled={idx === 0}
                      className="p-1 bg-dark-700/80 rounded-sm hover:bg-dark-600 disabled:opacity-30"
                      title="Move up" aria-label="Move up"
                    >
                      <ArrowUp size={10} />
                    </button>
                    <button
                      onClick={() => moveSlide(slide, 1)}
                      disabled={idx === slides.length - 1}
                      className="p-1 bg-dark-700/80 rounded-sm hover:bg-dark-600 disabled:opacity-30"
                      title="Move down" aria-label="Move down"
                    >
                      <ArrowDown size={10} />
                    </button>
                  </div>
                  {/* Toggle + Delete */}
                  <div className="flex gap-0.5">
                    <button
                      onClick={() => toggleStatus(slide)}
                      className={`p-1 rounded-sm ${isLive(slide) ? 'bg-green-600/60 hover:bg-green-600' : 'bg-gray-600/60 hover:bg-gray-600'}`}
                      title={isLive(slide) ? 'Hide from users' : 'Publish'}
                      aria-label={isLive(slide) ? 'Hide from users' : 'Publish'}
                    >
                      {isLive(slide) ? <Eye size={10} /> : <EyeOff size={10} />}
                    </button>
                    <button
                      onClick={() => setConfirmDel(slide)}
                      className="p-1 bg-red-600/60 hover:bg-red-600 rounded-sm"
                      title="Delete"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
                <div className="text-[9px] text-gray-400 text-right">{slide.mediaType === 'VIDEO' ? '▶ Video · ' : ''}#{idx + 1}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Slide Modal */}
      {showAdd && (
        <Modal isOpen onClose={() => { setShowAdd(false); setForm(emptyForm); }} title={takesVideo(activeTab) ? 'Add Reel' : 'Add Slide'}>
          <div className="space-y-4">
            <p className="text-xs text-gray-400">
              Adding to: <span className="text-white font-medium">{TABS.find(t => t.key === activeTab)?.label}</span>
            </p>
            {/* FIX-15: Image spec guidance for content creators */}
            {takesVideo(activeTab) ? (
              <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2 text-[11px]">
                <p className="text-yellow-400 font-bold mb-0.5">📐 Reel size: full phone screen, like Instagram Reels</p>
                <p className="text-gray-400">Make it <span className="text-white font-mono">1080 × 1920 px</span> (portrait 9:16). It fills the screen, so keep text away from the edges.</p>
                <p className="text-gray-500 mt-0.5">Image: JPG, PNG or WEBP, up to 5 MB · Video: MP4 or WebM, up to 30 seconds and 50 MB. Videos play on their own, without sound until the player taps.</p>
              </div>
            ) : (
              <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2 text-[11px]">
                <p className="text-yellow-400 font-bold mb-0.5">📐 Recommended Image Spec</p>
                <p className="text-gray-400">Width: <span className="text-white font-mono">1200px</span> · Height: <span className="text-white font-mono">628px</span> · Resolution: <span className="text-white font-mono">72 DPI</span></p>
                <p className="text-gray-500 mt-0.5">Aspect ratio 16:9 · Max file size: 5 MB · Formats: JPG, PNG, WEBP</p>
              </div>
            )}

            {/* Upload mode toggle */}
            <div className="flex gap-2 bg-dark-800 p-1 rounded-lg">
              <button
                onClick={() => setForm(f => ({ ...f, urlMode: true }))}
                className={`flex-1 py-1.5 rounded text-xs font-medium flex items-center justify-center gap-1.5
                  ${form.urlMode ? 'bg-dark-600 text-white' : 'text-gray-400'}`}
              >
                <Link2 size={12} /> Paste URL
              </button>
              <button
                onClick={() => { setForm(f => ({ ...f, urlMode: false })); fileRef.current?.click(); }}
                className={`flex-1 py-1.5 rounded text-xs font-medium flex items-center justify-center gap-1.5
                  ${!form.urlMode ? 'bg-dark-600 text-white' : 'text-gray-400'}`}
              >
                <Upload size={12} /> {takesVideo(activeTab) ? 'Upload image or video' : 'Upload Image'}
              </button>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept={takesVideo(activeTab) ? 'image/*,video/mp4,video/webm' : 'image/*'}
              className="hidden"
              onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }}
            />

            {form.urlMode ? (
              <div>
                <label className="label" htmlFor="image-url-cdn-s3-direct-link">Image URL (CDN / S3 / direct link)</label>
                <input id="image-url-cdn-s3-direct-link"
                  type="url"
                  value={form.fileUrl}
                  onChange={e => setForm(f => ({ ...f, fileUrl: e.target.value }))}
                  placeholder="https://cdn.example.com/slide.jpg"
                  className="input"
                />
              </div>
            ) : (
              <div>
                <label className="label" htmlFor="image-url-after-upload">Image URL (after upload)</label>
                <input id="image-url-after-upload"
                  type="url"
                  value={form.fileUrl}
                  onChange={e => setForm(f => ({ ...f, fileUrl: e.target.value }))}
                  placeholder={uploading ? 'Uploading…' : 'Click "Upload Image" to select a file'}
                  readOnly={uploading}
                  className="input"
                />
                {uploading && (
                  <p className="text-xs text-gold-400 mt-1 animate-pulse">Uploading to CDN…</p>
                )}
              </div>
            )}

            {/* Preview */}
            {form.fileUrl && (
              <div className={`${takesVideo(activeTab) ? 'aspect-9/16 max-w-[220px] mx-auto' : 'aspect-video'} w-full rounded-lg overflow-hidden border border-dark-600 bg-dark-800`}>
                <SlideMedia url={form.fileUrl} controls
                  video={(form.urlMode ? mediaTypeOfUrl(form.fileUrl) : form.mediaType) === 'VIDEO'}
                  alt="Preview" className={`w-full h-full ${takesVideo(activeTab) ? 'object-cover' : 'object-contain'}`} />
              </div>
            )}

            <div>
              <label className="label" htmlFor="caption-optional">Caption (optional)</label>
              <input id="caption-optional"
                type="text"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Tip #1: Watch the pattern"
                className="input"
              />
            </div>

            <p className="text-[11px] text-gray-500">New ones go to the end of the list. Use the arrows on each tile to change the order.</p>

            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowAdd(false)} className="flex-1 btn-secondary">Cancel</button>
              <button
                onClick={handleSave}
                disabled={saving || uploading || !form.fileUrl.trim()}
                className="flex-1 btn-primary disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Slide'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {confirmDel && (
        <ConfirmDialog
          isOpen
          onClose={() => setConfirmDel(null)}
          onConfirm={() => handleDelete(confirmDel)}
          title="Delete Slide"
          message="This slide will be permanently removed from the page."
          type="danger"
        />
      )}
    </div>
  );
};
