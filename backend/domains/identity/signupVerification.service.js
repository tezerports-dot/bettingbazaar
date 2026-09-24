// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * signupVerification.service.js — "has this account finished the Telegram step?"
 *
 * THE one owner of that question. The form creates the account; this module
 * owns everything between that and a player who may use the app.
 *
 * ── The two things Telegram is for ─────────────────────────────────────────
 * 1. CONTACT SHARE — Telegram holds a number it has verified itself, and hands
 *    it over when the player taps its share-contact button. Matching it against
 *    the mobile they typed on the form is what turns a typed number into a
 *    proven one. This is why the platform needs no SMS OTP at all.
 * 2. CHANNEL MEMBERSHIP — the official channel is private and admits on a JOIN
 *    REQUEST, which the platform auto-approves. Membership is a standing
 *    requirement, not a one-off: somebody who leaves is asked to join again.
 *
 * Both must hold. `verificationStateFor` answers with WHICH one is missing,
 * because "you are not verified" is a sentence a player cannot act on (§32 S14)
 * and the two have completely different next steps.
 *
 * ── What this module deliberately does NOT claim to detect ─────────────────
 * Telegram does not push an event when somebody changes the phone number on
 * their account. There is no webhook for it and no field on an ordinary message
 * that carries the number. So a silent change is invisible until the NEXT
 * contact share — and that is the honest statement of the limit.
 *
 * What IS detected, and handled, is every case where evidence actually arrives:
 *
 *   • a share carrying a DIFFERENT number from the one on file → the link is
 *     stood down, the player is re-gated, and an admin is told (`noteContactChange`)
 *   • a `chat_member` leave or kick → the membership cache flips and the gate
 *     closes on the next request, with no sweep needed
 *   • a CHANNEL REPLACEMENT → every cached status is stale by construction
 *     because it is stamped with the generation it was observed in, so everyone
 *     is asked to join the new one. That is the owner's requirement — "if the
 *     channel is replaced all users must join again" — and it needs no migration
 *     because the staleness is structural rather than swept.
 */
import { db } from '#db';
import { getUser, claimJoiningNumber } from '#db/repositories/users.js';
import { recordEarningsFor } from '../referral/referral.service.js';
import { membershipFor, joinPrompt } from '../telegram/telegramMembership.js';
import { activeConfig } from '../telegram/telegramClient.js';
import { notify } from '../communication/communication.service.js';
import { sendAlert } from '../../services/alerting.service.js';

/**
 * Which sign-in bot this account must open, as the panel needs it.
 *
 * The rotation itself is `db.telegram.assignSigninBot` — one statement, keep
 * what they hold if it is still live, otherwise take the next turn. This wraps
 * it with the one thing a screen needs and an id is not: the @username.
 *
 * @returns {Promise<{botId: string, username: string}|null>} null when the
 *   operator has registered no live sign-in bot yet. A real state at launch,
 *   and one the caller REPORTS rather than blaming on the player.
 */
export async function assignSigninBot(userId) {
  const botId = await db.telegram.assignSigninBot(userId);
  if (!botId) return null;
  const bot = await db.telegram.getBot(botId);
  return bot ? { botId: bot.botId, username: bot.username } : null;
}

/**
 * Everything the gate needs, for one account.
 *
 * Every field is derived; nothing here is a second copy of a stored answer.
 *
 * @param {object} user a user row from db.users
 * @param {{refresh?: boolean}} [opts] refresh:false serves the membership cache
 *   only and never calls Telegram — what a high-frequency poll passes.
 */
export async function verificationStateFor(user, { refresh = true } = {}) {
  const cfg = await activeConfig();
  // `activeOnly: false` deliberately. The default read returns only a LIVE
  // link, so a player whose contact was stood down would come back as though
  // they had never linked at all — and the gate would say "share your contact"
  // where the true answer is "your number changed, share it again". Two
  // different sentences, and the one that names what happened is the one that
  // stops a support ticket. `contactActive` is then checked explicitly below.
  const identity = await db.telegram.getIdentityByUserId(user.userId, { activeOnly: false });

  // ── Which bot, re-resolved on every read ──────────────────────────────────
  // Not cached on this response and not decided once at signup: an admin may
  // retire or replace any bot at any time, and a player still holding a retired
  // bot's @username would be sent to a conversation nobody is listening to.
  // `assignSigninBot` keeps a live assignment and replaces a dead one.
  const bot = await assignSigninBot(user.userId);

  // ── Step 1: has a Telegram account proven this mobile? ───────────────────
  // `contact_active` is the stand-down flag: a share that arrived carrying a
  // different number sets it false, so an old proof cannot keep a re-gated
  // player inside.
  const contactShared = Boolean(identity && identity.contactActive
    && String(identity.phone) === String(user.mobile));

  // ── Step 2: are they in the CURRENT channel? ─────────────────────────────
  const membership = contactShared
    ? await membershipFor(identity, { refresh })
    : { joined: false, status: 'unlinked' };

  const prompt = await joinPrompt();

  // The reason is a SINGLE value naming the one thing to do next, in the order
  // the player must do it in. A screen that had to work this out from four
  // booleans would work it out differently from the next screen that tried.
  let reason = null;
  if (!bot) reason = 'no_bot';
  else if (!contactShared) reason = identity && String(identity.phone) !== String(user.mobile)
    ? 'contact_changed'
    : 'share_contact';
  else if (membership.unconfigured) reason = 'no_channel';
  else if (!membership.joined) reason = 'join_channel';

  return {
    // The gate's whole question. Note what it is NOT: it is not `kycStatus`.
    // KYC is the admin's bulk Aadhaar verification and runs on its own clock;
    // this is whether the player may use the app at all.
    verified: reason === null,
    reason,
    contactShared,
    channelJoined: Boolean(membership.joined),
    // ── Diagnostic ONLY, and named so nobody renders it ──────────────────
    // This is the last thing Telegram told us, for whichever channel it was
    // observed in. After a channel replacement it can read `member` while
    // `channelJoined` is correctly false — the status is true of the OLD
    // channel and the generation stamp is what makes it stale. A screen that
    // showed this to a player would tell them they are in a channel they must
    // now re-join. `reason` is the one value a screen reads.
    lastKnownChannelStatus: membership.status,
    bot: bot ? { username: bot.username } : null,
    // Deep-linked with the account's own mobile so the bot can greet them by
    // name before they have shared anything. It carries NO secret: the payload
    // is the last four digits, which the player already knows and which proves
    // nothing on its own — the contact share is what proves the number.
    botLink: bot ? `https://t.me/${bot.username}?start=verify` : '',
    channel: {
      inviteLink: prompt?.inviteLink || '',
      username: prompt?.channelUsername || '',
    },
    generation: cfg?.generation ?? 0,
  };
}

/**
 * A contact share arrived carrying a number that is not the one on file.
 *
 * ── Why this is not just an error ──────────────────────────────────────────
 * It is the ONLY moment a changed Telegram number becomes visible, and it is
 * ambiguous in a way only a person can settle: the player may have changed
 * their own number, or somebody else may be sharing a contact at an account
 * that is not theirs. So the platform does the safe half automatically — stand
 * the proof down and re-gate — and tells a human the rest.
 *
 * The player is notified too, and FIRST in the code as in importance: the thing
 * that must never happen is that their access quietly stops working and nothing
 * anywhere says why.
 */
export async function noteContactChange({ userId, telegramUserId, wasPhone, nowPhone }) {
  await db.telegram.deactivateContact(String(telegramUserId)).catch(() => {});

  await notify({
    userId,
    type: 'SECURITY',
    title: 'Verify your mobile number again',
    message: 'The Telegram account linked to your Betting Bazaar account is now using a '
      + 'different mobile number, so your verification has been paused. Open the bot and '
      + 'share your contact again to restore it.',
  }).catch(() => { /* a notification failure must not swallow the stand-down */ });

  // The admin's copy. An alert rather than a notification row because there is
  // no one admin to address it to, and because a number changing under an
  // account is the shape an account takeover has.
  // Keyed per account so one player's change cannot silence another's under the
  // alerting cooldown — the key IS the dedupe unit there.
  await sendAlert(
    `telegram-contact-changed:${userId}`,
    'Telegram contact changed under an account',
    {
      account: userId,
      verifiedOn: wasPhone,
      nowReports: nowPhone,
      action: 'link stood down; the player must verify again',
    },
  ).catch(() => {});
}

/**
 * The signup FINISHES here — the moment both halves of verification hold.
 *
 * The joining number is allocated HERE, not at account creation: it orders the
 * referral payout queue, and a number consumed by someone who never joined
 * would leave a permanent gap ahead of people who did.
 *
 * Idempotent — a second `chat_member` event for someone already numbered does
 * nothing, and `recordEarningsFor` is itself guarded by a unique index.
 */
export async function completeVerification({ userId }) {
  const user = await getUser(userId);
  if (!user) return { ok: false, reason: 'no_user' };

  // Whether this join is the one that FINISHES a signup, or just another join
  // by somebody who finished long ago. The absence of a joining number is
  // exactly that question: it is allocated here, once, and never cleared.
  //
  // The caller needs it to decide whether to send a message at all. On a
  // channel replacement every existing player re-joins, and treating each of
  // those as a fresh signup would push one message per player through the fleet
  // in the same few seconds — at the exact moment everyone is trying to get
  // back in, which is the worst moment to spend the Bot API's budget.
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

  return { ok: true, firstCompletion, joiningNumber, earnings };
}
