// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Sign up, sign in and reset a password in a real browser, the way a person
 * does it, on all three panels and the Telegram Mini App page (Step 3).
 *
 * ── Why this exists beside test:e2e's scenario 9 ───────────────────────────
 * s9-telegram.js drives the same flows as HTTP requests. It proves the server;
 * it renders nothing. `test:browser` opens every screen but installs a token
 * instead of typing into the login forms, so until this pass no test had ever
 * pressed a sign-in button. This one types into the forms, follows the
 * "Open Telegram" link the screen shows, answers on the Mini App page itself
 * (its own buttons, its own password boxes), and then reads what the panel
 * did: the screen it moved to, the token it stored, the row it wrote.
 *
 * ── What stands in for Telegram ─────────────────────────────────────────────
 * The Mini App page loads Telegram's script from telegram.org. This pass
 * answers that one request with a stand-in that sets `Telegram.WebApp`:
 * `initData` and the `requestContact` answer are signed in this process with
 * the test bot's token (miniAppFixture.js), by the algorithm the server
 * verifies, so the page and the server run unchanged. Telegram's own UI (its
 * contact prompt, the chat that opens the page) is NOT covered.
 *
 * ── What it needs ───────────────────────────────────────────────────────────
 * A running dev server at BB_BASE (default http://127.0.0.1:8099) on the
 * DATABASE_URL this process is given, started with BB_RATE_LIMIT_RELAX (§34:
 * a dev server for a browser pass), and no real bot saved: the test bot is
 * saved for the run and removed after. It starts the three panels' own dev
 * servers itself (stack.js).
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
import { API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite } from './stack.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId, TEST_BOT,
} from '../miniAppFixture.js';
import { rid } from '../e2e/harness.js';

const PW = 'Browser-Step3-Pass-7q!';
const NEW_PW = 'Browser-Fresh-Pass-4k!';
const base = (panel) => `http://127.0.0.1:${PANELS[panel].port}`;
const USER = base('user-panel');
const ADMIN = base('admin-panel');
const MERCHANT = base('merchant-panel');

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

/** The player app, signed out, with the sign-in modal open. */
async function playerModal(browser) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${USER}/#/`, { waitUntil: 'domcontentloaded' });
  const opener = page.getByRole('button', { name: /Sign in\s*to play/i }).first();
  await opener.waitFor({ timeout: 30_000 });
  await opener.click();
  await page.locator('#bb-login-mobile').waitFor({ timeout: 10_000 });
  return { ctx, page };
}
const playerSignedIn = (page) => until(async () =>
  (await page.getByRole('button', { name: /Wallet/i }).count()) > 0 && Boolean(await stored(page, 'auth_token')));

async function playerJourney(browser) {
  const m = mobile('9');
  const tgId = freshTelegramUserId();

  // ── Sign up with the form; verify the mobile in the Mini App ──────────────
  const { ctx, page } = await playerModal(browser);
  await page.getByRole('tab', { name: 'Sign up' }).click();
  await page.locator('#bb-signup-mobile').fill(m);
  await page.locator('#bb-password').fill(PW);
  await page.locator('#bb-confirm').fill(PW);
  await page.getByRole('button', { name: 'Create account' }).click();
  const open = page.getByRole('link', { name: /Open Telegram/ });
  await open.waitFor({ timeout: 15_000 }).catch(() => {});
  const verifyParam = startParamOf(await open.getAttribute('href').catch(() => null));
  record('player: the signup form ends on a Telegram step with an Open Telegram link',
    Boolean(verifyParam) && /Verify your mobile in Telegram/.test(await bodyText(page)), `startapp=${verifyParam}`);
  const created = await db.users.getUserByMobile(m, 'PLAYER');
  record('player: the account exists, and no session was stored yet',
    Boolean(created) && !(await stored(page, 'auth_token')), created?.userId);

  const tg = await openMiniApp(browser, { tgId, startParam: verifyParam, contact: contactOf(tgId, m) });
  const verifyText = await until(async () => /Verify the mobile number of your player account/.test(await bodyText(tg.page)) && bodyText(tg.page));
  record('Mini App: opened on the signup link, it asks to verify the player account', Boolean(verifyText),
    verifyText ? verifyText.slice(0, 90) : await bodyText(tg.page));
  await tg.page.getByRole('button', { name: 'Share contact and approve' }).click();
  const verified = await until(async () => (await tg.page.getByRole('status').count()) > 0 && tg.page.getByRole('status').innerText());
  record('Mini App: sharing the contact is answered with the server\'s sentence', Boolean(verified), verified || await bodyText(tg.page));
  await tg.ctx.close();

  record('player: the waiting screen signs in by itself after the share', Boolean(await playerSignedIn(page)));
  const link = created ? await linkOf(created.userId) : null;
  record('player: the account is linked to that Telegram account', link?.telegram_user_id === tgId, link?.telegram_user_id);
  await ctx.close();

  // ── Sign in with the password ─────────────────────────────────────────────
  const second = await playerModal(browser);
  await second.page.locator('#bb-login-mobile').fill(m);
  await second.page.locator('#bb-login-password').fill(PW);
  await second.page.getByRole('button', { name: 'Log in', exact: true }).click();
  record('player: mobile and password sign in, no Telegram step', Boolean(await playerSignedIn(second.page)));

  // ── Log in with Telegram ──────────────────────────────────────────────────
  const third = await playerModal(browser);
  await third.page.getByRole('button', { name: 'Log in with Telegram' }).click();
  const tlOpen = third.page.getByRole('link', { name: /Open Telegram/ });
  await tlOpen.waitFor({ timeout: 15_000 }).catch(() => {});
  const tlParam = startParamOf(await tlOpen.getAttribute('href').catch(() => null));
  const tl = await openMiniApp(browser, { tgId, startParam: tlParam });
  const asks = await until(async () => /Log in to your player account with Telegram/.test(await bodyText(tl.page)));
  if (asks) await tl.page.getByRole('button', { name: 'Approve', exact: true }).click();
  record('Mini App: Login with Telegram is approved on the page', Boolean(asks)
    && Boolean(await until(async () => (await tl.page.getByRole('status').count()) > 0)), tlParam);
  await tl.ctx.close();
  record('player: Login with Telegram signs in once approved', Boolean(await playerSignedIn(third.page)));
  await third.ctx.close();

  // ── Forgot password: set in the Mini App; the open session is signed out ──
  const fourth = await playerModal(browser);
  const resetHref = await fourth.page.getByRole('link', { name: /Forgot password/ }).getAttribute('href').catch(() => null);
  record('player: "Forgot password" opens the Mini App on the player reset', startParamOf(resetHref) === 'reset-PLAYER', resetHref);
  await fourth.ctx.close();

  await sleep(1100); // a session's `iat` is whole seconds; the cutoff must land after it
  const rs = await openMiniApp(browser, { tgId, startParam: 'reset-PLAYER', contact: contactOf(tgId, m) });
  await rs.page.locator('#mini-new-password').waitFor({ timeout: 15_000 }).catch(() => {});
  await rs.page.locator('#mini-new-password').fill(NEW_PW);
  await rs.page.locator('#mini-new-confirm').fill(NEW_PW);
  await rs.page.getByRole('button', { name: 'Share contact and reset' }).click();
  const changed = await until(async () => {
    const s = rs.page.getByRole('status');
    return (await s.count()) > 0 && /password has been changed/i.test(await s.innerText()) && s.innerText();
  });
  record('Mini App: a new password is set on the page', Boolean(changed), changed || await bodyText(rs.page));
  await rs.ctx.close();

  await second.page.reload({ waitUntil: 'domcontentloaded' });
  const signedOut = await until(async () => (await second.page.getByRole('button', { name: /Sign in\s*to play/i }).count()) > 0);
  record('player: the session opened before the reset is signed out', Boolean(signedOut));
  await second.ctx.close();

  const fifth = await playerModal(browser);
  await fifth.page.locator('#bb-login-mobile').fill(m);
  await fifth.page.locator('#bb-login-password').fill(NEW_PW);
  await fifth.page.getByRole('button', { name: 'Log in', exact: true }).click();
  record('player: the new password signs in', Boolean(await playerSignedIn(fifth.page)));
  await fifth.ctx.close();
}

/** Approve the sign-in the panel is waiting on, from the Mini App page. */
async function approveOnMiniApp(browser, page, tgId, who) {
  const open = page.getByRole('link', { name: /Open Telegram/ });
  await open.waitFor({ timeout: 15_000 }).catch(() => {});
  const param = startParamOf(await open.getAttribute('href').catch(() => null));
  record(`${who}: the password is answered with an Approve in Telegram step`, Boolean(param), `startapp=${param}`);
  const tg = await openMiniApp(browser, { tgId, startParam: param });
  const asks = await until(async () => new RegExp(`Someone is signing in to your ${who} account`).test(await bodyText(tg.page)));
  record(`Mini App: it shows the ${who} sign-in to approve`, Boolean(asks), asks ? '' : await bodyText(tg.page));
  if (asks) await tg.page.getByRole('button', { name: 'Approve', exact: true }).click();
  await until(async () => (await tg.page.getByRole('status').count()) > 0);
  await tg.ctx.close();
}

async function staffJourney(browser) {
  const userId = rid('staff');
  const m = mobile('8');
  await db.users.createUser({ userId, username: userId, mobile: m, passwordHash: await hashPassword(PW), accountType: 'STAFF', isAdmin: true });
  await db.users.setRoles(userId, ['admin']);
  const tgId = await linkTelegram(userId);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(`${ADMIN}/admin/#/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#mobile').waitFor({ timeout: 30_000 });
  record('staff: the sign-in screen has no captcha', (await page.locator('iframe[src*="turnstile"], .cf-turnstile').count()) === 0);
  await page.locator('#mobile').fill(m);
  await page.locator('#password').fill(PW);
  await page.getByRole('button', { name: /Sign in/ }).click();
  await approveOnMiniApp(browser, page, tgId, 'staff');
  const session = await until(async () => {
    const raw = await stored(page, 'admin-auth');
    const state = raw ? JSON.parse(raw).state : null;
    return state?.token && state.isAuthenticated && !/#\/login/.test(page.url()) && page.url();
  });
  record('staff: approved in Telegram, the panel signs in and leaves the sign-in screen', Boolean(session), session || page.url());
  await ctx.close();
}

async function merchantJourney(browser) {
  const m = mobile('7');
  const created = await createMerchantAccount({
    userId: db.users.newUserId(), username: rid('m').replace(/-/g, ''), mobile: m,
    passwordHash: await hashPassword(PW), currency: 'INR',
  });
  await pgQuery(`UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED' WHERE merchant_id = $1`,
    [created.merchant.merchantId], 'journey_merchant_approve');
  const tgId = await linkTelegram(created.userId);

  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${MERCHANT}/merchant/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-mobile').waitFor({ timeout: 30_000 });
  record('merchant: the sign-in screen has no captcha', (await page.locator('iframe[src*="turnstile"], .cf-turnstile').count()) === 0);
  const resetHref = await page.getByRole('link', { name: /Forgot password/ }).getAttribute('href').catch(() => null);
  record('merchant: "Forgot password" opens the Mini App on the merchant reset', startParamOf(resetHref) === 'reset-MERCHANT', resetHref);
  await page.locator('#login-mobile').fill(m);
  await page.locator('#login-password').fill(PW);
  await page.getByRole('button', { name: /Sign in securely/ }).click();
  await approveOnMiniApp(browser, page, tgId, 'merchant');
  const session = await until(async () => Boolean(await stored(page, 'merchantToken'))
    && (await page.locator('#login-mobile').count()) === 0);
  record('merchant: approved in Telegram, the panel signs in and leaves the sign-in screen', Boolean(session), page.url());

  // Forgot password, in the Mini App: the merchant floor is twelve.
  await sleep(1100);
  const rs = await openMiniApp(browser, { tgId, startParam: 'reset-MERCHANT', contact: contactOf(tgId, m) });
  await rs.page.locator('#mini-new-password').waitFor({ timeout: 15_000 }).catch(() => {});
  await rs.page.locator('#mini-new-password').fill('Eleven-char');
  await rs.page.locator('#mini-new-confirm').fill('Eleven-char');
  const button = rs.page.getByRole('button', { name: 'Share contact and reset' });
  record('Mini App: an eleven-character merchant password cannot be sent', await button.isDisabled());
  await rs.page.locator('#mini-new-password').fill(NEW_PW);
  await rs.page.locator('#mini-new-confirm').fill(NEW_PW);
  await button.click();
  const changed = await until(async () => {
    const s = rs.page.getByRole('status');
    return (await s.count()) > 0 && /password has been changed/i.test(await s.innerText());
  });
  record('Mini App: the merchant password is set on the page', Boolean(changed), changed ? '' : await bodyText(rs.page));
  await rs.ctx.close();

  await page.reload({ waitUntil: 'domcontentloaded' });
  const signedOut = await until(async () => (await page.locator('#login-mobile').count()) > 0);
  record('merchant: the session opened before the reset is signed out', Boolean(signedOut), page.url());
  await ctx.close();
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
    // The server caches the bot (miniAppBot, 30 s unless TELEGRAM_CONFIG_TTL_MS).
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
