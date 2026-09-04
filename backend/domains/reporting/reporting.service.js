// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/reporting/reporting.service.js — read-only reports.
 *
 * Everything here is DERIVED from the authoritative records: the settlement
 * ledger (financial truth), the order lifecycle (funding), and the bonus and
 * wallet ledgers. This platform stores nothing, mutates nothing, and never
 * re-computes business math — it aggregates what the owning platforms already
 * recorded.
 *
 * ── What the rewrite changed ────────────────────────────────────────────────
 *
 * The FINANCIAL report counted entries with a separate `countDocuments`. That
 * is a second read of a table that accepts an event between the two, so the
 * count and the movement it summarised described different instants. Counted in
 * the same query now.
 *
 * The MERCHANT report ran three aggregates and merged them into a keyed object
 * by mutating rows in two loops, with the second loop re-defaulting the first
 * loop's fields for a merchant who had a bonus but no orders. It is a FULL
 * OUTER JOIN: a merchant appears if either side has anything for them, said
 * once instead of maintained in two places. Its merchant lookup was also a scan
 * of every merchant on the platform, to attach a username to the handful in the
 * results.
 *
 * The REGULATORY EXPORT expanded each event's postings in JavaScript, so its
 * `limit` bounded EVENTS rather than rows — a ten-thousand-event limit could
 * return forty thousand rows, and an export that was meant to be bounded was
 * not. The flattening happens in the database, so the limit means what it says.
 */
import { db } from '#db';
import { ACCOUNTS, ACCOUNT_CODES } from '../revenue/chartOfAccounts.js';

const rupees = (paise) => Math.round(paise) / 100;

/**
 * financialReport — period activity per ledger account (movement, not just
 * closing balance) plus per-event-type totals.
 *
 * The regulatory-grade view: every figure traces to append-only journal
 * entries. Accounts with no activity in the period are included as zeroes,
 * because "nothing moved through PROMOTIONAL_LIABILITY in March" is an answer
 * and a missing row is not.
 */
export async function financialReport({ from, to } = {}) {
  const [activity, totals] = await Promise.all([
    db.ledger.accountActivity({ from, to }),
    db.ledger.eventTypeTotals({ from, to }),
  ]);

  const byAccount = new Map(activity.map((a) => [a.account, a]));

  const accounts = ACCOUNT_CODES.map((code) => {
    const row = byAccount.get(code) ?? { debitPaise: 0, creditPaise: 0, netPaise: 0 };
    const normal = ACCOUNTS[code].normalBalance;
    return {
      account: code,
      normalBalance: normal,
      debit: rupees(row.debitPaise),
      credit: rupees(row.creditPaise),
      // A CREDIT-normal account grows with negative postings, so its movement
      // is negated to read as a positive figure. Getting this backwards renders
      // a profitable period as a loss.
      netMovement: rupees(normal === 'CREDIT' ? -row.netPaise : row.netPaise),
    };
  });

  return {
    period: { from: from || null, to: to || null },
    entryCount: totals.totalEvents,
    accounts,
    eventTypes: totals.byEventType,
  };
}

/** settlementReport — daily settlement ledger activity, chart and export ready. */
export async function settlementReport({ from, to } = {}) {
  const days = await db.ledger.dailyActivity({ from, to });
  return days.map((d) => ({
    day: d.day,
    totalEvents: d.totalEvents,
    byEventType: d.byEventType.map((e) => ({
      eventType: e.eventType,
      events: e.events,
      gross: rupees(e.grossPaise),
    })),
  }));
}

/** merchantReport — per-merchant funding and bonus activity over a period. */
export function merchantReport({ from, to } = {}) {
  return db.stats.merchantActivityReport({ from, to });
}

/**
 * regulatoryLedgerExport — one flat row per journal POSTING in a period,
 * suitable for CSV export and external audit.
 */
export async function regulatoryLedgerExport({ from, to, limit = 10000 } = {}) {
  const rows = await db.ledger.postingExport({ from, to, limit });
  return rows.map((r) => ({
    entryId: r.entryId,
    occurredAt: r.occurredAt,
    recordedAt: r.recordedAt,
    eventType: r.eventType,
    idempotencyKey: r.idempotencyKey,
    refModel: r.refModel,
    refId: r.refId,
    account: r.account,
    side: r.side,
    // A string with two decimals, because a spreadsheet opening this file must
    // not reformat a currency column as a float.
    amountINR: rupees(r.amountPaise).toFixed(2),
    description: r.description,
  }));
}

// toCsv lives in the pure ./csv.util.js so the CPU worker can import it without
// pulling the data layer into the worker thread. Re-exported here so callers
// and tests that import it from this service keep working unchanged.
export { toCsv } from './csv.util.js';
