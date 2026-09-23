// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Press the bet button, as a player, in a real browser.
 *
 * ── Why this needed its own pass ───────────────────────────────────────────
 * `POST /bet/place` requires an `Idempotency-Key`, and the user panel sends
 * one — but `CORS_SHAPE.allowedHeaders` did not name it. A browser asks
 * permission for a header it has not been promised, and CANCELS the request
 * when the answer omits it. So from any origin other than the API's own, the
 * platform's most-used control never reached the server: no status code, no log
 * line, nothing for a route test to see, and the panel left holding a network
 * error rather than a refusal it could explain.
 *
 * Every tier below a browser was green. `curl` sends whatever it is told, so
 * the route tests passed; the panel test would have proved the header is SET,
 * which it was. The only thing that finds this is a real browser making a real
 * cross-origin request, which is what this does: the panel runs on its own
 * origin and the API on another, exactly as §15 deploys them.
 *
 *   node backend/tests/browser/betButton.js
 */
import { chromium } from 'playwright-core';
import { API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite, settle } from './stack.js';
import { seedPlayer } from '../e2e/seed.js';
import { playerToken } from '../e2e/harness.js';
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';

const cfg = PANELS['user-panel'];
const BASE = `http://127.0.0.1:${cfg.port}`;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  if (!await waitFor(`${API}/health/live`, 'the backend')) process.exit(1);

  const player = await seedPlayer({ balancePaise: 500000 });
  const token = playerToken(player);

  children.push(startVite('user-panel', cfg.port));
  if (!await waitFor(`${BASE}/`, 'the user dev server')) { stopAll(); process.exit(1); }

  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 480, height: 940 } });
  await ctx.addInitScript(([k, v]) => {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  }, [cfg.key, cfg.wrap(token)]);
  const page = await ctx.newPage();

  const corsBlocks = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/blocked by CORS policy/i.test(t)) corsBlocks.push(t);
  });

  try {
    await page.goto(cfg.entry(BASE), { waitUntil: 'domcontentloaded' });
    await settle(page, 12000);

    // ── The real cross-origin preflight, from the panel's own origin ───────
    // Asked from INSIDE the page, so the browser applies the same CORS rules it
    // applies to the bet itself. A 400 or 401 here is a PASS: the request
    // reached the server and was answered. A TypeError is the failure — that is
    // the browser cancelling before anything was sent.
    const reached = await page.evaluate(async (api) => {
      try {
        const r = await fetch(`${api}/api/bet/place`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'browser-preflight-probe' },
          body: JSON.stringify({}),
        });
        return { ok: true, status: r.status };
      } catch (e) {
        return { ok: false, error: String(e && e.message) };
      }
    }, API);

    record('a bet request carrying Idempotency-Key REACHES the server from the panel\'s origin',
      reached.ok, reached.ok ? `answered ${reached.status}` : reached.error);
    record('the browser raised no CORS block for it',
      corsBlocks.length === 0, corsBlocks[0]?.slice(0, 140) ?? '');

    // ── And the control itself ─────────────────────────────────────────────
    const before = (await getBalances(player.userId)).depositBalance ?? 0;
    // ── Get to the board first ────────────────────────────────────────────
    // The home screen has a "DELHI BAZAAR vs Bombay" CATEGORY card, and a
    // name-matched click on /Delhi/ lands on that instead of on the bet card —
    // which then reports a press that navigated as a bet that did nothing. The
    // amount input only exists on the board, so it is the thing to wait for.
    const amountSel = 'input[placeholder^="Or type amount"]';
    if (await page.locator(amountSel).count() === 0) {
      const entry = page.getByRole('button', { name: /DELHI BAZAAR/i }).first();
      if (await entry.count()) { await entry.click(); await settle(page, 10000); }
    }
    if (await page.locator(amountSel).count() === 0) {
      // The board may be reachable only by its route.
      await page.evaluate(() => { window.location.hash = '/game'; });
      await settle(page, 10000);
    }

    // A stake needs an amount first — the screen refuses with "Pick a chip or
    // enter an amount first" otherwise, which would make a press that never
    // reached the network look like a refusal the server issued.
    const amount = page.locator(amountSel).first();
    if (await amount.count()) await amount.fill('500');
    await settle(page, 1500);

    // ── The BET card, not the category card ───────────────────────────────
    // Both are buttons and both contain "Delhi": the home strip's "DELHI BAZAAR
    // vs Bombay" comes first in the DOM, and its path is `/` — the board itself
    // — so clicking it navigates nowhere and changes nothing. A pass that took
    // it for the bet card reported the platform's main control as INERT. The
    // bet card carries its landmark, "India Gate", which the category card does
    // not.
    const betButton = page.getByRole('button', { name: /India Gate/i }).first();
    if (await betButton.count() === 0) {
      record('the bet control is on screen', false, 'no India Gate / Gateway of India card found');
    } else {
      record('the bet control is on screen', true);
      await betButton.click();
      await settle(page, 8000);
      const after = (await getBalances(player.userId)).depositBalance ?? 0;
      const words = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      // A stake may legitimately be refused (the cycle may be past its close
      // boundary when the click lands), so what is asserted is that the platform
      // ANSWERED — money moved, or it said why. Silence is the failure.
      const moved = after !== before;
      const reason = words.match(/(Bets just closed[^.]*|Pick a chip[^.]*|Minimum bet[^.]*|Maximum[^.]*|Insufficient[^.]*|You already backed[^.]*|Bet placed[^.]*|closed for this cycle[^.]*)/i)?.[0];
      // A stake may legitimately be refused — the cycle can cross its close
      // boundary while the click is in flight — so what is asserted is that the
      // platform ANSWERED. Silence is the failure, and the detail must print
      // what the screen SAID rather than restating the branch, or a harness
      // that measured nothing reads exactly like one that measured a refusal.
      record('pressing it either moved money or said why',
        moved || Boolean(reason),
        // `getBalances` answers in RUPEES (`paiseToRupees` at the boundary), not
        // paise — dividing again here printed a ₹500 stake as "₹5", which is the
        // kind of figure a report is believed on.
        moved ? `₹${before - after} left the deposit balance`
              : (reason ? `refused: "${reason.trim().slice(0, 90)}"` : `NOTHING — screen unchanged: ${words.slice(0, 120)}`));
      record('no CORS block on the real press', corsBlocks.length === 0);
    }
  } catch (err) {
    record('the pass completed', false, err.message);
  } finally {
    await browser.close().catch(() => {});
    stopAll();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
