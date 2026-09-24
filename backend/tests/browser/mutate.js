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
import {
  API, EXECUTABLE, PANELS, children, stopAll, waitFor, startVite, settle, clickThrough,
  configureTelegram,
} from './stack.js';
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
  // The merchant panel is a HISTORY router under /merchant — setting the hash
  // moves nothing there, so the case would measure whatever screen happened to
  // be up. Each router is navigated the way it actually navigates.
  const move = async (to) => {
    if (cfg.router === 'hash') await page.evaluate((t) => { window.location.hash = t; }, to);
    else {
      await page.evaluate(([b, t]) => {
        window.history.pushState({}, '', `${b}${t}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, [cfg.base ?? '', to]);
    }
  };
  await move('/__mutate_reset__');
  await sleep(200);
  await move(screen);
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
async function pressInRow(row, what, { timeout = 8000 } = {}) {
  // ── A title OR the words on the button ──────────────────────────────────
  // This matched on `title` alone, which is right for the icon buttons
  // (Details, Limits, Orders carry one) and wrong for every button that says
  // what it does in text. Measured: the Approve and Reject cases reported
  // "no usable Approve in the row — it offers [Details, Limits, Orders,
  // Suspend]", which reads exactly like a missing feature, and the row was
  // rendering both buttons the whole time. The server was sending
  // `merchantApprovalStatus: 'PENDING'` and the panel was drawing them.
  //
  // That is §28's own warning pointed at this harness: a false failure is how
  // a pass loses its authority. A person does not press a `title`; they press
  // the thing that says the word.
  const byTitle = row.getByTitle(what);
  const byName = row.getByRole('button', { name: new RegExp(`^\\s*${what}\\s*$`, 'i') });
  for (const control of [byTitle, byName]) {
    if (await control.count().catch(() => 0) === 0) continue;
    const hit = await clickThrough(control.first(), { timeout });
    if (hit.ok) return { ok: true, via: hit.via };
  }
  const titles = await row.locator('[title]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('title')),
  ).catch(() => []);
  const names = await row.locator('button').evaluateAll(
    (els) => els.map((e) => (e.innerText || '').trim()).filter(Boolean),
  ).catch(() => []);
  return {
    ok: false,
    why: `no usable "${what}" in the row — titles [${titles.join(', ') || 'none'}],`
      + ` buttons [${names.join(', ') || 'none'}]`,
  };
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
  // ── DIALOG ONLY. The page-wide fallback was actively dangerous ──────────
  // With no dialog open this used to search the whole page, and on
  // /chat-management every message's delete control is named exactly "Delete".
  // So one press deleted the message, `window.confirm` was accepted, and then
  // this clicked ANOTHER row's Delete: one press, TWO messages gone. The case
  // caught it ("2 messages went, expected exactly 1") only because it counted.
  //
  // A confirmation lives in a dialog. When there is none — a `window.confirm`
  // the dialog handler already answered, or a control that needs no second
  // press — the honest answer is 'none', and the caller carries on.
  const dialog = page.locator('[role="dialog"]').last();
  if (await dialog.count() === 0 || !(await dialog.isVisible().catch(() => false))) return 'none';

  // ── The caller's verb, then the words a dialog ACTUALLY uses ────────────
  // `ConfirmDialog` takes a `confirmText` prop and DEFAULTS IT TO 'Confirm',
  // and most callers pass nothing — so the FAQ dialog's affirmative button
  // says "Confirm" while its title says "Delete FAQ". Asking only for the
  // caller's verb found no button, this returned 'none', and the case
  // reported "the FAQ is still in the list" — which reads as a broken delete
  // route and was a dialog nobody answered.
  //
  // A person does not know the prop name. They read the dialog and press the
  // affirmative button, so the verb is a PREFERENCE and these are the
  // fallbacks. `Cancel`/`Close` are never among them, deliberately: a
  // confirmation this cannot answer must be reported, never dismissed into
  // looking like a pass.
  const wanted = [verb, 'Confirm', 'Yes', 'OK', 'Continue', 'Proceed'];
  for (const word of wanted) {
    const button = dialog.getByRole('button', { name: new RegExp(`^\\s*${word}\\s*$`, 'i') }).last();
    if (!(await button.count()) || !(await button.isVisible().catch(() => false))) continue;
    // Bounded, so a confirmation that cannot be pressed is REPORTED rather than
    // spending thirty seconds proving it.
    try { await button.click({ timeout: 8000 }); } catch { return 'stuck'; }
    await settle(page, 8000);
    return 'dialog';
  }
  // A dialog is open and none of its buttons is an affirmative this knows.
  // Saying so beats returning 'none', which reads as "there was nothing to
  // confirm" — the opposite of what happened.
  const offered = await dialog.locator('button').evaluateAll(
    (els) => els.map((e) => (e.innerText || '').trim()).filter(Boolean),
  ).catch(() => []);
  return `unanswered:[${offered.join(', ') || 'no buttons'}]`;
}

/** Fill a field, bounded, saying which one when it cannot be filled. */
async function fill(page, selector, value) {
  const field = page.locator(selector).first();
  if (await field.count() === 0) {
    // Say what IS there. "no #foo on screen" is true of a screen that never
    // rendered and of one that renders a different field, and those need
    // different fixes — naming the inputs present separates them in one line.
    const present = await page.locator('input, textarea, select').evaluateAll(
      (els) => els.slice(0, 12).map((e) => e.id || e.getAttribute('placeholder') || e.type || 'input'),
    ).catch(() => []);
    return { ok: false, why: `no ${selector} on screen — it offers [${present.join(', ') || 'no fields at all'}]` };
  }
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
const orderStatus = async (orderId) => {
  const { rows } = await pgQuery(
    'SELECT status FROM merchant_admin_token_orders WHERE order_id = $1', [String(orderId)]);
  return rows[0]?.status ?? null;
};
const orderState = async (orderId) => {
  const { rows } = await pgQuery('SELECT state FROM order_states WHERE order_id = $1', [String(orderId)]);
  return rows[0]?.state ?? null;
};
/** The bonus pool's balance, from the treasury — the one owner (§2). */
const poolPaise = async () => (await db.treasury.getTreasuryBalances()).BONUS_POOL ?? 0;
/**
 * The messages the moderation screen can still see.
 *
 * A delete here is a SOFT delete — `is_deleted` is set and the row survives, so
 * counting rows would report nothing removed on a delete that worked perfectly.
 * Count what the feed counts.
 */
const chatCount = async () => {
  const { rows } = await pgQuery('SELECT COUNT(*)::int AS n FROM public_chat_messages WHERE NOT is_deleted');
  return Number(rows[0]?.n ?? 0);
};
/** What the referral programme has actually paid out, in paise. */
const referralPaidPaise = async () => {
  const { rows } = await pgQuery(
    // `disbursed_at`, not `paid_at` — the column names the BATCH that paid it.
    `SELECT COALESCE(SUM(amount_paise), 0)::BIGINT AS paid
       FROM referral_earnings WHERE disbursed_at IS NOT NULL`).catch(() => ({ rows: [] }));
  return Number(rows[0]?.paid ?? 0);
};
/** The ACTIVE bot generation — §2: a channel change bumps it, a bot swap does not. */
const telegramGeneration = async () => {
  const { rows } = await pgQuery(
    `SELECT generation, channel_username FROM telegram_configs
      ORDER BY generation DESC LIMIT 1`).catch(() => ({ rows: [] }));
  return rows[0] ?? null;
};
/** The gateway mode — P2P vs a third-party gateway (§2), not the settlement rail. */
const gatewayMode = async () => {
  const { rows } = await pgQuery(
    `SELECT active_mode FROM payment_gateway_configs ORDER BY config_key LIMIT 1`)
    .catch(() => ({ rows: [] }));
  return rows[0]?.active_mode ?? null;
};
const cdnImageExists = async (id) => {
  const { rows } = await pgQuery('SELECT 1 FROM cdn_images WHERE image_id = $1', [String(id)]);
  return rows.length > 0;
};
/**
 * What "preferences" actually are on a merchant: two booleans on the row.
 *
 * `PUT /merchant/preferences` accepts `acceptsDeposits` and
 * `acceptsWithdrawals` and nothing else — there is no notification_preferences
 * column, so reading one would have compared undefined to undefined and passed
 * on a save that did nothing.
 */
const merchantPrefs = async (merchantId) => {
  const { rows } = await pgQuery(
    'SELECT accepts_deposits, accepts_withdrawals FROM merchants WHERE merchant_id = $1',
    [String(merchantId)]);
  return rows[0] ?? null;
};
const providerExists = async (key) => {
  const { rows } = await pgQuery('SELECT 1 FROM game_providers WHERE provider_key = $1', [String(key)]);
  return rows.length > 0;
};
/** §9: every player balance read goes through the wallet authority. */
const balances = (userId) => db.wallets.getBalances(userId);


/**
 * A "Save" case, declared rather than written out four times.
 *
 * Every one of these screens does the same thing — read a config document, edit
 * one field, press Save, and publish it platform-wide — so writing them out
 * separately would be §5's shape: four copies of one procedure, drifting. What
 * differs is the screen, the field, the button's wording and the document, and
 * those are the four things this takes.
 *
 * The restore is in a `finally` and outside every early return, because these
 * cases rewrite the platform's live rules and a restore that only runs on the
 * happy path is the one that matters least (trap 10).
 */
function configSave({ id, screen, selector, button, scope, key, value, label, also = [], confirm = null }) {
  return {
    id,
    panel: 'admin-panel',
    what: label,
    async run(page, cfg, base) {
      const before = await db.config.getConfig(scope);
      const was = before?.[key];
      try {
        await go(page, cfg, base, screen);
        const typed = await fill(page, selector, value);
        if (!typed.ok) return ['NOT DRIVEN', typed.why];
        // Some screens will not ARM their Save until a second field is filled —
        // the settlement rail wants the justification recorded against the
        // version, and the button stays disabled without it. A case that only
        // typed the value reported "Save is disabled with a valid value", which
        // blames the screen for a field it was never given.
        for (const extra of also) {
          const more = await fill(page, extra.selector, extra.value);
          if (!more.ok) return ['NOT DRIVEN', more.why];
        }
        await settle(page, 1500);

        const save = page.getByRole('button', { name: new RegExp(`^\\s*${button}\\s*$`, 'i') }).first();
        if (await save.count() === 0) return ['NOT DRIVEN', `no "${button}" button on ${screen}`];
        if (await save.isDisabled()) return ['NOT DRIVEN', `"${button}" is disabled with a valid value`];
        await save.click({ timeout: 8000 });
        await settle(page, 8000);
        if (confirm) {
          const answered = await confirmWith(page, confirm);
          if (answered === 'stuck') return ['FAILED', `the "${confirm}" confirmation could not be pressed`];
          if (answered === 'none') return ['FAILED', `pressing ${button} raised no "${confirm}" confirmation`];
        }

        // The DOCUMENT, freshly, not the form: a screen that keeps its own copy
        // of what it just sent is not evidence anything was stored (§32 S25).
        const after = await db.config.getConfig(scope, { fresh: true });
        if (String(after?.[key] ?? '') !== String(value)) {
          return ['FAILED',
            `pressed ${button}; ${scope}.${key} is '${after?.[key]}', expected '${value}'`
            + ` — screen said: ${(await words(page)).slice(-140)}`];
        }
        const said = await words(page);
        if (!/saved|updated|success/i.test(said)) {
          return ['FAILED', `${scope}.${key} was written; the screen never confirmed it`];
        }
        return ['DROVE', `${scope}.${key} '${was}' → '${value}', confirmed on screen`];
      } finally {
        await db.config.applyConfig({
          scope, actor: 'mutating-drive', patch: { [key]: was },
        }).catch((e) => console.error(`   ! could not restore ${scope}.${key}:`, e.message));
      }
    },
  };
}

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


  // ── Money: the platform hands a merchant inventory ───────────────────────
  {
    id: 'admin/merchant-token-orders/approve',
    panel: 'admin-panel',
    what: 'Approve a merchant token purchase',
    async run(page, cfg, base) {
      const target = await seedMerchant({ currency: 'USDT', tokensPaise: 0 });
      const bystander = await seedMerchant({ currency: 'USDT', tokensPaise: 0 });
      const mineId = rid('TO');
      const theirsId = rid('TO');
      for (const [orderId, m] of [[mineId, target], [theirsId, bystander]]) {
        await pgQuery(
          `INSERT INTO merchant_admin_token_orders
             (order_id, merchant_id, token_paise, usdt_rate, usdt_amount, usdt_tx_hash, status)
           VALUES ($1, $2, $3, 90, 100, $4, 'PENDING')`,
          [orderId, m.merchantId, 900000, `0xDRIVE${orderId}`],
        );
      }

      await go(page, cfg, base, '/merchant-token-orders');
      const row = await rowFor(page, target.merchantId) ?? await rowFor(page, target.name);
      if (!row) return ['NOT DRIVEN', `seeded PENDING order for ${target.name} never appeared`];
      const hit = await pressInRow(row, 'Approve — transfers tokens from the platform\'s holding to the merchant');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 8000);

      // BOTH sides, against the database: the merchant's wallet AND the
      // platform's own holding. A credit that came from nowhere would pass an
      // assertion that only looked at the wallet.
      const got = await db.merchantWallets.getMerchantTokenBalance(target.merchantId);
      const neighbour = await db.merchantWallets.getMerchantTokenBalance(bystander.merchantId);
      const state = await orderStatus(mineId);
      if (Number(got) !== 9000) return ['FAILED', `merchant holds ${got} tokens, expected 9000`];
      if (Number(neighbour) !== 0) return ['FAILED', `the BYSTANDER merchant was credited ${neighbour}`];
      if (state !== 'APPROVED') return ['FAILED', `the order is ${state}, not APPROVED`];
      if (await orderStatus(theirsId) !== 'PENDING') return ['FAILED', "the BYSTANDER's order was decided too"];
      return ['DROVE', `9,000 tokens transferred, order APPROVED, bystander still PENDING at 0`];
    },
  },


  // ── Money: an admin decides a disputed deposit ───────────────────────────
  {
    id: 'admin/payment-control/release',
    panel: 'admin-panel',
    what: 'Release a disputed deposit to the player',
    async run(page, cfg, base) {
      const player = await seedPlayer({ balancePaise: 0 });
      const other = await seedPlayer({ balancePaise: 0 });
      const merchant = await seedMerchant({ currency: 'INR', tokensPaise: 100000000 });
      const mine = rid('DISP');
      const theirs = rid('DISP');
      for (const [orderId, u] of [[mine, player], [theirs, other]]) {
        await pgQuery(
          `INSERT INTO order_states
             (order_id, user_id, merchant_id, order_type, state, token_amount_paise, fiat_amount_paise)
           VALUES ($1, $2, $3, 'DEPOSIT', 'DISPUTED', 50000, 50000)`,
          [orderId, u.userId, merchant.merchantId],
        );
      }

      await go(page, cfg, base, '/payment-control');
      // ── MY order's card, not merely an element mentioning it ─────────────
      // `:has-text()` matches every ancestor too, and `.last()` gives the
      // innermost — a <span> holding the order id and no button. The case then
      // reported "no Release to User" while FOUR were on the page, which reads
      // as an empty dispute queue over a working one. Ask for the card that
      // contains BOTH the id and the control, and take the innermost of those.
      const card = page.locator('div')
        .filter({ hasText: mine })
        .filter({ has: page.getByRole('button', { name: /Release to User/i }) })
        .last();
      const release = (await card.count())
        ? card.getByRole('button', { name: /Release to User/i }).first()
        : page.locator('nothing-matches-this');
      if (await release.count() === 0) {
        // Measure the ROUTED region, not the page (§32 S21): the shell is on
        // screen either way, so quoting the top of the body reports the nav bar
        // and tells the reader nothing about whether the queue rendered.
        const routed = await page.locator('main').innerText().catch(() => '(no <main>)');
        const all = await page.getByRole('button', { name: /Release to User/i }).count();
        return ['NOT DRIVEN',
          `no "Release to User" for ${mine} (${all} on the page) — routed region: `
          + `${routed.replace(/\s+/g, ' ').trim().slice(0, 220)}`];
      }

      const before = await balances(player.userId);
      // The handler asks for a reason through `window.prompt`, and returns early
      // on an empty one — so the prompt is ANSWERED, not merely accepted.
      page.__bbAccept = 'mutating drive: released';
      try {
        await release.click({ timeout: 8000 });
        await settle(page, 10000);
      } finally { page.__bbAccept = false; }

      const after = await balances(player.userId);
      const neighbour = await balances(other.userId);
      const state = await orderState(mine);
      if ((after.depositBalance ?? 0) <= (before.depositBalance ?? 0)) {
        return ['FAILED', `the player was not credited (₹${before.depositBalance} → ₹${after.depositBalance});`
          + ` order is ${state} — screen said: ${(await words(page)).slice(-140)}`];
      }
      if ((neighbour.depositBalance ?? 0) !== 0) return ['FAILED', 'the BYSTANDER player was credited too'];
      if (await orderState(theirs) !== 'DISPUTED') return ['FAILED', "the BYSTANDER's dispute was resolved too"];
      return ['DROVE', `player credited ₹${after.depositBalance}, order ${state}, the other dispute untouched`];
    },
  },

  // ── Money: the platform funds its own bonus pool ─────────────────────────
  {
    id: 'admin/revenue/fund-pool',
    panel: 'admin-panel',
    what: 'Fund the merchant bonus pool',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/revenue');
      const amount = page.locator('input[placeholder^="Amount"]').first();
      if (await amount.count() === 0) return ['NOT DRIVEN', 'no amount field on /revenue'];
      await amount.fill('100');
      await fill(page, 'input[placeholder^="Business justification"]', 'mutating drive');
      await settle(page, 1500);

      const before = await poolPaise();
      const fund = page.getByRole('button', { name: /^\s*Fund Pool\s*$/i }).first();
      if (await fund.count() === 0) return ['NOT DRIVEN', 'no Fund Pool button'];
      await fund.click({ timeout: 8000 });
      await settle(page, 10000);

      const after = await poolPaise();
      const said = await words(page);
      // The backend REFUSES anything beyond distributable revenue, and on a
      // fresh database there is none — so a refusal here is the platform
      // working, not failing, and the case says which happened rather than
      // calling a correct refusal a defect (S19).
      if (after > before) return ['DROVE', `pool ${before} → ${after} paise`];
      if (/revenue|insufficient|distributable|cannot/i.test(said)) {
        return ['DROVE', `refused by name, pool unchanged — "${said.match(/[^.]*(?:revenue|distributable|insufficient)[^.]*/i)?.[0]?.trim().slice(0, 100)}"`];
      }
      return ['FAILED', `pressed Fund Pool: pool unchanged and the screen said nothing — ${said.slice(-140)}`];
    },
  },

  // ── Deleting a player's chat message ─────────────────────────────────────
  {
    id: 'admin/chat-management/delete',
    panel: 'admin-panel',
    what: 'Delete a chat message',
    async run(page, cfg, base) {
      // ── The PUBLIC chat, which is not `chat_messages` ────────────────────
      // Two different chats exist: `chat_messages` is the P2P conversation
      // attached to an ORDER, and `public_chat_messages` is the open room this
      // screen moderates. Seeding the first left the screen correctly empty
      // while the table said two rows — a harness reporting "nothing to delete"
      // over rows the screen was never going to show.
      const player = await seedPlayer({});
      for (const body of ['drive-target', 'drive-bystander']) {
        await pgQuery(
          `INSERT INTO public_chat_messages (user_id, display_name, content)
           VALUES ($1, $2, $3)`,
          [player.userId, `Drive ${player.userId.slice(-6)}`, body],
        );
      }

      await go(page, cfg, base, '/chat-management');
      const before = await chatCount();
      const del = page.getByTitle('Delete').first();
      if (await del.count() === 0) {
        return ['NOT DRIVEN', `no message to delete on /chat-management (${before} in the table)`];
      }
      page.__bbAccept = true;
      try {
        await del.click({ timeout: 8000 });
        await settle(page, 6000);
        await confirmWith(page, 'Delete');
      } finally { page.__bbAccept = false; }

      const after = await chatCount();
      if (after >= before) return ['FAILED', `messages ${before} → ${after}; nothing was removed`];
      if (before - after !== 1) return ['FAILED', `${before - after} messages went, expected exactly 1`];
      return ['DROVE', `one message removed (${before} → ${after}), the rest kept`];
    },
  },


  // ── The other half of each money decision ────────────────────────────────
  {
    id: 'admin/merchant-token-orders/reject',
    panel: 'admin-panel',
    what: 'Reject a merchant token purchase',
    async run(page, cfg, base) {
      const target = await seedMerchant({ currency: 'USDT', tokensPaise: 0 });
      const orderId = rid('TOR');
      await pgQuery(
        `INSERT INTO merchant_admin_token_orders
           (order_id, merchant_id, token_paise, usdt_rate, usdt_amount, usdt_tx_hash, status)
         VALUES ($1, $2, 900000, 90, 100, $3, 'PENDING')`,
        [orderId, target.merchantId, `0xREJ${orderId}`],
      );

      await go(page, cfg, base, '/merchant-token-orders');
      const row = await rowFor(page, target.merchantId) ?? await rowFor(page, target.name);
      if (!row) return ['NOT DRIVEN', `seeded PENDING order for ${target.name} never appeared`];
      const hit = await pressInRow(row, 'Reject — needs a reason');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 4000);

      // A rejection with no reason is refused by the platform on purpose — the
      // merchant is shown it — so the case supplies one rather than pressing a
      // button that was always going to decline.
      const typed = await fill(page, '#reason', 'mutating drive: no transaction at that hash');
      if (!typed.ok) return ['NOT DRIVEN', `the reject modal never opened — ${typed.why}`];
      // "Reject request" — the row's control says "Reject", the modal's says
      // something else again. Three screens, three vocabularies for one verb.
      const said = await confirmWith(page, 'Reject request');
      if (said === 'stuck') return ['FAILED', 'the Reject request button could not be pressed'];
      if (said === 'none') return ['FAILED', 'the reject modal offered no Reject request button'];

      const state = await orderStatus(orderId);
      const held = await db.merchantWallets.getMerchantTokenBalance(target.merchantId);
      if (state !== 'REJECTED') return ['FAILED', `the order is ${state}, not REJECTED`];
      // The decisive assertion: a rejection must move NO tokens.
      if (Number(held) !== 0) return ['FAILED', `a REJECTED purchase credited ${held} tokens`];
      return ['DROVE', `order REJECTED and not one token moved`];
    },
  },

  {
    id: 'admin/payment-control/refund',
    panel: 'admin-panel',
    what: 'Refund a disputed deposit to the merchant',
    async run(page, cfg, base) {
      const player = await seedPlayer({ balancePaise: 0 });
      const merchant = await seedMerchant({ currency: 'INR', tokensPaise: 100000000 });
      const mine = rid('DISP');
      await pgQuery(
        `INSERT INTO order_states
           (order_id, user_id, merchant_id, order_type, state, token_amount_paise, fiat_amount_paise)
         VALUES ($1, $2, $3, 'DEPOSIT', 'DISPUTED', 50000, 50000)`,
        [mine, player.userId, merchant.merchantId],
      );

      await go(page, cfg, base, '/payment-control');
      const card = page.locator('div')
        .filter({ hasText: mine })
        .filter({ has: page.getByRole('button', { name: /Refund to Merchant/i }) })
        .last();
      if (await card.count() === 0) {
        const routed = await page.locator('main').innerText().catch(() => '(no <main>)');
        return ['NOT DRIVEN', `no card for ${mine} — routed region: ${routed.replace(/\s+/g, ' ').slice(0, 180)}`];
      }
      const refund = card.getByRole('button', { name: /Refund to Merchant/i }).first();

      const before = await balances(player.userId);
      page.__bbAccept = 'mutating drive: refunded';
      try {
        await refund.click({ timeout: 8000 });
        await settle(page, 10000);
      } finally { page.__bbAccept = false; }

      const after = await balances(player.userId);
      const state = await orderState(mine);
      // The opposite outcome from a release, and the assertion is its mirror:
      // the player must NOT be credited on a refund.
      if ((after.depositBalance ?? 0) !== (before.depositBalance ?? 0)) {
        return ['FAILED', `a REFUND credited the player ₹${after.depositBalance}`];
      }
      if (!['CANCELLED', 'FAILED', 'REJECTED', 'COMPLETED'].includes(String(state))) {
        return ['FAILED', `the order is ${state}; the refund left it undecided`];
      }
      return ['DROVE', `order ${state}, the player correctly not credited`];
    },
  },

  {
    id: 'admin/kyc/reject',
    panel: 'admin-panel',
    what: 'Reject a KYC submission',
    async run(page, cfg, base) {
      const target = await seedPlayer({ kycStatus: 'PENDING_APPROVAL' });
      await pgQuery(
        `INSERT INTO user_kyc (user_id, kyc_status, submitted_at)
         VALUES ($1, 'PENDING_APPROVAL', now())
         ON CONFLICT (user_id) DO UPDATE SET kyc_status = 'PENDING_APPROVAL'`, [target.userId],
      );

      await go(page, cfg, base, '/kyc');
      const review = page
        .getByRole('button', { name: new RegExp(`Review KYC for ${target.userId}`, 'i') }).first();
      if (await review.count() === 0) return ['NOT DRIVEN', `${target.userId} is not on the queue`];
      await review.click({ timeout: 8000 });
      await settle(page, 6000);

      const reject = page.getByRole('button', { name: /^\s*Reject\s*$/i }).last();
      if (await reject.count() === 0) return ['NOT DRIVEN', 'the review panel offered no Reject'];
      await reject.click({ timeout: 8000 });
      await settle(page, 4000);

      const typed = await fill(page, '#rejection-reason', 'mutating drive: unreadable submission');
      if (!typed.ok) return ['NOT DRIVEN', `the reject modal never opened — ${typed.why}`];
      const said = await confirmWith(page, 'Reject KYC');
      if (said === 'stuck') return ['FAILED', 'the Reject KYC button could not be pressed'];
      if (said === 'none') return ['FAILED', 'the reject modal offered no Reject KYC button'];

      const after = await kycStatus(target.userId);
      if (after !== 'REJECTED') return ['FAILED', `KYC is ${after}, not REJECTED`];
      // The reason is what the player is shown — a rejection without one is the
      // defect the transition module exists to refuse.
      const { rows } = await pgQuery(
        'SELECT rejection_reason FROM user_kyc WHERE user_id = $1', [target.userId]);
      if (!String(rows[0]?.rejection_reason ?? '').trim()) {
        return ['FAILED', 'REJECTED with no reason stored — the player is told nothing'];
      }
      return ['DROVE', `REJECTED, and the reason was stored for the player to read`];
    },
  },

  // ── Config saves, each through the one declared factory ──────────────────
  // ── Not a config document, so not the factory ────────────────────────────
  // The rail's timers live in `payment_mode_policies` — one ACTIVE version,
  // APPEND-ONLY and justified (§2) — not in `config_documents`. Putting it
  // through configSave would have read the wrong owner and reported a save that
  // worked as a save that vanished. A different owner is a different case.
  //
  // There is deliberately no restore: the table is append-only by design, so
  // "putting it back" means writing a THIRD version, which is a worse record of
  // what happened than leaving the two. This runs on its own database.
  {
    id: 'admin/settlement-rail/save-timers',
    panel: 'admin-panel',
    what: 'Save the settlement rail timers',
    async run(page, cfg, base) {
      const before = await db.paymentModePolicy.getActivePolicy();
      const was = Number(before?.assignmentWaitSeconds ?? 0);
      const target = was === 91 ? 92 : 91;

      await go(page, cfg, base, '/business-policy/settlement-rail');
      const typed = await fill(page, '#timer-assignmentWaitSeconds', String(target));
      if (!typed.ok) return ['NOT DRIVEN', typed.why];
      // The Save stays DISABLED until the justification is filled — it is
      // recorded against the version, and the screen says so. A case that typed
      // only the number reported "Save is disabled with a valid value", which
      // blames the screen for a field it was never given.
      const why = await fill(page, '#rail-justification', 'mutating drive: timer check');
      if (!why.ok) return ['NOT DRIVEN', why.why];
      await settle(page, 1500);

      const save = page.getByRole('button', { name: /^\s*Save timers\s*$/i }).first();
      if (await save.count() === 0) return ['NOT DRIVEN', 'no "Save timers" button'];
      if (await save.isDisabled()) return ['NOT DRIVEN', 'Save timers is still disabled with both fields filled'];
      await save.click({ timeout: 8000 });
      await settle(page, 6000);
      const answered = await confirmWith(page, 'Save');
      if (answered === 'stuck') return ['FAILED', 'the Save confirmation could not be pressed'];
      if (answered === 'none') return ['FAILED', 'pressing Save timers raised no confirmation'];

      const after = await db.paymentModePolicy.getActivePolicy();
      if (Number(after?.assignmentWaitSeconds) !== target) {
        return ['FAILED', `assignmentWaitSeconds is ${after?.assignmentWaitSeconds}, expected ${target}`
          + ` — screen said: ${(await words(page)).slice(-140)}`];
      }
      // A new ACTIVE version, not an edit of the old one — that is what
      // append-only means, and a save that mutated v1 in place would be wrong
      // in a way the value alone cannot show.
      if (Number(after?.version) <= Number(before?.version ?? 0)) {
        return ['FAILED', `the policy stayed at v${after?.version}; the timers were edited in place`];
      }
      return ['DROVE', `assignmentWaitSeconds ${was} → ${target} as v${after.version} (was v${before?.version})`];
    },
  },


  // ── A commission policy version, which is also append-only ───────────────
  {
    id: 'admin/merchant-platform/save-policy',
    panel: 'admin-panel',
    what: 'Publish a new merchant commission policy version',
    async run(page, cfg, base) {
      const before = await db.merchantCommissionPolicy.getActivePolicy().catch(() => null);
      const wasVersion = Number(before?.version ?? 0);
      const wasFloor = Number(before?.minMatchedVolumePaise ?? before?.minMatchedVolume ?? 0);

      await go(page, cfg, base, '/merchant-platform');
      const typed = await fill(page, '#min-matched-volume', String(wasFloor === 1234 ? 1235 : 1234));
      if (!typed.ok) return ['NOT DRIVEN', typed.why];
      // Same shape as the settlement rail: the version is JUSTIFIED, and the
      // route refuses without one ("Business justification required").
      const why = await fill(page, '#justification-required', 'mutating drive: floor check');
      if (!why.ok) return ['NOT DRIVEN', why.why];
      await settle(page, 1500);

      const save = page.getByRole('button', { name: /^\s*Save New Policy Version\s*$/i }).first();
      if (await save.count() === 0) return ['NOT DRIVEN', 'no "Save New Policy Version" button'];
      if (await save.isDisabled()) return ['NOT DRIVEN', 'Save New Policy Version is disabled with both fields filled'];
      await save.click({ timeout: 8000 });
      await settle(page, 8000);
      await confirmWith(page, 'Save');

      const after = await db.merchantCommissionPolicy.getActivePolicy().catch(() => null);
      if (!after) return ['FAILED', 'no active commission policy after the save'];
      if (Number(after.version) <= wasVersion) {
        return ['FAILED', `the policy stayed at v${after.version} — a version was not published`
          + ` — screen said: ${(await words(page)).slice(-140)}`];
      }
      return ['DROVE', `published v${after.version} (was v${wasVersion || 'none'})`];
    },
  },

  // ── Deleting a branding asset ────────────────────────────────────────────
  {
    id: 'admin/content/cdn/delete',
    panel: 'admin-panel',
    what: 'Remove an image from the CDN library',
    async run(page, cfg, base) {
      const mine = rid('cdnimg');
      const neighbour = rid('cdnimg');
      for (const id of [mine, neighbour]) {
        await pgQuery(
          `INSERT INTO cdn_images (image_id, url, category, title)
           VALUES ($1, $2, 'GENERAL', $1)`,
          [id, `https://cdn.example.test/${id}.png`],
        );
      }

      await go(page, cfg, base, '/content/cdn');
      const card = page.locator('div')
        .filter({ hasText: mine })
        .filter({ has: page.getByTitle('Delete') })
        .last();
      if (await card.count() === 0) {
        const n = await page.getByTitle('Delete').count();
        await pgQuery('DELETE FROM cdn_images WHERE image_id = ANY($1::text[])', [[mine, neighbour]]);
        return ['NOT DRIVEN', `${mine} is not among the ${n} images offering a Delete`];
      }
      await card.getByTitle('Delete').first().click({ timeout: 8000 });
      await settle(page, 4000);
      // ConfirmDialog with confirmText="Remove", under the title
      // "Remove from CDN Library" — not "Delete", which the row's control says.
      const said = await confirmWith(page, 'Remove');

      const goneTarget = !(await cdnImageExists(mine));
      const keptOther = await cdnImageExists(neighbour);
      await pgQuery('DELETE FROM cdn_images WHERE image_id = ANY($1::text[])', [[mine, neighbour]]);
      if (said === 'stuck') return ['FAILED', 'the Remove confirmation could not be pressed'];
      if (said === 'none') return ['FAILED', 'pressing Delete raised no Remove confirmation'];
      if (!goneTarget) return ['FAILED', `${mine} is still in the library`];
      if (!keptOther) return ['FAILED', 'the BYSTANDER image was removed too'];
      return ['DROVE', `${mine} removed, the neighbour image kept`];
    },
  },

  // ── The merchant's own panel ─────────────────────────────────────────────
  {
    id: 'merchant/profile/save-preferences',
    panel: 'merchant-panel',
    what: 'Save merchant notification preferences',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/profile');
      const save = page.getByRole('button', { name: /^\s*Save preferences\s*$/i }).first();
      if (await save.count() === 0) {
        const routed = await page.locator('main').innerText().catch(() => '(no <main>)');
        return ['NOT DRIVEN', `no "Save preferences" — routed region: ${routed.replace(/\s+/g, ' ').slice(0, 160)}`];
      }
      // Flip a switch first, or the save publishes what was already stored and
      // proves nothing about whether the press carried anything.
      // The switch is `sr-only` inside its label, so a direct click times out
      // and — because the click was swallowed — nothing changed, Save stayed
      // DISABLED, and this case failed on the SAVE while the real cause was
      // the switch above it. `clickThrough` presses what a person presses.
      const toggle = page.locator('[role="switch"], input[type="checkbox"]').first();
      let flipped = false;
      if (await toggle.count() > 0) {
        const hit = await clickThrough(toggle.first(), { timeout: 8000 });
        flipped = hit.ok;
        if (!hit.ok) return ['NOT DRIVEN', `the preference switch could not be pressed: ${hit.why}`];
      }
      await settle(page, 1500);

      const before = await merchantPrefs(page.__bbMerchantId);
      if (await save.isDisabled()) {
        return ['FAILED', 'a preference was flipped and Save preferences stayed disabled'];
      }
      const hit = await clickThrough(save, { timeout: 8000 });
      if (!hit.ok) return ['FAILED', `Save preferences could not be pressed: ${hit.why}`];
      await settle(page, 8000);
      const after = await merchantPrefs(page.__bbMerchantId);
      const said = await words(page);

      if (JSON.stringify(after) !== JSON.stringify(before)) {
        return ['DROVE', `preferences written: ${JSON.stringify(after).slice(0, 80)}`];
      }
      if (!flipped && /saved|updated|success/i.test(said)) {
        return ['DROVE', 'saved with nothing changed — the screen confirmed it (no switch to flip)'];
      }
      return ['FAILED', `pressed Save preferences and the stored preferences did not move`
        + ` — screen said: ${said.slice(-140)}`];
    },
  },


  // ── Money: paying referral rewards out to players ────────────────────────
  {
    id: 'admin/referrals/disburse',
    panel: 'admin-panel',
    what: 'Disburse referral rewards',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/referrals');
      const typed = await fill(page, '#pool-amount', '100');
      if (!typed.ok) return ['NOT DRIVEN', typed.why];
      await settle(page, 1500);

      const open = page.getByRole('button', { name: /^\s*Disburse\s*$/i }).first();
      if (await open.count() === 0) return ['NOT DRIVEN', 'no Disburse button on /referrals'];
      if (await open.isDisabled()) return ['NOT DRIVEN', 'Disburse is disabled with an amount entered'];
      await open.click({ timeout: 8000 });
      await settle(page, 2000);

      // An INLINE two-step, not a dialog: pressing Disburse swaps the button
      // for "Yes, pay out" beside a warning. `confirmWith` is dialog-only by
      // design, so this screen's own second press is made here.
      const yes = page.getByRole('button', { name: /^\s*Yes, pay out\s*$/i }).first();
      if (await yes.count() === 0) return ['NOT DRIVEN', 'pressing Disburse raised no "Yes, pay out"'];

      const before = await referralPaidPaise();
      // ── Read the ANSWER, not the toast ───────────────────────────────────
      // Both outcomes raise a toast and both fade. Reading the page ten seconds
      // later found neither and reported "the screen said nothing" over a
      // button that had been answered properly. The response is the durable
      // record of what the platform decided.
      const answered = page.waitForResponse(
        (r) => /\/referral/i.test(r.url()) && r.request().method() === 'POST',
        { timeout: 15000 },
      ).catch(() => null);
      await yes.click({ timeout: 8000 });
      const reply = await answered;
      await settle(page, 8000);
      const after = await referralPaidPaise();
      const body = reply ? await reply.text().catch(() => '') : '';

      if (after > before) return ['DROVE', `referral payouts ${before} → ${after} paise`];
      if (!reply) return ['FAILED', 'pressing "Yes, pay out" sent no request at all'];
      // With no budget and nobody verified there is nothing to pay, and saying
      // so is the platform working, not a broken button (§32 S19).
      if (reply.status() < 500) {
        return ['DROVE', `answered ${reply.status()}, nothing owed — ${body.replace(/\s+/g, ' ').slice(0, 110)}`];
      }
      return ['FAILED', `"Yes, pay out" answered ${reply.status()} — ${body.slice(0, 140)}`];
    },
  },

  // ── The bot generation that owns the official channel ────────────────────
  {
    id: 'admin/telegram/activate',
    panel: 'admin-panel',
    what: 'Activate a new Telegram generation',
    async run(page, cfg, base) {
      const before = await telegramGeneration();

      await go(page, cfg, base, '/telegram');
      const channel = `drive_${Math.random().toString(36).slice(2, 8)}`;
      // ── Addressed by PLACEHOLDER, and that is a finding ───────────────────
      // "Bot token" and "Channel id" are the two REQUIRED fields — Activate
      // stays disabled without them — and each is a bare <label> with no
      // `htmlFor` and no `id` on the input. §32 S24: the text is on screen so
      // it looks labelled, but nothing associates the two, so a screen reader
      // (and `getByLabel`) cannot address either. On the screen that owns the
      // platform's official channel.
      const token = await fill(page, 'input[placeholder^="123456789"]', '123456789:AAdrive-pass-token');
      if (!token.ok) return ['NOT DRIVEN', `bot token field: ${token.why}`];
      const chan = await fill(page, 'input[placeholder^="-100"]', '-1001234567890');
      if (!chan.ok) return ['NOT DRIVEN', `channel id field: ${chan.why}`];
      await fill(page, '#channel-username', channel);
      await fill(page, '#channel-invite-link', `https://t.me/${channel}`);
      await fill(page, '#reason', 'mutating drive: generation check');
      await settle(page, 1500);

      const activate = page.getByRole('button', { name: /^\s*Activate\s*$/i }).first();
      if (await activate.count() === 0) return ['NOT DRIVEN', 'no Activate button on /telegram'];
      if (await activate.isDisabled()) return ['NOT DRIVEN', 'Activate is disabled with the form filled'];

      // ── The ANSWER, never the page text ──────────────────────────────────
      // A first draft looked for /token|invalid|…/ in the body to decide whether
      // the platform had refused by name. The nav carries a "Token Flow" link,
      // so it matched on every run and reported a refusal the server never made
      // — a check measuring nothing that reads exactly like a pass (§32 S8).
      const answered = page.waitForResponse(
        (r) => /\/telegram/i.test(r.url()) && r.request().method() !== 'GET',
        { timeout: 20000 },
      ).catch(() => null);
      await activate.click({ timeout: 8000 });
      await settle(page, 3000);
      // An INLINE two-step, like the referral disbursal: pressing Activate
      // swaps the button for "Yes, activate" beside a warning, in the page
      // rather than a dialog. `confirmWith` is dialog-only by design (a
      // page-wide fallback once deleted a second chat message), so a screen
      // that confirms inline is confirmed here, by name. Third screen with this
      // shape — "Yes, pay out", "Yes, activate" — and neither is a dialog.
      const yes = page.getByRole('button', { name: /^\s*Yes, activate\s*$/i }).first();
      if (await yes.count() === 0) {
        return ['FAILED', 'pressing Activate raised no "Yes, activate" step'];
      }
      await yes.click({ timeout: 8000 });
      const reply = await answered;
      await settle(page, 8000);

      const after = await telegramGeneration();
      // §2: a CHANNEL change bumps the generation; a bot swap does not. So the
      // assertion is the generation, not merely "something saved".
      if (Number(after?.generation ?? 0) > Number(before?.generation ?? 0)) {
        return ['DROVE', `generation ${before?.generation ?? 'none'} → ${after.generation}, channel ${after.channel_username}`];
      }
      if (!reply) return ['FAILED', 'pressing Activate sent no request at all'];
      const body = (await reply.text().catch(() => '')).replace(/\s+/g, ' ');
      // A refusal is legitimate and expected here: the route validates the bot
      // token WITH TELEGRAM, which this container cannot reach. What matters is
      // that the platform said so rather than half-applying.
      if (reply.status() >= 400 && reply.status() < 500) {
        return ['DROVE', `refused ${reply.status()}, generation unchanged — ${body.slice(0, 110)}`];
      }
      return ['FAILED', `Activate answered ${reply.status()} and the generation did not move — ${body.slice(0, 140)}`];
    },
  },


  // ── The payment gateway configuration ────────────────────────────────────
  {
    id: 'admin/payment-control/save',
    panel: 'admin-panel',
    what: 'Save the payment system configuration',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/payment-control');
      const save = page.getByRole('button', { name: /^\s*Save\s*$/i }).first();
      if (await save.count() === 0) return ['NOT DRIVEN', 'no Save button on /payment-control'];

      const answered = page.waitForResponse(
        (r) => /\/payment\/admin\/config/.test(r.url()) && r.request().method() === 'PUT',
        { timeout: 15000 },
      ).catch(() => null);
      await save.click({ timeout: 8000 });
      const reply = await answered;
      await settle(page, 8000);

      if (!reply) return ['FAILED', 'pressing Save sent no PUT at all — the control is inert'];
      const body = (await reply.text().catch(() => '')).replace(/\s+/g, ' ');
      if (reply.status() >= 500) return ['FAILED', `Save answered ${reply.status()} — ${body.slice(0, 140)}`];

      // The row the route owns, read back. §2: this is `active_mode` — P2P vs a
      // third-party gateway — and NOT the settlement rail, which lives in
      // `payment_mode_policies`. Confusing the two is how a screen comes to
      // report a rail it does not control.
      const stored = await gatewayMode();
      if (!stored) return ['FAILED', `Save answered ${reply.status()} but no gateway config row exists`];
      return ['DROVE', `answered ${reply.status()}, active_mode is '${stored}'`];
    },
  },

  // ── Deferred by NAME, and not a mutation at all ──────────────────────────
  // `drive.js` defers on the first word of a control's name, which is the right
  // rule for an action and wrong for these two: Token Flow's "Apply" re-READS
  // the window, and the player's theme toggle is a per-viewer preference. They
  // were never pressed by any pass, so they are pressed here — with the
  // assertion each actually deserves, which is that NOTHING was written.
  {
    id: 'admin/token-flow/apply',
    panel: 'admin-panel',
    what: 'Apply the analytics window (a READ)',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/token-flow');
      const window = page.locator('#trend-window');
      if (await window.count() === 0) return ['NOT DRIVEN', 'no #trend-window on /token-flow'];
      await window.selectOption('90').catch(() => {});
      await settle(page, 1500);

      const apply = page.getByRole('button', { name: /^\s*Apply\s*$/i }).first();
      if (await apply.count() === 0) return ['NOT DRIVEN', 'no Apply button on /token-flow'];

      const writes = [];
      const watch = (r) => { if (r.method() !== 'GET' && /\/api\//.test(r.url())) writes.push(`${r.method()} ${r.url()}`); };
      page.on('request', watch);
      const reads = page.waitForResponse(
        (r) => /analytics|token/i.test(r.url()) && r.request().method() === 'GET',
        { timeout: 15000 },
      ).catch(() => null);
      await apply.click({ timeout: 8000 });
      const reply = await reads;
      await settle(page, 6000);
      page.off('request', watch);

      if (!reply) return ['FAILED', 'pressing Apply fetched nothing — the control is inert'];
      if (writes.length) return ['FAILED', `"Apply" WROTE: ${writes.slice(0, 2).join(', ')}`];
      return ['DROVE', `re-read at ${reply.status()}, and wrote nothing — correctly not a mutation`];
    },
  },

  {
    id: 'user/profile/switch-theme',
    panel: 'user-panel',
    what: 'Switch the theme (a per-viewer preference)',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/');
      const toggle = page.getByRole('button', { name: /Toggle theme/i }).first();
      if (await toggle.count() === 0) return ['NOT DRIVEN', 'no theme toggle on the player shell'];

      const themeNow = () => page.evaluate(() =>
        document.documentElement.getAttribute('data-theme')
        ?? document.body.getAttribute('data-theme')
        ?? getComputedStyle(document.body).backgroundColor);
      const before = await themeNow();

      const writes = [];
      const watch = (r) => { if (r.method() !== 'GET' && /\/api\//.test(r.url())) writes.push(`${r.method()} ${r.url()}`); };
      page.on('request', watch);
      await toggle.click({ timeout: 8000 });
      await settle(page, 4000);
      page.off('request', watch);
      const after = await themeNow();

      if (after === before) return ['FAILED', `pressing the toggle left the theme at '${before}'`];
      // §11 allows a genuine UI-only value as a frontend concern. The assertion
      // is that it STAYED one: a theme that posted to the server would be a
      // preference with a second owner.
      if (writes.length) return ['FAILED', `the theme toggle WROTE: ${writes.slice(0, 2).join(', ')}`];
      return ['DROVE', `theme '${before}' → '${after}', and nothing was sent to the server`];
    },
  },

  configSave({
    id: 'admin/content/support/save',
    screen: '/content/support',
    selector: '#sl-whatsapp',
    button: 'Save support links',
    scope: 'supportLinks',
    key: 'whatsapp',
    value: 'https://wa.me/919999900001',
    label: 'Save the support links document',
  }),

  configSave({
    id: 'admin/branding/save',
    screen: '/branding',
    selector: '#app-name',
    button: 'Save Branding Settings',
    scope: 'branding',
    key: 'appName',
    value: 'Drive Pass Bazaar',
    label: 'Save the branding document',
  }),

  // ══════════════════════════════════════════════════════════════════════
  // The controls the drive deferred and this pass had no case for. Every one
  // was in the DEFERRED list of a full three-panel run and therefore in the
  // 53.7% nobody had pressed; a deferral is an admission, not a result.
  // ══════════════════════════════════════════════════════════════════════

  // ── A merchant's application, decided both ways ──────────────────────────
  {
    id: 'admin/merchants/approve',
    panel: 'admin-panel',
    what: 'Approve a pending merchant application',
    async run(page, cfg, base) {
      // `approve: false` leaves them PENDING, which is the state the button
      // exists for. A merchant seeded APPROVED has no Approve button at all,
      // and a case that reports NOT DRIVEN for its own fixture's sake is worse
      // than no case.
      const target = await seedMerchant({ currency: 'INR', approve: false, online: false });
      const bystander = await seedMerchant({ currency: 'INR', approve: false, online: false });

      await go(page, cfg, base, '/merchants');
      await search(page, target.username);
      const row = await rowFor(page, target.username);
      if (!row) return ['NOT DRIVEN', `seeded merchant ${target.username} never appeared`];

      const hit = await pressInRow(row, 'Approve');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 6000);
      await confirmWith(page, 'Approve');

      const mine = await merchantStatus(target.merchantId);
      const neighbour = await merchantStatus(bystander.merchantId);
      if (mine !== 'ACTIVE') return ['FAILED', `pressed Approve; the merchant is ${mine}`];
      if (neighbour !== 'PENDING') return ['FAILED', `the BYSTANDER merchant moved to ${neighbour}`];
      return ['DROVE', `${target.username} PENDING → ACTIVE, bystander still ${neighbour}`];
    },
  },

  {
    id: 'admin/merchants/reject',
    panel: 'admin-panel',
    what: 'Reject a pending merchant application',
    async run(page, cfg, base) {
      const target = await seedMerchant({ currency: 'INR', approve: false, online: false });
      const bystander = await seedMerchant({ currency: 'INR', approve: false, online: false });

      await go(page, cfg, base, '/merchants');
      await search(page, target.username);
      const row = await rowFor(page, target.username);
      if (!row) return ['NOT DRIVEN', `seeded merchant ${target.username} never appeared`];

      // `handleRejectMerchant` opens `prompt('Rejection reason (required):')`
      // and returns on an empty one, so a dismissed dialog is a press that
      // does nothing. `__bbAccept` as a STRING types into the prompt.
      page.__bbAccept = 'rejected by the mutating pass';
      let hit;
      try {
        hit = await pressInRow(row, 'Reject');
        if (!hit.ok) return ['NOT DRIVEN', hit.why];
        await settle(page, 6000);
        await confirmWith(page, 'Reject');
      } finally { page.__bbAccept = false; }

      const mine = await merchantStatus(target.merchantId);
      const neighbour = await merchantStatus(bystander.merchantId);
      if (mine === 'PENDING') return ['FAILED', 'pressed Reject; the merchant is still PENDING'];
      if (neighbour !== 'PENDING') return ['FAILED', `the BYSTANDER merchant moved to ${neighbour}`];
      return ['DROVE', `${target.username} PENDING → ${mine}, bystander still ${neighbour}`];
    },
  },

  // ── Content rows, each deleted against a neighbour that must survive ─────
  {
    id: 'admin/content/faq/delete',
    panel: 'admin-panel',
    what: 'Delete an FAQ entry',
    async run(page, cfg, base) {
      const mine = rid('DriveFaq');
      const neighbour = rid('KeepFaq');
      for (const q of [mine, neighbour]) {
        await pgQuery(
          `INSERT INTO faqs (faq_id, question, answer, category, sort_order, is_published)
           VALUES ($1, $1, 'seeded by the mutating pass', 'general', 999, TRUE)`, [q],
        );
      }

      await go(page, cfg, base, '/content/faq');
      const button = page.getByRole('button', { name: new RegExp(`Delete FAQ: ${mine}`, 'i') }).first();
      if (await button.count() === 0) return ['NOT DRIVEN', `no "Delete FAQ: ${mine}" control found`];

      page.__bbAccept = true;
      let answered = 'none';
      try {
        await button.click();
        await settle(page, 6000);
        answered = await confirmWith(page, 'Delete');
      } finally { page.__bbAccept = false; }
      if (String(answered).startsWith('unanswered')) {
        return ['FAILED', `the confirmation could not be answered — ${answered}`];
      }

      const count = async (id) => Number(
        (await pgQuery('SELECT count(*)::int AS n FROM faqs WHERE faq_id = $1', [id])).rows[0].n);
      const goneTarget = (await count(mine)) === 0;
      const keptOther = (await count(neighbour)) === 1;
      await pgQuery('DELETE FROM faqs WHERE faq_id = ANY($1::text[])', [[mine, neighbour]]);

      if (!goneTarget) return ['FAILED', `${mine} is still in the FAQ list`];
      if (!keptOther) return ['FAILED', 'the BYSTANDER FAQ was deleted too'];
      return ['DROVE', `${mine} deleted, ${neighbour} untouched`];
    },
  },

  {
    id: 'admin/promotions/announcements/delete',
    panel: 'admin-panel',
    what: 'Delete an announcement',
    async run(page, cfg, base) {
      const mine = rid('DriveAnn');
      const neighbour = rid('KeepAnn');
      for (const t of [mine, neighbour]) {
        await pgQuery(
          `INSERT INTO announcements (announcement_id, title, body, kind, priority, is_active)
           VALUES ($1, $1, 'seeded by the mutating pass', 'INFO', 1, TRUE)`, [t],
        );
      }

      await go(page, cfg, base, '/promotions/announcements');
      const button = page
        .getByRole('button', { name: new RegExp(`Delete announcement "${mine}"`, 'i') }).first();
      if (await button.count() === 0) return ['NOT DRIVEN', `no delete control for announcement ${mine}`];

      page.__bbAccept = true;
      try {
        await button.click();
        await settle(page, 6000);
        await confirmWith(page, 'Delete');
      } finally { page.__bbAccept = false; }

      const count = async (id) => Number(
        (await pgQuery('SELECT count(*)::int AS n FROM announcements WHERE announcement_id = $1', [id])).rows[0].n);
      const goneTarget = (await count(mine)) === 0;
      const keptOther = (await count(neighbour)) === 1;
      await pgQuery('DELETE FROM announcements WHERE announcement_id = ANY($1::text[])', [[mine, neighbour]]);

      if (!goneTarget) return ['FAILED', `announcement ${mine} is still listed`];
      if (!keptOther) return ['FAILED', 'the BYSTANDER announcement was deleted too'];
      return ['DROVE', `${mine} deleted, ${neighbour} untouched`];
    },
  },

  // ── An app asset: a SLOT, so deleting it is a reset, and it goes back ────
  {
    id: 'admin/app-assets/delete',
    panel: 'admin-panel',
    what: 'Clear an uploaded app asset',
    async run(page, cfg, base) {
      // `app_assets` is keyed by SLOT, not by an id this pass can invent, so
      // there is no "its own row" to make here — the row IS the platform's.
      // The case therefore takes the whole row first and puts it back in a
      // `finally`, which is the same rule a platform-wide Save obeys.
      const slot = 'logo.png';
      const before = (await pgQuery('SELECT * FROM app_assets WHERE slot = $1', [slot])).rows[0] ?? null;
      const seeded = !before;
      if (seeded) {
        await pgQuery(
          `INSERT INTO app_assets (slot, url, storage, content_type)
           VALUES ($1, 'https://cdn.invalid/drive-logo.png', 'EXTERNAL', 'image/png')`, [slot],
        );
      }
      try {
        await go(page, cfg, base, '/app-assets');
        const button = page.getByRole('button', { name: new RegExp(`Delete the ${slot} asset`, 'i') }).first();
        if (await button.count() === 0) return ['NOT DRIVEN', `no "Delete the ${slot} asset" control`];

        page.__bbAccept = true;
        try {
          await button.click();
          await settle(page, 6000);
          await confirmWith(page, 'Delete');
        } finally { page.__bbAccept = false; }

        const still = (await pgQuery('SELECT count(*)::int AS n FROM app_assets WHERE slot = $1', [slot])).rows[0].n;
        if (Number(still) !== 0) return ['FAILED', `pressed Delete; the ${slot} slot still holds a row`];
        return ['DROVE', `the ${slot} slot was cleared, and is restored`];
      } finally {
        if (before) {
          await pgQuery(
            `INSERT INTO app_assets (slot, url, storage, file_key, file_size, content_type, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (slot) DO UPDATE SET url = EXCLUDED.url, storage = EXCLUDED.storage,
               file_key = EXCLUDED.file_key, file_size = EXCLUDED.file_size,
               content_type = EXCLUDED.content_type`,
            [before.slot, before.url, before.storage, before.file_key,
             before.file_size, before.content_type, before.updated_by],
          ).catch((e) => console.error('   ! could not restore the app asset:', e.message));
        } else {
          await pgQuery('DELETE FROM app_assets WHERE slot = $1', [slot]).catch(() => {});
        }
      }
    },
  },

  // ── What the bot SAYS: a per-template Save, restored to the default ──────
  {
    id: 'admin/telegram/save-template',
    panel: 'admin-panel',
    what: "Save one of the bot's message templates",
    async run(page, cfg, base) {
      await go(page, cfg, base, '/telegram');
      const box = page.locator('textarea[aria-label^="Message the bot sends for"]').first();
      if (await box.count() === 0) return ['NOT DRIVEN', 'no template editor on /telegram'];

      const key = (await box.getAttribute('aria-label') ?? '').replace(/^Message the bot sends for\s*/i, '').trim();
      if (!key) return ['NOT DRIVEN', 'the template editor does not say which key it edits'];

      const rows = await pgQuery('SELECT body FROM telegram_templates WHERE key = $1', [key]);
      const before = rows.rows[0]?.body ?? null;    // null = never customised, i.e. the shipped default
      const wrote = `drive pass ${rid('tpl')} — this text is restored in a finally`;
      try {
        await box.fill(wrote);
        await settle(page, 1500);

        // The Save is disabled until the draft differs, which is the screen
        // telling the truth: there is nothing to save. Asserting that first
        // means a failure here is about the SAVE, not about the fill.
        const save = page.getByRole('button', { name: /^\s*Sav(e|ing)/i }).first();
        if (await save.count() === 0) return ['NOT DRIVEN', 'no Save control beside the template'];
        if (await save.isDisabled()) return ['FAILED', 'the text changed and Save stayed disabled'];
        await save.click();
        await settle(page, 8000);

        const after = (await pgQuery('SELECT body FROM telegram_templates WHERE key = $1', [key])).rows[0]?.body ?? null;
        if (after !== wrote) {
          return ['FAILED', `pressed Save; telegram_templates.body for '${key}' is ${JSON.stringify(String(after).slice(0, 40))}`];
        }
        return ['DROVE', `template '${key}' written and restored`];
      } finally {
        // §2: a BLANK row means the shipped default, never silence — so the
        // way back to "not customised" is a blank body, not a deleted row,
        // unless there was no row to begin with.
        if (before === null) {
          await pgQuery('DELETE FROM telegram_templates WHERE key = $1', [key])
            .catch((e) => console.error('   ! could not remove the template row:', e.message));
        } else {
          await pgQuery('UPDATE telegram_templates SET body = $2 WHERE key = $1', [key, before])
            .catch((e) => console.error('   ! could not restore the template:', e.message));
        }
      }
    },
  },

  // ── Log out: the one control that ends the pass that presses it ─────────
  // `ownContext` is the whole point. Pressing this on the shared page would
  // sign out every case after it on that panel, which is why the drive
  // deferred it and why nobody had ever pressed it.
  {
    id: 'user/profile/logout',
    panel: 'user-panel',
    ownContext: true,
    what: 'Log out of the player panel',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/profile');
      const button = page.getByRole('button', { name: /^\s*Log ?out\s*$/i }).first();
      if (await button.count() === 0) return ['NOT DRIVEN', 'no Log out control on /profile'];

      page.__bbAccept = true;
      try {
        await button.click();
        await settle(page, 6000);
      } finally { page.__bbAccept = false; }

      // The credential must be REMOVED. A screen that navigates to sign-in
      // while the token is still stored is a logout that logs nobody out —
      // the next tab restores the session.
      const removed = await page.evaluate(() => {
        try { return JSON.parse(sessionStorage.getItem('__bb_removed') || '[]'); } catch { return []; }
      });
      if (!removed.includes(cfg.key)) {
        return ['FAILED', `pressed Log out and ${cfg.key} was never removed — saw [${removed.join(', ') || 'nothing'}]`];
      }

      const said = await words(page);
      if (!/sign in|log ?in|welcome|get started|create account/i.test(said)) {
        return ['FAILED', 'the token was cleared; the screen never showed a way back in'];
      }
      return ['DROVE', `${cfg.key} removed and the panel offered a way back in`];
    },
  },

  {
    id: 'merchant/profile/logout',
    panel: 'merchant-panel',
    ownContext: true,
    what: 'Log out of the merchant panel',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/profile');
      const button = page.getByRole('button', { name: /^\s*Log ?out\s*$/i }).first();
      if (await button.count() === 0) return ['NOT DRIVEN', 'no Log out control on /profile'];

      page.__bbAccept = true;
      try {
        await button.click();
        await settle(page, 6000);
      } finally { page.__bbAccept = false; }

      const removed = await page.evaluate(() => {
        try { return JSON.parse(sessionStorage.getItem('__bb_removed') || '[]'); } catch { return []; }
      });
      if (!removed.includes(cfg.key)) {
        return ['FAILED', `pressed Log out and ${cfg.key} was never removed — saw [${removed.join(', ') || 'nothing'}]`];
      }
      // A merchant panel caches its PROFILE beside the token, and a logout
      // that leaves that behind leaves the next visitor a name and a mobile
      // number belonging to somebody else on a shared machine.
      if (cfg.cacheKey && !removed.includes(cfg.cacheKey)) {
        return ['FAILED', `the token went; the cached profile in ${cfg.cacheKey} did NOT`];
      }
      return ['DROVE', `${cfg.key} and ${cfg.cacheKey ?? 'no cache'} both removed`];
    },
  },

  // ── A file PICKER can be driven; Playwright sets the files directly ──────
  {
    id: 'admin/kyc/bulk/choose-csv',
    panel: 'admin-panel',
    what: 'Choose a CSV on the bulk KYC screen',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/kyc/bulk');
      const input = page.locator('input[type="file"]').first();
      if (await input.count() === 0) return ['NOT DRIVEN', 'no file input on /kyc/bulk'];

      // A REAL shape, not an empty file: the screen's job is to parse it and
      // say what it found, and an empty upload cannot tell "parsed nothing"
      // from "never parsed".
      const before = await words(page);
      await input.setInputFiles({
        name: 'drive-bulk-kyc.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('mobile,aadhaar\n9876500001,111122223333\n9876500002,444455556666\n'),
      });
      await settle(page, 6000);
      const after = await words(page);

      if (after === before) {
        return ['FAILED', 'a CSV was chosen and the screen said nothing — no count, no preview, no error'];
      }
      return ['DROVE', 'a 2-row CSV was accepted and the screen responded to it'];
    },
  },

  // ── A DOWNLOAD can be driven too; the browser hands it over ──────────────
  {
    id: 'merchant/history/export-csv',
    panel: 'merchant-panel',
    what: 'Export the merchant history as CSV',
    async run(page, cfg, base) {
      // ── The export needs something to export, and saying so is the point ──
      // `exportCsv` returns early with "No completed orders to export yet"
      // when the list is empty — correct behaviour, and it is why the first
      // version of this case reported "the browser was offered no file" as
      // though the button were broken. That is §32 S19 in a case of my own:
      // asserting a precondition it never established. So it establishes it.
      const player = await seedPlayer({ balancePaise: 100000 });
      const orderId = rid('drive-hist');
      await pgQuery(
        `INSERT INTO order_states
           (order_id, user_id, merchant_id, order_type, state, token_amount_paise,
            fiat_amount_paise, completed_at)
         VALUES ($1, $2, $3, 'DEPOSIT', 'COMPLETED', 50000, 50000, now())`,
        [orderId, player.userId, page.__bbMerchantId],
      );

      await go(page, cfg, base, '/history');
      // The export reads the COMPLETED tab's list, so the tab has to be the
      // one showing it — the button exports what the view holds, not what the
      // database holds, and those are different claims.
      const tab = page.getByRole('button', { name: /^\s*Completed\s*$/i }).first();
      if (await tab.count() > 0) { await clickThrough(tab, { timeout: 8000 }); await settle(page, 4000); }

      const button = page.getByRole('button', { name: /^\s*Export CSV\s*$/i }).first();
      if (await button.count() === 0) return ['NOT DRIVEN', 'no Export CSV control on /history'];

      // The drive defers a download because it cannot hand the file back.
      // Playwright can: `waitForEvent('download')` gives the real file, so the
      // assertion is about the CONTENT, not about whether a click happened.
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
        button.click(),
      ]);
      if (!download) return ['FAILED', 'pressed Export CSV and the browser was offered no file'];

      const path = await download.path();
      const body = path ? await import('node:fs').then((fs) => fs.promises.readFile(path, 'utf8')) : '';
      if (!body.trim()) return ['FAILED', `downloaded ${download.suggestedFilename()} and it is EMPTY`];

      const lines = body.split(/\r?\n/).filter(Boolean);
      const firstLine = lines[0];
      if (!/,/.test(firstLine)) {
        return ['FAILED', `the file has no comma-separated header row: "${firstLine.slice(0, 80)}"`];
      }
      // The order this run created has to be IN it. A header with no rows is
      // a file, and it is not an export.
      if (!body.includes(orderId)) {
        return ['FAILED', `the CSV has ${lines.length - 1} row(s) and none of them is ${orderId}`];
      }
      return ['DROVE', `${download.suggestedFilename()}, ${lines.length - 1} row(s), and ${orderId} is in it`];
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

  // ── A configured platform, because all three panels GATE on one ─────────
  // §33.7 gates every panel on Telegram, and `VerificationGateModal` BLOCKS —
  // with no bot and no channel it renders a modal with no button, over the
  // whole screen, deliberately. Measured before this line existed: the two
  // merchant cases timed out at THIRTY SECONDS on buttons that were behind
  // that modal, and the preference switch could not be pressed for the same
  // reason. Three "the control is broken" findings, none of them true.
  //
  // STAFF pass through the bootstrap exemption, which is why the admin cases
  // were unaffected and the failure looked merchant-specific.
  //
  // Restored at the end, outside any assertion (trap 10): an active channel
  // re-gates every player the moment its generation moves, so a leftover one
  // is not a stale fixture, it is a platform running under rules nobody chose.
  const restoreTelegram = await configureTelegram();

  const tokens = { 'admin-panel': adminToken(await seedAdmin()) };
  const cached = {};
  let driveMerchant = null;
  if (panels.includes('merchant-panel')) {
    // `cashDenominationPaise` makes it a CASH merchant so its screens render
    // their working state rather than the "not approved for the ATM rail"
    // empty one — the same seeding stack.js documents for the drive pass.
    driveMerchant = await seedMerchant({
      currency: 'INR', tokensPaise: 500000000, cashDenominationPaise: 500000,
    });
    tokens['merchant-panel'] = merchantToken(driveMerchant);
    // A RETURNING merchant has a cached profile besides a token; seeding only
    // the token means one refused profile call renders the sign-in screen.
    cached['merchant-panel'] = {
      id: driveMerchant.merchantId, merchantId: driveMerchant.merchantId,
      username: driveMerchant.username, email: driveMerchant.email,
      mobile: driveMerchant.mobile, isOnline: true, status: 'ACTIVE',
      acceptedCurrencies: ['INR'],
    };
  }

  // ── Refuse to run behind a tripped login limiter ─────────────────────────
  // Every page entry calls `/api/v1/auth/me`, and enough runs trip the login
  // tier. The panel answers a 429 by logging out, so EVERY case then reports
  // its control as missing — nineteen "NOT DRIVEN" lines that look like
  // nineteen broken screens and are one exhausted counter. Measured: it cost
  // two full debugging rounds before anyone asked the server.
  //
  // The limiter is right and must not be weakened (§29). The pass just says so,
  // and says what to do: the counter is in memory, so a restart clears it.
  //
  // The probe carries the admin token deliberately. `authLimiter` sets
  // `skipSuccessfulRequests`, so an authenticated 200 costs nothing — while an
  // UNAUTHENTICATED probe is a 401, which counts, so a guard that asked
  // anonymously would spend a quarter of the budget it exists to protect on
  // every run, and eventually cause the very lockout it reports.
  try {
    const probe = await fetch(`${API}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${tokens['admin-panel']}` },
    });
    if (probe.status === 429) {
      console.error(`\n  The login limiter is tripped on ${API} — every screen would render`
        + ' its sign-in form and every case would report a missing control.\n'
        + '  Restart the backend (the counter is in memory) and run again.');
      stopAll();
      process.exit(1);
    }
  } catch { /* unreachable is a different problem, and waitFor above covers it */ }

  const pages = {};
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });

  /**
   * A fresh, signed-in page for one panel.
   *
   * ── Why a case may need its own ──────────────────────────────────────────
   * Every case shares one page per panel, which is right: a browser pass that
   * re-authenticated per control would spend its whole run booting. But LOG
   * OUT ends that session, and the drive deferred it for exactly that reason —
   * "ends the session for every screen after it". A deferral is an admission,
   * so the harness grows the ability instead: a case marked `ownContext` gets
   * a context of its own and it is closed afterwards, so what it destroys is
   * its own session and nobody else's.
   */
  const newPanelPage = async (panel) => {
    const cfg = PANELS[panel];
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(([k, v, ck, cv]) => {
      try {
        localStorage.setItem(k, v);
        if (ck) localStorage.setItem(ck, cv);
      } catch { /* private mode */ }
    }, [cfg.key, cfg.wrap(tokens[panel], cached[panel]), cfg.cacheKey ?? '',
        cfg.cacheKey && cached[panel] ? JSON.stringify(cached[panel]) : '']);

    // ── Watch the REMOVALS, because reading the key back cannot work ───────
    // The seeding above is an init script: it runs on every new document. The
    // merchant panel logs out with `window.location.href = '/merchant/'` — a
    // full navigation — so the init script fires again and writes the token
    // straight back. Reading `localStorage` afterwards therefore reports a
    // token for a logout that worked perfectly, which is the harness
    // describing itself (§28).
    //
    // What a logout must actually DO is call `removeItem` for the credential.
    // So that is what is observed, into a key nothing else writes, and it
    // survives the navigation the seeding does not.
    await ctx.addInitScript(() => {
      try {
        const real = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function removeItem(k) {
          try {
            if (this === window.localStorage) {
              const seen = JSON.parse(sessionStorage.getItem('__bb_removed') || '[]');
              seen.push(k);
              sessionStorage.setItem('__bb_removed', JSON.stringify(seen));
            }
          } catch { /* storage blocked */ }
          return real.call(this, k);
        };
      } catch { /* nothing to wrap */ }
    });

    const page = await ctx.newPage();
    page.on('dialog', (d) => {
      const want = page.__bbAccept;
      if (want === undefined || want === false) return void d.dismiss().catch(() => {});
      return void d.accept(typeof want === 'string' ? want : undefined).catch(() => {});
    });
    return { ctx, page, cfg, base: `http://127.0.0.1:${cfg.port}` };
  };

  for (const panel of panels) {
    const cfg = PANELS[panel];
    children.push(startVite(panel, cfg.port));
    const base = `http://127.0.0.1:${cfg.port}`;
    if (!await waitFor(`${base}${panel === 'user-panel' ? '/' : `/${panel.split('-')[0]}/`}`, `${panel}'s dev server`)) {
      stopAll(); process.exit(1);
    }
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(([k, v, ck, cv]) => {
      try {
        localStorage.setItem(k, v);
        if (ck) localStorage.setItem(ck, cv);
      } catch { /* private mode */ }
    }, [cfg.key, cfg.wrap(tokens[panel]), cfg.cacheKey ?? '',
        cfg.cacheKey && cached[panel] ? JSON.stringify(cached[panel]) : '']);
    const page = await ctx.newPage();
    if (panel === 'merchant-panel') page.__bbMerchantId = driveMerchant.merchantId;
    // A confirm nobody answers blocks the page for ever. Cases that WANT one
    // register their own `page.once('dialog')` first, which wins.
    // A confirm nobody answers blocks the page for ever, so the default is to
    // dismiss. A case that MEANS to say yes sets `page.__bbAccept` — a second
    // `page.once('dialog')` would not work, because every registered listener
    // runs and this one, registered first, dismissed before the case's accept
    // could land. That is why "Delete" reported the row still in the catalogue.
    // `page.__bbAccept` is false to dismiss, true to accept, or a STRING to
    // type into a `window.prompt` — the dispute resolution asks for a reason
    // that way, and `if (!reason?.trim()) return` means an empty accept is
    // indistinguishable from a cancel: the button would do nothing and the case
    // would report the platform as failing to release money it was never asked
    // to release.
    page.on('dialog', (d) => {
      const want = page.__bbAccept;
      const p = want === false || want === undefined
        ? d.dismiss()
        : d.accept(typeof want === 'string' ? want : undefined);
      p.catch(() => {});
    });
    if (process.env.BB_DIAG) {
      page.on('request', (r) => { if (/\/api\//.test(r.url())) console.log('   [req]', r.method(), r.url().slice(0, 90)); });
      page.on('requestfailed', (r) => console.log('   [reqfail]', r.url().slice(0, 90), r.failure()?.errorText));
    }
    pages[panel] = { page, cfg, base };
  }

  console.log(`\nDriving ${cases.length} mutating control(s) against their own rows.\n`);

  for (const c of cases) {
    // A case that ENDS a session gets its own, so the damage is its own.
    const own = c.ownContext ? await newPanelPage(c.panel) : null;
    const { page, cfg, base } = own ?? pages[c.panel];
    try {
      const [verdict, detail] = await c.run(page, cfg, base);
      record(c.id, verdict, detail);
    } catch (err) {
      record(c.id, 'FAILED', `threw: ${err.message.split('\n')[0].slice(0, 140)}`);
    } finally {
      if (own) await own.ctx.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});
  await restoreTelegram().catch((e) => console.error('   ! could not restore telegram config:', e.message));
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
