// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The settlement rail an admin can switch, and the orders it must not disturb.
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 * The platform runs one of two P2P rails at a time and an admin moves between
 * them from the panel. The dangerous moment is not the switch — it is the two
 * hundred orders already in flight when it happens. Each of those was created
 * under a rail, with timers, an assignment path and an expectation of what the
 * merchant owes. If the switch reaches them, a player is waiting on a process
 * nobody started and a merchant is holding an obligation that changed shape
 * underneath them.
 *
 * So the rail is snapshotted onto the row at creation and the database refuses
 * to change it. Not the writer — the database. `setOrderFields` is an allowlist
 * that does not name these columns today, and it is one edit away from naming
 * them with nothing failing.
 *
 * ── Why the concurrency case is here ────────────────────────────────────────
 * "Exactly one ACTIVE policy" is the partial unique index's rule, not the
 * writer's. Two admins saving at once must not leave two rows ACTIVE with the
 * next order reading whichever the query happens to return — which is exactly
 * how the deposit policy behaved before its index existed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import {
  PAYMENT_MODES, getActivePolicy, getActivePaymentMode, publishPolicyVersion,
  getPolicyHistory, stampForNewOrder,
} from '#db/repositories/paymentModePolicy.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { openOrder, getOrder } from '#db/repositories/orders.core.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the settlement rail, and the orders it must not disturb', () => {
  let seq = 0;
  const oid = () => `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const uniqueUtr = () => `${Date.now()}`.slice(-9) + String(Math.floor(Math.random() * 900) + 100);

  // Every test leaves the platform on the rail it found it on. These run in the
  // same database as the rest of the pg tier, and an order created by an
  // unrelated suite while this one had flipped the rail would be stamped
  // CASH_ATM — a failure in a file that never mentions payment modes.
  let restore = null;

  beforeAll(async () => {
    await applySchema();
    restore = await getActivePolicy();
  }, 60_000);

  afterAll(async () => {
    if (restore && (await getActivePaymentMode()) !== restore.activeMode) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  it('seeds exactly one active policy, on the rail already in production', async () => {
    const policy = await getActivePolicy();
    expect(policy).toBeTruthy();
    expect(policy.status).toBe('ACTIVE');
    // Installing the switch changes no live behaviour.
    expect(restore.activeMode).toBe(PAYMENT_MODES.P2P_UPI);

    const { rows } = await pgQuery(
      "SELECT COUNT(*)::int AS n FROM payment_mode_policies WHERE status = 'ACTIVE'",
    );
    expect(rows[0].n).toBe(1);
  });

  it('switches the rail as a new version, leaving the old one readable', async () => {
    const before = await getActivePolicy();

    const res = await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'Moving to ATM cash withdrawal and CDM deposits.',
      changedBy: 'admin-1', changedByName: 'Ops Lead',
    });
    expect(res.ok).toBe(true);
    expect(res.policy.activeMode).toBe(PAYMENT_MODES.CASH_ATM);
    expect(res.policy.version).toBe(before.version + 1);
    expect(await getActivePaymentMode()).toBe(PAYMENT_MODES.CASH_ATM);

    // The version it replaced is still there, superseded rather than edited —
    // an auditor asking "what was in force at time T" needs the row to exist.
    const history = await getPolicyHistory({ limit: 5 });
    const old = history.find((p) => p.version === before.version);
    expect(old.status).toBe('SUPERSEDED');
    expect(old.supersededAt).toBeTruthy();
    expect(old.activeMode).toBe(before.activeMode);

    // And exactly one is active, whatever the history holds.
    const { rows } = await pgQuery(
      "SELECT COUNT(*)::int AS n FROM payment_mode_policies WHERE status = 'ACTIVE'",
    );
    expect(rows[0].n).toBe(1);
  });

  it('carries timers forward rather than resetting them to column defaults', async () => {
    await publishPolicyVersion({
      timers: { processingWindowSeconds: 777 },
      justification: 'Tuning the processing window.',
      changedByName: 'Ops Lead',
    });
    // A rail switch that silently discarded the window an admin tuned last week
    // would be a change nobody asked for, arriving with one they did.
    const switched = await publishPolicyVersion({
      activeMode: PAYMENT_MODES.P2P_UPI,
      justification: 'Back to UPI while the ATM merchants onboard.',
      changedByName: 'Ops Lead',
    });
    expect(switched.ok).toBe(true);
    expect(switched.policy.processingWindowSeconds).toBe(777);
  });

  it('refuses a switch with no reason, an unknown rail, and a zero timer', async () => {
    const before = await getActivePolicy();

    const noReason = await publishPolicyVersion({ activeMode: PAYMENT_MODES.CASH_ATM, justification: '   ' });
    expect(noReason.ok).toBe(false);
    expect(noReason.reason).toBe('JUSTIFICATION_REQUIRED');

    const unknown = await publishPolicyVersion({ activeMode: 'CRYPTO_ATM', justification: 'why not' });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe('UNKNOWN_MODE');

    // Zero is not "no limit", it is "expire immediately", and every one of
    // these gates something a human has to physically go and do.
    const zero = await publishPolicyVersion({ timers: { utrSubmitSeconds: 0 }, justification: 'no cap' });
    expect(zero.ok).toBe(false);
    expect(zero.reason).toBe('TIMER_NOT_POSITIVE');

    const stray = await publishPolicyVersion({ timers: { utrSubmitMinutes: 5 }, justification: 'wrong unit' });
    expect(stray.ok).toBe(false);
    expect(stray.reason).toBe('UNKNOWN_TIMER');

    // A refusal moves NOTHING.
    const after = await getActivePolicy();
    expect(after.version).toBe(before.version);
    expect(after.activeMode).toBe(before.activeMode);
  });

  it('refuses a link window in which no link is ever assignable', async () => {
    // A link that must have more time left than it ever has is a link the
    // merchant supplied for nothing.
    const res = await publishPolicyVersion({
      timers: { linkExpirySeconds: 120, linkMinRemainingSeconds: 120 },
      justification: 'Tightening the link window.',
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('LINK_WINDOW_UNUSABLE');
  });

  it('stamps a new order with the rail live at its creation, through BOTH insert paths', async () => {
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'Switching for the stamp test.', changedByName: 'Ops Lead',
    });
    const live = await getActivePolicy();

    // order_states has two writers. A snapshot on one of them is a platform
    // where half the orders are stamped and nothing says which half.
    const viaRecord = oid();
    await createOrderRecord({
      orderId: viaRecord, userId: 'pm-user-1', type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500,
    });
    const viaLifecycle = oid();
    await openOrder({
      orderId: viaLifecycle, userId: 'pm-user-1', type: 'DEPOSIT',
      tokenAmountPaise: 50_000,
    });

    expect((await getOrderRecord(viaRecord)).paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    expect((await getOrderRecord(viaRecord)).paymentModeVersion).toBe(live.version);
    expect((await getOrder(viaLifecycle)).paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    expect((await getOrder(viaLifecycle)).paymentModeVersion).toBe(live.version);
  });

  it('leaves an in-flight order on the rail it was born on when the switch flips', async () => {
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.P2P_UPI,
      justification: 'Starting the in-flight test on UPI.', changedByName: 'Ops Lead',
    });

    const inFlight = oid();
    await createOrderRecord({
      orderId: inFlight, userId: 'pm-user-2', type: 'WITHDRAWAL',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000, state: 'PROCESSING',
    });

    // The admin switches while this order is mid-flight.
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'Switching with an order in flight.', changedByName: 'Ops Lead',
    });

    // The platform moved. This order did not.
    expect(await getActivePaymentMode()).toBe(PAYMENT_MODES.CASH_ATM);
    expect((await getOrderRecord(inFlight)).paymentMode).toBe(PAYMENT_MODES.P2P_UPI);

    // And the order still takes the updates its own rail's flow performs.
    // A UTR is globally unique (order_states_utr_unique), so a literal here
    // collides with any other suite that used the same digits.
    const moved = await setOrderFields(inFlight, { utrNumber: uniqueUtr() });
    expect(moved).toBeTruthy();
    expect((await getOrderRecord(inFlight)).paymentMode).toBe(PAYMENT_MODES.P2P_UPI);
  });

  // The database's own refusal to move an order between rails is asserted in
  // database/tests/paymentModeImmutabilityPg.test.js. Proving it means writing
  // the column straight past every repository, which is precisely what
  // check:db-boundary forbids outside database/ — and rightly: the exception
  // is the proof itself, not a habit worth spreading to the route tier.

  it('lets exactly one of two simultaneous switches win, and tells the loser why', async () => {
    const results = await Promise.all([
      publishPolicyVersion({ activeMode: PAYMENT_MODES.CASH_ATM, justification: 'Admin A switches.' }),
      publishPolicyVersion({ activeMode: PAYMENT_MODES.P2P_UPI, justification: 'Admin B switches.' }),
    ]);
    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);

    // One ACTIVE row is the index's rule. The loser gets an answer it can act
    // on — reload and try again — not an unhandled 23505.
    expect(won.length + lost.length).toBe(2);
    expect(won.length).toBeGreaterThanOrEqual(1);
    for (const l of lost) expect(l.reason).toBe('CONCURRENT_CHANGE');

    const { rows } = await pgQuery(
      "SELECT COUNT(*)::int AS n FROM payment_mode_policies WHERE status = 'ACTIVE'",
    );
    expect(rows[0].n).toBe(1);
  });

  it('answers the stamp from an explicitly supplied policy, for tests that need the other rail', async () => {
    const stamp = await stampForNewOrder({ activeMode: PAYMENT_MODES.CASH_ATM, version: 99 });
    expect(stamp).toEqual({ mode: PAYMENT_MODES.CASH_ATM, version: 99 });
  });
});
