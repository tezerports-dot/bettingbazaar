// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The configuration store, against a real PostgreSQL.
 *
 * These settings are JSONB rather than columns, so the enforcement that a CHECK
 * constraint would give lives in `configSpec.js` and is applied on write. The
 * tests below are that enforcement: if they pass, the spec is doing the job the
 * constraints do everywhere else.
 *
 * Two of them assert something the document model could NOT do:
 *   • an undeclared key is REFUSED — the document model silently discarded a
 *     write to a path it did not declare and reported success;
 *   • bounds hold on EVERY write — Mongoose validates `min`/`max` on a document
 *     save and skips them entirely on the update operators the admin routes
 *     use, so a 900% payout fee was accepted by all of them.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  setConfigPath,
  getConfig, getSystemConfig, getConfigs, applyConfig, applySystemConfig,
  bumpConfigCounter, getConfigHistory, restoreConfigVersion, defaultsFor,
  invalidateConfigCache,
} from '../repositories/config.js';
import { DEFAULT_CYCLE_PHASES } from '../spec/config.spec.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the configuration store', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let KEY;

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(() => {
    seq += 1;
    // A fresh document per test: config_document_versions is append-only, so a
    // suite cannot tear itself down by deleting its own audit trail.
    KEY = `t-${RUN}-${seq}`;
    invalidateConfigCache();
  });

  // ── Defaults ──────────────────────────────────────────────────────────────
  it('reads as its declared defaults when nothing has been written', async () => {
    // Never null. A caller that had to handle "config missing" would grow its
    // own fallback copy of every constant, and that second copy is the drift
    // this store exists to remove.
    const cfg = await getConfig('system', { docKey: KEY });
    expect(cfg.payoutFeePercent).toBe(0);
    expect(cfg.winningsFeePercent).toBe(1);
    expect(cfg.betLimits.thirtyMin.max).toBe(100000);
    expect(cfg.riskRules.maxWarnings).toBe(3);
    expect(cfg.version).toBe(0);
  });

  it('uses ONE copy of the cycle phase constants', async () => {
    // These were declared three times and had already drifted: the admin panel
    // drew the 30-minute block closing betting 60s before the end while the
    // engine closed it at 30s.
    const cfg = await getConfig('system', { docKey: KEY });
    expect(cfg.cyclePhases.thirtyMin).toEqual({ ...DEFAULT_CYCLE_PHASES.thirtyMin });
    expect(defaultsFor('system').cyclePhases.oneMin).toEqual({ ...DEFAULT_CYCLE_PHASES.oneMin });
  });

  it('fills in a key that was never stored, without losing the ones that were', async () => {
    await applyConfig({ scope: 'system', docKey: KEY, patch: { payoutFeePercent: 2.5 } });
    const cfg = await getConfig('system', { docKey: KEY, fresh: true });
    expect(cfg.payoutFeePercent).toBe(2.5);
    expect(cfg.winningsFeePercent).toBe(1);            // still the default
    expect(cfg.cyclePhases.fullDay.mergeBeforeEndSec).toBe(300);
  });

  // ── The two things the document model could not do ────────────────────────
  it('REFUSES an undeclared setting instead of discarding it', async () => {
    // The document model dropped this and reported success, so a misspelled
    // setting changed nothing for as long as nobody checked.
    await expect(applyConfig({
      scope: 'system', docKey: KEY, patch: { payoutFeePercnt: 5 },
    })).rejects.toThrow(/refusing to write undeclared setting 'payoutFeePercnt'/);

    await expect(applyConfig({
      scope: 'system', docKey: KEY, patch: { riskRules: { maxWarnigs: 5 } },
    })).rejects.toThrow(/refusing to write undeclared setting 'riskRules\.maxWarnigs'/);
  });

  it('ENFORCES bounds on every write — these feed money arithmetic', async () => {
    // Mongoose validates min/max on a document save and skips it on the update
    // operators the admin routes use, so all four of these were accepted.
    const bad = [
      [{ payoutFeePercent: 900 }, /'payoutFeePercent' must be <= 100/],
      [{ payoutFeePercent: -1 }, /'payoutFeePercent' must be >= 0/],
      [{ betReservePercent: 101 }, /'betReservePercent' must be <= 100/],
      [{ winningsFeePercent: -5 }, /'winningsFeePercent' must be >= 0/],
      [{ payoutMultiplier: 0 }, /'payoutMultiplier' must be >= 1/],
      [{ withdrawalHoldMinutes: 100000 }, /'withdrawalHoldMinutes' must be <= 1440/],
      [{ cycleDurationMinutes: 5 }, /'cycleDurationMinutes' must be >= 10/],
      [{ merchantOrderLimits: { maxConcurrentDepositOrders: 50 } },
        /'merchantOrderLimits\.maxConcurrentDepositOrders' must be <= 10/],
    ];
    for (const [patch, message] of bad) {
      await expect(applyConfig({ scope: 'system', docKey: KEY, patch })).rejects.toThrow(message);
    }
    // Nothing was written by any of them.
    expect((await getConfig('system', { docKey: KEY, fresh: true })).version).toBe(0);
  });

  it('refuses a value of the wrong type rather than coercing it into nonsense', async () => {
    await expect(applyConfig({ scope: 'system', docKey: KEY, patch: { maintenanceMode: 'yes' } }))
      .rejects.toThrow(/'maintenanceMode' must be true or false/);
    await expect(applyConfig({ scope: 'system', docKey: KEY, patch: { payoutFeePercent: 'free' } }))
      .rejects.toThrow(/'payoutFeePercent' must be a number/);
    await expect(applyConfig({ scope: 'system', docKey: KEY, patch: { footerPages: [1, 2] } }))
      .rejects.toThrow(/'footerPages' must be an array of strings/);
  });

  it('accepts a value AT each bound — the bounds are inclusive', async () => {
    const r = await applyConfig({
      scope: 'system', docKey: KEY,
      patch: { payoutFeePercent: 100, betReservePercent: 0, withdrawalHoldMinutes: 1440 },
    });
    expect(r.ok).toBe(true);
    const cfg = await getConfig('system', { docKey: KEY, fresh: true });
    expect(cfg.payoutFeePercent).toBe(100);
    expect(cfg.withdrawalHoldMinutes).toBe(1440);
  });

  // ── Versioning and audit ──────────────────────────────────────────────────
  it('records WHO changed WHAT, in the same transaction as the change', async () => {
    // "Who changed the payout fee, and to what?" is asked after money has
    // already moved under the new value.
    await applyConfig({
      scope: 'system', docKey: KEY, patch: { payoutFeePercent: 3 },
      actor: 'admin-1', reason: 'Board decision',
    });
    const history = await getConfigHistory('system', { docKey: KEY });
    expect(history).toHaveLength(1);
    expect(history[0].changedBy).toBe('admin-1');
    expect(history[0].reason).toBe('Board decision');
    // Only the keys the change touched, so an auditor does not diff two full
    // documents to see what an admin actually did.
    expect(history[0].changed).toEqual({ payoutFeePercent: 3 });
  });

  it('flattens a nested patch into the paths that changed', async () => {
    await applyConfig({
      scope: 'system', docKey: KEY, actor: 'admin-2',
      patch: { riskRules: { maxWarnings: 5 }, betLimits: { fullDay: { min: 200 } } },
    });
    const [entry] = await getConfigHistory('system', { docKey: KEY });
    expect(entry.changed).toEqual({ 'riskRules.maxWarnings': 5, 'betLimits.fullDay.min': 200 });

    const cfg = await getConfig('system', { docKey: KEY, fresh: true });
    expect(cfg.riskRules.maxWarnings).toBe(5);
    expect(cfg.betLimits.fullDay.min).toBe(200);
    expect(cfg.betLimits.fullDay.max).toBe(500000);   // sibling untouched
  });

  it('refuses a stale write rather than silently overwriting another admin', async () => {
    const first = await applyConfig({ scope: 'system', docKey: KEY, patch: { minDeposit: 200 } });
    expect(first.version).toBe(1);

    // A second admin held a form open across the first admin's save.
    const stale = await applyConfig({
      scope: 'system', docKey: KEY, patch: { minDeposit: 999 }, expectedVersion: 0,
    });
    expect(stale).toEqual({ ok: false, reason: 'STALE', currentVersion: 1 });
    expect((await getConfig('system', { docKey: KEY, fresh: true })).minDeposit).toBe(200);

    // With the version it actually read, the same write goes through.
    const ok = await applyConfig({
      scope: 'system', docKey: KEY, patch: { minDeposit: 999 }, expectedVersion: 1,
    });
    expect(ok.ok).toBe(true);
    expect(ok.version).toBe(2);
  });

  it('restores an earlier version as a NEW version, not by rewinding', async () => {
    await applyConfig({ scope: 'system', docKey: KEY, patch: { minDeposit: 111 }, actor: 'a' });
    await applyConfig({ scope: 'system', docKey: KEY, patch: { minDeposit: 222 }, actor: 'b' });
    expect((await getConfig('system', { docKey: KEY, fresh: true })).minDeposit).toBe(222);

    const restored = await restoreConfigVersion('system', 1, { docKey: KEY, actor: 'c' });
    expect(restored.ok).toBe(true);
    expect(restored.version).toBe(3);   // forward, never backward
    expect((await getConfig('system', { docKey: KEY, fresh: true })).minDeposit).toBe(111);

    // The trail describes what happened, including the restore itself.
    const history = await getConfigHistory('system', { docKey: KEY });
    expect(history.map((h) => h.version)).toEqual([3, 2, 1]);
    expect(history[0].reason).toBe('Restored from version 1');

    expect(await restoreConfigVersion('system', 99, { docKey: KEY }))
      .toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('will not let anything rewrite the audit trail', async () => {
    await applyConfig({ scope: 'system', docKey: KEY, patch: { minDeposit: 300 } });
    await expect(pgQuery(
      `UPDATE config_document_versions SET changed_by = 'someone-else'
        WHERE scope = 'system' AND doc_key = $1`, [KEY],
    )).rejects.toThrow();
    await expect(pgQuery(
      `DELETE FROM config_document_versions WHERE scope = 'system' AND doc_key = $1`, [KEY],
    )).rejects.toThrow();
  });

  // ── The cache ─────────────────────────────────────────────────────────────
  it('applies a change IMMEDIATELY — a stale limit is worse than a stale banner', async () => {
    // The read below populates the cache. The write must invalidate it rather
    // than let the old limit stand until the TTL expires.
    expect((await getConfig('system', { docKey: KEY })).maxWithdrawal).toBe(50000);
    await applyConfig({ scope: 'system', docKey: KEY, patch: { maxWithdrawal: 10000 } });
    expect((await getConfig('system', { docKey: KEY })).maxWithdrawal).toBe(10000);
  });

  // ── The supply cap ────────────────────────────────────────────────────────
  it('holds the token supply cap against concurrent mints', async () => {
    // A read-modify-write lets two concurrent mints both read the same
    // `minted` and both pass the cap check, which is how a ceiling stops being
    // a ceiling. The arithmetic and the check are one statement.
    await applyConfig({
      scope: 'system', docKey: KEY,
      patch: { adminTokenSupply: { cap: 1000, minted: 0 } },
    });

    const mints = await Promise.all(Array.from({ length: 20 }, () => bumpConfigCounter({
      scope: 'system', docKey: KEY, path: 'adminTokenSupply.minted', by: 100, cap: 1000,
    })));
    expect(mints.filter((m) => m.ok)).toHaveLength(10);
    expect(mints.filter((m) => !m.ok).every((m) => m.reason === 'CAP_EXCEEDED')).toBe(true);

    const cfg = await getConfig('system', { docKey: KEY, fresh: true });
    expect(cfg.adminTokenSupply.minted).toBe(1000);
  });

  // ── Other scopes ──────────────────────────────────────────────────────────
  it('serves every declared scope, and refuses one it does not know', async () => {
    const branding = await getConfig('branding', { docKey: KEY });
    expect(branding.appName).toBe('Betting Bazaar');

    const policy = await getConfig('depositPolicy', { docKey: KEY });
    expect(policy.reservePercent).toBe(0);
    await expect(applyConfig({
      scope: 'depositPolicy', docKey: KEY, patch: { reservePercent: 150 },
    })).rejects.toThrow(/'reservePercent' must be <= 100/);

    await expect(getConfig('not-a-scope')).rejects.toThrow(/Unknown config scope 'not-a-scope'/);
  });

  it('reads several scopes in one call for a panel that renders them all', async () => {
    const all = await getConfigs(['system', 'branding', 'supportLinks'], { docKey: KEY });
    expect(Object.keys(all).sort()).toEqual(['branding', 'supportLinks', 'system']);
    expect(all.system.kycRequired).toBe(true);
  });

  it('keeps scopes apart', async () => {
    await applyConfig({ scope: 'branding', docKey: KEY, patch: { appName: 'Other' } });
    expect((await getConfig('branding', { docKey: KEY, fresh: true })).appName).toBe('Other');
    expect((await getSystemConfig({ docKey: KEY, fresh: true })).maintenanceMode).toBe(false);
  });

  // ── The admin System Settings write path ──────────────────────────────────
  it('writes a dotted path to the document the platform actually reads', async () => {
    const before = await getConfig('system', { docKey: KEY, fresh: true });
    expect(before.betLimits.thirtyMin.min).toBe(10);

    await setConfigPath('system', 'betLimits.thirtyMin.min', 25, {
      docKey: KEY, actor: 'admin1', reason: 'probe',
    });

    // This is the bug that made the whole rewrite necessary: the service that
    // served the admin System Settings page wrote to a SystemConfig document
    // while getSystemConfig read config_documents. Every setting appeared to
    // save and none of them took effect.
    const after = await getConfig('system', { docKey: KEY, fresh: true });
    expect(after.betLimits.thirtyMin.min).toBe(25);
  });

  it('records the dotted path it changed, not the whole document', async () => {
    await setConfigPath('system', 'maintenanceMode', true, { docKey: KEY, actor: 'admin1' });
    const [latest] = await getConfigHistory('system', { docKey: KEY });
    // An auditor reading the trail sees what an admin actually did rather than
    // having to diff two full documents to find it.
    expect(latest.changed).toEqual({ maintenanceMode: true });
    expect(latest.changedBy).toBe('admin1');
  });

  it('refuses a dotted path the spec does not declare', async () => {
    await expect(setConfigPath('system', 'notADeclaredKey', 1, { docKey: KEY }))
      .rejects.toThrow(/refusing to write undeclared setting 'notADeclaredKey'/);
    await expect(setConfigPath('system', 'betLimits.thirtyMin.nope', 1, { docKey: KEY }))
      .rejects.toThrow(/betLimits\.thirtyMin\.nope/);
  });

  it('is a no-op for an empty patch rather than a version bump', async () => {
    const r = await applySystemConfig({}, { docKey: KEY });
    expect(r.ok).toBe(true);
    expect((await getConfig('system', { docKey: KEY, fresh: true })).version).toBe(0);
    expect(await getConfigHistory('system', { docKey: KEY })).toEqual([]);
  });
});
