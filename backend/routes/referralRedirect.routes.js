// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routes/referralRedirect.routes.js — GET /r/:code
 *
 * The shared referral link is ours, never Telegram's: it is pasted into
 * WhatsApp, printed and saved for months, and must survive the bot behind it
 * being replaced. So it points HERE and is redirected at the moment of the tap.
 *
 * ── Where it goes (Step 3, owner 2026-10-07: "telegram mini app ... for
 * signup and referal code basis") ─────────────────────────────────────────
 *   a bot is configured → the Mini App, opened with `ref-<CODE>`, where the
 *                          person signs up with the code locked and their
 *                          mobile verified by the same contact share
 *   no bot              → the player app's signup form with `?ref=<CODE>`,
 *                          which pre-fills and locks the code; the account
 *                          verifies when a bot exists (their next sign-in)
 *
 * Not an open redirect: the destination is always t.me with our bot, or our
 * own player origin; the only thing taken from the URL is the code, validated
 * against the referral alphabet before it is used. A code of the wrong shape is
 * dropped, and the visitor still reaches signup.
 */
import express from 'express';
import { miniAppBot, miniAppLink } from '../domains/telegram/telegramClient.js';
import { recordReferralClick } from '../domains/referral/referral.service.js';
import { panelOrigin } from '../config/panelOrigins.js';

const router = express.Router();

/** The referral alphabet, plus the lenient shapes a hand-typed code takes. */
const CODE_SHAPE = /^[A-Za-z0-9_-]{4,32}$/;

router.get('/r/:code', async (req, res) => {
  const raw = String(req.params.code || '');
  const code = CODE_SHAPE.test(raw) ? raw.toUpperCase() : '';

  let bot = null;
  try {
    bot = await miniAppBot();
  } catch (err) {
    // A lookup that throws must not become a broken link: the form still works.
    console.error('[referral-redirect] could not read the bot:', err.message);
  }

  // Recorded before the redirect and never allowed to delay it.
  if (code) {
    recordReferralClick({ code, ip: clientIp(req) })
      .catch((err) => console.warn('[referral-redirect] click not recorded:', err.message));
  }

  const site = panelOrigin('PLAYER') || '';
  const target = bot && code
    ? miniAppLink(bot, `ref-${code}`)
    : `${site}/${code ? `?ref=${encodeURIComponent(code)}` : ''}`;

  // 302, never 301: a cached permanent redirect would pin today's bot in
  // browsers and caches nobody can clear.
  res.set('Cache-Control', 'no-store, private');
  return res.redirect(302, target);
});

/**
 * The viewer's address, as `req.ip` resolves it through the trust-proxy
 * setting. Only ever hashed, never stored or logged.
 */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

export default router;
