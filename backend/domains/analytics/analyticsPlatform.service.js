// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/analytics/analyticsPlatform.service.js — platform-level trends.
 *
 * Growth (users), business (betting and funding volume), revenue (from the
 * settlement ledger, which is the financial truth), and risk (rejection and
 * dispute signals). All derived, read-only, day-bucketed and chart-ready.
 *
 * ── Two things the aggregates got wrong ─────────────────────────────────────
 *
 * 1. THEY EMITTED ONLY DAYS THAT HAD ACTIVITY. A chart drawn from that draws a
 *    straight line across a quiet stretch — so an outage reads as a gentle
 *    slope rather than a cliff, and the day the deposits stopped is invisible.
 *    Every series is now gap-filled: a zero is a fact, a missing day is not.
 *
 * 2. THEY CUT DAYS IN UTC. This platform operates in IST, which is UTC+5:30, so
 *    everything after 18:30 local landed on the following day's bar — a fifth
 *    of each day's activity attributed to the next one, every day.
 */
import { db } from '#db';

/** Growth: daily new registrations and first-time depositors. */
export const growthTrend = (options = {}) => db.stats.growthTrend(options);

/** Business: daily betting volume and count, plus funding volume by direction. */
export const businessTrend = (options = {}) => db.stats.businessTrend(options);

/** Revenue: daily PLATFORM_REVENUE movement from the settlement ledger. */
export const revenueTrend = (options = {}) => db.stats.revenueTrend(options);

/** Risk: daily rejected, cancelled, failed and disputed order signals. */
export const riskTrend = (options = {}) => db.stats.riskTrend(options);
