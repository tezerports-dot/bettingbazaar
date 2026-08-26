// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A referral link must outlive the bot it opens.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 * The link a player shares used to be `https://t.me/<botUsername>?start=<code>`,
 * built in the browser from whichever bot was live at page load.
 *
 * That link then LEAVES. It is pasted into WhatsApp, forwarded, screenshotted,
 * posted — and it lives for months in places nobody can reach. It names one
 * specific bot.
 *
 * Telegram suspends gambling bots, and this platform is built so that replacing
 * one is a single click. But every link already shared would still name the DEAD
 * bot: the invited player taps it, Telegram says the bot does not exist, and the
 * referrer loses a signup they earned. Silently — nobody reports that a link
 * they sent last month is broken.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * Two things, and they are the whole fix:
 *
 *   1. The redirect resolves the bot AT REQUEST TIME, so the same URL follows a
 *      bot swap. This is checked by swapping the bot between two requests and
 *      watching the destination move.
 *   2. The panel does not build a t.me link. A test of the server alone would
 *      pass while the browser kept minting the old, bot-specific URL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');

// The route's two collaborators are stubbed: this is about the redirect's
// contract, not about Telegram or Mongo.
let liveBotUsername = 'bazaar_signin_bot';
const clicks = [];

vi.mock('../../domains/telegram/telegramClient.js', () => ({
  activeConfig: async () => (liveBotUsername ? { botUsername: liveBotUsername } : null),
}));

vi.mock('../../domains/referral/referral.service.js', () => ({
  recordReferralClick: async (args) => { clicks.push(args); return { counted: true }; },
}));

const { default: referralRedirect } = await import('../../routes/referralRedirect.routes.js');

function app() {
  const a = express();
  a.use('/', referralRedirect);
  return a;
}

beforeEach(() => {
  liveBotUsername = 'bazaar_signin_bot';
  clicks.length = 0;
});

describe('the link survives a bot replacement', () => {
  it('sends the visitor to whichever bot is live at the moment of the tap', async () => {
    const before = await request(app()).get('/r/ABC12345');
    expect(before.status).toBe(302);
    expect(before.headers.location).toBe('https://t.me/bazaar_signin_bot?start=ABC12345');

    // Telegram suspends the bot; an operator promotes the standby.
    liveBotUsername = 'bazaar_backup_bot';

    // THE SAME URL — the one already sitting in a hundred WhatsApp threads.
    const after = await request(app()).get('/r/ABC12345');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('https://t.me/bazaar_backup_bot?start=ABC12345');
  });

  it('carries the code through as the /start argument, so nobody types it', async () => {
    const res = await request(app()).get('/r/ZZZZ9999');
    expect(res.headers.location).toContain('?start=ZZZZ9999');
  });

  it('never answers with a cacheable redirect', async () => {
    // A 301 would be cached by browsers and intermediaries against the CURRENT
    // bot — recreating this exact bug inside caches nobody can clear.
    const res = await request(app()).get('/r/ABC12345');
    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });
});

describe('the redirect cannot be turned into someone else’s link', () => {
  it('refuses to pass through a code that is not a code', async () => {
    // The code is interpolated into a URL. Anything that could change where
    // that URL points is dropped — the visitor still reaches the bot, because a
    // mistyped link should not be a dead end.
    for (const bad of ['../evil', 'a b', 'x'.repeat(80), '%2e%2e', 'a?b=c', 'a#b']) {
      const res = await request(app()).get(`/r/${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(302);
      expect(res.headers.location, bad).toBe('https://t.me/bazaar_signin_bot');
      expect(res.headers.location, bad).not.toContain('start=');
    }
  });

  it('always lands on t.me, whatever the bot username contains', async () => {
    liveBotUsername = 'evil.example/x?';
    const res = await request(app()).get('/r/ABC12345');
    expect(res.headers.location.startsWith('https://t.me/')).toBe(true);
  });

  it('does not count a click for a code it refused', async () => {
    await request(app()).get('/r/..');
    expect(clicks).toHaveLength(0);
  });

  it('counts exactly one click for a valid code', async () => {
    await request(app()).get('/r/ABC12345');
    expect(clicks).toHaveLength(1);
    expect(clicks[0].code).toBe('ABC12345');
  });
});

describe('when there is no bot to send anyone to', () => {
  it('says so rather than redirecting to a chat that does not exist', async () => {
    // The state a fresh deployment sits in before the runbook's Phase 3.5, and
    // the state a suspension leaves until a spare is promoted.
    liveBotUsername = '';
    const res = await request(app()).get('/r/ABC12345');
    expect(res.status).toBe(503);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toMatch(/paused/i);
    // The reassurance matters: a referrer must not go asking for a new link.
    expect(res.text).toMatch(/keep working/i);
  });
});

describe('the browser does not mint a bot-specific link', () => {
  // A server-side test alone would pass while the panel kept building
  // `t.me/<bot>?start=` — which is where the bug actually lived.
  const page = readFileSync(join(repo, 'user-panel/src/pages/ReferralPage.tsx'), 'utf8');

  it('builds the shared link from our own origin', () => {
    expect(page).toMatch(/\/r\/\$\{encodeURIComponent\(data\.referralCode\)\}/);
  });

  it('has no t.me link construction left in the share path', () => {
    // t.me/share/url is fine — that is the share SHEET, and the url it carries
    // is our own. A `t.me/${bot}` template is not.
    const templated = page.match(/https:\/\/t\.me\/\$\{[^}]*bot[^}]*\}/g) || [];
    expect(templated, 'the shared link must not name a bot').toEqual([]);
  });
});
