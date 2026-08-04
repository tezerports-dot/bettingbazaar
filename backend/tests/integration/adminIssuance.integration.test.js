// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Admin issuance across BOTH stores — domain 4's cross-store suite.
 *
 * ── What only this can prove ────────────────────────────────────────────────
 * The other two suites each mock the store they are not about.
 * adminIssuancePg.test.js proves the treasury's behaviour against a real
 * PostgreSQL; adminIssuanceRouting.test.js proves the resolver picks the right
 * branch and that both return the same shape.
 *
 * Neither can prove the claim the domain actually rests on: that a RUNNING
 * COUNTER and a TOTAL DERIVED FROM DOUBLE-ENTRY ROWS stay equal. That is a
 * statement about two databases, and reconcileAdminSupply is the thing that
 * checks it — so a mocked treasury or a mocked SystemConfig would be checking
 * its own fixture.
 *
 * It also covers the one property the counter can never have on its own: after
 * a mint and its rollback the two stores agree on ZERO, and the treasury still
 * shows both movements. Mongo's `$inc: -amount` reaches the same number by
 * erasing the evidence, which is why the reconciliation is only meaningful
 * because the rollback is a burn.
 *
 * REQUIRES MONGODB_URI (a replica set) and DATABASE_URL. Skips otherwise.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';

const authoritative = vi.hoisted(() => ({ value: false }));

vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: () => authoritative.value };
});

const { pgConfigured, pgQuery, applySchema } = await import('../../postgres/pgClient.js');
const { ACCOUNTS, getTreasuryBalances, trialBalance } = await import('../../postgres/treasuryPg.js');
const { reconcileAdminSupply } = await import('../../postgres/reconcile.js');
const {
  reserveAdminMint, rollbackAdminMint, adminTokenSupply,
} = await import('../../postgres/adminIssuanceAuthority.js');

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const SystemConfig = () => mongoose.model('SystemConfig');

const mongoMinted = async () =>
  (await SystemConfig().findOne({ key: 'main' }).select('adminTokenSupply').lean())
    ?.adminTokenSupply?.minted ?? 0;

const pgMinted = async () => 0 - (await getTreasuryBalances())[ACCOUNTS.TOKEN_SUPPLY];

const mint = (amountTokens, movementId, extra = {}) =>
  reserveAdminMint({ amountTokens, movementId, merchantId: 'm1', actor: 'admin1', ...extra });

describePg('admin issuance — both stores', () => {
  beforeEach(async () => {
    await applySchema();
    await pgQuery('TRUNCATE treasury_entries, treasury_accounts RESTART IDENTITY CASCADE');
    await SystemConfig().create({ key: 'main', adminTokenSupply: { cap: 10_000, minted: 0 } });
    authoritative.value = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // ── Phase A: Mongo decides, the treasury follows ──────────────────────────
  describe('while MongoDB is authoritative', () => {
    it('a mint lands in both stores and reconciles', async () => {
      await mint(3_000, 'mv_fwd');

      expect(await mongoMinted()).toBe(3_000);
      expect(await pgMinted()).toBe(300_000); // paise
      expect(await reconcileAdminSupply()).toMatchObject({
        ok: true, mongoMintedTokens: 3_000, pgMintedTokens: 3_000, driftPaise: 0,
      });
      expect(await trialBalance()).toMatchObject({ ok: true, conservesToZero: true });
    });

    it('a rollback agrees on zero — and the treasury still holds both movements', async () => {
      await mint(3_000, 'mv_back');
      await rollbackAdminMint({ amountTokens: 3_000, movementId: 'mv_back', actor: 'admin1' });

      expect(await mongoMinted()).toBe(0);
      expect(await reconcileAdminSupply()).toMatchObject({ ok: true, driftPaise: 0 });

      // The asymmetry that matters. Mongo reached zero by decrementing its
      // counter and now looks like the mint never happened. The treasury
      // reached the same zero by posting a reversal, so an admin can still see
      // that 3,000 tokens were minted and returned.
      const { rows } = await pgQuery(
        `SELECT operation, COUNT(*)::int AS n FROM treasury_entries GROUP BY operation ORDER BY operation`);
      expect(rows).toEqual([{ operation: 'BURN', n: 2 }, { operation: 'MINT', n: 2 }]);
    });

    it('the reconciler SEES a mirror that never ran', async () => {
      // Exactly what a swallowed `.catch(() => {})` leaves behind: Mongo moved,
      // Postgres did not. The check exists for this, so it must fail here — a
      // reconciler that cannot report drift is decoration.
      await SystemConfig().updateOne({ key: 'main' }, { $inc: { 'adminTokenSupply.minted': 500 } });

      expect(await reconcileAdminSupply()).toMatchObject({
        ok: false, mongoMintedTokens: 500, pgMintedTokens: 0, driftPaise: -50_000,
      });
    });

    it('refuses to repair Mongo while Mongo is the source of truth', async () => {
      await SystemConfig().updateOne({ key: 'main' }, { $inc: { 'adminTokenSupply.minted': 500 } });
      // Repairing here would overwrite the authoritative counter with its own
      // follower — turning a detected drift into a silently destroyed record of
      // 500 minted tokens.
      await expect(reconcileAdminSupply({ repairMongo: true }))
        .rejects.toThrow(/refusing to repair Mongo while Mongo is authoritative/);
      expect(await mongoMinted()).toBe(500);
    });
  });

  // ── Phase B: Postgres decides, the counter follows ────────────────────────
  describe('once PostgreSQL is authoritative', () => {
    beforeEach(() => { authoritative.value = true; });

    it('the counter follows the derived total, so a fallback reads the right number', async () => {
      await mint(4_000, 'mv_rev');

      expect(await pgMinted()).toBe(400_000);
      expect(await mongoMinted()).toBe(4_000);
      expect(await reconcileAdminSupply()).toMatchObject({ ok: true, driftPaise: 0 });
    });

    it('repairs a counter that fell behind, without inventing a movement', async () => {
      await mint(4_000, 'mv_repair');
      // The reverse mirror dropped its write.
      await SystemConfig().updateOne({ key: 'main' }, { $set: { 'adminTokenSupply.minted': 0 } });
      expect(await reconcileAdminSupply()).toMatchObject({ ok: false, driftPaise: 400_000 });

      expect(await reconcileAdminSupply({ repairMongo: true })).toMatchObject({ repaired: 1 });
      expect(await mongoMinted()).toBe(4_000);
      // The repair copied a total onto the follower. It must not have posted
      // anything to the ledger it was reading from.
      expect(await pgMinted()).toBe(400_000);
      expect(await reconcileAdminSupply()).toMatchObject({ ok: true });
    });

    it('a redelivered request mints once in BOTH stores', async () => {
      await mint(2_000, 'mv_dup');
      await mint(2_000, 'mv_dup');
      await mint(2_000, 'mv_dup');

      expect(await pgMinted()).toBe(200_000);
      expect(await mongoMinted()).toBe(2_000);
      expect(await reconcileAdminSupply()).toMatchObject({ ok: true });
    });

    it('honours the cap an admin set in Mongo while the money moves in Postgres', async () => {
      await mint(9_000, 'mv_cap_a');
      const err = await mint(2_000, 'mv_cap_b').catch((e) => e);

      expect(err.status).toBe(400);
      // Refused, and nothing moved in either store.
      expect(await pgMinted()).toBe(900_000);
      expect(await mongoMinted()).toBe(9_000);
      expect(await reconcileAdminSupply()).toMatchObject({ ok: true });
    });

    it('20 racing copies of one request leave both stores agreeing on one mint', async () => {
      await Promise.all(Array.from({ length: 20 }, () => mint(500, 'mv_race').catch(() => null)));

      expect(await pgMinted()).toBe(50_000);
      expect(await adminTokenSupply()).toMatchObject({ minted: 500, cap: 10_000 });
      expect(await mongoMinted()).toBe(500);
      expect(await reconcileAdminSupply()).toMatchObject({ ok: true, driftPaise: 0 });
      expect(await trialBalance()).toMatchObject({ ok: true });
    });
  });
});
