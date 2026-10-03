// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An order cannot change rails. The database is what says so.
 *
 * ── Why this is a trigger and not a rule in the writer ──────────────────────
 * An order's rail is DERIVED when it is created — from its size and currency
 * (`paymentModeFor`, PROJECT_STATUS §3.10 2c) — and decides which teams can
 * serve it, its timers and the member's obligation. An order that changed rail
 * while a member was serving it would put the player in front of a process the
 * member never started, and a CASH member at a machine would be holding a UPI
 * order.
 *
 * `setOrderFields` is an allowlist and does not name `payment_mode` today. That
 * is a property of one object literal in one file, and it is one edit away from
 * being untrue with nothing failing — `SETTABLE` has grown a wrong entry three
 * times in three files already. So the refusal lives in the row.
 *
 * ── Why this test is in the database tier ───────────────────────────────────
 * Proving a trigger means writing the column straight past every repository,
 * which is exactly what `check:db-boundary` forbids outside `database/`. That
 * rule is right, and the exception is this proof rather than a habit worth
 * spreading upward.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('an order stays on the rail it was born on', () => {
  let seq = 0;
  const oid = () => `pmi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const uniqueUtr = () => `${Date.now()}`.slice(-9) + String(Math.floor(Math.random() * 900) + 100);

  const made = [];
  const seed = async (mode) => {
    const orderId = oid();
    made.push(orderId);
    await pgQuery(
      `INSERT INTO order_states
         (order_id, user_id, order_type, state, token_amount_paise, payment_mode)
       VALUES ($1, 'pmi-user', 'DEPOSIT', 'PENDING_QUEUE', 50000, $2)`,
      [orderId, mode],
    );
    return orderId;
  };

  const modeOf = async (orderId) => {
    const { rows } = await pgQuery(
      'SELECT payment_mode, state FROM order_states WHERE order_id = $1',
      [orderId],
    );
    return rows[0];
  };

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
    // Trap 10: this run's own rows, removed outside any assertion.
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await pgQuery('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await closePg();
  });

  it('refuses a write that moves an order to the other rail', async () => {
    const orderId = await seed('P2P_UPI');
    await expect(pgQuery(
      'UPDATE order_states SET payment_mode = $1 WHERE order_id = $2',
      ['CASH_ATM', orderId],
    )).rejects.toThrow(/cannot be moved/);
    expect((await modeOf(orderId)).payment_mode).toBe('P2P_UPI');
  });

  it('lets every other column move freely — this guards one column, not the row', async () => {
    // A trigger that refused ordinary updates would freeze the lifecycle, which
    // is a far worse failure than the one it prevents: every transition on the
    // order would 500 and the money would strand.
    const orderId = await seed('P2P_UPI');
    // A UTR is globally unique (order_states_utr_unique), so a literal here
    // collides with any other suite that happened to use the same digits.
    await pgQuery("UPDATE order_states SET state = 'ASSIGNED', utr = $1 WHERE order_id = $2",
      [uniqueUtr(), orderId]);
    const row = await modeOf(orderId);
    expect(row.state).toBe('ASSIGNED');
    expect(row.payment_mode).toBe('P2P_UPI');
  });

  it('refuses an unknown rail outright', async () => {
    // The CHECK is what makes "two rails" true, rather than a convention every
    // writer is trusted to honour.
    await expect(seed('CRYPTO_ATM')).rejects.toThrow(/order_states_payment_mode_known/);
  });
});
