// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * One image slot on the Images page: where it shows, the size to make it, a
 * preview drawn in the slot's own frame, and Upload / Replace / Paste a CDN
 * link / Remove. The slot only STAGES a change: the owner of the value saves
 * it (owner, 2026-10-10: "option to see preview before saving or removing or
 * replacing").
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Upload, Trash2, Link2, Undo2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { errorMessage, naturalSize, shapeFits, uploadImage, type UploadKind } from '../../services/imageUpload';

export interface SlotSpec {
  label: string;
  /** Where on the player's screen it appears. */
  where: string;
  /** Who sees it (device examples). */
  examples?: string;
  /** The frame it is drawn in, width : height; null = drawn at its own shape. */
  ratio: { w: number; h: number } | null;
  /** The pixel size to make it. */
  upload: { w: number; h: number };
  /** How wide to draw the preview, in px. */
  previewWidth: number;
}

export const ImageSlot: React.FC<{
  spec: SlotSpec;
  /** What is saved now. */
  saved: string;
  /** What is staged (equal to `saved` when nothing changed). */
  value: string;
  onChange: (url: string) => void;
  kind: UploadKind;
}> = ({ spec, saved, value, onChange, kind }) => {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState('');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let live = true;
    setSize(null);
    if (value) naturalSize(value).then((s) => { if (live) setSize(s); });
    return () => { live = false; };
  }, [value]);

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      onChange(await uploadImage(file, kind));
      toast.success('Uploaded. Check the preview, then Save.');
    } catch (e) {
      toast.error(errorMessage(e, 'Upload failed'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const changed = value !== saved;
  const fits = spec.ratio ? shapeFits(size, spec.ratio) : null;
  const ratioText = spec.ratio ? `${spec.ratio.w}:${spec.ratio.h}` : 'its own shape';

  return (
    <div className="rounded-lg border border-dark-600 bg-dark-800/60 p-4 space-y-3" aria-labelledby={`${id}-t`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div id={`${id}-t`} className="font-semibold text-white">{spec.label}</div>
          <div className="text-xs text-gray-400 mt-0.5">{spec.where}</div>
          {spec.examples && <div className="text-xs text-gray-500 mt-0.5">{spec.examples}</div>}
        </div>
        <div className="text-right flex-none">
          <div className="text-xs font-mono text-gold-400">{spec.upload.w} × {spec.upload.h} px</div>
          <div className="text-[11px] text-gray-500">frame {ratioText}</div>
        </div>
      </div>

      {/* The preview, in the slot's own frame at the size it will appear. */}
      <div style={{ width: '100%', maxWidth: spec.previewWidth }}>
        <div className="relative overflow-hidden rounded-md border border-dark-600 bg-dark-900"
          style={spec.ratio ? { aspectRatio: `${spec.ratio.w} / ${spec.ratio.h}` } : { minHeight: 80 }}>
          {value ? (
            <img src={value} alt={`${spec.label} preview`} className="block w-full"
              style={spec.ratio ? { height: '100%', objectFit: 'cover' } : { height: 'auto' }} />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 text-center px-2">
              {spec.previewWidth >= 160 && spec.ratio ? `No image. Make it ${spec.upload.w} × ${spec.upload.h} px.` : 'No image'}
            </div>
          )}
          {changed && <span className="absolute top-1.5 left-1.5 rounded bg-gold-500 px-1.5 py-0.5 text-[10px] font-bold text-dark-900">Not saved</span>}
        </div>
      </div>

      {value && size && (
        <div className={`text-xs flex items-center gap-1 ${fits === false ? 'text-amber-400' : 'text-gray-500'}`} role={fits === false ? 'status' : undefined}>
          {fits === false && <AlertTriangle size={12} />}
          This image is {size.w} × {size.h} px.
          {fits === false && ` The frame is ${ratioText}, so its edges will be cut. Make it ${spec.upload.w} × ${spec.upload.h} px to show it whole.`}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <input ref={fileRef} id={`${id}-file`} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        <button type="button" className="btn-secondary text-xs flex items-center gap-1 disabled:opacity-50" disabled={busy}
          onClick={() => fileRef.current?.click()}>
          <Upload size={13} />{busy ? 'Uploading…' : value ? 'Replace' : 'Upload'}
        </button>
        <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => setPasting((p) => !p)} aria-expanded={pasting}>
          <Link2 size={13} />Paste a CDN link
        </button>
        {value && (
          <button type="button" className="btn-secondary text-xs flex items-center gap-1 text-red-300" onClick={() => onChange('')}>
            <Trash2 size={13} />Remove
          </button>
        )}
        {changed && (
          <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => onChange(saved)}>
            <Undo2 size={13} />Undo
          </button>
        )}
      </div>
      {pasting && (
        <div className="flex gap-2">
          <label htmlFor={`${id}-paste`} className="sr-only">CDN link for {spec.label}</label>
          <input id={`${id}-paste`} type="url" className="input text-sm font-mono flex-1" placeholder="https://cdn…/image.png"
            value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button type="button" className="btn-secondary text-xs" disabled={!paste.trim()}
            onClick={() => { onChange(paste.trim()); setPaste(''); setPasting(false); }}>Preview</button>
        </div>
      )}
    </div>
  );
};

export default ImageSlot;
