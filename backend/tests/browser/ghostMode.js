// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * GHOST MODE, pressed as a phantom agent, in a real browser — ON and OFF.
 *
 * ── Why this pass exists ───────────────────────────────────────────────────
 * Measured, not guessed (owner, 2026-10-01). Route coverage across every tier
 * found `POST /api/bet/phantom` answered only with refusals — 400 and 403 —
 * and never once with a phantom bet placed. The control inventory never
 * contained the GHOST MODE toggle at all: it renders only for an account with
 * `phantom_access`, and every browser pass opened the player panel as a plain
 * player. So the feature an operator uses to balance the visible pool had no
 * press anywhere, and its one route had never been seen to do its work.
 *
 * What it asserts, against the DATABASE and not the screen:
 *
 *   - a plain player has NO toggle                     (the opposite case, §37 step 6)
 *   - a phantom agent has it, and it starts OFF
 *   - ON:  a bet press writes a PHANTOM bet row (is_phantom, the agent as its
 *          manager) and moves NO money out of the agent's wallet
 *   - OFF: the same press is a REAL bet, and the stake leaves the wallet
 *
 *   node backend/tests/browser/ghostMode.js        (npm run test:ghost-mode)
 *
 * Needs a backend (`BB_BASE`) on the database it seeds (`DATABASE_URL`).
 */
import { chromium } from 'playwright-core';
import { pgQuery } from '#db/client.js';
import { API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite, settle, configureTelegram } from './stack.js';
import { seedPlayer } from '../e2e/seed.js';
import { playerToken } from '../e2e/harness.js';
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';

const cfg = PANELS['user-panel'];
const BASE = `http://127.0.0.1:${cfg.port}`;
const STAKE = 500;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A signed-in player page on the board. */
async function boardAs(browser, player) {
  const ctx = await browser.newContext({ viewport: { width: 480, height: 940 } });
  await ctx.addInitScript(([k, v]) => {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  }, [cfg.key, cfg.wrap(playerToken(player))]);
  const page = await ctx.newPage();
  await page.goto(cfg.entry(BASE), { waitUntil: 'domcontentloaded' });
  await settle(page, 12000);
  // The board is where the amount box lives; the home strip's category card
  // is a different button with "DELHI" in it (see betButton.js).
  const amountSel = 'input[placeholder^="Or type amount"]';
  if (await page.locator(amountSel).count() === 0) {
    const entry = page.getByRole('button', { name: /DELHI BAZAAR/i }).first();
    if (await entry.count()) { await entry.click(); await settle(page, 10000); }
  }
  if (await page.locator(amountSel).count() === 0) {
    await page.evaluate(() => { window.location.hash = '/game'; });
    await settle(page, 10000);
  }
  return { ctx, page, amountSel };
}

const ghostToggle = (page) => page.getByRole('button', { name: /GHOST MODE/i }).first();

/** Bets are only taken while the board is open; wait out a closed window rather than report it as a refusal. */
async function waitForOpenBoard(page, ms = 120000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const words = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (/NEXT RESULT IN|POOLS MERGED/i.test(words) && !/BETS CLOSED/i.test(words)) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

async function press(page, amountSel) {
  await page.locator(amountSel).first().fill(String(STAKE));
  await settle(page, 1000);
  await page.getByRole('button', { name: /India Gate/i }).first().click();
  await settle(page, 8000);
}

const betsOf = async (userId) => (await pgQuery(
  `SELECT bet_id, is_phantom, phantom_manager_id, stake_paise::bigint AS stake, side, cycle_id
     FROM bets WHERE user_id = $1 ORDER BY placed_at`, [userId], 'ghost_mode_bets',
)).rows.map((r) => ({ ...r, stake: Number(r.stake) }));

async function main() {
  if (!await waitFor(`${API}/health/live`, 'the backend')) process.exit(1);
  const restoreTelegram = await configureTelegram();

  const plain = await seedPlayer({ balancePaise: 500000 });
  const agent = await seedPlayer({ balancePaise: 500000 });
  await pgQuery(`UPDATE users SET phantom_access = 'BOTH' WHERE user_id = $1`, [agent.userId], 'ghost_mode_grant');

  children.push(startVite('user-panel', cfg.port));
  if (!await waitFor(`${BASE}/`, 'the user dev server')) { stopAll(); process.exit(1); }
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });

  try {
    // ── The opposite case: a plain player is offered nothing ───────────────
    {
      const { ctx, page, amountSel } = await boardAs(browser, plain);
      record('the board loaded for a plain player', await page.locator(amountSel).count() > 0);
      record('a plain player has NO ghost mode toggle', await ghostToggle(page).count() === 0);
      await ctx.close();
    }

    const { page, amountSel } = await boardAs(browser, agent);
    const toggle = ghostToggle(page);
    if (await toggle.count() === 0) {
      record('a phantom agent sees the ghost mode toggle', false, 'no GHOST MODE button on the board');
      return;
    }
    record('a phantom agent sees the ghost mode toggle', true);
    record('it starts OFF', /OFF/.test(await toggle.innerText()), await toggle.innerText());

    // ── ON: a phantom bet, and no money moves ──────────────────────────────
    await toggle.click();
    await settle(page, 1500);
    record('pressing it turns it ON', /ON/.test(await toggle.innerText()), await toggle.innerText());
    const words = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    record('the board says ghost mode is active', /GHOST MODE ACTIVE/i.test(words));

    if (!await waitForOpenBoard(page)) {
      record('the board opened for bets within two minutes', false, 'it stayed closed; nothing below was pressed');
      return;
    }
    const walletBefore = (await getBalances(agent.userId)).depositBalance ?? 0;
    await press(page, amountSel);
    const afterPhantom = await betsOf(agent.userId);
    const phantom = afterPhantom.find((b) => b.is_phantom);
    const walletAfterPhantom = (await getBalances(agent.userId)).depositBalance ?? 0;
    const said = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    record('ON: the press wrote a PHANTOM bet row', Boolean(phantom),
      phantom ? `${phantom.bet_id}, ₹${phantom.stake / 100} on ${phantom.side}`
        : `rows: ${JSON.stringify(afterPhantom)}; screen: ${said.match(/Phantom[^.]{0,80}|Bets just closed[^.]*/i)?.[0] ?? said.slice(0, 120)}`);
    if (phantom) {
      record('ON: the phantom bet names the agent as its manager', phantom.phantom_manager_id === agent.userId, phantom.phantom_manager_id);
      record(`ON: the phantom stake is the ₹${STAKE} pressed`, phantom.stake === STAKE * 100, `₹${phantom.stake / 100}`);
    }
    record('ON: NO money left the agent\'s wallet', walletAfterPhantom === walletBefore, `₹${walletBefore} → ₹${walletAfterPhantom}`);
    record('ON: no REAL bet was written', !afterPhantom.some((b) => !b.is_phantom));

    // ── OFF: the same press is a real bet ─────────────────────────────────
    await toggle.click();
    await settle(page, 1500);
    record('pressing it again turns it OFF', /OFF/.test(await toggle.innerText()), await toggle.innerText());
    if (!await waitForOpenBoard(page)) {
      record('the board opened for bets within two minutes', false, 'it stayed closed; the OFF press was not made');
      return;
    }
    const realBefore = (await getBalances(agent.userId)).depositBalance ?? 0;
    await press(page, amountSel);
    const real = (await betsOf(agent.userId)).filter((b) => !b.is_phantom);
    const realAfter = (await getBalances(agent.userId)).depositBalance ?? 0;
    const words2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    record('OFF: the press wrote a REAL bet row', real.length === 1,
      real.length ? `${real[0].bet_id}` : `screen: ${words2.match(/Bets just closed[^.]*|Insufficient[^.]*|already backed[^.]*/i)?.[0] ?? words2.slice(0, 120)}`);
    record(`OFF: ₹${STAKE} left the wallet`, realBefore - realAfter === STAKE, `₹${realBefore} → ₹${realAfter}`);
  } catch (err) {
    record('the pass completed', false, err.message);
  } finally {
    await browser.close().catch(() => {});
    stopAll();
    await restoreTelegram().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
