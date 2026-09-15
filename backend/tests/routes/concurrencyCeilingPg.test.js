// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The UPI rail's concurrency is whatever an operator sets. The cash rail's is 1.
 *
 * ── The owner's model, and what the code did instead ────────────────────────
 * On the UPI rail a merchant moves bank balance, so how many orders they can
 * carry at once is a judgement about that merchant — 3, 10, 100. On the CASH
 * rail it is 1 and always 1, because the notes in their hand are the same notes
 * and two orders would promise them twice.
 *
 * The RULE was already right: `concurrencyCapFor` returns 1 for CASH_ATM before
 * it looks at anything, so no configuration has ever been able to raise it.
 *
 * What was wrong was the CEILING. Two CHECK constraints, a repository validator
 * and two spec declarations all capped the setting at 10 — a limit that could
 * only ever bind the rail with no physical constraint, while the rail that
 * genuinely has one was never governed by it.
 *
 * The inline CHECK on `merchants` was a second defect wearing the first one's
 * clothes: `CREATE TABLE IF NOT EXISTS` skips the whole statement on a database
 * that already exists, so editing an inline constraint reaches a fresh install
 * and nothing else — production included. It is a guarded ALTER now, like the
 * thirty others in the file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import {
  PAYMENT_MODES, concurrencyCapFor, publishPolicyVersion, getActivePolicy,
} from '#db/repositories/paymentModePolicy.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('how many orders a merchant may carry at once', () => {
  let restore = null;

  beforeAll(async () => {
    await applySchema();
    // `payment_mode_policies` is append-only and one ACTIVE version governs the
    // platform, so this suite changes the live rail for every suite after it
    // unless it puts it back — CLAUDE.md trap 10, the config variant.
    const before = await getActivePolicy();
    restore = before
      ? { activeMode: before.activeMode, timers: { maxConcurrentOrders: before.maxConcurrentOrders } }
      : null;
  }, 60_000);

  afterAll(async () => {
    if (restore) {
      await publishPolicyVersion({
        ...restore, justification: 'concurrencyCeilingPg.test.js restoring the rail it changed',
      });
    }
    await closePg();
  });

  it('lets an operator set 100 on the UPI rail', async () => {
    // `maxConcurrentOrders` is declared in POLICY_TIMERS, so it is written
    // through `timers` like every other per-version number.
    const res = await publishPolicyVersion({
      activeMode: PAYMENT_MODES.P2P_UPI,
      timers: { maxConcurrentOrders: 100 },
      justification: 'A merchant moving bank balance can carry more than ten.',
    });
    expect(res.ok, res.message).toBe(true);
    expect(res.policy.maxConcurrentOrders).toBe(100);
    expect(concurrencyCapFor(res.policy)).toBe(100);
  });

  it('still refuses zero — that is a pause, and pausing has its own control', async () => {
    const res = await publishPolicyVersion({
      activeMode: PAYMENT_MODES.P2P_UPI, timers: { maxConcurrentOrders: 0 },
      justification: 'should be refused',
    });
    expect(res.ok).toBe(false);
    // Refused by the TIMER_NOT_POSITIVE rule, which every per-version number
    // shares — zero is not "no limit", it is "assign to nobody".
    expect(String(res.message)).toMatch(/positive|at least 1/i);
  });

  it('CANNOT be raised on the cash rail, whatever the setting says', async () => {
    // The one number on this platform that configuration may not touch.
    expect(concurrencyCapFor({ activeMode: PAYMENT_MODES.CASH_ATM, maxConcurrentOrders: 100 })).toBe(1);
    expect(concurrencyCapFor({ activeMode: PAYMENT_MODES.CASH_ATM, maxConcurrentOrders: 3 },
                             { maxConcurrentOrders: 50 })).toBe(1);
  });

  it('honours a per-merchant override above ten on the UPI rail', async () => {
    expect(concurrencyCapFor({ activeMode: PAYMENT_MODES.P2P_UPI, maxConcurrentOrders: 3 },
                             { maxConcurrentOrders: 40 })).toBe(40);
  });

  it('accepts a per-merchant override above ten in the DATABASE too', async () => {
    // The constraint, not the function. An inline CHECK edit never reaches an
    // existing database, so this asks the live table rather than the file.
    const { rows } = await pgQuery(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conname = 'merchants_concurrency_positive'`,
    );
    expect(rows.length, 'the constraint is missing entirely').toBe(1);
    expect(rows[0].d, 'the 1..10 ceiling is still on the merchants table').not.toMatch(/BETWEEN 1 AND 10/i);
  });
});
