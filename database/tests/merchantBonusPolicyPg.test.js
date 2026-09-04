// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The merchant bonus rate, against a real PostgreSQL.
 *
 * This number decides how much money leaves the MERCHANT_BONUS_POOL, so the
 * tests below are about the properties the engine depends on rather than about
 * CRUD: exactly one rate is in force at a time, history is never rewritten, and
 * a policy that would pay nothing while reading as switched on is refused.
 *
 * The document version could not hold the first of those. It created the new
 * ACTIVE row and superseded the old one afterwards, in that order, as two
 * separate writes — so between them the engine could read two ACTIVE policies
 * and take whichever sorted first.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  getActivePolicy, getPolicyHistory, getPolicyVersion,
  createPolicyVersion, rollbackToVersion,
} from '../repositories/merchantBonusPolicy.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the merchant bonus policy', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE merchant_bonus_policies RESTART IDENTITY CASCADE');
  });

  const make = (over = {}) => createPolicyVersion({
    enabled: true, bonusPercent: 2, minMatchedVolume: 100,
    justification: 'initial', changedBy: 'admin-1', changedByName: 'Asha',
    ...over,
  });

  // ── The engine's read ─────────────────────────────────────────────────────
  it('reads as null before anything is configured, so the engine stays idle', async () => {
    // Not a thrown error and not a default rate: an install that has never
    // configured a bonus must pay nothing, and null is what the engine checks.
    expect(await getActivePolicy()).toBeNull();
  });

  it('returns the rate that is in force, with the percentage as a number', async () => {
    await make({ bonusPercent: 2.5 });
    const p = await getActivePolicy();
    expect(p.enabled).toBe(true);
    // NUMERIC comes back from node-postgres as a string. Uncast, `'2.5' * x`
    // happens to coerce but `'10' > '9'` is false, and a rate comparison would
    // silently invert.
    expect(p.bonusPercent).toBe(2.5);
    expect(typeof p.bonusPercent).toBe('number');
    expect(p.minMatchedVolume).toBe(100);
    expect(typeof p.minMatchedVolume).toBe('number');
  });

  // ── Exactly one in force ──────────────────────────────────────────────────
  it('leaves exactly one ACTIVE row after a change', async () => {
    await make({ bonusPercent: 2 });
    await make({ bonusPercent: 5, justification: 'raise' });

    const { rows } = await pgQuery(
      "SELECT version FROM merchant_bonus_policies WHERE status = 'ACTIVE'");
    expect(rows).toHaveLength(1);
    expect((await getActivePolicy()).bonusPercent).toBe(5);
  });

  it('refuses a second ACTIVE row written behind the repository', async () => {
    await make();
    // The index is the guard, not the writer's care. A direct INSERT bypassing
    // createPolicyVersion is exactly the shape the old two-write service
    // produced between its two statements.
    await expect(pgQuery(
      `INSERT INTO merchant_bonus_policies
         (version, status, enabled, bonus_percent, min_matched_volume, justification)
       VALUES (99, 'ACTIVE', true, 3, 100, 'smuggled')`,
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('numbers versions from the table, so two writers cannot collide', async () => {
    await make();
    await make({ justification: 'second' });
    await make({ justification: 'third' });
    const history = await getPolicyHistory();
    expect(history.map((h) => h.version)).toEqual([3, 2, 1]);
  });

  // ── History is not rewritten ──────────────────────────────────────────────
  it('keeps every superseded version readable, with when it stopped applying', async () => {
    await make({ bonusPercent: 2 });
    await make({ bonusPercent: 5, justification: 'raise' });

    const v1 = await getPolicyVersion(1);
    expect(v1.status).toBe('SUPERSEDED');
    expect(v1.bonusPercent).toBe(2);
    expect(v1.supersededAt).toBeInstanceOf(Date);
    // The name is stored, not joined: an audit trail must say who it was at the
    // time, and a later rename must not rewrite what the record says happened.
    expect(v1.changedByName).toBe('Asha');
  });

  it('rolls back by writing a NEW version, never by reviving an old one', async () => {
    await make({ bonusPercent: 2 });
    await make({ bonusPercent: 9, justification: 'too high' });

    const res = await rollbackToVersion(1, { changedBy: 'admin-2', changedByName: 'Bo' });
    expect(res.ok).toBe(true);
    expect(res.policy.version).toBe(3);
    expect(res.policy.bonusPercent).toBe(2);
    expect(res.policy.isRollback).toBe(true);
    expect(res.policy.rollbackOfVersion).toBe(1);

    // v1 stays superseded. Reviving it would erase the fact that 9% was ever
    // in force, which is the one thing a bonus dispute needs to establish.
    expect((await getPolicyVersion(1)).status).toBe('SUPERSEDED');
    expect((await getPolicyVersion(2)).status).toBe('SUPERSEDED');
    expect((await getActivePolicy()).version).toBe(3);
  });

  it('refuses a rollback to a version that does not exist', async () => {
    await make();
    const res = await rollbackToVersion(42);
    expect(res).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    // And leaves the live policy exactly where it was.
    expect((await getActivePolicy()).version).toBe(1);
  });

  // ── Refusals the table makes, not the validator ───────────────────────────
  it('refuses an enabled policy that would pay nothing', async () => {
    const res = await make({ enabled: true, bonusPercent: 0 });
    expect(res).toMatchObject({ ok: false, reason: 'ENABLED_NEEDS_PERCENT' });
    expect(await getActivePolicy()).toBeNull();
  });

  it('allows a DISABLED policy at 0%, which is how a programme is switched off', async () => {
    await make({ bonusPercent: 4 });
    const res = await make({ enabled: false, bonusPercent: 0, justification: 'pause' });
    expect(res.ok).toBe(true);
    const p = await getActivePolicy();
    expect(p.enabled).toBe(false);
    expect(p.bonusPercent).toBe(0);
  });

  it('refuses a percentage outside 0..100', async () => {
    expect(await make({ bonusPercent: 101 }))
      .toMatchObject({ ok: false, reason: 'PERCENT_OUT_OF_RANGE' });
    // Disabled, so the enabled-needs-a-percentage rule cannot fire first and
    // this asserts the range check rather than whichever constraint PostgreSQL
    // happened to evaluate before the other.
    expect(await make({ enabled: false, bonusPercent: -1 }))
      .toMatchObject({ ok: false, reason: 'PERCENT_OUT_OF_RANGE' });
  });

  it('refuses a negative minimum volume', async () => {
    expect(await make({ minMatchedVolume: -5 }))
      .toMatchObject({ ok: false, reason: 'VOLUME_NEGATIVE' });
  });

  it('refuses a change with no justification', async () => {
    expect(await make({ justification: '   ' }))
      .toMatchObject({ ok: false, reason: 'JUSTIFICATION_REQUIRED' });
  });

  it('does not supersede the live policy when the new one is refused', async () => {
    await make({ bonusPercent: 3 });
    await make({ enabled: true, bonusPercent: 0, justification: 'bad' });
    // The supersede and the insert are one transaction, so a refused insert
    // rolls the supersede back with it. Without that, a rejected save would
    // leave the platform with NO active bonus policy.
    const live = await getActivePolicy();
    expect(live).not.toBeNull();
    expect(live.bonusPercent).toBe(3);
  });
});
