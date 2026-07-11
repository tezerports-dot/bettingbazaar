// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: CMS / Branding. Metadata record for admin-uploaded app assets (PWA
// icons, logos, splash) — one document per fixed slot. This is the multi-instance
// source of truth for "which slots are uploaded and where they live", so app-asset
// listing no longer depends on a single instance's local disk. The bytes go to S3
// when configured (shared across instances) or local disk as a graceful fallback;
// this record stores the resulting public URL + storage backend either way.
import mongoose from 'mongoose';

const appAssetSchema = new mongoose.Schema({
  slot:        { type: String, required: true, unique: true }, // e.g. 'icon-512.png'
  url:         { type: String, required: true },               // public URL (CDN/S3 or /app-assets/…)
  storage:     { type: String, enum: ['S3', 'LOCAL'], default: 'LOCAL' },
  fileKey:     { type: String, default: '' },                  // S3 object key (blank for LOCAL)
  size:        { type: Number, default: 0 },
  contentType: { type: String, default: '' },
  updatedAt:   { type: Date, default: Date.now },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

export const AppAsset = mongoose.model('AppAsset', appAssetSchema);
