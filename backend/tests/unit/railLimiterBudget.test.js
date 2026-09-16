// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A payment-rail limiter spends its budget on what it actually bounds.
 *
 * ── The defect this pins ───────────────────────────────────────────────────
 * `usdtDepositLimiter` allows five requests an hour and counted every one of
 * them, refusals included. Driven against the live server, four malformed
 * creates — 60,000 tokens (not a denomination), no chain, a chain that does
 * not exist, and an INR-rail size — spent four fifths of the hour's budget
 * without a single order existing. The fifth request was the only real
 * purchase the player had left, and a sixth was refused for an hour.
 *
 * Every one of those four was refused BY NAME, on purpose, so the player could
 * correct it (`CLAUDE.md` §25: "A refusal on either rail names that rail's own
 * choices"). The correction was then the thing they could not afford. And the
 * same counting applies to `USDT_RATE_UNSET` — a platform-side outage the
 * player had no part in, charged to the player's own hour.
 *
 * ── Why this is not one flag on one helper ─────────────────────────────────
 * Two of the five rail limiters bound the OPPOSITE thing. The grace claim is
 * once per order by construction, so a caller sweeping other people's orders
 * looking for one that has not claimed it produces refusals and nothing else —
 * the refusals ARE the sweep. Skipping them there would switch the limiter off
 * while leaving it looking configured.
 *
 * So `railLimiter` takes `bounds` and refuses to build without it. This suite
 * asserts both halves, because a fix that only proved the first half would be
 * one grep away from being applied to the other two and silently disabling
 * them.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import {
  usdtDepositLimiter, orderRetryLimiter, cashLinkSupplyLimiter,
  utrGraceLimiter, cdmReceiptLimiter,
} from '../../middleware/security.js';
import { RATE_LIMIT_TIERS } from '../../config/security.config.js';

/**
 * A limiter in front of a handler whose status the caller dictates, so one app
 * can play both "the server refused this" and "this created something".
 */
function appWith(limiter) {
  const app = express();
  app.use(express.json());
  // `actorKey` keys on `req.user.userId` first — the same thing `authenticate`
  // puts there — so the probe identifies itself the way a real caller does.
  // Keying on the IP instead would put every case in this file in one bucket.
  app.post('/go', (req, _res, next) => { req.user = { userId: req.get('X-Probe-Actor') }; next(); },
    limiter, (req, res) => {
      const status = Number(req.body?.status) || 200;
      res.status(status).json({ ok: status < 400 });
    });
  return app;
}

/** A distinct actor per case — the limiters are keyed on the caller. */
let seq = 0;
const actor = () => `rail-budget-probe-${process.pid}-${++seq}`;

async function post(app, who, status) {
  return request(app).post('/go').set('X-Probe-Actor', who).send({ status });
}

describe('a rail limiter that bounds EFFECTS does not charge for refusals', () => {
  it('spends nothing on the four refusals that cost a real USDT purchase', async () => {
    const app = appWith(usdtDepositLimiter);
    const who = actor();

    // The exact four the live server refused, in order.
    for (const refusal of ['NOT_A_DENOMINATION', 'CHAIN_MISSING', 'CHAIN_UNKNOWN', 'INR_SIZE']) {
      const res = await post(app, who, 400);
      expect(res.status, `${refusal} should be the handler's own refusal`).toBe(400);
    }

    // The budget is five. Before the fix this player had one left; they have
    // all five, because none of the four created anything.
    for (let i = 0; i < RATE_LIMIT_TIERS.usdtDeposit.max; i++) {
      const res = await post(app, who, 200);
      expect(res.status, `purchase ${i + 1} of ${RATE_LIMIT_TIERS.usdtDeposit.max}`).toBe(200);
    }

    // And the budget is still a real budget: the one after it is refused.
    const overflow = await post(app, who, 200);
    expect(overflow.status).toBe(429);
    expect(overflow.body.message).toMatch(/USDT purchase attempts/);
  });

  it('does not let a caller push their own window out by knocking', async () => {
    // The 429 is itself a >= 400 response, so it is decremented back. A pace
    // that grew every time somebody retried would be a lockout wearing a
    // pace's message.
    const app = appWith(usdtDepositLimiter);
    const who = actor();
    for (let i = 0; i < RATE_LIMIT_TIERS.usdtDeposit.max; i++) {
      expect((await post(app, who, 200)).status).toBe(200);
    }
    for (let i = 0; i < 4; i++) expect((await post(app, who, 200)).status).toBe(429);
    // Still exactly at the limit — the four 429s put nothing back on the tab.
    expect((await post(app, who, 200)).status).toBe(429);
  });

  it('applies to the retry and cash-link rails too', async () => {
    for (const [name, limiter, tier] of [
      ['orderRetry', orderRetryLimiter, RATE_LIMIT_TIERS.orderRetry],
      ['cashLinkSupply', cashLinkSupplyLimiter, RATE_LIMIT_TIERS.cashLinkSupply],
    ]) {
      const app = appWith(limiter);
      const who = actor();
      for (let i = 0; i < tier.max; i++) expect((await post(app, who, 400)).status).toBe(400);
      // Nothing was created, so nothing was spent.
      expect((await post(app, who, 200)).status, name).toBe(200);
    }
  });
});

describe('a rail limiter that bounds ATTEMPTS still counts refusals', () => {
  it('bounds a sweep across other orders, which is nothing but refusals', async () => {
    // If this ever starts passing at 200, the grace-claim and CDM limiters have
    // been switched off by a change that looked like a consistency fix.
    for (const [name, limiter, tier] of [
      ['utrGrace', utrGraceLimiter, RATE_LIMIT_TIERS.utrGrace],
      ['cdmReceipt', cdmReceiptLimiter, RATE_LIMIT_TIERS.cdmReceipt],
    ]) {
      const app = appWith(limiter);
      const who = actor();
      for (let i = 0; i < tier.max; i++) {
        expect((await post(app, who, 404)).status, `${name} sweep ${i + 1}`).toBe(404);
      }
      expect((await post(app, who, 404)).status, `${name} must stop the sweep`).toBe(429);
    }
  });
});

describe('the declaration cannot be omitted', () => {
  it('every rail limiter states which kind it is', () => {
    // Read as source: the point is that a NEW limiter cannot be added without
    // the decision, and a call site is the only place that shows.
    const src = readFileSync(new URL('../../middleware/security.js', import.meta.url), 'utf8');
    const calls = src.match(/railLimiter\(\s*'rl:[^)]*?\)/gs) ?? [];
    expect(calls.length, 'rail limiters found').toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(call, call.slice(0, 60)).toMatch(/bounds:\s*'(effects|attempts)'/);
    }
  });

  it('refuses to build one without it', async () => {
    // Not a lint rule that can be green while the code is wrong: the helper
    // throws, so an omission is a boot failure rather than a silent default.
    const src = readFileSync(new URL('../../middleware/security.js', import.meta.url), 'utf8');
    expect(src).toMatch(/bounds !== 'effects' && bounds !== 'attempts'/);
    expect(src).toMatch(/throw new Error\(`railLimiter/);
  });
});
