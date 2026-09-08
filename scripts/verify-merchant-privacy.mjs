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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// Derived, never a path baked in from one machine's checkout. `verify-ui-
// coverage.mjs` shipped with an absolute ROOT and died at CI's first read.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(ROOT, p);

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

// Pull a frozen string array out of the module source by name.
function arrayLiteral(src, name) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const viewSrc = readFileSync(VIEW_MODULE, 'utf8');
const allowed   = arrayLiteral(viewSrc, 'MERCHANT_ORDER_FIELDS');
const forbidden = arrayLiteral(viewSrc, 'MERCHANT_FORBIDDEN_ORDER_FIELDS');
const bankOk    = arrayLiteral(viewSrc, 'MERCHANT_BANK_FIELDS');

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

// 2. Every merchant-facing responder that sends an order projects it.
for (const file of MERCHANT_ROUTES) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!/res\.json\(/.test(line)) return;
    if (!/\borders?\s*:/.test(line)) return;
    if (/toMerchantOrderViews?\(/.test(line)) return;
    // Which route encloses this responder? Search back to the nearest handler
    // declaration rather than guessing at a fixed number of lines — the
    // admin-token-orders responder sits 38 lines below its own router.post.
    let route = '';
    for (let j = i; j >= 0; j -= 1) {
      const m = lines[j].match(/router\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/);
      if (m) { route = m[1]; break; }
    }
    if ([...RESPONDER_ALLOW.keys()].some((k) => route.includes(k))) return;
    fail(`${rel(file)}:${i + 1}`, 'sends an order to a merchant without toMerchantOrderView()');
  });
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
