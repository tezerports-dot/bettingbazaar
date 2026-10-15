// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The payout hold (schema.sql "PAYOUT HOLD"; owner, 2026-10-15), against a
 * REAL PostgreSQL (skipped when DATABASE_URL is unset): moving a player's bank
 * details to another account, or relinking their Telegram, refuses every new
 * withdrawal for 24 hours. Setting bank details the first time does not, and
 * a buy is never held.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser, getUser, updateUser } from '../repositories/users.js';
import { createOrderRecord } from '../repositories/orders.record.js';

const describePg = pgConfigured() ? describe : describe.skip;

const BANK_A = { accountHolderName: 'Asha', accountNumber: '111122223333', ifscCode: 'HDFC0000001', bankName: 'HDFC' };
const BANK_B = { accountHolderName: 'Asha', accountNumber: '444455556666', ifscCode: 'ICIC0000002', bankName: 'ICICI' };

let n = 0;
const sell = (userId = 'p1') => createOrderRecord({
  orderId: `WD_hold_${++n}`, userId, type: 'WITHDRAWAL', tokenAmountRupees: 500,
});
const buy = (userId = 'p1') => createOrderRecord({
  orderId: `DP_hold_${++n}`, userId, type: 'DEPOSIT', tokenAmountRupees: 500,
});
const holdRefusal = { code: '23514', constraint: 'order_states_payout_hold' };

describePg('payout hold (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE users RESTART IDENTITY CASCADE');
    await pgQuery('TRUNCATE order_states CASCADE');
    await createUser({ userId: 'p1', username: 'asha', mobile: '9990000101' });
    await createUser({ userId: 'p2', username: 'ravi', mobile: '9990000102' });
  });

  it('setting bank details the first time starts no hold', async () => {
    await updateUser('p1', { bankDetails: BANK_A });
    expect((await getUser('p1')).payoutHoldUntil).toBeNull();
    await expect(sell()).resolves.toBeTruthy();
  });

  it('moving to another bank account holds withdrawals for 24 hours', async () => {
    await updateUser('p1', { bankDetails: BANK_A });
    await updateUser('p1', { bankDetails: BANK_B });
    const until = new Date((await getUser('p1')).payoutHoldUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(until - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 5_000);
    await expect(sell()).rejects.toMatchObject(holdRefusal);
    // Buys and other players are untouched.
    await expect(buy()).resolves.toBeTruthy();
    await updateUser('p2', { bankDetails: BANK_A });
    await expect(sell('p2')).resolves.toBeTruthy();
  });

  it('saving the same account again (a name or bank-name fix) starts no hold', async () => {
    await updateUser('p1', { bankDetails: BANK_A });
    await updateUser('p1', { bankDetails: { ...BANK_A, accountHolderName: 'Asha K', bankName: 'HDFC Bank' } });
    expect((await getUser('p1')).payoutHoldUntil).toBeNull();
  });

  it('the hold lifts once it has passed, and never moves earlier', async () => {
    await updateUser('p1', { bankDetails: BANK_A });
    await pgQuery(`UPDATE users SET payout_hold_until = now() + interval '48 hours' WHERE user_id = 'p1'`);
    await updateUser('p1', { bankDetails: BANK_B });
    const until = new Date((await getUser('p1')).payoutHoldUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(47 * 3600_000);

    await pgQuery(`UPDATE users SET payout_hold_until = now() - interval '1 second' WHERE user_id = 'p1'`);
    await expect(sell()).resolves.toBeTruthy();
  });
});
