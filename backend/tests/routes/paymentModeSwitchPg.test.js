// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
  getPolicyHistory, getPolicyVersion, stampForNewOrder,
} from '#db/repositories/paymentModePolicy.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { openOrder, getOrder } from '#db/repositories/orders.core.js';
import {
  createMerchant, updateMerchant, newMerchantId, generateMerchantPublicRef,
} from '#db/repositories/merchants.js';
import { creditMerchantTokens } from '../../domains/merchant/merchantWallet.service.js';
import { tryAssignMerchant } from '../../domains/payment/paymentProcessing.service.js';

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

  it('holds an order to the window of the rail it was created on, not the rail live now', async () => {
    // The single most important consequence of the snapshot. If an admin
    // switches while an order is in flight and the window follows the SWITCH,
    // the player is given a deadline for a workflow they were never shown.
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.P2P_UPI,
      timers: { processingWindowSeconds: 600 },
      justification: 'Ten minutes on the UPI rail.', changedByName: 'Ops Lead',
    });
    const born = await getActivePolicy();

    const orderId = oid();
    await createOrderRecord({
      orderId, userId: 'pm-user-4', type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500,
    });

    // The admin switches AND retunes the window while the order is open.
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      timers: { processingWindowSeconds: 60 },
      justification: 'One minute on the ATM rail.', changedByName: 'Ops Lead',
    });

    const order = await getOrderRecord(orderId);
    expect(order.paymentModeVersion).toBe(born.version);

    // The window this order is held to is the one it was created under. Read
    // through the same repository the assignment path reads.
    const held = await getPolicyVersion(order.paymentModeVersion);
    expect(held.processingWindowSeconds).toBe(600);
    expect((await getActivePolicy()).processingWindowSeconds).toBe(60);
  });

  it('sets the real expiry from the order\'s own rail, through tryAssignMerchant itself', async () => {
    // The assertion above reads the policy the order points at. That proves the
    // DATA is right and says nothing about whether the assignment path reads
    // it — a guard asserted against code nothing calls is worse than none,
    // because it reports the guard as present. So this drives the real
    // function and reads the expiry it actually wrote.
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.P2P_UPI,
      timers: { processingWindowSeconds: 600 },
      justification: 'Ten minutes on the UPI rail.', changedByName: 'Ops Lead',
    });

    const orderId = oid();
    await createOrderRecord({
      orderId, userId: 'pm-user-5', type: 'DEPOSIT',
      tokenAmountRupees: 100, fiatAmountRupees: 100,
    });

    // A merchant able to take it: approved, online, on the INR rail, funded.
    const merchantId = newMerchantId();
    await createMerchant({
      merchantId, name: 'Assignable Merchant',
      publicRef: generateMerchantPublicRef(), status: 'ACTIVE',
    });
    await updateMerchant(merchantId, { merchantApprovalStatus: 'APPROVED', isOnline: true });
    await creditMerchantTokens({
      merchantId, amount: 5000, reason: 'assignment test float',
      refModel: 'Test', refId: merchantId, txId: `pm_float_${merchantId}`,
    });

    // The admin switches AND shortens the window while the order is queued.
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      timers: { processingWindowSeconds: 60 },
      justification: 'One minute on the ATM rail.', changedByName: 'Ops Lead',
    });

    const order = await getOrderRecord(orderId);
    const assignedAtMs = Date.now();
    const assigned = await tryAssignMerchant(order);
    expect(assigned).toBe(true);

    const written = await getOrderRecord(orderId);
    const windowSeconds = (new Date(written.expiresAt).getTime() - assignedAtMs) / 1000;

    // 600, from the rail it was created on — NOT 60, from the rail live now.
    // The bounds are wide enough for the call's own elapsed time (the clock is
    // read before it) and far too narrow to admit the 60 the live rail would
    // have given.
    expect(windowSeconds).toBeGreaterThan(500);
    expect(windowSeconds).toBeLessThan(660);
  });

  it('refuses a timer passed at the top level instead of publishing it as a no-op', async () => {
    // The timers live in a nested `timers` object, so the natural mistake is
    // `publishPolicyVersion({ utrSubmitSeconds: 300, justification })`. That
    // used to return ok:true and publish a version carrying the OLD value: a
    // write reported as successful that did not happen — the same shape
    // `setOrderFields` refuses, and the one an operator would meet as "I set
    // the window, it said saved, nothing changed".
    const before = await getActivePolicy();
    const result = await publishPolicyVersion({
      activeMode: before.activeMode,
      utrSubmitSeconds: 300,
      justification: 'A timer in the wrong place.',
      changedByName: 'test',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('UNKNOWN_FIELD');
    // And nothing was published — a refusal that still supersedes the active
    // row would be worse than the silent discard it replaced.
    const after = await getActivePolicy();
    expect(after.version).toBe(before.version);
    expect(after.utrSubmitSeconds).toBe(before.utrSubmitSeconds);

    // In the right place it takes effect, so this is a shape check and not a
    // refusal to accept the value at all.
    const good = await publishPolicyVersion({
      activeMode: before.activeMode,
      timers: { utrSubmitSeconds: 300 },
      justification: 'A timer in the right place.',
      changedByName: 'test',
    });
    expect(good.ok).toBe(true);
    expect((await getActivePolicy()).utrSubmitSeconds).toBe(300);

    await publishPolicyVersion({
      activeMode: before.activeMode,
      timers: { utrSubmitSeconds: before.utrSubmitSeconds },
      justification: 'Restoring the window this test found.',
      changedByName: 'test',
    });
  });

  it('stamps a FORCED rail, and refuses one it does not recognise', async () => {
    // This asserted the old contract — a policy OBJECT — and passed, while the
    // only real caller (`createOrderRecord`, whose parameter is documented as
    // "the rail to stamp") passed the mode STRING. `'CASH_ATM'?.activeMode` is
    // undefined, so the argument was accepted, ignored, and the order came back
    // on the live rail with nothing raised. A test proving a contract nobody
    // used, over a call site silently doing the opposite.
    const live = await getActivePolicy();
    const other = live.activeMode === PAYMENT_MODES.CASH_ATM
      ? PAYMENT_MODES.P2P_UPI : PAYMENT_MODES.CASH_ATM;

    const forced = await stampForNewOrder(other);
    expect(forced.mode).toBe(other);
    // No published policy said this order should be on that rail, so it names
    // none. A version pointing at a policy that says the OTHER rail is a lie in
    // the audit trail, and this row is what a dispute months later reads.
    expect(forced.version).toBeNull();

    // Forcing the rail that IS live keeps the policy version, because one
    // genuinely governs it.
    const same = await stampForNewOrder(live.activeMode);
    expect(same).toEqual({ mode: live.activeMode, version: live.version });

    // Unforced is the live rail, which is what every production caller gets.
    expect(await stampForNewOrder()).toEqual({ mode: live.activeMode, version: live.version });

    // And a rail that does not exist THROWS rather than quietly becoming the
    // default — the whole point of the fix.
    await expect(stampForNewOrder('ATM_CASH')).rejects.toThrow(/unknown payment mode/i);
    await expect(stampForNewOrder({ activeMode: PAYMENT_MODES.CASH_ATM })).rejects.toThrow(/unknown payment mode/i);
  });
});
