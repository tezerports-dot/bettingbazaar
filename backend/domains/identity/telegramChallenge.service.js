// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/telegramChallenge.service.js — "Continue with Telegram".
 *
 * Every player and merchant sign-in (and signup: the same action, owner
 * 2026-10-13) opens a challenge here and hands the browser:
 *
 *   • `telegram` — `{ url, botUsername, expiresAt }`: the deep link that opens
 *     the Mini App on this challenge. Shown or opened by the panel.
 *   • `challengeToken` — the signed token the browser polls with and nobody
 *     else holds (twoFactorChallenge.js).
 *   • `delivery`, and for MATCH the `matchNumber` the browser shows.
 *
 * The windows:
 *   a sign-in                     5 minutes — a person at a screen, waiting.
 *   an approval, to be redeemed   2 minutes — the polling browser takes it
 *                                within seconds.
 *   a handoff ticket              60 seconds — the Mini App opens it at once.
 */
import crypto from 'crypto';
import { db } from '#db';
import { miniAppBot, miniAppLink } from '../telegram/telegramClient.js';
import { issueChallenge } from './twoFactorChallenge.js';
import { refusal } from '../../shared/httpError.js';
import { publicAppOrigin } from '../../config/publicAppOrigin.js';

/** How long a sign-in waits for Verify. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

/** How long an approved challenge waits to be redeemed. */
export const REDEEM_WINDOW_SECONDS = 2 * 60;

/** How long a handoff ticket lives: the Mini App opens the site at once. */
export const TICKET_TTL_SECONDS = 60;

/**
 * The number a MATCH sign-in shows the browser, and the three the Mini App
 * offers: the right one and two others, all two-digit, in random order.
 * `crypto.randomInt`, so neither the number nor its place can be predicted.
 */
export function drawMatch() {
  const number = crypto.randomInt(10, 100);
  const picks = new Set([number]);
  while (picks.size < 3) picks.add(crypto.randomInt(10, 100));
  const choices = [...picks];
  for (let i = choices.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return { number, choices };
}

/**
 * A new handoff ticket: 32 random bytes (256 bits), base64url so it rides in a
 * URL fragment untouched, and the SHA-256 that is all the database keeps.
 */
export function newTicket() {
  const ticket = crypto.randomBytes(32).toString('base64url');
  return { ticket, hash: ticketHash(ticket) };
}

/** What `telegram_handoff_tickets` keys a ticket by. */
export function ticketHash(ticket) {
  return crypto.createHash('sha256').update(String(ticket)).digest('hex');
}

/** Where each panel lives on the public origin (the api role serves all three, deploy/vps/Caddyfile.vps). */
const PANEL_PATH = Object.freeze({ PLAYER: '/', MERCHANT: '/merchant/' });

/**
 * Where Verify sends the person, decided here and never by the page:
 * `https://<site>/#/tg/<ticket>` for a player, `/merchant/#/tg/<ticket>` for a
 * merchant. The ticket rides in the FRAGMENT, which a browser never sends to a
 * server or in a Referer. Null without a ticket: the site's address alone, for
 * the sentence the Mini App shows above Verify.
 *
 * @throws 503 SITE_ADDRESS_UNSET when `PUBLIC_APP_ORIGIN` is not set: there is
 *   nowhere to send the person, and saying so beats a link to nowhere.
 */
export function destinationFor(audience, ticket = null) {
  const origin = publicAppOrigin();
  if (!origin) {
    throw refusal(503, 'SITE_ADDRESS_UNSET',
      'The website address is not set up yet, so Telegram cannot send you there. Please tell support.');
  }
  const base = `${origin}${PANEL_PATH[audience] || '/'}`;
  return ticket ? `${base}#/tg/${ticket}` : base;
}

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
 * Open a "Continue with Telegram" sign-in and mint its token.
 *
 * @param {object} o
 * @param {'PLAYER'|'MERCHANT'} o.door  (staff have no Telegram: the CHECK refuses STAFF)
 * @param {import('express').Request} [o.req]  for the address and device the
 *   Mini App shows the person approving
 * @param {'MATCH'|'HANDOFF'} [o.delivery]
 * @param {string|null} [o.referralCode]  a player's invite, used only if the
 *   sign-in creates the account
 * @returns {Promise<{challengeToken: string, telegram: object, challengeId: string,
 *   delivery: string, matchNumber: number|null}>}
 * @throws 503 TELEGRAM_UNAVAILABLE when no bot is configured
 */
export async function openChallenge({ door, req = null, delivery = 'MATCH', referralCode = null }) {
  const bot = await miniAppBot();
  if (!bot) throw telegramUnavailable();
  const how = delivery === 'HANDOFF' ? 'HANDOFF' : 'MATCH';
  const match = how === 'MATCH' ? drawMatch() : null;
  const challenge = await db.telegram.createChallenge({
    challengeId: newChallengeId(),
    audience: door, ttlSeconds: CHALLENGE_TTL_SECONDS,
    requestedIp: req?.ip || '',
    requestedAgent: req?.get?.('user-agent') || '',
    delivery: how, match,
    referralCode: door === 'PLAYER' ? referralCode : null,
  });
  return {
    challengeId: challenge.challengeId,
    challengeToken: issueChallenge({
      door, challengeId: challenge.challengeId,
      ttlSeconds: CHALLENGE_TTL_SECONDS + REDEEM_WINDOW_SECONDS,
    }),
    telegram: telegramBlock(bot, challenge),
    delivery: how,
    // The browser that asked shows this; the Mini App never sees which of its
    // three choices it is.
    matchNumber: match ? match.number : null,
  };
}
