// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An order is stamped with the rail it was VALIDATED for.
 *
 * `createDepositOrder` read the rail in force (`railNow`) and judged the amount
 * against it — a cash buy must be a denomination a machine dispenses. Then
 * `createOrderRecord` read the rail in force AGAIN to stamp the row. Two reads.
 * An admin switching rails between them produced an order stamped on a rail it
 * was never checked for: a UPI-validated ₹7,770 born as a CASH_ATM order no ATM
 * can serve, sitting in the queue until it expires (review C1).
 *
 * The gap cannot be held open with a lock — both are plain reads — so the test
 * does the next most honest thing: it makes the service's own read return the
 * policy that was live BEFORE a real switch, while the repository reads the
 * live one. That is exactly the state of the world when the switch lands
 * between the two statements.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

let staleRead = null;
vi.mock('#db/repositories/paymentModePolicy.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    // Only the SERVICE's read is replaced; `stampForNewOrder` keeps the real
    // module's own reference and reads the database.
    getActivePolicy: (...args) => (staleRead ? Promise.resolve(staleRead) : real.getActivePolicy(...args)),
  };
});

const { pgConfigured, applySchema, closePg } = await import('#db/client.js');
const { PAYMENT_MODES, publishPolicyVersion, getPolicyHistory } = await import('#db/repositories/paymentModePolicy.js');
const { getOrderRecord } = await import('#db/repositories/orders.record.js');
const { cancelOrder } = await import('#db/repositories/orders.core.js');
const { createDepositOrder } = await import('../../domains/payment/paymentProcessing.service.js');
const { actor } = await import('./_harness.js');

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the rail an order is stamped with', () => {
  let restore = null;

  beforeAll(async () => {
    await applySchema();
    [restore] = await getPolicyHistory({ limit: 1 });
  }, 60_000);

  afterAll(async () => {
    staleRead = null;
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.', changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  it('is the rail the buy was validated for, even if the admin switched in between', async () => {
    const cash = await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'The rail the buy is validated on.', changedByName: 'test',
    });
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.P2P_UPI,
      justification: 'The admin switches while the buy is in flight.', changedByName: 'test',
    });

    const player = await actor({});
    const validatedOn = cash.policy;
    staleRead = validatedOn;
    let order;
    try {
      // ₹5,000: a cash denomination, so it is legal on the rail it is judged by.
      order = await createDepositOrder(player.userId, 5000);
    } finally {
      staleRead = null;
    }
    const row = await getOrderRecord(order.orderId ?? order.order?.orderId);
    try {
      expect(row.paymentMode, 'stamped on a rail it was never validated for').toBe(PAYMENT_MODES.CASH_ATM);
      expect(row.paymentModeVersion).toBe(validatedOn.version);
    } finally {
      await cancelOrder({ orderId: row.orderId, actor: 'test', reason: 'rail snapshot suite' }).catch(() => {});
    }
  });
});
