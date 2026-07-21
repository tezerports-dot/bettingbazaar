// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Link2, Trash2, Copy, Plus, Image, ExternalLink } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import api from '../../services/api';
import type { CDNImage } from '../../types';
import toast from 'react-hot-toast';

// CDN Library — manages CDN URLs (zero-upload setup, 0 RAM usage)
// Admin pastes CDN URLs from their CDN provider (e.g. Cloudflare, BunnyCDN, etc.)
// and gives them a title/category so they can be referenced across all panels.

const CATEGORIES: CDNImage['category'][] = ['promo', 'banner', 'avatar', 'logo', 'icon', 'kyc', 'payment_proof', 'other'];

export const CDNManager: React.FC = () => {
  const [images, setImages] = useState<CDNImage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [showAddModal, setShowAddModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<CDNImage | null>(null);

  const [form, setForm] = useState({
    url: '',
    title: '',
    category: 'other' as CDNImage['category'],
    description: '',
    tags: '',
  });
  const [previewError, setPreviewError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => { loadImages(); }, [categoryFilter]);

  const loadImages = async () => {
    setIsLoading(true);
    try {
      const res = await api.cdn.getImages(categoryFilter === 'ALL' ? undefined : categoryFilter);
      if (res.success && res.data) setImages(res.data);
    } catch { toast.error('Failed to load CDN library'); }
    finally { setIsLoading(false); }
  };

  const handleAdd = async () => {
    if (!form.url) { toast.error('CDN URL is required'); return; }
    if (!form.title) { toast.error('Title is required'); return; }
    if (!form.url.startsWith('http')) { toast.error('Enter a valid URL (http/https)'); return; }
    setIsSaving(true);
    try {
      // Save as CDN URL entry (backend stores url + metadata, no file upload)
      await (api.cdn as any).addUrl?.({
        url: form.url,
        title: form.title,
        category: form.category,
        description: form.description,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
      });
      toast.success('CDN URL added to library');
      setShowAddModal(false);
      setForm({ url: '', title: '', category: 'other', description: '', tags: '' });
      setPreviewError(false);
      loadImages();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to add URL'); }
    finally { setIsSaving(false); }
  };

  const handleDelete = async (imageId: string) => {
    try {
      await api.cdn.deleteImage(imageId);
      toast.success('Removed from CDN library');
      loadImages();
    } catch { toast.error('Failed to delete'); }
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success('URL copied to clipboard');
  };

  const filteredImages = images.filter(img => categoryFilter === 'ALL' || img.category === categoryFilter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">CDN Library</h1>
          <p className="text-gray-400">Manage CDN URLs for images used across all panels — zero file upload, zero RAM usage</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary flex items-center">
          <Plus size={15} className="mr-1" /> Add CDN URL
        </button>
      </div>

      {/* Info Banner */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 text-sm">
        <p className="font-semibold text-blue-400 mb-2">How it works</p>
        <p className="text-gray-300">Upload images to your CDN provider (Cloudflare Images, BunnyCDN, Cloudinary, etc.), paste the public URL here, assign a category and title. These URLs are then available across all three panels (user app, merchant, admin) and referenced in Branding, Promo Content, and KYC flows.</p>
      </div>

      {/* Category Filter */}
      <div className="card">
        <div className="flex flex-wrap gap-2">
          {['ALL', ...CATEGORIES].map((cat) => (
            <button key={cat} onClick={() => setCategoryFilter(cat)}
              className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors capitalize ${categoryFilter === cat ? 'bg-gold-500 text-dark-900' : 'bg-dark-700 text-gray-300 hover:bg-dark-600'}`}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card"><p className="text-sm text-gray-400 mb-1">Total URLs</p><p className="text-2xl font-bold">{images.length}</p></div>
        {['promo', 'banner', 'logo', 'icon'].map((cat) => (
          <div key={cat} className="card">
            <p className="text-sm text-gray-400 mb-1 capitalize">{cat}</p>
            <p className="text-2xl font-bold">{images.filter(i => i.category === cat).length}</p>
          </div>
        ))}
      </div>

      {/* Image Grid */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : filteredImages.length === 0 ? (
        <EmptyState icon={Image} title="No CDN URLs" description="Add your first CDN URL to get started" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredImages.map((img) => (
            <div key={img._id} className="card space-y-3">
              {/* Preview */}
              <div className="relative bg-dark-800 rounded-lg overflow-hidden h-40 flex items-center justify-center">
                <img src={img.url} alt={img.title} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  className="max-h-full max-w-full object-contain" />
                <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 bg-black/50 transition-opacity">
                  <a href={img.url} target="_blank" rel="noreferrer" className="p-2 bg-white/20 rounded-full mr-2"><ExternalLink size={16}/></a>
                </div>
              </div>

              <div>
                <p className="font-semibold truncate">{img.title}</p>
                <span className="text-xs px-2 py-0.5 bg-dark-700 rounded-full capitalize">{img.category}</span>
                {img.description && <p className="text-xs text-gray-400 mt-1 truncate">{img.description}</p>}
              </div>

              <div className="flex items-center gap-2">
                <p className="flex-1 text-xs font-mono text-gray-500 truncate">{img.url}</p>
                <button onClick={() => copyUrl(img.url)} className="p-1.5 hover:bg-dark-700 rounded text-gray-400 hover:text-white" title="Copy URL"><Copy size={13}/></button>
                <button onClick={() => setConfirmDelete(img)} className="p-1.5 hover:bg-red-600/20 rounded text-red-400" title="Delete"><Trash2 size={13}/></button>
              </div>

              {img.tags && img.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {img.tags.slice(0, 3).map((tag, i) => <span key={i} className="text-xs px-1.5 py-0.5 bg-dark-800 text-gray-400 rounded">{tag}</span>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add CDN URL Modal */}
      {showAddModal && (
        <Modal isOpen={showAddModal} onClose={() => { setShowAddModal(false); setPreviewError(false); }} title="Add CDN URL">
          <div className="space-y-4">
            <div className="bg-dark-800 rounded-lg p-3 text-xs text-gray-400">
              <p>Paste the public CDN URL of your image. No files are uploaded to our server — only the URL is saved.</p>
            </div>

            <div>
              <label htmlFor="cdn-url" className="label">CDN Image URL *</label>
              <input id="cdn-url" name="cdnUrl" type="url" value={form.url}
                onChange={(e) => { setForm(f => ({ ...f, url: e.target.value })); setPreviewError(false); }}
                className="input font-mono text-sm" placeholder="https://cdn.yourdomain.com/images/banner.png" />
            </div>

            {/* URL Preview */}
            {form.url && !previewError && (
              <div className="bg-dark-800 rounded-lg p-3">
                <p className="text-xs text-gray-400 mb-2">Preview:</p>
                <img src={form.url} alt="Preview" onError={() => setPreviewError(true)}
                  className="max-h-32 max-w-full rounded object-contain mx-auto" />
              </div>
            )}
            {previewError && <p className="text-xs text-red-400">⚠️ Could not preview this URL. Make sure it's a valid public image URL.</p>}

            <div>
              <label htmlFor="cdn-title" className="label">Title *</label>
              <input id="cdn-title" name="title" type="text" value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} className="input" placeholder="e.g. Home page banner" />
            </div>

            <div>
              <label htmlFor="cdn-category" className="label">Category</label>
              <select id="cdn-category" name="category" value={form.category} onChange={(e) => setForm(f => ({ ...f, category: e.target.value as any }))} className="input">
                {CATEGORIES.map((cat) => <option key={cat} value={cat} className="capitalize">{cat}</option>)}
              </select>
            </div>

            <div>
              <label htmlFor="cdn-desc" className="label">Description</label>
              <input id="cdn-desc" name="description" type="text" value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} className="input" placeholder="Optional" />
            </div>

            <div>
              <label htmlFor="cdn-tags" className="label">Tags (comma-separated)</label>
              <input id="cdn-tags" name="tags" type="text" value={form.tags} onChange={(e) => setForm(f => ({ ...f, tags: e.target.value }))} className="input" placeholder="home, promo, seasonal" />
            </div>

            <div className="flex gap-3">
              <button onClick={() => { setShowAddModal(false); setPreviewError(false); }} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={handleAdd} disabled={isSaving} className="flex-1 btn-primary disabled:opacity-50">{isSaving ? 'Saving...' : 'Add to Library'}</button>
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDialog isOpen={!!confirmDelete} onClose={() => setConfirmDelete(null)}
          onConfirm={() => { handleDelete(confirmDelete._id); setConfirmDelete(null); }}
          title="Remove from CDN Library"
          message={`Remove "${confirmDelete.title}" from the CDN library? The actual image on your CDN will NOT be deleted.`}
          type="danger" confirmText="Remove" />
      )}
    </div>
  );
};
