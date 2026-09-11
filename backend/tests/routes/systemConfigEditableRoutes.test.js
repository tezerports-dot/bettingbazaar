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
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { SYSTEM_CONFIG_SPEC } from '#db/spec/config.spec.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const FIELDS = SYSTEM_CONFIG_SPEC.fields.merchantOrderLimits?.fields ?? {};

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
  }, 60_000);

  afterAll(async () => {
    // Before closePg, and outside any assertion — a restore that only runs when
    // the suite passed is the one that matters least.
    if (original && app && admin) {
      await as(app, admin).put('/system/config').send({ merchantOrderLimits: original });
    }
    await closePg();
  });

  it('declares at least the eight operational limits the workers read', () => {
    // Not a count — a count drifts the moment a field is added. These are the
    // names live code reads; if one is renamed away this test says which.
    expect(Object.keys(FIELDS)).toEqual(expect.arrayContaining([
      'maxConcurrentDepositOrders', 'maxConcurrentWithdrawalOrders',
      'maxConsecutiveRejections', 'paidResponseMinutes',
      'maxConsecutivePlayerPaymentFailures', 'playerOrderLockMinutes',
      'maxConsecutiveMerchantExpiries', 'minAdminTokenPurchase',
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

  it('serves EVERY declared setting, not just the ones with a line', async () => {
    // The sweep that followed the merchantOrderLimits fix, written down so it
    // stays true. `withdrawalHoldMinutes`, both `loadShedding` ceilings and all
    // eight `ipDefense` fields were declared in the spec, read by live
    // middleware, served by no GET and written by no PUT — two of them under a
    // source comment that called them "admin-editable". Nothing failed, because
    // nothing compared the three lists.
    const leaves = [];
    const walk = (node, path = []) => {
      if (node.type !== 'group') { leaves.push({ path, decl: node }); return; }
      for (const [k, v] of Object.entries(node.fields)) walk(v, [...path, k]);
    };
    walk(SYSTEM_CONFIG_SPEC);

    const settable = leaves.filter(({ decl }) => !decl.internal);
    expect(settable.length).toBeGreaterThan(60);

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

  it('does NOT offer the running issuance total as a setting', async () => {
    // `adminTokenSupply.minted` is the count of tokens ever issued, checked
    // against a 10-billion cap. Setting it back to 0 does not correct a count —
    // it re-authorises minting the entire supply again. It is marked `internal`
    // in the spec, which is what keeps it out of BOTH derived lists; this
    // asserts the marker is doing its job rather than that somebody remembered.
    const { getSystemConfig } = await import('#db/repositories/config.js');
    const was = (await getSystemConfig()).adminTokenSupply?.minted ?? 0;

    const seed = await as(app, admin).get('/system/config');
    expect(seed.body.config.adminTokenSupply?.minted, 'minted is served as an editable field').toBeUndefined();

    await as(app, admin).put('/system/config')
      .send({ adminTokenSupply: { minted: was + 1234, cap: 10000000000 } });

    expect(
      (await getSystemConfig()).adminTokenSupply?.minted ?? 0,
      'an admin PUT moved the issuance counter',
    ).toBe(was);
  });

  it('checks EVERY board\'s phases fit its own block, the one-minute one included', async () => {
    // §18.3: "a merge offset larger than the block fires before the cycle
    // starts and nothing objects" — the ordering check compares phases only
    // with each other, so the block length is the half it cannot see. That
    // ceiling was two literals at one call site covering two of the three
    // boards, and the one it omitted is the 60-second block, where an
    // oversized merge is easiest to enter by accident.
    const before = await as(app, admin).get('/system/config');
    const wasOneMin = { ...before.body.config.cyclePhases.oneMin };

    // Ordered correctly, so ONLY the block-length rule can refuse it.
    const overflowing = {
      mergeBeforeEndSec: 90, equalizerBeforeEndSec: 70,
      closeBeforeEndSec: 50, celebrateBeforeEndSec: 30,
    };
    const res = await as(app, admin).put('/system/config')
      .send({ cyclePhases: { oneMin: overflowing } });
    expect(res.status, 'a 90s merge was accepted on a 60s block').toBe(400);
    expect(String(res.body?.message ?? '')).toContain('oneMin');

    const after = await as(app, admin).get('/system/config');
    expect(after.body.config.cyclePhases.oneMin).toEqual(wasOneMin);

    // And a legal set for the same board is accepted, so the test is not
    // passing on a route that refuses `oneMin` outright.
    //
    // Built from constants, NOT derived from what is stored: another suite in
    // the same run writes this board's phases, so a set nudged off the current
    // value can violate the ORDERING rule and be refused for a reason this
    // test is not about. It read as a failure of the block-length check.
    const legal = {
      mergeBeforeEndSec: 20, equalizerBeforeEndSec: 15,
      closeBeforeEndSec: 10, celebrateBeforeEndSec: 5,
    };
    const ok = await as(app, admin).put('/system/config').send({ cyclePhases: { oneMin: legal } });
    expect(ok.status, ok.body?.message).toBe(200);
    const back = await as(app, admin).get('/system/config');
    expect(back.body.config.cyclePhases.oneMin).toEqual(legal);

    // Put the board back. Not asserted: if what was there is itself refused,
    // it was already in that state before this file ran.
    await as(app, admin).put('/system/config').send({ cyclePhases: { oneMin: wasOneMin } });
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
