// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

// ---------------------------------------------------------------------------
// ACCOUNT RECOVERY REQUEST — initiated by user via PAN + Aadhaar video KYC.
// Flow: user submits → admin reviews video → approves → system generates
//        temp password → admin shares credentials with user.
// ---------------------------------------------------------------------------
const accountRecoverySchema = new mongoose.Schema({
  requestId:     { type: String, required: true, unique: true, index: true },
  // Identifying fields (all encrypted/hashed server-side before storage)
  mobile:        { type: String, required: true },
  panHash:       { type: String, required: true, index: true }, // SHA-256(PAN)
  panLast4:      { type: String, required: true },
  aadhaarLast4:  { type: String, required: true },   // last 4 digits only
  // Resolved user
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  // Video KYC proof
  videoUrl:      { type: String, default: '' },      // S3 presigned CDN URL
  videoKey:      { type: String, default: '' },      // S3 key
  videoUploadedAt: { type: Date },
  // Request state
  status: {
    type: String,
    enum: ['PENDING_VIDEO', 'VIDEO_UPLOADED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'],
    default: 'PENDING_VIDEO',
    index: true,
  },
  // Admin action
  reviewedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt:    { type: Date },
  rejectReason:  { type: String, default: '' },
  adminNote:     { type: String, default: '' },
  // Credential dispatch (temp password hashed, shared once by admin)
  tempPassword:  { type: String, default: '' },      // bcrypt hash of temp password
  credentialsSent: { type: Boolean, default: false },
  // Rate-limit: track IP + mobile to prevent abuse
  requestIp:     { type: String, default: '' },
  attempts:      { type: Number, default: 1 },
  createdAt:     { type: Date, default: Date.now, index: true },
  updatedAt:     { type: Date, default: Date.now },
});
accountRecoverySchema.index({ mobile: 1, createdAt: -1 });
export const AccountRecovery = mongoose.model('AccountRecovery', accountRecoverySchema);

