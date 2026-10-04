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
import { SUPERVISOR_MESSAGES_PER_DISPUTE } from '#db/repositories/chat.js';

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
  has_pool_history:      [409, 'This team has traded tokens, so it is kept as the record of where they went. It cannot be deleted.'],
  // Team pools (Step 2b)
  pool_short:            [409, "The team's pool does not have that many tokens available. Ask for fewer, or wait for open orders to finish."],
  request_pending:       [409, 'This team already has a request of that kind waiting. Cancel it, or wait for an admin to decide it.'],
  request_not_pending:   [409, 'That request has already been decided or cancelled. Refresh to see its outcome.'],
  request_not_found:     [404, 'No such request.'],
  supply_cap_exceeded:   [409, 'The platform does not hold that many tokens to sell. Sell fewer.'],
  // Oversight (Step 2f)
  member_not_found:      [404, 'That merchant is not an approved member of one of your teams. A member\'s log opens once an admin approves them.'],
  dispute_not_found:     [404, 'That dispute is not on an order of one of your teams.'],
  dispute_closed:        [409, 'This dispute has been decided, so its thread is closed. Refresh to see the decision.'],
  bad_message:           [400, 'Write a message of up to 2,000 characters.'],
  message_has_mobile:    [400, 'Take the mobile number out of your message. Nobody\'s mobile number may be shared, not even with the dispute manager.'],
  too_many_messages:     [409, `You have sent the ${SUPERVISOR_MESSAGES_PER_DISPUTE} messages a supervisor may send on one dispute. The dispute manager has them all; wait for their decision.`],
});

/** Send the refusal for a repository `{ ok: false, reason }`. */
export function refuse(res, reason) {
  const [status, message] = REFUSALS[reason] ?? [409, 'That could not be done.'];
  return res.status(status).json({ success: false, code: reason, message });
}
