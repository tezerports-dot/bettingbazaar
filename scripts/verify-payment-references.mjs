#!/usr/bin/env node
/**
 * verify-payment-references.mjs — one payment cannot be claimed twice.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * A UTR is a bank's reference for one real transfer. A transaction hash is a
 * blockchain's reference for one real transfer. A CDM slip carries the
 * machine's reference for one real cash deposit. They look nothing alike and
 * they mean the same thing, so they share ONE registry — and a reference may be
 * claimed by exactly one order, ever.
 *
 * ── What was actually happening ────────────────────────────────────────────
 * Only the player's UTR was ever claimed. Two other paths wrote a reference
 * into a column and claimed nothing:
 *
 *   • `cdm_transaction_id` — a merchant submits the bank's id from a CDM slip
 *     as proof they paid out a withdrawal in cash. Nothing stopped the same id
 *     appearing on a second payout.
 *   • `usdt_tx_hash` on a merchant's token purchase — nothing stopped one
 *     payment funding two purchases of the platform's own inventory.
 *
 * Both were green under every check in this repository, because no check was
 * looking at the SHAPE of the problem — a column holding somebody else's
 * reference — only at individual handlers.
 *
 * ── What this refuses ──────────────────────────────────────────────────────
 * 1. A handler that TAKES a reference from `req.body` without claiming it.
 *
 *    That is the entry point, and it is the precise one. A first draft looked
 *    for the field appearing as an object key anywhere in a file, and flagged
 *    two RESPONSE payloads — `utrNumber: view.utrNumber` inside a `res.json` —
 *    as writes. A gate with false positives is a gate somebody adds an
 *    exception to, and the exception is where the next real one hides.
 * 2. A claim call that does not carry a `spec`, which is what decides the
 *    shape and the noun the refusal is phrased with.
 * 3. A second registry. `utr_registry` is the only table any of them may use,
 *    because two registries let one string be spent once on each.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { callsTo, topLevelKeys, blankComments } from './lib/privacyLists.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(ROOT, p);
const read = (p) => blankComments(readFileSync(p, 'utf8'));

/** The one owner. Every claim goes through this call. */
const CLAIM = 'claimPaymentReference';
const OWNER = join(ROOT, 'backend/domains/payment/paymentReference.js');

/**
 * The names an external payment reference arrives under, from a client.
 *
 * `utrNumber` is the player's bank reference or chain transaction hash on a
 * buy; `transactionId` the bank's id on a CDM slip; `usdtTxHash` the hash a
 * merchant gives when buying platform tokens with USDT.
 */
const REFERENCE_FIELDS = ['utrNumber', 'transactionId', 'usdtTxHash'];

/** Handlers that legitimately take one WITHOUT claiming, with the reason. */
const NO_CLAIM_ALLOW = new Map([
  ['backend/routes/admin/utr.admin.routes.js',
   'the review queue — an admin READS the registry and flags an already-claimed reference as fraud. Flagging is not claiming, and re-claiming it would be the defect.'],
]);

const failures = [];
const fail = (where, msg) => failures.push(`${where}: ${msg}`);

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (/\.m?js$/.test(name) && !/\.test\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

// ── 1. The owner exists and refuses on its own ──────────────────────────────
{
  const src = read(OWNER);
  if (!src.includes(`export async function ${CLAIM}`)) {
    fail(rel(OWNER), `does not export ${CLAIM}() — this gate names it as the one owner`);
  }
  // It must THROW on a refused claim. Returning a flag is a result a caller can
  // ignore, and the caller is about to write the reference either way.
  if (!/if\s*\(!claimed\.ok\)\s*\{[\s\S]{0,400}?throw/.test(src)) {
    fail(rel(OWNER), 'does not throw when the registry refuses — a returned flag is one a caller can ignore');
  }
}

// ── 2. Every reference a handler TAKES is claimed, BY NAME ──────────────────
//
// From `req.body`, which is where one enters this system.
//
// Per FIELD, not per file. A first draft asked only whether the file contained
// a claim anywhere, and `merchant.routes.js` has two — so deleting the CDM
// slip's claim left the token purchase's behind and the gate stayed green. The
// claim has to name the reference it is claiming.
function claimsFor(src) {
  return callsTo(src, CLAIM)
    .filter((c) => c.args.includes('{'))
    .map((c) => ({ ...c, keys: topLevelKeys(c.args) }));
}

for (const file of jsFiles(join(ROOT, 'backend'))) {
  const where = rel(file);
  if (NO_CLAIM_ALLOW.has(where)) continue;
  const src = read(file);
  if (!src.includes('req.body')) continue;

  // Destructured (`const { utrNumber } = req.body`) or reached directly
  // (`req.body.utrNumber`). Both are the same act.
  const taken = REFERENCE_FIELDS.filter((f) => (
    new RegExp(`req\\.body\\??\\.${f}\\b`).test(src)
    || new RegExp(`\\{[^}]*\\b${f}\\b[^}]*\\}\\s*=\\s*req\\.body`, 's').test(src)
  ));
  if (!taken.length) continue;

  // A route may be thin: `payment.routes.js` reads `utrNumber` off the body and
  // hands it to `markOrderPaid`, which claims. Refusing that would push the
  // claim up into every route — the opposite of one owner, and the shape that
  // lets two routes claim differently.
  //
  // ONE hop, deliberately. Following the whole call graph would accept a
  // handler four modules away from a claim that may not be on its path at all.
  const nearby = [src, ...[...src.matchAll(/from\s+'(\.[^']+\.js)'/g)]
    .map((m) => { try { return read(join(dirname(file), m[1])); } catch { return ''; } })];

  for (const field of taken) {
    // The claim that names THIS reference — here, or one hop away.
    const claim = nearby.flatMap(claimsFor)
      .find((c) => new RegExp(`\\breference\\s*:\\s*${field}\\b`).test(c.args));
    if (!claim) {
      fail(where, `takes '${field}' from the request and no ${CLAIM}() claims it`
        + ' — the same payment can then be presented twice');
      continue;
    }
    // ── 3. And the claim says what shape it is claiming ─────────────────────
    if (!claim.keys.includes('spec')) {
      fail(where, `claims '${field}' with no \`spec\` — nothing then decides what a valid`
        + ' one looks like, or what noun the refusal is phrased with');
    }
  }
}

// ── 4. There is ONE registry ────────────────────────────────────────────────
{
  const REGISTRY = 'utr_registry';
  const others = [];
  for (const file of jsFiles(join(ROOT, 'database'))) {
    const src = read(file);
    // A table whose name says it holds references, that is not the registry.
    for (const m of src.matchAll(/(?:INSERT INTO|UPDATE)\s+([a-z_]*(?:utr|tx_hash|reference)[a-z_]*)/gi)) {
      if (m[1].toLowerCase() !== REGISTRY) others.push({ file: rel(file), table: m[1] });
    }
  }
  for (const o of others) {
    fail(o.file, `writes '${o.table}' — a SECOND reference registry lets one string`
      + ` be spent once on each. ${REGISTRY} is the only one.`);
  }
}

if (failures.length) {
  console.error('\nPAYMENT REFERENCES: ' + failures.length + ' violation(s)\n');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('\nOne payment, one claim. A reference belongs to exactly one order, ever.\n');
  process.exit(1);
}
console.log('check:payment-references — every external payment reference is claimed once, through one registry.');
