// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The global accounting ledger, read from PostgreSQL — domain 4.
 *
 * The invariants:
 *   • an event's postings sum to zero, enforced by the DATABASE
 *   • the whole ledger sums to zero, derived
 *   • one idempotencyKey records exactly once, under concurrency
 *   • balances are DERIVED from postings, never stored
 *   • the ledger is compared against the sub-ledgers it summarises — internal
 *     consistency is not the same as describing reality
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../../postgres/pgClient.js';
import {
  recordEvent, getEvent, getLedger, trialBalance, accountBalancePaise,
  reconcileAgainstSubLedgers,
} from '../../postgres/ledgerPg.js';
import { EVENT_TYPES } from '../../domains/revenue/chartOfAccounts.js';
import { mintToMerchantFloat, merchantDispensedToUser } from '../../postgres/treasuryPg.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

/** A balanced deposit: fiat in, user liability up. */
const deposit = (key, paise) => recordEvent({
  eventType: EVENT_TYPES.DEPOSIT_COMPLETED, idempotencyKey: key,
  refModel: 'PaymentOrder', refId: key,
  postings: [
    { account: 'EXTERNAL_FIAT', amountPaise: paise },
    { account: 'USER_FUNDS', amountPaise: -paise },
  ],
});

describePg('Accounting ledger (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(
      `TRUNCATE accounting_events, wallets, wallet_ledger,
                merchant_wallets, merchant_wallet_entries,
                treasury_entries, treasury_accounts RESTART IDENTITY CASCADE`);
  });

  // ── Double entry ───────────────────────────────────────────────────────────
  describe('double entry', () => {
    it('records a balanced event and derives its balances', async () => {
      const r = await deposit('dep_1', 100_000);
      expect(r).toMatchObject({ ok: true, idempotent: false });

      const tb = await trialBalance();
      expect(tb.conservesToZero).toBe(true);
      expect(tb.accounts.EXTERNAL_FIAT.rawPaise).toBe(100_000);
      // USER_FUNDS is credit-normal, so its liability reads positive.
      expect(tb.accounts.USER_FUNDS.reportedPaise).toBe(100_000);
      expect(await accountBalancePaise('USER_FUNDS')).toBe(100_000);
    });

    it('refuses unbalanced postings, an unknown account, and a non-integer amount', async () => {
      await expect(recordEvent({
        eventType: EVENT_TYPES.DEPOSIT_COMPLETED, idempotencyKey: 'bad_1',
        postings: [
          { account: 'EXTERNAL_FIAT', amountPaise: 100 },
          { account: 'USER_FUNDS', amountPaise: -90 },
        ],
      })).rejects.toThrow(/conserve to zero/);

      await expect(recordEvent({
        eventType: EVENT_TYPES.DEPOSIT_COMPLETED, idempotencyKey: 'bad_2',
        postings: [
          { account: 'SLUSH', amountPaise: 100 },
          { account: 'USER_FUNDS', amountPaise: -100 },
        ],
      })).rejects.toThrow(/Unknown ledger account/);

      await expect(recordEvent({
        eventType: EVENT_TYPES.DEPOSIT_COMPLETED, idempotencyKey: 'bad_3',
        postings: [
          { account: 'EXTERNAL_FIAT', amountPaise: 10.5 },
          { account: 'USER_FUNDS', amountPaise: -10.5 },
        ],
      })).rejects.toThrow(/must be an integer/);

      await expect(recordEvent({
        eventType: 'MADE_UP_EVENT', idempotencyKey: 'bad_4',
        postings: [
          { account: 'EXTERNAL_FIAT', amountPaise: 100 },
          { account: 'USER_FUNDS', amountPaise: -100 },
        ],
      })).rejects.toThrow(/Unknown accounting event type/);

      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM accounting_events');
      expect(rows[0].n).toBe(0);
    });

    it('refuses a single-legged event — value cannot appear', async () => {
      await expect(recordEvent({
        eventType: EVENT_TYPES.DEPOSIT_COMPLETED, idempotencyKey: 'bad_5',
        postings: [{ account: 'EXTERNAL_FIAT', amountPaise: 100 }],
      })).rejects.toThrow(/at least two postings/);
    });

    it('is enforced by the DATABASE, not only by this module', async () => {
      // The application check is a good error message; the trigger is the
      // guarantee. Direct SQL must not be able to write an unbalanced event.
      await expect(pgQuery(
        `INSERT INTO accounting_events (idempotency_key, event_type, amount_paise, postings)
         VALUES ('raw_bad','DEPOSIT_COMPLETED',5,'[{"account":"EXTERNAL_FIAT","amountPaise":5}]')`))
        .rejects.toThrow(/conserve to zero/);
    });

    it('keeps the ledger at zero across a long chain of events', async () => {
      await deposit('c1', 500_000);
      await recordEvent({
        eventType: EVENT_TYPES.WITHDRAWAL_COMPLETED, idempotencyKey: 'c2',
        postings: [
          { account: 'USER_FUNDS', amountPaise: 200_000 },
          { account: 'EXTERNAL_FIAT', amountPaise: -200_000 },
        ],
      });
      await recordEvent({
        eventType: EVENT_TYPES.BET_CYCLE_SETTLED, idempotencyKey: 'c3',
        postings: [
          { account: 'USER_FUNDS', amountPaise: 30_000 },
          { account: 'PLATFORM_REVENUE', amountPaise: -30_000 },
        ],
      });

      const tb = await trialBalance();
      expect(tb.ok).toBe(true);
      expect(tb.grandTotalPaise).toBe(0);
      expect(await accountBalancePaise('PLATFORM_REVENUE')).toBe(30_000);
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('records one key exactly once and returns the existing event on replay', async () => {
      const first = await deposit('idem_1', 100_000);
      const second = await deposit('idem_1', 100_000);

      expect(first.idempotent).toBe(false);
      expect(second.idempotent).toBe(true);
      expect(second.event.idempotencyKey).toBe('idem_1');
      expect(await accountBalancePaise('USER_FUNDS')).toBe(100_000);
    });

    it('survives a 100-copy retry storm on one key', async () => {
      // No pre-read anywhere in the write path — the single INSERT … ON
      // CONFLICT DO NOTHING RETURNING is the gate, so there is no window two
      // concurrent callers can both pass.
      const results = await Promise.all(
        Array.from({ length: 100 }, () => deposit('storm', 70_000)),
      );
      expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
      expect(await accountBalancePaise('USER_FUNDS')).toBe(70_000);
      expect((await trialBalance()).ok).toBe(true);
    });

    it('does not exhaust the connection pool under 100 concurrent writes', async () => {
      // Every write here is a single pooled statement — no transaction holds a
      // client while asking for another, the failure that deadlocked the
      // treasury. This asserts the property rather than assuming it.
      const pool = await getPool();
      await Promise.all(Array.from({ length: 100 }, (_, i) => deposit(`pool_${i}`, 1_000)));
      expect(pool.waitingCount).toBe(0);
      expect((await trialBalance()).ok).toBe(true);
      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM accounting_events');
      expect(rows[0].n).toBe(100);
    });
  });

  // ── Append-only ────────────────────────────────────────────────────────────
  it('cannot be edited or deleted, even by direct SQL', async () => {
    await deposit('ap_1', 100_000);
    await expect(pgQuery(`UPDATE accounting_events SET amount_paise = 1 WHERE idempotency_key = 'ap_1'`))
      .rejects.toThrow(/append-only/);
    await expect(pgQuery(`DELETE FROM accounting_events WHERE idempotency_key = 'ap_1'`))
      .rejects.toThrow(/append-only/);
  });

  // ── Reads ──────────────────────────────────────────────────────────────────
  describe('reads', () => {
    it('pages the ledger newest first and filters by event type', async () => {
      await deposit('p1', 10_000);
      await deposit('p2', 20_000);
      await recordEvent({
        eventType: EVENT_TYPES.WITHDRAWAL_COMPLETED, idempotencyKey: 'p3',
        postings: [
          { account: 'USER_FUNDS', amountPaise: 5_000 },
          { account: 'EXTERNAL_FIAT', amountPaise: -5_000 },
        ],
      });

      const all = await getLedger({ limit: 10 });
      expect(all.total).toBe(3);
      expect(all.entries).toHaveLength(3);

      const deposits = await getLedger({ eventType: EVENT_TYPES.DEPOSIT_COMPLETED });
      expect(deposits.total).toBe(2);
      expect(deposits.entries.every((e) => e.eventType === EVENT_TYPES.DEPOSIT_COMPLETED)).toBe(true);

      expect((await getEvent('p1')).postings).toEqual([
        { account: 'EXTERNAL_FIAT', amountPaise: 10_000 },
        { account: 'USER_FUNDS', amountPaise: -10_000 },
      ]);
      expect(await getEvent('nope')).toBeNull();
    });

    it('reports an untouched credit-normal account as +0, never -0', async () => {
      // Negating a zero raw balance yields -0, and Object.is(-0, 0) is false —
      // so a caller using strict equality would see an empty account as
      // "not zero". Same edge the treasury hit.
      const tb = await trialBalance();
      expect(tb.accounts.USER_FUNDS.reportedPaise).toBe(0);
      expect(Object.is(tb.accounts.USER_FUNDS.reportedPaise, -0)).toBe(false);
      expect(await accountBalancePaise('PLATFORM_REVENUE')).toBe(0);
      expect(Object.is(await accountBalancePaise('PLATFORM_REVENUE'), -0)).toBe(false);
    });

    it('rejects an unknown account on read', async () => {
      await expect(accountBalancePaise('SLUSH')).rejects.toThrow(/Unknown ledger account/);
    });

    it('flags an account outside the chart that the trigger cannot catch', async () => {
      // The per-event trigger only checks the postings sum to zero — a typo'd
      // account balances perfectly against nothing anyone can name.
      await pgQuery(
        `INSERT INTO accounting_events (idempotency_key, event_type, amount_paise, postings)
         VALUES ('ghost','DEPOSIT_COMPLETED',100,
                 '[{"account":"GHOST_ACCOUNT","amountPaise":100},{"account":"USER_FUNDS","amountPaise":-100}]')`);

      const tb = await trialBalance();
      expect(tb.conservesToZero).toBe(true);      // it does balance
      expect(tb.unknownAccounts).toEqual(['GHOST_ACCOUNT']);
      expect(tb.ok).toBe(false);                  // and is still not acceptable
    });
  });

  // ── The audit question ─────────────────────────────────────────────────────
  describe('reconciliation against the sub-ledgers', () => {
    it('agrees when the ledger describes what the wallets actually hold', async () => {
      await pgQuery(
        `INSERT INTO wallets (user_id, deposit_paise, winnings_paise) VALUES ('u1', 80_000, 20_000)`);
      await deposit('rec_1', 100_000);

      const r = await reconcileAgainstSubLedgers();
      const userLiability = r.comparisons.find((c) => c.name === 'user_liability');
      expect(userLiability).toMatchObject({ ledgerPaise: 100_000, subLedgerPaise: 100_000 });
      expect(r.differences.filter((d) => d.name === 'user_liability')).toEqual([]);
    });

    it('catches a ledger that balances but does not describe reality', async () => {
      // The failure the trial balance is structurally blind to: the ledger
      // conserves perfectly to zero while claiming users hold money they do not.
      await deposit('rec_2', 100_000);          // ledger says users hold ₹1,000
      // …and no wallet rows exist at all.

      const r = await reconcileAgainstSubLedgers();
      expect(r.conservesToZero).toBe(true);     // internally consistent
      expect(r.ok).toBe(false);                 // and still wrong
      const drift = r.differences.find((d) => d.name === 'user_liability');
      expect(drift).toMatchObject({ ledgerPaise: 100_000, subLedgerPaise: 0, driftPaise: 100_000 });
    });

    it('compares the treasury floats against the wallets they summarise', async () => {
      await mintToMerchantFloat(500_000, { movementId: 'rec_mint' });
      await pgQuery(
        `INSERT INTO merchant_wallets (merchant_id, available_paise) VALUES ('m1', 500_000)`);
      await merchantDispensedToUser(100_000, { movementId: 'rec_disp' });

      const r = await reconcileAgainstSubLedgers();
      // MERCHANT_FLOAT is now 400_000 but the wallet still holds 500_000 — the
      // treasury recorded a dispense the merchant wallet never performed.
      const merchantDrift = r.differences.find((d) => d.name === 'merchant_float');
      expect(merchantDrift).toMatchObject({ ledgerPaise: 400_000, subLedgerPaise: 500_000, driftPaise: -100_000 });
      expect(r.ok).toBe(false);
    });
  });
});
