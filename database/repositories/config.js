// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/configPg.js — the platform's admin-editable configuration.
 *
 * Reads are cached and cheap; writes are validated, versioned and audited.
 *
 * ── The write path is the point ─────────────────────────────────────────────
 * Every write goes through `applyConfig`, which:
 *   • REFUSES a key the spec does not declare (the document model silently
 *     discarded these and reported success);
 *   • REFUSES a value outside its declared bounds (Mongoose skips `min`/`max`
 *     entirely on the update operators the admin routes use, so a 900% payout
 *     fee was accepted by all of them);
 *   • records the previous version and the keys that changed IN THE SAME
 *     TRANSACTION, so a configuration change that is not audited is a
 *     configuration change that did not happen;
 *   • refuses a stale write, so an admin who held a form open for ten minutes
 *     cannot silently overwrite an edit made in between.
 *
 * ── The cache, and what invalidates it ──────────────────────────────────────
 * The system config is read on nearly every request path. It is cached for a
 * few seconds and invalidated ON WRITE, so an admin's change takes effect
 * immediately rather than at the next expiry — the asymmetry that matters is
 * that a stale LIMIT is worse than a stale banner.
 */
import { pgQuery, getPool, connectGuarded } from '../client.js';
import { SCOPES } from '../spec/config.spec.js';

/** How long a configuration read may be reused. */
const CACHE_TTL_MS = 5_000;

/** `${scope}:${key}` -> { value, at } */
const cache = new Map();

export function invalidateConfigCache(scope = null, docKey = 'main') {
  if (scope) cache.delete(`${scope}:${docKey}`);
  else cache.clear();
}

function specFor(scope) {
  const spec = SCOPES[scope];
  if (!spec) throw new Error(`Unknown config scope '${scope}'. Known: ${Object.keys(SCOPES).join(', ')}`);
  return spec;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** The document a fresh install starts from — every declared default, nested. */
export function defaultsFor(scope) {
  return materialise(specFor(scope));
}

function materialise(node) {
  if (node.type !== 'group') return node.default;
  const out = {};
  for (const [key, child] of Object.entries(node.fields)) out[key] = materialise(child);
  return out;
}

/**
 * Stored settings over declared defaults.
 *
 * A key absent from storage falls back to its DECLARED default — the same
 * constant a fresh install is created with, never a second copy written at the
 * call site. That is what stops the drift that had the admin panel drawing a
 * cycle phase boundary the engine did not honour.
 */
function withDefaults(node, stored) {
  if (node.type !== 'group') return stored === undefined ? node.default : stored;
  const out = {};
  const src = (stored && typeof stored === 'object') ? stored : {};
  for (const [key, child] of Object.entries(node.fields)) out[key] = withDefaults(child, src[key]);
  return out;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Check a patch against the spec, returning the flattened set of changes.
 *
 * Throws on the first problem with the PATH that caused it, because "invalid
 * config" without a path is a message an operator cannot act on.
 */
function validatePatch(node, patch, path = []) {
  const flat = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`config: expected an object at ${path.join('.') || '<root>'}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const child = node.fields?.[key];
    const here = [...path, key];
    if (!child) {
      throw new Error(
        `config: refusing to write undeclared setting '${here.join('.')}'`
        + ` (known here: ${Object.keys(node.fields ?? {}).join(', ') || 'none'})`,
      );
    }
    if (child.type === 'group') {
      Object.assign(flat, validatePatch(child, value, here));
      continue;
    }
    flat[here.join('.')] = coerce(child, value, here.join('.'));
  }
  return flat;
}

function coerce(field, value, path) {
  switch (field.type) {
    case 'number': {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new Error(`config: '${path}' must be a number, got ${JSON.stringify(value)}`);
      if (field.min !== null && field.min !== undefined && num < field.min) {
        throw new Error(`config: '${path}' must be >= ${field.min}, got ${num}`);
      }
      if (field.max !== null && field.max !== undefined && num > field.max) {
        throw new Error(`config: '${path}' must be <= ${field.max}, got ${num}`);
      }
      return num;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`config: '${path}' must be true or false, got ${JSON.stringify(value)}`);
      return value;
    case 'string':
      if (typeof value !== 'string') throw new Error(`config: '${path}' must be a string, got ${JSON.stringify(value)}`);
      return value;
    case 'string[]':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`config: '${path}' must be an array of strings`);
      }
      return value;
    case 'number[]':
      if (!Array.isArray(value) || value.some((v) => !Number.isFinite(Number(v)))) {
        throw new Error(`config: '${path}' must be an array of numbers`);
      }
      return value.map(Number);
    default:
      throw new Error(`config: '${path}' has an unknown spec type '${field.type}'`);
  }
}

/** Set a dotted path inside a plain object, creating groups as needed. */
function setPath(target, dotted, value) {
  const parts = dotted.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * One configuration document, defaults filled in.
 *
 * Never returns null: a scope with no row yet reads as its declared defaults,
 * which is what a fresh install genuinely is. A caller that had to handle
 * "config missing" would grow its own fallback copy of every constant, and that
 * second copy is the drift this store exists to remove.
 */
export async function getConfig(scope, { docKey = 'main', fresh = false } = {}) {
  const spec = specFor(scope);
  const cacheKey = `${scope}:${docKey}`;

  if (!fresh) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  const { rows } = await pgQuery(
    `SELECT settings, version, updated_at, updated_by
       FROM config_documents WHERE scope = $1 AND doc_key = $2`,
    [scope, docKey], 'config_get',
  );
  const row = rows[0];
  const value = Object.freeze({
    ...withDefaults(spec, row?.settings ?? {}),
    key: docKey,
    version: row ? Number(row.version) : 0,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  });
  cache.set(cacheKey, { value, at: Date.now() });
  return value;
}

/** The system configuration. The read 37 call sites make. */
export async function getSystemConfig(options = {}) {
  return getConfig('system', options);
}

/** Several scopes in one round trip, for a panel that renders all of them. */
export async function getConfigs(scopes = [], { docKey = 'main' } = {}) {
  const out = {};
  await Promise.all(scopes.map(async (scope) => { out[scope] = await getConfig(scope, { docKey }); }));
  return out;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Apply a patch to a configuration document.
 *
 * @param {object}  args
 * @param {string}  args.scope
 * @param {object}  args.patch      nested, partial — only what is changing
 * @param {string}  [args.actor]    who is making the change
 * @param {string}  [args.reason]
 * @param {number}  [args.expectedVersion] refuse if the document has moved on
 *
 * @returns {{ok:true, config, version, changed}}
 *          {{ok:false, reason:'STALE', currentVersion}}
 *
 * The row, its version and its audit entry are written in ONE transaction. An
 * audit trail that can be missing the change it describes is not an audit
 * trail — and this one answers "who changed the payout fee, and to what?",
 * which is a question asked after money has already moved under the new value.
 */
export async function applyConfig({
  scope, patch, docKey = 'main', actor = null, reason = null, expectedVersion = null,
}) {
  const spec = specFor(scope);
  const flat = validatePatch(spec, patch);
  if (!Object.keys(flat).length) {
    return { ok: true, config: await getConfig(scope, { docKey, fresh: true }), version: null, changed: {} };
  }

  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;
  let committed = null;
  let stale = null;

  try {
    await client.query('BEGIN');

    // Materialise the row and lock it, so the read-modify-write below cannot
    // interleave with another admin's save. A configuration document is small
    // and edited rarely; correctness is worth the lock.
    await client.query(
      `INSERT INTO config_documents (scope, doc_key) VALUES ($1, $2)
       ON CONFLICT (scope, doc_key) DO NOTHING`, [scope, docKey],
    );
    const locked = await client.query(
      `SELECT settings, version FROM config_documents
        WHERE scope = $1 AND doc_key = $2 FOR UPDATE`, [scope, docKey],
    );
    const current = locked.rows[0];
    const currentVersion = Number(current.version);

    if (expectedVersion !== null && Number(expectedVersion) !== currentVersion) {
      await client.query('ROLLBACK');
      stale = { ok: false, reason: 'STALE', currentVersion };
    }

    if (stale) return stale;

    const settings = JSON.parse(JSON.stringify(current.settings ?? {}));
    for (const [dotted, value] of Object.entries(flat)) setPath(settings, dotted, value);
    const nextVersion = currentVersion + 1;

    await client.query(
      `UPDATE config_documents
          SET settings = $3, version = $4, updated_at = now(), updated_by = $5
        WHERE scope = $1 AND doc_key = $2`,
      [scope, docKey, JSON.stringify(settings), nextVersion, actor ? String(actor) : null],
    );
    await client.query(
      `INSERT INTO config_document_versions
         (scope, doc_key, version, settings, changed, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [scope, docKey, nextVersion, JSON.stringify(settings), JSON.stringify(flat),
        actor ? String(actor) : null, reason],
    );
    await client.query('COMMIT');
    // Applied immediately, not at the next expiry: a stale LIMIT is worse than
    // a stale banner, and both go through here.
    invalidateConfigCache(scope, docKey);
    // Built from what was just written, NOT re-read. A read here would ask the
    // pool for a second client while this one is still checked out, which
    // deadlocks the pool once enough writers do it at once.
    committed = { settings, version: nextVersion };
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Pass the error so a dead socket is DESTROYED rather than handed to the
    // next caller. See client.connectGuarded.
    client.release(failure ?? undefined);
  }

  // The client is back in the pool before this runs, so asking for another is
  // safe here and is not inside the transaction above.
  return {
    ok: true,
    config: await getConfig(scope, { docKey, fresh: true }),
    version: committed.version,
    changed: flat,
  };
}

/** Convenience for the 1 call site that patches the system config. */
export async function applySystemConfig(patch, options = {}) {
  return applyConfig({ scope: 'system', patch, ...options });
}

/**
 * Move a counter inside a configuration document, atomically.
 *
 * `adminTokenSupply.minted` is the only one of these, and it is a cap on how
 * many tokens may exist. A read-modify-write would let two concurrent mints
 * both read the same `minted` and both pass the cap check — which is how a
 * supply ceiling stops being a ceiling. The arithmetic and the check are one
 * statement here; it returns false rather than raising, because "the cap
 * refused this" is an answer, not an error.
 */
export async function bumpConfigCounter({
  scope, path, by, docKey = 'main', cap = null,
}) {
  specFor(scope);
  const parts = path.split('.');
  const { rows } = await pgQuery(
    `UPDATE config_documents
        SET settings = jsonb_set(settings, $3::text[],
              to_jsonb(COALESCE((settings #>> $3::text[])::numeric, 0) + $4::numeric), true),
            version = version + 1,
            updated_at = now()
      WHERE scope = $1 AND doc_key = $2
        AND ($5::numeric IS NULL
             OR COALESCE((settings #>> $3::text[])::numeric, 0) + $4::numeric <= $5::numeric)
      RETURNING (settings #>> $3::text[])::numeric AS value`,
    [scope, docKey, parts, Number(by), cap === null ? null : Number(cap)],
    'config_bump',
  );
  invalidateConfigCache(scope, docKey);
  return rows[0] ? { ok: true, value: Number(rows[0].value) } : { ok: false, reason: 'CAP_EXCEEDED' };
}

/**
 * Write ONE dotted path — `betLimits.thirtyMin.min` — and version it.
 *
 * A convenience over `applyConfig` for callers that hold a path and a value
 * rather than a nested patch. Everything else is identical: the spec still
 * refuses an undeclared key or an out-of-range value, and the change is still
 * recorded in the same transaction that makes it.
 */
export async function setConfigPath(scope, path, value, { docKey = 'main', actor = null, reason = null } = {}) {
  const patch = {};
  setPath(patch, String(path), value);
  return applyConfig({ scope, docKey, patch, actor, reason });
}

/**
 * The change history for a document, newest first.
 *
 * This is what `ConfigVersion` was for. It is written by `applyConfig` in the
 * same transaction as the change rather than by hand at each call site, so
 * there is no path that edits configuration without leaving a record.
 */
export async function getConfigHistory(scope, { docKey = 'main', limit = 50 } = {}) {
  specFor(scope);
  const { rows } = await pgQuery(
    `SELECT version, changed, changed_by, reason, created_at
       FROM config_document_versions
      WHERE scope = $1 AND doc_key = $2
      ORDER BY version DESC LIMIT $3`,
    [scope, docKey, Math.min(Math.max(Number(limit) || 50, 1), 500)],
    'config_history',
  );
  return rows.map((r) => ({
    version: Number(r.version),
    changed: r.changed,
    changedBy: r.changed_by,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

/**
 * Restore a document to an earlier version.
 *
 * Goes through `applyConfig`, so the restore is itself a new version with its
 * own audit entry. Rewinding the version counter would make the trail describe
 * a history that did not happen.
 */
export async function restoreConfigVersion(scope, version, { docKey = 'main', actor = null } = {}) {
  specFor(scope);
  const { rows } = await pgQuery(
    `SELECT settings FROM config_document_versions
      WHERE scope = $1 AND doc_key = $2 AND version = $3`,
    [scope, docKey, Number(version)], 'config_restore_read',
  );
  if (!rows[0]) return { ok: false, reason: 'NOT_FOUND' };
  return applyConfig({
    scope, docKey, patch: rows[0].settings, actor,
    reason: `Restored from version ${version}`,
  });
}
