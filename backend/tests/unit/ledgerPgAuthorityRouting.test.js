// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Ledger routing — which store owns an accounting event, and whether the answer
 * comes back in the vocabulary callers already speak.
 *
 * No database. These assert the DECISION and the TRANSLATION. The ledger's own
 * behaviour — double entry enforced by the database, the derived trial balance,
 * the single-INSERT idempotency gate — is proven against a real PostgreSQL in
 * tests/postgres/ledgerPg.test.js.
 *
 * ── The translation is the risky part ───────────────────────────────────────
 * Mongo's postings carry `amountMinor`; Postgres carries `amountPaise`. Both
 * are integer paise and the rename is historical, not a conversion — but a
 * mistake there is a hundredfold error in the books that every downstream
 * conservation check would then report as drift for the wrong reason. So the
 * mapping is asserted in both directions.
 *
 * ── The OFF position is tested first ────────────────────────────────────────
 * This adapter spends its production life switched off. Every call must fall
 * straight through to the Mongo implementation without touching Postgres, and a
 * bug there breaks the live ledger rather than the migration.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const onPostgres = new Set();
vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: (path) => onPostgres.has(path) };
});

const ledgerPg = {
  recordEvent: vi.fn(), getEvent: vi.fn(), getLedger: vi.fn(),
  trialBalance: vi.fn(), accountBalancePaise: vi.fn(),
};
vi.mock('../../postgres/ledgerPg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordEvent:         (...a) => ledgerPg.recordEvent(...a),
    getEvent:            (...a) => ledgerPg.getEvent(...a),
    getLedger:           (...a) => ledgerPg.getLedger(...a),
    trialBalance:        (...a) => ledgerPg.trialBalance(...a),
    accountBalancePaise: (...a) => ledgerPg.accountBalancePaise(...a),
  };
});

const reverse = { accountingEvent: vi.fn() };
vi.mock('../../postgres/reverseMirror.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reverseMirrorAccountingEvent: (...a) => reverse.accountingEvent(...a) };
});

import { MONEY_PATHS } from '../../postgres/moneyAuthority.js';
import { EVENT_TYPES, ACCOUNTS } from '../../domains/revenue/chartOfAccounts.js';
import {
  onPostgres as isOn, recordEventOnPostgres, trialBalanceOnPostgres,
  accountBalanceOnPostgres, getLedgerOnPostgres,
} from '../../postgres/ledgerPgAuthority.js';

const EVENT = {
  eventType: EVENT_TYPES.DEPOSIT_COMPLETED,
  idempotencyKey: 'dep_1',
  postings: [
    { account: ACCOUNTS.EXTERNAL_FIAT.code, amountMinor: 50_000 },
    { account: ACCOUNTS.USER_FUNDS.code,    amountMinor: -50_000 },
  ],
  refModel: 'PaymentOrder', refId: 'o1',
};

const PG_EVENT = {
  idempotencyKey: 'dep_1',
  eventType: EVENT_TYPES.DEPOSIT_COMPLETED,
  amountPaise: 50_000,
  refModel: 'PaymentOrder', refId: 'o1',
  postings: [
    { account: ACCOUNTS.EXTERNAL_FIAT.code, amountPaise: 50_000 },
    { account: ACCOUNTS.USER_FUNDS.code,    amountPaise: -50_000 },
  ],
  description: null,
  createdAt: new Date('2026-08-10'),
};

beforeEach(() => {
  onPostgres.clear();
  vi.clearAllMocks();
  ledgerPg.recordEvent.mockResolvedValue({ idempotent: false, event: PG_EVENT });
  ledgerPg.getEvent.mockResolvedValue(PG_EVENT);
  reverse.accountingEvent.mockResolvedValue(undefined);
});

describe('the ON position — Postgres owns the ledger', () => {
  beforeEach(() => { onPostgres.add(MONEY_PATHS.LEDGER); });

  it('posts the event to Postgres and mirrors it back to Mongo', async () => {
    const result = await recordEventOnPostgres(EVENT);

    expect(result).toMatchObject({ handled: true, idempotent: false });
    expect(ledgerPg.recordEvent).toHaveBeenCalledTimes(1);
    // Mongo follows, so the panels and the Mongo-side trial balance keep working
    // and a fallback is a redeploy rather than a data recovery.
    expect(reverse.accountingEvent).toHaveBeenCalledTimes(1);
  });

  it('renames amountMinor to amountPaise WITHOUT rescaling', async () => {
    // Both are integer paise. A conversion here would be a hundredfold error in
    // the books, and every conservation check downstream would then report drift
    // for a reason unrelated to the bug.
    await recordEventOnPostgres(EVENT);

    const sent = ledgerPg.recordEvent.mock.calls[0][0];
    expect(sent.postings).toEqual([
      { account: ACCOUNTS.EXTERNAL_FIAT.code, amountPaise: 50_000 },
      { account: ACCOUNTS.USER_FUNDS.code,    amountPaise: -50_000 },
    ]);
    expect(sent.postings.reduce((s, p) => s + p.amountPaise, 0)).toBe(0);
  });

  it('returns the event in the vocabulary callers already speak', async () => {
    const { event } = await recordEventOnPostgres(EVENT);
    expect(event).toMatchObject({
      idempotencyKey: 'dep_1',
      amountMinor: 50_000,
      postings: [
        { account: ACCOUNTS.EXTERNAL_FIAT.code, amountMinor: 50_000 },
        { account: ACCOUNTS.USER_FUNDS.code,    amountMinor: -50_000 },
      ],
    });
    // No amountPaise leaks out — a caller that saw both names would eventually
    // read the wrong one.
    expect(event.postings[0]).not.toHaveProperty('amountPaise');
  });

  it('refuses a non-integer posting rather than rounding it', async () => {
    // A fractional paise is a bug upstream. Truncating it would hide the bug and
    // break the conserve-to-zero constraint at the same time.
    await expect(recordEventOnPostgres({
      ...EVENT,
      postings: [
        { account: ACCOUNTS.EXTERNAL_FIAT.code, amountMinor: 50_000.5 },
        { account: ACCOUNTS.USER_FUNDS.code,    amountMinor: -50_000.5 },
      ],
    })).rejects.toThrow(/must be an integer paise value/);
    expect(ledgerPg.recordEvent).not.toHaveBeenCalled();
  });

  it('reports a replayed key as idempotent, and mirrors the STORED row', async () => {
    // The reconcilers replay the same completed orders every pass. Treating
    // "already recorded" as a failure would make an ordinary reconcile look like
    // a broken ledger.
    //
    // The row that already exists is the one Mongo must match — not the one this
    // call tried to write, which may differ in description or timestamp.
    const older = { ...PG_EVENT, description: 'the first posting' };
    ledgerPg.recordEvent.mockResolvedValue({ idempotent: true, event: null });
    ledgerPg.getEvent.mockResolvedValue(older);

    const result = await recordEventOnPostgres({ ...EVENT, description: 'a later replay' });

    expect(result).toMatchObject({ handled: true, idempotent: true });
    expect(ledgerPg.getEvent).toHaveBeenCalledWith('dep_1');
    expect(reverse.accountingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'the first posting' }),
    );
  });
});

describe('reads follow authority too', () => {
  beforeEach(() => { onPostgres.add(MONEY_PATHS.LEDGER); });

  it('translates the trial balance into the shape callers branch on', async () => {
    ledgerPg.trialBalance.mockResolvedValue({
      ok: true, grandTotalPaise: 0, conservesToZero: true, unknownAccounts: [],
      accounts: {
        [ACCOUNTS.USER_FUNDS.code]: {
          normalBalance: 'CREDIT', description: 'user liability',
          rawPaise: -50_000, reportedPaise: 50_000, postings: 1,
        },
      },
    });

    const tb = await trialBalanceOnPostgres();
    expect(tb.integrityOk).toBe(true);
    expect(tb.accounts[ACCOUNTS.USER_FUNDS.code]).toMatchObject({
      account: ACCOUNTS.USER_FUNDS.code, rawMinor: -50_000, reportedMinor: 50_000, postings: 1,
    });
    expect(tb.grandTotalMinor).toBe(0);
  });

  it('does not drop the unknown-account check Mongo has no equivalent for', async () => {
    // An account that is not in the chart balances perfectly against nothing
    // anyone can name. `ok` folds that in; `integrityOk` must not lose it on the
    // way through, or a typo'd account would read as a clean ledger.
    ledgerPg.trialBalance.mockResolvedValue({
      ok: false, grandTotalPaise: 0, conservesToZero: true,
      unknownAccounts: ['PLATFORM_REVENEU'], accounts: {},
    });

    const tb = await trialBalanceOnPostgres();
    expect(tb.integrityOk).toBe(false);
    expect(tb.unknownAccounts).toEqual(['PLATFORM_REVENEU']);
  });

  it('reads one account balance from Postgres', async () => {
    ledgerPg.accountBalancePaise.mockResolvedValue(12_345);
    expect(await accountBalanceOnPostgres(ACCOUNTS.USER_FUNDS.code))
      .toEqual({ handled: true, reportedMinor: 12_345 });
  });

  it('pages the ledger and translates every entry', async () => {
    ledgerPg.getLedger.mockResolvedValue({ entries: [PG_EVENT], total: 1, page: 1, pages: 1 });
    const page = await getLedgerOnPostgres({ page: 1, limit: 50 });
    expect(page.total).toBe(1);
    expect(page.entries[0]).toMatchObject({ idempotencyKey: 'dep_1', amountMinor: 50_000 });
    expect(page.entries[0].postings[0]).toMatchObject({ amountMinor: 50_000 });
  });
});

describe('the service asks the resolver, and validates on both paths', () => {
  it('routes recordAccountingEvent through Postgres when the path has moved', async () => {
    onPostgres.add(MONEY_PATHS.LEDGER);
    const { recordAccountingEvent } = await import('../../domains/revenue/revenueSettlement.service.js');

    const result = await recordAccountingEvent(EVENT);
    expect(ledgerPg.recordEvent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ idempotent: false });
    expect(result).not.toHaveProperty('handled');
  });

  it('refuses a malformed event BEFORE asking either store', async () => {
    // A cutover must not quietly change what the books accept. Validation runs
    // first and identically on both paths.
    onPostgres.add(MONEY_PATHS.LEDGER);
    const { recordAccountingEvent } = await import('../../domains/revenue/revenueSettlement.service.js');

    await expect(recordAccountingEvent({
      ...EVENT,
      postings: [
        { account: ACCOUNTS.EXTERNAL_FIAT.code, amountMinor: 50_000 },
        { account: ACCOUNTS.USER_FUNDS.code,    amountMinor: -49_000 },   // does not sum to zero
      ],
    })).rejects.toThrow(/sum to zero/);
    expect(ledgerPg.recordEvent).not.toHaveBeenCalled();
  });
});
