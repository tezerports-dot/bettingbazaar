// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * routes/referralRedirect.routes.js — GET /r/:code
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 * A referral link used to be `https://t.me/<botUsername>?start=<code>`, built in
 * the browser from whichever bot was live when the referrer opened the page.
 *
 * That link then leaves. It is pasted into WhatsApp, forwarded, posted, saved,
 * printed. It lives for months in places nobody can reach — and it names a
 * specific bot.
 *
 * The whole point of the bot fleet is that a suspended bot is replaced in one
 * click. But every referral link ever shared would still name the DEAD bot: an
 * invited player taps it, Telegram says the bot does not exist, and the referrer
 * loses a signup they earned. Worse, it fails silently — nobody reports "the
 * link I sent my cousin last month is broken", so the platform's own referral
 * numbers quietly stop making sense.
 *
 * So the shared link points HERE, at our own domain, and this redirects to
 * whichever bot is live at the moment of the tap. The link never has to change,
 * because it never named a bot in the first place.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * Not an open redirect. The destination is always t.me and always the bot from
 * our own config; the only thing taken from the URL is the code, and that is
 * validated against the referral alphabet before it is used. A code that does
 * not match the shape is not passed through — it is dropped, and the visitor
 * still reaches the bot, because a mistyped link should still let someone sign
 * up.
 */
import express from 'express';
import { activeConfig } from '../domains/telegram/telegramClient.js';
import { recordReferralClick } from '../domains/referral/referral.service.js';

const router = express.Router();

/**
 * The referral alphabet, plus the older/lenient shapes a hand-typed code takes.
 *
 * `generateReferralCode` emits 8 characters from a Crockford-ish set. This
 * accepts a slightly wider range so a code entered by hand in a different case
 * still works, while still refusing anything that could change the meaning of
 * the URL it is interpolated into.
 */
const CODE_SHAPE = /^[A-Za-z0-9_-]{4,32}$/;

/** Telegram's own limit on a start payload. */
const MAX_PAYLOAD = 64;

router.get('/r/:code', async (req, res) => {
  const raw = String(req.params.code || '');
  const code = CODE_SHAPE.test(raw) && raw.length <= MAX_PAYLOAD ? raw.toUpperCase() : '';

  let cfg = null;
  try {
    cfg = await activeConfig();
  } catch (err) {
    // A config lookup that throws must not become a broken link. Fall through
    // to the "not available" page, which at least says something true.
    console.error('[referral-redirect] could not resolve the active bot:', err.message);
  }

  const bot = cfg?.botUsername ? String(cfg.botUsername).replace(/^@/, '') : '';
  if (!bot) {
    // No bot configured, or the platform is between generations. Telling the
    // visitor the truth beats sending them to a t.me URL that 404s, and it is
    // the state a fresh deployment sits in before Phase 3.5 of the runbook.
    res.status(503);
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(unavailablePage());
  }

  // Recorded before the redirect and never allowed to delay it: the visitor is
  // mid-tap, and a slow database must not become a slow link.
  if (code) {
    recordReferralClick({ code, ip: clientIp(req) })
      .catch((err) => console.warn('[referral-redirect] click not recorded:', err.message));
  }

  const target = code
    ? `https://t.me/${encodeURIComponent(bot)}?start=${encodeURIComponent(code)}`
    : `https://t.me/${encodeURIComponent(bot)}`;

  // 302, deliberately, not 301. A permanent redirect would be cached by
  // browsers and intermediaries against the CURRENT bot — which would recreate
  // the exact problem this endpoint exists to solve, and this time in caches
  // nobody can clear.
  res.set('Cache-Control', 'no-store, private');
  return res.redirect(302, target);
});

/**
 * The viewer's address, as seen through whatever sits in front of us.
 *
 * Only ever hashed, never stored or logged. `req.ip` already honours the
 * trust-proxy setting configured in server.js, so this does not re-parse
 * X-Forwarded-For — doing that by hand is how a header nobody validated becomes
 * a way to inflate somebody's click count.
 */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

function unavailablePage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-ups paused</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#12100c;color:#e8e2d4;font:15px/1.6 system-ui,-apple-system,sans-serif;padding:24px}
  main{max-width:380px;text-align:center}
  h1{font-size:19px;margin:0 0 10px}
  p{margin:0;color:#a49b86;font-size:13.5px}
</style>
</head><body><main>
<h1>Sign-ups are paused</h1>
<p>We're switching over to a new sign-up bot. Please try this link again shortly &mdash; it will keep working, so there's no need to ask for a new one.</p>
</main></body></html>`;
}

export default router;
