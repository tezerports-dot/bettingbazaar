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

/**
 * Normalise a referral code arriving from a deep link.
 *
 * Codes are GENERATED uppercase, and looked up by exact match. A payload that
 * arrives in another case therefore matches nothing — and the failure is
 * completely silent: the signup succeeds, the referrer simply never earns, and
 * nobody finds out. That is the worst possible shape for an attribution bug.
 *
 * A code arrives in lower case more often than it sounds: somebody retypes a
 * link they were read out, a client lowercases a URL it thinks is a hostname, or
 * a code is copied out of a message that was auto-capitalised. Anything that is
 * not a plausible code at all becomes null rather than being stored as junk that
 * will never match.
 */
export function normaliseReferralCode(raw) {
  const v = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9_-]{4,32}$/.test(v) ? v : null;
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
  if (existing) {
    // A rejected player is not asking to log in — they are stuck, and the only
    // useful thing the bot can do is take a corrected Aadhaar. Reported here so
    // the route does not have to re-read the user to find out.
    const User = mongoose.model('User');
    const u = await User.findById(existing.userId).select('kycStatus kycData').lean();
    return {
      alreadyLinked: true,
      userId: existing.userId,
      kycStatus: u?.kycStatus || null,
      canReapply: u?.kycStatus === 'REJECTED'
        && (u?.kycData?.submissionCount || 0) < MAX_KYC_SUBMISSIONS,
    };
  }

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
      //
      // Normalised, because the lookup at contact-share time is an exact match
      // against a code that was generated in upper case — and a mismatch there
      // costs the referrer their earning with no error anywhere.
      $setOnInsert: { referralCode: normaliseReferralCode(referralCode) },
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

      // The signup IS submission one. Counting it here keeps the reapply cap
      // honest — otherwise MAX_KYC_SUBMISSIONS would silently allow one more
      // attempt than it says.
      await User.updateOne({ _id: user._id }, { $set: { 'kycData.submissionCount': 1 } }, { session });

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

// ── Reapply: a rejected player sends a different Aadhaar ───────────────────

/**
 * How many Aadhaar numbers one account may ever submit.
 *
 * The first is the signup. The rest are corrections. Bounded because
 * "submit a number, be told whether it is already registered" is an enumeration
 * oracle the moment it can be repeated freely — the cap is what keeps this a
 * correction path rather than a probe. Someone who genuinely exhausts it has a
 * problem support should look at anyway.
 */
export const MAX_KYC_SUBMISSIONS = 3;

/**
 * Replace a rejected Aadhaar with a new one.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 * The Aadhaar is immutable once verified, which is correct. But a player who
 * mistyped a digit is rejected through no fault of the design, and without this
 * their account is permanently dead: the signup conversation is over, so
 * sending a new number did nothing, and support had no code path either.
 *
 * ── Why the old row is gone by the time we get here ─────────────────────────
 * `releaseFailedSubmissions` (kycBulk) deletes a failed submission once the
 * verdict is on the user. That releases the unique `aadhaarHash` — which is
 * what makes a re-submission possible at all, and also un-breaks the stranger
 * whose Aadhaar the typo was occupying.
 *
 * @returns {Promise<{ok: true, last4: string} | {ok: false, reason: string}>}
 */
export async function resubmitAadhaar({ userId, aadhaar }) {
  const User = mongoose.model('User');
  const user = await User.findById(userId).select('kycStatus kycData').lean();
  if (!user) return { ok: false, reason: 'no_user' };

  // Only a rejected account may resubmit. An APPROVED Aadhaar is immutable, and
  // a PENDING one is already queued — letting either through would be a way to
  // change a verified identity, which is the thing the whole model forbids.
  if (user.kycStatus !== 'REJECTED') return { ok: false, reason: 'not_rejected' };

  if ((user.kycData?.submissionCount || 0) >= MAX_KYC_SUBMISSIONS) {
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (!isValidAadhaar(aadhaar)) return { ok: false, reason: 'invalid_format' };

  const normalised = String(aadhaar).replace(/[\s-]/g, '');
  const hash = hashAadhaar(normalised);

  const taken = await KycVerification.findOne({
    aadhaarHash: { $in: hashAadhaarCandidates(normalised) },
  }).select('_id userId').lean();
  // Their own live row would mean the release did not happen; anyone else's
  // means the number genuinely belongs to another account.
  if (taken) return { ok: false, reason: 'already_registered' };

  const identity = await TelegramIdentity.findOne({ userId }).select('phone').lean();

  try {
    await KycVerification.create({
      userId,
      aadhaarHash: hash,
      aadhaarEncrypted: encryptField(normalised),
      aadhaarLast4: normalised.slice(-4),
      phone: identity?.phone || '',
      status: 'PENDING_VERIFICATION',
    });
  } catch (err) {
    // 11000 on userId means a row already exists — the previous one was not
    // released, so this is a state problem rather than a duplicate Aadhaar.
    if (err?.code === 11000) return { ok: false, reason: 'already_registered' };
    throw err;
  }

  // Back into the queue, through the state machine rather than a raw write, so
  // the transition is checked and recorded like every other KYC decision.
  const { submitKycForReview } = await import('../user/kycDecision.service.js');
  const moved = await submitKycForReview(userId, { reason: null });
  if (!moved.ok) {
    // Do not strand a submission the user cannot see the status of.
    await KycVerification.deleteOne({ userId, status: 'PENDING_VERIFICATION' }).catch(() => {});
    return { ok: false, reason: 'state_refused' };
  }

  await User.updateOne({ _id: userId }, { $inc: { 'kycData.submissionCount': 1 } });

  return { ok: true, last4: normalised.slice(-4) };
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

  // Whether this join is the one that FINISHES a signup, or just another join by
  // somebody who finished long ago. The absence of a joining number is exactly
  // that question: it is allocated here, once, and never cleared.
  //
  // The caller needs this to decide whether to send an unsolicited login link.
  // See the note in telegram.routes.js — on a channel replacement every existing
  // player re-joins, and treating each of those as a fresh signup would send the
  // whole user base a login link they did not ask for, through the one bot they
  // are all simultaneously trying to sign in with.
  const firstCompletion = !user.joiningNumber;

  if (firstCompletion) {
    /**
     * Retried on a duplicate, because the counter can fall behind the data.
     *
     * `joiningNumber` is unique, and it comes from a counter document that is
     * separate from the users it numbers. Anything that restores one without
     * the other — a partial restore, a counter reset, a number set by hand
     * during support work — leaves the counter handing out a value some user
     * already holds. `user.save()` then throws E11000.
     *
     * Nothing above catches that. The webhook's own catch logs it and returns,
     * so the player is left with no joining number, no referral earnings booked
     * for their upline, and no login link — permanently, because the only thing
     * that would retry is another `chat_member` event and they have already
     * joined. It is silent, it costs the referrer real money, and support has
     * nothing to look at.
     *
     * The counter is atomic, so simply asking again yields the next value and
     * walks past the occupied range. Bounded, because a loop that cannot make
     * progress must fail loudly rather than spin.
     */
    for (let attempt = 1; ; attempt += 1) {
      user.joiningNumber = await nextJoiningNumber();
      try {
        await user.save();
        break;
      } catch (err) {
        if (err?.code !== 11000 || attempt >= 25) throw err;
        console.warn(`[onboarding] joining number ${user.joiningNumber} was taken — `
          + 'the counter is behind the data; asking for the next one');
      }
    }
  }

  // Books the upline's ₹25s. Safe on replay.
  const earnings = await recordEarningsFor(user);

  await TelegramPendingLink.deleteOne({ telegramUserId: { $exists: true }, phone: user.mobile })
    .catch(() => { /* the pending row also expires on its own */ });

  return { ok: true, firstCompletion, joiningNumber: user.joiningNumber, earnings };
}
