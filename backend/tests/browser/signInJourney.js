// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Sign up and sign in in a real browser, the way a person does it, on all
 * three panels and the Telegram Mini App page: "Continue with Telegram" for
 * players and merchants (owner, 2026-10-13/14), a password and an
 * authenticator code for staff.
 *
 * ── Why this exists beside test:e2e's scenario 9 ───────────────────────────
 * s9-telegram.js drives the same flows as HTTP requests. It proves the server;
 * it renders nothing. `test:browser` opens every screen but installs a token
 * instead of signing in. This one presses the buttons, reads the number the
 * screen shows, answers on the Mini App page itself (its own number buttons,
 * its Verify and Deny), follows the handoff link Verify opens, and then reads
 * what the panel did: the screen it moved to, the token it stored, the row it
 * wrote.
 *
 * ── What stands in for Telegram ─────────────────────────────────────────────
 * The Mini App page loads Telegram's script from telegram.org. This pass
 * answers that one request with a stand-in that sets `Telegram.WebApp`:
 * `initData` and the `requestContact` answer are signed in this process with
 * the test bot's token (miniAppFixture.js), by the algorithm the server
 * verifies, so the page and the server run unchanged; `openLink` records the
 * address Verify opens. Telegram's own UI (its contact prompt, the chat that
 * opens the page, the browser it opens the site in) is NOT covered.
 *
 * ── What it needs ───────────────────────────────────────────────────────────
 * A running dev server at BB_BASE (default http://127.0.0.1:8099) on the
 * DATABASE_URL this process is given, started with BB_RATE_LIMIT_RELAX (§34:
 * a dev server for a browser pass), ALLOW_NO_CAPTCHA and
 * TELEGRAM_BOT_HEALTH_MS=0 (the test token is fake), and no real bot saved: the test bot is saved for the run and removed after. It starts the
 * three panels' own dev servers itself (stack.js).
 *
 *   npm run test:signin-journey
 *   BB_HEADED=1 npm run test:signin-journey     watch it happen
 */
import { chromium } from 'playwright-core';
import { setTimeout as sleep } from 'node:timers/promises';
import { pgQuery } from '#db/client.js';
import { db } from '#db';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { base32Decode, totp } from '../../domains/identity/totp.service.js';
import { API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite } from './stack.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId, TEST_BOT,
} from '../miniAppFixture.js';
import { rid } from '../e2e/harness.js';

const PW = 'Browser-Staff-Pass-7q!';
const base = (panel) => `http://127.0.0.1:${PANELS[panel].port}`;
const USER = base('user-panel');
const ADMIN = base('admin-panel');
const MERCHANT = base('merchant-panel');
const LAPTOP = { viewport: { width: 1280, height: 860 } };
const PHONE = {
  viewport: { width: 400, height: 820 },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
};

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A ten-digit Indian mobile nobody has, with the first digit given. */
const mobile = (first = '9') => `${first}${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
const startParamOf = (href) => (href ? new URL(href).searchParams.get('startapp') : null);
/** A signed contact; each one is claimed once, so every share gets its own second. */
let contactAge = 0;
const contactOf = (tgId, phone) => signContact({
  telegramUserId: tgId, phone: `91${phone}`, authDate: Math.floor(Date.now() / 1000) - (contactAge += 1),
});

/** What the page under Telegram would see: `Telegram.WebApp`, standing in for telegram.org's script. */
const telegramScript = (initData, contact) => `
window.Telegram = { WebApp: {
  initData: ${JSON.stringify(initData)},
  ready() {}, expand() {}, close() { window.__miniAppClosed = true; },
  openLink(url) { window.__opened = url; },
  requestContact(cb) { setTimeout(() => cb(${contact ? 'true' : 'false'}, ${contact ? `{ response: ${JSON.stringify(contact)} }` : 'undefined'}), 0); },
  requestWriteAccess(cb) { cb(true); },
} };`;

/**
 * Open the Mini App page as Telegram would: launched on `startParam` by the
 * Telegram account `tgId`, sharing `contact` when the page asks for one.
 */
async function openMiniApp(browser, { tgId, startParam, contact = null }) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 760 } });
  await ctx.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: telegramScript(signInitData({ telegramUserId: tgId, startParam }), contact),
  }));
  const page = await ctx.newPage();
  await page.goto(`${USER}/mini-app.html`, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

/** Wait for `fn` to answer truthy, asking every half second. */
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(500);
  }
  return null;
}

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const stored = (page, key) => page.evaluate((k) => { try { return localStorage.getItem(k); } catch { return null; } }, key);
const linkOf = async (userId) => (await pgQuery(
  'SELECT telegram_user_id FROM telegram_links WHERE user_id = $1', [userId], 'journey_link')).rows[0] ?? null;

/** The Telegram link and, on a laptop, the number the waiting screen shows. */
async function waitingStep(page) {
  const open = page.getByRole('link', { name: /Open Telegram|Login with Telegram/ });
  await open.waitFor({ timeout: 15_000 }).catch(() => {});
  const param = startParamOf(await open.getAttribute('href').catch(() => null));
  const shown = page.getByTestId('match-number');
  const number = (await shown.count()) ? Number((await shown.innerText()).trim()) : null;
  return { param, number };
}

/** On the Mini App page: pick the number (a laptop's sign-in) and press Verify. */
async function verifyOnMiniApp(tg, { number = null } = {}) {
  const verify = tg.page.getByRole('button', { name: /^(Share contact and verify|Verify)$/ });
  await verify.waitFor({ timeout: 15_000 }).catch(() => {});
  if (number !== null) await tg.page.getByRole('button', { name: String(number), exact: true }).click();
  await verify.click();
}

/** The player app, signed out, with "Sign in or join" open. */
async function playerModal(browser, device) {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  await page.goto(`${USER}/#/`, { waitUntil: 'domcontentloaded' });
  const opener = page.getByRole('button', { name: /Sign in or join|Sign in\s*to play/i }).filter({ visible: true }).first();
  await opener.waitFor({ timeout: 30_000 });
  await opener.click();
  // The player's screen asks for the sign-in when its captcha ticks (none
  // here), and its one control is the "Login with Telegram" link.
  await page.getByRole('link', { name: 'Login with Telegram' }).waitFor({ timeout: 15_000 });
  return { ctx, page };
}
const playerSignedIn = (page) => until(async () => Boolean(await stored(page, 'auth_token'))
  && (await page.getByRole('button', { name: /Sign in or join|Sign in\s*to play/i }).filter({ visible: true }).count()) === 0);

async function playerJourney(browser) {
  const m = mobile('9');
  const tgId = freshTelegramUserId();

  // ── A laptop, a new person: the number match, and Verify makes the account ─
  const laptop = await playerModal(browser, LAPTOP);
  record('player: the sign-in offers no mobile or password box',
    (await laptop.page.locator('input[type="password"], input[type="tel"]').count()) === 0);
  const first = await waitingStep(laptop.page);
  record('player: a laptop shows a number, the Telegram link and its QR',
    Boolean(first.param) && Number.isInteger(first.number)
      && (await laptop.page.getByRole('img', { name: /QR code that opens Telegram/ }).count()) > 0,
    `startapp=${first.param} number=${first.number}`);

  const tg = await openMiniApp(browser, { tgId, startParam: first.param, contact: contactOf(tgId, m) });
  const offer = await until(async () => /creates your player account/.test(await bodyText(tg.page)) && bodyText(tg.page));
  record('Mini App: the Verify screen says Verify creates the account, and names who asked',
    Boolean(offer) && (await tg.page.getByTestId('verify-request').count()) > 0,
    offer ? offer.slice(0, 110) : await bodyText(tg.page));
  const picks = await tg.page.locator('fieldset button').allInnerTexts();
  record('Mini App: three numbers to choose from, the right one among them',
    picks.length === 3 && picks.map(Number).includes(first.number), picks.join(' '));
  await verifyOnMiniApp(tg, { number: first.number });
  const done = await until(async () => (await tg.page.getByRole('status').count()) > 0 && tg.page.getByRole('status').innerText());
  record('Mini App: Verify is answered with the server\'s sentence', Boolean(done), done || await bodyText(tg.page));
  await tg.ctx.close();

  record('player: the laptop signs in by itself', Boolean(await playerSignedIn(laptop.page)));
  const created = await db.users.getUserByMobile(m, 'PLAYER');
  const link = created ? await linkOf(created.userId) : null;
  const pw = created ? (await db.users.getUserCredentials(created.userId)).passwordHash : 'no account';
  record('player: the account is the shared number, linked to that Telegram, with no password',
    link?.telegram_user_id === tgId && pw === null, `${created?.userId} ${link?.telegram_user_id} ${pw}`);
  await laptop.ctx.close();

  // ── A phone: the handoff ticket ──────────────────────────────────────────
  const phone = await playerModal(browser, PHONE);
  const second = await waitingStep(phone.page);
  record('player: a phone shows no number, only the Telegram link', Boolean(second.param) && second.number === null,
    `startapp=${second.param}`);
  const tg2 = await openMiniApp(browser, { tgId, startParam: second.param });
  await verifyOnMiniApp(tg2);
  const opened = await until(() => tg2.page.evaluate(() => window.__opened || null));
  const ticket = String(opened || '').split('#/tg/')[1] || '';
  record('Mini App: Verify opens the site with a one-time ticket in the fragment', ticket.length >= 40,
    String(opened).replace(ticket, '<ticket>'));
  await tg2.ctx.close();

  const handedOff = await until(async () => /signed in where Telegram opened the site/.test(await bodyText(phone.page)));
  record('player: the page that asked is told the session went where Telegram opened the site', Boolean(handedOff));
  await phone.ctx.close();

  const site = await browser.newContext(PHONE);
  const sitePage = await site.newPage();
  await sitePage.goto(`${USER}/#/tg/${ticket}`, { waitUntil: 'domcontentloaded' });
  record('player: the site opened on the ticket signs in', Boolean(await playerSignedIn(sitePage)));
  record('player: the ticket is gone from the address bar', !sitePage.url().includes(ticket), sitePage.url().replace(ticket, '<ticket>'));
  await site.close();

  const again = await browser.newContext(PHONE);
  const againPage = await again.newPage();
  await againPage.goto(`${USER}/#/tg/${ticket}`, { waitUntil: 'domcontentloaded' });
  const refused = await until(async () => /already been used or has expired/.test(await bodyText(againPage)));
  record('player: the same ticket opened again is refused, in words', Boolean(refused) && !(await stored(againPage, 'auth_token')));
  await again.close();

  // ── Deny ─────────────────────────────────────────────────────────────────
  const deny = await playerModal(browser, LAPTOP);
  const third = await waitingStep(deny.page);
  const tg3 = await openMiniApp(browser, { tgId, startParam: third.param });
  await tg3.page.getByRole('button', { name: 'Deny' }).click();
  await until(async () => (await tg3.page.getByRole('status').count()) > 0);
  await tg3.ctx.close();
  const told = await until(async () => {
    const a = deny.page.getByRole('alert');
    return (await a.count()) > 0 && /refused in Telegram/.test(await a.first().innerText()) && a.first().innerText();
  });
  record('player: Deny in Telegram is shown on the waiting page as an alert, and signs nobody in',
    Boolean(told) && !(await stored(deny.page, 'auth_token')), told || await bodyText(deny.page));
  await deny.ctx.close();
}

async function staffJourney(browser) {
  const userId = rid('staff');
  const m = mobile('8');
  await db.users.createUser({ userId, username: userId, mobile: m, passwordHash: await hashPassword(PW), accountType: 'STAFF', isAdmin: true });
  await db.users.setRoles(userId, ['admin']);

  const ctx = await browser.newContext(LAPTOP);
  const page = await ctx.newPage();
  await page.goto(`${ADMIN}/admin/#/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#mobile').waitFor({ timeout: 30_000 });
  record('staff: the sign-in screen has no captcha and no Telegram',
    (await page.locator('iframe[src*="turnstile"], .cf-turnstile').count()) === 0 && !/Telegram/.test(await bodyText(page)));
  await page.locator('#mobile').fill(m);
  await page.locator('#password').fill(PW);
  await page.getByRole('button', { name: /Sign in/ }).click();

  // A first sign-in sets the authenticator up: the key the screen shows, then its code.
  const key = page.getByTestId('totp-secret');
  await key.waitFor({ timeout: 15_000 }).catch(() => {});
  const secret = (await key.count()) ? (await key.innerText()).replace(/\s+/g, '') : '';
  record('staff: the password is answered with the authenticator setup, its key shown', secret.length >= 16);
  await page.locator('#totp-first-code').fill(totp(base32Decode(secret)));
  await page.locator('#totp-first-code').press('Enter');
  const saved = page.locator('#codes-saved');
  await saved.waitFor({ timeout: 15_000 }).catch(() => {});
  record('staff: the right code shows the recovery codes once', (await saved.count()) > 0, (await saved.count()) ? '' : await bodyText(page));
  await saved.check();
  await page.getByRole('button', { name: /Continue/ }).click();
  const session = await until(async () => {
    const raw = await stored(page, 'admin-auth');
    const state = raw ? JSON.parse(raw).state : null;
    return state?.token && state.isAuthenticated && !/#\/login/.test(page.url()) && page.url();
  });
  record('staff: the panel signs in and leaves the sign-in screen', Boolean(session), session || page.url());
  await ctx.close();
}

async function merchantJourney(browser) {
  // ── An approved merchant ─────────────────────────────────────────────────
  const m = mobile('7');
  const created = await createMerchantAccount({
    userId: db.users.newUserId(), username: rid('m').replace(/-/g, ''), mobile: m, currency: 'INR',
  });
  await pgQuery(`UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED' WHERE merchant_id = $1`,
    [created.merchant.merchantId], 'journey_merchant_approve');
  const tgId = await linkTelegram(created.userId);

  const ctx = await browser.newContext(LAPTOP);
  const page = await ctx.newPage();
  await page.goto(`${MERCHANT}/merchant/`, { waitUntil: 'domcontentloaded' });
  const button = page.getByRole('button', { name: /Continue with Telegram/ });
  await button.waitFor({ timeout: 30_000 });
  record('merchant: the sign-in screen has no captcha and no password box',
    (await page.locator('iframe[src*="turnstile"], .cf-turnstile, input[type="password"]').count()) === 0);
  await button.click();
  const step = await waitingStep(page);
  record('merchant: a laptop shows a number and the Telegram link', Boolean(step.param) && Number.isInteger(step.number),
    `startapp=${step.param} number=${step.number}`);
  const tg = await openMiniApp(browser, { tgId, startParam: step.param });
  await verifyOnMiniApp(tg, { number: step.number });
  await until(async () => (await tg.page.getByRole('status').count()) > 0);
  await tg.ctx.close();
  const session = await until(async () => Boolean(await stored(page, 'merchantToken'))
    && (await page.getByRole('button', { name: /Continue with Telegram/ }).count()) === 0);
  record('merchant: Verified in Telegram, the panel signs in and leaves the sign-in screen', Boolean(session), page.url());
  await ctx.close();

  // ── A new applicant ──────────────────────────────────────────────────────
  const am = mobile('6');
  const atg = freshTelegramUserId();
  const actx = await browser.newContext(LAPTOP);
  const apage = await actx.newPage();
  await apage.goto(`${MERCHANT}/merchant/`, { waitUntil: 'domcontentloaded' });
  await apage.getByRole('button', { name: /Continue with Telegram/ }).click();
  const astep = await waitingStep(apage);
  const atgPage = await openMiniApp(browser, { tgId: atg, startParam: astep.param, contact: contactOf(atg, am) });
  const says = await until(async () => /merchant application/.test(await bodyText(atgPage.page)));
  record('Mini App: a new merchant is told Verify submits an application an admin approves', Boolean(says));
  await verifyOnMiniApp(atgPage, { number: astep.number });
  await until(async () => (await atgPage.page.getByRole('status').count()) > 0);
  await atgPage.ctx.close();
  const waiting = await until(async () => /waiting for approval/i.test(await bodyText(apage)));
  const row = await db.users.getUserByMobile(am, 'MERCHANT');
  record('merchant: the applicant\'s page says the application waits for approval; nothing signs in',
    Boolean(waiting) && Boolean(row) && !(await stored(apage, 'merchantToken')), row?.userId);
  await actx.close();
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('needs DATABASE_URL, the database the server at BB_BASE runs on'); process.exit(1); }
  if (!await waitFor(`${API}/health/live`, 'the backend')) process.exit(1);
  const { rows: before } = await pgQuery('SELECT bot_id FROM telegram_bot', [], 'journey_bot_before');
  if (before[0] && before[0].bot_id !== TEST_BOT.botId) {
    console.error(`bot ${before[0].bot_id} is saved in this database; this pass does not replace a real bot`);
    process.exit(1);
  }
  await saveTestBot();
  let code = 1;
  try {
    // The server caches the bot (miniAppBot, 5 s unless TELEGRAM_CONFIG_TTL_MS).
    const ready = await until(async () => (await (await fetch(`${API}/api/telegram/mini-app?panel=PLAYER`)).json()).available, 40_000);
    if (!ready) throw new Error('the server never reported the test bot as available');

    for (const panel of ['user-panel', 'admin-panel', 'merchant-panel']) children.push(startVite(panel, PANELS[panel].port));
    for (const [panel, url] of [['user-panel', `${USER}/`], ['admin-panel', `${ADMIN}/admin/`], ['merchant-panel', `${MERCHANT}/merchant/`]]) {
      if (!await waitFor(url, `the ${panel} dev server`)) throw new Error(`${panel} did not start`);
    }
    const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: !process.env.BB_HEADED, args: ['--no-sandbox'] });
    try {
      console.log('\nPlayer'); await playerJourney(browser);
      console.log('\nStaff'); await staffJourney(browser);
      console.log('\nMerchant'); await merchantJourney(browser);
    } finally { await browser.close(); }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length} checks, ${results.length - failed} pass, ${failed} fail`);
    code = failed ? 1 : 0;
  } catch (err) {
    console.error(err);
  } finally {
    if (!before[0]) await removeTestBot();
    stopAll();
  }
  process.exit(code);
}

main();
