// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/merchantCommissionPolicy.js — what a merchant earns, per variety
 * of work.
 *
 * Supersedes `merchantBonusPolicy.js`, which held ONE percentage for every kind
 * of work. The basis did not change — matched buy->sell volume, paid once, from
 * the platform-funded pool — only the rate, which is now looked up per
 * (currency, payment_mode, denomination).
 *
 * ── A version owns its rates ────────────────────────────────────────────────
 * The rates are written in the SAME transaction as the version that carries
 * them and are never edited afterwards. Editing a rate in place would make
 * "what was this merchant paid under?" unanswerable the moment an admin changed
 * their mind, and that question is the whole reason the policy is versioned.
 *
 * A rate row per variety, rather than a JSONB column holding all of them,
 * because the things that must be impossible — two rates for one variety, a
 * denomination the rail does not deal in, a percentage above 100 — are
 * constraints the database can hold on a row and cannot hold inside a document.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * `min_matched_volume` is RUPEES, deliberately: it is a threshold an admin types
 * into a panel, converted to minor units at the single point the engine compares
 * it. `denomination_paise` is the minor unit of whatever the VARIETY is
 * denominated in — rupee paise on the cash rail, token paise on USDT — which is
 * why the currency is part of the key and not a fact hanging off the row.
 */
import { pgQuery, withTransaction } from '../client.js';

const toRate = (r) => ({
  currency: r.currency,
  paymentMode: r.payment_mode,
  denominationPaise: r.denomination_paise === null ? null : Number(r.denomination_paise),
  buyPercent: Number(r.buy_percent),
  sellPercent: Number(r.sell_percent),
});

const toPolicy = (r, rates = []) => (r ? {
  id: Number(r.id),
  // Callers address a version as `v3`, the same shape deposit policy and the
  // policy this replaces both use.
  _id: `v${r.version}`,
  version: Number(r.version),
  status: r.status,
  enabled: r.enabled,
  minMatchedVolume: Number(r.min_matched_volume),
  rates,
  isRollback: r.is_rollback,
  rollbackOfVersion: r.rollback_of_version === null ? null : Number(r.rollback_of_version),
  businessJustification: r.justification,
  changedBy: r.changed_by,
  changedByName: r.changed_by_name,
  createdAt: r.created_at,
  supersededAt: r.superseded_at,
} : null);

/**
 * Every rate belonging to a set of policy versions, grouped by version.
 *
 * One statement for N versions rather than a query per version: the history
 * endpoint renders every version's rates, and a per-row read there is the
 * ordinary way a list page becomes N+1 queries against the money database.
 */
async function ratesByVersion(versions) {
  if (!versions.length) return {};
  const { rows } = await pgQuery(
    `SELECT * FROM merchant_commission_rates
      WHERE policy_version = ANY($1::BIGINT[])
      ORDER BY currency, payment_mode, denomination_paise NULLS FIRST`,
    [versions], 'merchant_commission_rates_by_version',
  );
  const out = {};
  for (const r of rows) {
    const v = Number(r.policy_version);
    (out[v] = out[v] || []).push(toRate(r));
  }
  return out;
}

/** The policy the engine pays under. One row, by construction. */
export async function getActivePolicy() {
  const { rows } = await pgQuery(
    "SELECT * FROM merchant_commission_policies WHERE status = 'ACTIVE'",
    [], 'merchant_commission_policy_active',
  );
  if (!rows[0]) return null;
  const rates = await ratesByVersion([Number(rows[0].version)]);
  return toPolicy(rows[0], rates[Number(rows[0].version)] || []);
}

/** Every version, newest first, each with the rates it was written with. */
export async function getPolicyHistory({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM merchant_commission_policies
      ORDER BY version DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    [], 'merchant_commission_policy_history',
  );
  const rates = await ratesByVersion(rows.map((r) => Number(r.version)));
  return rows.map((r) => toPolicy(r, rates[Number(r.version)] || []));
}

/** One version by its number. Used by rollback to read the values forward. */
export async function getPolicyVersion(version) {
  const { rows } = await pgQuery(
    'SELECT * FROM merchant_commission_policies WHERE version = $1',
    [Number(version)], 'merchant_commission_policy_version',
  );
  if (!rows[0]) return null;
  const rates = await ratesByVersion([Number(version)]);
  return toPolicy(rows[0], rates[Number(version)] || []);
}

/**
 * Map a constraint violation onto the operator error it actually is.
 *
 * These are answerable mistakes ("an ATM does not dispense ₹7,770"), not 500s,
 * so they come back as a refusal carrying a reason the panel can render.
 */
function refusal(err) {
  if (err.constraint === 'merchant_commission_rates_denomination_matches_rail') {
    return { ok: false, reason: 'DENOMINATION_NOT_ON_RAIL',
      message: 'That denomination is not one this rail deals in. The cash rail dispenses ₹500, ₹1,000, ₹5,000, ₹10,000 and ₹40,000; a USDT purchase is 50,000, 100,000 or 500,000 tokens; the UPI rail is a range and takes no denomination.' };
  }
  if (err.constraint === 'merchant_commission_rates_pays_something') {
    return { ok: false, reason: 'RATE_PAYS_NOTHING',
      message: 'A rate of 0% on both legs reads as priced and pays nothing. Remove the variety instead — an unpriced variety earns nothing and is reported as unpriced.' };
  }
  if (err.constraint === 'merchant_commission_rates_percent_range') {
    return { ok: false, reason: 'PERCENT_OUT_OF_RANGE',
      message: 'Each leg must be between 0 and 100 percent.' };
  }
  if (err.constraint === 'merchant_commission_rates_currency_known'
   || err.constraint === 'merchant_commission_rates_mode_known') {
    return { ok: false, reason: 'VARIETY_UNKNOWN',
      message: 'Unknown currency or payment mode. The rails are INR and USDT, over P2P_UPI or CASH_ATM.' };
  }
  if (err.constraint === 'merchant_commission_policies_volume_range') {
    return { ok: false, reason: 'VOLUME_NEGATIVE',
      message: 'minMatchedVolume cannot be negative.' };
  }
  if (err.constraint === 'merchant_commission_policies_justified') {
    return { ok: false, reason: 'JUSTIFICATION_REQUIRED',
      message: 'businessJustification is required for every commission policy change.' };
  }
  // Both variety indexes are UNIQUE, so a duplicated variety arrives as 23505
  // alongside the ordinary concurrent-change collision on `version`. The index
  // name is what tells them apart, and they are different operator mistakes.
  if (err.code === '23505'
   && String(err.constraint || '').startsWith('merchant_commission_rates_variety')) {
    return { ok: false, reason: 'VARIETY_PRICED_TWICE',
      message: 'The same variety is priced twice in this version. Each combination of rail, payment mode and denomination takes exactly one rate.' };
  }
  if (err.code === '23505') {
    return { ok: false, reason: 'CONCURRENT_CHANGE',
      message: 'Another change to this policy landed first. Reload and try again.' };
  }
  return null;
}

/**
 * The write path. Supersede, insert the version, insert its rates — one
 * transaction, so a version can never exist without the rates it was saved
 * with, and a half-priced policy can never be read by the engine.
 *
 * The version number is assigned by the INSERT itself (`MAX(version) + 1` as a
 * subquery) rather than read first and passed in: a read-then-write hands two
 * concurrent admins the same number, and the UNIQUE then fails the second one
 * AFTER it has already superseded the live policy.
 */
export async function createPolicyVersion({
  enabled = false, minMatchedVolume = 100, rates = [],
  justification = '', changedBy = null, changedByName = '',
  isRollback = false, rollbackOfVersion = null,
} = {}) {
  try {
    return await withTransaction(async (client) => {
      await client.query(
        `UPDATE merchant_commission_policies SET status = 'SUPERSEDED', superseded_at = now()
          WHERE status = 'ACTIVE'`,
      );
      const { rows } = await client.query(
        `INSERT INTO merchant_commission_policies
           (version, status, enabled, min_matched_volume,
            is_rollback, rollback_of_version, justification, changed_by, changed_by_name)
         VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM merchant_commission_policies),
                 'ACTIVE', $1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [Boolean(enabled), Number(minMatchedVolume),
          Boolean(isRollback), rollbackOfVersion === null ? null : Number(rollbackOfVersion),
          String(justification ?? '').trim(), changedBy, String(changedByName ?? '')],
      );
      const version = Number(rows[0].version);

      const saved = [];
      for (const rate of rates) {
        const { rows: rateRows } = await client.query(
          `INSERT INTO merchant_commission_rates
             (policy_version, currency, payment_mode, denomination_paise, buy_percent, sell_percent)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [version, rate.currency, rate.paymentMode,
            rate.denominationPaise === null || rate.denominationPaise === undefined
              ? null : Number(rate.denominationPaise),
            Number(rate.buyPercent || 0), Number(rate.sellPercent || 0)],
        );
        saved.push(toRate(rateRows[0]));
      }
      return { ok: true, policy: toPolicy(rows[0], saved) };
    });
  } catch (err) {
    const refused = refusal(err);
    if (refused) return refused;
    throw err;
  }
}

/**
 * Rollback — a NEW ACTIVE version carrying an old version's values, rates
 * included, forward.
 *
 * Never a status flip on the old row: reviving a superseded version would erase
 * the fact that it was ever replaced, and the history is the point of the table.
 */
export async function rollbackToVersion(version, { changedBy = null, changedByName = '' } = {}) {
  const target = await getPolicyVersion(version);
  if (!target) return { ok: false, reason: 'NOT_FOUND', message: 'Policy version not found' };

  return createPolicyVersion({
    enabled: target.enabled,
    minMatchedVolume: target.minMatchedVolume,
    rates: target.rates,
    justification: `Rollback to v${target.version}`,
    changedBy,
    changedByName,
    isRollback: true,
    rollbackOfVersion: target.version,
  });
}
