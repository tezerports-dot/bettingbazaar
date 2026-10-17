// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * postgres/ledgerPgAuthority.js — the double-entry ledger, behind the resolver.
 *
 * `domains/revenue/revenueSettlement.service.js` is the ONLY way an entry
 * enters the ledger, and until now it wrote `AccountingEvent` documents
 * unconditionally. `postgres/ledgerPg.js` has existed alongside it for some
 * time with a full reader and writer, 16 tests and a derived trial balance —
 * and nothing read it. This module is what makes the choice real:
 * `true` decides per call.
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
 * Older postings carried `amountMinor`; these carry `amountPaise`. Both
 * are integer paise — the rename is historical, not a conversion, and nothing
 * here multiplies or divides. Getting that wrong would be a hundredfold error
 * in the books, so the translation lives in ONE pair of functions below rather
 * than being repeated at each call site.
 *
 * ── Reads follow authority too ──────────────────────────────────────────────
 * A trial balance derived from anything but the rows the writes landed in is a report
 * about a store that is no longer the source of truth, and it would read as
 * clean the whole time it was wrong. The plan's "reads before writes" ordering
 * is about the CUTOVER SEQUENCE — read paths are exercised against Postgres
 * before it starts taking writes — not a licence to leave reads pointing at the
 * old store afterwards.
 */
import {
  recordEvent as pgRecordEvent, getEvent as pgGetEvent, getLedger as pgGetLedger,
  trialBalance as pgTrialBalance, accountBalancePaise as pgAccountBalance,
} from './ledger.core.js';
import { withTransaction, pgQuery } from '../client.js';

/** Is Postgres the source of truth for the accounting ledger? */

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
function toCallerShape(event) {
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
 * Post an accounting event.
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
    idempotent: Boolean(result.idempotent),
    event: toCallerShape(stored),
  };
}

/**
 * The trial balance, in the shape `getTrialBalance()` has always returned.
 *
 * Callers (the admin ledger view, the certification report) branch on
 * `integrityOk` and index `accounts` by code, so the answer is translated into
 * that vocabulary rather than exposing a second one.
 *
 * `unknownAccounts` is carried through and must not be dropped: a posting
 * against an account that is not in the chart balances perfectly against
 * nothing anyone can name, so a ledger can be internally consistent and still
 * describe money nobody can account for.
 */
export async function trialBalanceOnPostgres() {

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
    accounts,
    integrityOk: pg.ok,
    grandTotalMinor: pg.grandTotalPaise,
    unknownAccounts: pg.unknownAccounts,
  };
}

/**
 * Record an event that spends from one account, only if that account's
 * reported balance covers it, in ONE transaction under a lock on the account
 * (§32 S6). Two admins funding the commission pool at once each read the
 * same distributable revenue and could jointly spend more than there was; the
 * second now waits for the first and reads what it left.
 *
 * Answers `{ refused: { availableMinor } }` when the balance is short, else
 * what `recordEventOnPostgres` answers.
 */
export async function recordSpendCoveredOnPostgres({
  spendAccount, spendMinor, eventType, idempotencyKey, postings,
  refModel = null, refId = null, occurredAt = null, description = null,
}) {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ledger_spend:${spendAccount}`]);
    // A replay of the same key is answered before the balance is asked: the
    // spend it repeats is already inside the balance.
    const existing = await pgGetEvent(idempotencyKey, { client });
    if (existing) return { idempotent: true, event: toCallerShape(existing) };
    const availableMinor = Math.max(0, await pgAccountBalance(spendAccount, { client }));
    if (spendMinor > availableMinor) return { refused: { availableMinor } };
    const result = await pgRecordEvent({
      eventType, idempotencyKey, postings: toPgPostings(postings),
      refModel, refId: refId == null ? null : String(refId),
      description, createdAt: occurredAt, client,
    });
    const stored = result.event ?? await pgGetEvent(idempotencyKey, { client });
    return { idempotent: Boolean(result.idempotent), event: toCallerShape(stored) };
  });
}

/**
 * Casino rounds whose net to the house (debited − credited − refunded) differs
 * from what the ledger has booked for them (the USER_FUNDS legs of their
 * CASINO_ROUND_NET events), untouched for `settleSeconds` so a round still in
 * play is not booked and reversed every pass. `deltaPaise` is what to book.
 */
export async function findCasinoRoundsUnbooked({ limit = 200, settleSeconds = 300 } = {}) {
  const { rows } = await pgQuery(
    `SELECT r.id::text AS id, r.provider_key, r.round_id, r.updated_at,
            r.debited_paise, r.credited_paise, r.refunded_paise,
            (r.debited_paise - r.credited_paise - r.refunded_paise) - COALESCE(b.booked, 0) AS delta_paise
       FROM casino_rounds r
       LEFT JOIN LATERAL (
         SELECT SUM((p->>'amountPaise')::BIGINT) AS booked
           FROM accounting_events e, jsonb_array_elements(e.postings) p
          WHERE e.ref_model = 'CasinoRound' AND e.ref_id = r.id::text AND p->>'account' = 'USER_FUNDS'
       ) b ON TRUE
      WHERE r.updated_at < now() - make_interval(secs => $2)
        AND (r.debited_paise - r.credited_paise - r.refunded_paise) <> COALESCE(b.booked, 0)
      ORDER BY r.updated_at
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000), settleSeconds], 'ledger_casino_unbooked',
  );
  return rows.map((r) => ({
    id: r.id, providerKey: r.provider_key, roundId: r.round_id, updatedAt: r.updated_at,
    debitedPaise: Number(r.debited_paise), creditedPaise: Number(r.credited_paise),
    refundedPaise: Number(r.refunded_paise), deltaPaise: Number(r.delta_paise),
  }));
}

/** General bonuses (`promo_grants`) with no PROMO_BONUS_PAID event yet. */
export async function findPromoGrantsUnbooked({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT g.grant_id, g.source, g.amount_paise, g.created_at
       FROM promo_grants g
       LEFT JOIN accounting_events e ON e.ref_model = 'PromoGrant' AND e.ref_id = g.grant_id
      WHERE e.id IS NULL
      ORDER BY g.created_at
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'ledger_promo_unbooked',
  );
  return rows.map((r) => ({
    grantId: r.grant_id, source: r.source, amountPaise: Number(r.amount_paise), createdAt: r.created_at,
  }));
}

/** Dispute compensations (`dispute_compensations`) with no DISPUTE_COMPENSATION event yet. */
export async function findCompensationsUnbooked({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT c.order_id, c.percent, c.amount_paise, c.created_at
       FROM dispute_compensations c
       LEFT JOIN accounting_events e ON e.ref_model = 'DisputeCompensation' AND e.ref_id = c.order_id
      WHERE e.id IS NULL
      ORDER BY c.created_at
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'ledger_compensation_unbooked',
  );
  return rows.map((r) => ({
    orderId: r.order_id, percent: Number(r.percent), amountPaise: Number(r.amount_paise), createdAt: r.created_at,
  }));
}

/** One account's reported balance in minor units. */
export async function accountBalanceOnPostgres(accountCode) {
  return { reportedMinor: await pgAccountBalance(accountCode) };
}

/** A page of the ledger, in the shape getLedger() returns. */
export async function getLedgerOnPostgres({ page = 1, limit = 50, eventType = null } = {}) {
  const pg = await pgGetLedger({ page, limit, eventType });
  return {
    entries: pg.entries.map(toCallerShape),
    total: pg.total,
    page: pg.page,
    pages: pg.pages,
  };
}
