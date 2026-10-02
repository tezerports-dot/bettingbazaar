// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sentence each team refusal is shown as, and its HTTP status.
 *
 * The repository answers with a `reason`; the admin routes and the supervisor
 * routes both turn it into what a person reads. One map, so the two panels
 * cannot word the same refusal differently (§5), and every sentence says what
 * to do next rather than only that it failed (§32 S14).
 */
import { MAX_TEAMS, TEAM_SIZE } from '#db/repositories/teams.js';

const REFUSALS = Object.freeze({
  not_found:             [404, 'Not found.'],
  team_not_found:        [404, 'That team is not one of yours.'],
  merchant_not_found:    [404, 'No merchant has that ID. Ask them for the ID shown on their Profile.'],
  not_approved:          [409, 'That merchant has not been approved by an admin yet.'],
  merchant_not_approved: [409, 'That merchant has not been approved by an admin yet, so they cannot join a team.'],
  has_teams:             [409, 'This supervisor still runs teams. Remove every team before changing their rail or role.'],
  is_member:             [409, 'That merchant is in a team. Remove them from it before making them a supervisor.'],
  is_supervisor:         [409, 'A supervisor cannot be a member of a team.'],
  not_supervisor:        [403, 'Only a supervisor can do that.'],
  team_limit:            [409, `A supervisor can run at most ${MAX_TEAMS} teams.`],
  team_full:             [409, `That team already has ${TEAM_SIZE} members.`],
  already_in_team:       [409, 'That merchant is already in a team. They must leave it first.'],
  has_members:           [409, 'Remove every member before deleting the team.'],
  not_pending:           [409, 'That merchant is not waiting for approval.'],
});

/** Send the refusal for a repository `{ ok: false, reason }`. */
export function refuse(res, reason) {
  const [status, message] = REFUSALS[reason] ?? [409, 'That could not be done.'];
  return res.status(status).json({ success: false, code: reason, message });
}
