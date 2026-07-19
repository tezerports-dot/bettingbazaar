// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

export const PUBLIC_CHAT_RETENTION_MS = 5 * 60 * 60 * 1000;

const fakeWinnerSchema = new mongoose.Schema({
  // Display fields (all editable from admin)
  displayName: { type: String, required: true },
  profilePic:  { type: String, default: '' },      // URL — uploaded to S3 / CDN
  city:        { type: String, default: '' },        // "Mumbai", "Delhi" etc
  amount:      { type: Number, required: true },     // Amount won (INR)
  game:        { type: String, default: 'Delhi/Bombay' }, // Which game
  badge:       { type: String, default: '' },        // "Big Win", "Jackpot" etc
  // Real user link (optional — leave null for synthetic entries)
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Display control
  isPublic:    { type: Boolean, default: true, index: true },
  sortOrder:   { type: Number, default: 0 },        // Lower = shown first
  // Timestamp shown to users (can be overridden for realism)
  displayTime: { type: Date, default: Date.now },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});
fakeWinnerSchema.index({ isPublic: 1, sortOrder: 1, displayTime: -1 });
export const FakeWinner = mongoose.model('FakeWinner', fakeWinnerSchema);

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
const chatRoomConfigSchema = new mongoose.Schema({
  key:     { type: String, default: 'main', unique: true },
  enabled: { type: Boolean, default: false },

  // Access control
  minBalanceToChat:   { type: Number, default: 0 },   
  requireKYC:        { type: Boolean, default: true },

  // Message rules
  maxMessageLength:  { type: Number, default: 200 },   // chars
  messageCooldownMs: { type: Number, default: 3000 },  // ms between messages per user
  linksAllowed:      { type: Boolean, default: false }, // URLs in text messages
  imagesAllowed:     { type: Boolean, default: false }, // Image attachments
  requireImageApproval: { type: Boolean, default: true },// Images queue before showing

  // Content filters
  profanityFilter:   { type: Boolean, default: true },
  bannedWords:       [{ type: String }],               // Exact words to block

  
  welcomeMessage:    { type: String, default: '🎰 Welcome to BettingBazaar Chat! Keep it fun & friendly.' },
  pinnedMessage:     { type: String, default: '' },    // Admin-pinned message

  updatedBy:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt:         { type: Date, default: Date.now },
});
export const ChatRoomConfig = mongoose.model('ChatRoomConfig', chatRoomConfigSchema);

// ---------------------------------------------------------------------------

// TTL index auto-deletes non-support chat messages older than 5 hours
// ---------------------------------------------------------------------------
const publicChatMsgSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  displayName: { type: String, required: true },    // Cached at time of posting
  profilePic:  { type: String, default: '' },
  vipLevel:    { type: Number, default: 0 },        // For badge display

  type:        { type: String, enum: ['text', 'image', 'system', 'gif'], default: 'text' },
  content:     { type: String, required: true, maxlength: 500 },  // Text OR image URL
  imageKey:    { type: String },                    // S3 key for images

  // Image approval flow
  status:      { type: String, enum: ['live', 'pending_approval', 'rejected', 'auto_rejected'], default: 'live', index: true },
  approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt:  { type: Date },
  rejectReason:{ type: String },

  // Moderation
  isDeleted:   { type: Boolean, default: false, index: true },
  deletedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  deletedAt:   { type: Date },
  reportCount: { type: Number, default: 0 },

  createdAt:   { type: Date, default: Date.now, index: true },
  // TTL: auto-delete after 5 hours; support-ticket messages use SupportMsg and are retained separately.
  expiresAt:   { type: Date, default: () => new Date(Date.now() + PUBLIC_CHAT_RETENTION_MS), index: { expireAfterSeconds: 0 } },
});
publicChatMsgSchema.index({ status: 1, isDeleted: 1, createdAt: -1 });
export const PublicChatMsg = mongoose.model('PublicChatMsg', publicChatMsgSchema);

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
const chatBanSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason:   { type: String, required: true },
  banUntil: { type: Date, default: null }, // null = permanent
  createdAt:{ type: Date, default: Date.now },
});
export const ChatBan = mongoose.model('ChatBan', chatBanSchema);

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
const supportTicketSchema = new mongoose.Schema({
  ticketId:   { type: String, required: true, unique: true, index: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subject:    { type: String, required: true, maxlength: 200 },
  category:   { type: String, enum: ['payment','account','game','bonus','technical','other'], default: 'other' },
  priority:   { type: String, enum: ['low','medium','high','urgent'], default: 'medium' },
  status:     { type: String, enum: ['open','assigned','waiting_user','resolved','closed'], default: 'open', index: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assignedAt: { type: Date },
  resolvedAt: { type: Date },
  closedAt:   { type: Date },
  // CSAT rating given by user after resolution (1-5)
  rating:     { type: Number, min: 1, max: 5 },
  ratingNote: { type: String },
  lastReplyAt:{ type: Date, default: Date.now },
  createdAt:  { type: Date, default: Date.now, index: true },
});
supportTicketSchema.index({ status: 1, assignedTo: 1 });
supportTicketSchema.index({ userId: 1, status: 1 });
export const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);

// ---------------------------------------------------------------------------
// SUPPORT MESSAGE — individual message in a support ticket
// ---------------------------------------------------------------------------
const supportMsgSchema = new mongoose.Schema({
  ticketId:    { type: mongoose.Schema.Types.ObjectId, ref: 'SupportTicket', required: true, index: true },
  senderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderType:  { type: String, enum: ['user','agent','system','bot'], default: 'user' },
  content:     { type: String, required: true, maxlength: 2000 },
  attachments: [{ url: String, type: String }],   // Images / screenshots
  isRead:      { type: Boolean, default: false },
  readAt:      { type: Date },
  createdAt:   { type: Date, default: Date.now, index: true },
});
supportMsgSchema.index({ ticketId: 1, createdAt: 1 });
export const SupportMsg = mongoose.model('SupportMsg', supportMsgSchema);
// ===========================================================================
// PAN CARD REGISTRY & ACCOUNT RECOVERY
// ===========================================================================

// ---------------------------------------------------------------------------
// PAN REGISTRY — stores hashed PAN (never raw) mapped to userId.
// SHA-256(PAN.toUpperCase().trim()) is the lookup key.
// Used to enforce: one account per PAN card across the platform.
// ---------------------------------------------------------------------------
const panRegistrySchema = new mongoose.Schema({
  panHash:  { type: String, required: true, unique: true }, // SHA-256(PAN)
  panLast4: { type: String, required: true },   // last 4 chars for admin display
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  verifiedAt: { type: Date, default: Date.now },
});
export const PANRegistry = mongoose.model('PANRegistry', panRegistrySchema);


