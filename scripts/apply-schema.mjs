// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Apply database/schema.sql once and exit — the production compose's one-shot
 * `migrate` service, run before the PM2 workers start (they then boot with
 * BB_SCHEMA_APPLY=skip and only check the schema is present).
 *
 *   node scripts/apply-schema.mjs        (DATABASE_URL from the environment)
 */
import { applySchema, closePg } from '#db/client.js';

try {
  const t0 = Date.now();
  await applySchema({ mode: 'boot' });
  console.log(`[migrate] schema applied in ${Date.now() - t0} ms`);
  await closePg();
  process.exit(0);
} catch (err) {
  console.error('[migrate] schema apply failed:', err.message);
  await closePg();
  process.exit(1);
}
