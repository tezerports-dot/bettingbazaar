// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin treasury — domain 3, and the thing that closes the books.
 *
 * The invariants, asserted rather than a particular sequence:
 *   • every movement's legs sum to zero, so the WHOLE ledger sums to zero
 *   • releasing tokens is not value from nowhere — TOKEN_SUPPLY goes negative
 *     by exactly what the receiving account gains
 *   • the supply ceiling cannot be exceeded, including by concurrent releases
 *   • one movementId posts exactly once however many copies arrive
 *   • entries explain balances, and neither the entries nor a balance that
 *     moved without one can be written at all
 *
 * ── Why the movements here touch PLATFORM accounts only ────────────────────
 * USER_FLOAT and TEAM_FLOAT are not free-standing balances: the database
 * refuses a transaction in which they move by other than the wallets and the
 * team pools they describe (schema.sql, "TOKEN CONSERVATION"). So their
 * movements are proven where their sub-ledgers are — `conservationPg`,
 * `teamRoutingPg`, `walletWriters` — and what is proven here is the double
 * entry underneath all of them.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  ACCOUNTS, postMovement, getTreasuryBalances, trialBalance, circulatingSupplyPaise,
} from '../repositories/treasury.js';
import { refusedBy } from './_funding.js';

/** The platform releasing tokens it holds, and taking them back. */
const release = (a, o = {}) => postMovement({
  operation: 'ALLOCATE_OPERATIONAL_FLOAT',
  legs: { [ACCOUNTS.TOKEN_SUPPLY]: -a, [ACCOUNTS.OPERATIONAL_FLOAT]: a }, ...o });
const takeBack = (a, o = {}) => postMovement({
  operation: 'RETURN_OPERATIONAL_FLOAT',
  legs: { [ACCOUNTS.OPERATIONAL_FLOAT]: -a, [ACCOUNTS.TOKEN_SUPPLY]: a }, ...o });
/** Platform money moving between platform accounts. */
const toPool = (a, pool, o = {}) => postMovement({
  operation: `ALLOCATE_${pool}`,
  legs: { [ACCOUNTS.OPERATIONAL_FLOAT]: -a, [pool]: a }, ...o });
const fromPool = (a, pool, o = {}) => postMovement({
  operation: `RETURN_${pool}`,
  legs: { [pool]: -a, [ACCOUNTS.OPERATIONAL_FLOAT]: a }, ...o });

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

/**
 * The ceiling is `SystemConfig.adminTokenSupply.total`, read in the database
 * (`bb_token_supply_paise()`), so a test that wants a small one writes the
 * config row — and restores what it found, outside any assertion (trap 10).
 */
async function setSupplyTotal(total) {
  const { rows } = await pgQuery(
    `SELECT settings FROM config_documents WHERE scope = 'system' AND doc_key = 'main'`);
  const prior = rows[0]?.settings ?? null;
  const next = { ...(prior ?? {}), adminTokenSupply: { total } };
  await pgQuery(
    `INSERT INTO config_documents (scope, doc_key, settings) VALUES ('system','main',$1)
     ON CONFLICT (scope, doc_key) DO UPDATE SET settings = EXCLUDED.settings`, [JSON.stringify(next)]);
  return async () => {
    if (prior === null) {
      await pgQuery(`DELETE FROM config_documents WHERE scope = 'system' AND doc_key = 'main'`);
    } else {
      await pgQuery(
        `UPDATE config_documents SET settings = $1 WHERE scope = 'system' AND doc_key = 'main'`,
        [JSON.stringify(prior)]);
    }
  };
}

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
        legs: { [ACCOUNTS.TOKEN_SUPPLY]: -1000, [ACCOUNTS.OPERATIONAL_FLOAT]: 900 },
      })).rejects.toThrow(/sum to zero/);

      // And nothing was written — the check runs before any row is touched, so
      // a malformed movement never exists even momentarily.
      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM treasury_entries');
      expect(rows[0].n).toBe(0);
    });

    it('refuses a single-legged movement — value cannot appear', async () => {
      await expect(postMovement({
        movementId: 'bad_2', operation: 'MINT', legs: { [ACCOUNTS.OPERATIONAL_FLOAT]: 1000 },
      })).rejects.toThrow(/sum to zero/);
    });

    it('refuses an unknown account and a non-integer amount', async () => {
      await expect(postMovement({
        movementId: 'bad_3', operation: 'X', legs: { SLUSH_FUND: 100, [ACCOUNTS.HOUSE_RESERVE]: -100 },
      })).rejects.toThrow(/Unknown treasury account/);
      await expect(postMovement({
        movementId: 'bad_4', operation: 'X',
        legs: { [ACCOUNTS.HOUSE_RESERVE]: 10.5, [ACCOUNTS.OPERATIONAL_FLOAT]: -10.5 },
      })).rejects.toThrow(/integer number of paise/);
    });

    it('refuses an unbalanced movement written by DIRECT SQL — the row holds the rule', async () => {
      // postMovement's own arithmetic is one writer's promise. This is the
      // same rule as a property of the data: one leg, nothing to balance it.
      const refusal = await refusedBy(pgQuery(
        `INSERT INTO treasury_entries (tx_id, movement_id, account, amount_paise,
           balance_before_paise, balance_after_paise, operation)
         VALUES ('solo','solo','HOUSE_RESERVE',100,0,100,'MANUAL')`));
      // The account moved by other than its entries is noticed first; either
      // way the transaction does not commit.
      expect(refusal.constraint).toMatch(/^bb_conservation_/);
      const { rows } = await pgQuery(`SELECT COUNT(*)::int n FROM treasury_entries WHERE tx_id = 'solo'`);
      expect(rows[0].n).toBe(0);
    });

    it('keeps the ledger at zero across a long chain of movements', async () => {
      await release(1_000_000, { movementId: 'm1', actor: 'admin' });
      await toPool(5_000, ACCOUNTS.COMMISSION_POOL, { movementId: 'm5' });
      await toPool(2_000, ACCOUNTS.BONUS_POOL, { movementId: 'm6' });
      await fromPool(1_000, ACCOUNTS.BONUS_POOL, { movementId: 'm7' });
      await takeBack(10_000, { movementId: 'm8' });

      const tb = await trialBalance();
      expect(tb.conservesToZero).toBe(true);
      expect(tb.grandTotalPaise).toBe(0);
      expect(tb.unexplained).toEqual([]);
      expect(tb.ok).toBe(true);
    });
  });

  // ── Supply ─────────────────────────────────────────────────────────────────
  describe('token supply', () => {
    it('makes a release a movement, not an appearance', async () => {
      await release(1_000_000, { movementId: 'sup_1', actor: 'admin-3' });
      const b = await getTreasuryBalances();
      // The tokens exist in the float; TOKEN_SUPPLY records that they left.
      expect(b[ACCOUNTS.OPERATIONAL_FLOAT]).toBe(1_000_000);
      expect(b[ACCOUNTS.TOKEN_SUPPLY]).toBe(-1_000_000);
      expect(await circulatingSupplyPaise()).toBe(1_000_000);
      expect((await trialBalance()).conservesToZero).toBe(true);
    });

    it('reduces supply on a return, exactly inverting a release', async () => {
      await release(500_000, { movementId: 'sup_2' });
      await takeBack(500_000, { movementId: 'sup_3' });
      expect(await circulatingSupplyPaise()).toBe(0);
      expect((await getTreasuryBalances())[ACCOUNTS.OPERATIONAL_FLOAT]).toBe(0);
    });

    it('refuses a release that would breach the ceiling, and writes nothing', async () => {
      // 10,000 tokens = 1,000,000 paise.
      const restore = await setSupplyTotal(10_000);
      try {
        await release(900_000, { movementId: 'cap_1' });
        const r = await release(200_000, { movementId: 'cap_2' });
        expect(r).toMatchObject({ ok: false, reason: 'supply_cap_exceeded', capPaise: 1_000_000 });
        expect(await circulatingSupplyPaise()).toBe(900_000);
        const { rows } = await pgQuery(`SELECT COUNT(*)::int n FROM treasury_entries WHERE movement_id = 'cap_2'`);
        expect(rows[0].n).toBe(0);
      } finally { await restore(); }
    });

    it('holds the ceiling against DIRECT SQL too', async () => {
      const restore = await setSupplyTotal(10_000);
      try {
        await release(900_000, { movementId: 'cap_sql' });
        const refusal = await refusedBy(pgQuery(
          `UPDATE treasury_accounts SET balance_paise = -1200000 WHERE account = 'TOKEN_SUPPLY'`));
        expect(refusal.constraint).toBe('treasury_supply_ceiling');
        expect(await circulatingSupplyPaise()).toBe(900_000);
      } finally { await restore(); }
    });

    it('holds the ceiling under 50 concurrent releases', async () => {
      // The ceiling fits exactly 10 releases of 100_000 paise. The guard is
      // inside the transaction behind a row lock, so a race cannot slip an
      // eleventh through — the failure a pre-read check would allow.
      const restore = await setSupplyTotal(10_000);
      try {
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, i) => release(100_000, { movementId: `race_${i}` })));

        expect(results.filter((r) => r.ok && !r.idempotent)).toHaveLength(10);
        expect(results.filter((r) => r.reason === 'supply_cap_exceeded')).toHaveLength(40);
        expect(await circulatingSupplyPaise()).toBe(1_000_000);
        expect((await trialBalance()).ok).toBe(true);
      } finally { await restore(); }
    });

    it('lets tokens come BACK when the total was lowered below what is out', async () => {
      // The ceiling is asked only of a release. Lowering the total does not
      // strand what is already in circulation.
      const restore = await setSupplyTotal(10_000);
      try {
        await release(1_000_000, { movementId: 'low_1' });
        const lower = await setSupplyTotal(1_000);          // 100_000 paise
        try {
          const back = await takeBack(400_000, { movementId: 'low_2' });
          expect(back.ok).toBe(true);
          expect(await circulatingSupplyPaise()).toBe(600_000);
        } finally { await lower(); }
      } finally { await restore(); }
    });

    it('takes the ceiling from the config the admin screen writes', async () => {
      const restore = await setSupplyTotal(7);
      try {
        const { rows } = await pgQuery('SELECT bb_token_supply_paise() AS paise');
        expect(Number(rows[0].paise)).toBe(700);
      } finally { await restore(); }
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('posts one movementId exactly once', async () => {
      const first = await release(300_000, { movementId: 'idem_1' });
      const second = await release(300_000, { movementId: 'idem_1' });
      expect(first.idempotent).toBe(false);
      expect(second).toMatchObject({ ok: true, idempotent: true });
      expect(await circulatingSupplyPaise()).toBe(300_000);
    });

    it('survives a 100-copy retry storm on one key', async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => release(70_000, { movementId: 'storm' })),
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
        release(40_000, { movementId: 'half' })));
      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int n FROM treasury_entries WHERE movement_id = 'half'`);
      expect(rows[0].n).toBe(2);                      // both legs, once
      expect((await trialBalance()).conservesToZero).toBe(true);
    });
  });

  // ── Concurrency across accounts ────────────────────────────────────────────
  it('does not deadlock when movements touch the same accounts in opposite orders', async () => {
    await release(10_000_000, { movementId: 'dl_seed' });
    await toPool(5_000_000, ACCOUNTS.BONUS_POOL, { movementId: 'dl_seed2' });

    // 100 movements alternating direction between the same two accounts.
    // Accounts are locked in a fixed order regardless of leg order, so these
    // queue rather than deadlock.
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2
      ? toPool(1_000, ACCOUNTS.BONUS_POOL, { movementId: `dl_a${i}` })
      : fromPool(1_000, ACCOUNTS.BONUS_POOL, { movementId: `dl_b${i}` }))));

    expect(results.every((r) => r.ok)).toBe(true);
    const tb = await trialBalance();
    expect(tb.conservesToZero).toBe(true);
    expect(tb.unexplained).toEqual([]);
  });

  // ── Append-only ────────────────────────────────────────────────────────────
  it('cannot have its entries edited or deleted, even by direct SQL', async () => {
    await release(100_000, { movementId: 'ap_1' });
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

  it('REFUSES a balance that moves without an entry, rather than reporting it later', async () => {
    await release(100_000, { movementId: 'dr_1' });
    // This used to commit and be visible as `trialBalance().unexplained`: a
    // report after the fact. The transaction now does not commit at all
    // (owner, 2026-10-07), so there is no drift to report.
    const refusal = await refusedBy(pgQuery(
      `UPDATE treasury_accounts SET balance_paise = balance_paise + 777 WHERE account = 'OPERATIONAL_FLOAT'`));
    expect(refusal.constraint).toBe('bb_conservation_treasury_entries');

    const tb = await trialBalance();
    expect(tb.unexplained).toEqual([]);
    expect(tb.ok).toBe(true);
  });
});
