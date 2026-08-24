// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/identity/kycVerification.model.js — Aadhaar KYC, verified in bulk.
 *
 * ── The workflow this models ────────────────────────────────────────────────
 * KYC is not a document upload any more. The player gives an Aadhaar number to
 * the Telegram bot and shares the phone number of the Telegram account they are
 * signing up with. Those two facts are exported together to an outside verifier,
 * who checks that the Aadhaar is genuine and that the phone is the one linked to
 * it, and returns YES or NO per row. Only YES activates payouts and betting.
 *
 * ── Why the number is stored encrypted rather than only hashed ──────────────
 * The rest of the platform stores Aadhaar as an HMAC (aadhaarHash.util.js) and
 * that is still what enforces "one account per Aadhaar" — a hash compares, and
 * comparison is all the uniqueness rule needs. But the verifier genuinely needs
 * the NUMBER to check it, so the export cannot be built from hashes.
 *
 * The number is therefore kept as AES-256-GCM ciphertext (fieldCrypto.util.js),
 * decrypted only while an export is being streamed to an authenticated admin,
 * and never written to disk on the server. A database dump yields ciphertext,
 * not identities. This is the narrowest arrangement that still lets the
 * verification happen at all.
 *
 * Nothing here is a substitute for handling Aadhaar lawfully — retention, who
 * may hold it, and what the verifier may do with it are policy decisions the
 * operator owns. The model just refuses to make them worse than necessary.
 */
import mongoose from 'mongoose';

const kycVerificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

  // UNIQUE — the no-duplicate-accounts rule, enforced by the database. Two
  // people cannot register the same Aadhaar, and it is a hash so the index
  // reveals nothing.
  aadhaarHash:      { type: String, required: true, unique: true, index: true },
  // Ciphertext. `select: false` so it is never returned by an ordinary query —
  // reaching it takes a deliberate `.select('+aadhaarEncrypted')`, which exists
  // in exactly one place (the audited export).
  aadhaarEncrypted: { type: String, required: true, select: false },
  // Shown to operators instead of the number. Enough to match a query, useless
  // to an attacker.
  aadhaarLast4:     { type: String, required: true },

  // The Telegram-verified phone this Aadhaar is claimed to belong to. The
  // verifier's whole job is confirming these two agree.
  phone: { type: String, required: true, index: true },

  status: {
    type: String,
    enum: ['PENDING_VERIFICATION', 'VERIFIED', 'FAILED'],
    default: 'PENDING_VERIFICATION',
    index: true,
  },

  // ── Batch trail ──────────────────────────────────────────────────────────
  // Which export a row went out in and which import decided it. Two rows with
  // the same exportBatchId went to the verifier together, which is what makes a
  // disputed result traceable to a specific file.
  exportBatchId: { type: String, default: null, index: true },
  exportedAt:    { type: Date },
  importBatchId: { type: String, default: null, index: true },
  verifiedAt:    { type: Date },
  // Verbatim from the verifier when a row comes back NO, so support can tell a
  // player why without guessing.
  failureReason: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'kyc_verifications' });

// The export query: everything still awaiting a verdict, oldest first.
kycVerificationSchema.index({ status: 1, createdAt: 1 });

kycVerificationSchema.pre('save', function () {
  this.updatedAt = new Date();
});

// ═══════════════════════════════════════════════════════════════════════════
// KYC BATCH — one export or one import, as an auditable record
// ═══════════════════════════════════════════════════════════════════════════
const kycBatchSchema = new mongoose.Schema({
  batchId:   { type: String, required: true, unique: true, index: true },
  kind:      { type: String, enum: ['EXPORT', 'IMPORT'], required: true, index: true },
  // EXPORT rows are Aadhaar numbers leaving the platform. Recording who asked
  // and when is the difference between a controlled disclosure and a leak
  // nobody can reconstruct afterwards.
  actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rowCount:  { type: Number, default: 0 },
  verifiedCount: { type: Number, default: 0 },
  failedCount:   { type: Number, default: 0 },
  skippedCount:  { type: Number, default: 0 },
  note:      { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true },
}, { collection: 'kyc_batches' });

export const KycVerification = mongoose.model('KycVerification', kycVerificationSchema);
export const KycBatch        = mongoose.model('KycBatch', kycBatchSchema);
