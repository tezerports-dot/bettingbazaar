// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Press "Top Up Wallet" and "Deduct From Wallet" in a real browser.
 *
 * ── Why a browser, when there is already a route test and a panel test ─────
 * The route test proves the handler works. The panel test proves the function
 * puts the right bytes on the wire. Neither could see that **"Deduct From
 * Wallet" had never once worked**: the path resolved, the method was right, and
 * the request was missing a HEADER the route requires, so the operator got a
 * 400 rendered as a toast reading "Idempotency-Key is required for this
 * request". Every tier was green (§28, S26). The only thing that finds that is
 * pressing the button and reading what the screen then says.
 *
 * So this asserts the whole chain in one pass, per §31: the control exists, a
 * person can fill it in, pressing it changes the SERVER (balance and the money
 * record, both read back from the database, not from the screen), and the
 * screen says something a human can act on.
 *
 *   node backend/tests/browser/walletButtons.js
 *
 * Needs a backend (BB_BASE, default 127.0.0.1:8099) and starts vite itself.
 */
import { chromium } from 'playwright-core';
import { setTimeout as sleep } from 'node:timers/promises';
import { API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite, settle } from './stack.js';
import { seedAdmin, seedMerchant } from '../e2e/seed.js';
import { adminToken } from '../e2e/harness.js';
import { db } from '#db';

const cfg = PANELS['admin-panel'];
const BASE = `http://127.0.0.1:${cfg.port}`;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The balance the WALLET holds, which is the only one a transfer will find. */
const balanceOf = (id) => db.merchantWallets.getMerchantTokenBalance(id);

async function main() {
  if (!await waitFor(`${API}/health/live`, 'the backend')) process.exit(1);

  const admin = await seedAdmin();
  const token = adminToken(admin);
  const merchant = await seedMerchant({
    currency: 'INR', tokensPaise: 500000000, cashDenominationPaise: 500000,
  });

  children.push(startVite('admin-panel', cfg.port));
  if (!await waitFor(`${BASE}/admin/`, 'the admin dev server')) { stopAll(); process.exit(1); }

  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  // The session goes on the CONTEXT before any page exists, the way drive.js
  // installs it. Setting it on an already-created page leaves the very first
  // navigation unauthenticated, and the admin panel answers that with its
  // sign-in screen — which looks exactly like "the table rendered no rows".
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([k, v]) => {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  }, [cfg.key, cfg.wrap(token)]);
  const page = await ctx.newPage();

  // Surface what the panel is actually told, so a failure here reads as the
  // server's refusal rather than "the button did nothing".
  const toasts = [];
  page.on('console', (m) => { if (m.type() === 'error') toasts.push(m.text()); });

  try {
    // ── Enter at the root, THEN move to the screen ────────────────────────
    // A deep link on the very first load loses a race the operator never sees:
    // the guard runs before the persisted session has rehydrated, sends the app
    // to #/login, and the screen that arrives is the sign-in form — which reads
    // from the outside exactly like "the merchants table is empty". Entering at
    // the root and then moving is what drive.js does, and it is what a person
    // does too.
    await page.goto(cfg.entry(BASE), { waitUntil: 'domcontentloaded' });
    await settle(page, 9000);
    await page.evaluate(() => { window.location.hash = '/merchants'; });
    await settle(page, 12000);

    // ── Open THIS merchant's wallet, the way an operator does ─────────────
    // By the row carrying its name and that row's own "Limits" control, not by
    // whichever row happens to be first: a test that clicks row one and asserts
    // against a merchant it seeded is asserting about two different merchants,
    // which is how §23's KYC bug looked from the outside.
    const rows = page.locator('tbody tr');
    if (await rows.count() === 0) {
      await page.screenshot({ path: '/tmp/claude-0/wallet-no-rows.png' });
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
      throw new Error(`the merchants table rendered no rows — screen said: ${body}`);
    }
    const mine = page.locator('tbody tr', { hasText: merchant.name }).first();
    if (await mine.count() === 0) {
      throw new Error(`seeded merchant ${merchant.name} is not on page 1 of ${await rows.count()} rows`);
    }
    await mine.getByTitle('Limits').click();
    await settle(page, 6000);

    // The wallet controls live on the detail modal. Find them by the LABEL a
    // person reads, not by a CSS class — a label that cannot address its own
    // control is S24, and a test that reaches past it would hide that.
    const topUpAmount   = page.getByLabel('Amount to Add (Rs. tokens)');
    const topUpPaid     = page.getByLabel(/Received from merchant/);
    const currency      = page.getByLabel('Settlement currency');
    const topUpButton   = page.getByRole('button', { name: /Top Up Wallet/ });

    record('the top-up settlement input exists and is addressable by its label',
      await topUpPaid.count() > 0);
    record('the currency selector exists', await currency.count() > 0);

    // ── The button refuses to arm without the figure ───────────────────────
    await topUpAmount.fill('1000');
    await settle(page, 1200);
    const disabledWithoutFigure = await topUpButton.isDisabled();
    record('Top Up stays disabled until the settlement figure is filled in',
      disabledWithoutFigure);

    // ── Press it for real ──────────────────────────────────────────────────
    const before = await balanceOf(merchant.merchantId);
    await topUpPaid.fill('950');
    await settle(page, 800);
    record('Top Up arms once both figures are in', !(await topUpButton.isDisabled()));

    await topUpButton.click();
    await settle(page, 6000);

    const afterTopUp = await balanceOf(merchant.merchantId);
    record('pressing Top Up credited the wallet',
      afterTopUp === before + 1000, `${before} → ${afterTopUp}`);

    const topUpRows = (await db.adminTokenConsiderations.listForMerchant(merchant.merchantId))
      .filter((r) => r.direction === 'RECEIVED');
    record('pressing Top Up recorded what the platform received',
      topUpRows.length === 1 && topUpRows[0].inrEquivalentPaise === 95000,
      topUpRows.length ? `₹${topUpRows[0].inrEquivalentPaise / 100} recorded` : 'no row written');

    const said = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    record('the screen confirms what was BOOKED, not just what was typed',
      /recorded/i.test(said) || /topped up/i.test(said),
      said.match(/[^.]*topped up[^.]*/i)?.[0]?.trim().slice(0, 120) ?? '(no confirmation seen)');

    // ── The other button — the one that had never worked ───────────────────
    const deductAmount = page.getByLabel('Amount to Remove (Rs. tokens)');
    const deductReason = page.getByLabel(/Reason \(required/);
    const deductPaid   = page.getByLabel(/Paid back to merchant/);
    const deductButton = page.getByRole('button', { name: /Deduct From Wallet/ });

    record('the paid-back input exists and is addressable by its label',
      await deductPaid.count() > 0);

    const beforeDeduct = await balanceOf(merchant.merchantId);
    await deductAmount.fill('400');
    await deductReason.fill('top-up correction');
    await deductPaid.fill('400');
    await settle(page, 800);
    await deductButton.click();
    await settle(page, 6000);

    const afterDeduct = await balanceOf(merchant.merchantId);
    record('pressing Deduct actually deducted — this is the button that 400\'d on every press',
      afterDeduct === beforeDeduct - 400, `${beforeDeduct} → ${afterDeduct}`);

    const paidRows = (await db.adminTokenConsiderations.listForMerchant(merchant.merchantId))
      .filter((r) => r.direction === 'PAID');
    record('pressing Deduct recorded what the platform paid out',
      paidRows.length === 1 && paidRows[0].inrEquivalentPaise === 40000,
      paidRows.length ? `₹${paidRows[0].inrEquivalentPaise / 100} recorded` : 'no row written');

    const afterWords = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    record('no protocol message reached the operator',
      !/Idempotency-Key/i.test(afterWords),
      /Idempotency-Key/i.test(afterWords) ? 'the header refusal is on screen' : '');

    // ── And the figures reach the screen that reports them ─────────────────
    const profitTab = page.getByRole('button', { name: /Profit/i }).first();
    if (await profitTab.count()) {
      await profitTab.click();
      await settle(page, 6000);
      const profitWords = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      record('the Profit tab shows the platform\'s own side of the trade',
        /Platform .{0,3} Merchant Token Trade/i.test(profitWords)
        && /Received for Tokens/i.test(profitWords),
        profitWords.match(/Net to Platform[^A-Z]{0,24}/)?.[0]?.trim() ?? '');
    } else {
      record('the Profit tab shows the platform\'s own side of the trade', false, 'no Profit tab found');
    }
  } catch (err) {
    record('the pass completed', false, err.message);
  } finally {
    await browser.close().catch(() => {});
    stopAll();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (toasts.length) console.log('console errors:', toasts.slice(0, 5));
  process.exit(failed.length ? 1 : 0);
}

main();
