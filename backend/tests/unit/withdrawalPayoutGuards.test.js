// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The payout side of the withdrawal lifecycle, pinned at the source.
 *
 * Payouts are MANUAL: an operator wires real money and then records the
 * approval. Two controls keep that safe, and both are structural — they are
 * about which check exists before which call, so a source scan states them
 * exactly and cannot pass because a fixture was lucky.
 *
 *   1. APPROVE refuses a request carrying no proof of reserved funds. Requests
 *      are only created after their funds are reserved, so a row without that
 *      proof means the money was never taken from the player and paying it out
 *      would be an unbacked loss.
 *
 *   2. REJECT returns money ONLY when money was actually reserved. The refund
 *      credits the player's withdrawable balance, and the guard inside
 *      refundWithdrawal is an AGGREGATE check on lockedBalance — it would
 *      happily satisfy an unfunded refund out of a DIFFERENT request's
 *      reservation, which is how an unbacked row turns into minted balance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Order-of-operations is the property under test, so the scan must see only
 * executable code: these handlers carry long comments that mention the very
 * calls whose ORDER is being asserted, and a comment sitting above the reserve
 * step would otherwise register as the step itself.
 */
function code(path) {
  return readFileSync(join(here, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

const adminSrc = code('../../routes/admin/system.admin.routes.js');
const routeSrc = code('../../domains/user/user.routes.js');
const modelSrc = code('../../domains/notification/notification.model.js');

/** The body of one route handler, up to the next route registration. */
function handler(src, marker) {
  const start = src.indexOf(marker);
  expect(start, `handler not found: ${marker}`).toBeGreaterThan(-1);
  const rest = src.slice(start + marker.length);
  const next = rest.indexOf('\nrouter.');
  return rest.slice(0, next === -1 ? rest.length : next);
}

describe('a withdrawal request cannot exist without reserved funds', () => {
  it('the schema requires a reservation, and one reservation backs one request', () => {
    expect(modelSrc).toMatch(/reservationTxId:\s*\{[^}]*required:\s*true/);
    expect(modelSrc).toMatch(/reservationTxId:\s*\{[^}]*unique:\s*true/);
  });

  it('the database enforces one open payout per player', () => {
    expect(modelSrc).toMatch(/partialFilterExpression:\s*\{\s*status:\s*'PENDING'\s*\}/);
    expect(modelSrc).toMatch(/one_pending_withdrawal_per_user/);
  });

  it('the route reserves BEFORE creating the payable record', () => {
    const h = handler(routeSrc, "router.post('/v1/user/withdraw'");
    const lockAt   = h.indexOf('lockWithdrawal(');
    const createAt = h.indexOf('WithdrawalRequest.create(');
    expect(lockAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(createAt);
  });

  it('releases the reservation when the record cannot be written', () => {
    const h = handler(routeSrc, "router.post('/v1/user/withdraw'");
    expect(h).toMatch(/refundWithdrawal\(/);
    // And pages a human when even the release fails — reserved money that could
    // not be returned is the one outcome no automated path can resolve.
    expect(h).toMatch(/withdrawal-reservation-stranded/);
  });
});

describe('the payout side refuses unbacked instruments', () => {
  it('approve requires proof of reservation before releasing money', () => {
    const h = handler(adminSrc, "'/withdrawal-requests/:id/approve'");
    const guardAt   = h.indexOf('reservationTxId');
    const releaseAt = h.indexOf('releaseWithdrawal(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(releaseAt);
    expect(h).toMatch(/409/);
  });

  it('reject refunds only when a reservation exists', () => {
    const h = handler(adminSrc, "'/withdrawal-requests/:id/reject'");
    expect(h).toMatch(/if\s*\(\s*wr\.reservationTxId\s*\)\s*\{[\s\S]*?refundWithdrawal\(/);
  });
});
