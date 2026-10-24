// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Order commission switched off for one suite (§26; owner, 2026-10-24).
 *
 * Commission is now paid straight from platform revenue the moment an order
 * completes, so it joins the serving team's pool beside the order's own
 * tokens. The suites that call this pin the ORDER's movement (the pool loses
 * exactly what the player gains, a stake reaches the pool once): before
 * 2026-10-24 they ran with commission effectively off, because the commission
 * pool they never funded refused it. This keeps them asking that one question.
 * Commission itself is pinned by teamCommissionPg, merchantAccountPg and
 * disputeReleaseConservationPg.
 *
 * Call it inside the suite's `describe`, before any `beforeAll` that completes
 * orders (it applies the schema itself, which is idempotent). Trap 10: what was stored is restored in
 * `afterAll`, outside any assertion.
 */
import { beforeAll, afterAll } from 'vitest';
import { db } from '#db';
import { applySchema } from '#db/client.js';

export function commissionOffForSuite() {
  let stored = null;
  beforeAll(async () => {
    await applySchema();
    stored = (await db.config.getSystemConfig())?.orderCommission ?? {};
    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { orderCommission: { depositPercent: 0, withdrawalPercent: 0 } },
    });
  });
  afterAll(async () => {
    if (!stored) return;
    await db.config.applyConfig({
      scope: 'system', actor: 'test',
      patch: { orderCommission: { depositPercent: stored.depositPercent ?? 5, withdrawalPercent: stored.withdrawalPercent ?? 5 } }, // schema default: 5
    });
  });
}
