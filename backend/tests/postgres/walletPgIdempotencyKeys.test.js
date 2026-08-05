// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The idempotency probe in debitSpendOrderPaise must test the keys the movement
 * would actually write — not a pattern that happens to contain them.
 *
 * It used to run `tx_id LIKE '<txId>%'`. Both of the failure modes below end the
 * same way: the probe answers "already done", the caller is told the spend
 * succeeded, and NO MONEY MOVES — a free bet. They are regression-tested here
 * rather than in walletPg.test.js because they are about the shape of the key,
 * not the arithmetic of the movement.
 *
 * The wildcard case is not hypothetical: debitForBet is reached from the
 * game-provider wallet webhook (domains/casino/gameProvider.routes.js), which
 * takes txId verbatim from the provider payload.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { debitSpendOrderPaise, getBalancesPaise, applyDeltaPaise } from '../../postgres/walletPg.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const USER = 'pg-idempotency-key-user';
const POCKETS = [
  { field: 'depositBalance',  suffix: '_dep' },
  { field: 'winningsBalance', suffix: '_win' },
];

const deposit = async () => (await getBalancesPaise(USER)).depositBalance;

describePg('debitSpendOrderPaise — idempotency keys are literal, not patterns', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE wallets, wallet_ledger RESTART IDENTITY CASCADE');
    await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 100_000, txId: 'seed' });
  });

  it('still debits normally for an ordinary key, and still replays as a no-op', async () => {
    const first = await debitSpendOrderPaise({ userId: USER, amountPaise: 30_000, txId: 'bet_ordinary', pockets: POCKETS });
    expect(first).toMatchObject({ ok: true, idempotent: false });
    expect(await deposit()).toBe(70_000);

    const replay = await debitSpendOrderPaise({ userId: USER, amountPaise: 30_000, txId: 'bet_ordinary', pockets: POCKETS });
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    expect(await deposit()).toBe(70_000); // charged exactly once
  });

  it('charges a txId of "%" instead of matching every row as a replay', async () => {
    // As a LIKE pattern this became '%%' and matched the seed row, so the debit
    // was skipped and the caller was told it had already happened.
    const r = await debitSpendOrderPaise({ userId: USER, amountPaise: 30_000, txId: '%', pockets: POCKETS });
    expect(r).toMatchObject({ ok: true, idempotent: false });
    expect(await deposit()).toBe(70_000);
  });

  it('does not let "_" match an unrelated key that differs in the separators', async () => {
    await debitSpendOrderPaise({ userId: USER, amountPaise: 10_000, txId: 'betXAXBXC', pockets: POCKETS });
    expect(await deposit()).toBe(90_000);

    // '_' is a single-character LIKE wildcard, so 'bet_A_B_C' used to match the
    // 'betXAXBXC_dep' row written above — a different movement entirely.
    const r = await debitSpendOrderPaise({ userId: USER, amountPaise: 10_000, txId: 'bet_A_B_C', pockets: POCKETS });
    expect(r).toMatchObject({ ok: true, idempotent: false });
    expect(await deposit()).toBe(80_000); // both movements charged
  });

  it('does not treat a key that is a prefix of an existing key as a replay', async () => {
    await debitSpendOrderPaise({ userId: USER, amountPaise: 10_000, txId: 'bet_c_b10', pockets: POCKETS });
    expect(await deposit()).toBe(90_000);

    // 'bet_c_b1%' matched the 'bet_c_b10_dep' row belonging to the bet above.
    const r = await debitSpendOrderPaise({ userId: USER, amountPaise: 10_000, txId: 'bet_c_b1', pockets: POCKETS });
    expect(r).toMatchObject({ ok: true, idempotent: false });
    expect(await deposit()).toBe(80_000);
  });

  it('detects the replay even when the original skipped a pocket', async () => {
    // Original draws from deposit only, so no '_win' row exists. The probe must
    // still recognise the replay from the '_dep' row alone.
    const first = await debitSpendOrderPaise({ userId: USER, amountPaise: 40_000, txId: 'bet_partial', pockets: POCKETS });
    expect(first.split).toEqual({ depositBalance: 40_000 });

    const replay = await debitSpendOrderPaise({ userId: USER, amountPaise: 40_000, txId: 'bet_partial', pockets: POCKETS });
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    expect(await deposit()).toBe(60_000);
  });
});
