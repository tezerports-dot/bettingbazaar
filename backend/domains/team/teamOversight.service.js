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
import { hideMobiles } from '../identity/mobileInText.js';

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
 * A UPI handle or e-mail address in free text: a name, `@`, a provider. It
 * resolves to a person (and on most UPI apps to their phone number), so a
 * supervisor is never shown one (§24).
 */
const HANDLE = /[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*/g;

/**
 * A payment reference or account number: nine digits or more, spaces or
 * dashes between them allowed ("4123 4567 8901"). Commas end a run, so an
 * amount written "1,00,000" stays readable.
 */
const LONG_NUMBER = /(?<![0-9])[0-9](?:[ -]?[0-9]){8,}(?![0-9])/g;

/**
 * Free text a supervisor reads that someone else typed (a dispute reason, a
 * rejection reason, the dispute manager's messages) with what would identify
 * the player hidden: mobile numbers in every spelling `hideMobiles` reads, UPI
 * handles, and the long numbers of references and accounts. The supervisor
 * speaks for their member and pays nobody, so none of it is theirs to see
 * (§24; owner, 2026-10-03).
 */
export function hideForSupervisor(text) {
  if (text == null) return text;
  return hideMobiles(text)
    .replace(HANDLE, '[handle hidden]')
    .replace(LONG_NUMBER, '[number hidden]');
}

/** An order row for a supervisor, its free text through `hideForSupervisor`. */
export function withTextHidden(order) {
  return order && {
    ...order,
    disputeReason: hideForSupervisor(order.disputeReason),
    rejectedReason: hideForSupervisor(order.rejectedReason),
  };
}

/**
 * Which messages of a dispute thread a supervisor reads: their own, their
 * member's, and the dispute manager's own words. Not the player's messages
 * (the player's detail is not theirs, §24), and not system notices, which
 * carry staff names and escalation notes written for staff (S52).
 */
export function supervisorMaySee(message) {
  if (message.senderType === 'SUPERVISOR') return true;
  return !message.isSystem && (message.senderType === 'ADMIN' || message.senderType === 'MERCHANT');
}

/** Fewest approved members at which the team's totals no longer give away one teammate's figures. */
export const TEAM_FIGURES_FROM = 3;

/**
 * What a MEMBER is shown of their team's work over the window: the team's
 * totals, the average per member, and their own figures. Never another
 * member's row — the supervisor and admins see those — and no team figures
 * below `TEAM_FIGURES_FROM` members, where they would be one.
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
    // With two members, the team's total less your own IS your teammate's.
    team: n < TEAM_FIGURES_FROM ? null : {
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
