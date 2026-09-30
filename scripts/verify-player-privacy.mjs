#!/usr/bin/env node
/**
 * verify-player-privacy.mjs — a player never learns who the merchant is.
 *
 * The mirror of `check:merchant-privacy`, pointing the other way. That gate
 * exists because a denylist protecting the PLAYER failed open. This one exists
 * because nothing at all was protecting the MERCHANT.
 *
 * Every player-facing response carried `merchantSnapshot` whole:
 *
 *     upiId          the merchant's UPI handle
 *     qrCodeUrl      their own QR image
 *     bankName / accountNo / ifsc / accountHolder    their BANK ACCOUNT
 *     usdtAddress    their settlement wallet
 *
 * — on order creation, on the order fetch, on the dispute response, on the
 * assignment socket push, and every few seconds on the status poll. The
 * player's screen rendered the handle in a copy-to-clipboard row. None of the
 * bank fields is needed to pay a UPI handle; they were pure disclosure.
 *
 * The rule is as short as the other one: **a player sees where to pay and
 * nothing about who they are paying.** A payment link, an opaque reference, a
 * deadline.
 *
 * Five things are checked, all mechanical:
 *   1. The allowlist and the forbidden list do not overlap.
 *   2. Every player-facing responder that sends an order projects it.
 *   3. No payload pushed on the PLAYER's channel names a forbidden field —
 *      anywhere in the backend, not only in route files. The two leaks this
 *      gate was written after were both in files the route scan never opened:
 *      a service and an SSE stream.
 *   4. The player panel's own type declares no forbidden field. A field the
 *      panel names is a field somebody will render.
 *   5. The payment link has ONE owner, and the client is not it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  frozenList, callsTo, topLevelKeys, topLevelSpreads, returnedLiterals, blankComments,
} from './lib/privacyLists.mjs';

// Derived, never a path baked in from one machine's checkout.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(ROOT, p);
// Comments blanked, positions preserved. An apostrophe in a comment is an
// opening quote to a bracket counter, and the failure is silent.
const read = (p) => blankComments(readFileSync(p, 'utf8'));

const VIEW_MODULE  = join(ROOT, 'backend/domains/payment/playerOrderView.js');
const LINK_MODULE  = join(ROOT, 'backend/domains/payment/paymentLink.js');
const SERVICE      = join(ROOT, 'backend/domains/payment/paymentProcessing.service.js');
const PLAYER_ROUTES = [join(ROOT, 'backend/domains/payment/payment.routes.js')];
const PANEL_TYPES  = join(ROOT, 'user-panel/src/types.ts');

/** The projection, by any of the names a caller may reach it under. */
const PROJECTS = /\b(toPlayerOrderViews?|forPlayer)\s*\(/;

/**
 * Functions whose returned `order` this gate verifies for itself, and the
 * pass-throughs that hand their result on unchanged.
 *
 * A route that spreads a producer's result — `res.json({ ...result })` — is
 * sending whatever that function built. So the gate follows it: the producer's
 * `order` key must be the projection, and only then is the spread permitted.
 * Without this pairing the check has two bad options, refusing every spread or
 * trusting every one.
 */
const FUNDING  = join(ROOT, 'backend/domains/funding/fundingAuthority.service.js');
const REGISTRY = join(ROOT, 'backend/domains/funding/providerRegistry.js');

const PRODUCERS = ['createDepositOrder', 'createWithdrawalOrder'];

/**
 * The functions a route spreads, and what each must call to be a pass-through
 * rather than a second builder. `requestDeposit` reaches the producer through
 * the provider registry, so the chain is stated in full instead of assumed:
 *
 *   res.json({ ...result })  ←  requestDeposit  ←  adapter.createDeposit
 *                                                    ←  createDepositOrder
 */
const PASSTHROUGH = new Map([
  ['retryOrder',        { file: SERVICE, calls: PRODUCERS }],
  ['requestDeposit',    { file: FUNDING, calls: ['adapter.createDeposit'] }],
  ['requestWithdrawal', { file: FUNDING, calls: ['adapter.createWithdrawal'] }],
]);

/** The registry's last hop: each adapter method must land on a producer. */
const ADAPTER_BINDINGS = new Map([
  ['createDeposit', 'createDepositOrder'],
  ['createWithdrawal', 'createWithdrawalOrder'],
]);

/**
 * Responders whose audience is NOT a player, with the reason. Adding a line
 * here is a decision somebody made, not a check somebody silenced.
 */
const RESPONDER_ALLOW = new Map([
  ['/deposit/:orderId/confirm',
   'merchant-or-admin only — it 403s a player before reaching a handler. A merchant is answered through toMerchantOrderView; an admin sees the order unredacted, which is the point of being an admin.'],
]);

const failures = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);

const viewSrc   = read(VIEW_MODULE);
const allowed   = frozenList(viewSrc, 'PLAYER_ORDER_FIELDS');
const forbidden = frozenList(viewSrc, 'PLAYER_FORBIDDEN_ORDER_FIELDS');

if (!allowed || !forbidden) {
  fail(rel(VIEW_MODULE), 'could not read PLAYER_ORDER_FIELDS / PLAYER_FORBIDDEN_ORDER_FIELDS');
  report();
}

// ── 1. A field cannot be both permitted and forbidden ────────────────────────
for (const f of allowed) {
  if (forbidden.includes(f)) fail(rel(VIEW_MODULE), `'${f}' is in BOTH the allowlist and the forbidden list`);
}

// ── 2. Every player-facing responder that sends an order projects it ─────────
//
// By balanced-bracket extraction, not per line: three of the four responders in
// this file span five lines or more, and a line-at-a-time scan sees the
// `res.json({` and none of what follows it.
// The producers first, because whether a spread is safe depends on them.

/** One function's source, from its declaration to the next module-level export. */
function bodyOf(src, name) {
  const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at === -1) return null;
  const end = src.indexOf('\nexport ', at + 1);
  return src.slice(at, end === -1 ? src.length : end);
}

{
  const src = read(SERVICE);
  for (const name of PRODUCERS) {
    const body = bodyOf(src, name);
    if (body === null) { fail(rel(SERVICE), `no function ${name}() — this gate names it as a producer`); continue; }
    let checked = 0;
    for (const ret of returnedLiterals(body)) {
      if (!topLevelKeys(`{${ret.body}}`).includes('order')) continue;
      checked += 1;
      const m = ret.body.match(/\border\s*:\s*([^,\n]*)/);
      if (m && PROJECTS.test(m[1])) continue;
      fail(`${rel(SERVICE)}:${name}`, "returns an 'order' that is not toPlayerOrderView() — a route spreads this straight to the player");
    }
    // A producer that returns no `order` at all means this scan found nothing
    // to check, which reads exactly like a pass. It is not one: say so, because
    // a check measuring zero things is the failure this gate has already had.
    if (checked === 0) {
      fail(`${rel(SERVICE)}:${name}`, 'is named here as a producer but returns no order — this gate checked nothing');
    }
  }

  // A pass-through hands a producer's result on. It has to actually do that:
  // it must call one, and it must not build an order of its own on the way
  // past, which is exactly where a "just add one field" would go.
  for (const [name, { file, calls }] of PASSTHROUGH) {
    const body = bodyOf(read(file), name);
    if (body === null) { fail(rel(file), `no function ${name}() — this gate names it as a pass-through`); continue; }
    if (!calls.some((callee) => body.includes(`${callee}(`))) {
      fail(`${rel(file)}:${name}`, `is named here as a pass-through but calls none of ${calls.join(', ')}`
        + ' — a route spreads its result to the player');
    }
    for (const ret of returnedLiterals(body)) {
      if (!topLevelKeys(`{${ret.body}}`).includes('order')) continue;
      const m = ret.body.match(/\border\s*:\s*([^,\n]*)/);
      if (m && PROJECTS.test(m[1])) continue;
      fail(`${rel(file)}:${name}`, "builds its own 'order' instead of passing the producer's through");
    }
  }

  // The registry's binding, which is the hop between the two above.
  {
    const src = read(REGISTRY);
    for (const [method, producer] of ADAPTER_BINDINGS) {
      const line = src.split('\n').find((l) => new RegExp(`\\b${method}\\s*:`).test(l) && l.includes(producer));
      if (!line) {
        fail(`${rel(REGISTRY)}:${method}`, `does not bind to ${producer}() — the chain a route's spread depends on is broken`);
      }
    }
  }
}

// Which route encloses a responder: search back to the nearest handler
// declaration rather than guessing at a fixed number of lines.
function routeOf(src, index) {
  const before = src.slice(0, index);
  const m = [...before.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)].pop();
  return m ? m[1] : '';
}

for (const file of PLAYER_ROUTES) {
  const src = read(file);
  for (const call of callsTo(src, 'res.json')) {
    const route = routeOf(src, call.index);
    if (RESPONDER_ALLOW.has(route)) continue;

    const keys = topLevelKeys(call.args);
    const where = `${rel(file)}:${call.line}`;

    for (const key of ['order', 'orders']) {
      if (!keys.includes(key)) continue;
      if (PROJECTS.test(call.args)) continue;
      fail(where, `sends '${key}' to a player without toPlayerOrderView()`);
    }
    for (const key of keys) {
      if (forbidden.includes(key)) fail(where, `sends '${key}', which a player must never receive`);
    }
    // The handler this responder sits in, so a spread is resolved against the
    // assignment that produced it and not against a same-named variable in
    // some other route.
    const handler = src.slice(src.lastIndexOf('router.', call.index), call.index);
    for (const spread of topLevelSpreads(call.args)) {
      if (PROJECTS.test(spread)) continue;
      const producer = new RegExp(`\\b${spread}\\s*=\\s*await\\s+([A-Za-z_$][\\w$]*)\\s*\\(`).exec(handler)?.[1];
      if (producer && (PRODUCERS.includes(producer) || PASSTHROUGH.has(producer))) continue;
      fail(where, `spreads '...${spread}' into a player response — a spread carries every field the object has,`
        + ' and this one does not come from a producer whose order key this gate verifies');
    }
  }
}

// ── 3. Nothing forbidden goes out on the player's channel ────────────────────
//
// `emitOrderUpdate(userId, event, payload)` is the player's socket. It is
// called from services and route files alike, so this reads the whole backend
// rather than a list of route files — which is precisely the list that missed
// `paymentProcessing.service.js` and `sse.routes.js`.
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
  if (!src.includes('emitOrderUpdate(')) continue;
  for (const call of callsTo(src, 'emitOrderUpdate')) {
    // The definition itself takes named parameters, not a literal.
    if (/^\s*userId/.test(call.args) && !call.args.includes('{')) continue;
    const where = `${rel(file)}:${call.line}`;
    for (const key of topLevelKeys(call.args)) {
      if (forbidden.includes(key)) fail(where, `pushes '${key}' to the player's socket`);
    }
    for (const spread of topLevelSpreads(call.args)) {
      if (PROJECTS.test(spread)) continue;
      fail(where, `spreads '...${spread}' to the player's socket — a spread carries every field the object has`);
    }
  }
}

// ── 4. The panel's own type must not name a forbidden field ──────────────────
{
  const src = read(PANEL_TYPES);
  const iface = src.match(/export interface PaymentOrder \{([\s\S]*?)\n\}/);
  if (!iface) {
    fail(rel(PANEL_TYPES), 'could not find the PaymentOrder interface');
  } else {
    for (const f of forbidden) {
      if (new RegExp(`^\\s*${f}\\??\\s*:`, 'm').test(iface[1])) {
        fail(rel(PANEL_TYPES), `PaymentOrder declares '${f}', which a player must never receive`);
      }
    }
  }
}

// ── 5. The payment link has one owner, and the client is not it ──────────────
//
// The panel used to assemble the intent itself from `merchantSnapshot.upiId`
// and the merchant's name, which is why it had to be given both. Building it on
// the server is what makes the rule structural rather than a thing the screen
// politely omits: there is nothing left in the payload to build one FROM.
{
  const INTENT = /upi:\/\/pay\?/;
  const panelSrc = join(ROOT, 'user-panel/src');
  for (const file of jsFiles(panelSrc).concat(
    readdirSync(panelSrc, { recursive: true })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => join(panelSrc, f)),
  )) {
    if (INTENT.test(read(file))) {
      fail(rel(file), 'builds a upi://pay intent — the link is built by backend/domains/payment/paymentLink.js');
    }
  }
  for (const file of jsFiles(join(ROOT, 'backend'))) {
    if (file === LINK_MODULE) continue;
    if (INTENT.test(read(file))) {
      fail(rel(file), `builds a upi://pay intent — ${rel(LINK_MODULE)} is the one owner`);
    }
  }
}

report();

function report() {
  if (failures.length) {
    console.error('\nPLAYER PRIVACY: ' + failures.length + ' violation(s)\n');
    for (const f of failures) console.error('  ✗ ' + f);
    console.error('\nA player sees where to pay. Not who they are paying.\n');
    process.exit(1);
  }
  console.log('check:player-privacy — the player-facing order projection carries no merchant identity.');
}
