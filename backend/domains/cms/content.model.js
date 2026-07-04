// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const promoContentSchema = new mongoose.Schema({
  title: { type: String },
  description: String,
  // ✅ FIX #14: FAQ fields - admin routes use PromoContent for FAQs
  type: { type: String, enum: ['PROMO', 'FAQ', 'BANNER', 'ANNOUNCEMENT'], default: 'PROMO', index: true },
  question: { type: String },               // For FAQ type
  answer: { type: String },                 // For FAQ type
  category: { type: String, enum: ['general', 'betting', 'payment', 'kyc', 'technical', 'account', 'security', 'gameplay', 'support', 'payments'], default: 'general', index: true },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: { type: Date, default: Date.now },
  location: { type: String, enum: ['HOME_POPUP', 'TRICKS_PAGE', 'RULES_PAGE', 'FAQ_PAGE'], index: true },
  mediaType: { type: String, enum: ['IMAGE', 'VIDEO'], default: 'IMAGE' },
  fileUrl: String,
  priority: { type: Number, default: 0 },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  createdAt: { type: Date, default: Date.now }
});

// ════════════════════════════════════════════════════════════════════════════
// 💱 TOKEN RATES SCHEMA - ✅ FIX #4: ADMIN-CONTROLLED PRICING
// ════════════════════════════════════════════════════════════════════════════
// Admin sets BB token buy and sell prices
// Merchant profit = (buyRate - sellRate) * tokenAmount
const brandingSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  // ── Core identity ──────────────────────────────────────────────────────────
  appName:           { type: String, default: 'Betting Bazaar' },
  logo:              { type: String, default: '' },
  icon:              { type: String, default: '' },
  favicon:           { type: String, default: '' },        // browser tab icon
  splashScreen:      { type: String, default: '' },        // PWA loading image
  // ── Panel names (GOVERNANCE §1: Branding is sole authority for panel titles) ─
  userPanelName:        { type: String, default: 'Betting Bazaar' },
  adminPanelName:       { type: String, default: 'Bazaar Admin' },
  merchantPanelName:    { type: String, default: 'Merchant Panel' },
  queueManagerPanelName:{ type: String, default: 'Queue Manager' },
  // ── Brand colours ─────────────────────────────────────────────────────────
  primaryColor:      { type: String, default: '#D4AF37' },
  secondaryColor:    { type: String, default: '#8B5CF6' },
  accentColor:       { type: String, default: '#F59E0B' },
  // ── Copy ──────────────────────────────────────────────────────────────────
  tagline:           { type: String, default: 'Your Premier Betting Platform' },
  description:       { type: String, default: 'Safe, secure, and exciting betting experience' },
  contactEmail:      { type: String, default: '' },
  contactPhone:      { type: String, default: '' },
  // ── CDN base URL — used by getAssetUrl() ──────────────────────────────────
  cdnBaseUrl:        { type: String, default: '' },
  // ── Home popup (GOVERNANCE §2: must have real consumer — GameContext reads these) ─
  homePopupImageUrl: { type: String, default: '' },
  homePopupLinkUrl:  { type: String, default: '' },
  homePopupEnabled:  { type: Boolean, default: false },
  // ── Promo/banner URLs (GOVERNANCE §2: consumed by PromoPage, RulesPage, WalletModal) ─
  tricksTipsBannerUrl:    { type: String, default: '' },
  rulesPageImageUrl:      { type: String, default: '' },
  depositPageBannerUrl:   { type: String, default: '' },
  withdrawalPageBannerUrl:{ type: String, default: '' },
  loginPageBannerUrl:     { type: String, default: '' },
  registerPageBannerUrl:  { type: String, default: '' },
  lastUpdated: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

// ════════════════════════════════════════════════════════════════════════════
// 🖼️ CDN IMAGE SCHEMA
// ════════════════════════════════════════════════════════════════════════════
const cdnImageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  category: { 
    type: String, 
    // AUDIT: Added 'misc' (used by admin CDN manager as catch-all) and kept all others.
    // Must match the validCategories array in admin.routes.js POST /branding/images.
    enum: ['promo', 'banner', 'avatar', 'kyc', 'payment_proof', 'logo', 'icon', 'misc', 'other'], 
    required: true,
    index: true
  },
  title: { type: String },
  description: { type: String },
  tags: [{ type: String }],
  mimeType: { type: String },
  fileSize: { type: Number },
  dimensions: {
    width: { type: Number },
    height: { type: Number }
  },
  isPublic: { type: Boolean, default: true },
  usageCount: { type: Number, default: 0 },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  uploadedAt: { type: Date, default: Date.now, index: true }
});

cdnImageSchema.index({ category: 1, uploadedAt: -1 });

// ════════════════════════════════════════════════════════════════════════════
// ❓ FAQ SCHEMA
// ════════════════════════════════════════════════════════════════════════════
const faqSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  category: { 
    type: String, 
    enum: ['general', 'account', 'betting', 'payments', 'kyc', 'security', 'technical'],
    default: 'general',
    index: true
  },
  order: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: true },
  views: { type: Number, default: 0 },
  tags: [{ type: String }],
  relatedFAQs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FAQ' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

faqSchema.index({ category: 1, order: 1 });
faqSchema.index({ isPublished: 1, createdAt: -1 });

// ════════════════════════════════════════════════════════════════════════════
// 🔗 SUPPORT LINKS SCHEMA
// ════════════════════════════════════════════════════════════════════════════
const supportLinksSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  email: { type: String },
  phone: { type: String },
  whatsapp: { type: String },
  telegram: { type: String },
  instagram: { type: String },
  facebook: { type: String },
  twitter: { type: String },
  youtube: { type: String },
  linkedin: { type: String },
  supportHours: { type: String, default: '24/7' },
  responseTime: { type: String, default: 'Within 2 hours' },
  helpCenterUrl: { type: String },
  tutorialUrl: { type: String },
  termsUrl: { type: String },
  privacyUrl: { type: String },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

// ════════════════════════════════════════════════════════════════════════════
// 🚨 DISPUTE SCHEMA
// ════════════════════════════════════════════════════════════════════════════
const announcementSchema = new mongoose.Schema({
  title:     { type: String, required: true },
  body:      { type: String, required: true },
  type:      { type: String, enum: ['INFO', 'WARNING', 'PROMO', 'MAINTENANCE'], default: 'INFO' },
  priority:  { type: Number, default: 0 },  // higher = shown first
  isActive:  { type: Boolean, default: true, index: true },
  expiresAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now, index: true },
});
export const Announcement = mongoose.model('Announcement', announcementSchema);

// ---------------------------------------------------------------------------
// SPIN WHEEL — daily lucky spin for bonus
// ---------------------------------------------------------------------------

export const PromoContent  = mongoose.model('PromoContent',  promoContentSchema);
export const Branding      = mongoose.model('Branding',      brandingSchema);
export const CDNImage      = mongoose.model('CDNImage',      cdnImageSchema);
export const FAQ           = mongoose.model('FAQ',           faqSchema);
export const SupportLinks  = mongoose.model('SupportLinks',  supportLinksSchema);
