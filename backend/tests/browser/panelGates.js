// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The MERCHANT and ADMIN verification gates, opened in a real browser.
 *
 * ── Why a browser, and what every tier below one cannot see ───────────────
 * `panelSplit.mjs` proves the server: the right bot reaches the right account,
 * the right channel gates it, the right panel's origin gets the reset link.
 * None of that says a merchant ever SEES a gate. A gate is a component
 * somebody has to mount, on a layout every screen actually renders inside, and
 * the failure mode is silent in exactly the way §28 describes: the component
 * exists, the endpoint works, and nothing puts the two together.
 *
 * Four things are asserted here that only a rendered page can answer:
 *
 *   1. The gate is ON SCREEN for an unverified account — not merely importable.
 *   2. It BLOCKS: no close control inside the dialog, and Escape does nothing.
 *      §33.3 — every path it guards is already refused by the server, so a
 *      close button would not restore access, it would hide the one
 *      instruction that does.
 *   3. It names THIS panel's bot. A merchant told to open the player bot has
 *      been sent to a conversation that cannot answer them (§33.2), and the
 *      copy is the only place that mistake shows.
 *   4. The admin BOOTSTRAP banner appears while staff Telegram is unconfigured
 *      and the gate does NOT block — otherwise the screen that configures it
 *      sits behind the gate that has nothing to check, and nobody can ever
 *      reach it from any account.
 *
 * Needs a backend on BB_BASE against the database this process connects to.
 * It puts every row it creates back in a `finally` (trap 10).
 *
 *   BB_BASE=http://127.0.0.1:8098 node backend/tests/browser/panelGates.js
 */
import { chromium } from 'playwright-core';
import { setTimeout as sleep } from 'node:timers/promises';
import { API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite } from './stack.js';
import { seedMerchant, seedAdmin } from '../e2e/seed.js';
import { merchantToken, adminToken } from '../e2e/harness.js';
import { pgQuery } from '#db/client.js';
import { db } from '#db';
import { encryptField } from '../../domains/identity/fieldCrypto.util.js';

const pass = [], fail = [];
const ok = (name, cond, detail = '') => {
  (cond ? pass : fail).push(`${cond ? '✓' : '✗'} ${name}${detail ? `\n      ${detail}` : ''}`);
  return cond;
};

const stamp = String(Date.now()).slice(-7);
const madeBots = [], madeGenerations = [];

/**
 * Take a panel's Telegram surface DOWN, and hand back a restore.
 *
 * ── §32 S19, paid for by this very file ───────────────────────────────────
 * The bootstrap assertion assumed "nothing is configured for STAFF" and never
 * established it. Run against a database another pass had configured, it
 * measured a gate that correctly blocked, reported a failure, and the failure
 * was this file reading whatever the database happened to hold.
 *
 * A pass that needs a state SETS it. The rows are deactivated rather than
 * deleted — a config is append-only history — and put back in a `finally`.
 */
async function standDown(audience) {
  const bots = await pgQuery(
    `UPDATE telegram_bots SET status = 'STANDBY'
      WHERE audience = $1 AND status = 'ACTIVE' RETURNING bot_id`, [audience]);
  const cfgs = await pgQuery(
    `UPDATE telegram_configs SET active = FALSE
      WHERE audience = $1 AND active RETURNING generation`, [audience]);
  return async () => {
    for (const r of bots.rows) {
      await pgQuery(`UPDATE telegram_bots SET status = 'ACTIVE' WHERE bot_id = $1`,
                    [r.bot_id]).catch(() => {});
    }
    for (const r of cfgs.rows) {
      await pgQuery(`UPDATE telegram_configs SET active = TRUE WHERE generation = $1`,
                    [r.generation]).catch(() => {});
    }
  };
}
const restores = [];

/** A live sign-in bot and channel for one panel, created by this pass alone. */
async function configure(audience) {
  const botId = `gate-${audience}-${stamp}`;
  await db.telegram.addBot({
    botId, label: `${audience} gate probe`, role: 'signin', audience,
    username: `bb_gate_${audience.toLowerCase()}`,
    tokenEncrypted: encryptField('000:FAKE'), webhookSecret: `gsec-${audience}-${stamp}`,
    status: 'ACTIVE',
  });
  madeBots.push(botId);
  const cfg = await db.telegram.activateConfig({
    audience, channelId: `-100gate${stamp}`, reason: `gate probe ${stamp}`,
  });
  madeGenerations.push(cfg.generation);
  return cfg;
}

/** What is actually on screen inside the blocking dialog, if there is one. */
async function readGate(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    const banner = document.querySelector('[role="status"]');
    return {
      hasDialog: !!dialog,
      title: dialog?.querySelector('h2')?.textContent?.trim() ?? '',
      text: dialog?.textContent?.trim() ?? '',
      // Every control INSIDE the dialog. A close control is what would make
      // this not a gate, so it is counted here and nowhere wider: an earlier
      // version counted the whole PAGE and reported the panel's own header
      // buttons as a way out of a modal that has none.
      controls: [...(dialog?.querySelectorAll('button, a[href], [role="button"]') ?? [])]
        .map((el) => (el.textContent || el.getAttribute('aria-label') || '').trim()),
      steps: [...(dialog?.querySelectorAll('li') ?? [])].map((li) => li.textContent.trim()),
      primaryHref: dialog?.querySelector('a[href]')?.getAttribute('href') ?? '',
      bannerText: banner?.textContent?.trim() ?? '',
    };
  });
}

const closeish = (label) =>
  /^(close|dismiss|cancel|skip|×|✕|x|back|later|not now)$/i.test(label.replace(/\s+/g, ' ').trim());

let browser;
try {
  if (!(await waitFor(`${API}/health`, 'backend'))) process.exit(1);

  // ── The two panels this pass is about ──────────────────────────────────
  for (const panel of ['merchant-panel', 'admin-panel']) {
    children.push(startVite(panel, PANELS[panel].port));
  }
  for (const panel of ['merchant-panel', 'admin-panel']) {
    if (!(await waitFor(`http://127.0.0.1:${PANELS[panel].port}/`, panel))) process.exit(1);
  }

  browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. THE ADMIN BOOTSTRAP: nothing configured for STAFF
  // ══════════════════════════════════════════════════════════════════════════
  // Run FIRST and deliberately, because it is the only state that cannot be
  // reached again once a staff bot exists — and it is the state a fresh install
  // boots into, so it is the one an operator meets before any other.
  {
    // ESTABLISH the state rather than hope for it. See `standDown`.
    restores.push(await standDown('STAFF'));

    const cfg = PANELS['admin-panel'];
    const base = `http://127.0.0.1:${cfg.port}`;
    const admin = await seedAdmin();
    const ctx = await browser.newContext();
    await ctx.addInitScript(([k, v]) => {
      try { localStorage.setItem(k, v); } catch { /* blocked */ }
    }, [cfg.key, cfg.wrap(adminToken(admin))]);
    const page = await ctx.newPage();
    await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const view = await readGate(page);
    ok('ADMIN, nothing configured: the gate does NOT block',
       view.hasDialog === false, `dialog=${view.hasDialog} title="${view.title}"`);
    ok('ADMIN, nothing configured: the bootstrap banner IS shown',
       /not switched on/i.test(view.bannerText), view.bannerText.slice(0, 160) || '(no banner)');
    ok('and the banner names the screen that closes it',
       /bot fleet/i.test(view.bannerText), view.bannerText.slice(0, 200) || '(no banner)');
    await ctx.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. THE MERCHANT GATE, with a merchant bot and channel live
  // ══════════════════════════════════════════════════════════════════════════
  {
    await configure('MERCHANT');
    const cfg = PANELS['merchant-panel'];
    const base = `http://127.0.0.1:${cfg.port}`;
    const merchant = await seedMerchant({ currency: 'INR' });
    const ctx = await browser.newContext();
    await ctx.addInitScript(([k, v, ck, cv]) => {
      try { localStorage.setItem(k, v); if (ck) localStorage.setItem(ck, cv); } catch { /* blocked */ }
    }, [cfg.key, cfg.wrap(merchantToken(merchant)), cfg.cacheKey, JSON.stringify({
      id: merchant.merchantId, merchantId: merchant.merchantId, username: merchant.username,
      mobile: merchant.mobile, isOnline: true, status: 'ACTIVE', acceptedCurrencies: ['INR'],
    })]);
    const page = await ctx.newPage();
    await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const view = await readGate(page);
    ok('MERCHANT: the gate is ON SCREEN for an unverified merchant',
       view.hasDialog === true, `dialog=${view.hasDialog} title="${view.title}"`);
    ok('MERCHANT: it names the MERCHANT bot, not the player one',
       /merchant bot/i.test(view.text), view.text.slice(0, 200));
    ok('MERCHANT: both steps are shown, and both read as not done',
       view.steps.length === 2 && view.steps.every((s) => /not done yet/i.test(s)),
       JSON.stringify(view.steps));
    ok('MERCHANT: there is NO close control inside the dialog',
       view.controls.filter(closeish).length === 0, JSON.stringify(view.controls));

    // Escape, pressed for real. A handler somebody adds later is exactly the
    // kind of change that would slip past every other tier.
    await page.keyboard.press('Escape');
    await sleep(700);
    ok('MERCHANT: Escape does not dismiss it',
       (await readGate(page)).hasDialog === true);

    // And the backdrop, clicked. `role="dialog"` is the backdrop element here,
    // so a click at its top-left corner is a click on the backdrop itself.
    await page.mouse.click(5, 5);
    await sleep(700);
    ok('MERCHANT: clicking the backdrop does not dismiss it',
       (await readGate(page)).hasDialog === true);

    // The one control it DOES have must do something a person can see.
    const checkAgain = view.controls.find((c) => /check again/i.test(c));
    ok('MERCHANT: the only control offered is "check again"',
       !!checkAgain && view.controls.filter((c) => c.length).length <= 2,
       JSON.stringify(view.controls));
    await ctx.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. THE ADMIN GATE, once STAFF is configured — the bootstrap CLOSES
  // ══════════════════════════════════════════════════════════════════════════
  {
    await configure('STAFF');
    const cfg = PANELS['admin-panel'];
    const base = `http://127.0.0.1:${cfg.port}`;
    const admin = await seedAdmin();
    const ctx = await browser.newContext();
    await ctx.addInitScript(([k, v]) => {
      try { localStorage.setItem(k, v); } catch { /* blocked */ }
    }, [cfg.key, cfg.wrap(adminToken(admin))]);
    const page = await ctx.newPage();
    await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const view = await readGate(page);
    ok('ADMIN: the gate BLOCKS once a staff bot and channel exist',
       view.hasDialog === true, `dialog=${view.hasDialog} title="${view.title}"`);
    ok('ADMIN: the bootstrap banner is GONE',
       !/not switched on/i.test(view.bannerText), view.bannerText.slice(0, 120) || '(none)');
    ok('ADMIN: it names the ADMIN bot, not the player or merchant one',
       /admin bot/i.test(view.text), view.text.slice(0, 200));
    ok('ADMIN: there is NO close control inside the dialog',
       view.controls.filter(closeish).length === 0, JSON.stringify(view.controls));
    await page.keyboard.press('Escape');
    await sleep(700);
    ok('ADMIN: Escape does not dismiss it', (await readGate(page)).hasDialog === true);
    await ctx.close();
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  // Put the platform back, outside any assertion — a restore that only runs
  // when the pass succeeded is the one that matters least (trap 10).
  for (const botId of madeBots) {
    await pgQuery(`DELETE FROM telegram_bots WHERE bot_id = $1`, [botId]).catch(() => {});
  }
  for (const generation of madeGenerations) {
    await pgQuery(`DELETE FROM telegram_configs WHERE generation = $1`, [generation]).catch(() => {});
  }
  for (const restore of restores) await restore().catch(() => {});
  stopAll();
}

console.log(`\n${pass.join('\n')}`);
if (fail.length) console.log(`\nFAILURES:\n${fail.join('\n')}`);
console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
process.exit(fail.length ? 1 : 0);
