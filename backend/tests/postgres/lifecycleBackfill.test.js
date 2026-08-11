// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * backfillLifecycleTables against a REAL PostgreSQL, with the Mongo side stubbed.
 *
 * This is the step that makes a cutover possible at all. Before it existed,
 * `order_states`, `user_kyc`, `casino_transactions` and `bets` were reachable by
 * no backfill: the forward mirrors only fire on a Mongo write, and every state
 * check starts with SELECT … FROM the Postgres table, so a row that was never
 * mirrored is invisible to it. Flipping a path meant pointing reads at a table
 * that was empty for all historical data.
 *
 * The properties asserted here are the three that make it ADOPTION rather than
 * synchronisation: it adopts at the CURRENT state, it never overwrites, and it
 * invents no history.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/** The Mongo side, as tables this test controls. */
const mongo = { PaymentOrder: [], User: [], GameTransaction: [], Bet: [] };
vi.mock('mongoose', () => {
  const query = (rows) => {
    const q = {
      select: () => q,
      sort: () => q,
      limit: () => q,
      lean: async () => rows,
    };
    return q;
  };
  return {
    default: {
      model: (name) => {
        if (!(name in mongo)) throw new Error(`unexpected model(${name})`);
        return { find: () => query(mongo[name]), updateOne: async () => ({}) };
      },
    },
  };
});

import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { backfillLifecycleTables } from '../../postgres/reconcile.js';
import { getOrder, getOrderHistory, transition, ORDER_STATES } from '../../postgres/orderPg.js';

if (process.env.CI && !pgConfigured()) {
  throw new Error('lifecycleBackfill.test.js: DATABASE_URL is unset in CI — this suite must not skip silently.');
}
const describePg = pgConfigured() ? describe : describe.skip;

const byTable = (rows) => Object.fromEntries(rows.map((r) => [r.table, r]));

describePg('backfillLifecycleTables (real PostgreSQL, stubbed Mongo)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(async () => {
    for (const k of Object.keys(mongo)) mongo[k] = [];
    await pgQuery('TRUNCATE order_transitions, order_states RESTART IDENTITY CASCADE');
    await pgQuery('TRUNCATE casino_transactions, casino_rounds RESTART IDENTITY CASCADE');
    await pgQuery('TRUNCATE kyc_transitions, user_kyc RESTART IDENTITY CASCADE');
    await pgQuery('TRUNCATE bet_transitions, bets RESTART IDENTITY CASCADE');
  });

  describe('orders — the table with no mirror at all', () => {
    it('adopts an order AT ITS CURRENT STATE, not at the start of the lifecycle', async () => {
      // The property the whole function turns on. An order adopted at
      // PENDING_QUEUE has its next transition refused, so every order in flight
      // at the moment of a cutover would strand.
      mongo.PaymentOrder = [
        { _id: 'bf_o1', userId: 'u1', merchantId: 'm1', type: 'DEPOSIT', tokenAmount: 500, fiatAmount: 500, status: 'PAID' },
        { _id: 'bf_o2', userId: 'u2', type: 'WITHDRAWAL', tokenAmount: 100, fiatAmount: 100, status: 'PROCESSING' },
      ];

      const report = byTable(await backfillLifecycleTables());
      expect(report.order_states).toMatchObject({ scanned: 2, created: 2, skipped: 0 });

      expect((await getOrder('bf_o1')).state).toBe(ORDER_STATES.PAID);
      expect((await getOrder('bf_o2')).state).toBe(ORDER_STATES.PROCESSING);
    });

    it('leaves an adopted order able to make its very next move', async () => {
      // The end-to-end point: adoption is only correct if the order can carry on.
      mongo.PaymentOrder = [
        { _id: 'bf_o3', userId: 'u1', type: 'DEPOSIT', tokenAmount: 500, fiatAmount: 500, status: 'PAID' },
      ];
      await backfillLifecycleTables();

      const done = await transition({ orderId: 'bf_o3', to: ORDER_STATES.COMPLETED });
      expect(done).toMatchObject({ ok: true, idempotent: false });
      expect((await getOrder('bf_o3')).state).toBe(ORDER_STATES.COMPLETED);
    });

    it('invents NO history — the transition table stays empty for an adopted order', async () => {
      // Synthesising the path that led to the current state would fabricate
      // timestamps and actors into an append-only table, where an auditor could
      // not tell manufactured history from the real thing. The absence of rows
      // is itself the honest signal that this order predates the cutover.
      mongo.PaymentOrder = [
        { _id: 'bf_o4', userId: 'u1', type: 'DEPOSIT', tokenAmount: 500, fiatAmount: 500, status: 'COMPLETED' },
      ];
      await backfillLifecycleTables();
      expect(await getOrderHistory('bf_o4')).toEqual([]);
    });

    it('NEVER overwrites a Postgres lifecycle that is already ahead', async () => {
      // Postgres may hold transitions Mongo never saw. A "backfill" that
      // clobbered them would destroy the history it exists to protect.
      mongo.PaymentOrder = [
        { _id: 'bf_o5', userId: 'u1', type: 'DEPOSIT', tokenAmount: 500, fiatAmount: 500, status: 'PAID' },
      ];
      await backfillLifecycleTables();
      await transition({ orderId: 'bf_o5', to: ORDER_STATES.COMPLETED });

      // Mongo still says PAID — it is behind. Re-running must not drag Postgres back.
      const report = byTable(await backfillLifecycleTables());
      expect(report.order_states).toMatchObject({ created: 0, skipped: 1 });
      expect((await getOrder('bf_o5')).state).toBe(ORDER_STATES.COMPLETED);
      expect(await getOrderHistory('bf_o5')).toHaveLength(1);
    });

    it('skips a document the state machine cannot represent rather than adopting it', async () => {
      // Adopting into an unknown state would fail the order's next transition,
      // which is precisely the failure this function exists to prevent.
      mongo.PaymentOrder = [
        { _id: 'bf_bad1', userId: 'u1', type: 'SIDEWAYS', tokenAmount: 1, fiatAmount: 1, status: 'PAID' },
        { _id: 'bf_bad2', userId: 'u1', type: 'DEPOSIT', tokenAmount: 1, fiatAmount: 1, status: 'HALFWAY' },
      ];
      const report = byTable(await backfillLifecycleTables());
      expect(report.order_states).toMatchObject({ scanned: 2, created: 0, skipped: 2 });
      expect(await getOrder('bf_bad1')).toBeNull();
      expect(await getOrder('bf_bad2')).toBeNull();
    });
  });

  describe('the other three tables', () => {
    it('adopts KYC, casino rounds and bets', async () => {
      mongo.User = [
        { _id: 'bf_u1', kycStatus: 'APPROVED', kycData: { nameOnPAN: 'A PERSON', panNumber: 'ABCDE1234F' } },
      ];
      mongo.GameTransaction = [
        { txId: 'bf_tx1', roundId: 'bf_r1', userId: 'bf_u1', type: 'BET', amount: 100, providerKey: 'acme', gameId: 'slots' },
        { txId: 'bf_tx2', roundId: 'bf_r1', userId: 'bf_u1', type: 'WIN', amount: 250, providerKey: 'acme', gameId: 'slots' },
      ];
      mongo.Bet = [
        { _id: 'bf_b1', userId: 'bf_u1', cycleId: 'bf_c1', side: 'DELHI', amount: 50, status: 'PENDING', timestamp: new Date() },
      ];

      const report = byTable(await backfillLifecycleTables());
      expect(report.user_kyc).toMatchObject({ created: 1 });
      expect(report.casino_transactions).toMatchObject({ created: 2 });
      expect(report.bets).toMatchObject({ created: 1 });

      const kyc = await pgQuery(`SELECT kyc_status FROM user_kyc WHERE user_id = 'bf_u1'`);
      expect(kyc.rows[0].kyc_status).toBe('APPROVED');

      // The casino round is DERIVED from its callbacks, so the running totals
      // must add up — not just the rows exist.
      const round = await pgQuery(`SELECT debited_paise, credited_paise FROM casino_rounds WHERE round_id = 'bf_r1'`);
      expect(Number(round.rows[0].debited_paise)).toBe(10_000);
      expect(Number(round.rows[0].credited_paise)).toBe(25_000);
    });

    it('is safe to re-run — a second pass creates nothing', async () => {
      // Adoption is a cutover step an operator may well run twice, and the
      // second run has to be a no-op rather than a doubling.
      mongo.User = [{ _id: 'bf_u2', kycStatus: 'PENDING_APPROVAL', kycData: {} }];
      mongo.GameTransaction = [
        { txId: 'bf_tx3', roundId: 'bf_r2', userId: 'bf_u2', type: 'BET', amount: 70, providerKey: 'acme' },
      ];
      mongo.Bet = [{ _id: 'bf_b2', userId: 'bf_u2', cycleId: 'bf_c1', side: 'MUMBAI', amount: 20, status: 'PENDING', timestamp: new Date() }];
      mongo.PaymentOrder = [{ _id: 'bf_o6', userId: 'bf_u2', type: 'DEPOSIT', tokenAmount: 5, fiatAmount: 5, status: 'ASSIGNED' }];

      const first = byTable(await backfillLifecycleTables());
      const second = byTable(await backfillLifecycleTables());

      for (const t of ['order_states', 'user_kyc', 'casino_transactions', 'bets']) {
        expect({ t, created: first[t].created }).toEqual({ t, created: 1 });
        expect({ t, created: second[t].created }).toEqual({ t, created: 0 });
      }

      // And the round's totals were not advanced twice by the re-run.
      const round = await pgQuery(`SELECT debited_paise FROM casino_rounds WHERE round_id = 'bf_r2'`);
      expect(Number(round.rows[0].debited_paise)).toBe(7_000);
    });

    // ── What adoption must carry, now that bets are settled in Postgres ─────
    //
    // `reconcile:pg -- --all --backfill` is step 1 of the cutover, and it is
    // what puts historical bets into the table the flip is about to make
    // authoritative. Two things it must get right, both introduced when
    // settlement was routed.

    it('adopts an ALREADY-SETTLED bet with its payout AND its retained fee', async () => {
      // A bet settled on the Mongo path before the cutover carries a real fee.
      // Adopting it with a zero would hand the store that is about to become
      // authoritative a number that is wrong — and the reverse mirror would
      // then write that zero back over the correct Mongo value, so the error
      // would propagate rather than sit still. Cycle.totalPlatformFees is
      // summed from exactly this field.
      mongo.User = []; mongo.GameTransaction = []; mongo.PaymentOrder = [];
      mongo.Bet = [{
        _id: 'bf_won', userId: 'bf_u9', cycleId: 'bf_c9', side: 'DELHI',
        amount: 100, payout: 198, platformFee: 2, status: 'WON',
        settledAt: new Date(), timestamp: new Date(),
      }];

      const report = byTable(await backfillLifecycleTables());
      expect(report.bets).toMatchObject({ created: 1 });

      const { rows } = await pgQuery(
        `SELECT status, payout_paise, platform_fee_paise FROM bets WHERE bet_id = 'bf_won'`,
      );
      expect(rows[0]).toMatchObject({
        status: 'WON', payout_paise: '19800', platform_fee_paise: '200',
      });
    });

    it('does NOT adopt a phantom bet', async () => {
      // Phantom bets are synthetic: a positive amount with zero funding
      // provenance and no balance deduction. betPg.settle requires slices that
      // sum to the stake, so an adopted phantom bet could never be settled
      // through the authoritative path — it would sit PENDING in Postgres
      // forever while Mongo stamped it LOST, reporting as drift on every cycle,
      // and it inflates reconcileUserStakes' outstanding total against a
      // lockedBalance that never moved.
      mongo.User = []; mongo.GameTransaction = []; mongo.PaymentOrder = [];
      mongo.Bet = [
        { _id: 'bf_ph', userId: 'bf_u8', cycleId: 'bf_c8', side: 'DELHI', amount: 50, status: 'PENDING', isPhantom: true, timestamp: new Date() },
        { _id: 'bf_real', userId: 'bf_u8', cycleId: 'bf_c8', side: 'DELHI', amount: 50, status: 'PENDING', isPhantom: false, timestamp: new Date() },
      ];

      const report = byTable(await backfillLifecycleTables());

      const { rows } = await pgQuery(`SELECT bet_id FROM bets WHERE bet_id LIKE 'bf_%' ORDER BY bet_id`);
      expect(rows.map((r) => r.bet_id)).toEqual(['bf_real']);
      // And the REPORT says so. `created` used to be a counter incremented after
      // calling a mirror that catches its own failures and may decline the row
      // outright — so it counted attempts, and this pass reported 2. It is
      // re-read from the table now, because `--backfill`'s report is what an
      // operator reads before pointing money at Postgres.
      expect(report.bets).toMatchObject({ scanned: 2, created: 1, notAdopted: 1 });
    });

    it('reports created from the TABLE, so a failing mirror cannot report success', async () => {
      // The general case behind the phantom one. A mirror that throws is
      // logged, counted and swallowed by design — a dual-write failure must
      // never break the money path it hangs off. The consequence is that the
      // adoption loop cannot learn about it from the call, so it asks the table.
      mongo.User = []; mongo.GameTransaction = []; mongo.PaymentOrder = [];
      // A bet with no amount: mirrorBet guards `stakePaise <= 0` and returns
      // without writing, exactly as a caught failure would.
      mongo.Bet = [
        { _id: 'bf_zero', userId: 'bf_u7', cycleId: 'bf_c7', side: 'DELHI', amount: 0, status: 'PENDING', timestamp: new Date() },
      ];

      const report = byTable(await backfillLifecycleTables());
      expect(report.bets).toMatchObject({ scanned: 1, created: 0, notAdopted: 1 });

      const { rows } = await pgQuery(`SELECT bet_id FROM bets WHERE bet_id = 'bf_zero'`);
      expect(rows).toHaveLength(0);
    });
  });
});
