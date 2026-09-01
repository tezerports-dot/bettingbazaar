// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The batched merchant-balance read behind deposit routing.
 *
 * `selectBestMerchant` has to compare every candidate's spendable balance
 * against the order. One `getMerchantBalances` per candidate is a query per
 * merchant on the hot path of every deposit, so this reads them together.
 *
 * The distinction that matters is ABSENT versus ZERO. A merchant with no
 * `merchant_wallets` row has never had money move through the system at all;
 * one with a row at zero is simply empty right now. Collapsing the first into
 * the second would let a deposit be routed to a merchant the money system has
 * never seen, which is a worse failure than routing to an empty one — so the
 * Map omits them and the caller decides.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema } from '../../postgres/pgClient.js';
import { getAvailablePaiseFor } from '../../postgres/merchantWalletPg.js';

const describePg = pgConfigured() ? describe : describe.skip;

let seq = 0;
const uniq = () => `mb_${Date.now()}_${seq++}`;

const givenWallet = (id, availablePaise) => pgQuery(
  `INSERT INTO merchant_wallets (merchant_id, available_paise) VALUES ($1,$2)
     ON CONFLICT (merchant_id) DO UPDATE SET available_paise = EXCLUDED.available_paise`,
  [id, availablePaise],
);

describePg('spendable balances for many merchants at once', () => {
  beforeAll(async () => { await applySchema(); });

  it('returns a balance per merchant that has a wallet', async () => {
    const a = uniq(), b = uniq();
    await givenWallet(a, 50_000);
    await givenWallet(b, 125);

    const m = await getAvailablePaiseFor([a, b]);
    expect(m.get(a)).toBe(50_000);
    expect(m.get(b)).toBe(125);
  });

  it('OMITS a merchant with no wallet row, rather than reporting zero', async () => {
    const real = uniq(), ghost = uniq();
    await givenWallet(real, 900);

    const m = await getAvailablePaiseFor([real, ghost]);
    expect(m.has(real)).toBe(true);
    // `.get()` would answer `undefined` either way; `.has()` is the question,
    // because "never seen" and "empty" route differently.
    expect(m.has(ghost)).toBe(false);
  });

  it('distinguishes a wallet AT zero from no wallet', async () => {
    const empty = uniq();
    await givenWallet(empty, 0);
    const m = await getAvailablePaiseFor([empty, uniq()]);
    expect({ has: m.has(empty), value: m.get(empty) }).toEqual({ has: true, value: 0 });
  });

  it('handles an empty, null or duplicate-laden id list without a query', async () => {
    expect((await getAvailablePaiseFor([])).size).toBe(0);
    expect((await getAvailablePaiseFor(null)).size).toBe(0);
    const dup = uniq();
    await givenWallet(dup, 700);
    // Duplicates collapse rather than widening the IN list.
    expect((await getAvailablePaiseFor([dup, dup, dup])).size).toBe(1);
  });

  it('returns integer paise, not a driver string', async () => {
    // BIGINT comes back from node-postgres as a STRING. Left uncast, every
    // comparison in the eligibility filter would be a string comparison —
    // '900' >= 1000 is true.
    const m = uniq();
    await givenWallet(m, 900);
    const v = (await getAvailablePaiseFor([m])).get(m);
    expect(typeof v).toBe('number');
    expect(v >= 1000).toBe(false);
  });
});
