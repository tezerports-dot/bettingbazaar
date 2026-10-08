// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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

// The route's collaborators are stubbed: this is about the redirect's
// contract, not about Telegram or the database. `miniAppLink` is the real one.
let liveBot = { botUsername: 'bazaar_bot', miniAppShortName: '' };
const clicks = [];

vi.mock('../../domains/telegram/telegramClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  miniAppBot: async () => liveBot,
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
  liveBot = { botUsername: 'bazaar_bot', miniAppShortName: '' };
  clicks.length = 0;
});

describe('the link survives a bot replacement (Step 3: it opens the Mini App)', () => {
  it('opens the Mini App of whichever bot is configured at the moment of the tap', async () => {
    const before = await request(app()).get('/r/ABC12345');
    expect(before.status).toBe(302);
    expect(before.headers.location).toBe('https://t.me/bazaar_bot?startapp=ref-ABC12345');

    // Telegram suspends the bot; an admin saves a new one.
    liveBot = { botUsername: 'bazaar_backup_bot', miniAppShortName: 'play' };

    // THE SAME URL — the one already sitting in a hundred WhatsApp threads.
    const after = await request(app()).get('/r/ABC12345');
    expect(after.headers.location).toBe('https://t.me/bazaar_backup_bot/play?startapp=ref-ABC12345');
  });

  it('carries the code as the signed start parameter, so nobody types it', async () => {
    const res = await request(app()).get('/r/zzzz9999');
    expect(res.headers.location).toContain('?startapp=ref-ZZZZ9999');
  });

  it('never answers with a cacheable redirect', async () => {
    const res = await request(app()).get('/r/ABC12345');
    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });
});

describe('the redirect cannot be turned into someone else’s link', () => {
  it('drops a code that is not a code, and still reaches signup', async () => {
    for (const bad of ['../evil', 'a b', 'x'.repeat(80), '%2e%2e', 'a?b=c', 'a#b']) {
      const res = await request(app()).get(`/r/${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(302);
      expect(res.headers.location, bad).toBe('/');
      expect(res.headers.location, bad).not.toContain('ref');
    }
  });

  it('always lands on t.me, whatever the bot username contains', async () => {
    liveBot = { botUsername: 'evil.example/x?', miniAppShortName: '' };
    const res = await request(app()).get('/r/ABC12345');
    expect(res.headers.location.startsWith('https://t.me/')).toBe(true);
    expect(res.headers.location).not.toContain('evil.example/');
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

describe('when there is no bot', () => {
  it('sends the visitor to the signup form with the code, rather than a dead chat', async () => {
    liveBot = null;
    const res = await request(app()).get('/r/ABC12345');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?ref=ABC12345');
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
