// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The cutover preflight, against a REAL PostgreSQL with the Mongo side stubbed.
 *
 * The script's job is to give one answer — may the money move — and the two
 * ways it can be wrong are not symmetric:
 *
 *   saying NO when the answer is yes    costs a delay
 *   saying YES when the answer is no    points reads at empty tables
 *
 * So the tests that matter most are the ones that force the second mistake and
 * check it does not happen: a populated MongoDB must never be read as
 * greenfield, and a drifting reconcile must never pass.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const mongoCounts = { value: {} };
const reconcileResult = { value: { drift: false, trialBalance: { ok: true }, ledgersAgree: true } };

vi.mock('mongoose', () => ({
  default: {
    connection: {
      db: { collection: (name) => ({ estimatedDocumentCount: async () => mongoCounts.value[name] ?? 0 }) },
    },
    connect: async () => {},
    disconnect: async () => {},
    model: () => ({ find: () => ({ select: () => ({ lean: async () => [] }) }) }),
  },
}));

vi.mock('../../postgres/reconcile.js', async (orig) => {
  const actual = await orig();
  return { ...actual, runReconcile: async () => reconcileResult.value };
});

const { pgConfigured, pgQuery, applySchema, closePg } = await import('../../postgres/pgClient.js');
const { preflight } = await import('../../postgres/preflightFlip.js');
const { ALL_PATHS, PATH_ENV } = await import('../../postgres/moneyAuthority.js');

const d = pgConfigured() ? describe : describe.skip;

const named = (r, name) => r.checks.find((c) => c.name === name);

d('cutover preflight', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(async () => {
    mongoCounts.value = {};
    reconcileResult.value = { drift: false, trialBalance: { ok: true }, ledgersAgree: true };
    // Every money table, derived from the schema rather than typed — the same
    // reasoning as backend/tests/setup.js. test:pg shares one database across
    // suites, so a table this list forgets keeps another suite's fixtures and
    // the script correctly reports MIGRATION when the test meant greenfield.
    const { rows } = await pgQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    await pgQuery(`TRUNCATE ${rows.map((r) => r.tablename).join(', ')} RESTART IDENTITY CASCADE`);
  });

  it('reads two empty stores as GREENFIELD and skips the migration gates', async () => {
    const r = await preflight({ json: true, silent: true });

    expect(r.greenfield).toBe(true);
    // The adoption and drift checks are absent rather than passing, because a
    // pass over nothing is not evidence and should not read like one.
    expect(named(r, 'reconcile reports no drift')).toBeUndefined();
    expect(named(r, 'no money in either store').passed).toBe(true);
  });

  it('a single Mongo document is enough to make it a MIGRATION', async () => {
    // The asymmetry that matters. Treating live data as greenfield skips
    // adoption and points authority at tables that are empty for all history.
    mongoCounts.value = { users: 1 };
    const r = await preflight({ json: true, silent: true });

    expect(r.greenfield).toBe(false);
    expect(named(r, 'reconcile reports no drift')).toBeDefined();
  });

  it('a populated Postgres alone also makes it a MIGRATION', async () => {
    await pgQuery(
      `INSERT INTO wallets (user_id, deposit_paise) VALUES ('pf_u1', 100)
         ON CONFLICT (user_id) DO NOTHING`);
    const r = await preflight({ json: true, silent: true });

    expect(r.greenfield).toBe(false);
  });

  it('REFUSES when reconciliation reports drift', async () => {
    mongoCounts.value = { users: 5 };
    reconcileResult.value = { drift: true, trialBalance: { ok: true }, ledgersAgree: true };

    const r = await preflight({ json: true, silent: true });
    expect(r.ready).toBe(false);
    expect(named(r, 'reconcile reports no drift').passed).toBe(false);
  });

  it('REFUSES when the trial balance does not close', async () => {
    mongoCounts.value = { users: 5 };
    reconcileResult.value = { drift: false, trialBalance: { ok: false }, ledgersAgree: true };

    const r = await preflight({ json: true, silent: true });
    expect(r.ready).toBe(false);
    expect(named(r, 'trial balance closes').passed).toBe(false);
  });

  it('REFUSES when a lifecycle table was never adopted', async () => {
    // The failure the whole adoption step exists for: Mongo has orders, the
    // Postgres lifecycle table is empty, and every state check over it reads
    // clean because it has nothing to compare.
    mongoCounts.value = { paymentorders: 250 };
    await pgQuery('TRUNCATE order_states, order_transitions RESTART IDENTITY CASCADE').catch(() => {});

    const r = await preflight({ json: true, silent: true });
    expect(named(r, 'order_states adopted').passed).toBe(false);
    expect(r.ready).toBe(false);
  });

  it('warns that ONE clean pass is not the signal, on every migration run', async () => {
    mongoCounts.value = { users: 1 };
    const r = await preflight({ json: true, silent: true });
    expect(r.warnings.join(' ')).toMatch(/REPEATEDLY/);
  });

  it('prints every path\'s variable, in flip order, including the odd ones', async () => {
    const r = await preflight({ json: true, silent: true });

    expect(r.plan).toHaveLength(ALL_PATHS.length);
    expect(r.plan[0]).toBe('MONEY_AUTHORITY_WALLET=postgres');
    // The name that does not follow its path, and the reason PATH_ENV is
    // exported rather than reconstructed by the caller.
    expect(r.plan).toContain('MONEY_AUTHORITY_BONUSES=postgres');
    for (const p of ALL_PATHS) expect(r.plan).toContain(`${PATH_ENV[p]}=postgres`);
  });

  it('confirms the full set is a configuration that boots', async () => {
    const r = await preflight({ json: true, silent: true });
    expect(named(r, 'the full configuration boots').passed).toBe(true);
    expect(named(r, 'all paths resolve to postgres').passed).toBe(true);
  });

  it('never claims infrastructure testing it cannot check', async () => {
    const r = await preflight({ json: true, silent: true });
    expect(r.checks.map((c) => c.name).join(' ')).not.toMatch(/infrastructure/i);
  });
});
