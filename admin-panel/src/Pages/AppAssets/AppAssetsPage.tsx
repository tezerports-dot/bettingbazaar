// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// APP-ASSETS-PAGE-V1
/**
 * AppAssetsPage.tsx — Admin Panel › App Assets
 * Upload logos, icons, and splash directly to the backend (no CDN).
 * Files served at /app-assets/:filename. Changes are live immediately.
 */
import React, { useEffect, useState, useRef } from 'react';
import { Upload, Trash2, RefreshCw, CheckCircle, ImageIcon, Info } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface AssetSlot {
  name: string; label: string; width: number; height: number; hint: string;
  uploaded: boolean; url: string | null; size: number | null; updatedAt: string | null;
}

const fmt = (b: number | null) => !b ? '—' : b > 1048576 ? `${(b/1048576).toFixed(1)} MB` : `${Math.round(b/1024)} KB`;

const AssetCard: React.FC<{
  slot: AssetSlot;
  onUpload: (slot: string, file: File) => Promise<void>;
  onDelete: (slot: string) => Promise<void>;
  uploading: boolean;
}> = ({ slot, onUpload, onDelete, uploading }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(slot.url || null);
  useEffect(() => { setPreview(slot.url || null); }, [slot.url, slot.updatedAt]);

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) { toast.error('Only image files allowed'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('Max 5 MB per file'); return; }
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result as string);
    reader.readAsDataURL(file);
    onUpload(slot.name, file);
  };

  const isWide = slot.width > slot.height * 2;
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-white font-semibold text-sm truncate">{slot.label}</span>
            {slot.uploaded && <CheckCircle size={14} className="text-green-400 flex-shrink-0" />}
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5">{slot.name}</div>
          <div className="text-[10px] text-slate-600 mt-1">
            Required: <span className="text-yellow-400 font-bold">{slot.width}×{slot.height}px</span>
            {slot.size != null && <span className="ml-2">· {fmt(slot.size)}</span>}
          </div>
        </div>
        {slot.uploaded && (
          <button onClick={() => onDelete(slot.name)} disabled={uploading}
            className="flex-shrink-0 p-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 text-red-400 transition-colors disabled:opacity-40">
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div
        className={`relative cursor-pointer group ${isWide ? 'h-24' : 'h-36'} bg-[repeating-conic-gradient(#1e293b_0%_25%,#0f172a_0%_50%)] bg-[length:16px_16px]`}
        onClick={() => !uploading && inputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
      >
        {preview
          ? <img src={preview} alt={slot.label} className="absolute inset-0 w-full h-full object-contain p-2" />
          : <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 group-hover:text-slate-400 transition-colors">
              <ImageIcon size={28} className="mb-1" /><span className="text-[10px]">No image uploaded</span>
            </div>
        }
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none">
          <div className="flex items-center gap-1.5 bg-black/70 text-white text-xs px-3 py-1.5 rounded-full">
            <Upload size={12} /> {slot.uploaded ? 'Replace' : 'Upload'}
          </div>
        </div>
        {uploading && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <RefreshCw size={20} className="animate-spin text-yellow-400" />
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-slate-800 flex items-start gap-1.5">
        <Info size={11} className="text-slate-600 mt-0.5 flex-shrink-0" />
        <span className="text-[10px] text-slate-600 leading-relaxed">{slot.hint}</span>
      </div>

      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
    </div>
  );
};

export const AppAssetsPage: React.FC = () => {
  const [slots, setSlots]         = useState<AssetSlot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});

  const load = async () => {
    setIsLoading(true);
    try {
      const res = await api.appAssets.getAll();
      if (res?.success) setSlots(res.slots);
      else toast.error('Failed to load assets');
    } catch { toast.error('Failed to load assets'); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleUpload = async (slotName: string, file: File) => {
    setUploading(u => ({ ...u, [slotName]: true }));
    const res = await api.appAssets.upload(slotName, file);
    if (res.success) { toast.success(`${slotName} uploaded — live immediately`); await load(); }
    else toast.error(res.message || 'Upload failed');
    setUploading(u => ({ ...u, [slotName]: false }));
  };

  const handleDelete = async (slotName: string) => {
    if (!confirm(`Remove ${slotName}? App will fall back to the built-in default.`)) return;
    const res = await api.appAssets.delete(slotName);
    if (res.success) { toast.success(`${slotName} removed`); await load(); }
    else toast.error(res.message || 'Delete failed');
  };

  const ORDER = ['logo.png','logo-header.png','icon-192.png','icon-512.png','icon-apple-180.png','favicon-32.png','splash.png'];
  const sorted = [...slots].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">App Assets</h1>
          <p className="text-xs text-slate-500 mt-1">Upload logos, icons, and splash screen. No CDN needed — files are served directly and go live immediately.</p>
        </div>
        <button onClick={load} disabled={isLoading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50">
          <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="mb-6 p-4 bg-blue-950/40 border border-blue-900/40 rounded-xl">
        <div className="text-xs font-semibold text-blue-300 mb-2 flex items-center gap-1.5"><Info size={13} /> Required Image Sizes — use transparent PNG</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[10px] text-slate-400 font-mono">
          {[['logo.png','512×512'],['logo-header.png','600×120'],['icon-192.png','192×192'],
            ['icon-512.png','512×512'],['icon-apple-180.png','180×180'],['favicon-32.png','32×32'],['splash.png','1242×2688']
          ].map(([n,s]) => <span key={n}>{n} — <b className="text-white">{s}</b></span>)}
        </div>
        <p className="text-[10px] text-slate-600 mt-2">Transparent backgrounds blend naturally with the dark app theme. Max 5 MB each. Drag & drop or click to upload.</p>
      </div>

      {isLoading ? (
        <div className="text-center py-20 text-slate-600">
          <RefreshCw size={32} className="mx-auto mb-4 animate-spin opacity-40" />
          <div className="text-sm">Loading…</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sorted.map(slot => (
            <AssetCard key={slot.name} slot={slot}
              onUpload={handleUpload} onDelete={handleDelete}
              uploading={!!uploading[slot.name]} />
          ))}
        </div>
      )}
    </div>
  );
};
