// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * teamOversight.service.js — red flags and what supervisors and members are
 * shown of a team's work (PROJECT_STATUS §3.10, Step 2f).
 *
 * The figures and the flags are computed by `database/repositories/
 * teamOversight.js`; this module schedules the daily evaluation with the
 * admin's thresholds and shapes the two merchant-panel readings of a team's
 * activity.
 */
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { redFlagSettings } from '#db/repositories/teamOversight.js';

/**
 * Evaluate every IST day that has ended and was not evaluated yet, with the
 * thresholds as they stand now. Run hourly by the cron; the day's row makes a
 * second run (or a second instance) a no-op.
 */
export async function runDailyRedFlags() {
  const settings = redFlagSettings(await getSystemConfig());
  const out = [];
  for (const day of await db.teamOversight.daysToEvaluate()) {
    out.push({ day, ...(await db.teamOversight.evaluateRedFlags(day, settings)) });
  }
  return out;
}

/**
 * A mobile number anywhere in free text, by the same pattern as the row
 * check `bb_text_has_a_mobile` (database/schema.sql) and `MOBILE_IN_TEXT`
 * (payment/cashLink.js), written with lookarounds so a replace keeps the
 * characters either side.
 */
const MOBILE_RUN = /(?<![0-9])(?:(?:00|\+)?91[ -]?|0)?[6-9](?:[ .-]?[0-9]){9}(?![0-9])/g;

/**
 * Free text a supervisor is shown that someone else typed — a dispute reason,
 * a rejection reason, the dispute manager's messages — with any mobile number
 * hidden (owner, 2026-10-03: nobody's mobile is exposed anywhere).
 */
export function hideMobiles(text) {
  return typeof text === 'string' ? text.replace(MOBILE_RUN, '[number hidden]') : text;
}

/** An order row for a supervisor, its free text through `hideMobiles`. */
export function withMobilesHidden(order) {
  return order && {
    ...order,
    disputeReason: hideMobiles(order.disputeReason),
    rejectedReason: hideMobiles(order.rejectedReason),
  };
}

/**
 * What a MEMBER is shown of their team's work over the window: the team's
 * totals, the average per member, and their own figures. Never another
 * member's row — the supervisor and admins see those.
 */
export function teamPerformanceFor(activity, merchantId) {
  const rows = activity.members;
  const n = rows.length;
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const mine = rows.find((r) => r.merchantId === String(merchantId));
  return {
    days: activity.days,
    from: activity.from,
    members: n,
    team: {
      completedOrders: sum('completedOrders'),
      completedTokens: sum('completedPaise') / 100,
      averageOrders: n ? Number((sum('completedOrders') / n).toFixed(2)) : 0,
      averageOnlineSeconds: n ? Math.round(sum('onlineSeconds') / n) : 0,
    },
    me: mine ? {
      completedOrders: mine.completedOrders,
      completedTokens: mine.completedPaise / 100,
      onlineSeconds: Math.round(mine.onlineSeconds),
    } : null,
  };
}

/** A supervisor's reading: every approved member's figures, whole seconds and tokens. */
export function memberActivityRows(activity, teamId) {
  return activity.members.map((r) => ({
    teamId,
    merchantId: r.merchantId,
    name: r.name,
    publicRef: r.publicRef,
    isOnline: r.isOnline,
    completedOrders: r.completedOrders,
    completedTokens: r.completedPaise / 100,
    onlineSeconds: Math.round(r.onlineSeconds),
  }));
}
