// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Funding the team commission pool cannot spend more than distributable
 * revenue, even when two fundings run at once (§32 S6): the check and the
 * posting are one transaction under a lock on PLATFORM_REVENUE
 * (`recordSpendCoveredOnPostgres`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pgConfigured, applySchema, closePg } from '../client.js';
import { recordEvent, accountBalancePaise } from '../repositories/ledger.core.js';
import { fundMerchantBonusPool } from '../../backend/domains/revenue/revenueSettlement.service.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('commission pool funding', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('two fundings at once spend at most what is distributable', async () => {
    const available = await accountBalancePaise('PLATFORM_REVENUE');
    const seed = 1000_00;
    // Revenue earned, as a settled round books it.
    await recordEvent({
      eventType: 'BET_CYCLE_SETTLED', idempotencyKey: `bfl-${randomUUID()}`, refModel: 'Cycle', refId: `bfl-${randomUUID()}`,
      postings: [{ account: 'USER_FUNDS', amountPaise: seed }, { account: 'PLATFORM_REVENUE', amountPaise: -seed }],
    });
    const each = Math.max(available, 0) + seed; // each alone fits; both together do not
    const fund = (n) => fundMerchantBonusPool({
      amountMinor: each, actor: { userId: `bfl-admin-${n}` }, justification: `race ${n}`, idempotencyKey: `bfl-${randomUUID()}`,
    });
    const results = await Promise.allSettled([fund(1), fund(2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String(results.find((r) => r.status === 'rejected').reason.message)).toMatch(/distributable platform revenue/);
    expect(await accountBalancePaise('PLATFORM_REVENUE')).toBe(available + seed - each);
  });

  it('a replay of the same key records once and is not refused', async () => {
    const seed = 50_00;
    await recordEvent({
      eventType: 'BET_CYCLE_SETTLED', idempotencyKey: `bfl-${randomUUID()}`, refModel: 'Cycle', refId: `bfl-${randomUUID()}`,
      postings: [{ account: 'USER_FUNDS', amountPaise: seed }, { account: 'PLATFORM_REVENUE', amountPaise: -seed }],
    });
    const key = `bfl-${randomUUID()}`;
    const args = { amountMinor: seed, actor: { userId: 'bfl-admin' }, justification: 'replay', idempotencyKey: key };
    const first = await fundMerchantBonusPool(args);
    const again = await fundMerchantBonusPool(args);
    expect(first.idempotent).toBe(false);
    expect(again.idempotent).toBe(true);
    expect(again.event.idempotencyKey).toBe(key);
  });
});
