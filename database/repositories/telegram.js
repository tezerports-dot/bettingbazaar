// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/telegram.js — the one bot, the links it proves, and the
 * "Continue with Telegram" sign-ins the Mini App answers.
 *
 * ── What Telegram is for now (owner, 2026-10-13/14) ────────────────────────
 * Players and merchants sign in with "Continue with Telegram" and nothing
 * else: no password, no form. Signing up and signing in are the same action.
 * The first Verify of a Telegram account on a panel shares its contact, once:
 * that writes the LINK (`telegram_links`) to the account of that mobile, or
 * makes one (a player; a merchant application). Every later Verify is the
 * link's own Telegram. Players and merchants only (`TELEGRAM_AUDIENCES`). One
 * bot; no fleet, channel, templates or webhooks (CLAUDE.md §33).
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
 * Every challenge and claim carries `expires_at` and every read or
 * update filters on it with the DATABASE clock. `sweepExpired` reclaims space
 * only; a late sweep never makes anything usable.
 */
import { pgQuery, withTransaction } from '../client.js';
import { claimJoiningNumber } from './users.js';
import { createAccountFromSignup } from './identity.js';
import { createMerchantAccountWithin } from './merchants.js';
import { recordJoinerEarnings } from './referrals.js';
import { REFERRAL_REWARD_PAISE } from '../../backend/domains/referral/referralRewards.js';

/**
 * The account types Telegram serves: players and merchants. A STAFF account has
 * no Telegram at all (owner, 2026-10-13): it signs in with a password and an
 * authenticator app, and the schema's audience CHECKs refuse a staff link or
 * challenge.
 */
export const TELEGRAM_AUDIENCES = Object.freeze(['PLAYER', 'MERCHANT']);

function assertAudience(audience, fn) {
  if (!TELEGRAM_AUDIENCES.includes(audience)) {
    throw new Error(`${fn} requires an audience (one of ${TELEGRAM_AUDIENCES.join(', ')}); got ${audience}`);
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
  first_name, verified_at, linked_at`;

const toLink = (r) => (r ? {
  userId: r.user_id,
  audience: r.audience,
  telegramUserId: r.telegram_user_id,
  phone: r.phone,
  telegramUsername: r.telegram_username,
  firstName: r.first_name,
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
 * the key and required: one person's Telegram account verifies their player and
 * merchant accounts alike (§33.5).
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

// ═══════════════════════════════════════════════════════════════════════════
// CHALLENGES — a question put to the Mini App
// ═══════════════════════════════════════════════════════════════════════════

const CHALLENGE_COLUMNS = `challenge_id, audience, user_id, status, created_at,
  expires_at, decided_at, telegram_user_id, redeemed_at, requested_ip, requested_agent,
  requested_city, delivery, match_number, match_choices, match_strikes, referral_code,
  (expires_at > now()) AS live`;

/** How an approved sign-in reaches a browser (schema.sql, "The number match and the handoff"). */
export const DELIVERY = Object.freeze({ MATCH: 'MATCH', HANDOFF: 'HANDOFF' });

/** Wrong picks a MATCH sign-in survives: the third refuses it. */
export const MATCH_STRIKES = 3;

const toChallenge = (r) => (r ? {
  challengeId: r.challenge_id,
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
  requestedCity: r.requested_city || '',
  delivery: r.delivery,
  // The right number is the requesting browser's to show and nobody else's:
  // it is read here for the answer's own check and never sent by a route.
  matchNumber: r.match_number === null ? null : Number(r.match_number),
  matchChoices: Array.isArray(r.match_choices) ? r.match_choices.map(Number) : null,
  matchStrikes: Number(r.match_strikes || 0),
  referralCode: r.referral_code || null,
  // On the DATABASE clock, so the app server's clock never decides.
  live: r.live === true,
} : null);

/**
 * Open a "Continue with Telegram" sign-in. Nobody is named yet: the approval
 * binds it to the account of the Telegram account that presses Verify.
 *
 * It says how its approval will reach a browser (`delivery`): a MATCH one
 * carries its number and the three choices the Mini App offers (the caller
 * draws them, `drawMatch`); a HANDOFF one has none.
 */
export async function createChallenge({
  challengeId, audience, ttlSeconds,
  requestedIp = '', requestedAgent = '', requestedCity = '',
  delivery = DELIVERY.MATCH, match = null, referralCode = null,
}) {
  assertAudience(audience, 'createChallenge');
  if (!DELIVERY[delivery]) throw new Error(`createChallenge: unknown delivery ${delivery}`);
  if (delivery === DELIVERY.MATCH && !match) throw new Error('createChallenge: a MATCH sign-in needs its number');
  const { rows } = await pgQuery(
    `INSERT INTO telegram_challenges
       (challenge_id, audience, expires_at, requested_ip, requested_agent,
        delivery, match_number, match_choices, referral_code, requested_city)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4, $5, $6, $7, $8::smallint[], $9, $10)
     RETURNING ${CHALLENGE_COLUMNS}`,
    [String(challengeId), audience, String(ttlSeconds),
      String(requestedIp || '').slice(0, 64), String(requestedAgent || '').slice(0, 256),
      delivery, match ? match.number : null, match ? match.choices : null,
      referralCode ? String(referralCode) : null, String(requestedCity || '').slice(0, 80)],
    'tg_challenge_create',
  );
  return toChallenge(rows[0]);
}

/**
 * A pick in the Mini App that is NOT the challenge's number: one strike, and
 * the third refuses the sign-in. Its own statement, committed whatever happens
 * next, because a wrong pick must cost something even though the approval it
 * came with is refused (the approval's own UPDATE re-asks the number in its
 * WHERE, §32 S6). A right pick, or a challenge with no number, changes nothing.
 *
 * @returns {Promise<{wrong: false} | {wrong: true, strikesLeft: number, denied: boolean}>}
 */
export async function strike({ challengeId, pick, telegramUserId }) {
  const { rows } = await pgQuery(
    `UPDATE telegram_challenges
        SET match_strikes = match_strikes + 1,
            status = CASE WHEN match_strikes + 1 >= $3 THEN 'DENIED' ELSE status END,
            decided_at = CASE WHEN match_strikes + 1 >= $3 THEN now() ELSE decided_at END,
            telegram_user_id = CASE WHEN match_strikes + 1 >= $3 THEN $4 ELSE telegram_user_id END
      WHERE challenge_id = $1 AND status = 'PENDING' AND expires_at > now()
        AND match_number IS NOT NULL AND match_number IS DISTINCT FROM $2::smallint
      RETURNING match_strikes, status`,
    [String(challengeId), Number.isInteger(pick) ? pick : null, MATCH_STRIKES, String(telegramUserId)],
    'tg_challenge_strike',
  );
  if (!rows[0]) return { wrong: false };
  return {
    wrong: true,
    strikesLeft: Math.max(0, MATCH_STRIKES - Number(rows[0].match_strikes)),
    denied: rows[0].status === 'DENIED',
  };
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
 * Spend an APPROVED challenge — once, by the browser that polls it.
 *
 * Only a MATCH challenge is spent by a poll: a HANDOFF one is spent only by
 * its ticket (`redeemTicket`), on the device that pressed Verify, so the
 * browser that opened it — perhaps somebody else's — never gets its session.
 * The state, the panel, the delivery and the database clock are all in the
 * UPDATE's WHERE, so two polls arriving together produce one session and one
 * "expired" (§32 S6). When nothing was spent, the row is read to say WHY, so
 * the panel can keep polling (`PENDING`) or stop.
 *
 * @param {object} p
 * @param {string} p.challengeId
 * @param {string} p.audience       the door the browser is at
 * @returns {Promise<{ok: true, userId: string}
 *          | {ok: false, state: 'PENDING'|'APPROVED'|'DENIED'|'EXPIRED'}>}
 */
export async function redeemChallenge({ challengeId, audience }) {
  assertAudience(audience, 'redeemChallenge');
  const { rows } = await pgQuery(
    `UPDATE telegram_challenges SET status = 'REDEEMED', redeemed_at = now()
      WHERE challenge_id = $1 AND audience = $2
        AND status = 'APPROVED' AND expires_at > now() AND delivery = 'MATCH'
      RETURNING user_id`,
    [String(challengeId), audience],
    'tg_challenge_redeem',
  );
  if (rows[0]) return { ok: true, userId: rows[0].user_id };
  return { ok: false, state: stateOf(await getChallenge(challengeId), { audience }) };
}

/** What a challenge means to a browser at this door, without spending it. */
export function stateOf(challenge, { audience }) {
  if (!challenge || challenge.audience !== audience) return 'EXPIRED';
  if (challenge.status === 'DENIED') return 'DENIED';
  if (!challenge.live || challenge.status === 'REDEEMED') return 'EXPIRED';
  return challenge.status; // PENDING or APPROVED
}

/**
 * Spend a handoff ticket — once — at the door it was minted for.
 *
 * The ticket and its HANDOFF challenge are spent in ONE statement: the ticket
 * unused and unexpired, the challenge APPROVED, unexpired and of this panel,
 * all on the database clock (§32 S6). Two tabs presenting one ticket get one
 * session. A ticket that fails any of it is spent anyway: it was shown once.
 *
 * @param {object} p
 * @param {string} p.ticketHash  SHA-256 hex of the ticket the site was opened with
 * @param {string} p.audience    the door it is presented at
 * @returns {Promise<{ok: true, userId: string} | {ok: false}>}
 */
export async function redeemTicket({ ticketHash, audience }) {
  assertAudience(audience, 'redeemTicket');
  if (!/^[0-9a-f]{64}$/.test(String(ticketHash || ''))) return { ok: false };
  const { rows } = await pgQuery(
    `WITH spent AS (
       UPDATE telegram_handoff_tickets SET used_at = now()
        WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING challenge_id
     )
     UPDATE telegram_challenges c SET status = 'REDEEMED', redeemed_at = now()
       FROM spent
      WHERE c.challenge_id = spent.challenge_id AND c.audience = $2
        AND c.delivery = 'HANDOFF' AND c.status = 'APPROVED' AND c.expires_at > now()
      RETURNING c.user_id`,
    [String(ticketHash), audience], 'tg_ticket_redeem',
  );
  return rows[0] ? { ok: true, userId: rows[0].user_id } : { ok: false };
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
           (user_id, audience, telegram_user_id, phone, telegram_username, first_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
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
 * The Mini App's answer to a "Continue with Telegram" sign-in.
 *
 * Beyond a fresh `initData` opened ON this challenge (its `start_param` is the
 * challenge id, signed by Telegram), approving needs one of:
 *
 *   - this Telegram account's link on the challenge's panel: that account;
 *   - a contact from this Telegram account (once, at the first Verify on that
 *     panel): the account of that mobile, linked (or relinked: the person
 *     changed Telegram account, not SIM) — or, with `signup`, a new one: a
 *     player, or a merchant application waiting for an admin.
 *
 * A DENY needs only the fresh `initData`: the challenge id reached nobody but
 * the browser that asked, and refusing grants nothing.
 *
 * Approval re-dates the challenge to `now() + redeemWindowSeconds`: an
 * approval is redeemed by the polling browser (or its ticket) within seconds,
 * and one left lying for the rest of the window is a session nobody is waiting
 * for.
 */
export async function answerChallenge({
  challengeId, decision, telegramUser, initData, contact = null, redeemWindowSeconds = 120,
  pick = null, ticket = null, signup = null, open = null,
}) {
  if (!['approve', 'deny'].includes(decision)) throw new Error(`answerChallenge: decision ${decision}`);
  return acting(async (client) => {
    await claimProof(client, initData);
    if (open) {
      // Opened from the bot itself (no website asked): the HANDOFF sign-in is
      // created here, in the transaction that answers it, so it exists only
      // once somebody has pressed Verify.
      assertAudience(open.audience, 'answerChallenge');
      await client.query(
        `INSERT INTO telegram_challenges
           (challenge_id, audience, expires_at, delivery, referral_code)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval, 'HANDOFF', $4)`,
        [String(challengeId), open.audience, String(open.ttlSeconds),
          open.audience === 'PLAYER' && open.referralCode ? String(open.referralCode) : null],
      );
    }
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
      return { ok: true, panel: ch.audience, approved: false, relinked: false, verified: false };
    }

    // ── Whose account this approves ────────────────────────────────────
    let account = null;
    let created = false;
    const { rows: mine } = await client.query(
      `SELECT user_id FROM telegram_links WHERE telegram_user_id = $1 AND audience = $2`,
      [tgId, ch.audience],
    );
    if (mine[0]) {
      account = await lockAccount(client, 'user_id = $1 AND account_type = $2', [mine[0].user_id, ch.audience]);
    } else if (contact) {
      account = await lockAccount(client, 'mobile = $1 AND account_type = $2', [contact.phone, ch.audience]);
      if (!account && signup) {
        // First time on this panel, no account on that number: this IS the
        // signup ("Continue with Telegram" is one action). The account, its
        // link and — for a player — the joining number and the referrer's
        // earnings commit with the approval, or none of them do.
        account = await signUpWithin(client, ch.audience, contact.phone, signup);
        created = true;
      }
    } else {
      refuse('CONTACT_REQUIRED');
    }
    if (!account) refuse('NO_ACCOUNT');

    let outcome = { verified: false, relinked: false };
    if (!mine[0]) outcome = await linkWithin(client, account, { telegramUser, phone: contact.phone });

    // The number is asked again HERE, in the approving UPDATE's WHERE, with
    // the strike count: a wrong pick (`strike`) committed apart from this, so
    // nothing read above may stand in for it (§32 S6).
    const approved = await client.query(
      `UPDATE telegram_challenges
          SET status = 'APPROVED', decided_at = now(), telegram_user_id = $2, user_id = $3,
              expires_at = now() + ($4 || ' seconds')::interval
        WHERE challenge_id = $1 AND status = 'PENDING' AND expires_at > now()
          AND match_strikes < $6
          AND (delivery = 'HANDOFF' OR match_number = $5::smallint)`,
      [ch.challengeId, tgId, account.user_id, String(redeemWindowSeconds),
        Number.isInteger(pick) ? pick : null, MATCH_STRIKES],
    );
    if (approved.rowCount !== 1) refuse(ch.delivery === DELIVERY.MATCH ? 'WRONG_NUMBER' : 'CHALLENGE_ANSWERED');

    // A HANDOFF approval travels as a ticket the Mini App opens on the site;
    // only its hash is written (`telegram_handoff_tickets`).
    if (ch.delivery === DELIVERY.HANDOFF) {
      if (!ticket?.hash) throw new Error('answerChallenge: a HANDOFF approval needs a ticket');
      await client.query(
        `INSERT INTO telegram_handoff_tickets (ticket_hash, challenge_id, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
        [String(ticket.hash), ch.challengeId, String(ticket.ttlSeconds)],
      );
    }
    return {
      ok: true, panel: ch.audience, approved: true, delivery: ch.delivery,
      relinked: outcome.relinked, verified: outcome.verified, created, userId: account.user_id,
    };
  });
}

/**
 * The account a first Verify makes, inside the approving transaction: a
 * player (with the invite the sign-in carried), or a merchant APPLICATION —
 * PENDING until an admin approves it, so it signs nobody in yet.
 */
async function signUpWithin(client, audience, phone, signup) {
  const last4 = String(phone).slice(-4);
  if (audience === 'PLAYER') {
    const made = await createAccountFromSignup({
      userId: signup.userId, username: `player${last4}`, mobile: phone,
      referralCode: signup.referralCode, referredBy: signup.referredBy ?? null, client,
    });
    if (!made.ok) refuse(made.reason === 'mobile_taken' ? 'MOBILE_TAKEN' : 'DUPLICATE');
    return lockAccount(client, 'user_id = $1 AND account_type = $2', [made.userId, 'PLAYER']);
  }
  const made = await createMerchantAccountWithin(client, {
    userId: signup.userId, username: `merchant${last4}`, mobile: phone,
  });
  if (!made.ok) refuse('MOBILE_TAKEN');
  return lockAccount(client, 'user_id = $1 AND account_type = $2', [made.userId, 'MERCHANT']);
}

// ═══════════════════════════════════════════════════════════════════════════
// RETENTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reclaim space from rows that can no longer be used. Space ONLY — every read
 * above already refuses an expired row. Scheduled as the `credential-sweep` cron
 * (backend/startup/cronJobs.js).
 */
export async function sweepExpired() {
  // A challenge is kept for a day after it lapses: "who asked to sign in to my
  // account, from where" is the first question after a denied approval.
  const challenges = await pgQuery(
    `DELETE FROM telegram_challenges WHERE expires_at <= now() - interval '1 day'`, [], 'tg_sweep_challenges');
  const uses = await pgQuery(
    `DELETE FROM telegram_init_data_uses WHERE expires_at <= now()`, [], 'tg_sweep_init_data');
  // A ticket goes with its challenge (ON DELETE CASCADE); one that lapsed
  // sooner is worthless the moment it lapses.
  const tickets = await pgQuery(
    `DELETE FROM telegram_handoff_tickets WHERE expires_at <= now()`, [], 'tg_sweep_tickets');
  return {
    challenges: challenges.rowCount ?? 0,
    initDataUses: uses.rowCount ?? 0,
    tickets: tickets.rowCount ?? 0,
  };
}
