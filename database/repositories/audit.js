// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/audit.js — who did what, to whom, from where, and whether it
 * worked.
 *
 * Both tables are append-only by TRIGGER. An audit log something can edit is
 * not an audit log, and a convention that nothing edits it is not the same as
 * a database that refuses.
 *
 * A FAILED action is recorded as carefully as a successful one. An audit trail
 * of successes cannot show an attack that did not land, which is most of them.
 */
import { pgQuery } from '../client.js';

/** Never let a logging failure take down the operation it was describing. */
async function safely(label, fn) {
  try { return await fn(); } catch (e) {
    console.error(`[audit] ${label} not recorded:`, e.message);
    return null;
  }
}

/** The simple trail: an admin, an action, a target. */
export async function record({ adminId = null, action, details = {}, targetId = null, ip = null }) {
  if (!action) throw new Error('audit.record requires an action');
  return safely('entry', async () => {
    const { rows } = await pgQuery(
      `INSERT INTO audit_logs (admin_id, action, details, target_id, ip)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [adminId ? String(adminId) : null, String(action),
        JSON.stringify(details ?? {}), targetId ? String(targetId) : null, ip],
      'audit_record',
    );
    return { id: Number(rows[0].id), createdAt: rows[0].created_at };
  });
}

/**
 * The richer trail.
 *
 * `success: false` REQUIRES an error message — the table refuses otherwise,
 * because a failure nobody can investigate is not worth the row it occupies.
 */
export async function recordDetailed({
  performedBy = null, performedByName = null, performedByRole = null,
  action, category = 'GENERAL', targetType = null, targetId = null, targetName = null,
  details = {}, changes = {}, ip = null, userAgent = null,
  method = null, endpoint = null, success = true, errorMessage = null,
}) {
  if (!action) throw new Error('audit.recordDetailed requires an action');
  return safely('detailed entry', async () => {
    const { rows } = await pgQuery(
      `INSERT INTO enhanced_audit_logs (
         performed_by, performed_by_name, performed_by_role, action, category,
         target_type, target_id, target_name, details, changes, ip, user_agent,
         method, endpoint, success, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, created_at`,
      [performedBy ? String(performedBy) : null, performedByName, performedByRole,
        String(action), String(category), targetType,
        targetId ? String(targetId) : null, targetName,
        JSON.stringify(details ?? {}), JSON.stringify(changes ?? {}),
        ip, userAgent, method, endpoint, Boolean(success),
        // The CHECK requires one. Supply a generic rather than failing the
        // write: losing the record of a failure is worse than a vague message.
        success ? errorMessage : (errorMessage || 'unspecified failure')],
      'audit_record_detailed',
    );
    return { id: Number(rows[0].id), createdAt: rows[0].created_at };
  });
}

const toEntry = (r) => ({
  id: Number(r.id), adminId: r.admin_id, action: r.action,
  details: r.details, targetId: r.target_id, ip: r.ip,
  createdAt: r.created_at, timestamp: r.created_at,
});

const toDetailed = (r) => ({
  id: Number(r.id),
  performedBy: r.performed_by, performedByName: r.performed_by_name,
  performedByRole: r.performed_by_role,
  action: r.action, category: r.category,
  targetType: r.target_type, targetId: r.target_id, targetName: r.target_name,
  details: r.details, changes: r.changes,
  ip: r.ip, userAgent: r.user_agent, method: r.method, endpoint: r.endpoint,
  success: r.success, errorMessage: r.error_message,
  createdAt: r.created_at, timestamp: r.created_at,
});

/**
 * Search the trail.
 *
 * Keyset pagination on `(created_at, id)`. Not OFFSET: an entry written while
 * an auditor pages through shifts every later row by one, and the page after it
 * silently skips an entry — in the one place where a missing row is the point.
 */
export async function search({
  adminId = null, action = null, targetId = null, category = null,
  onlyFailures = false, detailed = false, since = null, until = null,
  limit = 100, cursor = null,
} = {}) {
  const table = detailed ? 'enhanced_audit_logs' : 'audit_logs';
  const actorColumn = detailed ? 'performed_by' : 'admin_id';
  const where = []; const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

  if (adminId) add(`${actorColumn} = $?`, String(adminId));
  if (action) add('action = $?', String(action));
  if (targetId) add('target_id = $?', String(targetId));
  if (detailed && category) add('category = $?', String(category));
  if (detailed && onlyFailures) where.push('NOT success');
  if (since) add('created_at >= $?', since);
  if (until) add('created_at <= $?', until);
  if (cursor?.createdAt && cursor?.id !== undefined) {
    params.push(cursor.createdAt, Number(cursor.id));
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }

  const size = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await pgQuery(
    `SELECT * FROM ${table}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ${size + 1}`,
    params, 'audit_search',
  );

  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    entries: page.map(detailed ? toDetailed : toEntry),
    nextCursor: hasMore && last ? { createdAt: last.created_at, id: Number(last.id) } : null,
  };
}

/** Everything that happened to one target, oldest first — the object's story. */
export async function historyFor(targetId, { limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM enhanced_audit_logs WHERE target_id = $1
      ORDER BY created_at ASC, id ASC LIMIT $2`,
    [String(targetId), Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    'audit_history',
  );
  return rows.map(toDetailed);
}

/** Failed actions in a window — the query a security review actually runs. */
export async function recentFailures({ hours = 24, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM enhanced_audit_logs
      WHERE NOT success AND created_at > now() - ($1 || ' hours')::interval
      ORDER BY created_at DESC LIMIT $2`,
    [String(Math.max(Number(hours) || 24, 1)),
      Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    'audit_recent_failures',
  );
  return rows.map(toDetailed);
}
