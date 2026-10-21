// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * When a pool's cash out ends (owner, 2026-10-21; the rule is
 * `database/repositories/teamCashOut.js`): once its pool cannot cover the
 * smallest buy it could still be sent and no buy of it is open. Which buys it
 * could be sent is the admin's, per size (`offeredSizesFor`): an agent team
 * gets its supervisor's rail's sizes, a merchant account the MERCHANT group.
 */
import { getSystemConfig } from '#db/repositories/config.js';
import { listCashingOut, finishCashOut } from '#db/repositories/teamCashOut.js';
import { offeredSizesFor } from '../merchant/denominations.js';
import { rupeesToPaise } from '../../shared/money.js';

/** The smallest buy, in paise, the platform could route to `team` now; null when none could. */
export function smallestBuyFor(cfg, team) {
  const group = team.kind === 'DIRECT' ? 'MERCHANT' : team.rail;
  if (!group) return null;
  const sizes = offeredSizesFor(cfg, group, 'DEPOSIT');
  return sizes.length ? rupeesToPaise(Math.min(...sizes)) : null;
}

/** End every cash out that has run its course; the pause starts. Returns the teams ended. */
export async function finishCashOuts() {
  const teams = await listCashingOut();
  if (!teams.length) return [];
  const cfg = await getSystemConfig();
  const ended = [];
  for (const team of teams) {
    const out = await finishCashOut(team.teamId, smallestBuyFor(cfg, team));
    if (out.ok) ended.push({ teamId: team.teamId, pausedUntil: out.pausedUntil });
  }
  return ended;
}
