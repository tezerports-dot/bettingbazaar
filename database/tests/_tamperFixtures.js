// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Test-only fixtures that write a row the application never would.
 *
 * ── Why these live here and not in a repository ─────────────────────────────
 * `orderAccessGuard` refuses an order whose tamper tag does not verify, and the
 * only way to test that is to produce such a row. There is deliberately no
 * production path that can: `openOrder` writes `order_hmac` once with the row,
 * and `setOrderFields`' allowlist does not name it, so no caller can rewrite a
 * tag. A repository function that could would hand an attacker the one thing
 * the tag exists to prevent — re-signing a row they had edited.
 *
 * ── Why they live under database/ ───────────────────────────────────────────
 * `check:db-boundary` refuses SQL outside this folder, and it is right to: a
 * test that can spell an UPDATE is a test that could run one against something
 * that matters. Putting the statement here keeps the boundary honest instead of
 * carving an exemption for tests, which is how a boundary stops being one.
 *
 * Nothing in `backend/` imports this except a test.
 */
import { pgQuery } from '../client.js';

/** Give an order a tag that verifies against no secret — a row we did not write. */
export async function corruptOrderHmac(orderId, tag = 'deadbeef'.repeat(8)) {
  await pgQuery('UPDATE order_states SET order_hmac = $2 WHERE order_id = $1',
    [String(orderId), String(tag)]);
}

/** Strip the tag, as on an order created before the column existed. */
export async function clearOrderHmac(orderId) {
  await pgQuery('UPDATE order_states SET order_hmac = NULL WHERE order_id = $1', [String(orderId)]);
}
