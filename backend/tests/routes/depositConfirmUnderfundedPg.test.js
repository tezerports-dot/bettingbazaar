// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A buy the team's pool cannot cover — on the path a player actually takes.
 *
 * ── Where "underfunded" moved to ────────────────────────────────────────────
 * This suite used to be about a MERCHANT confirming a deposit they could not
 * fund: the confirm completed the order first and debited the merchant second,
 * so a refused debit left a paid deposit reading COMPLETED with the player
 * never credited (§21). Merchants hold no tokens any more (PROJECT_STATUS
 * §3.10, 2c). A team's POOL does, and a buy takes its tokens from the pool at
 * ASSIGNMENT, not at confirm: `teamRouting.assignToTeam` holds them in the
 * same transaction that gives the order to a member, refused by the pool
 * UPDATE's own WHERE (§32 S6). So the question "what if the tokens are not
 * there" is now asked — and must be answered — before anybody is asked to
 * serve the order, and before the player is told where to pay.
 *
 * What must be true when the answer is no:
 *   - the order stays QUEUED, with no member, no team and nothing held;
 *   - the pool and TEAM_FLOAT are exactly as they were;
 *   - two buys racing for tokens that cover one get one hold, never two;
 *   - and once the team is funded, the same order is taken on the next offer
 *     — it was waiting, not lost.
 *
 * ── What is no longer asserted, and why ─────────────────────────────────────
 * "A PAID buy the pool cannot pay is refused at confirm and stays PAID" needs a
 * PAID buy holding nothing. No production path produces one now: a buy is held
 * in the statement that assigns it, a player can mark paid only an assigned
 * order, and a PAID or DISPUTED buy keeps its hold until it completes or is
 * cancelled. Staging that row would be §32 S16. The repository's own refusal
 * (`spendForBuy` → `pool_short`) is covered in database/tests/teamRoutingPg.
 *
 * Driven through `createDepositOrder`, the function the player's buy route
 * calls, because a guard proven on the repository says nothing about whether
 * the player's path reaches it (the lesson M97 and M98 taught).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { createDepositOrder, tryAssignMerchant } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// Above the cash ceiling, so the buy runs on UPI_BANK and needs no Ready press.
const BUY_TOKENS = 20_000;
const BUY_PAISE = BUY_TOKENS * 100;

describePg('a buy the team pool cannot cover', () => {
  const teams = teamFixture();
  const orders = [];

  beforeAll(async () => { await applySchema(); }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** The only working UPI team online holds `poolTokens`, served by one member. */
  const teamWith = async (poolTokens) => {
    const member = await merchantActor();
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens, include: [member.merchantId] });
    return { member, team };
  };

  /** The player's buy, through the service their route calls. */
  const buy = async () => {
    const player = await actor({});
    const { order } = await createDepositOrder(player.userId, BUY_TOKENS);
    orders.push(order.orderId);
    return { player, orderId: order.orderId, view: order };
  };

  const teamFloat = async () => (await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT] ?? 0;

  it('stays queued, with nobody assigned and nothing held', async () => {
    // One token short. `>=` against `>` is exactly the kind of boundary a
    // guard gets wrong, so the pool is as close as it can be without covering.
    const { team } = await teamWith(BUY_TOKENS - 1);
    const poolBefore = await getPool(team.teamId);
    const floatBefore = await teamFloat();

    const { orderId, view } = await buy();

    // What the player is told: their order is waiting — not that it failed.
    expect(view.status).toBe('PENDING_QUEUE');
    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('PENDING_QUEUE');
    expect(row.merchantId ?? null).toBeNull();
    expect(row.teamId).toBeNull();
    expect(row.poolHeldPaise).toBe(0);

    // Not a token moved, in the pool or in the books.
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect(await teamFloat()).toBe(floatBefore);
  });

  it('a pool that covers the buy exactly takes it, and holds all of it', async () => {
    // The mirror, so a "fix" that simply stopped assigning buys is not
    // mistaken for one (§37 step 6).
    const { member, team } = await teamWith(BUY_TOKENS);
    const floatBefore = await teamFloat();

    const { orderId, view } = await buy();

    expect(view.status).toBe('ASSIGNED');
    expect(await getOrderRecord(orderId)).toMatchObject({
      status: 'ASSIGNED', merchantId: member.merchantId, teamId: team.teamId, poolHeldPaise: BUY_PAISE,
    });
    expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 0, heldPaise: BUY_PAISE });
    // A hold moves tokens inside the pool, not out of it: the books are unchanged.
    expect(await teamFloat()).toBe(floatBefore);
  });

  it('two buys racing for tokens that cover one: one is held, the other waits', async () => {
    // Both read a pool that covers them; only one hold can land. A guard that
    // was a read would assign both and hold 40,000 tokens the team does not own.
    const { team } = await teamWith(BUY_TOKENS);
    const [a, b] = await Promise.all([buy(), buy()]);

    const rows = await Promise.all([getOrderRecord(a.orderId), getOrderRecord(b.orderId)]);
    expect(rows.map((r) => r.status).sort()).toEqual(['ASSIGNED', 'PENDING_QUEUE']);
    const waiting = rows.find((r) => r.status === 'PENDING_QUEUE');
    expect(waiting.poolHeldPaise).toBe(0);
    expect(waiting.teamId).toBeNull();
    expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 0, heldPaise: BUY_PAISE });
  });

  it('once the team is funded, the waiting buy is taken on the next offer', async () => {
    const { member, team } = await teamWith(BUY_TOKENS - 1);
    const { orderId } = await buy();
    expect((await getOrderRecord(orderId)).status).toBe('PENDING_QUEUE');

    // The supervisor buys more tokens into the pool, through the request an
    // admin fulfils — the only way tokens reach a pool.
    await teams.fund(team, 1);

    // The call the assignment sweep makes for each queued order. (The sweep
    // itself walks every queued order in this shared database, so it is not
    // called here: another suite's leftover would be held in this pool.)
    expect(await tryAssignMerchant(await getOrderRecord(orderId))).toBe(true);
    expect(await getOrderRecord(orderId)).toMatchObject({
      status: 'ASSIGNED', merchantId: member.merchantId, teamId: team.teamId, poolHeldPaise: BUY_PAISE,
    });
    expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 0, heldPaise: BUY_PAISE });
  });
});
