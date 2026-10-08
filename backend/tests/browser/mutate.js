// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Press the controls that CHANGE something, against rows this run created.
 *
 * ── Why these were not in the drive pass ───────────────────────────────────
 * `drive.js` presses everything that cannot do harm and DEFERS the rest with a
 * reason: pressing "Approve" on a live payment queue is not a test, it is an
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
 *   node backend/tests/browser/mutate.js games      cases whose id matches
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
import { seedPlayer, seedMerchant, seedTeam, seedAdmin, seedStaff } from '../e2e/seed.js';
import { playerToken, adminToken, merchantToken } from '../e2e/harness.js';
import { db } from '#db';
import { pgQuery } from '#db/client.js';
import { setOnline } from '#db/repositories/merchants.js';
// The order state machine, so the harness ends what it started through the
// same guarded transition the platform uses rather than a raw UPDATE.
import { cancelOrder as cancelOrderState } from '../../domains/payment/orderLifecycle.service.js';
// Every order the platform writes carries its tamper tag, written with the row
// (`createOrderRecord`). A fixture inserted without one is a row production
// cannot produce (§32 S16) — and the player's order routes refuse it.
import { deriveOrderHmac } from '../../middleware/order-crypto-access.js';

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

// ── Scalars, like every other reader here ─────────────────────────────────
// This one returned the ROW while `merchantStatus` and
// `orderState` beside it return a string. A case that treated it like its
// neighbours compared an OBJECT to 'ACTIVE' — true for every object — and
// reported "pressed ONE Block on row 5 and 5 accounts changed". The database
// said one. A finding that size cost a database read to disprove, and the
// cause was one helper that did not match the idiom next to it (§5).
/**
 * Two claimed references, each on a real PAID deposit with its tamper tag, and
 * a REFUSED reuse of the first one from a second order — the signal the
 * Payment References screen exists to show. Claimed through the one registry
 * (`claimUtr`), so the rows are ones production can produce (§32 S16).
 */
async function seedReferences() {
  const player = await seedPlayer({ balancePaise: 0 });
  const merchant = await seedMerchant({ currency: 'INR' });
  const mk = async () => {
    const orderId = rid('UTRO');
    await pgQuery(
      `INSERT INTO order_states
         (order_id, user_id, merchant_id, order_type, state, token_amount_paise, fiat_amount_paise, order_hmac)
       VALUES ($1, $2, $3, 'DEPOSIT', 'PAID', 50000, 50000, $4)`,
      [orderId, player.userId, merchant.merchantId, deriveOrderHmac(orderId)],
    );
    return orderId;
  };
  const digits = () => String(Math.floor(Math.random() * 1e12)).padStart(12, '7');
  const ref = digits(); const bystanderRef = digits();
  await db.utr.claimUtr({ utr: ref, orderId: await mk(), userId: player.userId, amountRupees: 500 });
  await db.utr.claimUtr({ utr: bystanderRef, orderId: await mk(), userId: player.userId, amountRupees: 500 });
  const reuse = await db.utr.claimUtr({ utr: ref, orderId: await mk(), userId: player.userId, amountRupees: 500 });
  if (reuse.ok !== false) {
    throw new Error(`seedReferences: the reuse of ${ref} was not refused (${JSON.stringify(reuse)})`);
  }
  return { ref, bystanderRef };
}

const userStatus = async (userId) => {
  const { rows } = await pgQuery('SELECT status FROM users WHERE user_id = $1', [userId]);
  return rows[0]?.status ?? null;
};
const userBlocked = async (userId) => {
  const { rows } = await pgQuery('SELECT is_blocked FROM users WHERE user_id = $1', [userId]);
  return rows[0]?.is_blocked === true;
};
const merchantStatus = async (merchantId) => {
  const { rows } = await pgQuery('SELECT status FROM merchants WHERE merchant_id = $1', [merchantId]);
  return rows[0]?.status ?? null;
};
const gameExists = async (slug) => {
  const { rows } = await pgQuery('SELECT 1 FROM games WHERE slug = $1', [String(slug)]);
  return rows.length > 0;
};
const isSubAdmin = async (userId) => {
  const { rows } = await pgQuery('SELECT is_sub_admin FROM users WHERE user_id = $1', [userId]);
  return rows[0]?.is_sub_admin === true;
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
/** What a buy credits: the deposit and reserve pockets together, in paise (the split is the policy's). */
const boughtPaise = async (userId) => {
  const b = await db.wallets.getBalancesPaise(userId);
  return Number(b.depositBalance ?? 0) + Number(b.reserveBalance ?? 0);
};
/** One order's state, its pool hold and the decision written on it. */
const orderRow = async (orderId) => {
  const { rows } = await pgQuery(
    `SELECT state, pool_held_paise, dispute_decision, dispute_resolved_by
       FROM order_states WHERE order_id = $1`, [String(orderId)]);
  return rows[0] ? { ...rows[0], pool_held_paise: Number(rows[0].pool_held_paise) } : null;
};
/** Who lost a dispute, from its one writer's table (`disputeFaults.js`). */
const faultParty = async (orderId) => {
  const { rows } = await pgQuery('SELECT party FROM dispute_faults WHERE order_id = $1', [String(orderId)]);
  return rows[0]?.party ?? null;
};

/** One request to the API as one account, answering `{ status, body }`. */
async function call(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Disputed BUYS, made the way production makes them.
 *
 * The two cases this replaces inserted `DISPUTED` rows straight into
 * `order_states`, with no team, no member and no pool hold — rows the platform
 * cannot produce (§32 S16), on a screen deleted in Step 2c. Since 2c a
 * disputed buy is a held order: routed to a member of a working team, its
 * tokens held in that team's pool from the assignment on, and the decision
 * either SPENDS that hold into the player's wallet or RELEASES it to the pool.
 * A fixture without the hold would test a decision that has nothing to move.
 *
 * So each buy goes through the routes a person uses: the player creates it
 * (`POST /api/payment/deposit/create`, the smallest UPI/bank size), the member
 * accepts it, the player marks it paid with a reference, and the player
 * disputes it. The one thing moved by hand is the CLOCK: the dispute route
 * makes a player wait ten minutes after Paid, so `paid_at` is put back past it
 * — the same step the e2e tier takes (s7). The member's rejection path is not
 * used because it needs a proof upload to object storage, which a local run
 * does not have.
 *
 * Routing has to reach THIS team's member and nobody else, so the team is
 * `exclusive` on the UPI/bank rail; the members that took offline are put
 * back by `restore()`, with this team's members taken offline (trap 10).
 */
const BUY_TOKENS = 50000;   // the smallest UPI/bank order size (CLAUDE.md §2, ORDER_SIZES)
async function disputedBuys(n) {
  const { rows: wereOnline } = await pgQuery(
    `SELECT m.merchant_id FROM merchants m
       JOIN team_members tm ON tm.merchant_id = m.merchant_id
       JOIN teams t ON t.team_id = tm.team_id
       JOIN merchants s ON s.merchant_id = t.supervisor_id
      WHERE m.is_online AND s.supervisor_rail = 'UPI_BANK'`);
  const member = await seedMerchant({ currency: 'INR' });
  const team = await seedTeam({ rail: 'UPI_BANK', poolTokens: BUY_TOKENS * n, include: [member], online: [member] });
  const restore = async () => {
    for (const m of team.members) await setOnline(m.merchantId, false).catch(() => {});
    for (const r of wereOnline) await setOnline(r.merchant_id, true).catch(() => {});
  };
  const buys = [];
  try {
    for (let i = 0; i < n; i++) {
      const player = await seedPlayer({ balancePaise: 0 });
      const pT = playerToken(player);
      const made = await call(pT, 'POST', '/api/payment/deposit/create', { tokenAmount: BUY_TOKENS });
      const orderId = made.body?.order?.orderId;
      if (!orderId) throw new Error(`the buy was refused: ${made.status} ${String(made.body?.message ?? '').slice(0, 100)}`);
      buys.push({ orderId, player });
      const placed = await orderRow(orderId);
      const { rows: [who] } = await pgQuery('SELECT merchant_id FROM order_states WHERE order_id = $1', [orderId]);
      if (placed?.state !== 'ASSIGNED' || who?.merchant_id !== member.merchantId) {
        throw new Error(`${orderId} was not routed to this team's member (${placed?.state}, ${who?.merchant_id ?? 'nobody'})`);
      }
      const steps = [
        ['the member accepts', await call(merchantToken(member), 'POST', `/api/merchant/accept/${orderId}`, {})],
        ['the player marks it paid', await call(pT, 'POST', `/api/payment/order/${orderId}/mark-paid`,
          { utrNumber: String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 1000)).padStart(3, '0') })],
      ];
      await pgQuery(`UPDATE order_states SET paid_at = now() - interval '11 minutes' WHERE order_id = $1`, [orderId]);
      steps.push(['the player disputes it', await call(pT, 'POST', `/api/payment/order/${orderId}/dispute`,
        { reason: 'mutating drive: I paid and nothing was credited' })]);
      const refused = steps.find(([, r]) => r.status !== 200);
      if (refused) throw new Error(`${refused[0]}: ${refused[1].status} ${String(refused[1].body?.message ?? '').slice(0, 100)}`);
      const row = await orderRow(orderId);
      if (row?.state !== 'DISPUTED' || row.pool_held_paise !== BUY_TOKENS * 100) {
        throw new Error(`${orderId} is ${row?.state} holding ${row?.pool_held_paise} paise, not a disputed held buy`);
      }
    }
  } catch (e) {
    await endBuys(buys);
    await restore();
    throw e;
  }
  return { member, team, buys, restore };
}

/** A literal for a RegExp: a seeded name is data, not a pattern. */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A supervisor of their own full cash team, members offline — the account
 * `profiles.js`'s `merchant-supervisor` inventories and the drive presses as —
 * and the session a case signs in with (`as`, see `main`). `secondTeam` adds
 * an empty team beside it, through the same writer the Create button calls,
 * for a case that needs a bystander team or a team with room.
 */
async function supervisorSession({ secondTeam = false } = {}) {
  const team = await seedTeam({ rail: 'CASH', online: [], exclusive: false });
  const supervisor = team.supervisor;
  const name = (await db.teams.getTeam(team.teamId)).name;
  let second = null;
  if (secondTeam) {
    const made = await db.teams.createTeam({ supervisorId: supervisor.merchantId, name: rid('drive-empty') });
    if (!made.ok) throw new Error(`supervisorSession: the second team was refused: ${made.reason}`);
    second = made.teamId;
  }
  return {
    token: merchantToken(supervisor),
    // A returning merchant has a cached profile besides a token (see main).
    cached: {
      id: supervisor.merchantId, merchantId: supervisor.merchantId, username: supervisor.username,
      email: supervisor.email, mobile: supervisor.mobile, isOnline: false, status: 'ACTIVE',
      acceptedCurrencies: ['INR'],
    },
    supervisor, team: { ...team, name }, second,
  };
}

/**
 * End whatever of these buys is still live, through the state machine and the
 * pool's one owner — never a DELETE: `order_transitions` is append-only and
 * holds an FK to the order (see `merchant/orders/accept-a-later-card`).
 */
async function endBuys(buys) {
  for (const { orderId } of buys) {
    await cancelOrderState(orderId, {
      expectFrom: ['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID', 'DISPUTED'],
      set: { cancelReason: 'HARNESS_CLEANUP', cancelledAt: new Date() },
      actor: 'drive-fixture', reason: 'harness cleanup',
    }).catch(() => {});
    await db.teamPools.releaseBuyHold(orderId, { actor: 'drive-fixture', reason: 'harness cleanup' }).catch(() => {});
  }
}

/**
 * Open a dispute in the Dispute Manager and decide it the way an admin does:
 * its card's "View Chat + Resolve", the Resolve tab, a decision, notes, and
 * "Decide dispute". Answers what the screen showed on the way, because a
 * decision the admin could not reach is a different finding from one that
 * moved the wrong money.
 *
 * The dispute must be on the screen an admin ARRIVES at. Until 2g's harness
 * pass it was not: the default view asked the queue for orders in state 'all'
 * and listed nothing, and these cases had to switch the filter to "Open" to
 * find their own dispute. A card missing on arrival is now a failure of the
 * screen (`missingOnArrival`), not a step to work around.
 *
 * `note` is what the Resolve tab says the chosen decision will do to whoever
 * loses — the server's answer (`suspendsIfTo…`), which the dialog read from a
 * detail view that did not carry it, so it said "Nobody is suspended" on every
 * dispute.
 */
async function decideOnScreen(page, cfg, base, orderId, decision) {
  await go(page, cfg, base, '/disputes');
  const cardFor = () => page.locator('div')
    .filter({ hasText: orderId })
    .filter({ has: page.getByRole('button', { name: /View Chat \+ Resolve/i }) })
    .last();
  // What a person arriving sees first: the default filter, untouched.
  if (await cardFor().count() === 0) {
    const routed = await page.locator('main').innerText().catch(() => '(no <main>)');
    return {
      ok: false, missingOnArrival: true,
      why: `no card for ${orderId} on the Dispute Manager as it opens — routed region: ${routed.replace(/\s+/g, ' ').slice(0, 180)}`,
    };
  }
  const open = cardFor().getByRole('button', { name: /View Chat \+ Resolve/i }).first();
  await open.click({ timeout: 8000 });
  await settle(page, 6000);
  const dialog = page.locator('[role="dialog"]').last();
  if (!(await dialog.isVisible().catch(() => false))) return { ok: false, why: 'View Chat + Resolve opened no dialog' };
  await dialog.getByRole('button', { name: /^\s*Resolve\s*$/i }).first().click({ timeout: 8000 });
  await settle(page, 2000);
  await dialog.locator('#decision').selectOption(decision);
  await dialog.locator('#resolution-notes').fill(`mutating drive: ${decision}`);
  const note = (await dialog.getByRole('note').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const decide = dialog.getByRole('button', { name: /Decide dispute/i }).first();
  if (await decide.isDisabled()) return { ok: false, why: '"Decide dispute" stayed disabled with notes typed' };
  const answered = page.waitForResponse(
    (r) => r.url().includes(`/dispute-orders/${orderId}/resolve`) && r.request().method() === 'POST',
    { timeout: 15000 },
  ).catch(() => null);
  await decide.click({ timeout: 8000 });
  const reply = await answered;
  await settle(page, 8000);
  const said = reply ? `${reply.status()} ${(await reply.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120)}` : 'no request left the panel';
  // Without a reload: the queue must have learned what it just did (§31).
  const stillOffered = await cardFor().count() > 0;
  return { ok: true, said, note, stillOffered };
}


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
        // a versioned policy wants the justification recorded against the
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
      if (after !== 'BLOCKED') return ['FAILED', `status is ${after}, not BLOCKED`];
      if (neighbour === 'BLOCKED') return ['FAILED', 'the BYSTANDER was blocked too'];

      // The screen, without a reload: a server that changed and a panel that
      // did not is half a feature.
      const said = await words(page);
      if (!/blocked/i.test(said)) return ['FAILED', 'server blocked them; the screen never said so'];
      return ['DROVE', `${target.userId} BLOCKED, bystander still ${neighbour}`];
    },
  },

  // ── Closing an account (the Delete Account control, 2026-10-01) ───────────
  {
    id: 'admin/users/delete',
    panel: 'admin-panel',
    what: 'Close a player account from the users list',
    async run(page, cfg, base) {
      const target = await seedPlayer({ balancePaise: 0 });
      const bystander = await seedPlayer({ balancePaise: 0 });

      await go(page, cfg, base, '/users');
      if (!await search(page, target.userId)) return ['NOT DRIVEN', 'no search box on /users'];
      const row = await rowFor(page, target.userId);
      if (!row) return ['NOT DRIVEN', `seeded player ${target.userId} never appeared in the table`];

      const hit = await pressInRow(row, 'Delete Account');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 4000);
      const answered = await confirmWith(page, 'Delete');
      if (answered === 'stuck') return ['FAILED', 'the Delete confirmation could not be pressed'];
      if (answered === 'none') return ['FAILED', 'Delete Account raised no confirmation'];

      const after = await userStatus(target.userId);
      const neighbour = await userStatus(bystander.userId);
      if (after !== 'DELETED') return ['FAILED', `status is ${after}, not DELETED`];
      if (neighbour === 'DELETED') return ['FAILED', 'the BYSTANDER was deleted too'];
      // Closed means closed: the deleted player's own session is refused.
      const me = await fetch(`${API}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${playerToken(target)}` } });
      if (me.status !== 403) return ['FAILED', `deleted, but their session still answers ${me.status} on /me`];
      if (!/account closed/i.test(await words(page))) return ['FAILED', 'server closed it; the screen never said so'];
      return ['DROVE', `${target.userId} DELETED and its session refused (403); bystander still ${neighbour}`];
    },
  },

  // ── Payment references (the canManageUtr screen, 2026-10-01) ──────────────
  {
    id: 'admin/utr/flag',
    panel: 'admin-panel',
    what: 'Flag a reused payment reference as fraud',
    async run(page, cfg, base) {
      const { ref, bystanderRef } = await seedReferences();

      await go(page, cfg, base, '/payment-references');
      const typed = await fill(page, '#utr-lookup', ref.toLowerCase());
      if (!typed.ok) return ['NOT DRIVEN', typed.why];
      const look = page.getByRole('button', { name: /^\s*Look up\s*$/i }).first();
      if (await look.count() === 0) return ['NOT DRIVEN', 'no Look up button'];
      await look.click({ timeout: 8000 });
      await settle(page, 6000);

      const reason = await fill(page, '#utr-flag-reason', 'mutating drive: same slip quoted twice');
      if (!reason.ok) return ['FAILED', `looked ${ref} up; no flag form appeared — ${reason.why}`];
      const flag = page.getByRole('button', { name: /Flag as fraud/i }).first();
      if (await flag.isDisabled()) return ['FAILED', 'Flag as fraud stayed disabled with a reason typed'];
      await flag.click({ timeout: 8000 });
      await settle(page, 6000);

      const after = await db.utr.getUtr(ref);
      const neighbour = await db.utr.getUtr(bystanderRef);
      if (after?.status !== 'FRAUD') return ['FAILED', `status is ${after?.status}, not FRAUD`];
      if (after.flagReason !== 'mutating drive: same slip quoted twice') return ['FAILED', `reason stored as '${after.flagReason}'`];
      if (neighbour?.status !== 'ACTIVE') return ['FAILED', `the BYSTANDER reference is ${neighbour?.status}`];
      if (await page.getByRole('button', { name: /Clear the flag/i }).count() === 0) {
        return ['FAILED', 'server flagged it; the screen still offers Flag'];
      }
      return ['DROVE', `${ref} FRAUD with its reason, flagged by ${after.flaggedBy}; bystander ACTIVE`];
    },
  },
  {
    id: 'admin/utr/clear',
    panel: 'admin-panel',
    what: 'Clear a fraud flag on a payment reference',
    async run(page, cfg, base) {
      const { ref, bystanderRef } = await seedReferences();
      await db.utr.flagFraud(ref, { actor: 'mutating-drive', reason: 'seeded flag' });
      await db.utr.flagFraud(bystanderRef, { actor: 'mutating-drive', reason: 'seeded bystander flag' });

      await go(page, cfg, base, '/payment-references');
      const typed = await fill(page, '#utr-lookup', ref);
      if (!typed.ok) return ['NOT DRIVEN', typed.why];
      await page.getByRole('button', { name: /^\s*Look up\s*$/i }).first().click({ timeout: 8000 });
      await settle(page, 6000);
      const clear = page.getByRole('button', { name: /Clear the flag/i }).first();
      if (await clear.count() === 0) return ['FAILED', `looked up a FRAUD reference; no Clear the flag button`];
      await clear.click({ timeout: 8000 });
      await settle(page, 6000);

      const after = await db.utr.getUtr(ref);
      const neighbour = await db.utr.getUtr(bystanderRef);
      if (after?.status !== 'ACTIVE') return ['FAILED', `status is ${after?.status}, not ACTIVE`];
      if (neighbour?.status !== 'FRAUD') return ['FAILED', `the BYSTANDER flag was lifted too (${neighbour?.status})`];
      if (!/flag cleared/i.test(await words(page))) return ['FAILED', 'server cleared it; the screen never said so'];
      return ['DROVE', `${ref} back to ACTIVE; bystander still FRAUD`];
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
      const target = await seedMerchant({ currency: 'INR' });
      const bystander = await seedMerchant({ currency: 'INR' });

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


  // ── Taking staff access away ─────────────────────────────────────────────
  {
    id: 'admin/sub-admins/remove',
    panel: 'admin-panel',
    what: 'Remove a sub-admin',
    async run(page, cfg, base) {
      // STAFF accounts, made the way the Sub-admins screen makes them. This
      // wrote `is_sub_admin` onto two PLAYER rows, which the database refuses
      // since 2026-10-01 (`users_staff_flags_need_staff`, seedStaff).
      const target = await seedStaff({ subAdmin: true, permissions: { canViewAnalytics: true } });
      const bystander = await seedStaff({ subAdmin: true, permissions: { canViewAnalytics: true } });

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


  // ── Money: an admin decides a disputed buy (Dispute Manager) ─────────────
  // These were `admin/payment-control/release` and `/refund`, which opened
  // `/payment-control` — a screen deleted in Step 2c — and pressed its
  // "Release to User" / "Refund to Merchant" on rows inserted straight into
  // `order_states`. What owns the decision now is `/disputes`
  // (DisputeManager.tsx → `POST /api/admin/dispute-orders/:id/resolve`), and
  // a disputed buy now carries its team's pool hold, so each case decides a
  // real held buy (`disputedBuys`) and reads both sides of the money back.
  {
    id: 'admin/disputes/decide-for-player',
    panel: 'admin-panel',
    what: 'Decide a disputed buy for the player: the team pool\'s hold is spent into the player\'s wallet',
    async run(page, cfg, base) {
      const fx = await disputedBuys(2);
      const [mine, theirs] = fx.buys;
      try {
        const playerBefore = await boughtPaise(mine.player.userId);
        const poolBefore = await db.teamPools.getPool(fx.team.teamId);
        const pressed = await decideOnScreen(page, cfg, base, mine.orderId, 'RELEASE_TO_USER');
        if (!pressed.ok) return [pressed.missingOnArrival ? 'FAILED' : 'NOT DRIVEN', pressed.why];

        const row = await orderRow(mine.orderId);
        const credited = (await boughtPaise(mine.player.userId)) - playerBefore;
        const poolAfter = await db.teamPools.getPool(fx.team.teamId);
        const spent = poolBefore.heldPaise - poolAfter.heldPaise;
        const neighbour = await orderRow(theirs.orderId);
        // The member was shown a reference: deciding for the player is the
        // member's loss, and the dialog must have said so before the press.
        if (!/team member on this order will be suspended/i.test(pressed.note)) {
          return ['FAILED', `before deciding for the player the dialog said "${pressed.note}" — the member is the one suspended`];
        }
        if (row?.state !== 'COMPLETED' || row.dispute_decision !== 'RELEASE_TO_USER') {
          return ['FAILED', `pressed Decide dispute; ${mine.orderId} is ${row?.state} / ${row?.dispute_decision ?? 'no decision'} — ${pressed.said}`];
        }
        if (credited !== BUY_TOKENS * 100) return ['FAILED', `the player was credited ${credited} paise, expected ${BUY_TOKENS * 100}`];
        if (spent !== BUY_TOKENS * 100 || poolAfter.availablePaise !== poolBefore.availablePaise) {
          return ['FAILED', `the pool's hold fell by ${spent} paise (available ${poolBefore.availablePaise} → ${poolAfter.availablePaise}); expected exactly one buy's hold spent`];
        }
        if (neighbour?.state !== 'DISPUTED' || neighbour.pool_held_paise !== BUY_TOKENS * 100
            || (await boughtPaise(theirs.player.userId)) !== 0) {
          return ['FAILED', `the BYSTANDER dispute moved: ${theirs.orderId} is ${neighbour?.state} holding ${neighbour?.pool_held_paise}`];
        }
        const party = await faultParty(mine.orderId);
        if (party !== 'MERCHANT') return ['FAILED', `the member was shown a reference and lost; the fault row says ${party ?? 'nobody'}`];
        if (pressed.stillOffered) return ['FAILED', 'decided, and the queue still offers "View Chat + Resolve" for it without a reload'];
        return ['DROVE', `${mine.orderId} COMPLETED: player +${credited / 100} tokens, team pool hold −${spent / 100}, `
          + 'fault MERCHANT as the dialog warned; listed on arrival; the bystander dispute untouched'];
      } finally {
        await endBuys(fx.buys);
        await fx.restore();
      }
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
    id: 'admin/disputes/decide-for-team',
    panel: 'admin-panel',
    what: 'Decide a disputed buy for the team: the hold goes back to the pool, the player gets nothing',
    async run(page, cfg, base) {
      const fx = await disputedBuys(2);
      const [mine, theirs] = fx.buys;
      try {
        const poolBefore = await db.teamPools.getPool(fx.team.teamId);
        const pressed = await decideOnScreen(page, cfg, base, mine.orderId, 'RELEASE_TO_MERCHANT');
        if (!pressed.ok) return [pressed.missingOnArrival ? 'FAILED' : 'NOT DRIVEN', pressed.why];

        const row = await orderRow(mine.orderId);
        const poolAfter = await db.teamPools.getPool(fx.team.teamId);
        const neighbour = await orderRow(theirs.orderId);
        if (!/player will be suspended/i.test(pressed.note)) {
          return ['FAILED', `before deciding for the team the dialog said "${pressed.note}" — the player is the one suspended`];
        }
        if (row?.state !== 'CANCELLED' || row.dispute_decision !== 'RELEASE_TO_MERCHANT') {
          return ['FAILED', `pressed Decide dispute; ${mine.orderId} is ${row?.state} / ${row?.dispute_decision ?? 'no decision'} — ${pressed.said}`];
        }
        // The mirror of the release: the player must NOT be credited, and the
        // hold must come back as available tokens, not vanish.
        if ((await boughtPaise(mine.player.userId)) !== 0) return ['FAILED', 'a decision for the TEAM credited the player'];
        if (row.pool_held_paise !== 0
            || poolBefore.heldPaise - poolAfter.heldPaise !== BUY_TOKENS * 100
            || poolAfter.availablePaise - poolBefore.availablePaise !== BUY_TOKENS * 100) {
          return ['FAILED', `the hold did not return to the pool: held ${poolBefore.heldPaise} → ${poolAfter.heldPaise}, `
            + `available ${poolBefore.availablePaise} → ${poolAfter.availablePaise}, order still holds ${row.pool_held_paise}`];
        }
        if (neighbour?.state !== 'DISPUTED' || neighbour.pool_held_paise !== BUY_TOKENS * 100) {
          return ['FAILED', `the BYSTANDER dispute moved: ${theirs.orderId} is ${neighbour?.state} holding ${neighbour?.pool_held_paise}`];
        }
        const party = await faultParty(mine.orderId);
        if (party !== 'PLAYER') return ['FAILED', `the player's claim was refused; the fault row says ${party ?? 'nobody'}`];
        if (pressed.stillOffered) return ['FAILED', 'decided, and the queue still offers "View Chat + Resolve" for it without a reload'];
        // Where an admin looks for it afterwards: "Closed", one of the filters
        // the queue sends, with the decision on its card. The card drew the
        // decision only for status 'RESOLVED', which no order is ever in.
        const filter = page.getByLabel('Filter disputes by status');
        if (await filter.count() === 0) return ['FAILED', 'decided, and the Dispute Manager offers no filter to find it under'];
        await filter.selectOption('CLOSED');
        await settle(page, 8000);
        const closed = page.locator('div').filter({ hasText: mine.orderId }).filter({ hasText: /Decision:/ }).last();
        const card = await closed.count() ? (await closed.innerText()).replace(/\s+/g, ' ') : '';
        if (!/Decision: RELEASE TO MERCHANT/.test(card)) {
          const routed = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
          return ['FAILED', `under "Closed" ${mine.orderId} shows no decision — ${card || routed}`];
        }
        return ['DROVE', `${mine.orderId} CANCELLED: hold of ${BUY_TOKENS} tokens back to the pool, player not credited, `
          + 'fault PLAYER as the dialog warned; listed on arrival, and under "Closed" with its decision; the bystander dispute untouched'];
      } finally {
        await endBuys(fx.buys);
        await fx.restore();
      }
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
      // ── PUT THE TRADING FLAGS BACK. Trap 10, on a ROW and not a config ───
      // This flips whatever switch is first on the screen, and the first
      // switch is "accept buy orders". It left the drive merchant with
      // `accepts_deposits = false` for every case that ran after it, and the
      // order-row case below then failed on "Merchant is not enabled for buy
      // orders." — the platform refusing exactly as it should, reported as a
      // defect. The restore is a `finally`, so it runs on the failing path
      // too: a restore that only runs when the case passed is the one that
      // matters least.
      const flagsBefore = (await pgQuery(
        'SELECT accepts_deposits AS d, accepts_withdrawals AS w FROM merchants WHERE merchant_id = $1',
        [page.__bbMerchantId],
      )).rows[0];
      try {
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
      } finally {
        await pgQuery(
          'UPDATE merchants SET accepts_deposits = $2, accepts_withdrawals = $3 WHERE merchant_id = $1',
          [page.__bbMerchantId, flagsBefore?.d ?? true, flagsBefore?.w ?? true],
        ).catch(() => {});
      }
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

  // ══════════════════════════════════════════════════════════════════════
  // IS THE FIRST INSTANCE REPRESENTATIVE?
  //
  // 574 controls come back REPEAT — a repeat of a name already pressed on
  // that screen. Pressing all 574 is not the answer; the ASSUMPTION is, and
  // the assumption is that row 40's button acts on row 40.
  //
  // §23 is this codebase's own record of that assumption failing: the (since
  // removed) KYC screen's `find(u => u._id === selectedId)` matched the FIRST row every
  // time, so a reviewer clicking the fifth player read the first player's
  // record — and approving grants withdrawal access. Every check was green.
  //
  // So these cases do the one thing that tests it: seed SEVERAL, do NOT
  // search (searching narrows to one row and destroys the question), press a
  // control on a row that is NOT the first, and assert the entity that moved
  // is the one whose row was pressed — and that the first row did not move.
  // ══════════════════════════════════════════════════════════════════════

  {
    id: 'admin/users/block-a-later-row',
    panel: 'admin-panel',
    what: 'Block from a row that is NOT the first — does the press hit its own row?',
    async run(page, cfg, base) {
      // Five, so "the last one" is unambiguously not "the first one".
      const seeded = [];
      for (let i = 0; i < 5; i++) seeded.push(await seedPlayer({ balancePaise: 10000 }));

      await go(page, cfg, base, '/users');
      await settle(page, 8000);

      // No search. A filtered table has one row and cannot answer the
      // question this case exists to ask.
      const rows = page.locator('tbody tr');
      const total = await rows.count();
      if (total < 3) return ['NOT DRIVEN', `only ${total} row(s) rendered — too few to tell a later row from the first`];

      // ── Which seeded player landed on a LATER row ───────────────────────
      // The list sorts newest first, so the last one seeded renders as row 1 —
      // picking it by seeding order asks the question of the wrong row. Read
      // the actual positions and take one that is genuinely not first.
      const positions = await page.evaluate((ids) => {
        const trs = [...document.querySelectorAll('tbody tr')].map((tr) => tr.innerText || '');
        return ids.map((id) => trs.findIndex((t) => t.includes(id)));
      }, seeded.map((u) => u.userId));

      let index = -1;
      let target = null;
      for (let i = 0; i < seeded.length; i++) {
        if (positions[i] > 0 && (index === -1 || positions[i] > index)) {
          index = positions[i]; target = seeded[i];
        }
      }
      if (!target) {
        return ['NOT DRIVEN', `none of the 5 seeded players rendered below row 1 (positions ${positions.join(', ')})`];
      }
      const row = page.locator('tbody tr', { hasText: target.userId }).first();
      if (await row.count() === 0) return ['NOT DRIVEN', `${target.userId} left the table between reads`];

      const hit = await pressInRow(row, 'Block');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 6000);
      await confirmWith(page, 'Block');

      // ── `userStatus` returns the ROW, not a string ──────────────────────
      // Comparing it to 'ACTIVE' is true for every object, so the first draft
      // reported "pressed ONE Block on row 5 and 5 accounts changed" — a
      // finding that would have been enormous if it were real. The database
      // said one row was blocked. Read the COLUMN, not the object.
      const after = await Promise.all(seeded.map((u) => userBlocked(u.userId)));
      const moved = seeded.filter((u, i) => after[i]).map((u) => u.userId);

      if (moved.length === 0) {
        return ['FAILED', `pressed Block on row ${index + 1} and NOBODY is blocked`];
      }
      if (moved.length > 1) {
        return ['FAILED', `pressed ONE Block on row ${index + 1} and ${moved.length} accounts changed: ${moved.join(', ')}`];
      }
      if (moved[0] !== target.userId) {
        return ['FAILED', `pressed Block on row ${index + 1} (${target.userId})`
          + ` and it blocked ${moved[0]} instead — the row's control is not bound to its row (§23)`];
      }
      return ['DROVE', `row ${index + 1} of ${total}: blocked ${target.userId} and nobody else — the repeat assumption holds here`];
    },
  },


  {
    id: 'admin/merchants/suspend-a-later-row',
    panel: 'admin-panel',
    what: 'Suspend from a row that is NOT the first',
    async run(page, cfg, base) {
      const seeded = [];
      for (let i = 0; i < 4; i++) {
        seeded.push(await seedMerchant({ currency: 'INR', approve: true, online: false }));
      }
      await go(page, cfg, base, '/merchants');
      await settle(page, 8000);

      const positions = await page.evaluate((names) => {
        const trs = [...document.querySelectorAll('tbody tr')].map((tr) => tr.innerText || '');
        return names.map((nm) => trs.findIndex((t) => t.includes(nm)));
      }, seeded.map((m) => m.username));

      let index = -1; let target = null;
      for (let i = 0; i < seeded.length; i++) {
        if (positions[i] > 0 && positions[i] > index) { index = positions[i]; target = seeded[i]; }
      }
      if (!target) return ['NOT DRIVEN', `no seeded merchant rendered below row 1 (positions ${positions.join(', ')})`];

      const total = await page.locator('tbody tr').count();
      const row = page.locator('tbody tr', { hasText: target.username }).first();
      const hit = await pressInRow(row, 'Suspend');
      if (!hit.ok) return ['NOT DRIVEN', hit.why];
      await settle(page, 6000);
      await confirmWith(page, 'Suspend');

      const after = await Promise.all(seeded.map((m) => merchantStatus(m.merchantId)));
      const moved = seeded.filter((m, i) => after[i] === 'SUSPENDED').map((m) => m.username);
      if (moved.length === 0) return ['FAILED', `pressed Suspend on row ${index + 1} and nobody is SUSPENDED`];
      if (moved.length > 1) return ['FAILED', `ONE Suspend and ${moved.length} merchants moved: ${moved.join(', ')}`];
      if (moved[0] !== target.username) {
        return ['FAILED', `pressed Suspend on row ${index + 1} (${target.username})`
          + ` and it suspended ${moved[0]} instead — the row's control is not bound to its row (§23)`];
      }
      return ['DROVE', `row ${index + 1} of ${total}: suspended ${target.username} and nobody else`];
    },
  },

  {
    id: 'admin/games/delete-a-later-row',
    panel: 'admin-panel',
    what: 'Delete a game from a row that is NOT the first',
    async run(page, cfg, base) {
      // Named so they sort together and land next to each other in the list.
      const mine = [];
      for (let i = 0; i < 4; i++) mine.push(rid('DriveRow'));
      for (const name of mine) {
        await pgQuery(
          `INSERT INTO games (slug, name, status, sort_order)
           VALUES ($1, $1, 'INACTIVE', 999) ON CONFLICT (slug) DO NOTHING`, [name],
        );
      }
      try {
        await go(page, cfg, base, '/games');
        await settle(page, 8000);

        // Which of mine is rendered below the first of mine — the question is
        // "does a later DELETE hit its own row", not "is it row 1 of the page".
        const order = await page.evaluate((names) => {
          const btns = [...document.querySelectorAll('button')]
            .map((b) => b.getAttribute('aria-label') || b.title || '');
          return names.map((nm) => btns.findIndex((t) => t.includes(`Delete ${nm}`)));
        }, mine);

        let index = -1; let target = null;
        const first = Math.min(...order.filter((i) => i >= 0));
        for (let i = 0; i < mine.length; i++) {
          if (order[i] > first && order[i] > index) { index = order[i]; target = mine[i]; }
        }
        if (!target) return ['NOT DRIVEN', `the seeded games did not render as separate rows (${order.join(', ')})`];

        const button = page.getByRole('button', { name: new RegExp(`Delete ${target}`, 'i') }).first();
        page.__bbAccept = true;
        try {
          await clickThrough(button, { timeout: 8000 });
          await settle(page, 6000);
          const said = await confirmWith(page, 'Delete');
          if (String(said).startsWith('unanswered')) return ['FAILED', `the confirmation was not answered — ${said}`];
        } finally { page.__bbAccept = false; }

        const still = await Promise.all(mine.map((n) => gameExists(n)));
        const gone = mine.filter((n, i) => !still[i]);
        if (gone.length === 0) return ['FAILED', `deleted the ${index}th Delete control and every game is still there`];
        if (gone.length > 1) return ['FAILED', `ONE Delete and ${gone.length} games went: ${gone.join(', ')}`];
        if (gone[0] !== target) {
          return ['FAILED', `pressed Delete for ${target} and ${gone[0]} was deleted instead (§23)`];
        }
        return ['DROVE', `a later Delete removed ${target} and left the other ${mine.length - 1} alone`];
      } finally {
        await pgQuery('DELETE FROM games WHERE slug = ANY($1::text[])', [mine]).catch(() => {});
      }
    },
  },

  {
    id: 'admin/game-providers/delete-a-later-row',
    panel: 'admin-panel',
    what: 'Delete a provider from a row that is NOT the first',
    async run(page, cfg, base) {
      const mine = [];
      for (let i = 0; i < 4; i++) mine.push(rid('driverow').toLowerCase());
      for (const key of mine) {
        await pgQuery(
          `INSERT INTO game_providers (provider_key, name, enabled)
           VALUES ($1, $1, FALSE) ON CONFLICT (provider_key) DO NOTHING`, [key],
        );
      }
      try {
        await go(page, cfg, base, '/game-providers');
        await settle(page, 8000);

        const order = await page.evaluate((keys) => {
          const btns = [...document.querySelectorAll('button')]
            .map((b) => b.getAttribute('aria-label') || b.title || b.innerText || '');
          return keys.map((k) => btns.findIndex((t) => new RegExp(`Delete\\s+${k}`, 'i').test(t)));
        }, mine);

        const present = order.filter((i) => i >= 0);
        if (present.length < 2) {
          return ['NOT DRIVEN', `only ${present.length} of the seeded providers rendered a Delete control`];
        }
        const first = Math.min(...present);
        let index = -1; let target = null;
        for (let i = 0; i < mine.length; i++) {
          if (order[i] > first && order[i] > index) { index = order[i]; target = mine[i]; }
        }
        if (!target) return ['NOT DRIVEN', `the seeded providers did not render as separate rows (${order.join(', ')})`];

        const button = page.getByRole('button', { name: new RegExp(`Delete\\s+${target}`, 'i') }).first();
        page.__bbAccept = true;
        try {
          await clickThrough(button, { timeout: 8000 });
          await settle(page, 6000);
          const said = await confirmWith(page, 'Delete');
          if (String(said).startsWith('unanswered')) return ['FAILED', `the confirmation was not answered — ${said}`];
        } finally { page.__bbAccept = false; }

        const still = await Promise.all(mine.map((k) => providerExists(k)));
        const gone = mine.filter((k, i) => !still[i]);
        if (gone.length === 0) return ['FAILED', 'pressed a later Delete and every provider is still there'];
        if (gone.length > 1) return ['FAILED', `ONE Delete and ${gone.length} providers went: ${gone.join(', ')}`];
        if (gone[0] !== target) {
          return ['FAILED', `pressed Delete for ${target} and ${gone[0]} was deleted instead (§23)`];
        }
        return ['DROVE', `a later Delete removed ${target} and left the other ${mine.length - 1} alone`];
      } finally {
        await pgQuery('DELETE FROM game_providers WHERE provider_key = ANY($1::text[])', [mine]).catch(() => {});
      }
    },
  },

  // ── The last control the drive still ASKS about ──────────────────────────
  {
    id: 'admin/support-assistant/re-ingest',
    panel: 'admin-panel',
    what: "Re-ingest the platform's own knowledge base",
    async run(page, cfg, base) {
      await go(page, cfg, base, '/support-assistant');
      const button = page.getByRole('button', { name: /Re-ingest/i }).first();
      if (await button.count() === 0) return ['NOT DRIVEN', 'no Re-ingest control on /support-assistant'];

      // This is the one the drive leaves as ASKED: it raises a confirm, and a
      // pass that answers a question it has not read is worse than one that
      // declines. Here it is read and answered.
      page.__bbAccept = true;
      let answered = 'none';
      try {
        await clickThrough(button, { timeout: 8000 });
        await settle(page, 4000);
        answered = await confirmWith(page, 'Re-ingest');
      } finally { page.__bbAccept = false; }
      if (String(answered).startsWith('unanswered')) {
        return ['FAILED', `the confirmation could not be answered — ${answered}`];
      }
      await settle(page, 10000);

      // ── Either outcome is correct, and SILENCE is not ────────────────────
      // pgvector is optional on this server (`applySchema` warns when it is
      // absent), so the honest answers are "ingested N passages" or a refusal
      // that NAMES the missing extension — §25's rule. What must not happen is
      // a press that reports nothing either way.
      const said = await words(page);
      const tail = said.slice(-500);
      if (/pgvector|extension|not available|unavailable/i.test(tail)) {
        return ['DROVE', 'refused by name — the screen explains pgvector is missing and what to install'];
      }
      if (/ingest|passage|document|indexed|updated|success/i.test(tail)) {
        return ['DROVE', `re-ingest ran and the screen reported it — "${tail.replace(/\s+/g, ' ').slice(-110)}"`];
      }
      return ['FAILED', `pressed Re-ingest and the screen said neither a count nor a reason: ${tail.slice(-140)}`];
    },
  },

  {
    id: 'merchant/orders/accept-a-later-card',
    panel: 'merchant-panel',
    what: 'Accept an order from a card that is NOT the first — the merchant side of §23',
    async run(page, cfg, base) {
      // ── THREE ASSIGNED orders has to be a state the platform can produce ──
      // So the platform produces them. Each is a real 20,000-token buy through
      // `POST /api/payment/deposit/create`, which routes it (Step 2c) to a
      // member of a working UPI/bank team and HOLDS its tokens in that team's
      // pool in the same transaction. `main()` put the drive merchant in such a
      // team with a pool, as the only member online on the rail, and the rail's
      // cap is three — so all three land on this merchant's queue, each with
      // its hold, and none is a row assignment itself would never write
      // (§32 S16). Inserting ASSIGNED rows and bolting a hold on afterwards was
      // the old version, and it was the shape the cron sweeps shout about.
      //
      // Online is ESTABLISHED, not trusted (§32 S19): a case before this one
      // may have taken the merchant offline.
      await setOnline(page.__bbMerchantId, true);
      const made = [];
      const refused = [];
      for (let i = 0; i < 3; i++) {
        const player = await seedPlayer({});
        const res = await fetch(`${API}/api/payment/deposit/create`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${playerToken(player)}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenAmount: 50000 }), // the smallest UPI/bank size (2d)
        });
        const body = await res.json().catch(() => ({}));
        if (body.order?.orderId) made.push(body.order.orderId);
        else refused.push(`${res.status} ${String(body.message ?? '').slice(0, 80)}`);
      }
      const placed = (await pgQuery(
        'SELECT order_id, state, merchant_id FROM order_states WHERE order_id = ANY($1::text[])', [made],
      )).rows;
      const notOurs = placed.filter((r) => r.state !== 'ASSIGNED' || r.merchant_id !== page.__bbMerchantId);
      try {
        // Routing that did not reach this merchant means the fixture is not the
        // state the case is about; driving on would test something else.
        if (refused.length || notOurs.length || placed.length !== 3) {
          return ['NOT DRIVEN', `the three buys did not all reach the drive merchant — refused [${refused.join('; ')}],`
            + ` elsewhere [${notOurs.map((r) => `${r.order_id} ${r.state} ${r.merchant_id ?? 'nobody'}`).join('; ')}]`];
        }
        await go(page, cfg, base, '/orders');
        await settle(page, 8000);

        // Where each of mine rendered, by the order id printed on its card.
        const order = await page.evaluate((ids) => {
          const text = document.body.innerText || '';
          return ids.map((id) => text.indexOf(id));
        }, made);
        const present = order.filter((i) => i >= 0);
        if (present.length < 2) {
          return ['NOT DRIVEN', `only ${present.length} of the 3 seeded orders are on the queue`];
        }
        const first = Math.min(...present);
        let at = -1; let target = null;
        for (let i = 0; i < made.length; i++) {
          if (order[i] > first && order[i] > at) { at = order[i]; target = made[i]; }
        }
        if (!target) return ['NOT DRIVEN', 'the seeded orders did not render as separate cards'];

        // The card that HOLDS my order id, not merely an element mentioning it.
        const card = page.locator('div', { hasText: target })
          .filter({ has: page.getByRole('button', { name: /Accept order/i }) }).last();
        if (await card.count() === 0) {
          const n = await page.getByRole('button', { name: /Accept order/i }).count();
          return ['NOT DRIVEN', `${target} has no card with an Accept among the ${n} on screen`];
        }
        const accept = card.getByRole('button', { name: /Accept order/i }).first();
        // Read the ANSWER, not the toast — `run()` raises one and it fades.
        const answered = page.waitForResponse(
          (r) => /accept/i.test(r.url()) && r.request().method() !== 'GET',
          { timeout: 15000 },
        ).catch(() => null);
        const hit = await clickThrough(accept, { timeout: 8000 });
        if (!hit.ok) return ['NOT DRIVEN', `Accept could not be pressed: ${hit.why}`];
        const reply = await answered;
        await settle(page, 8000);
        await confirmWith(page, 'Accept');
        const said = reply
          ? `${reply.status()} ${(await reply.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140)}`
          : 'no request left the panel';

        const after = await Promise.all(made.map((id) => orderState(id)));
        const moved = made.filter((id, i) => after[i] !== 'ASSIGNED');
        if (moved.length === 0) {
          return ['FAILED', `pressed Accept on a later card and every order is still ASSIGNED — ${said}`];
        }
        if (moved.length > 1) {
          return ['FAILED', `ONE Accept and ${moved.length} orders moved: ${moved.join(', ')}`];
        }
        if (moved[0] !== target) {
          return ['FAILED', `pressed Accept on ${target}'s card and ${moved[0]} was accepted instead (§23)`
            + ' — a merchant would have taken on an order they did not choose'];
        }
        return ['DROVE', `a later card accepted ${target} (now ${after[made.indexOf(target)]}) and left the other 2 ASSIGNED`];
      } finally {
        // ── Putting these back is not a DELETE, and that is the point ──────
        // `order_transitions` is append-only, enforced by `bb_forbid_change()`,
        // and it holds a plain FK to `order_states` — so these orders, which
        // every one MOVED (created, then assigned), can never be deleted. Each
        // still-live one is taken to CANCELLED through the state machine, and
        // its pool hold released through the pool's one owner, so no sweep is
        // left holding it and the team's tokens come back.
        for (const id of made) {
          await cancelOrderState(id, {
            expectFrom: ['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING'],
            set: { cancelReason: 'HARNESS_CLEANUP', cancelledAt: new Date() },
            actor: 'drive-fixture', reason: 'harness cleanup',
          }).catch((e) => console.error(`   ! could not cancel ${id}:`, e.message));
          await db.teamPools.releaseBuyHold(id, { actor: 'drive-fixture', reason: 'harness cleanup' })
            .catch((e) => console.error(`   ! could not release ${id}:`, e.message));
        }
      }
    },
  },

  // ══════════════════════════════════════════════════════════════════════
  // DISABLED ON ARRIVAL — fifteen of them, and each is disabled for a reason.
  //
  // "Disabled" is not coverage. A person cannot press it either, so the drive
  // is right to record it and wrong to stop there: the question a disabled
  // control raises is whether it ENABLES when it should, and whether it then
  // works. Each case below establishes the precondition, asserts the control
  // became enabled, and presses it. A control that stays disabled once its
  // condition holds is a live defect nobody would ever see.
  // ══════════════════════════════════════════════════════════════════════

  {
    id: 'admin/users/pagination-previous',
    panel: 'admin-panel',
    what: 'Previous page, once there IS a previous page',
    async run(page, cfg, base) {
      await go(page, cfg, base, '/users');
      const prev = page.getByRole('button', { name: /^\s*Previous page/i }).first();
      if (await prev.count() === 0) return ['NOT DRIVEN', 'no pagination on /users'];
      if (!await prev.isDisabled()) return ['FAILED', 'Previous is enabled on the FIRST page'];

      const next = page.getByRole('button', { name: /^\s*Next page/i }).first();
      if (await next.count() === 0 || await next.isDisabled()) {
        return ['NOT DRIVEN', 'only one page of users exists, so there is no previous to go back to'];
      }
      const hit = await clickThrough(next, { timeout: 8000 });
      if (!hit.ok) return ['FAILED', `Next page could not be pressed: ${hit.why}`];
      await settle(page, 6000);

      if (await prev.isDisabled()) {
        return ['FAILED', 'moved to page 2 and Previous page is STILL disabled — the way back is gone'];
      }
      const back = await clickThrough(prev, { timeout: 8000 });
      if (!back.ok) return ['FAILED', `Previous page enabled but could not be pressed: ${back.why}`];
      await settle(page, 6000);
      if (!await prev.isDisabled()) {
        return ['FAILED', 'back on page 1 and Previous page is still enabled'];
      }
      return ['DROVE', 'disabled on page 1, enabled on page 2, pressed, disabled again'];
    },
  },


  {
    id: 'admin/sub-admins/grant',
    panel: 'admin-panel',
    what: 'Grant, once a person is chosen — to a STAFF account, never a player',
    async run(page, cfg, base) {
      // A staff login holding no authority yet. Queue-manager access routes
      // players' payments, so it goes on a STAFF account only: the route
      // refuses a player id with 409 and the database refuses the flag
      // (owner, 2026-10-01 — separate accounts). This granted it to a PLAYER.
      const target = await seedStaff({});
      const player = await seedPlayer({ balancePaise: 0 });
      await go(page, cfg, base, '/sub-admins');
      const grant = page.getByRole('button', { name: /^\s*Grant\s*$/i }).first();
      if (await grant.count() === 0) return ['NOT DRIVEN', 'no Grant control on /sub-admins'];
      if (!await grant.isDisabled()) return ['FAILED', 'Grant is enabled with nobody chosen'];

      // Not a search box — the screen takes the user id DIRECTLY, in a field
      // whose placeholder says so. `search()` looks for the panel's general
      // search input and there is none here, which is why the first version
      // reported "no search box" as though the screen were broken.
      const field = page.getByPlaceholder(/user id to grant/i).first();
      if (await field.count() === 0) return ['NOT DRIVEN', 'no "User id to grant…" field on /sub-admins'];
      await field.fill(target.userId);
      await settle(page, 3000);

      if (await grant.isDisabled()) {
        return ['FAILED', 'a person was chosen and Grant stayed disabled'];
      }
      const hit = await clickThrough(grant, { timeout: 8000 });
      if (!hit.ok) return ['FAILED', `Grant enabled but could not be pressed: ${hit.why}`];
      await settle(page, 8000);
      await confirmWith(page, 'Grant');

      // ── QUEUE MANAGER, not sub-admin ───────────────────────────────────
      // The button calls `toggleQueueManager(id, true)`. Asserting
      // `is_sub_admin` reported "the player is still not a sub-admin" for a
      // press that did exactly what it says on it — the wrong column, which is
      // §23's shape in a test rather than in a type.
      const granted = Boolean((await pgQuery(
        'SELECT is_queue_manager FROM users WHERE user_id = $1', [target.userId],
      )).rows[0]?.is_queue_manager);
      if (!granted) return ['FAILED', 'pressed Grant and the staff account is still not a queue manager'];
      await pgQuery('UPDATE users SET is_queue_manager = FALSE WHERE user_id = $1',
        [target.userId]).catch(() => {});

      // The opposite case, on the same control: a PLAYER id is refused, the
      // player gains nothing, and the screen says why.
      await field.fill(player.userId);
      await settle(page, 2000);
      const again = await clickThrough(grant, { timeout: 8000 });
      if (!again.ok) return ['FAILED', `Grant could not be pressed for the player id: ${again.why}`];
      await settle(page, 6000);
      await confirmWith(page, 'Grant');
      const playerGot = Boolean((await pgQuery(
        'SELECT is_queue_manager FROM users WHERE user_id = $1', [player.userId],
      )).rows[0]?.is_queue_manager);
      if (playerGot) return ['FAILED', 'a PLAYER account was made a queue manager'];
      if (!/staff account/i.test(await words(page))) {
        return ['FAILED', 'the player id was refused, but the screen never said why'];
      }
      return ['DROVE', `${target.userId} (STAFF) became a queue manager; a PLAYER id was refused and the screen said why`];
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
            fiat_amount_paise, completed_at, order_hmac)
         VALUES ($1, $2, $3, 'DEPOSIT', 'COMPLETED', 50000, 50000, now(), $4)`,
        [orderId, player.userId, page.__bbMerchantId, deriveOrderHmac(orderId)],
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
      const wasSizes = before?.orderSizes;
      try {
        await go(page, cfg, base, '/settings');
        // One size on the Order Sizes card (Step 2d), addressed by its printed
        // name (S24). Flipped from whatever it is now, so the press changes the
        // document whichever state an earlier run left it in.
        const box = page.getByLabel('5,000', { exact: true }).first();
        if (await box.count() === 0) return ['NOT DRIVEN', 'no 5,000 order-size checkbox on /settings'];
        const wasOn = await box.isChecked();
        await box.setChecked(!wasOn);
        await settle(page, 1500);

        const save = page.getByRole('button', { name: /^Save Settings$/i }).first();
        if (await save.count() === 0) return ['NOT DRIVEN', 'no Save Settings button'];
        if (await save.isDisabled()) return ['NOT DRIVEN', 'Save Settings is disabled with a valid value'];
        await save.click();
        await settle(page, 8000);

        const after = await db.config.getSystemConfig();
        const nowOn = (after?.orderSizes ?? []).map(Number).includes(5000);
        if (nowOn === wasOn) {
          return ['FAILED', `pressed Save; 5,000 is still ${wasOn ? 'on' : 'off'} offer (${JSON.stringify(after?.orderSizes)})`];
        }
        const said = await words(page);
        if (!/saved|updated|success/i.test(said)) {
          return ['FAILED', 'the document was written; the screen never confirmed it'];
        }
        return ['DROVE', `5,000 ${wasOn ? 'taken off' : 'put on'} offer, confirmed on screen`];
      } finally {
        // Outside the assertions, and outside the early returns above (trap 10).
        await db.config.applyConfig({
          scope: 'system', actor: 'mutating-drive', patch: { orderSizes: wasSizes },
        }).catch((e) => console.error('   ! could not restore orderSizes:', e.message));
      }
    },
  },

  // ── Live Cycles: the controls nothing pressed ────────────────────────────
  // Measured 2026-10-01 (route coverage + the control inventory): Pause,
  // Resume and Balance Book on /live-cycles had no pass that pressed them, and
  // `POST /api/admin/cycles/:cycleId/equalize` was reached only by refusals.
  // They act on the LIVE board, so each case targets the FULL DAY cycle (the
  // longest window, so no phase boundary lands mid-case), checks the 30 MIN
  // cycle as the bystander, and puts back what it changed in a `finally`.
  {
    id: 'admin/live-cycles/pause-resume',
    panel: 'admin-panel',
    what: 'Pause the full-day cycle, then resume it',
    async run(page, cfg, base) {
      const cycleRow = async (type) => (await pgQuery(
        `SELECT cycle_id, status, is_paused FROM cycles
          WHERE cycle_type = $1 AND status IN ('OPEN','PAUSED') AND end_time > now()
          ORDER BY start_time DESC LIMIT 1`, [type])).rows[0];
      const target = await cycleRow('FULL_DAY');
      if (!target) return ['NOT DRIVEN', 'no open FULL_DAY cycle on the board'];
      if (target.status !== 'OPEN') return ['NOT DRIVEN', `the FULL_DAY cycle is ${target.status}, not OPEN`];
      const bystander = await cycleRow('30_MIN');
      const statusOf = async (id) => (await pgQuery('SELECT status, is_paused FROM cycles WHERE cycle_id = $1', [id])).rows[0];
      try {
        await go(page, cfg, base, '/live-cycles');
        const card = () => page.locator('.card').filter({ hasText: 'FULL DAY' }).first();
        if (await card().count() === 0) return ['NOT DRIVEN', 'no FULL DAY card on /live-cycles'];

        await card().getByRole('button', { name: /^\s*Pause\s*$/ }).click({ timeout: 8000 });
        if (await confirmWith(page, 'Pause') === 'stuck') return ['FAILED', 'the Pause confirmation could not be pressed'];
        await settle(page, 4000);
        const paused = await statusOf(target.cycle_id);
        if (paused.status !== 'PAUSED' || !paused.is_paused) {
          return ['FAILED', `after Pause the cycle is ${paused.status}, is_paused ${paused.is_paused}`];
        }
        if (bystander && (await statusOf(bystander.cycle_id)).status !== bystander.status) {
          return ['FAILED', 'the 30 MIN BYSTANDER cycle changed state too'];
        }
        // The screen, without a reload: the card now offers Resume.
        const resume = card().getByRole('button', { name: /^\s*Resume\s*$/ });
        if (await resume.count() === 0) return ['FAILED', 'server paused it; the card never offered Resume'];

        await resume.click({ timeout: 8000 });
        if (await confirmWith(page, 'Resume') === 'stuck') return ['FAILED', 'the Resume confirmation could not be pressed'];
        await settle(page, 4000);
        const resumed = await statusOf(target.cycle_id);
        if (resumed.is_paused || resumed.status === 'PAUSED') return ['FAILED', `after Resume the cycle is ${resumed.status}`];
        return ['DROVE', `FULL_DAY ${target.cycle_id}: OPEN → PAUSED → ${resumed.status}; 30 MIN bystander unchanged`];
      } finally {
        // Never leave the live board paused (trap 10).
        const now = await statusOf(target.cycle_id);
        if (now?.is_paused) await db.markets.setPaused(target.cycle_id, false).catch(() => {});
      }
    },
  },
  {
    id: 'admin/live-cycles/balance-book',
    panel: 'admin-panel',
    what: 'Balance the full-day cycle\'s phantom book',
    async run(page, cfg, base) {
      const { rows: [target] } = await pgQuery(
        `SELECT cycle_id, phantom_delhi_paise::bigint AS d, phantom_bombay_paise::bigint AS b, phantom_balanced
           FROM cycles WHERE cycle_type = 'FULL_DAY' AND status = 'OPEN' AND end_time > now()
          ORDER BY start_time DESC LIMIT 1`);
      if (!target) return ['NOT DRIVEN', 'no open FULL_DAY cycle on the board'];
      // The button is offered only while the book is unbalanced, so the case
      // makes it unbalanced — the state an operator presses it in.
      await pgQuery(
        `UPDATE cycles SET phantom_delhi_paise = phantom_delhi_paise + 70000, phantom_balanced = FALSE WHERE cycle_id = $1`,
        [target.cycle_id]);
      try {
        await go(page, cfg, base, '/live-cycles');
        const card = page.locator('.card').filter({ hasText: 'FULL DAY' }).first();
        const button = card.getByRole('button', { name: /Balance Book/i });
        if (await button.count() === 0) return ['FAILED', 'an unbalanced FULL DAY book offered no Balance Book button'];
        await button.click({ timeout: 8000 });
        if (await confirmWith(page, 'Equalizer') === 'stuck') return ['FAILED', 'the Balance confirmation could not be pressed'];
        await settle(page, 4000);
        const { rows: [after] } = await pgQuery(
          `SELECT phantom_delhi_paise::bigint AS d, phantom_bombay_paise::bigint AS b, phantom_balanced FROM cycles WHERE cycle_id = $1`,
          [target.cycle_id]);
        if (!after.phantom_balanced) return ['FAILED', 'the book is not marked balanced'];
        if (String(after.d) !== String(after.b)) return ['FAILED', `phantom pools still differ: ${after.d} / ${after.b}`];
        const audited = (await pgQuery(
          `SELECT 1 FROM audit_logs WHERE details::text LIKE $1 AND created_at > now() - interval '5 minutes' LIMIT 1`,
          [`%${target.cycle_id}%`]).catch(() => ({ rows: [] }))).rows.length > 0;
        return ['DROVE', `phantom pools levelled to ₹${Number(after.d) / 100} each${audited ? ', audit row written' : ''}`];
      } finally {
        await pgQuery(
          `UPDATE cycles SET phantom_delhi_paise = $2, phantom_bombay_paise = $3, phantom_balanced = $4 WHERE cycle_id = $1`,
          [target.cycle_id, target.d, target.b, target.phantom_balanced]).catch(() => {});
      }
    },
  },

  // ══════════════════════════════════════════════════════════════════════
  // THE SUPERVISOR'S HALF OF THE TEAM PAGE
  //
  // `BB_PROFILE=merchant-supervisor npm run test:drive` presses the Team page
  // AS a supervisor, and defers or finds disabled exactly the five controls
  // that change a team: Remove a member (destructive), and Send request,
  // Create team, Add and Rename (disabled until something is typed). Each case
  // below signs in as its OWN supervisor (`as`), on a team it seeded, and
  // reads the team's one writer back (`teams.js`, `teamPools.js`), with a
  // bystander team or member beside it.
  // ══════════════════════════════════════════════════════════════════════

  {
    id: 'merchant/team/remove-member',
    panel: 'merchant-panel',
    what: 'A supervisor removes one member of a full team, and only that one',
    as: () => supervisorSession(),
    async run(page, cfg, base, s) {
      const [victim, neighbour] = s.team.members;
      await go(page, cfg, base, '/team');
      const remove = page.getByRole('button', { name: new RegExp(`^\\s*Remove ${victim.username}\\s*$`) });
      if (await remove.count() === 0) return ['NOT DRIVEN', `no "Remove ${victim.username}" on /team — ${(await words(page)).slice(0, 160)}`];
      const hit = await clickThrough(remove.first(), { timeout: 8000 });
      if (!hit.ok) return ['NOT DRIVEN', `Remove could not be pressed: ${hit.why}`];
      await settle(page, 1500);
      // The first press only asks. Nothing may have moved yet.
      const asked = page.getByRole('group', { name: `Confirm removing ${victim.username}` });
      if (await asked.count() === 0) return ['FAILED', `pressed "Remove ${victim.username}" and no confirmation was asked`];
      if (!(await db.teams.membershipOf(victim.merchantId))) {
        return ['FAILED', `${victim.username} left the team on the FIRST press, before the confirmation was answered`];
      }
      const confirm = asked.getByRole('button', { name: new RegExp(`^\\s*Remove ${escapeRe(victim.username)} from ${escapeRe(s.team.name)}\\s*$`) });
      if (await confirm.count() === 0) return ['FAILED', `the confirmation has no "Remove ${victim.username} from ${s.team.name}"`];
      const yes = await clickThrough(confirm.first(), { timeout: 8000 });
      if (!yes.ok) return ['NOT DRIVEN', `the confirmation could not be pressed: ${yes.why}`];
      await settle(page, 8000);

      const gone = await db.teams.membershipOf(victim.merchantId);
      const kept = await db.teams.membershipOf(neighbour.merchantId);
      const team = await db.teams.getTeam(s.team.teamId);
      if (gone) return ['FAILED', `pressed Remove; ${victim.username} is still ${gone.member.status} in ${gone.team.teamId}`];
      if (kept?.team?.teamId !== s.team.teamId || kept.member.status !== 'APPROVED') {
        return ['FAILED', `the BYSTANDER member moved: ${neighbour.username} is ${kept ? `${kept.member.status} in ${kept.team.teamId}` : 'in no team'}`];
      }
      if (team.approvedCount !== 9) return ['FAILED', `the team counts ${team.approvedCount} approved, expected 9`];
      if (await remove.count() > 0) return ['FAILED', `${victim.username} left the team and the screen still offers to remove them`];
      return ['DROVE', `asked first (nothing moved), then ${victim.username} out of ${s.team.teamId} (9 approved now), ${neighbour.username} still APPROVED, screen updated`];
    },
  },

  {
    id: 'merchant/team/pool-request',
    panel: 'merchant-panel',
    what: 'A supervisor asks to buy tokens into one team\'s pool — "Send request" enables once tokens are typed',
    as: () => supervisorSession({ secondTeam: true }),
    async run(page, cfg, base, s) {
      const mine = s.team.teamId;
      try {
        await go(page, cfg, base, '/team');
        const send = page.getByRole('button', { name: new RegExp(`^\\s*Send ${escapeRe(s.team.name)} request\\s*$`) }).first();
        if (await send.count() === 0) return ['NOT DRIVEN', `no "Send ${s.team.name} request" on /team`];
        if (!(await send.isDisabled())) return ['FAILED', 'Send request is enabled before any tokens are typed'];
        const typed = await fill(page, `#pa-${mine}`, '1000');
        if (!typed.ok) return ['NOT DRIVEN', typed.why];
        await settle(page, 1500);
        if (await send.isDisabled()) return ['FAILED', 'Send request stayed disabled with 1000 tokens typed'];
        await send.click({ timeout: 8000 });
        await settle(page, 8000);

        const asked = await db.teamPools.listRequests({ teamId: mine });
        const other = await db.teamPools.listRequests({ teamId: s.second });
        const pending = asked.filter((r) => r.status === 'PENDING');
        if (pending.length !== 1 || pending[0].direction !== 'BUY' || Number(pending[0].tokenAmountPaise) !== 100000) {
          return ['FAILED', `pressed Send; the team's requests are ${JSON.stringify(asked.map((r) => [r.status, r.direction, r.tokenAmountPaise]))}`];
        }
        if (other.length) return ['FAILED', `the BYSTANDER team got ${other.length} request(s) too`];
        const said = await words(page);
        if (!/waiting for an admin/i.test(said)) return ['FAILED', 'the request was written; the screen never showed it waiting'];
        return ['DROVE', `one PENDING BUY of 1,000 tokens for ${mine}, the other team asked for nothing, shown as waiting`];
      } finally {
        for (const r of await db.teamPools.listRequests({ teamId: mine }).catch(() => [])) {
          if (r.status === 'PENDING') await db.teamPools.cancelRequest({ requestId: r.requestId, supervisorId: s.supervisor.merchantId }).catch(() => {});
        }
      }
    },
  },

  {
    id: 'merchant/team/create',
    panel: 'merchant-panel',
    what: 'A supervisor creates a second team — "Create team" enables once a name is typed',
    as: () => supervisorSession(),
    async run(page, cfg, base, s) {
      const name = `Drive ${rid('team').slice(-6)}`;
      let made = null;
      try {
        await go(page, cfg, base, '/team');
        const create = page.getByRole('button', { name: /^\s*Create team\s*$/ }).first();
        if (await create.count() === 0) return ['NOT DRIVEN', 'no "Create team" on /team'];
        if (!(await create.isDisabled())) return ['FAILED', 'Create team is enabled with no name typed'];
        const typed = await fill(page, '#new-team-name', name);
        if (!typed.ok) return ['NOT DRIVEN', typed.why];
        await settle(page, 1500);
        await create.click({ timeout: 8000 });
        await settle(page, 8000);

        const teams = await db.teams.listTeams({ supervisorId: s.supervisor.merchantId });
        made = teams.find((t) => t.name === name) ?? null;
        const original = teams.find((t) => t.teamId === s.team.teamId);
        if (!made) return ['FAILED', `pressed Create team; the supervisor has [${teams.map((t) => t.name).join(', ')}]`];
        if (teams.length !== 2) return ['FAILED', `one press, ${teams.length - 1} new teams`];
        if (original?.name !== s.team.name || original.approvedCount !== 10) {
          return ['FAILED', `the BYSTANDER team changed: ${original?.name} with ${original?.approvedCount} approved`];
        }
        if (!(await words(page)).includes(name)) return ['FAILED', `${name} was written; the screen never showed it`];
        return ['DROVE', `"${name}" created for the supervisor, the first team untouched, shown on screen`];
      } finally {
        if (made) await db.teams.deleteTeam({ teamId: made.teamId, supervisorId: s.supervisor.merchantId }).catch(() => {});
      }
    },
  },

  {
    id: 'merchant/team/add-member',
    panel: 'merchant-panel',
    what: 'A supervisor proposes a merchant for a team by the ID that merchant was given — "Add" enables once typed',
    as: () => supervisorSession({ secondTeam: true }),
    async run(page, cfg, base, s) {
      const candidate = await seedMerchant({ currency: 'INR', online: false });
      const { rows: [ref] } = await pgQuery('SELECT public_ref FROM merchants WHERE merchant_id = $1', [candidate.merchantId]);
      try {
        await go(page, cfg, base, '/team');
        // The empty team's own form: each team card has an "Add".
        const form = page.locator('form', { has: page.locator(`#add-${s.second}`) });
        const add = form.getByRole('button', { name: /^\s*Add\s*$/ }).first();
        if (await add.count() === 0) return ['NOT DRIVEN', `no "Add" beside #add-${s.second}`];
        if (!(await add.isDisabled())) return ['FAILED', 'Add is enabled with no merchant ID typed'];
        const typed = await fill(page, `#add-${s.second}`, ref.public_ref);
        if (!typed.ok) return ['NOT DRIVEN', typed.why];
        await settle(page, 1500);
        await add.click({ timeout: 8000 });
        await settle(page, 8000);

        const joined = await db.teams.membershipOf(candidate.merchantId);
        const full = await db.teams.getTeam(s.team.teamId);
        if (joined?.team?.teamId !== s.second || joined.member.status !== 'PENDING') {
          return ['FAILED', `pressed Add with ${ref.public_ref}; the merchant is ${joined ? `${joined.member.status} in ${joined.team.teamId}` : 'in no team'}`];
        }
        if (full.approvedCount !== 10 || full.pendingCount !== 0) {
          return ['FAILED', `the BYSTANDER team changed: ${full.approvedCount} approved, ${full.pendingCount} pending`];
        }
        if (!/waiting for admin/i.test(await words(page))) return ['FAILED', 'proposed, and the screen never showed them waiting for an admin'];
        return ['DROVE', `${ref.public_ref} PENDING in ${s.second} (an admin approves), the full team untouched, shown waiting`];
      } finally {
        await db.teams.removeMember({ merchantId: candidate.merchantId }).catch(() => {});
      }
    },
  },

  {
    id: 'merchant/team/rename',
    panel: 'merchant-panel',
    what: 'A supervisor renames one team — "Rename" enables once the name differs',
    as: () => supervisorSession({ secondTeam: true }),
    async run(page, cfg, base, s) {
      const name = `Renamed ${rid('team').slice(-6)}`;
      const otherBefore = (await db.teams.getTeam(s.second)).name;
      await go(page, cfg, base, '/team');
      const form = page.locator('form', { has: page.locator(`#name-${s.team.teamId}`) });
      const rename = form.getByRole('button', { name: /^\s*Rename\s*$/ }).first();
      if (await rename.count() === 0) return ['NOT DRIVEN', `no "Rename" beside #name-${s.team.teamId}`];
      if (!(await rename.isDisabled())) return ['FAILED', 'Rename is enabled while the name is unchanged'];
      const typed = await fill(page, `#name-${s.team.teamId}`, name);
      if (!typed.ok) return ['NOT DRIVEN', typed.why];
      await settle(page, 1500);
      await rename.click({ timeout: 8000 });
      await settle(page, 8000);

      const now = (await db.teams.getTeam(s.team.teamId)).name;
      const other = (await db.teams.getTeam(s.second)).name;
      if (now !== name) return ['FAILED', `pressed Rename; the team is called "${now}"`];
      if (other !== otherBefore) return ['FAILED', `the BYSTANDER team was renamed too: "${otherBefore}" → "${other}"`];
      if (!(await words(page)).includes(name)) return ['FAILED', 'renamed, and the screen still shows the old name'];
      return ['DROVE', `"${s.team.name}" → "${name}", the other team still "${other}", shown on screen`];
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

  // ── A configured platform: the one Mini App bot exists (Step 3) ─────────
  // Restored at the end, outside any assertion (trap 10).
  const restoreTelegram = await configureTelegram();

  const tokens = { 'admin-panel': adminToken(await seedAdmin()) };
  const cached = {};
  let driveMerchant = null;
  if (panels.includes('merchant-panel')) {
    // A MEMBER of a working UPI/bank team with tokens in its pool, and the
    // only member online on that rail (`seedTeam`'s `exclusive`), so its
    // screens render their working state and a buy created during the run is
    // routed to it — `merchant/orders/accept-a-later-card` depends on exactly
    // that. Since Step 2c a merchant outside a team is served no orders at all.
    driveMerchant = await seedMerchant({ currency: 'INR' });
    await seedTeam({ rail: 'UPI_BANK', poolTokens: 200000, include: [driveMerchant], online: [driveMerchant] });
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
   *
   * A case that must act as a DIFFERENT account than the panel's shared one
   * (a supervisor, where the shared merchant is a member) declares `as`, which
   * seeds that account and answers `{ token, cached }`; it gets its own
   * context signed in as it, for the same reason.
   */
  const newPanelPage = async (panel, session = null) => {
    const cfg = PANELS[panel];
    const token = session?.token ?? tokens[panel];
    const cache = session?.cached ?? cached[panel];
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addInitScript(([k, v, ck, cv]) => {
      try {
        localStorage.setItem(k, v);
        if (ck) localStorage.setItem(ck, cv);
      } catch { /* private mode */ }
    }, [cfg.key, cfg.wrap(token, cache), cfg.cacheKey ?? '',
        cfg.cacheKey && cache ? JSON.stringify(cache) : '']);

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
    // type into a `window.prompt` — rejecting a merchant's application asks for its reason
    // that way, and `if (!reason?.trim()) return` means an empty accept is
    // indistinguishable from a cancel: the button would do nothing and the case
    // would report the platform as failing to do what it was never asked to.
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
    // A case that ENDS a session gets its own, so the damage is its own; a
    // case that acts as another account (`as`) gets one signed in as it.
    let session = null;
    try {
      session = c.as ? await c.as() : null;
    } catch (err) {
      record(c.id, 'NOT DRIVEN', `its account could not be seeded: ${err.message.split('\n')[0].slice(0, 140)}`);
      continue;
    }
    const own = (c.ownContext || session) ? await newPanelPage(c.panel, session) : null;
    const { page, cfg, base } = own ?? pages[c.panel];
    try {
      const [verdict, detail] = await c.run(page, cfg, base, session);
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
