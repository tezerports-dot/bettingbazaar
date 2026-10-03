// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * DisputeRecordBadge — how many payment disputes an account has lost, and
 * whether it is in high-risk review (2c+).
 *
 * The values are `lostDisputes` / `highRiskAt` as the users and merchants
 * repositories map them (`database/repositories/disputeFaults.js` writes them).
 * From the third loss (`HIGH_RISK_LOSSES` there) only a full admin can lift the
 * suspension, and the server refuses anyone else; this badge is what tells a
 * sub-admin why before they press.
 */
import React from 'react';

export function DisputeRecordBadge({ lostDisputes, highRiskAt }: { lostDisputes?: number; highRiskAt?: string | null }) {
  if (highRiskAt) {
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-900/40 text-red-300 border border-red-700/50"
        title="Lost three or more disputes. Only an admin can lift the suspension.">
        High risk · {lostDisputes ?? 0} lost disputes
      </span>
    );
  }
  if (lostDisputes && lostDisputes > 0) {
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-900/30 text-amber-300 border border-amber-700/40"
        title="Payment disputes decided against this account.">
        {lostDisputes} lost {lostDisputes === 1 ? 'dispute' : 'disputes'}
      </span>
    );
  }
  return null;
}
