// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramOnboarding.service.js — turning a Telegram
 * conversation into an account.
 *
 * The flow, in the order the player experiences it:
 *
 *   /start [referralCode]   → attribution recorded, Aadhaar requested
 *   12-digit Aadhaar        → held (hashed + encrypted), contact requested
 *   "Share contact" tap     → phone proven by Telegram, account CREATED
 *   joins the channel       → onboarding COMPLETE, login link issued
 *
 * ── Where the account is actually created ───────────────────────────────────
 * At the CONTACT step, not at /start and not at channel join. Before the
 * contact there is nothing verified — anyone can type an Aadhaar. After it,
 * Telegram has vouched for the phone number, which is the same assurance an SMS
 * OTP would give and the point at which an identity exists.
 *
 * Channel membership is then a gate on ACTING, not on existing: the account is
 * real, it simply cannot bet or touch the wallet until the player joins. That
 * separation is what lets an admin swap the channel later without invalidating
 * anybody's account.
 *
 * ── Duplicates are refused by the database, not by a lookup ─────────────────
 * Three unique constraints do the work: one identity per Telegram account, one
 * identity per platform user, one active identity per phone — plus one KYC row
 * per Aadhaar hash. Every "is this taken?" read here is a courtesy that
 * produces a friendly message; correctness comes from the write failing.
 */
import mongoose from 'mongoose';
import { TelegramIdentity, TelegramPendingLink } from './telegram.model.js';
import { KycVerification } from '../identity/kycVerification.model.js';
import { hashAadhaar, hashAadhaarCandidates } from '../identity/aadhaarHash.util.js';
import { encryptField } from '../identity/fieldCrypto.util.js';
import { nextJoiningNumber, generateReferralCode, recordEarningsFor } from '../referral/referral.service.js';
import { activeConfig } from './telegramClient.js';

/** Telegram gives phone numbers with or without a +; store digits only. */
export function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  // Indian numbers arrive as 91XXXXXXXXXX from Telegram and are stored as the
  // 10-digit subscriber number, which is what User.mobile already holds.
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export function isValidAadhaar(raw) {
  return /^\d{12}$/.test(String(raw || '').replace(/[\s-]/g, ''));
}

// ── Step 1: /start ──────────────────────────────────────────────────────────

/**
 * Begin (or restart) an onboarding conversation.
 *
 * Referral attribution is captured HERE and nowhere else: the deep-link payload
 * exists only on this first message, so if it is not recorded now it is gone.
 */
export async function beginOnboarding({ telegramUserId, username, firstName, referralCode }) {
  const cfg = await activeConfig();

  // Already has an account? Then this is a login, not a signup.
  const existing = await TelegramIdentity.findOne({ telegramUserId: String(telegramUserId) }).lean();
  if (existing) return { alreadyLinked: true, userId: existing.userId };

  await TelegramPendingLink.findOneAndUpdate(
    { telegramUserId: String(telegramUserId) },
    {
      $set: {
        step: 'AWAITING_AADHAAR',
        telegramUsername: username || '',
        firstName: firstName || '',
        generation: cfg?.generation ?? 0,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      // Only on insert: a returning user restarting the flow must not lose the
      // referrer they originally arrived with.
      $setOnInsert: { referralCode: referralCode || null },
    },
    { upsert: true, new: true },
  );
  return { alreadyLinked: false, step: 'AWAITING_AADHAAR' };
}

// ── Step 2: Aadhaar ─────────────────────────────────────────────────────────

/**
 * Record the Aadhaar the player typed.
 *
 * Held on the pending row, not on an account — there is no account yet. It is
 * hashed for the duplicate check and encrypted for the eventual verification
 * export in the same breath, so the plaintext never rests anywhere.
 */
export async function submitAadhaar({ telegramUserId, aadhaar }) {
  const pending = await TelegramPendingLink.findOne({ telegramUserId: String(telegramUserId) });
  if (!pending) return { ok: false, reason: 'no_session' };
  if (!isValidAadhaar(aadhaar)) return { ok: false, reason: 'invalid_format' };

  const normalised = String(aadhaar).replace(/[\s-]/g, '');
  const hash = hashAadhaar(normalised);

  // Courtesy check — the unique index on KycVerification.aadhaarHash is what
  // actually prevents a second account, but telling them now is kinder than
  // failing after they have shared a contact.
  const taken = await KycVerification.findOne({
    aadhaarHash: { $in: hashAadhaarCandidates(normalised) },
  }).select('_id').lean();
  if (taken) return { ok: false, reason: 'already_registered' };

  pending.aadhaarHash = hash;
  pending.aadhaarEncrypted = encryptField(normalised);
  pending.aadhaarLast4 = normalised.slice(-4);
  pending.step = 'AWAITING_CONTACT';
  await pending.save();

  return { ok: true, step: 'AWAITING_CONTACT', last4: pending.aadhaarLast4 };
}

// ── Step 3: shared contact → the account exists ─────────────────────────────

/**
 * The contact share. This is where an account comes into being.
 *
 * @param {object} args
 * @param {string} args.telegramUserId
 * @param {string} args.phone         from Telegram's contact object
 * @param {string} args.contactUserId Telegram's user_id ON the shared contact
 */
export async function completeContactShare({ telegramUserId, phone, contactUserId }) {
  const pending = await TelegramPendingLink.findOne({ telegramUserId: String(telegramUserId) })
    .select('+aadhaarEncrypted');
  if (!pending) return { ok: false, reason: 'no_session' };
  if (pending.step !== 'AWAITING_CONTACT' || !pending.aadhaarHash) {
    return { ok: false, reason: 'aadhaar_first' };
  }

  // Telegram includes the owning user's id on a shared contact. If it is not
  // the sender's own id, they forwarded somebody ELSE's contact card — which
  // would register that person's number against this Telegram account.
  if (contactUserId && String(contactUserId) !== String(telegramUserId)) {
    return { ok: false, reason: 'not_own_contact' };
  }

  const mobile = normalisePhone(phone);
  if (!mobile) return { ok: false, reason: 'invalid_phone' };

  const cfg = await activeConfig();
  const User = mongoose.model('User');

  // Courtesy checks before doing work; the indexes remain the real guarantee.
  const phoneTaken = await TelegramIdentity.findOne({ phone: mobile, contactActive: true }).select('_id').lean();
  if (phoneTaken) return { ok: false, reason: 'phone_already_linked' };

  const referrer = pending.referralCode
    ? await User.findOne({ referralCode: pending.referralCode }).select('_id').lean()
    : null;

  const session = await mongoose.startSession();
  try {
    let created = null;
    await session.withTransaction(async () => {
      // The platform account. `mobile` is unique, so a person who somehow
      // already has an account on this number collides here rather than
      // acquiring a second one.
      const [user] = await User.create([{
        username: pending.firstName || `player${mobile.slice(-4)}`,
        mobile,
        kycStatus: 'PENDING_APPROVAL',
        status: 'ACTIVE',
        referralCode: generateReferralCode(),
        referredBy: referrer?._id || null,
      }], { session });

      await TelegramIdentity.create([{
        telegramUserId: String(telegramUserId),
        userId: user._id,
        telegramUsername: pending.telegramUsername || '',
        firstName: pending.firstName || '',
        phone: mobile,
        contactSharedAt: new Date(),
        contactActive: true,
        channelStatus: 'unknown',
        channelGeneration: cfg?.generation ?? 0,
        linkedGeneration: cfg?.generation ?? 0,
      }], { session });

      // The KYC row goes in now, PENDING_VERIFICATION, so the Aadhaar is
      // queued for the next export the moment the account exists.
      await KycVerification.create([{
        userId: user._id,
        aadhaarHash: pending.aadhaarHash,
        aadhaarEncrypted: pending.aadhaarEncrypted,
        aadhaarLast4: pending.aadhaarLast4,
        phone: mobile,
        status: 'PENDING_VERIFICATION',
      }], { session });

      created = user;
    });

    pending.step = 'AWAITING_CHANNEL';
    pending.phone = mobile;
    await pending.save();

    return { ok: true, step: 'AWAITING_CHANNEL', userId: created._id, mobile };
  } catch (err) {
    // 11000 from any of the three unique constraints: somebody completed this
    // same signup concurrently, or the number/Aadhaar is already registered.
    // Reported as a duplicate rather than a crash — the database refused
    // exactly as designed.
    if (err?.code === 11000) return { ok: false, reason: 'duplicate' };
    throw err;
  } finally {
    await session.endSession();
  }
}

// ── Step 4: channel joined → onboarding complete ────────────────────────────

/**
 * Finish onboarding once the player is in the channel.
 *
 * The joining number is allocated HERE, not at account creation: it orders the
 * referral payout queue, and a number consumed by someone who never joined
 * would leave a permanent gap ahead of people who did.
 *
 * Idempotent — a second `chat_member` event for someone already numbered does
 * nothing, and `recordEarningsFor` is itself guarded by a unique index.
 */
export async function completeOnboarding({ userId }) {
  const User = mongoose.model('User');
  const user = await User.findById(userId);
  if (!user) return { ok: false, reason: 'no_user' };

  if (!user.joiningNumber) {
    user.joiningNumber = await nextJoiningNumber();
    await user.save();
  }

  // Books the upline's ₹25s. Safe on replay.
  const earnings = await recordEarningsFor(user);

  await TelegramPendingLink.deleteOne({ telegramUserId: { $exists: true }, phone: user.mobile })
    .catch(() => { /* the pending row also expires on its own */ });

  return { ok: true, joiningNumber: user.joiningNumber, earnings };
}
