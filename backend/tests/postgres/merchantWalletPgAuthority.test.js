// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The merchant wallet's Postgres AUTHORITY path — the adapter the service calls
 * once MONEY_AUTHORITY_MERCHANT_WALLET=postgres, plus the reconciliation and
 * rollback machinery that has to exist before that flip is allowed.
 *
 * merchantWalletPg.test.js proves the Postgres primitives. This file proves the
 * things that only matter at a CUTOVER, which are different questions:
 *
 *   • the return shapes callers already depend on survive the switch
 *   • the idempotency keys are byte-identical, so a movement made in one store
 *     is recognised as already-applied by the other
 *   • rupees↔paise conversion happens exactly once, at the wall
 *   • a merchant that does not exist in Mongo cannot mint a Postgres wallet
 *   • the rollback leg copies BOTH the ledger rows and the balance back, which
 *     is what makes falling back to Mongo lossless rather than a restore
 *   • the two stores can be proven to agree on the NUMBER, not just on which
 *     rows exist
 *
 * MongoDB is mocked, deliberately. These are the Postgres-side guarantees, and
 * the suite has to run where mongod cannot (the build sandbox). The Mongo-side
 * behaviour of the same service is covered by the integration suite.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// ── Mongo test double ────────────────────────────────────────────────────────
// Hoisted so vi.mock's factory can reach it (vi.mock is lifted above imports).
const mongo = vi.hoisted(() => {
  const state = {
    merchants: new Map(),        // id → { _id, userId, tokenBalance }
    ledgerUpserts: [],
    merchantUpdates: [],
  };

  const chain = (rows) => ({
    select: () => chain(rows),
    limit: () => chain(rows),
    lean: () => Promise.resolve(rows),
    then: (res, rej) => Promise.resolve(rows).then(res, rej),
  });

  const models = {
    Merchant: {
      findById: (id) => Promise.resolve(state.merchants.get(String(id)) ?? null),
      find: () => chain([...state.merchants.values()]),
      updateOne: (filter, update) => {
        state.merchantUpdates.push({ filter, update });
        const doc = state.merchants.get(String(filter._id));
        if (doc && update.$set?.tokenBalance !== undefined) doc.tokenBalance = update.$set.tokenBalance;
        return Promise.resolve({ acknowledged: true });
      },
    },
    MerchantWalletLedger: {
      updateOne: (filter, update, options) => {
        state.ledgerUpserts.push({ filter, update, options });
        return Promise.resolve({ acknowledged: true });
      },
    },
  };

  const mongoose = {
    model: (name) => {
      if (!models[name]) throw new Error(`test double has no model '${name}'`);
      return models[name];
    },
  };
  return { state, mongoose };
});

vi.mock('mongoose', () => ({ default: mongo.mongoose, ...mongo.mongoose }));

const { pgConfigured, pgQuery, applySchema, closePg } = await import('../../postgres/pgClient.js');
const {
  getMerchantBalances, reconcileMerchant, recordOpeningBalances,
  adminIssueToMerchant, reserveForSettlement,
} = await import('../../postgres/merchantWalletPg.js');
const {
  debitMerchantTokens, creditMerchantTokens, getMerchantTokenBalance,
} = await import('../../postgres/merchantWalletPgAuthority.js');
const { reverseMirrorMerchantMovement } = await import('../../postgres/reverseMirror.js');
const {
  reconcileMerchantBalances, reconcileMerchantLedgers, openMerchantLedgers,
} = await import('../../postgres/reconcile.js');

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const M = '507f1f77bcf86cd799439011';
const U = '507f1f77bcf86cd799439099';

/** Register a merchant in the Mongo double. Rupees, like the real document. */
function seedMerchant(id = M, tokenBalance = 0) {
  mongo.state.merchants.set(String(id), { _id: String(id), userId: U, tokenBalance });
  return mongo.state.merchants.get(String(id));
}

/** The Phase A dual-write's effect: a balance in Postgres with no entries. */
function mirrorBalanceDirect(id, paise) {
  return pgQuery(
    `INSERT INTO merchant_wallets (merchant_id, available_paise, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (merchant_id) DO UPDATE SET available_paise = EXCLUDED.available_paise`,
    [String(id), paise],
  );
}

/** The reverse mirror is fire-and-forget; let its microtasks drain. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describePg('Merchant wallet — Postgres authority path', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE merchant_wallets, merchant_wallet_entries RESTART IDENTITY CASCADE');
    mongo.state.merchants.clear();
    mongo.state.ledgerUpserts.length = 0;
    mongo.state.merchantUpdates.length = 0;
  });

  // ── The contract callers already depend on ─────────────────────────────────
  describe('return shapes', () => {
    it('credits and reports the new balance in RUPEES on the Mongo document', async () => {
      seedMerchant(M, 0);
      const r = await creditMerchantTokens({
        merchantId: M, amount: 250.5, reason: 'Admin top-up',
        refModel: 'Merchant', refId: M, txId: 'mw_topup_a',
      });

      expect(r.idempotent).toBe(false);
      expect(r.merchant).toBeTruthy();
      expect(r.merchant.tokenBalance).toBe(250.5);   // rupees out
      expect(r.merchant.userId).toBe(U);             // identity fields survive
      expect((await getMerchantBalances(M)).available).toBe(25050); // paise at rest
    });

    it('debits, and refuses without mutating when the balance is short', async () => {
      seedMerchant(M, 100);
      await creditMerchantTokens({ merchantId: M, amount: 100, reason: 'seed', txId: 'seed_1' });

      const r = await debitMerchantTokens({
        merchantId: M, amount: 250, reason: 'Deposit dispensed',
        refModel: 'PaymentOrder', refId: 'o1', txId: 'mw_dep_deduct_o1',
      });

      expect(r).toEqual({ merchant: null, idempotent: false });
      expect((await getMerchantBalances(M)).available).toBe(10000); // untouched
    });

    it('distinguishes "no such merchant" from "insufficient" — and mints no orphan wallet', async () => {
      // Postgres has no foreign key to the Mongo Merchant collection, so a
      // typo'd id would otherwise materialise a wallet row holding real money
      // that no merchant owns.
      const r = await creditMerchantTokens({
        merchantId: 'ffffffffffffffffffffffff', amount: 500, reason: 'typo', txId: 'mw_typo',
      });
      expect(r).toEqual({ merchant: null, idempotent: false });

      const { rows } = await pgQuery('SELECT * FROM merchant_wallets');
      expect(rows).toHaveLength(0);
    });

    it('exposes the full pocket position alongside the single Mongo number', async () => {
      seedMerchant(M, 0);
      const r = await creditMerchantTokens({ merchantId: M, amount: 10, reason: 'seed', txId: 'seed_2' });
      expect(r.merchant.pgBalances).toEqual({
        available: 1000, reserved: 0, settlement: 0, liability: 0,
      });
    });
  });

  // ── Idempotency: the property a cutover depends on most ────────────────────
  describe('idempotency', () => {
    it('applies one txId exactly once and reports the CURRENT balance on replay', async () => {
      seedMerchant(M, 0);
      const first = await creditMerchantTokens({ merchantId: M, amount: 100, reason: 'x', txId: 'mw_k' });
      const second = await creditMerchantTokens({ merchantId: M, amount: 100, reason: 'x', txId: 'mw_k' });

      expect(first.idempotent).toBe(false);
      expect(second.idempotent).toBe(true);
      expect(second.merchant.tokenBalance).toBe(100);           // not 0, not 200
      expect((await getMerchantBalances(M)).available).toBe(10000);
    });

    it('writes the caller\'s txId verbatim — no suffix, so Mongo\'s gate still matches it', async () => {
      // MerchantWalletLedger.findOne({ txId }) is Mongo's idempotency gate. If
      // Postgres decorated the key, a fallback would not recognise the movement
      // and the next retry would apply it a second time.
      seedMerchant(M, 0);
      await creditMerchantTokens({
        merchantId: M, amount: 40, reason: 'x', refModel: 'PaymentOrder', refId: 'o9',
        txId: 'mw_wd_credit_o9',
      });
      const { rows } = await pgQuery('SELECT tx_id, ref_model, ref_id FROM merchant_wallet_entries');
      expect(rows).toHaveLength(1);
      expect(rows[0].tx_id).toBe('mw_wd_credit_o9');
      expect(rows[0]).toMatchObject({ ref_model: 'PaymentOrder', ref_id: 'o9' });
    });

    it('survives a 200-copy retry storm on one key', async () => {
      seedMerchant(M, 0);
      const attempts = Array.from({ length: 200 }, () =>
        creditMerchantTokens({ merchantId: M, amount: 25, reason: 'storm', txId: 'mw_storm' }));
      const results = await Promise.all(attempts);

      expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
      expect((await getMerchantBalances(M)).available).toBe(2500);
    });
  });

  // ── Concurrency: the guard has to hold under contention, not just in order ──
  describe('concurrency', () => {
    it('lets exactly as many distinct debits through as the balance covers', async () => {
      seedMerchant(M, 0);
      await creditMerchantTokens({ merchantId: M, amount: 100, reason: 'seed', txId: 'seed_c' });

      // 200 racing debits of ₹1 against ₹100.
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          debitMerchantTokens({ merchantId: M, amount: 1, reason: 'race', txId: `race_${i}` })),
      );

      expect(results.filter((r) => r.merchant)).toHaveLength(100);
      expect(results.filter((r) => !r.merchant)).toHaveLength(100);
      expect((await getMerchantBalances(M)).available).toBe(0);
      expect((await reconcileMerchant(M)).ok).toBe(true);
    });
  });

  // ── Overdraft: authorised only, and recorded either way ────────────────────
  describe('overdraft', () => {
    it('refuses by default and permits when explicitly authorised', async () => {
      seedMerchant(M, 0);
      await creditMerchantTokens({ merchantId: M, amount: 10, reason: 'seed', txId: 'seed_o' });

      const strict = await debitMerchantTokens({
        merchantId: M, amount: 50, reason: 'strict', txId: 'od_strict',
      });
      expect(strict.merchant).toBeNull();

      const authorised = await debitMerchantTokens({
        merchantId: M, amount: 50, reason: 'dispute release', txId: 'od_allowed', allowOverdraft: true,
      });
      expect(authorised.merchant.tokenBalance).toBe(-40);
      expect((await reconcileMerchant(M)).ok).toBe(true); // the ledger explains it
    });
  });

  // ── Rollback leg: what makes falling back to Mongo lossless ────────────────
  describe('reverse mirror', () => {
    it('copies the ledger row AND the balance back to Mongo after every movement', async () => {
      seedMerchant(M, 0);
      await creditMerchantTokens({
        merchantId: M, amount: 75, reason: 'Withdrawal settled', refModel: 'PaymentOrder', refId: 'o7',
        txId: 'mw_wd_credit_o7',
      });
      await settle();

      // The ledger row is the part that keeps Mongo's idempotency gate working.
      expect(mongo.state.ledgerUpserts).toHaveLength(1);
      const upsert = mongo.state.ledgerUpserts[0];
      expect(upsert.filter).toEqual({ txId: 'mw_wd_credit_o7' });
      expect(upsert.options).toEqual({ upsert: true });
      expect(upsert.update.$setOnInsert).toMatchObject({
        txId: 'mw_wd_credit_o7', merchantId: M, type: 'CREDIT', amount: 75, balanceAfter: 75,
      });

      // The balance is the part that keeps the fallback correct.
      expect(mongo.state.merchantUpdates.at(-1)).toEqual({
        filter: { _id: M }, update: { $set: { tokenBalance: 75 } },
      });
    });

    it('maps the WHOLE position back, not just the spendable pocket', async () => {
      // Reverting means Mongo becomes authoritative again with a single number.
      // Mirroring only `available` would silently destroy reserved and owed-out
      // tokens — exactly the money a merchant is still owed.
      await reverseMirrorMerchantMovement({
        merchantId: M,
        entries: [{
          txId: 'mw_x', pocket: 'available', amountPaise: -1000,
          balanceBefore: 6000, balanceAfter: 5000, entryType: 'DEBIT',
          operation: 'MERCHANT_DEBIT', reason: 'r',
        }],
        balances: { available: 5000, reserved: 2000, settlement: 3000 },
      });
      await settle();

      expect(mongo.state.merchantUpdates.at(-1).update).toEqual({ $set: { tokenBalance: 100 } });
    });

    it('mirrors a multi-leg movement under the logical key Mongo\'s gate matches', async () => {
      // Postgres keys a multi-pocket movement `<txId>:<pocket>`; Mongo's gate
      // looks up the caller's logical key. Every row carries it as movementId,
      // so a fallback recognises the movement and a retry is a no-op.
      await reverseMirrorMerchantMovement({
        merchantId: M,
        entries: [
          { txId: 'res_1:available', movementId: 'res_1', pocket: 'available', amountPaise: -1000, balanceBefore: 1000, balanceAfter: 0, entryType: 'DEBIT', operation: 'RESERVE' },
          { txId: 'res_1:reserved', movementId: 'res_1', pocket: 'reserved', amountPaise: 1000, balanceBefore: 0, balanceAfter: 1000, entryType: 'CREDIT', operation: 'RESERVE' },
        ],
        balances: { available: 0, reserved: 1000, settlement: 0 },
      });
      await settle();

      expect(mongo.state.ledgerUpserts).toHaveLength(2);
      expect(mongo.state.ledgerUpserts.map((u) => u.update.$setOnInsert.movementId))
        .toEqual(['res_1', 'res_1']);
      // The whole position, not one pocket — a reserve does not change what the
      // merchant holds in total.
      expect(mongo.state.merchantUpdates.at(-1).update).toEqual({ $set: { tokenBalance: 10 } });
    });

    it('still refuses a multi-leg movement that arrives without its logical key', async () => {
      // Without movementId the rows are findable only by their per-pocket txIds,
      // which is the wrong key — a fallback would not see the movement and the
      // next retry would apply it twice.
      await reverseMirrorMerchantMovement({
        merchantId: M,
        entries: [
          { txId: 'res_2:available', pocket: 'available', amountPaise: -1000, balanceBefore: 1000, balanceAfter: 0, entryType: 'DEBIT', operation: 'RESERVE' },
        ],
        balances: { available: 0, reserved: 1000, settlement: 0 },
      });
      await settle();

      expect(mongo.state.ledgerUpserts).toHaveLength(0);
      expect(mongo.state.merchantUpdates).toHaveLength(0);
    });
  });

  // ── Opening balances: the cutover step that makes the ledger check honest ──
  describe('recordOpeningBalances', () => {
    it('gives a mirrored balance a history so the ledger can explain it', async () => {
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 50000);

      // Phase A: the number arrived by projection, the entries are in Mongo.
      const before = await reconcileMerchant(M);
      expect(before.ok).toBe(false);
      expect(before.drift.available).toBe(50000);

      const opened = await recordOpeningBalances(M);
      expect(opened.posted).toEqual([`mw_opening_${M}_available`]);
      expect((await reconcileMerchant(M)).ok).toBe(true);
      expect((await getMerchantBalances(M)).available).toBe(50000); // balance untouched
    });

    it('is a no-op on a second run', async () => {
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 50000);
      await recordOpeningBalances(M);

      const again = await recordOpeningBalances(M);
      expect(again).toMatchObject({ posted: [], conflicts: [] });
      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int AS n FROM merchant_wallet_entries WHERE operation = 'OPENING_BALANCE'`);
      expect(rows[0].n).toBe(1);
    });

    it('refuses to launder a balance that moved without an entry after opening', async () => {
      // The opening key already exists, and the pocket STILL does not
      // reconcile — so something wrote outside this module. Posting a second
      // opening entry would quietly absorb the unexplained movement into the
      // ledger and make the books look correct; it has to surface instead.
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 50000);
      await recordOpeningBalances(M);
      await pgQuery('UPDATE merchant_wallets SET available_paise = available_paise + 9999 WHERE merchant_id = $1', [M]);

      const r = await recordOpeningBalances(M);
      expect(r).toMatchObject({ posted: [], conflicts: ['available'] });
      expect((await reconcileMerchant(M)).drift.available).toBe(9999); // still visible
      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int AS n FROM merchant_wallet_entries WHERE operation = 'OPENING_BALANCE'`);
      expect(rows[0].n).toBe(1);
    });

    it('keeps the ledger explaining the balance across subsequent movements', async () => {
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 50000);
      await recordOpeningBalances(M);

      await debitMerchantTokens({ merchantId: M, amount: 120, reason: 'deposit', txId: 'post_open_1' });
      await creditMerchantTokens({ merchantId: M, amount: 45.5, reason: 'withdrawal', txId: 'post_open_2' });

      expect((await reconcileMerchant(M)).ok).toBe(true);
      expect(await getMerchantTokenBalance(M)).toBe(425.5);
    });

    it('opens nothing for a merchant whose balance is already explained', async () => {
      seedMerchant(M, 0);
      await creditMerchantTokens({ merchantId: M, amount: 30, reason: 'native', txId: 'native_1' });
      expect((await recordOpeningBalances(M)).posted).toEqual([]);
      expect((await reconcileMerchant(M)).ok).toBe(true);
    });
  });

  // ── Cross-store reconciliation: the gate the cutover actually rests on ─────
  describe('reconcileMerchantBalances', () => {
    it('reports agreement when the stores hold the same number', async () => {
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 50000);
      const r = await reconcileMerchantBalances();
      expect(r).toMatchObject({ checked: 1, drifted: 0, totalDriftPaise: 0, orphansInPg: 0 });
    });

    it('catches a balance that differs even though both stores have the row', async () => {
      // The failure row-presence reconciliation is structurally blind to.
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 49900); // ₹1 short
      const r = await reconcileMerchantBalances();
      expect(r.drifted).toBe(1);
      expect(r.totalDriftPaise).toBe(100);
      expect(r.sampleDrift[0]).toMatchObject({ merchantId: M, mongoPaise: 50000, pgPaise: 49900 });
    });

    it('counts reserved and owed-out tokens as part of the merchant position', async () => {
      seedMerchant(M, 500);
      await adminIssueToMerchant({ merchantId: M, amountPaise: 50000, txId: 'iss', reason: 'seed' });
      await reserveForSettlement({ merchantId: M, amountPaise: 20000, txId: 'res', reason: 'settle' });
      // ₹500 in Mongo; ₹300 available + ₹200 reserved in Postgres — agreement.
      expect((await reconcileMerchantBalances()).drifted).toBe(0);
    });

    it('treats a Postgres wallet with no Mongo merchant as drift', async () => {
      await mirrorBalanceDirect('ffffffffffffffffffffffff', 100000);
      const r = await reconcileMerchantBalances();
      expect(r.orphansInPg).toBe(1);
      expect(r.sampleOrphans).toEqual(['ffffffffffffffffffffffff']);
    });

    it('repairs Postgres from Mongo when asked, and refuses contradictory directions', async () => {
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 1);
      await reconcileMerchantBalances({ backfill: true });
      expect((await getMerchantBalances(M)).available).toBe(50000);
      expect((await reconcileMerchantBalances()).drifted).toBe(0);

      await expect(reconcileMerchantBalances({ backfill: true, repairMongo: true }))
        .rejects.toThrow(/opposite directions/);
    });

    it('repairs Mongo from Postgres in the rollback direction', async () => {
      const doc = seedMerchant(M, 1);
      await mirrorBalanceDirect(M, 50000);
      await reconcileMerchantBalances({ repairMongo: true });
      expect(doc.tokenBalance).toBe(500);
    });
  });

  describe('reconcileMerchantLedgers', () => {
    it('skips merchants whose ledger has not been opened yet', async () => {
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 50000);
      const r = await reconcileMerchantLedgers();
      expect(r).toMatchObject({ checked: 0, skippedUnopened: 1, unexplained: 0 });
    });

    it('reports an unexplained balance once the ledger is opened', async () => {
      seedMerchant(M, 500);
      await mirrorBalanceDirect(M, 50000);
      await recordOpeningBalances(M);
      expect((await reconcileMerchantLedgers()).unexplained).toBe(0);

      // Simulate a write that bypassed the ledger entirely.
      await pgQuery('UPDATE merchant_wallets SET available_paise = available_paise + 777 WHERE merchant_id = $1', [M]);
      const r = await reconcileMerchantLedgers();
      expect(r.unexplained).toBe(1);
      expect(r.sample[0]).toMatchObject({ merchantId: M, deltaPaise: 777 });
    });

    it('openMerchantLedgers opens every merchant and is safe to re-run', async () => {
      seedMerchant(M, 500);
      seedMerchant('507f1f77bcf86cd799439012', 250);
      await mirrorBalanceDirect(M, 50000);
      await mirrorBalanceDirect('507f1f77bcf86cd799439012', 25000);

      expect(await openMerchantLedgers()).toMatchObject({ merchants: 2, opened: 2, alreadySettled: 0, conflicts: [] });
      expect(await openMerchantLedgers()).toMatchObject({ merchants: 2, opened: 0, alreadySettled: 2, conflicts: [] });
      expect((await reconcileMerchantLedgers({ requireOpened: true })).unexplained).toBe(0);
    });
  });
});
