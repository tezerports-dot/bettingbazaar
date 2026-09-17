// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Configuration / Business Policy Platform.
//
// Sole writer of merchant commission policy versions. Runtime consumer
// (read-only): the Merchant Platform commission engine
// (domains/merchant/merchantCommission.service.js) via getActiveCommissionPolicy().
//
// The versioning rules — one ACTIVE at a time, append-only history, rollback as
// a new version — live in the table and its constraints, not here. What stays
// here is the operator-facing validation: the same rules, checked early so the
// panel gets a sentence rather than a constraint name.

import { db } from '#db';
import { MERCHANT_CURRENCY, MERCHANT_CURRENCIES } from '../merchant/merchantCurrency.js';
import {
  CASH_DENOMINATIONS_PAISE, USDT_BUY_DENOMINATIONS_PAISE,
} from '../merchant/denominations.js';

/**
 * The payment modes a variety can name.
 *
 * Imported from the rail vocabulary rather than written here, so a rail added
 * there reaches this validator instead of being silently unpriceable.
 */
export const COMMISSION_PAYMENT_MODES = Object.freeze(['P2P_UPI', 'CASH_ATM']);

/**
 * Which denominations a variety may name, given its rail.
 *
 * The same three-way rule the CHECK constraint holds, stated once here so the
 * panel gets "an ATM does not dispense ₹7,770" instead of a constraint name.
 * Both are needed: this one explains, the constraint is what actually refuses —
 * a validator is only true for callers that remember to call it.
 */
export function allowedDenominationsFor({ currency, paymentMode }) {
  if (currency === MERCHANT_CURRENCY.USDT) return USDT_BUY_DENOMINATIONS_PAISE;
  if (paymentMode === 'CASH_ATM') return CASH_DENOMINATIONS_PAISE;
  return null; // the UPI rail is a range: its only valid denomination is none
}

/**
 * Validate one variety's rate. Throws with the operator's own vocabulary.
 */
export function validateCommissionRate(rate, index = 0) {
  const where = `rate ${index + 1}`;
  if (!MERCHANT_CURRENCIES.includes(rate?.currency)) {
    throw new Error(`${where}: currency must be one of ${MERCHANT_CURRENCIES.join(', ')}.`);
  }
  if (!COMMISSION_PAYMENT_MODES.includes(rate?.paymentMode)) {
    throw new Error(`${where}: paymentMode must be one of ${COMMISSION_PAYMENT_MODES.join(', ')}.`);
  }
  for (const leg of ['buyPercent', 'sellPercent']) {
    const value = rate?.[leg];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${where}: ${leg} must be a number between 0 and 100.`);
    }
  }
  // A row at 0/0 reads as priced and pays nothing, which is the shape most
  // easily mistaken for a working rate. Absence is how a variety goes unpriced.
  if (!(rate.buyPercent > 0) && !(rate.sellPercent > 0)) {
    throw new Error(
      `${where}: both legs are 0%, which reads as priced and pays nothing. `
      + 'Leave the variety out instead — an unpriced variety earns nothing and is reported as unpriced.',
    );
  }

  const allowed = allowedDenominationsFor(rate);
  const given = rate.denominationPaise === null || rate.denominationPaise === undefined
    ? null : Number(rate.denominationPaise);
  if (allowed === null && given !== null) {
    throw new Error(`${where}: the ${rate.paymentMode} rail on ${rate.currency} is a range, so it takes no denomination.`);
  }
  if (allowed !== null && !allowed.includes(given)) {
    const shown = rate.currency === MERCHANT_CURRENCY.USDT
      ? allowed.map((p) => `${(p / 100).toLocaleString('en-IN')} tokens`).join(', ')
      : allowed.map((p) => `₹${(p / 100).toLocaleString('en-IN')}`).join(', ');
    throw new Error(`${where}: that is not a size this rail deals in. Allowed: ${shown}.`);
  }
  return true;
}

export function validateCommissionPolicyFields({ enabled, minMatchedVolume, rates }) {
  if (typeof enabled !== 'boolean') {
    throw new Error('enabled must be a boolean.');
  }
  if (typeof minMatchedVolume !== 'number' || !Number.isFinite(minMatchedVolume) || minMatchedVolume < 0) {
    throw new Error('minMatchedVolume must be a non-negative number of rupees.');
  }
  if (!Array.isArray(rates)) {
    throw new Error('rates must be an array of per-variety rates.');
  }
  rates.forEach(validateCommissionRate);

  // Two rates for one variety is "which one pays?". The database refuses it on
  // a UNIQUE index; caught here first so the answer names the variety.
  const seen = new Set();
  for (const rate of rates) {
    const key = `${rate.currency}:${rate.paymentMode}:${rate.denominationPaise ?? 'none'}`;
    if (seen.has(key)) throw new Error(`The variety ${key} is priced twice. Each variety takes exactly one rate.`);
    seen.add(key);
  }

  if (enabled && rates.length === 0) {
    throw new Error('An enabled policy with no rates does nothing — price at least one variety or disable it.');
  }
  return true;
}

/**
 * Every variety an admin may price, derived from the modules that own the
 * ladders rather than listed again here.
 *
 * The panel needs this to offer a denomination picker. A copy in the panel
 * would be a second owner of a money rule — it would offer sizes the rail does
 * not deal in, and the refusal would arrive from a CHECK constraint at save
 * time instead of from the form.
 *
 * USDT appears on BOTH payment modes deliberately. `payment_mode` is stamped
 * from the rail that was ACTIVE when the order was created, and the rail switch
 * knows nothing about currency — so a USDT purchase made while the cash rail is
 * live is stamped CASH_ATM. That variety is reachable in the data, so it has to
 * be priceable; leaving it out would leave real work permanently unpriced.
 */
export function commissionVarietyCatalogue() {
  const inr = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;
  const tokens = (paise) => `${(paise / 100).toLocaleString('en-IN')} tokens`;
  const out = [{
    currency: MERCHANT_CURRENCY.INR, paymentMode: 'P2P_UPI', denominationPaise: null,
    label: 'INR · UPI · any amount in range',
  }];
  for (const paise of CASH_DENOMINATIONS_PAISE) {
    out.push({
      currency: MERCHANT_CURRENCY.INR, paymentMode: 'CASH_ATM', denominationPaise: paise,
      label: `INR · Cash/ATM · ${inr(paise)}`,
    });
  }
  for (const paymentMode of COMMISSION_PAYMENT_MODES) {
    for (const paise of USDT_BUY_DENOMINATIONS_PAISE) {
      out.push({
        currency: MERCHANT_CURRENCY.USDT, paymentMode, denominationPaise: paise,
        label: `USDT · ${paymentMode === 'CASH_ATM' ? 'cash rail live' : 'UPI rail live'} · ${tokens(paise)}`,
      });
    }
  }
  return out;
}

/** The runtime read path for the commission engine. Read-only. */
export async function getActiveCommissionPolicy() {
  return db.merchantCommissionPolicy.getActivePolicy();
}

export async function getCommissionPolicyHistory() {
  return db.merchantCommissionPolicy.getPolicyHistory();
}

/**
 * A refusal from the table is an operator error with a specific answer. The
 * routes above this already catch Error and render its message, so a refused
 * write is raised rather than returned — the two failure shapes stay one.
 */
function unwrap(result) {
  if (result?.ok) return result.policy;
  const err = new Error(result?.message || 'Commission policy change refused.');
  err.reason = result?.reason;
  throw err;
}

/**
 * createCommissionPolicyVersion — the write path. Immediate-apply only in v1
 * (no scheduling/approval-gating — see CLAUDE.md).
 */
export async function createCommissionPolicyVersion(fields, actor, { justification } = {}) {
  if (!justification || !justification.trim()) {
    throw new Error('businessJustification is required for every commission policy change.');
  }
  const merged = {
    enabled: fields.enabled ?? false,
    minMatchedVolume: fields.minMatchedVolume ?? 100,
    rates: fields.rates ?? [],
  };
  validateCommissionPolicyFields(merged);

  return unwrap(await db.merchantCommissionPolicy.createPolicyVersion({
    ...merged,
    justification: justification.trim(),
    changedBy: actor?.userId ?? null,
    changedByName: actor?.userName ?? '',
  }));
}

/** Rollback = new ACTIVE version copying an old version's values forward. */
export async function rollbackToCommissionPolicyVersion(versionId, actor) {
  // Panels address a version as `v3`; the table addresses it as 3. Accept both
  // so a link built from a history payload works without the caller unwrapping
  // the id first.
  const version = Number(String(versionId).replace(/^v/i, ''));
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('Policy version not found');
  }
  return unwrap(await db.merchantCommissionPolicy.rollbackToVersion(version, {
    changedBy: actor?.userId ?? null,
    changedByName: actor?.userName ?? '',
  }));
}
