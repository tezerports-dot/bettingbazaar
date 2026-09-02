// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/configuration/configVersioning.service.js — the versioned write path
 * for admin-editable business parameters.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE WAS, AND WHY MOST OF IT IS GONE
 * ══════════════════════════════════════════════════════════════════════════
 * It was a SECOND configuration store: it wrote values to a `SystemConfig`
 * document and appended audit rows to a `ConfigVersion` collection, by hand, at
 * each call site.
 *
 * Two things followed from that, and the second is why this matters:
 *
 *   1. Two owners for one value. `getSystemConfig()` reads `config_documents`,
 *      and this wrote somewhere else — so the admin System Settings page saved
 *      successfully and NOTHING the platform read actually changed. Bet limits,
 *      deposit bounds, the alert webhook, the TLS policy: all of them appeared
 *      to save and none of them took effect.
 *
 *   2. The audit row was a SEPARATE write. A change applied and then failed to
 *      record left a configuration change nobody could account for — in the one
 *      place where "who raised the payout fee, and when" is asked after money
 *      has already moved under the new value.
 *
 * `applyConfig` in the configuration store does both in ONE transaction, and
 * refuses a key the spec does not declare or a value outside its declared
 * bounds — neither of which the document path could express. So this file is
 * now the thin adapter that keeps the existing call shape and routes to it.
 *
 * ── The approval and scheduling flow was deleted, not ported ───────────────
 * `setConfigField` accepted `requireApproval` and a future `effectiveAt`, which
 * recorded a version as PENDING_APPROVAL or SCHEDULED instead of applying it,
 * and a cron job swept for due SCHEDULED versions.
 *
 * NOTHING ever set either option. The one caller passes neither, no route
 * exposes an approval endpoint, and no admin screen offers a future date — so
 * the sweep ran every 60 seconds over rows that could not exist, and the
 * approval gate was a state no configuration change could enter. It is deleted
 * rather than carried across: a governance control that cannot be reached is
 * not a control, and porting it would have made it look like one.
 *
 * If scheduled or approval-gated changes are wanted, they belong on
 * `config_document_versions` — where the version rows actually live and where
 * an applied change is recorded by the same transaction that applies it.
 */
import { db } from '#db';

/**
 * The config SCOPES a caller may name, by the model name the old API used.
 *
 * Kept as a map rather than passing the caller's string through, for the reason
 * the original had it: it decides which documents this service may write, and
 * that must be a property of this module rather than of the call.
 */
const SCOPE_BY_MODEL = Object.freeze({ SystemConfig: 'system' });

function scopeFor(modelName) {
  const scope = SCOPE_BY_MODEL[modelName];
  if (!scope) {
    throw new Error(
      `Unknown config model: ${modelName}. Known: ${Object.keys(SCOPE_BY_MODEL).join(', ')}`,
    );
  }
  return scope;
}

/**
 * setConfigField — the write path for a single business-parameter change.
 *
 * @param {string} modelName  'SystemConfig'
 * @param {string} field      dot-path, e.g. 'betLimits.thirtyMin.min'
 * @param {*}      newValue
 * @param {object} actor      { userId, userName }
 * @param {object} opts       { justification }
 *
 * Applies immediately and records the version in the same transaction. Throws
 * with the offending PATH when the spec does not declare the field or the value
 * is out of its declared range — an admin panel writing a setting nobody reads
 * is worse than one that reports the mistake.
 */
export async function setConfigField(modelName, field, newValue, actor, opts = {}) {
  const { justification = '' } = opts;
  return db.config.setConfigPath(scopeFor(modelName), field, newValue, {
    actor: actor?.userId ?? null,
    reason: justification || `Set ${field}`,
  });
}

/** getFieldHistory — every recorded change, newest first. Read-only. */
export async function getFieldHistory(modelName, field) {
  const history = await db.config.getConfigHistory(scopeFor(modelName));
  // Filtered on the keys a version actually touched, which the store records
  // per change — so a field's history is the changes to THAT field rather than
  // every configuration edit that happened to include it in a full document.
  return history.filter((v) => Object.keys(v.changed ?? {}).some(
    (key) => key === field || key.startsWith(`${field}.`),
  ));
}

/**
 * rollbackToVersion — restore the document to an earlier version.
 *
 * Never deletes history: the restore is itself a new version with its own audit
 * entry, so the trail says what happened rather than pretending it did not.
 */
export async function rollbackToVersion(modelName, version, actor) {
  return db.config.restoreConfigVersion(scopeFor(modelName), version, {
    actor: actor?.userId ?? null,
  });
}
