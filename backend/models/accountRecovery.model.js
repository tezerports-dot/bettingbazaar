// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

// ---------------------------------------------------------------------------
// ACCOUNT RECOVERY REQUEST — initiated by user via PAN + Aadhaar video KYC.
// Flow: user submits → admin reviews video → approves → system generates
//        temp password → admin shares credentials with user.
// ---------------------------------------------------------------------------
// ── This schema is the CONTRACT the route and both panels already speak ──────
// It previously described a different, PAN-based flow: it required `requestId`,
// `panHash`, `panLast4` and `aadhaarLast4`, and enumerated uppercase statuses
// (PENDING_VIDEO/UNDER_REVIEW/…). The live flow is Aadhaar + video KYC and
// writes `recoveryId`, `fullName`, `dob`, `videoKycUrl` with lowercase statuses.
//
// Nothing reconciled the two, so EVERY recovery submission failed schema
// validation and returned 500, the status lookup queried a field that did not
// exist, and an admin approval could not save. Account recovery — the only way a
// locked-out player reaches their balance — did not work at all.
//
// The route and the user/admin panels agree with each other, so the model is
// what moves. Fields are optional unless the flow genuinely cannot proceed
// without them, so a partially-filled request is still reviewable by a human
// rather than rejected by the database.
const accountRecoverySchema = new mongoose.Schema({
  recoveryId:    { type: String, required: true, unique: true, index: true },
  // Identifying fields. The Aadhaar NUMBER is never stored — the account is
  // located by keyed hash (aadhaarHash.util), and only the last four digits are
  // kept, so an admin can eyeball the request against the video.
  mobile:        { type: String, required: true },
  fullName:      { type: String, default: '' },
  dob:           { type: String, default: '' },      // YYYY-MM-DD as submitted
  aadhaarLast4:  { type: String, default: '' },
  // Resolved user. OPTIONAL on purpose: a submission whose Aadhaar matches no
  // account is still recorded, so the response can stay neutral (never
  // confirming whether an Aadhaar is registered here) while a human still sees
  // the request and can help someone who simply mistyped.
  // Not `index: true` — the partial unique index below already covers
  // { userId: 1 }. Two index declarations on one key pattern with different
  // options is the shape MongoDB rejects, and it is invisible until something
  // actually builds the indexes.
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Video KYC proof
  videoKycUrl:   { type: String, default: '' },      // S3 CDN URL
  videoKycKey:   { type: String, default: '' },      // S3 key
  selfieUrl:     { type: String, default: '' },
  videoUploadedAt: { type: Date },
  // Request state
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  },
  // Admin action
  processedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  processedAt:   { type: Date },
  adminNote:     { type: String, default: '' },
  // Credential dispatch — the HASH only. The plain temporary password exists
  // solely in the approve response and is never persisted.
  tempPassword:  { type: String, default: '' },
  credentialsSent: { type: Boolean, default: false },
  // Abuse forensics
  requestIp:     { type: String, default: '' },
  attempts:      { type: Number, default: 1 },
  createdAt:     { type: Date, default: Date.now, index: true },
  updatedAt:     { type: Date, default: Date.now },
});
accountRecoverySchema.index({ mobile: 1, createdAt: -1 });
// The route rejects a second OPEN request per account; this makes that the
// database's rule rather than a read-then-write.
accountRecoverySchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending', userId: { $exists: true } }, name: 'one_open_recovery_per_user' },
);
export const AccountRecovery = mongoose.model('AccountRecovery', accountRecoverySchema);

