#!/usr/bin/env node
/**
 * verify-merchant-privacy.mjs — a merchant never learns who the player is.
 *
 * The rule: a merchant may see the bank account a withdrawal pays and the name
 * on it. Not the player's phone number, not their UPI ID, not the platform's
 * treasury split, not the risk verdicts on their own conduct.
 *
 * This existed as a convention and was broken in three places at once:
 *
 *   • the projection was a DENYLIST that stripped `userBankDetails` only on a
 *     DEPOSIT, so every WITHDRAWAL carried the player's `upiId`;
 *   • the merchant panel rendered it — OrderCard's "Send to user UPI"; and
 *   • the order search matched on `order.userPhone`, so a merchant could look
 *     a player up by phone number.
 *
 * Every check in the repository was green throughout. Nothing was looking.
 *
 * Three things are checked, and all three are mechanical:
 *   1. The allowlist and the forbidden list do not overlap.
 *   2. Every merchant-facing responder that sends an order projects it first.
 *   3. The merchant panel's own type declares no forbidden field — a field the
 *      panel names is a field somebody will render.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { frozenList, callsTo, topLevelKeys, topLevelSpreads, blankComments } from './lib/privacyLists.mjs';

// Derived, never a path baked in from one machine's checkout. `verify-ui-
// coverage.mjs` shipped with an absolute ROOT and died at CI's first read.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(ROOT, p);
// Comments blanked, positions preserved. An apostrophe in English prose is an
// opening quote to a bracket counter, and that failure is silent.
const read = (p) => blankComments(readFileSync(p, 'utf8'));

const VIEW_MODULE   = join(ROOT, 'backend/domains/merchant/merchantOrderView.js');
const MERCHANT_ROUTES = [
  join(ROOT, 'backend/domains/merchant/merchant.routes.js'),
];
const PANEL_TYPES   = join(ROOT, 'merchant-panel/src/types.ts');
const ORDER_MAPPER  = join(ROOT, 'database/repositories/orders.record.js');

/**
 * Responder lines that legitimately send an `order`/`orders` key without the
 * merchant order projection. Each needs a REASON, so adding a line here is a
 * decision somebody made rather than a check somebody silenced.
 */
const RESPONDER_ALLOW = new Map([
  ['admin-token-orders', 'merchant_admin_token_orders rows — the merchant buying tokens from the platform. No player is party to one, so there is no player identity to strip.'],
]);

const failures = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);

const viewSrc = read(VIEW_MODULE);
const allowed   = frozenList(viewSrc, 'MERCHANT_ORDER_FIELDS');
const forbidden = frozenList(viewSrc, 'MERCHANT_FORBIDDEN_ORDER_FIELDS');
const bankOk    = frozenList(viewSrc, 'MERCHANT_BANK_FIELDS');

if (!allowed || !forbidden || !bankOk) {
  fail(rel(VIEW_MODULE), 'could not read MERCHANT_ORDER_FIELDS / MERCHANT_FORBIDDEN_ORDER_FIELDS / MERCHANT_BANK_FIELDS');
} else {
  // 1. A field cannot be both permitted and forbidden.
  for (const f of allowed) {
    if (forbidden.includes(f)) fail(rel(VIEW_MODULE), `'${f}' is in BOTH the allowlist and the forbidden list`);
  }
  // A UPI id resolves to a name and, on most apps, a phone number. It is a
  // contact handle wearing a payment field's name.
  if (bankOk.includes('upiId')) {
    fail(rel(VIEW_MODULE), "MERCHANT_BANK_FIELDS names 'upiId' — a contact handle, not a payout destination");
  }
}

/** The projection, by any of the names a caller may reach it under. */
const PROJECTS = /\btoMerchantOrderViews?\s*\(/;

// Which route encloses a responder? Search back to the nearest handler
// declaration rather than guessing at a fixed number of lines — the
// admin-token-orders responder sits 38 lines below its own router.post.
function routeOf(src, index) {
  const m = [...src.slice(0, index).matchAll(/router\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)].pop();
  return m ? m[1] : '';
}

// 2. Every merchant-facing responder that sends an order projects it.
//
// By balanced-bracket extraction, not per line: a responder whose payload spans
// five lines shows a line-scan the `res.json({` and none of what follows.
for (const file of MERCHANT_ROUTES) {
  const src = read(file);
  for (const call of callsTo(src, 'res.json')) {
    const route = routeOf(src, call.index);
    if ([...RESPONDER_ALLOW.keys()].some((k) => route.includes(k))) continue;
    const keys = topLevelKeys(call.args);
    const where = `${rel(file)}:${call.line}`;

    for (const key of ['order', 'orders']) {
      if (!keys.includes(key)) continue;
      if (PROJECTS.test(call.args)) continue;
      fail(where, `sends '${key}' to a merchant without toMerchantOrderView()`);
    }
    for (const key of keys) {
      if (forbidden.includes(key)) fail(where, `sends '${key}', which a merchant must never receive`);
    }
    // A spread of something ORDER-shaped. `merchant.routes.js` is the whole
    // merchant surface — sessions, profiles, rail copy — and most of what it
    // spreads is not an order at all, so this asks whether the spread could be
    // one rather than refusing every spread in the file. The pushes below are
    // held to the stricter rule, because a push payload always is one.
    for (const spread of topLevelSpreads(call.args)) {
      if (PROJECTS.test(spread)) continue;
      if (!/order/i.test(spread) && !keys.includes('order') && !keys.includes('orders')) continue;
      fail(where, `spreads '...${spread}' into a merchant response — a spread carries every field the object has`);
    }
  }
}

// 2b. And so does every merchant-facing PUSH, anywhere in the backend.
//
// The route scan above was the whole of this check, and it read one file. Two
// live leaks sat outside it and stayed green for as long as it existed:
//
//   • `paymentProcessing.service.js` spread the WHOLE order — `...order` — onto
//     the merchant's stream at the moment of assignment; and
//   • `sse.routes.js` pushed `page.orders` raw in `merchant_orders_snapshot`,
//     to every merchant, on every connect.
//
// Both carried the player's phone number, their bank details, the platform's
// treasury split and the risk verdicts on the player. A merchant channel is a
// merchant-facing responder wherever it is written, so this reads all of them.
const MERCHANT_PUSHES = ['emitMerchantUpdate', 'sendToMerchant', 'broadcastToMerchants'];

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (/\.m?js$/.test(name) && !/\.test\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

for (const file of jsFiles(join(ROOT, 'backend'))) {
  const src = read(file);
  const calls = MERCHANT_PUSHES.flatMap((name) => (src.includes(`${name}(`) ? callsTo(src, name) : []));
  // The SSE writer takes the event name as its second argument, so the merchant
  // streams are the ones whose event starts `merchant_`.
  calls.push(...callsTo(src, 'writeEvent').filter((c) => /'merchant_/.test(c.args)));
  calls.push(...callsTo(src, 'sseManager.writeEvent').filter((c) => /'merchant_/.test(c.args)));

  for (const call of calls) {
    // The emitter definitions take named parameters, not a payload literal.
    if (!call.args.includes('{')) continue;
    const where = `${rel(file)}:${call.line}`;
    for (const key of topLevelKeys(call.args)) {
      if (forbidden.includes(key)) fail(where, `pushes '${key}' to a merchant`);
    }
    for (const spread of topLevelSpreads(call.args)) {
      if (PROJECTS.test(spread)) continue;
      fail(where, `spreads '...${spread}' to a merchant — a spread carries every field the object has`);
    }
    // A payload that names `orders` must have projected them: `page.orders`
    // raw is exactly what the SSE snapshot was sending.
    if (topLevelKeys(call.args).includes('orders') && !PROJECTS.test(call.args)) {
      fail(where, "pushes 'orders' to a merchant without toMerchantOrderViews()");
    }
  }
}

// 3. The panel's own type must not name a forbidden field.
if (forbidden) {
  const src = readFileSync(PANEL_TYPES, 'utf8');
  const iface = src.match(/export interface PaymentOrder \{([\s\S]*?)\n\}/);
  if (!iface) {
    fail(rel(PANEL_TYPES), 'could not find the PaymentOrder interface');
  } else {
    for (const f of forbidden) {
      if (new RegExp(`^\\s*${f}\\??\\s*:`, 'm').test(iface[1])) {
        fail(rel(PANEL_TYPES), `PaymentOrder declares '${f}', which a merchant must never receive`);
      }
    }
  }
}

// 4. The CDM receipt must never enter the order mapper.
//
// A merchant deposits cash at a CDM into a player's bank account and submits
// the slip: account number, branch, timestamp, bank reference. Neither the
// player nor the merchant who uploaded it may read it back — only an admin or
// a disputes manager.
//
// That is enforced by ABSENCE. Every projection on this platform is built from
// `toOrder`, so a column it does not name cannot reach any of them. Three added
// lines there would hand the slip to both parties and nothing would fail — no
// test, no type, no gate — because every existing check asks whether the right
// things are present, not whether the wrong thing has appeared.
const CDM_COLUMNS = ['cdm_transaction_id', 'cdm_receipt_url', 'cdm_receipt_at'];
{
  const src = readFileSync(ORDER_MAPPER, 'utf8');
  const mapper = src.match(/export function toOrder\(r\) \{([\s\S]*?)\n\}/);
  if (!mapper) {
    fail(rel(ORDER_MAPPER), 'could not find the toOrder mapper');
  } else {
    // Comments explaining the absence are expected and must not trip this, so
    // only actual field reads count.
    const body = mapper[1].replace(/^\s*\/\/.*$/gm, '');
    for (const column of CDM_COLUMNS) {
      if (new RegExp(`r\\.${column}\\b`).test(body)) {
        fail(rel(ORDER_MAPPER), `toOrder reads '${column}' — the CDM receipt is admin-only and every projection is built from this mapper`);
      }
    }
  }
}

if (failures.length) {
  console.error('\nMERCHANT PRIVACY: ' + failures.length + ' violation(s)\n');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('\nA merchant may see the payout bank account and the name on it. Nothing else.\n');
  process.exit(1);
}
console.log('check:merchant-privacy — the merchant-facing order projection carries no player identity.');
