// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every operational limit the spec declares is editable from the admin API.
 *
 * ── The defect this exists to refuse ────────────────────────────────────────
 * `merchantOrderLimits` had TWELVE fields declared in `SYSTEM_CONFIG_SPEC` and
 * FOUR that the admin route would write. The other eight were read by real
 * workers — the refusal cap, the PAID response window, the player cool-off and
 * its length, the expiry threshold that pauses assignment — and could only be
 * changed by editing the spec and redeploying. `maxConsecutiveRejections` was
 * the clearest case: the GET returned it, so it could be RENDERED on the
 * settings screen, and the PUT dropped it on the floor. An operator raising it
 * would have been told it saved and served exactly the same cap as before.
 *
 * That is CLAUDE.md §3 in both directions at once — a field an admin appears to
 * control that nothing reads back, and a business number with no admin owner.
 *
 * ── Why this test loops over the spec instead of listing fields ─────────────
 * §28: derive what a gate checks from the thing it is checking. A hand-written
 * list here would have the same failure mode as the route did — the ninth field
 * someone declares is the one nobody remembers to add. The spec is the only
 * list, so a field declared and not wired fails HERE, in the change that
 * declares it, rather than on a settings screen months later.
 *
 * The route is exercised end to end: PUT through the real handler, then GET
 * through the real handler, then read the row. A test that only asserted the
 * PUT's 200 would pass against a handler that validated and wrote nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { SYSTEM_CONFIG_SPEC } from '#db/spec/config.spec.js';
import { getSystemConfig, invalidateConfigCache } from '#db/repositories/config.js';
import { routingSettings } from '#db/repositories/teamRouting.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const FIELDS = SYSTEM_CONFIG_SPEC.fields.merchantOrderLimits?.fields ?? {};

/** Every leaf the spec declares, with its dotted path. */
function leavesOf(node, path = []) {
  if (node.type !== 'group') return [{ path, decl: node }];
  return Object.entries(node.fields).flatMap(([k, v]) => leavesOf(v, [...path, k]));
}

/**
 * A legal value for one field that differs from what is STORED right now.
 *
 * Not "differs from the default" — that is the version of this test that a
 * mutation proved worthless. `config_documents` is one shared row that survives
 * between runs, so a field left at 4 by an earlier run read back as 4 in the
 * next one and the assertion passed against a write that never happened. It is
 * CLAUDE.md trap 10 in a new disguise: the assertion has to be about the DELTA
 * this run caused, so the value is chosen against the current one.
 *
 * The USDT pair carries its own rule the route enforces (min >= 100, both
 * multiples of 10, max either 0 or >= min), so those four move between two
 * values that satisfy it together rather than each being nudged independently.
 */
function distinctLegalValue(key, decl, current) {
  if (/Usdt$/.test(key)) {
    if (/^min/.test(key)) return current === 110 ? 120 : 110;
    return current === 990 ? 1000 : 990;
  }
  const min = decl.min ?? 0;
  const max = decl.max ?? Number.MAX_SAFE_INTEGER;
  const up = Math.min(max, Number(current ?? min) + 1);
  if (up !== Number(current)) return up;
  return Math.max(min, Number(current) - 1);
}

describePg('every declared merchantOrderLimits field is admin-editable', () => {
  let app;
  let admin;
  let original;
  let originalRouting;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/admin/system.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
    // `config_documents` is ONE shared row, and this file's whole purpose is to
    // change it. Left changed, it is not a stale fixture — it is the platform's
    // live rules, and the next suite runs under them: raising
    // `maxConsecutiveRejections` to 4 made the rejection-cap suite assert a
    // suspension that correctly did not happen, and `playerOrderLockMinutes`
    // at 61 made the cool-off suite measure a lock longer than the one it
    // wrote. Both read as failures in code this file never touched.
    //
    // CLAUDE.md trap 10, stated as a duty rather than a warning: take a
    // baseline, cause your delta, put the shared table back.
    const seed = await as(app, admin).get('/system/config');
    original = { ...seed.body.config.merchantOrderLimits };
    originalRouting = structuredClone(seed.body.config.teamRouting);
  }, 60_000);

  afterAll(async () => {
    // Before closePg, and outside any assertion — a restore that only runs when
    // the suite passed is the one that matters least.
    if (original && app && admin) {
      await as(app, admin).put('/system/config').send({ merchantOrderLimits: original });
    }
    if (originalRouting && app && admin) {
      await as(app, admin).put('/system/config').send({ teamRouting: originalRouting });
    }
    await closePg();
  });

  it('declares at least the six operational limits the workers read', () => {
    // Not a count — a count drifts the moment a field is added. These are the
    // names live code reads; if one is renamed away this test says which.
    //
    // The per-merchant concurrency pair is not here any more: a member's cap is
    // per RAIL, `teamRouting.concurrency` (PROJECT_STATUS §3.10, 2c), asserted
    // below against the code that reads it.
    expect(Object.keys(FIELDS)).toEqual(expect.arrayContaining([
      'maxConsecutiveRejections', 'paidResponseMinutes', 'utrAfterPaidMinutes',
      'maxConsecutivePlayerPaymentFailures', 'playerOrderLockMinutes',
      'maxConsecutiveMerchantExpiries',
    ]));
  });

  it('writes every field through PUT and serves every one back from GET', async () => {
    const before = await as(app, admin).get('/system/config');
    expect(before.status).toBe(200);
    const stored = before.body.config.merchantOrderLimits;

    const wanted = Object.fromEntries(
      Object.entries(FIELDS).map(([key, decl]) => [key, distinctLegalValue(key, decl, stored[key])]),
    );

    const put = await as(app, admin)
      .put('/system/config')
      .send({ merchantOrderLimits: wanted });
    expect(put.status, put.body?.message).toBe(200);

    const got = await as(app, admin).get('/system/config');
    expect(got.status).toBe(200);

    // Every key, not a sample: the field that is not wired is by definition the
    // one a sample would skip.
    for (const [key, value] of Object.entries(wanted)) {
      expect(got.body.config.merchantOrderLimits[key], `merchantOrderLimits.${key} did not survive the round trip`)
        .toBe(value);
      expect(value, `merchantOrderLimits.${key} was written the value it already held, so this proves nothing`)
        .not.toBe(stored[key]);
    }
  });

  it('writes every teamRouting field, and routing READS what was written', async () => {
    // The per-member caps moved here from `merchantOrderLimits.maxConcurrent*`
    // when orders started going to teams (§3.10, 2c), with the per-rail timers
    // the payment-mode policy used to hold. Declared is not enough (§3): the
    // value has to reach the code that routes — `routingSettings` — or the
    // operator raising a cap is told it saved and nothing routes differently.
    const routing = SYSTEM_CONFIG_SPEC.fields.teamRouting;
    expect(routing, 'teamRouting is no longer declared').toBeTruthy();
    const leaves = leavesOf(routing);
    expect(leaves.map(({ path }) => path.join('.'))).toEqual(expect.arrayContaining([
      'concurrency.CASH', 'concurrency.UPI_BANK', 'concurrency.USDT',
    ]));

    const stored = (await as(app, admin).get('/system/config')).body.config.teamRouting;
    const at = (obj, path) => path.reduce((n, k) => n?.[k], obj);
    const wanted = {};
    for (const { path, decl } of leaves) {
      let node = wanted;
      for (const k of path.slice(0, -1)) node = (node[k] ??= {});
      node[path.at(-1)] = distinctLegalValue(path.at(-1), decl, at(stored, path));
    }

    const put = await as(app, admin).put('/system/config').send({ teamRouting: wanted });
    expect(put.status, put.body?.message).toBe(200);

    const served = (await as(app, admin).get('/system/config')).body.config.teamRouting;
    invalidateConfigCache('system');
    const read = routingSettings(await getSystemConfig());
    for (const { path } of leaves) {
      const label = `teamRouting.${path.join('.')}`;
      expect(at(wanted, path), `${label} was written the value it already held`).not.toBe(at(stored, path));
      expect(at(served, path), `${label} did not survive the round trip`).toBe(at(wanted, path));
      expect(at(read, path), `${label} saved, and routing still reads the old value`).toBe(at(wanted, path));
    }
  });

  it('serves EVERY declared setting, not just the ones with a line', async () => {
    // The sweep that followed the merchantOrderLimits fix, written down so it
    // stays true. `withdrawalHoldMinutes`, both `loadShedding` ceilings and all
    // eight `ipDefense` fields were declared in the spec, read by live
    // middleware, served by no GET and written by no PUT — two of them under a
    // source comment that called them "admin-editable". Nothing failed, because
    // nothing compared the three lists.
    // Every leaf: the spec no longer holds a value the platform writes for
    // itself (the issuance counter was the only one, and it is derived from
    // the treasury now — see the case below).
    const settable = leavesOf(SYSTEM_CONFIG_SPEC);
    expect(settable.length).toBeGreaterThan(40);

    const seed = await as(app, admin).get('/system/config');
    expect(seed.status).toBe(200);

    const missing = settable.filter(({ path }) => {
      let node = seed.body.config;
      for (const key of path) {
        if (node === null || node === undefined || typeof node !== 'object') return true;
        node = node[key];
      }
      return node === undefined;
    });
    expect(missing.map(({ path }) => path.join('.')).join(' | '), 'declared settings the GET does not serve').toBe('');
  });

  it('serves none of the settings the redesign removed, and a save naming one stores nothing', async () => {
    // Each of these had a consumer once and has none now (PROJECT_STATUS §3.10,
    // 2c): the per-merchant caps became per-rail `teamRouting.concurrency`; the
    // merchant token-purchase bounds went with merchant token orders; the
    // manual-assignment pool went with hand-picking; and the issuance counter
    // is DERIVED from the treasury, so an operator who could set it would be
    // telling the platform it still held tokens it had handed out. A setting
    // with no consumer is §3's violation, and a counter on a settings screen is
    // a number somebody types over (F-022).
    const removed = [
      ['merchantOrderLimits', 'maxConcurrentDepositOrders'],
      ['merchantOrderLimits', 'maxConcurrentWithdrawalOrders'],
      ['merchantOrderLimits', 'minAdminTokenPurchase'],
      ['merchantOrderLimits', 'minAdminTokenPurchaseUsdt'],
      ['merchantOrderLimits', 'maxAdminTokenPurchaseUsdt'],
      ['queueManagerPool'],
      ['adminTokenSupply', 'transferred'],
    ];
    const declared = new Set(leavesOf(SYSTEM_CONFIG_SPEC).map(({ path }) => path.join('.')));
    const at = (obj, path) => path.reduce((n, k) => n?.[k], obj);

    const served = (await as(app, admin).get('/system/config')).body.config;
    for (const path of removed) {
      expect(declared.has(path.join('.')), `${path.join('.')} is declared again`).toBe(false);
      expect(at(served, path), `${path.join('.')} is served as a setting`).toBeUndefined();
    }

    // The save an out-of-date screen would send. Whatever it answers, it must
    // not be a 5xx, and none of these may land in the stored document.
    const res = await as(app, admin).put('/system/config').send({
      merchantOrderLimits: {
        maxConcurrentDepositOrders: 7, maxConcurrentWithdrawalOrders: 7,
        minAdminTokenPurchase: 12345, minAdminTokenPurchaseUsdt: 200, maxAdminTokenPurchaseUsdt: 900,
      },
      queueManagerPool: ['MRC-somebody'],
      adminTokenSupply: { transferred: 1234 },
    });
    expect(res.status, res.body?.message).toBeLessThan(500);

    const { rows } = await pgQuery(
      `SELECT settings FROM config_documents WHERE scope = 'system' AND doc_key = 'main'`);
    const stored = rows[0]?.settings ?? {};
    for (const path of removed) {
      expect(at(stored, path), `a save wrote the removed setting ${path.join('.')}`).toBeUndefined();
    }
  });

  it('refuses an out-of-bounds value as the CALLER\'s mistake, not a 500', async () => {
    const bounded = Object.entries(FIELDS).find(([, d]) => typeof d.max === 'number');
    expect(bounded, 'no bounded field to test with').toBeTruthy();
    const [key, decl] = bounded;

    const res = await as(app, admin)
      .put('/system/config')
      .send({ merchantOrderLimits: { [key]: decl.max + 1 } });

    // A 500 here is the defect, not a cosmetic one: `serverError` answers with
    // nothing by design, so the message naming the field and its bound — the
    // only thing that tells the operator what to type instead — is swallowed,
    // and they are told the platform broke.
    expect(res.status, `an out-of-range value answered ${res.status}; the spec refusing a value is the caller's mistake`).toBe(400);
    expect(String(res.body?.message ?? '')).toContain(key);

    const after = await as(app, admin).get('/system/config');
    expect(after.body.config.merchantOrderLimits[key]).toBeLessThanOrEqual(decl.max);
  });

  it('writes NOTHING when one field in the save is invalid', async () => {
    // §21, inside one request. Written field-by-field, the values BEFORE the
    // bad one committed and the ones after it never ran: the admin was told
    // the save failed and reloaded into a form half old and half new, with
    // nothing on the screen saying which half.
    const good = Object.entries(FIELDS).find(([k, d]) => typeof d.max === 'number' && !/Usdt$/.test(k));
    const bad  = Object.entries(FIELDS).find(([k, d]) => typeof d.max === 'number' && k !== good[0]);
    expect(good && bad, 'need two bounded fields to test atomicity').toBeTruthy();

    const before = await as(app, admin).get('/system/config');
    const wasGood = before.body.config.merchantOrderLimits[good[0]];
    const newGood = distinctLegalValue(good[0], good[1], wasGood);
    expect(newGood).not.toBe(wasGood);

    const res = await as(app, admin).put('/system/config').send({
      // Object key order is insertion order for string keys, so the valid field
      // is genuinely reached first by a field-by-field writer. A test that put
      // the bad one first would pass against the very implementation it exists
      // to refuse.
      merchantOrderLimits: { [good[0]]: newGood, [bad[0]]: bad[1].max + 1 },
    });
    expect(res.status).toBe(400);

    const after = await as(app, admin).get('/system/config');
    expect(
      after.body.config.merchantOrderLimits[good[0]],
      `${good[0]} was committed even though the save was refused — the write is not atomic`,
    ).toBe(wasGood);
  });
});
