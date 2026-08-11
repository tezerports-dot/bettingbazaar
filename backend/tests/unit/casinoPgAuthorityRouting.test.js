// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Casino routing — which store owns a provider callback, and what the provider
 * is told when Postgres refuses one.
 *
 * The refusal is the product here. Every other domain's adapter surfaces a
 * refusal because overruling the source of truth is incoherent; this one does
 * it because the refusal is what stops a buggy, replayed or hostile provider
 * MINTING REAL MONEY by rolling back a round that never had a bet. So the
 * refusal path gets more attention than the happy one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const onPostgres = new Set();
vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: (path) => onPostgres.has(path) };
});

const casinoPg = { recordCallback: vi.fn(), getRound: vi.fn() };
vi.mock('../../postgres/casinoPg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordCallback: (...a) => casinoPg.recordCallback(...a),
    getRound: (...a) => casinoPg.getRound(...a),
  };
});

const reverse = { casinoRound: vi.fn() };
vi.mock('../../postgres/reverseMirror.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reverseMirrorCasinoRound: (...a) => reverse.casinoRound(...a) };
});

const walletPg = { getBalancesRupees: vi.fn() };
vi.mock('../../postgres/walletPg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getBalancesRupees: (...a) => walletPg.getBalancesRupees(...a) };
});

const mongoUser = { findById: vi.fn() };
vi.mock('mongoose', () => ({
  default: { model: (n) => {
    if (n !== 'User') throw new Error(`unexpected model(${n})`);
    return mongoUser;
  } },
}));

import { MONEY_PATHS } from '../../postgres/moneyAuthority.js';
import { onPostgres as isOn, applyCallbackOnPostgres, normaliseType } from '../../postgres/casinoPgAuthority.js';

const CALLBACK = {
  txId: 'prov-tx-1', roundId: 'r1', userId: 'u1', type: 'BET',
  amountRupees: 100, providerKey: 'acme', gameId: 'slots',
};

beforeEach(() => {
  onPostgres.clear();
  vi.clearAllMocks();
  casinoPg.recordCallback.mockResolvedValue({ ok: true, idempotent: false, round: { roundId: 'r1' } });
  casinoPg.getRound.mockResolvedValue({ roundId: 'r1' });
  reverse.casinoRound.mockResolvedValue(undefined);
  mongoUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ depositBalance: 400, winningsBalance: 100 }) }) });
});

describe('the provider vocabulary', () => {
  it('normalises the aliases every provider spells differently', () => {
    expect(normaliseType('debit')).toBe('BET');
    expect(normaliseType('CREDIT')).toBe('WIN');
    expect(normaliseType('rollback')).toBe('ROLLBACK');
    expect(normaliseType('REFUND')).toBe('REFUND');
  });

  it('refuses anything that is not a money move', () => {
    // An unrecognised type reaching the money path as a default would be the
    // worst kind of permissive.
    for (const junk of ['', null, 'PING', 'CANCEL_MAYBE']) expect(normaliseType(junk)).toBeNull();
  });
});

describe('the OFF position — Mongo owns the path', () => {
  it('reports the path as Mongo-owned', () => expect(isOn()).toBe(false));

  it('hands the callback back to the route without touching Postgres', async () => {
    expect(await applyCallbackOnPostgres(CALLBACK)).toEqual({ handled: false });
    expect(casinoPg.recordCallback).not.toHaveBeenCalled();
    expect(reverse.casinoRound).not.toHaveBeenCalled();
  });
});

describe('the ON position — Postgres owns the round', () => {
  beforeEach(() => { onPostgres.add(MONEY_PATHS.CASINO_SETTLEMENT); });

  it('records the callback in paise and mirrors it back', async () => {
    const r = await applyCallbackOnPostgres(CALLBACK);
    expect(casinoPg.recordCallback).toHaveBeenCalledWith(expect.objectContaining({
      txId: 'prov-tx-1', roundId: 'r1', type: 'BET', amountPaise: 10_000,
    }));
    expect(r).toMatchObject({ handled: true, ok: true, idempotent: false });
    expect(reverse.casinoRound).toHaveBeenCalledTimes(1);
  });

  it('SURFACES a rollback with no prior debit', async () => {
    // The exposure the domain exists for: a reversal must prove the debit it
    // reverses. Falling back to Mongo here would hand the provider the money.
    casinoPg.recordCallback.mockResolvedValue({ ok: false, reason: 'no_prior_debit', roundId: 'r9' });
    const r = await applyCallbackOnPostgres({ ...CALLBACK, type: 'ROLLBACK', roundId: 'r9' });
    expect(r).toMatchObject({ handled: true, ok: false, reason: 'no_prior_debit' });
    expect(reverse.casinoRound).not.toHaveBeenCalled();
  });

  it('SURFACES a refund that exceeds what the round took', async () => {
    casinoPg.recordCallback.mockResolvedValue({
      ok: false, reason: 'refund_exceeds_debit',
      debitedPaise: 10_000, refundedPaise: 8_000, requestedPaise: 5_000,
    });
    const r = await applyCallbackOnPostgres({ ...CALLBACK, type: 'REFUND', amountRupees: 50 });
    expect(r).toMatchObject({ handled: true, ok: false, reason: 'refund_exceeds_debit' });
    expect(reverse.casinoRound).not.toHaveBeenCalled();
  });

  it('refuses an unknown callback type before reaching the money path', async () => {
    const r = await applyCallbackOnPostgres({ ...CALLBACK, type: 'SOMETHING_ELSE' });
    expect(r).toMatchObject({ handled: true, ok: false, reason: 'unknown_type' });
    expect(casinoPg.recordCallback).not.toHaveBeenCalled();
  });

  it('reports a redelivered callback as idempotent, not as a failure', async () => {
    // Providers retry hard; duplicate callbacks are routine, and treating one
    // as an error would have the provider reconcile against a phantom failure.
    casinoPg.recordCallback.mockResolvedValue({ ok: true, idempotent: true, round: { roundId: 'r1' } });
    expect(await applyCallbackOnPostgres(CALLBACK)).toMatchObject({ ok: true, idempotent: true });
  });
});

describe('the balance the provider is told', () => {
  beforeEach(() => { onPostgres.add(MONEY_PATHS.CASINO_SETTLEMENT); });

  it('comes from MONGO while the wallet path is still Mongo-authoritative', async () => {
    // Casino settles through the user wallet directly, not the bets path, so
    // the balance follows WALLET's flag — a separate one from this module's.
    // Reading the wrong store tells the provider a number no store holds.
    const r = await applyCallbackOnPostgres(CALLBACK);
    expect(r.balanceRupees).toBe(500);
    expect(walletPg.getBalancesRupees).not.toHaveBeenCalled();
  });

  it('comes from POSTGRES once the wallet path has moved', async () => {
    onPostgres.add(MONEY_PATHS.WALLET);
    walletPg.getBalancesRupees.mockResolvedValue({ depositBalance: 250, winningsBalance: 75 });
    const r = await applyCallbackOnPostgres(CALLBACK);
    expect(r.balanceRupees).toBe(325);
    expect(walletPg.getBalancesRupees).toHaveBeenCalledWith('u1');
  });
});
