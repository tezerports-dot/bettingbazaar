// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/mongooseGlobalOptions.js — process-global Mongoose options that MUST
 * be in force before the first query runs, on every entrypoint (the app, the
 * test suites, and the operational scripts). Imported purely for side effect;
 * calling it more than once is harmless (mongoose.set is idempotent, and the
 * module body runs once per process thanks to ESM caching).
 *
 * ── updatePipeline: true ─────────────────────────────────────────────────────
 * Mongoose 9 made AGGREGATION-PIPELINE UPDATES —
 *     Model.updateOne(filter, [ { $set: … }, … ])   (an ARRAY as the update)
 * — throw by default ("Cannot pass an array to query updates unless the
 * `updatePipeline` option is set"), because Mongoose does not cast pipeline
 * stages and wanted the escape hatch to be explicit. See
 * node_modules/mongoose/lib/query.js (the `updatePipeline` guard) and
 * lib/mongoose.js (the option, `false` by default).
 *
 * This codebase relies on pipeline updates in paths written and PROVEN against
 * Mongoose 8's "pipelines allowed" behavior, e.g.:
 *   • domains/markets/cycleGenerator.service.js runPhantomEqualizer — $max/$add
 *     balance the two phantom pools atomically against the LIVE document, so a
 *     concurrent real bet's $inc is never lost (the whole point of using a
 *     pipeline instead of a read-modify-write $set).
 *   • domains/markets/cyclePool.service.js
 *   • postgres/adminIssuanceAuthority.js
 *   • scripts/enforce-public-chat-retention.js
 *
 * Every one of those stages computes from existing NUMERIC fields server-side,
 * so Mongoose's lack of pipeline casting is a non-issue here — there is nothing
 * to cast. Setting this true restores the exact pre-9 behavior GLOBALLY rather
 * than annotating each call site: annotating risks a missed path throwing in
 * production on a branch the tests don't cover (runPhantomEqualizer already
 * swallows its own errors in a try/catch, so a missed pipeline update would
 * fail SILENTLY — the pool would just stop equalizing).
 */
import mongoose from 'mongoose';

mongoose.set('updatePipeline', true);
