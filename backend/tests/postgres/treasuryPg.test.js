// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The admin treasury — domain 3, and the thing that closes the books.
 *
 * The invariants, asserted rather than a particular sequence:
 *   • every movement's legs sum to zero, so the WHOLE ledger sums to zero
 *   • minting is not value from nowhere — TOKEN_SUPPLY goes negative by
 *     exactly what the float account gains
 *   • the supply cap cannot be exceeded, including by concurrent mints
 *   • one movementId posts exactly once however many copies arrive
 *   • entries explain balances, and the entries cannot be edited
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import {
  ACCOUNTS, postMovement, getTreasuryBalances, trialBalance, circulatingSupplyPaise,
  mintToMerchantFloat, burnFromMerchantFloat, merchantDispensedToUser, userPaidMerchant,
  stakeLostToHouse, housePaidWinnings, allocateFromHouse, poolPaidUser,
} from '../../postgres/treasuryPg.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

describePg('Admin treasury (PostgreSQL double entry)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE treasury_entries, treasury_accounts RESTART IDENTITY CASCADE');
  });

  // ── The rule everything else rests on ──────────────────────────────────────
  describe('double entry', () => {
    it('refuses a movement whose legs do not sum to zero', async () => {
      await expect(postMovement({
        movementId: 'bad_1', operation: 'MINT',
        legs: { [ACCOUNTS.TOKEN_SUPPLY]: -1000, [ACCOUNTS.MERCHANT_FLOAT]: 900 },
      })).rejects.toThrow(/sum to zero/);

      // And nothing was written — the check runs before any row is touched, so
      // a malformed movement never exists even momentarily.
      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM treasury_entries');
      expect(rows[0].n).toBe(0);
    });

    it('refuses a single-legged movement — value cannot appear', async () => {
      await expect(postMovement({
        movementId: 'bad_2', operation: 'MINT', legs: { [ACCOUNTS.MERCHANT_FLOAT]: 1000 },
      })).rejects.toThrow(/sum to zero/);
    });

    it('refuses an unknown account and a non-integer amount', async () => {
      await expect(postMovement({
        movementId: 'bad_3', operation: 'X', legs: { SLUSH_FUND: 100, [ACCOUNTS.HOUSE_RESERVE]: -100 },
      })).rejects.toThrow(/Unknown treasury account/);
      await expect(postMovement({
        movementId: 'bad_4', operation: 'X',
        legs: { [ACCOUNTS.HOUSE_RESERVE]: 10.5, [ACCOUNTS.USER_FLOAT]: -10.5 },
      })).rejects.toThrow(/integer number of paise/);
    });

    it('keeps the ledger at zero across a long chain of movements', async () => {
      await mintToMerchantFloat(1_000_000, { movementId: 'm1', actor: 'admin' });
      await merchantDispensedToUser(200_000, { movementId: 'm2' });
      await stakeLostToHouse(50_000, { movementId: 'm3' });
      await housePaidWinnings(80_000, { movementId: 'm4' });
      await allocateFromHouse(5_000, ACCOUNTS.COMMISSION_POOL, { movementId: 'm5' });
      await poolPaidUser(2_000, ACCOUNTS.BONUS_POOL, { movementId: 'm6' });
      await userPaidMerchant(30_000, { movementId: 'm7' });
      await burnFromMerchantFloat(10_000, { movementId: 'm8' });

      const tb = await trialBalance();
      expect(tb.conservesToZero).toBe(true);
      expect(tb.grandTotalPaise).toBe(0);
      expect(tb.unexplained).toEqual([]);
      expect(tb.ok).toBe(true);
    });
  });

  // ── Supply ─────────────────────────────────────────────────────────────────
  describe('token supply', () => {
    it('makes minting a movement, not an appearance', async () => {
      await mintToMerchantFloat(1_000_000, { movementId: 'sup_1', actor: 'admin-3' });
      const b = await getTreasuryBalances();
      // The tokens exist in the float; TOKEN_SUPPLY records that they were made.
      expect(b[ACCOUNTS.MERCHANT_FLOAT]).toBe(1_000_000);
      expect(b[ACCOUNTS.TOKEN_SUPPLY]).toBe(-1_000_000);
      expect(await circulatingSupplyPaise()).toBe(1_000_000);
      expect((await trialBalance()).conservesToZero).toBe(true);
    });

    it('reduces supply on a burn, exactly inverting a mint', async () => {
      await mintToMerchantFloat(500_000, { movementId: 'sup_2' });
      await burnFromMerchantFloat(500_000, { movementId: 'sup_3' });
      expect(await circulatingSupplyPaise()).toBe(0);
      expect((await getTreasuryBalances())[ACCOUNTS.MERCHANT_FLOAT]).toBe(0);
    });

    it('refuses a mint that would breach the cap, and writes nothing', async () => {
      const cap = 1_000_000;
      await mintToMerchantFloat(900_000, { movementId: 'cap_1', supplyCapPaise: cap });

      const r = await mintToMerchantFloat(200_000, { movementId: 'cap_2', supplyCapPaise: cap });
      expect(r).toMatchObject({ ok: false, reason: 'supply_cap_exceeded' });
      expect(await circulatingSupplyPaise()).toBe(900_000);
      const { rows } = await pgQuery(`SELECT COUNT(*)::int n FROM treasury_entries WHERE movement_id = 'cap_2'`);
      expect(rows[0].n).toBe(0);
    });

    it('holds the cap under 50 concurrent mints', async () => {
      // The cap fits exactly 10 mints of 100_000. The guard is inside the
      // transaction behind a row lock, so a race cannot slip an eleventh
      // through — the failure a pre-read check would allow.
      const cap = 1_000_000;
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          mintToMerchantFloat(100_000, { movementId: `race_${i}`, supplyCapPaise: cap })),
      );

      expect(results.filter((r) => r.ok && !r.idempotent)).toHaveLength(10);
      expect(results.filter((r) => r.reason === 'supply_cap_exceeded')).toHaveLength(40);
      expect(await circulatingSupplyPaise()).toBe(1_000_000);
      expect((await trialBalance()).ok).toBe(true);
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('posts one movementId exactly once', async () => {
      const first = await mintToMerchantFloat(300_000, { movementId: 'idem_1' });
      const second = await mintToMerchantFloat(300_000, { movementId: 'idem_1' });
      expect(first.idempotent).toBe(false);
      expect(second).toMatchObject({ ok: true, idempotent: true });
      expect(await circulatingSupplyPaise()).toBe(300_000);
    });

    it('survives a 100-copy retry storm on one key', async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => mintToMerchantFloat(70_000, { movementId: 'storm' })),
      );
      expect(results.filter((r) => r.ok && !r.idempotent)).toHaveLength(1);
      expect(await circulatingSupplyPaise()).toBe(70_000);
      expect((await trialBalance()).ok).toBe(true);
    });

    it('never leaves a movement half-posted', async () => {
      // Both legs share one movement. If the gate fired between them the
      // ledger would stop summing to zero — which is exactly what the
      // in-transaction UNIQUE prevents.
      await Promise.all(Array.from({ length: 30 }, () =>
        merchantDispensedToUser(40_000, { movementId: 'half' })));
      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int n FROM treasury_entries WHERE movement_id = 'half'`);
      expect(rows[0].n).toBe(2);                      // both legs, once
      expect((await trialBalance()).conservesToZero).toBe(true);
    });
  });

  // ── Concurrency across accounts ────────────────────────────────────────────
  it('does not deadlock when movements touch the same accounts in opposite orders', async () => {
    await mintToMerchantFloat(10_000_000, { movementId: 'dl_seed' });
    await merchantDispensedToUser(5_000_000, { movementId: 'dl_seed2' });

    // 100 movements alternating direction between the same two accounts.
    // Accounts are locked in a fixed order regardless of leg order, so these
    // queue rather than deadlock.
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2
      ? merchantDispensedToUser(1_000, { movementId: `dl_a${i}` })
      : userPaidMerchant(1_000, { movementId: `dl_b${i}` }))));

    expect(results.every((r) => r.ok)).toBe(true);
    const tb = await trialBalance();
    expect(tb.conservesToZero).toBe(true);
    expect(tb.unexplained).toEqual([]);
  });

  // ── Append-only ────────────────────────────────────────────────────────────
  it('cannot have its entries edited or deleted, even by direct SQL', async () => {
    await mintToMerchantFloat(100_000, { movementId: 'ap_1' });
    await expect(pgQuery(`UPDATE treasury_entries SET amount_paise = 1 WHERE movement_id = 'ap_1'`))
      .rejects.toThrow(/append-only/);
    await expect(pgQuery(`DELETE FROM treasury_entries WHERE movement_id = 'ap_1'`))
      .rejects.toThrow(/append-only/);
  });

  it('rejects an entry whose own arithmetic does not hold', async () => {
    await expect(pgQuery(
      `INSERT INTO treasury_entries (tx_id, movement_id, account, amount_paise,
         balance_before_paise, balance_after_paise, operation)
       VALUES ('x','x','HOUSE_RESERVE',100,0,5000,'MANUAL')`))
      .rejects.toThrow(/treasury_entries_arithmetic/);
  });

  it('detects a balance that moved without an entry', async () => {
    await mintToMerchantFloat(100_000, { movementId: 'dr_1' });
    // MERCHANT_FLOAT, not HOUSE_RESERVE: only accounts a movement has touched
    // have rows, so nudging an untouched one updates nothing and proves nothing.
    await pgQuery(
      `UPDATE treasury_accounts SET balance_paise = balance_paise + 777 WHERE account = 'MERCHANT_FLOAT'`);

    const tb = await trialBalance();
    expect(tb.conservesToZero).toBe(false);          // the ledger no longer closes
    expect(tb.unexplained).toEqual([
      { account: 'MERCHANT_FLOAT', balance: 100_777, fromEntries: 100_000, drift: 777 },
    ]);
    expect(tb.ok).toBe(false);
  });
});
