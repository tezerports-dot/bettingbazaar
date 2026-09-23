// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Press the controls that CHANGE something, against rows this run created.
 *
 * ── Why these were not in the drive pass ───────────────────────────────────
 * `drive.js` presses everything that cannot do harm and DEFERS the rest with a
 * reason: pressing "Approve" on a live KYC queue is not a test, it is an
 * incident, and pressing "Save" on System Settings publishes whatever the form
 * happened to hold to the whole platform. Eighty-five controls came back
 * DEFERRED, and a deferral is an admission, not a result — this is the pass
 * that turns them into one.
 *
 * ── The three rules every case here obeys ──────────────────────────────────
 *
 * 1. **It acts on its OWN rows.** Every case seeds its target, and a BYSTANDER
 *    beside it. Trap 10 is explicit that a suite must never assert a global
 *    invariant over a shared table, and the mirror of that rule is this: a
 *    delete that removed the right row proves nothing until you also know it
 *    left the neighbour alone. "Deleted something" and "deleted THIS" are
 *    different findings, and only one of them is good news.
 *
 * 2. **It asserts the SERVER, not the screen.** A row vanishing from a table is
 *    a React state update; it is not evidence that anything was written. Every
 *    assertion reads the database back. The screen is then checked too — a
 *    server that changed and a screen that did not is half a feature (§31), and
 *    it is checked WITHOUT a reload, because a reload hides exactly the bug
 *    where the panel never learned what it had just done.
 *
 * 3. **Anything it changes platform-wide, it puts back.** A "Save" case reads
 *    the document first, presses, asserts, and restores in a `finally` —
 *    outside any assertion, because a restore that only runs when the case
 *    passed is the one that matters least (trap 10).
 *
 * A control this pass cannot drive is reported NOT DRIVEN with the reason. It
 * is never silently dropped: the whole point of the exercise is that the list
 * of things nobody pressed is visible.
 *
 *   node backend/tests/browser/mutate.js            every case
 *   node backend/tests/browser/mutate.js kyc        cases whose id matches
 *
 * Wants its OWN database (`bb_drive`) and a backend on it — these cases block
 * merchants, delete games and rewrite config documents, which is not something
 * to do to a database anything else is reading.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite, settle } from './stack.js';
import { seedPlayer, seedMerchant, seedAdmin } from '../e2e/seed.js';
import { playerToken, adminToken, merchantToken } from '../e2e/harness.js';
import { db } from '#db';
import { pgQuery } from '#db/client.js';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const results = [];

const rid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * One case's outcome.
 *
 * `DROVE` means the control was pressed AND the server changed the way the case
 * said it would AND the bystander did not. Anything less is named.
 */
function record(id, verdict, detail) {
  results.push({ id, verdict, detail });
  const mark = verdict === 'DROVE' ? 'DROVE ' : verdict === 'NOT DRIVEN' ? 'SKIP  ' : 'FAIL  ';
  console.log(`  ${mark} ${id}${detail ? ` — ${detail}` : ''}`);
}

// ── Screen helpers ──────────────────────────────────────────────────────────

/** Move the admin panel to a screen, entering at the root the first time. */
async function go(page, cfg, base, screen) {
  if (!page.__bbEntered) {
    // A deep link on the FIRST load loses a race the operator never sees: the
    // route guard runs before the persisted session has rehydrated, sends the
    // app to #/login, and the sign-in form arrives looking exactly like an
    // empty table. Enter at the root, then move.
    await page.goto(cfg.entry(base), { waitUntil: 'domcontentloaded' });
    await settle(page, 10000);
    page.__bbEntered = true;
  }
  // ── Every case starts on a screen nothing is covering ────────────────────
  // A case before this one may have left a modal open, and a modal's backdrop
  // intercepts every click underneath it — which surfaces as a 30-second
  // timeout on a control that is present, visible and perfectly fine. Escape,
  // then a round trip through a route that matches nothing, so the screen
  // REMOUNTS rather than being handed back with the previous case's search box
  // still filled in.
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { window.location.hash = '/__mutate_reset__'; });
  await sleep(200);
  await page.evaluate((s) => { window.location.hash = s; }, screen);
  await settle(page, 12000);
  if (process.env.BB_DIAG) {
    console.log(`   [diag] ${screen} → hash ${await page.evaluate(() => location.hash)} · `
      + `inputs ${await page.locator('input').count()} · rows ${await page.locator('tbody tr').count()} · `
      + (await words(page)).slice(0, 160));
  }
}

/** Type into a screen's search box, if it has one, so my row is on the page. */
async function search(page, term) {
  const box = page.locator('input[placeholder*="Search" i], input[type="search"]').first();
  if (await box.count() === 0) return false;
  await box.fill(term);
  await settle(page, 8000);
  return true;
}

/** The table row carrying this text, or null. */
async function rowFor(page, text) {
  const row = page.locator('tbody tr', { hasText: text }).first();
  return (await row.count()) ? row : null;
}

/**
 * Press a control inside a row, and say what was THERE when it cannot.
 *
 * A bare `.click()` that times out reports "Timeout 30000ms exceeded" and
 * nothing else, which is indistinguishable between four different causes: the
 * control is absent, it is present but covered, it is disabled, or the row
 * moved under us. Listing the row's actual controls turns all four into one
 * readable line — and a harness that cannot say why it failed sends the reader
 * hunting a defect in the app that is really in the harness.
 */
async function pressInRow(row, title, { timeout = 8000 } = {}) {
  const control = row.getByTitle(title);
  try {
    await control.click({ timeout });
    return { ok: true };
  } catch (err) {
    const titles = await row.locator('[title]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('title')),
    ).catch(() => []);
    return {
      ok: false,
      why: `no usable "${title}" in the row — it offers [${titles.join(', ') || 'nothing'}]`
        + ` (${err.message.split('\n')[0].slice(0, 70)})`,
    };
  }
}

/**
 * Press a confirmation the panel raises, whichever form it takes.
 *
 * Three exist in these panels and a case cannot know which it will meet: a
 * `window.confirm`, a modal with its own verb on the button, and no
 * confirmation at all. Returns what it found, because "the case pressed a
 * button and a dialog it never answered is still open" is a different failure
 * from "nothing happened".
 */
async function confirmWith(page, verb) {
  // ── SCOPED to the dialog, and this is the whole point ────────────────────
  // The row that opened the modal has a button with the SAME accessible name:
  // "Suspend" on the row, "Suspend" on the confirmation. A page-wide
  // `getByRole('button', { name: 'Suspend' }).last()` picks whichever comes
  // last in the DOM — which is a row button several rows down, sitting UNDER
  // the modal's backdrop. Playwright then waits for it to become clickable,
  // which it never will, and reports `Timeout 30000ms exceeded` — a message
  // that names neither the ambiguity nor the overlay. Measured: that is what
  // made the deduct and suspend cases look like app failures.
  const dialog = page.locator('[role="dialog"]').last();
  const inDialog = await dialog.count() > 0 && await dialog.isVisible().catch(() => false);
  const scope = inDialog ? dialog : page;

  const button = scope.getByRole('button', { name: new RegExp(`^\\s*${verb}\\s*$`, 'i') }).last();
  if (await button.count() && await button.isVisible().catch(() => false)) {
    // Bounded, so a confirmation that cannot be pressed is REPORTED rather than
    // spending thirty seconds proving it.
    try { await button.click({ timeout: 8000 }); } catch { return 'stuck'; }
    await settle(page, 8000);
    return inDialog ? 'dialog' : 'inline';
  }
  return 'none';
}

/** Fill a field, bounded, saying which one when it cannot be filled. */
async function fill(page, selector, value) {
  const field = page.locator(selector).first();
  if (await field.count() === 0) return { ok: false, why: `no ${selector} on screen` };
  try { await field.fill(String(value), { timeout: 8000 }); return { ok: true }; }
  catch (err) { return { ok: false, why: `${selector} would not accept input (${err.message.split('\n')[0].slice(0, 60)})` }; }
}

/** Everything the page is showing, as one flat string. */
const words = (page) => page.locator('body').innerText()
  .then((t) => t.replace(/\s+/g, ' ').trim());

// ── Server-side readers, each naming the ONE owner of what it reads ─────────

const userStatus = async (userId) => {
  const { rows } = await pgQuery('SELECT status, is_blocked FROM users WHERE user_id = $1', [userId]);
  return rows[0] ?? null;
};
const merchantStatus = async (merchantId) => {
  const { rows } = await pgQuery('SELECT status FROM merchants WHERE merchant_id = $1', [merchantId]);
  return rows[0]?.status ?? null;
};
const gameExists = async (slug) => {
  const { rows } = await pgQuery('SELECT 1 FROM games WHERE slug = $1', [String(slug)]);
  return rows.length > 0;
};
const kycStatus = async (userId) => {
  const { rows } = await pgQuery('SELECT kyc_status FROM users WHERE user_id = $1', [userId]);
  return rows[0]?.kyc_status ?? null;
};
const isSubAdmin = async (userId) => {
  const { rows } = await pgQuery('SELECT is_sub_admin FROM users WHERE user_id = $1', [userId]);
  return rows[0]?.is_sub_admin === true;
};
const providerExists = async (key) => {
  const { rows } = await pgQuery('SELECT 1 FROM game_providers WHERE provider_key = $1', [String(key)]);
  return rows.length > 0;
};
/** §9: every player balance read goes through the wallet authority. */
const balances = (userId) => db.wallets.getBalances(userId);

// ════════════════════════════════════════════════════════════════════════════
// THE CASES
// ════════════════════════════════════════════════════════════════════════════

const CASES = [
  // ── Player status ─────────────────────────────────────────────────────────
  {
    id: 'admin/users/block',
    panel: 'admin-panel',
    what: 'Block a player from the users list',
    async run(page, cfg, base) {
      const target = await seedPlayer({ balancePaise: 10000 });
      const bystander = await seedPlayer({ balancePaise: 10000 });

      await go(page, cfg, base, '/users');
      if (!await search(page, target.userId)) return ['NOT DRIVEN', 'no search box on /users'];
      const row = await rowFor(page, target.userId);
      if (!row) return ['NOT DRIVEN', `seeded player ${target.userId} never appeared in the table`];

      const hit = await pressInRow(row, 'Block');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 4000);
      if (await confirmWith(page, 'Block') === 'stuck') {
        return ['FAILED', 'the Block confirmation could not be pressed'];
      }

      const after = await userStatus(target.userId);
      const neighbour = await userStatus(bystander.userId);
      if (after?.status !== 'BLOCKED') return ['FAILED', `status is ${after?.status}, not BLOCKED`];
      if (neighbour?.status === 'BLOCKED') return ['FAILED', 'the BYSTANDER was blocked too'];

      // The screen, without a reload: a server that changed and a panel that
      // did not is half a feature.
      const said = await words(page);
      if (!/blocked/i.test(said)) return ['FAILED', 'server blocked them; the screen never said so'];
      return ['DROVE', `${target.userId} BLOCKED, bystander still ${neighbour?.status}`];
    },
  },

  // ── Player money, straight from the users list ────────────────────────────
  {
    id: 'admin/users/deduct',
    panel: 'admin-panel',
    what: 'Deduct from a player balance',
    async run(page, cfg, base) {
      const target = await seedPlayer({ balancePaise: 100000 });     // ₹1,000
      const bystander = await seedPlayer({ balancePaise: 100000 });

      await go(page, cfg, base, '/users');
      if (!await search(page, target.userId)) return ['NOT DRIVEN', 'no search box on /users'];
      const row = await rowFor(page, target.userId);
      if (!row) return ['NOT DRIVEN', `seeded player ${target.userId} never appeared`];

      const before = await balances(target.userId);
      const hit = await pressInRow(row, 'Deduct');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 4000);

      const typed = await fill(page, '#balance-amount', '250');
      if (!typed.ok) return ['NOT DRIVEN', `the deduct dialog never opened — ${typed.why}`];
      await fill(page, '#balance-reason', 'mutating drive');
      // The dialog's button reads "Deduct Balance" — the row's reads "Deduct".
      // Naming the dialog's own wording is the point: a case that asked for
      // "Deduct" and got the row button back is how this started.
      const pressed = await confirmWith(page, 'Deduct Balance');
      if (pressed === 'stuck') return ['FAILED', 'the Deduct Balance button could not be pressed'];
      if (pressed === 'none') return ['FAILED', 'the deduct dialog offered no Deduct Balance button'];

      const after = await balances(target.userId);
      const neighbour = await balances(bystander.userId);
      const moved = (before.depositBalance ?? 0) - (after.depositBalance ?? 0);
      if (moved !== 250) return ['FAILED', `deposit moved by ${moved}, expected 250`];
      if ((neighbour.depositBalance ?? 0) !== 1000) return ['FAILED', 'the BYSTANDER\'s balance moved'];
      return ['DROVE', `₹250 debited, ₹${after.depositBalance} left, bystander untouched`];
    },
  },

  // ── Merchant status ───────────────────────────────────────────────────────
  {
    id: 'admin/merchants/suspend',
    panel: 'admin-panel',
    what: 'Suspend a merchant',
    async run(page, cfg, base) {
      const target = await seedMerchant({ currency: 'INR', tokensPaise: 1000000, cashDenominationPaise: 500000 });
      const bystander = await seedMerchant({ currency: 'INR', tokensPaise: 1000000, cashDenominationPaise: 500000 });

      await go(page, cfg, base, '/merchants');
      await search(page, target.name);
      const row = await rowFor(page, target.name);
      if (!row) return ['NOT DRIVEN', `seeded merchant ${target.name} never appeared`];

      const hit = await pressInRow(row, 'Suspend');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 4000);
      // `MerchantsList` passes no `confirmText` to ConfirmDialog, so the button
      // carries the component's default — "Confirm" — while the users list
      // passes "Block". Two screens, two vocabularies for the same decision.
      const said = await confirmWith(page, 'Confirm');
      if (said === 'stuck') return ['FAILED', 'the Suspend confirmation could not be pressed'];
      if (said === 'none') return ['FAILED', 'the suspend dialog offered no Confirm button'];

      const after = await merchantStatus(target.merchantId);
      const neighbour = await merchantStatus(bystander.merchantId);
      if (after !== 'SUSPENDED') return ['FAILED', `status is ${after}, not SUSPENDED`];
      if (neighbour === 'SUSPENDED') return ['FAILED', 'the BYSTANDER was suspended too'];
      return ['DROVE', `${target.name} SUSPENDED, bystander still ${neighbour}`];
    },
  },

  // ── The catalogue ─────────────────────────────────────────────────────────
  {
    id: 'admin/games/delete',
    panel: 'admin-panel',
    what: 'Delete a game from the catalogue',
    async run(page, cfg, base) {
      // Its own rows, with names nothing else uses — deleting "Aviator" would
      // be deleting the platform's catalogue to prove a button works.
      const mine = rid('DriveGame');
      const neighbour = rid('DriveKeep');
      for (const name of [mine, neighbour]) {
        await pgQuery(
          // INACTIVE: `games_live_is_launchable` refuses a playable game with no
          // way to launch it, and this row exists to be deleted, not played.
          `INSERT INTO games (slug, name, status, sort_order)
           VALUES ($1, $1, 'INACTIVE', 999)
           ON CONFLICT (slug) DO NOTHING`, [name],
        );
      }

      await go(page, cfg, base, '/games');
      await search(page, mine);
      const button = page.getByRole('button', { name: new RegExp(`Delete ${mine}`, 'i') }).first();
      if (await button.count() === 0) return ['NOT DRIVEN', `no "Delete ${mine}" control found`];

      page.__bbAccept = true;
      try {
        await button.click();
        await settle(page, 6000);
        await confirmWith(page, 'Delete');
      } finally {
        page.__bbAccept = false;
      }

      const goneTarget = !(await gameExists(mine));
      const keptOther = await gameExists(neighbour);
      await pgQuery('DELETE FROM games WHERE slug = ANY($1::text[])', [[mine, neighbour]]);

      if (!goneTarget) return ['FAILED', `${mine} is still in the catalogue`];
      if (!keptOther) return ['FAILED', 'the BYSTANDER game was deleted too'];
      return ['DROVE', `${mine} deleted, ${neighbour} untouched`];
    },
  },


  // ── Money, from the dedicated adjustment screen ──────────────────────────
  {
    id: 'admin/balance-adjust/apply',
    panel: 'admin-panel',
    what: 'Apply a balance adjustment',
    async run(page, cfg, base) {
      const target = await seedPlayer({ balancePaise: 100000 });     // ₹1,000
      const bystander = await seedPlayer({ balancePaise: 100000 });

      await go(page, cfg, base, '/users/balance-adjust');
      // The screen picks its player through a search-and-select, not a raw id
      // field — `form.userId` is set by `selectUser`, so typing an id into the
      // search box and pressing Apply would submit an EMPTY userId and be
      // refused. The row has to actually be chosen.
      // This screen's search is its own: the box says "Username or mobile...",
      // nothing fires on typing, and the results are a list of BUTTONS rather
      // than table rows. A generic "find the search box and wait" found nothing
      // and reported the screen as undriveable.
      const box = page.locator('input[placeholder*="Username or mobile" i]').first();
      if (await box.count() === 0) return ['NOT DRIVEN', 'no player search on /users/balance-adjust'];
      await box.fill(target.userId);
      await box.press('Enter');
      await settle(page, 8000);

      const option = page.getByRole('button', { name: new RegExp(target.userId, 'i') }).first();
      if (await option.count() === 0) {
        return ['NOT DRIVEN', `search never offered ${target.userId} — screen said: ${(await words(page)).slice(-140)}`];
      }
      // Selecting is what sets `form.userId`; typing an id in the box does not.
      await option.click({ timeout: 8000 });
      await settle(page, 3000);

      const amount = await fill(page, '#amount', '300');
      if (!amount.ok) return ['NOT DRIVEN', amount.why];
      const why = await fill(page, '#reason', 'mutating drive');
      if (!why.ok) return ['NOT DRIVEN', why.why];

      const before = await balances(target.userId);
      const apply = page.getByRole('button', { name: /^Apply Adjustment$/i }).first();
      if (await apply.count() === 0) return ['NOT DRIVEN', 'no Apply Adjustment button'];
      await apply.click({ timeout: 8000 });
      await settle(page, 8000);

      const after = await balances(target.userId);
      const neighbour = await balances(bystander.userId);
      const moved = (after.depositBalance ?? 0) - (before.depositBalance ?? 0);
      if (moved !== 300) {
        return ['FAILED', `deposit moved by ${moved}, expected +300 — screen said: ${(await words(page)).slice(-160)}`];
      }
      if ((neighbour.depositBalance ?? 0) !== 1000) return ['FAILED', "the BYSTANDER's balance moved"];
      return ['DROVE', `₹300 credited, ₹${after.depositBalance} held, bystander untouched`];
    },
  },

  // ── Access: approving KYC is what lets a player withdraw ─────────────────
  {
    id: 'admin/kyc/approve',
    panel: 'admin-panel',
    what: 'Approve a KYC submission',
    async run(page, cfg, base) {
      // ── Seed the state the PLATFORM can actually produce (S16) ───────────
      // Two different fields are in play: the queue LISTS by `users.kyc_status`,
      // and the decision GATES on the `user_kyc` submission row. Setting only
      // the first produces a player who appears in the queue and cannot be
      // approved — the route answers 409 "Cannot approve KYC from unknown
      // status", which is correct, and a case that staged that row would be
      // reporting the platform for refusing a row a real submission never
      // creates. So both, at the state a submitted player is really in.
      const target = await seedPlayer({ kycStatus: 'PENDING_APPROVAL' });
      const bystander = await seedPlayer({ kycStatus: 'PENDING_APPROVAL' });
      for (const u of [target, bystander]) {
        await pgQuery(
          `INSERT INTO user_kyc (user_id, kyc_status, submitted_at)
           VALUES ($1, 'PENDING_APPROVAL', now())
           ON CONFLICT (user_id) DO UPDATE SET kyc_status = 'PENDING_APPROVAL'`,
          [u.userId],
        );
      }

      await go(page, cfg, base, '/kyc');
      // ── Not a table ───────────────────────────────────────────────────────
      // The queue renders cards, not `tbody tr`, so looking for a row found
      // nothing and reported "0 rows on the queue" — which reads like the queue
      // is empty (the exact false alarm §28 warns about) when in fact the query
      // is right and the harness was looking for the wrong shape. The control
      // names its own player, so address it directly.
      const review = page
        .getByRole('button', { name: new RegExp(`Review KYC for ${target.userId}`, 'i') }).first();
      if (await review.count() === 0) {
        const n = await page.getByRole('button', { name: /Review KYC for/i }).count();
        return ['NOT DRIVEN',
          `${target.userId} is not among the ${n} players the queue is offering for review`];
      }
      await review.click({ timeout: 8000 });
      await settle(page, 6000);

      // Both the panel's button and the confirmation's read "Approve KYC" — the
      // dialog is given `confirmText="Approve KYC"`. An anchored /^Approve$/
      // matched neither, so the dialog opened and was never answered and the
      // case reported the platform as failing to approve. It had not been asked.
      const approve = page.getByRole('button', { name: /^\s*Approve KYC\s*$/i }).last();
      if (await approve.count() === 0) return ['NOT DRIVEN', 'the review panel offered no Approve KYC'];
      await approve.click({ timeout: 8000 });
      await settle(page, 4000);
      const said = await confirmWith(page, 'Approve KYC');
      if (said === 'stuck') return ['FAILED', 'the Approve KYC confirmation could not be pressed'];
      if (said === 'none') return ['FAILED', 'the approve dialog offered no Approve KYC button'];

      const after = await kycStatus(target.userId);
      const neighbour = await kycStatus(bystander.userId);
      if (after !== 'APPROVED') return ['FAILED', `KYC is ${after}, not APPROVED`];
      if (neighbour === 'APPROVED') return ['FAILED', 'the BYSTANDER was approved too'];
      return ['DROVE', `${target.userId} APPROVED, bystander still ${neighbour}`];
    },
  },

  // ── Taking staff access away ─────────────────────────────────────────────
  {
    id: 'admin/sub-admins/remove',
    panel: 'admin-panel',
    what: 'Remove a sub-admin',
    async run(page, cfg, base) {
      const target = await seedPlayer({});
      const bystander = await seedPlayer({});
      for (const u of [target, bystander]) {
        await pgQuery(
          `UPDATE users SET is_sub_admin = true, sub_admin_permissions = '{"canViewAnalytics":true}'::jsonb
            WHERE user_id = $1`, [u.userId],
        );
      }

      await go(page, cfg, base, '/sub-admins');
      const row = await rowFor(page, target.userId);
      if (!row) return ['NOT DRIVEN', `seeded sub-admin ${target.userId} never appeared`];
      const hit = await pressInRow(row, 'Remove Sub-Admin');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 4000);
      const said = await confirmWith(page, 'Remove');
      if (said === 'stuck') return ['FAILED', 'the Remove confirmation could not be pressed'];

      const gone = !(await isSubAdmin(target.userId));
      const kept = await isSubAdmin(bystander.userId);
      if (!gone) return ['FAILED', `${target.userId} is still a sub-admin`];
      if (!kept) return ['FAILED', 'the BYSTANDER lost their sub-admin access too'];
      return ['DROVE', `${target.userId} demoted, bystander still staff`];
    },
  },

  // ── Deleting from the provider catalogue ─────────────────────────────────
  {
    id: 'admin/game-providers/delete',
    panel: 'admin-panel',
    what: 'Delete a casino provider',
    async run(page, cfg, base) {
      const mine = rid('driveprov');
      const neighbour = rid('keepprov');
      for (const key of [mine, neighbour]) {
        await pgQuery(
          `INSERT INTO game_providers (provider_key, name, category, enabled)
           VALUES ($1, $1, 'CASINO', false)
           ON CONFLICT (provider_key) DO NOTHING`, [key],
        );
      }

      await go(page, cfg, base, '/game-providers');
      const row = await rowFor(page, mine);
      const button = row
        ? row.getByRole('button', { name: /Delete/i }).first()
        : page.getByRole('button', { name: new RegExp(`Delete ${mine}`, 'i') }).first();
      if (await button.count() === 0) return ['NOT DRIVEN', `no Delete control for ${mine}`];

      page.__bbAccept = true;
      try {
        await button.click({ timeout: 8000 });
        await settle(page, 6000);
        await confirmWith(page, 'Delete');
      } finally { page.__bbAccept = false; }

      const goneTarget = !(await providerExists(mine));
      const keptOther = await providerExists(neighbour);
      await pgQuery('DELETE FROM game_providers WHERE provider_key = ANY($1::text[])', [[mine, neighbour]]);
      if (!goneTarget) return ['FAILED', `${mine} is still in the provider list`];
      if (!keptOther) return ['FAILED', 'the BYSTANDER provider was deleted too'];
      return ['DROVE', `${mine} deleted, ${neighbour} untouched`];
    },
  },

  // ── A platform-wide document: snapshot, press, assert, put back ───────────
  {
    id: 'admin/settings/save',
    panel: 'admin-panel',
    what: 'Save System Settings',
    async run(page, cfg, base) {
      // The WHOLE document, not the one field — restoring a field leaves every
      // other one at whatever the press wrote.
      const before = await db.config.getSystemConfig();
      const wasMinDeposit = before?.minDeposit;
      try {
        await go(page, cfg, base, '/settings');
        const field = page.getByLabel(/Min Deposit/i).first();
        if (await field.count() === 0) return ['NOT DRIVEN', 'no Min Deposit field on /settings'];

        const target = Number(wasMinDeposit) === 501 ? 502 : 501;
        await field.fill(String(target));
        await settle(page, 1500);

        const save = page.getByRole('button', { name: /^Save Settings$/i }).first();
        if (await save.count() === 0) return ['NOT DRIVEN', 'no Save Settings button'];
        if (await save.isDisabled()) return ['NOT DRIVEN', 'Save Settings is disabled with a valid value'];
        await save.click();
        await settle(page, 8000);

        const after = await db.config.getSystemConfig();
        if (Number(after?.minDeposit) !== target) {
          return ['FAILED', `pressed Save; minDeposit is ${after?.minDeposit}, expected ${target}`];
        }
        const said = await words(page);
        if (!/saved|updated|success/i.test(said)) {
          return ['FAILED', 'the document was written; the screen never confirmed it'];
        }
        return ['DROVE', `minDeposit ${wasMinDeposit} → ${target}, confirmed on screen`];
      } finally {
        // Outside the assertions, and outside the early returns above (trap 10).
        await db.config.applyConfig({
          scope: 'system', actor: 'mutating-drive', patch: { minDeposit: wasMinDeposit },
        }).catch((e) => console.error('   ! could not restore minDeposit:', e.message));
      }
    },
  },
];

// ════════════════════════════════════════════════════════════════════════════

async function main() {
  if (!await waitFor(`${API}/health/live`, 'the backend')) {
    console.error('This pass wants its OWN backend and database — see the header.');
    process.exit(1);
  }

  const cases = only.length
    ? CASES.filter((c) => only.some((q) => c.id.includes(q)))
    : CASES;
  if (!cases.length) { console.error('no case matched', only); process.exit(1); }

  const panels = [...new Set(cases.map((c) => c.panel))];
  const tokens = {
    'admin-panel': adminToken(await seedAdmin()),
  };

  const pages = {};
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });

  for (const panel of panels) {
    const cfg = PANELS[panel];
    children.push(startVite(panel, cfg.port));
    const base = `http://127.0.0.1:${cfg.port}`;
    if (!await waitFor(`${base}${panel === 'user-panel' ? '/' : `/${panel.split('-')[0]}/`}`, `${panel}'s dev server`)) {
      stopAll(); process.exit(1);
    }
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(([k, v]) => {
      try { localStorage.setItem(k, v); } catch { /* private mode */ }
    }, [cfg.key, cfg.wrap(tokens[panel])]);
    const page = await ctx.newPage();
    // A confirm nobody answers blocks the page for ever. Cases that WANT one
    // register their own `page.once('dialog')` first, which wins.
    // A confirm nobody answers blocks the page for ever, so the default is to
    // dismiss. A case that MEANS to say yes sets `page.__bbAccept` — a second
    // `page.once('dialog')` would not work, because every registered listener
    // runs and this one, registered first, dismissed before the case's accept
    // could land. That is why "Delete" reported the row still in the catalogue.
    page.on('dialog', (d) => (page.__bbAccept ? d.accept() : d.dismiss()).catch(() => {}));
    if (process.env.BB_DIAG) {
      page.on('request', (r) => { if (/\/api\//.test(r.url())) console.log('   [req]', r.method(), r.url().slice(0, 90)); });
      page.on('requestfailed', (r) => console.log('   [reqfail]', r.url().slice(0, 90), r.failure()?.errorText));
    }
    pages[panel] = { page, cfg, base };
  }

  console.log(`\nDriving ${cases.length} mutating control(s) against their own rows.\n`);

  for (const c of cases) {
    const { page, cfg, base } = pages[c.panel];
    try {
      const [verdict, detail] = await c.run(page, cfg, base);
      record(c.id, verdict, detail);
    } catch (err) {
      record(c.id, 'FAILED', `threw: ${err.message.split('\n')[0].slice(0, 140)}`);
    }
  }

  await browser.close().catch(() => {});
  stopAll();

  const drove = results.filter((r) => r.verdict === 'DROVE').length;
  const skipped = results.filter((r) => r.verdict === 'NOT DRIVEN');
  const failed = results.filter((r) => r.verdict === 'FAILED');
  console.log(`\n${drove}/${results.length} driven · ${skipped.length} not driven · ${failed.length} failed`);
  if (skipped.length) {
    console.log('\nNOT DRIVEN — these are the ones nobody has pressed:');
    for (const s of skipped) console.log(`   ${s.id} — ${s.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
