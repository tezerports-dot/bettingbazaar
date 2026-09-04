// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/compliance.js — the PAN registry.
 *
 * One PAN, one account. That is a legal requirement, not a preference, and it
 * is STORAGE-ENFORCED: the hash is the primary key and `user_id` is UNIQUE, so
 * two accounts cannot claim one tax identity and one account cannot register
 * two. A pre-read would let two concurrent registrations both pass.
 *
 * The number itself is never stored. Only its hash — which is what makes the
 * uniqueness check possible without holding the document — and its last four,
 * which is what a support agent needs to confirm an identity over the phone.
 */
import { pgQuery } from '../client.js';

/**
 * Register a PAN to an account.
 *
 * Returns a refusal rather than throwing on a conflict: "this PAN belongs to
 * another account" is an answer the signup form shows, and the two conflicts
 * are distinguished because they mean different things to the person reading
 * them.
 */
export async function registerPan({ panHash, panLast4, userId }) {
  if (!panHash || !userId) throw new Error('registerPan requires a panHash and a userId');
  try {
    const { rows } = await pgQuery(
      `INSERT INTO pan_registry (pan_hash, pan_last4, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (pan_hash) DO NOTHING
       RETURNING pan_hash, pan_last4, user_id, verified_at`,
      [String(panHash), String(panLast4 || '').toUpperCase(), String(userId)],
      'pan_register',
    );
    if (rows[0]) {
      return { ok: true, registration: {
        panHash: rows[0].pan_hash, panLast4: rows[0].pan_last4,
        userId: rows[0].user_id, verifiedAt: rows[0].verified_at,
      } };
    }
    // The hash collided. Whose is it?
    const existing = await findByPanHash(panHash);
    return existing?.userId === String(userId)
      ? { ok: true, idempotent: true, registration: existing }
      : { ok: false, reason: 'PAN_ALREADY_REGISTERED' };
  } catch (e) {
    // `user_id` is UNIQUE too: this account already registered a different PAN.
    if (e.code === '23505') return { ok: false, reason: 'ACCOUNT_ALREADY_HAS_PAN' };
    throw e;
  }
}

const toRegistration = (r) => (r ? {
  panHash: r.pan_hash, panLast4: r.pan_last4,
  userId: r.user_id, verifiedAt: r.verified_at,
} : null);

export async function findByPanHash(panHash) {
  const { rows } = await pgQuery(
    'SELECT pan_hash, pan_last4, user_id, verified_at FROM pan_registry WHERE pan_hash = $1',
    [String(panHash)], 'pan_find_hash',
  );
  return toRegistration(rows[0]);
}

export async function findByUserId(userId) {
  const { rows } = await pgQuery(
    'SELECT pan_hash, pan_last4, user_id, verified_at FROM pan_registry WHERE user_id = $1',
    [String(userId)], 'pan_find_user',
  );
  return toRegistration(rows[0]);
}

/** Is this PAN already spoken for, and by someone else? */
export async function isPanTaken(panHash, { exceptUserId = null } = {}) {
  const existing = await findByPanHash(panHash);
  if (!existing) return false;
  return exceptUserId ? existing.userId !== String(exceptUserId) : true;
}

/**
 * Release a registration.
 *
 * Deliberately narrow: it takes the account id as well as the hash, so an
 * operator cannot free a PAN by knowing only the hash. Freeing one that is in
 * use lets a second account claim an identity the first still holds.
 */
export async function releasePan(panHash, userId) {
  const { rows } = await pgQuery(
    'DELETE FROM pan_registry WHERE pan_hash = $1 AND user_id = $2 RETURNING pan_hash',
    [String(panHash), String(userId)], 'pan_release',
  );
  return rows.length > 0;
}

export async function panCount() {
  const { rows } = await pgQuery('SELECT COUNT(*)::int AS n FROM pan_registry', [], 'pan_count');
  return rows[0].n;
}
