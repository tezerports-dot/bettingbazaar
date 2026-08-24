// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/telegram/telegram.model.js — the Telegram identity layer.
 *
 * Authentication moves off passwords entirely for PLAYERS: a person proves who
 * they are by controlling a Telegram account, sharing that account's phone
 * number through the bot, and joining the official channel. Admins and
 * merchants keep password + TOTP — their credentials must not depend on a
 * third party that can suspend an account.
 *
 * ── The replaceability requirement drives the shape ─────────────────────────
 * A bot can be banned and a channel can be lost, and neither may cost the
 * platform its users. So nothing here stores "the bot" as an implicit global:
 * the active bot/channel lives in ONE config document that an admin can replace
 * from the panel, and every identity records WHICH generation of that config it
 * was created under. Replacing the bot bumps the generation; existing links
 * keep working because they are keyed on the person's Telegram user id, which
 * is a property of Telegram, not of our bot.
 */
import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM CONFIG — the replaceable bot + channel, one active document
// ═══════════════════════════════════════════════════════════════════════════
const telegramConfigSchema = new mongoose.Schema({
  // Monotonic. Bumped every time an admin swaps the bot or the channel, so an
  // identity can say which era it was created in and the enforcement layer can
  // tell "has not joined the CURRENT channel" from "joined an older one".
  generation: { type: Number, required: true, unique: true, index: true },

  // ── Primary bot (signup / login) ─────────────────────────────────────────
  // Ciphertext (fieldCrypto). Whoever holds a bot token can read every message
  // sent to the bot and speak as the platform, so it is never stored in clear
  // and never returned to any panel.
  botTokenEncrypted: { type: String, required: true, select: false },
  botUsername:       { type: String, required: true, trim: true },
  // Telegram calls the webhook with this in X-Telegram-Bot-Api-Secret-Token.
  // It is how we know an update really came from Telegram.
  webhookSecret:     { type: String, required: true, select: false },

  // ── Recovery bot (separate, so a compromised primary cannot self-recover) ──
  recoveryBotTokenEncrypted: { type: String, select: false },
  recoveryBotUsername:       { type: String, trim: true, default: '' },
  recoveryWebhookSecret:     { type: String, select: false },

  // ── Official channel ─────────────────────────────────────────────────────
  // channelId is the numeric -100… id the Bot API needs; the username and invite
  // link are what a human is shown.
  channelId:         { type: String, required: true, trim: true },
  channelUsername:   { type: String, trim: true, default: '' },
  channelInviteLink: { type: String, trim: true, default: '' },

  // No `index: true` here: the partial unique index below already covers
  // { active: 1 }. Declaring both creates two indexes with the SAME key pattern
  // and different options, which MongoDB refuses with IndexOptionsConflict.
  active:     { type: Boolean, default: false },
  activatedAt: { type: Date },
  activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Why this generation replaced the previous one — read during incident review.
  reason:     { type: String, default: '' },
  createdAt:  { type: Date, default: Date.now },
}, { collection: 'telegram_configs' });

// At most one active config. A partial unique index makes that the database's
// rule rather than something every writer has to remember: activating a new
// generation must deactivate the old one in the same transaction or fail.
telegramConfigSchema.index(
  { active: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'one_active_telegram_config' },
);

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM IDENTITY — one Telegram account ↔ one platform user
// ═══════════════════════════════════════════════════════════════════════════
const telegramIdentitySchema = new mongoose.Schema({
  // Telegram's own id for the person. Stable across username changes and
  // independent of which bot they talk to, which is what makes replacing the
  // bot non-destructive. UNIQUE: one Telegram account cannot hold two accounts.
  telegramUserId: { type: String, required: true, unique: true, index: true },

  // UNIQUE: and one platform account cannot be driven by two Telegram accounts.
  // Together these two constraints are the whole no-duplicate-accounts story,
  // enforced by the database rather than by a check-then-insert.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

  telegramUsername: { type: String, trim: true, default: '' },
  firstName:        { type: String, trim: true, default: '' },

  // ── The shared contact ───────────────────────────────────────────────────
  // Telegram only reveals a phone number when the person taps "Share contact",
  // and it is Telegram's own verified number for that account — which is why it
  // can stand in for an SMS OTP. Normalised to digits, no country prefix
  // punctuation, so it compares to User.mobile.
  // Indexed by the partial unique index below, not here — same key pattern.
  phone:           { type: String, required: true },
  contactSharedAt: { type: Date, required: true },
  // Cleared if the person later revokes/changes their number — payout
  // eligibility requires this to still be true.
  contactActive:   { type: Boolean, default: true, index: true },

  // ── Channel membership (cached; authoritative source is Telegram) ────────
  // Kept as a cache updated by `chat_member` webhook events, with a TTL sweep
  // for anyone whose event we missed. Polling getChatMember per request does
  // not survive the member counts this platform is planning for.
  channelStatus:    { type: String, enum: ['member', 'administrator', 'creator', 'restricted', 'left', 'kicked', 'unknown'], default: 'unknown', index: true },
  channelCheckedAt: { type: Date },
  // The config generation whose channel the status above refers to. When an
  // admin swaps the channel this goes stale by construction, and the gate then
  // treats the user as "must join the new channel".
  channelGeneration: { type: Number, default: 0, index: true },

  // Which generation they originally linked under — audit only.
  linkedGeneration: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, index: true },
  lastSeenAt: { type: Date },
}, { collection: 'telegram_identities' });

// The phone is an identity anchor: two Telegram accounts sharing one number
// must not become two platform accounts. UNIQUE among contact-active rows only,
// so a person who genuinely moves their number to a new Telegram account (the
// recovery-bot path) is not blocked by their own retired row.
telegramIdentitySchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { contactActive: true }, name: 'one_active_identity_per_phone' },
);

// ═══════════════════════════════════════════════════════════════════════════
// PENDING LINK — the short-lived state of an onboarding conversation
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Onboarding is a conversation across several messages (Aadhaar → contact →
 * channel), and the bot is stateless between updates. This holds that state.
 *
 * It is deliberately SEPARATE from TelegramIdentity: nothing here has proven
 * anything yet, and a half-finished signup must never be mistaken for an
 * account. Rows expire on their own so an abandoned conversation cleans up.
 */
const telegramPendingLinkSchema = new mongoose.Schema({
  telegramUserId: { type: String, required: true, unique: true, index: true },
  step: {
    type: String,
    enum: ['AWAITING_AADHAAR', 'AWAITING_CONTACT', 'AWAITING_CHANNEL', 'COMPLETE'],
    default: 'AWAITING_AADHAAR',
  },
  // Captured in order; none of it is trusted until the step that proves it.
  aadhaarHash:      { type: String, default: null },
  aadhaarEncrypted: { type: String, default: null, select: false },
  aadhaarLast4:     { type: String, default: '' },
  phone:            { type: String, default: null },
  telegramUsername: { type: String, default: '' },
  firstName:        { type: String, default: '' },
  // Referral attribution is recorded HERE, at first contact with the bot,
  // because that is the only moment the deep-link payload exists. Carrying it
  // forward to the created account is what makes referral links work.
  referralCode:     { type: String, default: null, index: true },
  generation:       { type: Number, default: 0 },
  createdAt:        { type: Date, default: Date.now },
  // TTL: an abandoned onboarding disappears after 24h rather than holding a
  // phone or an Aadhaar hash indefinitely.
  // The TTL index below owns { expiresAt: 1 }; a plain index here would collide.
  expiresAt:        { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
}, { collection: 'telegram_pending_links' });

telegramPendingLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TelegramConfig      = mongoose.model('TelegramConfig', telegramConfigSchema);
export const TelegramIdentity    = mongoose.model('TelegramIdentity', telegramIdentitySchema);
export const TelegramPendingLink = mongoose.model('TelegramPendingLink', telegramPendingLinkSchema);
