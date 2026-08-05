// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Admin issuance — which store runs, and what the caller sees either way.
 *
 * adminIssuancePg.test.js proves the BEHAVIOUR against a real PostgreSQL: the
 * idempotency gate, the burn-not-erasure rollback, the cap under contention.
 * What is left is the contract the routes depend on, and it is a contract about
 * SAMENESS — `merchant.admin.routes.js` renders `supply` into a JSON response
 * and turns one specific error into a 400, and it must not be able to tell
 * which store answered. A response shape that drifted between the two would
 * make the flip a user-visible change, which is exactly what a migration is
 * supposed not to be.
 *
 * The Mongo branch is asserted here too. It is the branch that runs in
 * production today, and the refactor that moved it out of the routes file is
 * the kind that silently changes an $inc into a $set.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const authoritative = vi.hoisted(() => ({ value: false }));
const config = vi.hoisted(() => ({ doc: { adminTokenSupply: { cap: 10_000, minted: 2_000 } } }));
const calls = vi.hoisted(() => []);

vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: () => authoritative.value };
});

vi.mock('mongoose', () => ({
  default: {
    model: () => ({
      findOneAndUpdate: (filter, update, options) => {
        calls.push({ op: 'mongo:findOneAndUpdate', filter, update, options });
        return {
          lean: async () => config.doc,
          catch: async () => {},
        };
      },
      updateOne: (filter, update, options) => {
        calls.push({ op: 'mongo:updateOne', filter, update, options });
        return { catch: async () => {} };
      },
      findOne: () => ({ select: () => ({ lean: async () => config.doc }) }),
    }),
  },
}));

const treasury = vi.hoisted(() => ({
  mint: { ok: true, idempotent: false, balances: { TOKEN_SUPPLY: -500_000 } },
  burn: { ok: true, idempotent: false, balances: { TOKEN_SUPPLY: 0 } },
}));

vi.mock('../../postgres/treasuryPg.js', () => ({
  ACCOUNTS: { TOKEN_SUPPLY: 'TOKEN_SUPPLY', MERCHANT_FLOAT: 'MERCHANT_FLOAT' },
  DEFAULT_SUPPLY_CAP_PAISE: 10_000_000_000 * 100,
  mintToMerchantFloat: (paise, args) => { calls.push({ op: 'pg:mint', paise, args }); return treasury.mint; },
  burnFromMerchantFloat: (paise, args) => { calls.push({ op: 'pg:burn', paise, args }); return treasury.burn; },
  getTreasuryBalances: async () => treasury.mint.balances,
}));

const mirrorAdminSupply = vi.fn();
const reverseMirrorAdminSupply = vi.fn();
vi.mock('../../postgres/dualWrite.js', () => ({ mirrorAdminSupply }));
vi.mock('../../postgres/reverseMirror.js', () => ({ reverseMirrorAdminSupply }));

const {
  reserveAdminMint, rollbackAdminMint, adminTokenSupply,
} = await import('../../postgres/adminIssuanceAuthority.js');

const ops = () => calls.map((c) => c.op);

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  authoritative.value = false;
  config.doc = { adminTokenSupply: { cap: 10_000, minted: 2_000 } };
  treasury.mint = { ok: true, idempotent: false, balances: { TOKEN_SUPPLY: -500_000 } };
  treasury.burn = { ok: true, idempotent: false, balances: { TOKEN_SUPPLY: 0 } };
});

describe('MongoDB authority — the path production runs today', () => {
  it('increments the counter with the cap guard in the FILTER, not in a read', async () => {
    await reserveAdminMint({ amountTokens: 500, movementId: 'mv1' });
    const write = calls.find((c) => c.op === 'mongo:findOneAndUpdate');
    // The guard has to be part of the matched document, or two concurrent
    // mints both read headroom that only one of them can have. This is the
    // one thing the Mongo original gets right and the refactor must not lose.
    expect(write.filter.$expr).toBeDefined();
    expect(write.update.$inc).toEqual({ 'adminTokenSupply.minted': 500 });
    expect(ops()).not.toContain('pg:mint');
  });

  it('never combines $expr with upsert — MongoDB refuses that outright', async () => {
    config.doc = null; // force the create-then-retry path as well
    await reserveAdminMint({ amountTokens: 500, movementId: 'mv1' }).catch(() => {});

    // The bug this pins down shipped in production and threw on EVERY admin
    // mint: "$expr is not allowed in the query predicate for an upsert". It
    // survived because nothing exercised the path against a real MongoDB —
    // so the invariant is asserted here, where it runs with no database at all.
    const offenders = calls.filter(
      (c) => c.filter?.$expr && c.options?.upsert,
    );
    expect(offenders).toEqual([]);

    // And the two halves must both still be there: a guarded update with no
    // upsert, and an upsert with no $expr to create the document.
    expect(calls.some((c) => c.filter?.$expr && !c.options?.upsert)).toBe(true);
    expect(calls.some((c) => c.options?.upsert && !c.filter?.$expr)).toBe(true);
  });

  it('retries the guard exactly once after creating the document', async () => {
    config.doc = null;
    await reserveAdminMint({ amountTokens: 500, movementId: 'mv1' }).catch(() => {});
    // Two guarded attempts, never a loop: a second miss is a real cap breach,
    // and spinning on it would turn a clean 400 into a hang.
    expect(calls.filter((c) => c.op === 'mongo:findOneAndUpdate')).toHaveLength(2);
  });

  it('returns the {cap, minted} shape the admin panel renders', async () => {
    const r = await reserveAdminMint({ amountTokens: 500, movementId: 'mv1' });
    expect(r).toMatchObject({ cap: 10_000, minted: 2_000, store: 'mongo' });
  });

  it('projects the mint onto the treasury so a cutover finds the supply already there', async () => {
    await reserveAdminMint({ amountTokens: 500, movementId: 'mv1', merchantId: 'm1' });
    expect(mirrorAdminSupply).toHaveBeenCalledWith(expect.objectContaining({
      movementId: 'mv1', amountPaise: 50_000, merchantId: 'm1',
    }));
    expect(reverseMirrorAdminSupply).not.toHaveBeenCalled();
  });

  it('mirrors a rollback as a NEGATIVE amount under its own key', async () => {
    await rollbackAdminMint({ amountTokens: 500, movementId: 'mv1' });
    // dualWrite turns a negative into a BURN. Mongo erases by decrementing; the
    // treasury must record the reversal instead, or the two stores stop being
    // comparable and reconcileAdminSupply is measuring nothing.
    expect(mirrorAdminSupply).toHaveBeenCalledWith(expect.objectContaining({
      movementId: 'mv1_burn', amountPaise: -50_000,
    }));
  });

  it('raises the 400 the routes translate, when the cap guard matches nothing', async () => {
    config.doc = null; // findOneAndUpdate matched no document — cap exceeded
    const err = await reserveAdminMint({ amountTokens: 1, movementId: 'mv1' }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Admin token supply cap exceeded');
  });

  it('reads the supply straight off SystemConfig', async () => {
    expect(await adminTokenSupply()).toEqual({ cap: 10_000, minted: 2_000 });
  });
});

describe('PostgreSQL authority — the same contract, a different store', () => {
  beforeEach(() => { authoritative.value = true; });

  it('mints through the treasury and never touches the counter', async () => {
    await reserveAdminMint({ amountTokens: 5_000, movementId: 'mv1', merchantId: 'm1' });
    expect(ops()).toContain('pg:mint');
    expect(ops()).not.toContain('mongo:findOneAndUpdate');
  });

  it('carries the caller key, the actor and the merchant into the movement', async () => {
    await reserveAdminMint({
      amountTokens: 5_000, movementId: 'mv1', merchantId: 'm1', actor: 'admin1',
      refModel: 'MerchantAdminTokenOrder', refId: 'o9',
    });
    const { paise, args } = calls.find((c) => c.op === 'pg:mint');
    expect(paise).toBe(500_000); // rupees crossed into integer paise at the boundary
    expect(args).toMatchObject({
      movementId: 'mv1', actor: 'admin1', refModel: 'MerchantAdminTokenOrder', refId: 'o9',
    });
  });

  it('enforces the cap an admin configured in Mongo, not a constant', async () => {
    await reserveAdminMint({ amountTokens: 1, movementId: 'mv1' });
    const { args } = calls.find((c) => c.op === 'pg:mint');
    // 10,000 tokens → 1,000,000 paise. Reading the ceiling from the store that
    // owns the SETTING, while the money moves in the store that owns the
    // BALANCE, is what keeps the flip invisible to an admin.
    expect(args.supplyCapPaise).toBe(1_000_000);
  });

  it('returns the same {cap, minted} shape, derived from the contra account', async () => {
    const r = await reserveAdminMint({ amountTokens: 5_000, movementId: 'mv1' });
    // minted is the NEGATION of TOKEN_SUPPLY: -500_000 paise → 5,000 tokens.
    expect(r).toMatchObject({ cap: 10_000, minted: 5_000, store: 'postgres' });
  });

  it('raises the same 400, with detail the counter could never supply', async () => {
    treasury.mint = {
      ok: false, reason: 'supply_cap_exceeded',
      capPaise: 1_000_000, circulatingPaise: 900_000, requestedPaise: 200_000,
    };
    const err = await reserveAdminMint({ amountTokens: 2_000, movementId: 'mv1' }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Admin token supply cap exceeded');
    expect(err.detail).toEqual({ capTokens: 10_000, circulatingTokens: 9_000, requestedTokens: 2_000 });
    expect(reverseMirrorAdminSupply).not.toHaveBeenCalled();
  });

  it('rolls back as a burn under a distinct key', async () => {
    await rollbackAdminMint({ amountTokens: 5_000, movementId: 'mv1' });
    const { args } = calls.find((c) => c.op === 'pg:burn');
    // A distinct key, or the burn would collide with its own mint's
    // idempotency gate and silently do nothing.
    expect(args.movementId).toBe('mv1_burn');
  });

  it('keeps the Mongo counter current so a fallback reads what Postgres decided', async () => {
    await reserveAdminMint({ amountTokens: 5_000, movementId: 'mv1' });
    expect(reverseMirrorAdminSupply).toHaveBeenCalledWith({ minted: 5_000, cap: 10_000 });
    expect(mirrorAdminSupply).not.toHaveBeenCalled();
  });

  it('refuses a mint with no idempotency key', async () => {
    await expect(reserveAdminMint({ amountTokens: 1 })).rejects.toThrow(/movementId/);
    await expect(rollbackAdminMint({ amountTokens: 1 })).rejects.toThrow(/movementId/);
  });

  it('rejects a non-positive or non-finite amount before anything is written', async () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      await expect(reserveAdminMint({ amountTokens: bad, movementId: 'mv1' })).rejects.toThrow(/positive number/);
    }
    expect(ops()).toEqual([]);
  });
});
