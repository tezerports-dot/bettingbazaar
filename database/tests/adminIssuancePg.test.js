// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Admin token issuance — domain 4, against a REAL PostgreSQL.
 *
 * ── What is actually on trial here ──────────────────────────────────────────
 * Not "does the database work". The counter this replaced had three named
 * defects, and a
 * port that reproduced them in a better database would be worthless. Each one
 * gets a test that FAILS if the defect comes back:
 *
 *   1. `reserveAdminMint(amount)` has NO idempotency key. Two deliveries of one
 *      admin request mint twice, and nothing in the system can distinguish that
 *      from two legitimate top-ups.
 *   2. Its rollback is `$inc: { minted: -amount }` under `.catch(() => {})`. A
 *      retried rollback invents headroom under the cap; a swallowed failure
 *      leaves the supply figure permanently wrong with nothing to check it
 *      against.
 *   3. A single counter cannot say where the tokens went.
 *
 * ── Why the reconciliation is only possible because of (2) ──────────────────
 * reconcileAdminSupply compares a running counter against a total derived from
 * double-entry rows. That comparison means something only if the derived side
 * cannot be edited into agreement — which is precisely the difference between a
 * burn (a new movement) and a decrement (an erasure). The rollback design and
 * the reconciliation are the same decision seen from two ends.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const { pgConfigured, pgQuery, applySchema, closePg, getPool } = await import('../client.js');
const { ACCOUNTS, getTreasuryBalances, trialBalance } = await import('../repositories/treasury.js');
const {
  reserveAdminMint, rollbackAdminMint, adminTokenSupply, DEFAULT_CAP_TOKENS,
} = await import('../repositories/adminIssuance.js');
const {
  applySystemConfig, invalidateConfigCache,
} = await import('../repositories/config.js');

/**
 * Set the admin-configured ceiling for real.
 *
 * The cap used to be read from a document store and this suite stubbed the
 * driver to supply it. It is a declared configuration setting now, so the test
 * writes it the way an admin does — which means the spec's own bounds apply and
 * a cap the code could never legally see cannot be tested into existence.
 *
 * The cache is invalidated because config reads are cached for a few seconds,
 * and a test that set a value and then read the previous one would pass or fail
 * on timing.
 */
async function setCapTokens(cap) {
  await applySystemConfig({ adminTokenSupply: { cap } }, { actor: 'test' });
  invalidateConfigCache();
}

/**
 * Put the ceiling back to the platform default.
 *
 * NOT by deleting the configuration row. Two reasons, and the second is the
 * interesting one:
 *
 *   • The version table is append-only, so a deleted document's versions
 *     survive it and the next write restarts the counter straight into a
 *     unique-constraint collision.
 *   • A missing document is not "no ceiling" any more. `getConfig` fills every
 *     absent key with its DECLARED default, and the spec declares the same
 *     10,000,000,000 the code carries as its built-in — deliberately, so the
 *     two cannot drift. "An admin has never set a ceiling" and "an admin set it
 *     back to the default" are the same state, which is the point of declaring
 *     defaults in one place.
 */
async function clearCap() {
  await setCapTokens(DEFAULT_CAP_TOKENS);
}

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const mint = (amountTokens, movementId, extra = {}) =>
  reserveAdminMint({ amountTokens, movementId, merchantId: 'm1', actor: 'admin1', ...extra });

const entriesFor = async (movementId) => {
  const { rows } = await pgQuery(
    `SELECT account, amount_paise, operation, ref_model, ref_id, actor
       FROM treasury_entries WHERE movement_id = $1 ORDER BY account`, [movementId],
  );
  return rows;
};

describePg('Admin token issuance (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE treasury_entries, treasury_accounts RESTART IDENTITY CASCADE');
    await clearCap();
    vi.clearAllMocks();
  });

  // ── Defect 1: no idempotency key ──────────────────────────────────────────
  describe('a mint happens once however many times the request arrives', () => {
    it('mints, and reports the {cap, minted} shape in tokens', async () => {
      const r = await mint(5_000, 'mv1');

      expect(r).toMatchObject({ minted: 5_000, cap: DEFAULT_CAP_TOKENS, idempotent: false, store: 'postgres' });
      // Minting is TOKEN_SUPPLY going negative, not value appearing from
      // nowhere. The tokens it created are visible in the float that received
      // them, and the two legs cancel.
      expect(await getTreasuryBalances()).toMatchObject({
        [ACCOUNTS.TOKEN_SUPPLY]: -500_000, [ACCOUNTS.MERCHANT_FLOAT]: 500_000,
      });
      expect(await trialBalance()).toMatchObject({ ok: true, conservesToZero: true });
    });

    it('a replayed request under the same key mints NOTHING further', async () => {
      await mint(5_000, 'mv_replay');
      const again = await mint(5_000, 'mv_replay');

      expect(again).toMatchObject({ idempotent: true, minted: 5_000 });
      // The whole defect, in one number: 5,000 and not 10,000.
      expect(await adminTokenSupply()).toMatchObject({ minted: 5_000 });
      expect(await entriesFor('mv_replay')).toHaveLength(2);
    });

    it('two DIFFERENT keys are two real top-ups, not a duplicate', async () => {
      await mint(5_000, 'mv_a');
      await mint(3_000, 'mv_b');
      // The distinction the counter could never make. Idempotency must not
      // collapse deliberate repeats — only redeliveries of the same request.
      expect(await adminTokenSupply()).toMatchObject({ minted: 8_000 });
    });

    it('refuses a mint with no key at all — the original signature is unusable here', async () => {
      await expect(reserveAdminMint({ amountTokens: 100 })).rejects.toThrow(/movementId/);
    });
  });

  // ── Defect 2: the erasing, non-idempotent rollback ────────────────────────
  describe('a rollback is a burn, not an erasure', () => {
    it('returns the supply to where it was, and leaves BOTH movements behind', async () => {
      await mint(5_000, 'mv_roll');
      const back = await rollbackAdminMint({ amountTokens: 5_000, movementId: 'mv_roll', actor: 'admin1' });

      expect(back).toMatchObject({ ok: true, store: 'postgres' });
      expect(await adminTokenSupply()).toMatchObject({ minted: 0 });

      // The difference from a decrement. An admin investigating a discrepancy
      // can see that a mint happened AND was reversed — the counter version
      // leaves a system that looks like the mint never occurred.
      expect(await entriesFor('mv_roll')).toHaveLength(2);
      expect(await entriesFor('mv_roll_burn')).toHaveLength(2);
      const ops = (await pgQuery(`SELECT DISTINCT operation FROM treasury_entries ORDER BY operation`)).rows;
      expect(ops.map((r) => r.operation)).toEqual(['BURN', 'MINT']);
    });

    it('a retried rollback does not invent headroom under the cap', async () => {
      await mint(5_000, 'mv_twice');
      await rollbackAdminMint({ amountTokens: 5_000, movementId: 'mv_twice' });
      const again = await rollbackAdminMint({ amountTokens: 5_000, movementId: 'mv_twice' });

      expect(again).toMatchObject({ ok: true, idempotent: true });
      // A blind decrement would be at -5,000 here: headroom released
      // twice for one mint, and a supply figure that says fewer tokens exist
      // than actually do.
      expect(await adminTokenSupply()).toMatchObject({ minted: 0 });
      expect(await trialBalance()).toMatchObject({ ok: true });
    });

    it('the books still close after a mint/rollback pair', async () => {
      await mint(1_234, 'mv_close');
      await rollbackAdminMint({ amountTokens: 1_234, movementId: 'mv_close' });
      const tb = await trialBalance();
      expect(tb.ok).toBe(true);
      expect(tb.grandTotalPaise).toBe(0);
      // Never -0: this number is compared and rendered, and Object.is(-0, 0)
      // is false.
      expect(Object.is(tb.circulatingSupplyPaise, 0)).toBe(true);
    });
  });

  // ── Defect 3: a counter cannot say where tokens went ──────────────────────
  it('records which merchant and which order caused the issuance', async () => {
    await mint(2_000, 'mv_who', { refModel: 'MerchantAdminTokenOrder', refId: 'order99' });
    const rows = await entriesFor('mv_who');

    expect(rows.every((r) => r.ref_model === 'MerchantAdminTokenOrder')).toBe(true);
    expect(rows.every((r) => r.ref_id === 'order99')).toBe(true);
    expect(rows.every((r) => r.actor === 'admin1')).toBe(true);
  });

  // ── The cap ───────────────────────────────────────────────────────────────
  describe('the supply ceiling', () => {
    it('refuses a mint that would breach it, with the shape the routes turn into a 400', async () => {
      await setCapTokens(10_000);
      await mint(9_000, 'mv_cap1');

      const err = await mint(2_000, 'mv_cap2').catch((e) => e);
      expect(err.status).toBe(400);
      expect(err.message).toBe('Admin token supply cap exceeded');
      // Detail a single counter never had: what the ceiling is, how much is out,
      // and what was asked for.
      expect(err.detail).toEqual({ capTokens: 10_000, circulatingTokens: 9_000, requestedTokens: 2_000 });
      expect(await adminTokenSupply()).toMatchObject({ minted: 9_000 });
    });

    it('enforces the cap an ADMIN configured, not a constant compiled in', async () => {
      await setCapTokens(1_000);
      await expect(mint(1_001, 'mv_cap3')).rejects.toThrow(/cap exceeded/);
      await setCapTokens(2_000);
      await expect(mint(1_001, 'mv_cap4')).resolves.toMatchObject({ minted: 1_001 });
    });

    it('falls back to the built-in ceiling when SystemConfig has never been written', async () => {
      await clearCap();
      expect(await mint(100, 'mv_cap5')).toMatchObject({ cap: DEFAULT_CAP_TOKENS });
    });
  });

  // ── The reported supply is DERIVED, never accumulated ─────────────────────
  //
  // These assertions used to be made against a mirror that copied the supply
  // to a second store, and they were really about the number rather than the
  // copy: `minted` is re-derived from the treasury on every read, so a pass
  // that ran late, twice, or not at all still converges on the right total
  // instead of accumulating its own misses. The mirror is gone; the property
  // is the same one, asserted at the source.
  describe('the reported supply', () => {
    it('is the running TOTAL after a mint, a second mint and a rollback', async () => {
      // Two mints of DIFFERENT sizes, because after one mint the total and the
      // amount are the same number and an off-by-a-delta bug is invisible.
      await mint(5_000, 'mv_supply_a');
      expect(await adminTokenSupply()).toMatchObject({ minted: 5_000, cap: DEFAULT_CAP_TOKENS });

      await mint(3_000, 'mv_supply_b');
      expect(await adminTokenSupply()).toMatchObject({ minted: 8_000, cap: DEFAULT_CAP_TOKENS });

      // The burn returns the headroom without erasing either movement.
      await rollbackAdminMint({ amountTokens: 3_000, movementId: 'mv_supply_b' });
      expect(await adminTokenSupply()).toMatchObject({ minted: 5_000, cap: DEFAULT_CAP_TOKENS });
    });

    it('is unchanged when the ceiling refused the mint', async () => {
      await setCapTokens(100);
      await mint(100, 'mv_ok');

      await mint(1, 'mv_refused').catch(() => {});
      expect(await adminTokenSupply()).toMatchObject({ minted: 100 });
    });
  });

  // ── Concurrency: the mandate ──────────────────────────────────────────────
  describe('concurrency and pool safety', () => {
    it('100 racing copies of one request mint exactly once', async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => mint(500, 'mv_storm').catch((e) => e)),
      );

      const applied = results.filter((r) => r?.idempotent === false);
      expect(applied).toHaveLength(1);
      expect(results.filter((r) => r instanceof Error)).toHaveLength(0);
      expect(await adminTokenSupply()).toMatchObject({ minted: 500 });
      expect(await entriesFor('mv_storm')).toHaveLength(2);
    });

    it('50 concurrent mints against a cap that fits 10 admit exactly 10', async () => {
      await setCapTokens(1_000);
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => mint(100, `mv_cap_race_${i}`).catch((e) => e)),
      );

      // The guard is inside the transaction behind a row lock, so the ceiling
      // holds under contention rather than being a read that 50 callers all
      // pass before any of them writes.
      expect(results.filter((r) => !(r instanceof Error))).toHaveLength(10);
      expect(results.filter((r) => r instanceof Error).every((e) => e.status === 400)).toBe(true);
      expect(await adminTokenSupply()).toMatchObject({ minted: 1_000 });
      expect(await trialBalance()).toMatchObject({ ok: true });
    });

    it('mixed mints and burns neither deadlock nor exhaust the pool', async () => {
      const pool = await getPool();
      // Every movement touches the SAME two accounts. postMovement locks them
      // in a fixed order regardless of leg order, which is the only reason
      // mints and burns interleaving cannot take them in opposite orders and
      // deadlock — a hazard this domain creates for itself by locking two rows.
      await Promise.all(Array.from({ length: 40 }, (_, i) => mint(100, `mv_mix_${i}`)));

      const started = Date.now();
      await Promise.all(Array.from({ length: 40 }, (_, i) =>
        i % 2
          ? mint(100, `mv_mix2_${i}`)
          : rollbackAdminMint({ amountTokens: 100, movementId: `mv_mix_${i}` })));

      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(pool.totalCount);
      // A deadlock is broken by Postgres's 1s timeout, so a run that hit one
      // and retried takes seconds longer than one that simply queued.
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(await trialBalance()).toMatchObject({ ok: true, conservesToZero: true });
    });
  });
});
