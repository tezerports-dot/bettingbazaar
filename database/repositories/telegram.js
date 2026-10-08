// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/telegram.js — the one bot, the links it proves, the questions
 * the Mini App answers, and the password resets it starts (Step 3, owner
 * 2026-10-07).
 *
 * ── What Telegram is for now ────────────────────────────────────────────────
 * "they must verify and share contact on signup ... now they can do login
 * without telegram mini app but add also login with telegram button too."
 *
 * An account is created by a form and cannot be used until its holder shares,
 * in the Mini App, the Telegram contact whose phone IS the form's mobile. That
 * share writes a LINK (`telegram_links`). After it the link is the staff and
 * merchant second factor, an optional "Login with Telegram", and how a
 * forgotten password is reset. One bot; no fleet, channel, templates or
 * webhooks (CLAUDE.md §33).
 *
 * ── Every act on a Mini App proof is ONE transaction ───────────────────────
 * The signed `initData` and contact are bearer proofs for five minutes
 * (domains/telegram/miniAppAuth.js). Each is claimed here, by primary key, in
 * the transaction that ACTS on it — `telegram_init_data_uses`; the INSERT is the
 * check (§32 S6). A refusal rolls the claim back with everything else, so the
 * person can correct the mistake (share the right contact) and try again,
 * while a string that was acted on cannot be acted on twice.
 *
 * The link, the joining number and a new player's referral earnings commit in
 * that same transaction (§21): a verification without its earnings is a
 * referrer who is never paid, and earnings without the verification are a form
 * submitted in a loop.
 *
 * ── Refusals are answers ────────────────────────────────────────────────────
 * A refusal returns `{ ok: false, code }`; the route maps `code` to a status
 * and a sentence. Nothing here throws at a person for something they did.
 *
 * ── Expiry is enforced by the READS ────────────────────────────────────────
 * Every challenge, reset and claim carries `expires_at` and every read or
 * update filters on it with the DATABASE clock. `sweepExpired` reclaims space
 * only; a late sweep never makes anything usable.
 */
import { pgQuery, withTransaction } from '../client.js';
import { ACCOUNT_TYPES, claimJoiningNumber } from './users.js';
import { createAccountFromSignup } from './identity.js';
import { recordJoinerEarnings } from './referrals.js';
import { REFERRAL_REWARD_PAISE } from '../../backend/domains/referral/referralRewards.js';

function assertAudience(audience, fn) {
  if (!ACCOUNT_TYPES.includes(audience)) {
    throw new Error(`${fn} requires an audience (one of ${ACCOUNT_TYPES.join(', ')}); got ${audience}`);
  }
  return audience;
}

/** A refusal raised inside a transaction: rolls it back, becomes `{ ok: false, code }`. */
class Refusal extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; this.extra = extra; }
}
const refuse = (code, extra) => { throw new Refusal(code, extra); };

/** Run `fn` in one transaction; a `Refusal` rolls back and is returned as an answer. */
async function acting(fn) {
  try {
    return await withTransaction(fn);
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, ...e.extra };
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ONE BOT
// ═══════════════════════════════════════════════════════════════════════════

const toBot = (r) => (r ? {
  configured: true,
  botId: r.bot_id,
  botUsername: r.username,
  miniAppShortName: r.mini_app_short_name,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
} : null);

/** The bot, without its token: what an admin screen renders. Null when none. */
export async function getBot() {
  const { rows } = await pgQuery(
    `SELECT bot_id, username, mini_app_short_name, updated_at, updated_by
       FROM telegram_bot WHERE id = 1`, [], 'tg_bot_get',
  );
  return toBot(rows[0]);
}

/**
 * The bot WITH its token ciphertext. Separate, and named for it: whoever holds
 * the token can sign Mini App data — sign anybody in — so no route that renders
 * the bot calls this.
 */
export async function getBotSecrets() {
  const { rows } = await pgQuery(
    `SELECT bot_id, username, token_encrypted, mini_app_short_name
       FROM telegram_bot WHERE id = 1`, [], 'tg_bot_secrets',
  );
  const r = rows[0];
  return r ? {
    botId: r.bot_id, botUsername: r.username,
    tokenEncrypted: r.token_encrypted, miniAppShortName: r.mini_app_short_name,
  } : null;
}

/**
 * Save the bot. With a token, the whole row (Telegram's `getMe` has already
 * named the bot); without one, only the Mini App short name of the bot that is
 * there — refused (null) when there is none to update.
 */
export async function saveBot({
  botId, botUsername, tokenEncrypted, miniAppShortName, updatedBy = null,
}) {
  if (tokenEncrypted) {
    const { rows } = await pgQuery(
      `INSERT INTO telegram_bot (id, bot_id, username, token_encrypted, mini_app_short_name, updated_at, updated_by)
       VALUES (1, $1, $2, $3, COALESCE($4, ''), now(), $5)
       ON CONFLICT (id) DO UPDATE
          SET bot_id = EXCLUDED.bot_id, username = EXCLUDED.username,
              token_encrypted = EXCLUDED.token_encrypted,
              mini_app_short_name = COALESCE($4, telegram_bot.mini_app_short_name),
              updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING bot_id, username, mini_app_short_name, updated_at, updated_by`,
      [String(botId), String(botUsername), String(tokenEncrypted),
        miniAppShortName ?? null, updatedBy], 'tg_bot_save',
    );
    return toBot(rows[0]);
  }
  const { rows } = await pgQuery(
    `UPDATE telegram_bot SET mini_app_short_name = $1, updated_at = now(), updated_by = $2
      WHERE id = 1
      RETURNING bot_id, username, mini_app_short_name, updated_at, updated_by`,
    [String(miniAppShortName ?? ''), updatedBy], 'tg_bot_short_name',
  );
  return toBot(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// LINKS — an account verified by its own Telegram
// ═══════════════════════════════════════════════════════════════════════════

const LINK_COLUMNS = `user_id, audience, telegram_user_id, phone, telegram_username,
  first_name, two_factor, verified_at, linked_at`;

const toLink = (r) => (r ? {
  userId: r.user_id,
  audience: r.audience,
  telegramUserId: r.telegram_user_id,
  phone: r.phone,
  telegramUsername: r.telegram_username,
  firstName: r.first_name,
  twoFactor: r.two_factor === true,
  verifiedAt: r.verified_at,
  linkedAt: r.linked_at,
} : null);

/**
 * The account's link, or null when it has never been verified. Not
 * audience-scoped, deliberately: `user_id` belongs to exactly one account type,
 * and the row's audience is that type by its foreign key.
 */
export async function getLinkByUserId(userId) {
  if (!userId) return null;
  const { rows } = await pgQuery(
    `SELECT ${LINK_COLUMNS} FROM telegram_links WHERE user_id = $1`,
    [String(userId)], 'tg_link_by_user',
  );
  return toLink(rows[0]);
}

/**
 * Which account of THIS panel a Telegram account verifies. The audience is half
 * the key and required: one person's Telegram account verifies their player,
 * merchant and staff accounts alike (§33.5).
 */
export async function getLinkByTelegramId(telegramUserId, audience) {
  if (!telegramUserId) return null;
  assertAudience(audience, 'getLinkByTelegramId');
  const { rows } = await pgQuery(
    `SELECT ${LINK_COLUMNS} FROM telegram_links
      WHERE telegram_user_id = $1 AND audience = $2`,
    [String(telegramUserId), audience], 'tg_link_by_telegram',
  );
  return toLink(rows[0]);
}

/**
 * Every account a Telegram account verifies, one per panel — what the Mini App
 * shows ("your player account ••••3210"). The mobile is returned for the hint
 * and never leaves the route whole.
 */
export async function listLinksForTelegramUser(telegramUserId) {
  if (!telegramUserId) return [];
  const { rows } = await pgQuery(
    `SELECT l.audience, l.user_id, u.mobile
       FROM telegram_links l JOIN users u ON u.user_id = l.user_id
      WHERE l.telegram_user_id = $1 AND u.status <> 'DELETED'
      ORDER BY l.audience`,
    [String(telegramUserId)], 'tg_links_for_telegram',
  );
  return rows.map((r) => ({ audience: r.audience, userId: r.user_id, mobile: r.mobile }));
}

/**
 * Who receives a staff security alert: every STAFF account that is linked and
 * neither blocked nor closed (owner, 2026-10-07: "admin security alerts to
 * staff who linked Telegram"). The bot can only message somebody who opened it,
 * which every linked staff member did to verify.
 */
export async function listAlertRecipients() {
  const { rows } = await pgQuery(
    `SELECT l.telegram_user_id
       FROM telegram_links l JOIN users u ON u.user_id = l.user_id
      WHERE l.audience = 'STAFF' AND u.account_type = 'STAFF'
        AND NOT u.is_blocked AND u.status NOT IN ('BLOCKED', 'DELETED')`,
    [], 'tg_alert_recipients',
  );
  return rows.map((r) => r.telegram_user_id);
}

/**
 * A player switches Telegram approval of their password sign-ins ON. Turning it
 * OFF is not here: it needs their Telegram's approval (`answerChallenge`,
 * TWO_FACTOR_OFF), or a stolen password would switch it off first.
 */
export async function enablePlayerTwoFactor(userId) {
  const { rows } = await pgQuery(
    `UPDATE telegram_links SET two_factor = TRUE
      WHERE user_id = $1 AND audience = 'PLAYER'
      RETURNING ${LINK_COLUMNS}`,
    [String(userId)], 'tg_link_2fa_on',
  );
  return toLink(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// CHALLENGES — a question put to the Mini App
// ═══════════════════════════════════════════════════════════════════════════

export const CHALLENGE_PURPOSE = Object.freeze({
  VERIFY: 'VERIFY',
  LOGIN: 'LOGIN',
  TELEGRAM_LOGIN: 'TELEGRAM_LOGIN',
  RELINK: 'RELINK',
  TWO_FACTOR_OFF: 'TWO_FACTOR_OFF',
});

const CHALLENGE_COLUMNS = `challenge_id, purpose, audience, user_id, status, created_at,
  expires_at, decided_at, telegram_user_id, redeemed_at, requested_ip, requested_agent,
  (expires_at > now()) AS live`;

const toChallenge = (r) => (r ? {
  challengeId: r.challenge_id,
  purpose: r.purpose,
  audience: r.audience,
  userId: r.user_id,
  status: r.status,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  telegramUserId: r.telegram_user_id,
  redeemedAt: r.redeemed_at,
  requestedIp: r.requested_ip,
  requestedAgent: r.requested_agent,
  // On the DATABASE clock, so the app server's clock never decides.
  live: r.live === true,
} : null);

/** Open a challenge. `userId` is null only for an unbound Telegram login. */
export async function createChallenge({
  challengeId, purpose, audience, userId = null, ttlSeconds,
  requestedIp = '', requestedAgent = '',
}) {
  assertAudience(audience, 'createChallenge');
  if (!CHALLENGE_PURPOSE[purpose]) throw new Error(`createChallenge: unknown purpose ${purpose}`);
  const { rows } = await pgQuery(
    `INSERT INTO telegram_challenges
       (challenge_id, purpose, audience, user_id, expires_at, requested_ip, requested_agent)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval, $6, $7)
     RETURNING ${CHALLENGE_COLUMNS}`,
    [String(challengeId), purpose, audience, userId ? String(userId) : null, String(ttlSeconds),
      String(requestedIp || '').slice(0, 64), String(requestedAgent || '').slice(0, 256)],
    'tg_challenge_create',
  );
  return toChallenge(rows[0]);
}

export async function getChallenge(challengeId) {
  if (!challengeId) return null;
  const { rows } = await pgQuery(
    `SELECT ${CHALLENGE_COLUMNS} FROM telegram_challenges WHERE challenge_id = $1`,
    [String(challengeId)], 'tg_challenge_get',
  );
  return toChallenge(rows[0]);
}

/**
 * Spend an APPROVED challenge — once.
 *
 * The state, the purpose, the panel, the account and the database clock are
 * all in the UPDATE's WHERE, so two polls arriving together produce one
 * session and one "expired" (§32 S6). When nothing was spent, the row is read
 * to say WHY, so the panel can keep polling (`PENDING`) or stop.
 *
 * @param {object} p
 * @param {string} p.challengeId
 * @param {string} p.audience       the door the browser is at
 * @param {string[]} p.purposes     what this door may redeem here
 * @param {string|null} [p.userId]  when the caller already knows whose it is
 * @returns {Promise<{ok: true, userId: string, purpose: string}
 *          | {ok: false, state: 'PENDING'|'DENIED'|'EXPIRED'}>}
 */
export async function redeemChallenge({ challengeId, audience, purposes, userId = null }) {
  assertAudience(audience, 'redeemChallenge');
  const { rows } = await pgQuery(
    `UPDATE telegram_challenges SET status = 'REDEEMED', redeemed_at = now()
      WHERE challenge_id = $1 AND audience = $2 AND purpose = ANY($3::text[])
        AND status = 'APPROVED' AND expires_at > now()
        AND ($4::text IS NULL OR user_id = $4)
      RETURNING user_id, purpose`,
    [String(challengeId), audience, purposes, userId ? String(userId) : null],
    'tg_challenge_redeem',
  );
  if (rows[0]) return { ok: true, userId: rows[0].user_id, purpose: rows[0].purpose };
  return { ok: false, state: stateOf(await getChallenge(challengeId), { audience, purposes, userId }) };
}

/**
 * What a challenge means to the browser holding it, without spending it: the
 * staff and merchant Telegram-first sign-in reads this to say "now your
 * password", and spends it only when the password arrives.
 */
export function stateOf(challenge, { audience, purposes, userId = null }) {
  if (!challenge || challenge.audience !== audience || !purposes.includes(challenge.purpose)
      || (userId && challenge.userId && String(challenge.userId) !== String(userId))) {
    return 'EXPIRED';
  }
  if (challenge.status === 'DENIED') return 'DENIED';
  if (!challenge.live || challenge.status === 'REDEEMED') return 'EXPIRED';
  return challenge.status; // PENDING or APPROVED
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTING ON A MINI APP PROOF — one transaction each
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Claim a signed Mini App string, once. Inside the acting transaction: if the
 * act is refused the claim rolls back with it.
 */
async function claimProof(client, proof) {
  if (!proof?.hash) return;
  const { rowCount } = await client.query(
    `INSERT INTO telegram_init_data_uses (hash, expires_at) VALUES ($1, $2)
     ON CONFLICT (hash) DO NOTHING`,
    [String(proof.hash), proof.expiresAt],
  );
  if (rowCount !== 1) refuse('INIT_DATA_REPLAYED');
}

/** The account, locked for the length of the act, refused if it may not be used. */
async function lockAccount(client, where, params) {
  const { rows } = await client.query(
    `SELECT user_id, account_type, mobile, status, is_blocked, referred_by
       FROM users WHERE ${where} FOR UPDATE`, params,
  );
  const a = rows[0];
  if (!a) return null;
  if (a.status === 'DELETED') refuse('ACCOUNT_CLOSED');
  if (a.is_blocked || a.status === 'BLOCKED') refuse('ACCOUNT_BLOCKED');
  return a;
}

/**
 * Link (or relink) an account to the Telegram account whose contact matched.
 *
 * The phone must BE the account's mobile — the trigger
 * `telegram_link_phone_is_mobile` refuses anything else, and this refuses first
 * with an answer. A Telegram account already verifying another account of the
 * same panel is refused (`telegram_links_one_per_panel` is the guarantee).
 *
 * A first link of a PLAYER is the moment they count: the joining number and the
 * referral earnings are booked here, in this transaction.
 */
async function linkWithin(client, account, { telegramUser, phone }) {
  if (String(account.mobile) !== String(phone)) refuse('CONTACT_MISMATCH');
  const tgId = String(telegramUser.id);

  const { rows: taken } = await client.query(
    `SELECT user_id FROM telegram_links WHERE telegram_user_id = $1 AND audience = $2`,
    [tgId, account.account_type],
  );
  if (taken[0] && String(taken[0].user_id) !== String(account.user_id)) refuse('TELEGRAM_ALREADY_LINKED');

  const { rows: prev } = await client.query(
    `SELECT telegram_user_id FROM telegram_links WHERE user_id = $1 FOR UPDATE`,
    [account.user_id],
  );
  try {
    if (!prev[0]) {
      await client.query(
        `INSERT INTO telegram_links
           (user_id, audience, telegram_user_id, phone, telegram_username, first_name, two_factor)
         VALUES ($1, $2, $3, $4, $5, $6, $2 <> 'PLAYER')`,
        [account.user_id, account.account_type, tgId, String(phone),
          String(telegramUser.username || ''), String(telegramUser.firstName || '')],
      );
      let joiningNumber = null;
      let referralLevels = [];
      if (account.account_type === 'PLAYER') {
        joiningNumber = await claimJoiningNumber(account.user_id, { client });
        referralLevels = await recordJoinerEarnings(account.user_id, {
          client, amountPaise: REFERRAL_REWARD_PAISE,
        });
      }
      return { verified: true, relinked: false, joiningNumber, referralLevels };
    }
    await client.query(
      `UPDATE telegram_links
          SET telegram_user_id = $2, telegram_username = $3, first_name = $4,
              linked_at = CASE WHEN telegram_user_id = $2 THEN linked_at ELSE now() END
        WHERE user_id = $1`,
      [account.user_id, tgId, String(telegramUser.username || ''), String(telegramUser.firstName || '')],
    );
    return { verified: false, relinked: String(prev[0].telegram_user_id) !== tgId };
  } catch (e) {
    // Two accounts claiming one Telegram account at the same instant: the
    // unique index decides, and the loser is told what the pre-check would
    // have said. The refusal rolls the whole act back.
    if (e?.code === '23505' && e.constraint === 'telegram_links_one_per_panel') {
      refuse('TELEGRAM_ALREADY_LINKED');
    }
    throw e;
  }
}

/**
 * The Mini App's answer to a challenge.
 *
 * What each purpose needs, beyond a fresh `initData` opened ON this challenge
 * (its `start_param` is the challenge id, signed by Telegram):
 *
 *   VERIFY, RELINK      a contact from this Telegram account whose phone is the
 *                       account's mobile. VERIFY links; RELINK moves the link.
 *   LOGIN               the account's linked Telegram account — or a matching
 *   TWO_FACTOR_OFF      contact from a new one, which relinks (the person lost
 *                       their old Telegram, not their SIM).
 *   TELEGRAM_LOGIN      the panel's link of this Telegram account, which binds
 *                       the challenge to that account — or a matching contact,
 *                       which verifies or relinks the account of that mobile.
 *
 * A DENY needs only the fresh `initData`: the challenge id reached nobody but
 * the browser that asked, and refusing grants nothing.
 *
 * Approval re-dates the challenge to `now() + redeemWindowSeconds`: an
 * approval is redeemed by the polling browser within seconds, and one left
 * lying for the rest of a fifteen-minute window is a session nobody is
 * waiting for.
 */
export async function answerChallenge({
  challengeId, decision, telegramUser, initData, contact = null, redeemWindowSeconds = 120,
}) {
  if (!['approve', 'deny'].includes(decision)) throw new Error(`answerChallenge: decision ${decision}`);
  return acting(async (client) => {
    await claimProof(client, initData);
    if (contact) {
      if (String(contact.userId) !== String(telegramUser.id)) refuse('CONTACT_NOT_OWN');
      await claimProof(client, contact);
    }

    const { rows } = await client.query(
      `SELECT ${CHALLENGE_COLUMNS} FROM telegram_challenges WHERE challenge_id = $1 FOR UPDATE`,
      [String(challengeId)],
    );
    const ch = toChallenge(rows[0]);
    if (!ch) refuse('NO_CHALLENGE');
    if (ch.status !== 'PENDING') refuse('CHALLENGE_ANSWERED');
    if (!ch.live) refuse('CHALLENGE_EXPIRED');
    const tgId = String(telegramUser.id);

    if (decision === 'deny') {
      await client.query(
        `UPDATE telegram_challenges SET status = 'DENIED', decided_at = now(), telegram_user_id = $2
          WHERE challenge_id = $1 AND status = 'PENDING'`,
        [ch.challengeId, tgId],
      );
      return { ok: true, kind: ch.purpose, panel: ch.audience, approved: false, relinked: false, verified: false };
    }

    // ── Whose account this approves ────────────────────────────────────
    let account = null;
    if (ch.userId) {
      account = await lockAccount(client, 'user_id = $1 AND account_type = $2', [ch.userId, ch.audience]);
    } else {
      const { rows: mine } = await client.query(
        `SELECT user_id FROM telegram_links WHERE telegram_user_id = $1 AND audience = $2`,
        [tgId, ch.audience],
      );
      if (mine[0]) {
        account = await lockAccount(client, 'user_id = $1 AND account_type = $2', [mine[0].user_id, ch.audience]);
      } else if (contact) {
        account = await lockAccount(client, 'mobile = $1 AND account_type = $2', [contact.phone, ch.audience]);
      } else {
        refuse('CONTACT_REQUIRED');
      }
    }
    if (!account) refuse('NO_ACCOUNT');

    const { rows: links } = await client.query(
      `SELECT telegram_user_id FROM telegram_links WHERE user_id = $1`, [account.user_id],
    );
    const linkedHere = links[0] && String(links[0].telegram_user_id) === tgId;

    let outcome = { verified: false, relinked: false };
    const needsContactAlways = ch.purpose === 'VERIFY' || ch.purpose === 'RELINK';
    if (needsContactAlways || !linkedHere) {
      if (!contact) refuse('CONTACT_REQUIRED');
      outcome = await linkWithin(client, account, { telegramUser, phone: contact.phone });
    }

    if (ch.purpose === 'TWO_FACTOR_OFF') {
      await client.query(
        `UPDATE telegram_links SET two_factor = FALSE WHERE user_id = $1 AND audience = 'PLAYER'`,
        [account.user_id],
      );
    }

    await client.query(
      `UPDATE telegram_challenges
          SET status = 'APPROVED', decided_at = now(), telegram_user_id = $2, user_id = $3,
              expires_at = now() + ($4 || ' seconds')::interval
        WHERE challenge_id = $1 AND status = 'PENDING'`,
      [ch.challengeId, tgId, account.user_id, String(redeemWindowSeconds)],
    );
    return {
      ok: true, kind: ch.purpose, panel: ch.audience, approved: true,
      relinked: outcome.relinked, verified: outcome.verified, userId: account.user_id,
    };
  });
}

/**
 * "Login with Telegram" from INSIDE the Mini App: the `initData` is the proof.
 *
 * Claims it and finds the panel's account this Telegram account verifies. A
 * player is signed in by the caller on the answer; staff and merchants still
 * owe their password (owner reading, 2026-10-07), so for them an APPROVED
 * challenge is written in the same transaction and the password sign-in spends
 * it.
 */
export async function telegramSignIn({
  audience, telegramUser, initData, challengeId = null, redeemWindowSeconds = 120,
  requestedIp = '', requestedAgent = '',
}) {
  assertAudience(audience, 'telegramSignIn');
  return acting(async (client) => {
    await claimProof(client, initData);
    const { rows } = await client.query(
      `SELECT user_id FROM telegram_links WHERE telegram_user_id = $1 AND audience = $2`,
      [String(telegramUser.id), audience],
    );
    if (!rows[0]) refuse('NO_LINKED_ACCOUNT');
    const account = await lockAccount(client, 'user_id = $1 AND account_type = $2', [rows[0].user_id, audience]);
    if (!account) refuse('NO_LINKED_ACCOUNT');
    if (challengeId) {
      await client.query(
        `INSERT INTO telegram_challenges
           (challenge_id, purpose, audience, user_id, status, expires_at, decided_at,
            telegram_user_id, requested_ip, requested_agent)
         VALUES ($1, 'TELEGRAM_LOGIN', $2, $3, 'APPROVED', now() + ($4 || ' seconds')::interval,
                 now(), $5, $6, $7)`,
        [String(challengeId), audience, account.user_id, String(redeemWindowSeconds),
          String(telegramUser.id), String(requestedIp || '').slice(0, 64),
          String(requestedAgent || '').slice(0, 256)],
      );
    }
    return { ok: true, userId: account.user_id };
  });
}

/**
 * A player signs up INSIDE the Mini App (a referral link opens it there): the
 * account is created already verified, its mobile taken from Telegram's own
 * contact, and the link, the joining number and the referral earnings are the
 * same transaction as the account.
 */
export async function signUpVerifiedPlayer({
  userId, username, passwordHash, referralCode, referredBy = null,
  telegramUser, initData, contact,
}) {
  return acting(async (client) => {
    await claimProof(client, initData);
    if (String(contact.userId) !== String(telegramUser.id)) refuse('CONTACT_NOT_OWN');
    await claimProof(client, contact);

    const created = await createAccountFromSignup({
      userId, username, mobile: contact.phone, passwordHash, referralCode, referredBy, client,
    });
    if (!created.ok) refuse(created.reason === 'mobile_taken' ? 'MOBILE_TAKEN' : 'DUPLICATE');

    const account = await lockAccount(client, 'user_id = $1 AND account_type = $2', [created.userId, 'PLAYER']);
    const outcome = await linkWithin(client, account, { telegramUser, phone: contact.phone });
    return { ok: true, userId: created.userId, joiningNumber: outcome.joiningNumber };
  });
}

/**
 * "I've forgotten my password", answered in the Mini App: the contact proves
 * the phone, the account of that mobile ON THAT PANEL is the one reset, and the
 * share verifies or relinks it on the way.
 *
 * The reset row is issued in the same transaction; asking again invalidates the
 * previous token (one live token per account).
 */
export async function resetPasswordByContact({
  panel, telegramUser, initData, contact, tokenHash, ttlSeconds = 900,
}) {
  assertAudience(panel, 'resetPasswordByContact');
  return acting(async (client) => {
    await claimProof(client, initData);
    if (String(contact.userId) !== String(telegramUser.id)) refuse('CONTACT_NOT_OWN');
    await claimProof(client, contact);

    const account = await lockAccount(client, 'mobile = $1 AND account_type = $2', [contact.phone, panel]);
    if (!account) refuse('NO_ACCOUNT');
    const outcome = await linkWithin(client, account, { telegramUser, phone: contact.phone });

    await client.query(
      `DELETE FROM password_resets WHERE user_id = $1 AND consumed_at IS NULL`, [account.user_id],
    );
    const { rows } = await client.query(
      `INSERT INTO password_resets (token_hash, user_id, telegram_user_id, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
       RETURNING expires_at`,
      [String(tokenHash), account.user_id, String(telegramUser.id), String(ttlSeconds)],
    );
    return {
      ok: true, userId: account.user_id, expiresAt: rows[0].expires_at,
      verified: outcome.verified, relinked: outcome.relinked,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PASSWORD RESETS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Redeem a reset token — ONCE.
 *
 * `consumed_at` is set in the same atomic UPDATE that reads the row, so twenty
 * racing redemptions produce one winner. Expiry is in the WHERE: a sweep that
 * has not run never makes a stale link usable.
 */
export async function consumePasswordReset(tokenHash) {
  const { rows } = await pgQuery(
    `UPDATE password_resets
        SET consumed_at = now()
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id, telegram_user_id`,
    [String(tokenHash)], 'pw_reset_consume',
  );
  const r = rows[0];
  return r ? { userId: r.user_id, telegramUserId: r.telegram_user_id } : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// RETENTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reclaim space from rows that can no longer be used. Space ONLY — every read
 * above already refuses an expired row. Scheduled as the `telegram-sweep` cron.
 */
export async function sweepExpired() {
  const resets = await pgQuery(
    `DELETE FROM password_resets WHERE expires_at <= now()`, [], 'tg_sweep_resets');
  // A challenge is kept for a day after it lapses: "who asked to sign in to my
  // account, from where" is the first question after a denied approval.
  const challenges = await pgQuery(
    `DELETE FROM telegram_challenges WHERE expires_at <= now() - interval '1 day'`, [], 'tg_sweep_challenges');
  const uses = await pgQuery(
    `DELETE FROM telegram_init_data_uses WHERE expires_at <= now()`, [], 'tg_sweep_init_data');
  return {
    passwordResets: resets.rowCount ?? 0,
    challenges: challenges.rowCount ?? 0,
    initDataUses: uses.rowCount ?? 0,
  };
}
