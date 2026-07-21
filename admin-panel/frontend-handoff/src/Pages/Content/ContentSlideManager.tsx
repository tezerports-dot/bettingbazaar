// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ContentSlideManager.tsx
 *
 * Admin page to manage full-screen image slides for:
 *   - TRICKS_PAGE  → user Promo / Tips & Tricks page
 *   - RULES_PAGE   → user Rules / How to Play page
 *
 * Each slide = one PromoContent document with:
 *   location : TRICKS_PAGE | RULES_PAGE
 *   fileUrl  : CDN URL of the image
 *   title    : caption shown below image (optional)
 *   priority : sort order (higher = shown first)
 *   status   : ACTIVE | INACTIVE
 *
 * Admin can:
 *   1. Upload images directly (presigned S3 URL flow)
 *   2. Paste an existing CDN URL
 *   3. Reorder via priority number
 *   4. Toggle active/inactive (hides from users without deleting)
 *   5. Delete
 */

import React, { useEffect, useState, useRef } from 'react';
import {
  Upload, Link2, Trash2, Eye, EyeOff, Plus, RefreshCw,
  ArrowUp, ArrowDown, Image as ImageIcon, BookOpen, Lightbulb,
} from 'lucide-react';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import api from '../../services/api';
import toast from 'react-hot-toast';

type Location = 'TRICKS_PAGE' | 'RULES_PAGE';

interface Slide {
  _id: string;
  title?: string;
  fileUrl?: string;
  priority: number;
  status: 'ACTIVE' | 'INACTIVE';
  location: Location;
  createdAt: string;
}

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
  const [form, setForm] = useState({ title: '', fileUrl: '', priority: 0, urlMode: true });
  const [uploading, setUploading]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadSlides(); }, [activeTab]);

  const loadSlides = async () => {
    setLoading(true);
    try {
      const res = await api.get<any>(`/api/admin/promo?location=${activeTab}`);
      if (res.data?.success) {
        setSlides((res.data.promos || []).sort((a: Slide, b: Slide) => b.priority - a.priority));
      }
    } catch { toast.error('Failed to load slides'); }
    finally { setLoading(false); }
  };

  const handleFileUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) { toast.error('Only image files are supported'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('Max file size is 5 MB'); return; }
    setUploading(true);
    try {
      // Step 1: Get presigned URL from backend
      const urlRes = await api.post<any>('/api/admin/promo/upload-url', {
        fileName:    file.name,
        contentType: file.type,
        fileSize:    file.size,
        location:    activeTab.toLowerCase(),
      });
      if (!urlRes.data?.success) throw new Error(urlRes.data?.message || 'Upload URL failed');
      const { uploadUrl, cdnUrl } = urlRes.data;

      // Step 2: PUT directly to S3
      const putRes = await fetch(uploadUrl, {
        method:  'PUT',
        body:    file,
        headers: { 'Content-Type': file.type },
      });
      if (!putRes.ok) throw new Error('S3 upload failed');

      setForm(f => ({ ...f, fileUrl: cdnUrl, urlMode: false }));
      toast.success('Image uploaded — click Save to publish');
    } catch (e: any) {
      toast.error(e.message || 'Upload failed');
    } finally { setUploading(false); }
  };

  const handleSave = async () => {
    if (!form.fileUrl.trim()) { toast.error('Provide an image URL or upload a file'); return; }
    setSaving(true);
    try {
      await api.post('/api/admin/promo', {
        title:     form.title.trim() || undefined,
        fileUrl:   form.fileUrl.trim(),
        location:  activeTab,
        mediaType: 'IMAGE',
        priority:  form.priority,
        status:    'ACTIVE',
      });
      toast.success('Slide added');
      setShowAdd(false);
      setForm({ title: '', fileUrl: '', priority: 0, urlMode: true });
      loadSlides();
    } catch { toast.error('Failed to save slide'); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (slide: Slide) => {
    const newStatus = slide.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await api.put(`/api/admin/promo/${slide._id}`, { status: newStatus });
      setSlides(prev => prev.map(s => s._id === slide._id ? { ...s, status: newStatus } : s));
      toast.success(newStatus === 'ACTIVE' ? 'Slide published' : 'Slide hidden');
    } catch { toast.error('Failed to update status'); }
  };

  const changePriority = async (slide: Slide, delta: number) => {
    const newPriority = slide.priority + delta;
    try {
      await api.put(`/api/admin/promo/${slide._id}`, { priority: newPriority });
      setSlides(prev =>
        prev.map(s => s._id === slide._id ? { ...s, priority: newPriority } : s)
          .sort((a, b) => b.priority - a.priority)
      );
    } catch { toast.error('Failed to update order'); }
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-1">Content Slides</h1>
          <p className="text-gray-400 text-sm">
            Manage full-screen image slides shown to users on the Promo and Rules pages.
            Images are displayed in a swipeable carousel — higher priority = shown first.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadSlides} className="btn-secondary flex items-center gap-1">
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-1">
            <Plus size={14} /> Add Slide
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 bg-dark-800 p-1 rounded-lg w-fit">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors
              ${activeTab === tab.key ? 'bg-dark-600 text-white' : 'text-gray-400 hover:text-white'}`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Slide count info */}
      <div className="text-xs text-gray-500">
        {slides.filter(s => s.status === 'ACTIVE').length} active slide(s) •&nbsp;
        {slides.filter(s => s.status === 'INACTIVE').length} hidden —&nbsp;
        users see active slides in swipeable full-screen view
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="aspect-[9/16] bg-dark-700 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : slides.length === 0 ? (
        <div className="card text-center py-16 text-gray-500">
          <ImageIcon size={48} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No slides yet</p>
          <p className="text-xs mt-1">Add images that users will see on the {activeTab === 'TRICKS_PAGE' ? 'Tips & Tricks' : 'Rules'} page</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {slides.map((slide, idx) => (
            <div
              key={slide._id}
              className={`relative rounded-xl overflow-hidden border transition-all
                ${slide.status === 'ACTIVE'
                  ? 'border-gold-500/40 shadow-[0_0_12px_rgba(212,175,55,0.15)]'
                  : 'border-dark-600 opacity-50 grayscale'}`}
            >
              {/* Image */}
              <div className="aspect-[9/16] bg-dark-800">
                {slide.fileUrl ? (
                  <img
                    src={slide.fileUrl}
                    alt={slide.title || `Slide ${idx + 1}`}
                    className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600">
                    <ImageIcon size={32} />
                  </div>
                )}
              </div>

              {/* Overlay controls */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex flex-col justify-end p-2 gap-1">
                {slide.title && (
                  <p className="text-white text-xs font-medium truncate">{slide.title}</p>
                )}
                <div className="flex items-center justify-between">
                  {/* Priority arrows */}
                  <div className="flex gap-0.5">
                    <button
                      onClick={() => changePriority(slide, 1)}
                      className="p-1 bg-dark-700/80 rounded hover:bg-dark-600"
                      title="Move up"
                    >
                      <ArrowUp size={10} />
                    </button>
                    <button
                      onClick={() => changePriority(slide, -1)}
                      className="p-1 bg-dark-700/80 rounded hover:bg-dark-600"
                      title="Move down"
                    >
                      <ArrowDown size={10} />
                    </button>
                  </div>
                  {/* Toggle + Delete */}
                  <div className="flex gap-0.5">
                    <button
                      onClick={() => toggleStatus(slide)}
                      className={`p-1 rounded ${slide.status === 'ACTIVE' ? 'bg-green-600/60 hover:bg-green-600' : 'bg-gray-600/60 hover:bg-gray-600'}`}
                      title={slide.status === 'ACTIVE' ? 'Hide from users' : 'Publish'}
                    >
                      {slide.status === 'ACTIVE' ? <Eye size={10} /> : <EyeOff size={10} />}
                    </button>
                    <button
                      onClick={() => setConfirmDel(slide)}
                      className="p-1 bg-red-600/60 hover:bg-red-600 rounded"
                      title="Delete"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
                <div className="text-[9px] text-gray-400 text-right">#{slide.priority}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Slide Modal */}
      {showAdd && (
        <Modal isOpen onClose={() => { setShowAdd(false); setForm({ title: '', fileUrl: '', priority: 0, urlMode: true }); }} title="Add Slide">
          <div className="space-y-4">
            <p className="text-xs text-gray-400">
              Adding to: <span className="text-white font-medium">{activeTab === 'TRICKS_PAGE' ? 'Tips & Tricks' : 'Rules / How to Play'}</span>
            </p>
            {/* FIX-15: Image spec guidance for content creators */}
            <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2 text-[11px]">
              <p className="text-yellow-400 font-bold mb-0.5">📐 Recommended Image Spec</p>
              <p className="text-gray-400">Width: <span className="text-white font-mono">1200px</span> · Height: <span className="text-white font-mono">628px</span> · Resolution: <span className="text-white font-mono">72 DPI</span></p>
              <p className="text-gray-500 mt-0.5">Aspect ratio 16:9 · Max file size: 5 MB · Formats: JPG, PNG, WEBP</p>
            </div>

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
                <Upload size={12} /> Upload Image
              </button>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }}
            />

            {form.urlMode ? (
              <div>
                <label className="label">Image URL (CDN / S3 / direct link)</label>
                <input
                  type="url"
                  value={form.fileUrl}
                  onChange={e => setForm(f => ({ ...f, fileUrl: e.target.value }))}
                  placeholder="https://cdn.example.com/slide.jpg"
                  className="input"
                />
              </div>
            ) : (
              <div>
                <label className="label">Image URL (after upload)</label>
                <input
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
              <div className="aspect-video w-full rounded-lg overflow-hidden border border-dark-600 bg-dark-800">
                <img src={form.fileUrl} alt="Preview" className="w-full h-full object-contain" />
              </div>
            )}

            <div>
              <label className="label">Caption (optional)</label>
              <input
                type="text"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Tip #1: Watch the pattern"
                className="input"
              />
            </div>

            <div>
              <label className="label">Priority (higher = shown first)</label>
              <input
                type="number"
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: parseInt(e.target.value) || 0 }))}
                className="input"
              />
            </div>

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
