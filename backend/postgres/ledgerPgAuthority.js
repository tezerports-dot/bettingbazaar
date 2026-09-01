// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/ledgerPgAuthority.js — the double-entry ledger, behind the resolver.
 *
 * `domains/revenue/revenueSettlement.service.js` is the ONLY way an entry
 * enters the ledger, and until now it wrote `AccountingEvent` documents
 * unconditionally. `postgres/ledgerPg.js` has existed alongside it for some
 * time with a full reader and writer, 16 tests and a derived trial balance —
 * and nothing read it. This module is what makes the choice real:
 * `isPostgresAuthoritative(MONEY_PATHS.LEDGER)` decides per call.
 *
 * ── Why this was gated on ORDERS ────────────────────────────────────────────
 * Order state produces most ledger events. `orderPg.transition()` posts the
 * accounting event in the SAME transaction as the state change, so once ORDERS
 * is authoritative in Postgres a completed deposit's event is ALREADY in
 * `accounting_events` before this module is asked about anything.
 *
 * Routing the ledger first would have inverted that: events posted into
 * Postgres for transitions Postgres never saw, and the transition-time events
 * arriving later as duplicates. They would collide on the idempotency key and
 * be reported as replays, so the books would survive — but every order-derived
 * event would then exist for a reason the transition history could not explain,
 * which is the thing an auditable ledger is for. Cause first, consequence
 * second. See docs/ORDERS_ROUTING_DESIGN.md.
 *
 * ── Minor units are the same unit, under two names ──────────────────────────
 * Mongo's postings carry `amountMinor`; Postgres carries `amountPaise`. Both
 * are integer paise — the rename is historical, not a conversion, and nothing
 * here multiplies or divides. Getting that wrong would be a hundredfold error
 * in the books, so the translation lives in ONE pair of functions below rather
 * than being repeated at each call site.
 *
 * ── Reads follow authority too ──────────────────────────────────────────────
 * A trial balance derived from Mongo while writes go to Postgres is a report
 * about a store that is no longer the source of truth, and it would read as
 * clean the whole time it was wrong. The plan's "reads before writes" ordering
 * is about the CUTOVER SEQUENCE — read paths are exercised against Postgres
 * before it starts taking writes — not a licence to leave reads pointing at the
 * old store afterwards.
 */
import { isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';
import {
  recordEvent as pgRecordEvent, getEvent as pgGetEvent, getLedger as pgGetLedger,
  trialBalance as pgTrialBalance, accountBalancePaise as pgAccountBalance,
} from './ledgerPg.js';

/** Is Postgres the source of truth for the accounting ledger? */
export const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.LEDGER);

/**
 * `{account, amountMinor}` → `{account, amountPaise}`. Same integer, other name.
 * Non-integer input is refused rather than rounded: a fractional paise in the
 * books is a bug upstream, and silently truncating it would hide the bug and
 * break the conserve-to-zero constraint at the same time.
 */
function toPgPostings(postings) {
  return postings.map((p) => {
    if (!Number.isInteger(p.amountMinor)) {
      throw new TypeError(`posting '${p.account}': amountMinor must be an integer paise value, got ${p.amountMinor}`);
    }
    return { account: p.account, amountPaise: p.amountMinor };
  });
}

/** The inverse, for handing a Postgres row back in the vocabulary callers use. */
function toMongoShape(event) {
  if (!event) return null;
  return {
    idempotencyKey: event.idempotencyKey,
    eventType:      event.eventType,
    amountMinor:    event.amountPaise,
    refModel:       event.refModel,
    refId:          event.refId,
    postings:       (event.postings ?? []).map((p) => ({ account: p.account, amountMinor: Number(p.amountPaise) || 0 })),
    description:    event.description,
    createdAt:      event.createdAt,
  };
}

/**
 * Post an accounting event, with Postgres deciding when it owns the ledger.
 *
 * Returns `{ handled: false }` when Mongo is authoritative, which tells
 * revenueSettlement to write the AccountingEvent itself. Anything else is the
 * final answer.
 *
 * `idempotent: true` comes back when the key already exists. That is not an
 * error and must not be turned into one — the reconcilers that call this replay
 * the same completed orders every pass, and treating "already recorded" as a
 * failure would make an ordinary reconcile look like a broken ledger.
 */
export async function recordEventOnPostgres({
  eventType, idempotencyKey, postings, refModel = null, refId = null,
  occurredAt = null, description = null, amountMinor = null,
}) {
  if (!onPostgres()) return { handled: false };

  const result = await pgRecordEvent({
    eventType, idempotencyKey,
    postings: toPgPostings(postings),
    refModel, refId: refId == null ? null : String(refId),
    description,
    amountPaise: amountMinor,
    createdAt: occurredAt,
  });

  // Fetched rather than assumed on the idempotent branch: the row that already
  // EXISTS is the event this call must report, not the one it tried to write.
  // A replay under the same key returns the original posting, which is what
  // makes the idempotency gate observable to the caller rather than silent.
  const stored = result.event ?? await pgGetEvent(idempotencyKey);

  return {
    handled: true,
    idempotent: Boolean(result.idempotent),
    event: toMongoShape(stored),
  };
}

/**
 * The trial balance, in the shape `getTrialBalance()` has always returned.
 *
 * Callers (the admin ledger view, the certification report,
 * `trialBalanceCompare`) branch on `integrityOk` and index `accounts` by code,
 * so the Postgres answer is translated into that vocabulary rather than
 * exposing a second one. `ok` there already folds in a check Mongo has no
 * equivalent for — postings against an account that is not in the chart — and
 * that must not be dropped on the way through: an unknown account balances
 * perfectly against nothing anyone can name.
 */
export async function trialBalanceOnPostgres() {
  if (!onPostgres()) return { handled: false };

  const pg = await pgTrialBalance();
  const accounts = {};
  for (const [code, a] of Object.entries(pg.accounts)) {
    accounts[code] = {
      account:       code,
      normalBalance: a.normalBalance,
      description:   a.description,
      rawMinor:      a.rawPaise,
      reportedMinor: a.reportedPaise,
      postings:      a.postings,
    };
  }
  return {
    handled: true,
    accounts,
    integrityOk: pg.ok,
    grandTotalMinor: pg.grandTotalPaise,
    unknownAccounts: pg.unknownAccounts,
  };
}

/** One account's reported balance in minor units. */
export async function accountBalanceOnPostgres(accountCode) {
  if (!onPostgres()) return { handled: false };
  return { handled: true, reportedMinor: await pgAccountBalance(accountCode) };
}

/** A page of the ledger, in the shape getLedger() returns. */
export async function getLedgerOnPostgres({ page = 1, limit = 50, eventType = null } = {}) {
  if (!onPostgres()) return { handled: false };
  const pg = await pgGetLedger({ page, limit, eventType });
  return {
    handled: true,
    entries: pg.entries.map(toMongoShape),
    total: pg.total,
    page: pg.page,
    pages: pg.pages,
  };
}
