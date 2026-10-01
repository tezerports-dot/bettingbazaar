// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/ipBlocks.js — the IP deny-list's rows (§2: the one owner).
 *
 * The ENFORCER is `backend/middleware/ipBlocklist.js`, which holds the live
 * list in memory and reloads it from `liveBlocks()`. This file only reads and
 * writes rows; nothing here is on the request path.
 *
 * The earlier deny-list had a table and a repository and was mounted nowhere —
 * three files said it "runs on every request" (F-030). This one is rebuilt with
 * its enforcer, its admin routes and its screen in the same change, and a route
 * test that proves a blocked address is refused on a real route.
 */
import { randomBytes } from 'node:crypto';
import { pgQuery } from '../client.js';

const newBlockId = () => `ipb_${randomBytes(10).toString('hex')}`;

function toBlock(r) {
  if (!r) return null;
  return {
    blockId: r.block_id,
    network: r.network,
    reason: r.reason,
    blockedBy: r.blocked_by,
    blockedAt: r.blocked_at,
    expiresAt: r.expires_at,
    releasedAt: r.released_at,
    releasedBy: r.released_by,
    // Decided by the DATABASE's clock, in the same SELECT, like `liveBlocks`:
    // the app's clock deciding this beside the database's would let the list
    // and the enforcer disagree about a block in its last moments.
    live: r.live === true,
  };
}

const COLUMNS = `block_id, network::text AS network, reason, blocked_by, blocked_at,
                 expires_at, released_at, released_by,
                 (released_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS live`;

/**
 * Every block in force right now — what the enforcer loads.
 *
 * The expiry is decided HERE, by the database's clock, so a temporary block
 * lapses without a sweep and an unexpired one holds even if no sweep ever runs.
 */
export async function liveBlocks() {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM ip_blocks
      WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [], 'ip_blocks_live',
  );
  return rows.map(toBlock);
}

/** The operator's view: live blocks, or the whole history, newest first. */
export async function listBlocks({ includeReleased = false, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM ip_blocks
      ${includeReleased ? '' : 'WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > now())'}
      ORDER BY blocked_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'ip_blocks_list',
  );
  return rows.map(toBlock);
}

/**
 * Block a range (a single address is a /32 or /128).
 *
 * `network` must already be validated by the caller; the database normalises it
 * (`network()` clears host bits) and the CIDR cast refuses anything malformed.
 * Blocking a range that already has an open row REFRESHES that row — a re-block
 * is a correction of the reason or expiry, not a second block.
 */
export async function blockNetwork({ network, reason, actor, expiresInMinutes = null }) {
  if (!network) throw new Error('blockNetwork requires a network');
  if (!actor) throw new Error('blockNetwork requires an actor');
  if (expiresInMinutes !== null && !(Number.isInteger(expiresInMinutes) && expiresInMinutes > 0)) {
    throw new Error('blockNetwork: expiresInMinutes must be a positive whole number, or null');
  }
  // ── The expiry is a DURATION, dated by the database ────────────────────────
  // It took an absolute `expiresAt` the route computed from the APP's clock,
  // while `ip_blocks_expiry_future` checks it against `blocked_at`, which is the
  // DATABASE's `now()`. An app clock a minute behind made every one-minute block
  // "already expired" to the CHECK: a 500 for a valid request. Both ends now
  // come from one clock, in one statement — on a re-block too.
  const { rows } = await pgQuery(
    `INSERT INTO ip_blocks (block_id, network, reason, blocked_by, expires_at)
     VALUES ($1, network($2::inet)::cidr, $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(mins => $5::int) END)
     ON CONFLICT (network) WHERE released_at IS NULL DO UPDATE SET
       reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by,
       blocked_at = now(), expires_at = EXCLUDED.expires_at
     RETURNING ${COLUMNS}`,
    [newBlockId(), String(network), String(reason), String(actor), expiresInMinutes],
    'ip_blocks_block',
  );
  return toBlock(rows[0]);
}

/**
 * Release a block. The row survives, stamped; releasing twice is not an error.
 * Returns null when there is no such block.
 */
export async function releaseBlock({ blockId, actor }) {
  if (!actor) throw new Error('releaseBlock requires an actor');
  const { rows } = await pgQuery(
    `UPDATE ip_blocks
        SET released_at = COALESCE(released_at, now()),
            released_by = COALESCE(released_by, $2)
      WHERE block_id = $1
      RETURNING ${COLUMNS}`,
    [String(blockId), String(actor)], 'ip_blocks_release',
  );
  return toBlock(rows[0]);
}
