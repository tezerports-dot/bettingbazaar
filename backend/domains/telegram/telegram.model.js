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
  //
  // OPTIONAL, and the reason matters: the bot registry (TelegramBot, below) is
  // the newer and preferred home for credentials, and `activeConfig` reads it
  // first. A generation created by the channel-flip path therefore embeds NO
  // bot at all — the token exists in exactly one place, so rotating it cannot
  // leave a stale second copy behind, and a database dump yields one ciphertext
  // per bot rather than one per generation.
  //
  // These fields remain for the combined activation form, which is what an
  // install that never registered a spare uses. "A config must have a reachable
  // bot" is still an invariant; it is enforced where it can actually be
  // evaluated — across both sources, in the admin route — rather than by a
  // `required` on one of the two.
  botTokenEncrypted: { type: String, select: false },
  botUsername:       { type: String, trim: true, default: '' },
  // Telegram calls the webhook with this in X-Telegram-Bot-Api-Secret-Token.
  // It is how we know an update really came from Telegram.
  webhookSecret:     { type: String, select: false },

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
// TELEGRAM BOT REGISTRY — every bot the platform owns, live or held in reserve
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The config document above carries the bot that was live when a generation was
 * created. That is enough to RUN, and not enough to RECOVER: replacing a
 * suspended bot meant pasting a fresh token into the activation form at the
 * moment of the incident, having first created the bot, named it, and verified
 * it — minutes of setup during an outage where nobody can sign up.
 *
 * This registry exists so that work happens BEFORE the incident. A spare bot is
 * added, verified against Telegram, and parked as STANDBY. When the live bot
 * dies, promoting the spare is one click on a row that already exists.
 *
 * ── Why bots live outside the generation ────────────────────────────────────
 * Generation exists for the CHANNEL: a cached "this user is a member" is only
 * meaningful for the channel it was observed in, so swapping channels must
 * invalidate every cached answer, which the generation counter does by
 * construction.
 *
 * Swapping a BOT invalidates nothing. Identities are keyed on the person's
 * Telegram user id — a property of Telegram, not of our bot — so the same
 * people, the same phone numbers and the same channel memberships survive a bot
 * swap untouched. Tying bot replacement to a generation bump would therefore
 * force every player to re-join the channel to fix a problem that never touched
 * the channel. They are separate operations because they have separate blast
 * radii.
 */
export const BOT_ROLES = ['signin', 'recovery', 'broadcast', 'moderation', 'generic'];

/**
 * Roles of which exactly one may be live.
 *
 * Sign-in and recovery are addressed by INBOUND webhooks, and an update is
 * authenticated by comparing its secret token against the live bot's. Two live
 * sign-in bots would mean the check compared against whichever row a
 * non-deterministic read returned first — updates from the genuine bot rejected
 * at random. Broadcast, moderation and generic bots are outbound only, so any
 * number of them may be live at once.
 */
export const SINGULAR_BOT_ROLES = new Set(['signin', 'recovery']);

const telegramBotSchema = new mongoose.Schema({
  // What an operator calls it in the panel. Free text; carries no meaning.
  label: { type: String, required: true, trim: true },
  role:  { type: String, enum: BOT_ROLES, required: true, index: true },

  // Telegram's numeric id for the bot — its real identity, unlike the @username
  // which can be changed by whoever controls it. UNIQUE, so the same bot cannot
  // be registered twice under two labels and leave "which row is live?" to
  // whichever one a query happened to return.
  botId:    { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, trim: true },

  // Same posture as the config's token: ciphertext, never selected by default,
  // never returned to any panel. Whoever holds it can speak as the platform.
  tokenEncrypted: { type: String, required: true, select: false },
  webhookSecret:  { type: String, required: true, select: false },

  // STANDBY is the point of this collection: verified, paid for, ready, unused.
  // RETIRED rows are kept rather than deleted so an incident review can answer
  // "what were we running on the 14th?".
  status: { type: String, enum: ['ACTIVE', 'STANDBY', 'RETIRED'], default: 'STANDBY', index: true },

  /**
   * DERIVED, and deliberately so — it exists only to be indexed.
   *
   * Set to `role` for a live bot in a singular role, absent otherwise. The
   * sparse unique index below then makes "at most one live sign-in bot" a rule
   * the DATABASE enforces rather than one every writer has to remember.
   *
   * It is maintained by the pre-validate hook, which means writers must go
   * through a document `.save()`. `updateOne` bypasses Mongoose hooks entirely,
   * so an update that set `status` without also setting this field would leave
   * the invariant unguarded — `telegramBots.service.js` uses `.save()` for
   * exactly that reason.
   */
  liveSlot: { type: String, default: undefined },

  webhookUrl:          { type: String, default: '' },
  webhookRegisteredAt: { type: Date },
  // Whatever Telegram last said when it refused — the first thing an operator
  // needs when a promotion does not take.
  lastError:  { type: String, default: '' },

  addedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  addedAt:     { type: Date, default: Date.now },
  activatedAt: { type: Date },
  activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  retiredAt:   { type: Date },
  retiredBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes:       { type: String, default: '' },
}, { collection: 'telegram_bots' });

telegramBotSchema.pre('validate', function setLiveSlot() {
  const live = this.status === 'ACTIVE' && SINGULAR_BOT_ROLES.has(this.role);
  this.liveSlot = live ? this.role : undefined;
});

// Sparse: rows without a liveSlot are not indexed at all, so any number of
// standby, retired and multi-role bots coexist. Unique: two rows claiming the
// same singular slot cannot both be written.
telegramBotSchema.index(
  { liveSlot: 1 },
  { unique: true, sparse: true, name: 'one_live_bot_per_singular_role' },
);

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE TEMPLATES — the bot's words, editable without a deploy
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The first thing a player ever reads from this platform is the bot's welcome
 * message, and it is the message most likely to need changing: it carries the
 * warning that the Telegram account must be on the Aadhaar-linked mobile, and
 * getting that wording wrong shows up as a wave of failed verifications.
 *
 * Held as rows keyed by name, with the shipped copy as the fallback. A missing
 * or blank row therefore means "use the default" — never "send nothing", which
 * would leave a player staring at silence after /start.
 */
const telegramTemplateSchema = new mongoose.Schema({
  key:  { type: String, required: true, unique: true, index: true },
  // Telegram HTML: <b>, <i>, <a href>, <code>. Validated on write.
  body: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { collection: 'telegram_templates' });

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

// ═══════════════════════════════════════════════════════════════════════════
// LOGIN TOKEN — the bridge from a Telegram chat to a browser session
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The bot cannot hand the browser a session directly, so it sends a link
 * carrying a one-time token which the site exchanges for a real session.
 *
 * That link is a bearer credential for the seconds it lives, and it travels
 * through a chat the player might forward, so it is deliberately hostile to
 * reuse: single-use (`consumedAt` is set inside the same atomic update that
 * reads it), short-lived (minutes, via TTL), and bound to the Telegram account
 * it was issued to so a stolen link cannot mint a session for anyone else.
 *
 * The token itself is stored as a SHA-256 hash. A database dump therefore
 * yields nothing usable, exactly as with a password — the plaintext exists only
 * in the message Telegram delivered.
 */
const telegramLoginTokenSchema = new mongoose.Schema({
  tokenHash:      { type: String, required: true, unique: true, index: true },
  telegramUserId: { type: String, required: true, index: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  consumedAt:     { type: Date, default: null },
  createdAt:      { type: Date, default: Date.now },
  // The TTL index owns { expiresAt: 1 } — no field-level index here.
  expiresAt:      { type: Date, required: true },
}, { collection: 'telegram_login_tokens' });

telegramLoginTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TelegramLoginToken  = mongoose.model('TelegramLoginToken', telegramLoginTokenSchema);
export const TelegramConfig      = mongoose.model('TelegramConfig', telegramConfigSchema);
export const TelegramBot         = mongoose.model('TelegramBot', telegramBotSchema);
export const TelegramTemplate    = mongoose.model('TelegramTemplate', telegramTemplateSchema);
export const TelegramIdentity    = mongoose.model('TelegramIdentity', telegramIdentitySchema);
export const TelegramPendingLink = mongoose.model('TelegramPendingLink', telegramPendingLinkSchema);
