// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/telegramChallenge.service.js — asking the Mini App.
 *
 * Every time the platform needs Telegram to answer for an account (Step 3,
 * owner 2026-10-07) it opens a challenge here and hands the browser two things:
 *
 *   • `telegram` — `{ url, botUsername, expiresAt }`: the deep link that opens
 *     the Mini App on this challenge. Shown or opened by the panel.
 *   • `challengeToken` — the signed token the browser polls with and nobody
 *     else holds (twoFactorChallenge.js).
 *
 * The windows (CLAUDE.md §2, "Telegram challenge"):
 *   VERIFY                       15 minutes — a new account's first step,
 *                                which may mean installing Telegram.
 *   LOGIN, TELEGRAM_LOGIN,        5 minutes — a person at a screen, waiting.
 *   RELINK, TWO_FACTOR_OFF
 *   an approval, to be redeemed   2 minutes — the polling browser takes it
 *                                within seconds.
 */
import crypto from 'crypto';
import { db } from '#db';
import { miniAppBot, miniAppLink } from '../telegram/telegramClient.js';
import { issueChallenge } from './twoFactorChallenge.js';
import { refusal } from '../../shared/httpError.js';

export const CHALLENGE_TTL_SECONDS = Object.freeze({
  VERIFY: 15 * 60,
  LOGIN: 5 * 60,
  TELEGRAM_LOGIN: 5 * 60,
  RELINK: 5 * 60,
  TWO_FACTOR_OFF: 5 * 60,
});

/** How long an approved challenge waits to be redeemed. */
export const REDEEM_WINDOW_SECONDS = 2 * 60;

/** A challenge id: also the Mini App's start parameter, so `[A-Za-z0-9_-]`. */
export function newChallengeId() {
  return `c${crypto.randomBytes(16).toString('hex')}`;
}

/** What a start parameter that names a challenge looks like. */
export const CHALLENGE_PARAM = /^c[0-9a-f]{32}$/;

/** The refusal for "no bot is configured", worded for the person who meets it. */
export function telegramUnavailable() {
  return refusal(503, 'TELEGRAM_UNAVAILABLE',
    'Telegram verification is not available right now. Please try again later.');
}

/** The block every panel renders: where to open the Mini App, and until when. */
export function telegramBlock(bot, challenge) {
  return {
    url: miniAppLink(bot, challenge.challengeId),
    botUsername: bot.botUsername,
    expiresAt: challenge.expiresAt,
  };
}

/**
 * Open a challenge and mint its token.
 *
 * @param {object} o
 * @param {string} o.purpose   VERIFY | LOGIN | TELEGRAM_LOGIN | RELINK | TWO_FACTOR_OFF
 * @param {'PLAYER'|'STAFF'|'MERCHANT'} o.door
 * @param {string|null} o.userId
 * @param {import('express').Request} [o.req]  for the address and device the
 *   Mini App shows the person approving
 * @param {string|null} [o.loginType]
 * @returns {Promise<{challengeToken: string, telegram: object, challengeId: string}>}
 * @throws 503 TELEGRAM_UNAVAILABLE when no bot is configured
 */
export async function openChallenge({ purpose, door, userId = null, req = null, loginType = null }) {
  const bot = await miniAppBot();
  if (!bot) throw telegramUnavailable();
  const ttlSeconds = CHALLENGE_TTL_SECONDS[purpose];
  if (!ttlSeconds) throw new Error(`openChallenge: unknown purpose ${purpose}`);
  const challenge = await db.telegram.createChallenge({
    challengeId: newChallengeId(),
    purpose, audience: door, userId, ttlSeconds,
    requestedIp: req?.ip || '',
    requestedAgent: req?.get?.('user-agent') || '',
  });
  return {
    challengeId: challenge.challengeId,
    challengeToken: issueChallenge({
      userId, door, challengeId: challenge.challengeId, loginType,
      ttlSeconds: ttlSeconds + REDEEM_WINDOW_SECONDS,
    }),
    telegram: telegramBlock(bot, challenge),
  };
}
