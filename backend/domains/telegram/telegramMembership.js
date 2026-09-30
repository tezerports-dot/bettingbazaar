// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramMembership.js — "is this player in the channel?"
 *
 * Betting, games and wallet operations are all gated on channel membership, so
 * this question is asked on a large share of authenticated requests. Answering
 * it by calling `getChatMember` every time does not work: the Bot API is rate
 * limited per bot, not per user, so at the member counts this programme is
 * sized for the bot becomes the bottleneck for the entire platform — and an
 * outage at Telegram would stop betting outright.
 *
 * So membership is a CACHE with two writers:
 *
 *   1. `chat_member` webhook updates. Telegram pushes these the moment someone
 *      joins or leaves, which makes the common case both free and instant. This
 *      is what "event-based" means here.
 *   2. A bounded refresh for anyone whose cached answer is older than the TTL —
 *      the safety net for updates we missed (webhook downtime, a redeploy, a
 *      member who joined before the bot was an administrator).
 *
 * ── Generation is part of the answer ────────────────────────────────────────
 * A cached "member" is only meaningful for the channel it was observed in. When
 * an admin swaps to a new channel the config generation increments, and every
 * cached status silently becomes stale-by-construction: the gate compares the
 * stored generation to the active one, and a mismatch reads as "must join the
 * new channel". That is what lets a channel be replaced without anyone having
 * to invalidate anything by hand.
 */
import { db } from '#db';
import { activeConfig, fetchChatMemberStatus } from './telegramClient.js';

/** Statuses that count as being in the channel. */
const JOINED = new Set(['member', 'administrator', 'creator']);

/** How long a cached status is trusted before a refresh is attempted. */
const TTL_MS = Number(process.env.TELEGRAM_MEMBERSHIP_TTL_MS || 15 * 60 * 1000);

export function isJoinedStatus(status) {
  return JOINED.has(status);
}

/**
 * Apply a `chat_member` / `my_chat_member` update.
 *
 * Telegram sends the new status directly, so this is a write with no API call —
 * the reason membership enforcement is affordable at all.
 */
export async function applyMemberUpdate({ telegramUserId, status, generation, audience }) {
  if (!telegramUserId) return { updated: false };
  // The observation timestamp is the DATABASE's clock, stamped inside the
  // UPDATE, not one computed here. The TTL below is measured against it, and a
  // node whose clock has drifted would otherwise write a freshness it does not
  // have — trusting a stale "member" for as long as the drift.
  const identity = await db.telegram.setChannelStatus(telegramUserId, {
    status: status || 'unknown',
    generation,
    audience,
  });
  // Null means no row matched: the Telegram account is not linked to any
  // platform account. Not an error — an update can arrive for someone who
  // joined the channel without ever signing up.
  return { updated: identity !== null, identity };
}

/**
 * The gate's question, answered from cache where possible.
 *
 * @param {object} identity a telegram identity row, from db.telegram
 * @param {{refresh?: boolean}} [opts] refresh:false serves cache only, never calls Telegram
 * @returns {Promise<{joined: boolean, status: string, stale: boolean, checked: boolean}>}
 */
export async function membershipFor(identity, { refresh = true, audience = null } = {}) {
  // ── The audience comes from the IDENTITY, and the argument is a FALLBACK ─
  // `audience` on the row is half its primary key, so when there IS a row it is
  // the one true answer to "which channel is this link about" and the argument
  // is ignored. A caller-supplied audience winning would be a second owner of
  // that value (§2), and it fails expensively: a merchant checked against the
  // player channel is told to join a channel they were never invited to, by a
  // gate they cannot get past.
  //
  // The argument exists for the one case with no row to read it from — an
  // account that has never linked — and the ORDER below is why it has to
  // exist at all rather than being answered with an early return.
  const scope = identity?.audience || audience;

  // ── THE ORDER IS THE WHOLE POINT, and getting it wrong is measurable ─────
  // The channel is resolved BEFORE the caller is told anybody is unlinked. The
  // first draft of the audience split returned `unlinked` above this line,
  // which reads as a tidy guard and is the documented bug: on a platform with
  // NO channel configured, every unlinked player was refused "link your
  // Telegram account" — an instruction naming a bot that does not exist, on a
  // fresh install, blaming the player for an operator's unfinished setup.
  //
  // MEASURED: 56 pg failures, among them every deposit and withdrawal route
  // test, all answering 403 where they had answered 200.
  if (!scope) {
    // Neither a row nor a caller that said which panel. Nothing can be
    // enforced, and reporting it as unconfigured is the honest answer — the
    // gate's own unconfigured branch then admits and alerts, rather than
    // refusing somebody for a question nobody asked properly.
    return { joined: false, status: 'unconfigured', stale: false, checked: false, unconfigured: true };
  }
  const cfg = await activeConfig(scope);
  // Nothing configured: there is no channel to be a member of. Reported as not
  // joined but flagged, so the gate can distinguish "user has not joined" from
  // "the platform has no channel" and refuse to blame the player.
  if (!cfg) {
    return { joined: false, status: 'unconfigured', stale: false, checked: false, unconfigured: true };
  }
  // A channel DOES exist and this account has no link to it. Now "you are not
  // linked" is a sentence the person can act on, and `joinPrompt` can name the
  // bot to open.
  if (!identity) {
    return { joined: false, status: 'unlinked', stale: false, checked: false };
  }

  const generationMatches = identity.channelGeneration === cfg.generation;
  const fresh = identity.channelCheckedAt
    && Date.now() - new Date(identity.channelCheckedAt).getTime() < TTL_MS;

  // A cached answer for the CURRENT channel that is still fresh is authoritative
  // enough — a `chat_member` event would have overwritten it the moment it
  // changed.
  if (generationMatches && fresh) {
    return {
      joined: isJoinedStatus(identity.channelStatus),
      status: identity.channelStatus,
      stale: false,
      checked: false,
    };
  }

  if (!refresh) {
    return {
      joined: generationMatches && isJoinedStatus(identity.channelStatus),
      status: identity.channelStatus,
      stale: true,
      checked: false,
    };
  }

  const live = await fetchChatMemberStatus(identity.telegramUserId, identity.audience);
  if (!live.ok) {
    // Telegram is unreachable. Fall back to the last thing we knew about the
    // CURRENT channel; if that is also missing, report unknown and let the gate
    // decide. This module does not choose fail-open vs fail-closed.
    return {
      joined: generationMatches && isJoinedStatus(identity.channelStatus),
      status: generationMatches ? identity.channelStatus : 'unknown',
      stale: true,
      checked: false,
      unreachable: true,
    };
  }

  await applyMemberUpdate({
    telegramUserId: identity.telegramUserId,
    status: live.status,
    generation: live.generation,
    audience: identity.audience,
  });

  return { joined: isJoinedStatus(live.status), status: live.status, stale: false, checked: true };
}

/** What a blocked person is shown: where to go, for THEIR panel's channel. */
export async function joinPrompt(audience) {
  const cfg = await activeConfig(audience);
  if (!cfg) return null;
  return {
    channelUsername: cfg.channelUsername,
    inviteLink: cfg.channelInviteLink
      || (cfg.channelUsername ? `https://t.me/${String(cfg.channelUsername).replace(/^@/, '')}` : ''),
    botUsername: cfg.botUsername,
    generation: cfg.generation,
  };
}
