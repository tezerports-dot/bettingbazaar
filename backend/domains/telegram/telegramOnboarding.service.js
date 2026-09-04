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
import {
  getIdentityByTelegramId, getIdentityByUserId, getPendingLink, getPendingAadhaar,
  upsertPendingLink, deletePendingLink, createAccountFromOnboarding,
} from '#db/repositories/telegram.js';
import {
  getUser, getUserByReferralCode, claimJoiningNumber,
  claimKycSubmission, releaseKycSubmission, newUserId,
} from '#db/repositories/users.js';
import {
  findRegisteredAadhaar, submitVerification, releaseFailedSubmission,
} from '#db/repositories/identity.js';
import { hashAadhaar, hashAadhaarCandidates } from '../identity/aadhaarHash.util.js';
import { encryptField } from '../identity/fieldCrypto.util.js';
import { generateReferralCode, recordEarningsFor } from '../referral/referral.service.js';
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
  const existing = await getIdentityByTelegramId(String(telegramUserId));
  if (existing) {
    // A rejected player is not asking to log in — they are stuck, and the only
    // useful thing the bot can do is take a corrected Aadhaar. Reported here so
    // the route does not have to re-read the user to find out.
    const u = await getUser(existing.userId);
    return {
      alreadyLinked: true,
      userId: existing.userId,
      kycStatus: u?.kycStatus || null,
      canReapply: u?.kycStatus === 'REJECTED'
        && (u?.kycSubmissionCount || 0) < MAX_KYC_SUBMISSIONS,
    };
  }

  // The referral code is written only when the row is CREATED — the upsert
  // keeps whichever code is already there. A returning player restarting the
  // flow must not lose the referrer they originally arrived with.
  //
  // Normalised, because the lookup at contact-share time is an exact match
  // against a code generated in upper case, and a mismatch there costs the
  // referrer their earning with no error anywhere.
  await upsertPendingLink({
    telegramUserId: String(telegramUserId),
    step: 'AWAITING_AADHAAR',
    telegramUsername: username || '',
    firstName: firstName || '',
    referralCode: normaliseReferralCode(referralCode),
    generation: cfg?.generation ?? 0,
  });
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
  const pending = await getPendingLink(String(telegramUserId));
  if (!pending) return { ok: false, reason: 'no_session' };
  if (!isValidAadhaar(aadhaar)) return { ok: false, reason: 'invalid_format' };

  const normalised = String(aadhaar).replace(/[\s-]/g, '');
  const hash = hashAadhaar(normalised);

  // Courtesy check — the UNIQUE index on the Aadhaar hash is what actually
  // prevents a second account, but telling them now is kinder than failing
  // after they have shared a contact. Checked across every candidate hash: the
  // HMAC secret is rotatable, so a number registered under a retired secret
  // must still read as taken.
  if (await findRegisteredAadhaar(hashAadhaarCandidates(normalised))) {
    return { ok: false, reason: 'already_registered' };
  }

  const last4 = normalised.slice(-4);
  await upsertPendingLink({
    telegramUserId: String(telegramUserId),
    step: 'AWAITING_CONTACT',
    aadhaarHash: hash,
    aadhaarEncrypted: encryptField(normalised),
    aadhaarLast4: last4,
    generation: pending.generation,
  });

  return { ok: true, step: 'AWAITING_CONTACT', last4 };
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
  const pending = await getPendingLink(String(telegramUserId));
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

  // The ciphertext is fetched separately from the rest of the row: an ordinary
  // read of a pending onboarding must not carry an Aadhaar around with it.
  const captured = await getPendingAadhaar(String(telegramUserId));
  if (!captured?.aadhaarEncrypted) return { ok: false, reason: 'aadhaar_first' };

  const referrer = pending.referralCode
    ? await getUserByReferralCode(pending.referralCode)
    : null;

  // One transaction: the account, the identity that drives it, and the Aadhaar
  // queued for verification. Every refusal below is something the bot has to
  // TELL somebody, and the unique indexes are what decide — a courtesy check
  // has a window a concurrent signup fits through, and this path is reachable
  // twice for one person whenever Telegram redelivers an update.
  const created = await createAccountFromOnboarding({
    telegramUserId: String(telegramUserId),
    mobile,
    username: pending.firstName || `player${mobile.slice(-4)}`,
    aadhaarHash: captured.aadhaarHash,
    aadhaarEncrypted: captured.aadhaarEncrypted,
    aadhaarLast4: captured.aadhaarLast4,
    telegramUsername: pending.telegramUsername || '',
    firstName: pending.firstName || '',
    referralCode: generateReferralCode(),
    referredBy: referrer?.userId ?? null,
    generation: cfg?.generation ?? 0,
    newUserId: newUserId(),
  });
  if (!created.ok) return created;

  await upsertPendingLink({
    telegramUserId: String(telegramUserId),
    step: 'AWAITING_CHANNEL',
    phone: mobile,
    generation: cfg?.generation ?? 0,
  });

  return { ok: true, step: 'AWAITING_CHANNEL', userId: created.userId, mobile };
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
  const user = await getUser(userId);
  if (!user) return { ok: false, reason: 'no_user' };

  // Only a rejected account may resubmit. An APPROVED Aadhaar is immutable, and
  // a PENDING one is already queued — letting either through would be a way to
  // change a verified identity, which is the thing the whole model forbids.
  if (user.kycStatus !== 'REJECTED') return { ok: false, reason: 'not_rejected' };

  if (!isValidAadhaar(aadhaar)) return { ok: false, reason: 'invalid_format' };

  /**
   * The attempt is CLAIMED before any work, in one statement that both checks
   * the cap and consumes an attempt.
   *
   * It used to read the count near the top and increment at the very bottom,
   * which left the whole submission between them: two reapplies arriving
   * together both read the same count, both passed, and the cap was exceeded
   * by exactly the number of requests in flight. That cap is the only thing
   * stopping "submit a number, be told whether it is registered" from being a
   * repeatable enumeration oracle, so a concurrency hole in it is the hole.
   *
   * The trade is deliberate: a refused submission below RELEASES the attempt,
   * but a crash between the claim and the release burns one. Burning an attempt
   * on a rare crash is a support ticket; an unbounded oracle is not.
   */
  const claimed = await claimKycSubmission(userId, MAX_KYC_SUBMISSIONS);
  if (claimed === null) return { ok: false, reason: 'too_many_attempts' };

  /** Give the attempt back — this submission never entered the queue. */
  const release = () => releaseKycSubmission(userId).catch(() => {});

  const normalised = String(aadhaar).replace(/[\s-]/g, '');
  const hash = hashAadhaar(normalised);

  // Their own live row would mean the release did not happen; anyone else's
  // means the number genuinely belongs to another account. Checked across
  // every candidate hash, so a number registered under a retired HMAC secret
  // still reads as taken.
  if (await findRegisteredAadhaar(hashAadhaarCandidates(normalised))) {
    await release();
    return { ok: false, reason: 'already_registered' };
  }

  const identity = await getIdentityByUserId(userId);

  const submitted = await submitVerification({
    userId,
    aadhaarHash: hash,
    aadhaarEncrypted: encryptField(normalised),
    aadhaarLast4: normalised.slice(-4),
    phone: identity?.phone || '',
  });
  if (!submitted.ok) {
    await release();
    // `user_already_submitted` means the previous row was never released, so
    // this is a state problem rather than a duplicate Aadhaar.
    return { ok: false, reason: 'already_registered' };
  }

  // Back into the queue, through the state machine rather than a raw write, so
  // the transition is checked and recorded like every other KYC decision.
  const { submitKycForReview } = await import('../user/kycDecision.service.js');
  const moved = await submitKycForReview(userId, { reason: null });
  if (!moved.ok) {
    // Do not strand a submission the user cannot see the status of.
    await releaseFailedSubmission(userId).catch(() => {});
    await release();
    return { ok: false, reason: 'state_refused' };
  }

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
  const user = await getUser(userId);
  if (!user) return { ok: false, reason: 'no_user' };

  // Whether this join is the one that FINISHES a signup, or just another join
  // by somebody who finished long ago. The absence of a joining number is
  // exactly that question: it is allocated here, once, and never cleared.
  //
  // The caller needs it to decide whether to send an unsolicited login link.
  // On a channel replacement every existing player re-joins, and treating each
  // of those as a fresh signup would send the whole user base a login link they
  // did not ask for, through the one bot they are all trying to sign in with.
  const firstCompletion = !user.joiningNumber;

  /**
   * One statement, and the retry loop it replaces is gone.
   *
   * The number used to come from a separate counter row, which could fall
   * BEHIND the users it numbered — a partial restore, a counter reset, a number
   * set by hand during support work — and then hand out a value somebody
   * already held. The save threw, nothing caught it, and the player was left
   * permanently with no joining number, no referral earnings booked for their
   * upline, and no login link: silent, costly to the referrer, and invisible to
   * support. The workaround was a bounded retry that asked the counter again.
   *
   * `claimJoiningNumber` derives MAX + 1 from the rows themselves inside one
   * UPDATE, so there is no counter to fall behind and nothing to retry. It is
   * idempotent by construction — an account that already holds a number keeps
   * it — which is what makes a redelivered `chat_member` event free.
   */
  const joiningNumber = await claimJoiningNumber(userId);

  // Books the upline's ₹25s. Safe on replay.
  const earnings = await recordEarningsFor({ ...user, joiningNumber });

  // The pending row also expires on its own; removing it here just stops a
  // finished onboarding lingering with an Aadhaar hash on it.
  await deletePendingLink(String(user.userId)).catch(() => {});

  return { ok: true, firstCompletion, joiningNumber, earnings };
}
