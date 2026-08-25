// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramRecovery.service.js — regaining an account when the
 * Telegram account behind it is gone.
 *
 * ── When this is the right tool, and when it is not ─────────────────────────
 * Normal login needs nothing: the player opens the bot and gets a link. This
 * path exists for exactly one situation — the Telegram account itself is lost
 * (deleted, or taken over) while the person still controls the PHONE NUMBER it
 * was registered on. That is the only case where the ordinary route cannot
 * work, because the ordinary route authenticates the Telegram account.
 *
 * ── Why a separate bot ──────────────────────────────────────────────────────
 * A compromised primary bot must not be able to hand out other people's
 * accounts. Recovery runs on its own token and its own webhook secret, so
 * losing one does not imply losing the other.
 *
 * ── What is actually proven ─────────────────────────────────────────────────
 * Two independent factors, and BOTH are required:
 *
 *   1. Control of the phone number — proven the same way signup proves it, by
 *      Telegram's own contact share. Not a claim the user types.
 *   2. Knowledge of the Aadhaar registered to that account — held only as an
 *      HMAC, so this is a comparison, never a lookup that reveals anything.
 *
 * Either one alone is refused. Someone who buys a recycled SIM has the phone
 * but not the Aadhaar; someone who has scraped an Aadhaar has no way to receive
 * on the number. Requiring both is what makes an automatic hand-back defensible
 * without a support queue in the middle.
 *
 * ── The result is a RE-LINK, not a new account ──────────────────────────────
 * Balance, bet history, KYC verdict, referral tree and joining number all
 * belong to the User, and the User is untouched. Only the Telegram identity
 * pointing at it is replaced. Creating a fresh account here would strand the
 * player's money and silently break the referral chain beneath them.
 */
import mongoose from 'mongoose';
import { TelegramIdentity } from './telegram.model.js';
import { KycVerification } from '../identity/kycVerification.model.js';
import { hashAadhaarCandidates } from '../identity/aadhaarHash.util.js';
import { activeConfig } from './telegramClient.js';
import { normalisePhone } from './telegramOnboarding.service.js';
import { sendAlert } from '../../services/alerting.service.js';

/**
 * Attempt a recovery.
 *
 * @param {object} args
 * @param {string} args.newTelegramUserId the Telegram account asking for it
 * @param {string} args.phone             from the contact share
 * @param {string} args.contactUserId     Telegram's user_id ON that contact
 * @param {string} args.aadhaar           as typed into the recovery bot
 * @returns {Promise<{ok: boolean, reason?: string, userId?: string}>}
 */
export async function attemptRecovery({ newTelegramUserId, phone, contactUserId, aadhaar }) {
  // Same guard as signup: a forwarded contact card would let someone recover an
  // account using a number they do not hold.
  if (contactUserId && String(contactUserId) !== String(newTelegramUserId)) {
    return { ok: false, reason: 'not_own_contact' };
  }

  const mobile = normalisePhone(phone);
  if (!mobile) return { ok: false, reason: 'invalid_phone' };

  const candidates = hashAadhaarCandidates(aadhaar);
  if (!candidates.length) return { ok: false, reason: 'invalid_aadhaar' };

  const User = mongoose.model('User');
  const user = await User.findOne({ mobile }).select('_id status isBlocked').lean();

  // FACTOR 2. Checked against the account the PHONE resolved to — not used as a
  // search key. Looking an account up BY Aadhaar would turn this bot into the
  // enumeration oracle that was removed from the old recovery flow.
  const kyc = user
    ? await KycVerification.findOne({ userId: user._id }).select('aadhaarHash').lean()
    : null;
  const aadhaarMatches = Boolean(kyc && candidates.includes(kyc.aadhaarHash));

  // One answer for every failure. Telling "no account on this number" apart
  // from "wrong Aadhaar" would let someone with a recycled SIM learn whether
  // the number is registered here, and let someone with a leaked Aadhaar list
  // confirm which numbers it belongs to.
  if (!user || !aadhaarMatches) {
    console.warn(`[recovery] refused for telegram=${newTelegramUserId} phone=***${mobile.slice(-4)} `
      + `(account=${Boolean(user)}, aadhaar=${aadhaarMatches})`);
    return { ok: false, reason: 'no_match' };
  }

  if (user.isBlocked || user.status === 'BLOCKED') {
    return { ok: false, reason: 'blocked' };
  }

  const cfg = await activeConfig();
  const session = await mongoose.startSession();
  try {
    let outcome;
    await session.withTransaction(async () => {
      // Retire the old identity FIRST. The phone's unique index is partial on
      // contactActive, so the new row cannot be inserted until the old one has
      // stepped aside — doing this in the same transaction is what stops a
      // failure from leaving the account with two live identities or none.
      await TelegramIdentity.updateMany(
        { userId: user._id, contactActive: true },
        { $set: { contactActive: false, channelStatus: 'left' } },
        { session },
      );

      // The same Telegram account asking twice re-points its existing row
      // rather than colliding with itself.
      await TelegramIdentity.findOneAndUpdate(
        { telegramUserId: String(newTelegramUserId) },
        {
          $set: {
            userId: user._id,
            phone: mobile,
            contactSharedAt: new Date(),
            contactActive: true,
            channelStatus: 'unknown',
            channelGeneration: cfg?.generation ?? 0,
            linkedGeneration: cfg?.generation ?? 0,
          },
        },
        { upsert: true, new: true, session },
      );

      outcome = { userId: String(user._id) };
    });

    // Recovery hands an account to a different Telegram identity, which is
    // exactly the shape a successful takeover would have. It is always
    // reported, so a pattern of them is visible without anyone having to think
    // to look.
    console.warn(`[recovery] GRANTED user=${user._id} to telegram=${newTelegramUserId}`);
    sendAlert('account-recovered', 'An account was re-linked to a new Telegram identity', {
      userId: String(user._id),
      newTelegramUserId: String(newTelegramUserId),
      phoneLast4: mobile.slice(-4),
    }).catch(() => { /* alerting must never block a recovery already committed */ });

    return { ok: true, ...outcome };
  } catch (err) {
    if (err?.code === 11000) {
      // The new Telegram account is already linked to a DIFFERENT user. Handing
      // it a second account would create the duplicate the whole design exists
      // to prevent.
      return { ok: false, reason: 'telegram_already_linked' };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}
