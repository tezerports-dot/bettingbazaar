// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Casino rounds and General bonuses reach the ledger (owner, 2026-10-17), so
 * PLATFORM_REVENUE is the same money the Profit & Loss page counts:
 *   · a casino round's net to the house is booked, and a later win books its
 *     reversal (the difference from what is already booked), once per state;
 *   · a referral bonus is booked once as a cost against revenue.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { creditReferralBonus } from '../repositories/promo.js';
import {
  reconcileCasinoRounds, reconcilePromoGrants,
} from '../../backend/domains/revenue/revenueSettlement.service.js';

const describePg = pgConfigured() ? describe : describe.skip;

/** USER_FUNDS legs booked for one ref: the net the ledger holds for it. */
const booked = async (refModel, refId) => Number((await pgQuery(
  `SELECT COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) AS n
     FROM accounting_events e, jsonb_array_elements(e.postings) p
    WHERE e.ref_model = $1 AND e.ref_id = $2 AND p->>'account' = 'USER_FUNDS'`, [refModel, refId])).rows[0].n);

describePg('casino rounds and General bonuses in the ledger', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('books a casino round net, then the reversal of a later win, once each', async () => {
    const roundId = `lcp-${randomUUID()}`;
    const { rows } = await pgQuery(
      `INSERT INTO casino_rounds (round_id, user_id, provider_key, debited_paise, debited_deposit_paise, updated_at)
       VALUES ($1, $2, 'lcp-test', 100_00, 100_00, now() - interval '1 hour') RETURNING id::text AS id`,
      [roundId, `lcp-user-${randomUUID()}`],
    );
    const id = rows[0].id;
    await reconcileCasinoRounds(1000);
    expect(await booked('CasinoRound', id)).toBe(100_00);
    await reconcileCasinoRounds(1000);
    expect(await booked('CasinoRound', id)).toBe(100_00); // a replay books nothing

    // The player wins 250: the house is now 150 down on this round.
    await pgQuery(`UPDATE casino_rounds SET credited_paise = 250_00, updated_at = now() - interval '1 hour' WHERE id = $1::bigint`, [id]);
    await reconcileCasinoRounds(1000);
    expect(await booked('CasinoRound', id)).toBe(-150_00);
  });

  it('leaves a round still in play alone', async () => {
    const { rows } = await pgQuery(
      `INSERT INTO casino_rounds (round_id, user_id, provider_key, debited_paise, debited_deposit_paise)
       VALUES ($1, $2, 'lcp-test', 40_00, 40_00) RETURNING id::text AS id`,
      [`lcp-${randomUUID()}`, `lcp-user-${randomUUID()}`],
    );
    await reconcileCasinoRounds(1000);
    expect(await booked('CasinoRound', rows[0].id)).toBe(0);
  });

  it('books a referral bonus once, as a cost against revenue', async () => {
    const userId = `lcp-user-${randomUUID()}`;
    const paid = await creditReferralBonus({ userId, amountPaise: 25_00, earningId: `lcp-${randomUUID()}` });
    expect(paid).toBeTruthy();
    const { rows } = await pgQuery(`SELECT grant_id FROM promo_grants WHERE user_id = $1`, [userId]);
    expect(rows).toHaveLength(1);
    await reconcilePromoGrants(1000);
    await reconcilePromoGrants(1000);
    expect(await booked('PromoGrant', rows[0].grant_id)).toBe(-25_00);
    const revenue = Number((await pgQuery(
      `SELECT SUM((p->>'amountPaise')::BIGINT) AS n FROM accounting_events e, jsonb_array_elements(e.postings) p
        WHERE e.ref_model = 'PromoGrant' AND e.ref_id = $1 AND p->>'account' = 'PLATFORM_REVENUE'`, [rows[0].grant_id])).rows[0].n);
    expect(revenue).toBe(25_00); // a debit to a credit-normal account: revenue down
  });
});
