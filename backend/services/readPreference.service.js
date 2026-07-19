// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/readPreference.service.js — Read Replicas (plan item 47). 2026-07-13.
 *
 * The read-routing half of read replicas, wired to the FLAGS.READ_REPLICA
 * feature flag the team already reserved (default OFF). When the flag is ON
 * (a real replica-set member exists to serve reads — Atlas secondaries or a
 * self-hosted secondary), analytics-class queries route to
 * `secondaryPreferred`, taking reporting load off the primary. Flag OFF (the
 * default and the current deploy) = exact current behavior, primary reads.
 *
 * ONLY for analytics/reporting/leaderboard reads where seconds-stale data is
 * fine. NEVER apply to money paths — wallet balances, bet placement,
 * settlement, and the ledger must read the primary (their correctness
 * depends on read-your-own-write).
 */
import { isEnabled, FLAGS } from './featureFlags.service.js';

/** Route a Mongoose query to a secondary when READ_REPLICA is on. Chainable. */
export async function preferReplica(query) {
  try {
    if (await isEnabled(FLAGS.READ_REPLICA)) query.read('secondaryPreferred');
  } catch { /* flag lookup must never break a read */ }
  return query;
}
