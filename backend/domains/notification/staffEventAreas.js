// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * staffEventAreas.js — which staff may RECEIVE each live admin event (§2).
 *
 * A permission that stops at the REST API is half a permission (§32 S32). The
 * admin SSE stream and the socket admin room carried every order, dispute, KYC
 * verdict and bet to every staff account that connected, whatever it had been
 * given: a sub-admin trusted with the FAQ page received every player's order
 * as it was created. So each event names the AREAS (staffPermissions keys) whose
 * screens need it, and both transports deliver it only to staff who hold one.
 *
 * An event NOT listed here reaches full admins only. Failing closed is the right
 * default for a new event: the symptom is a screen that does not update for a
 * sub-admin, which somebody reports, rather than data reaching people it should
 * not, which nobody does.
 */
import { shieldContact } from '../identity/staffContactShield.js';
import { staffCan } from '../identity/staffPermissions.js';

const QUEUE = Object.freeze({ keys: ['canManageMerchants'] });
const DISPUTES = Object.freeze({ keys: ['canResolveDisputes'] });
const MERCHANTS = Object.freeze({ keys: ['canManageMerchants'] });
const CYCLES = Object.freeze({ keys: ['canViewAnalytics', 'canManageCycles'] });

export const STAFF_EVENT_AREAS = Object.freeze({
  // The payment queue
  queue_snapshot: QUEUE,
  queue_order_update: QUEUE,
  new_order: QUEUE,
  // Disputes
  order_disputed: DISPUTES,
  order_red_flagged: DISPUTES,
  // Merchants
  merchant_status_changed: MERCHANTS,
  merchant_approved: MERCHANTS,
  merchant_rejected: MERCHANTS,
  merchant_assignment_paused: MERCHANTS,
  merchant_assignment_resumed: MERCHANTS,
  merchant_flag_raised: MERCHANTS,
  merchant_config_updated: MERCHANTS,
  // Players
  user_flagged: { keys: ['canManageUsers'] },
  // Cycles and the live book
  admin_cycle_result: CYCLES,
  admin_new_cycle: CYCLES,
  admin_cycle_snapshot: CYCLES,
  // phantom_equalized and admin_bet_placed are NOT listed: they carry the real
  // (or phantom, from which the real follows) split of an OPEN round, which
  // tells who is winning, so they reach full admins only (owner, 2026-10-15).
  admin_stats_update: { keys: ['canViewAnalytics'] },
  admin_stats_delta: { keys: ['canViewAnalytics'] },
});

/** Whether this staff viewer may receive this event. */
export function staffMayReceive(viewer, event) {
  if (!viewer || viewer.isBlocked) return false;
  if (viewer.isAdmin === true) return true;
  const area = STAFF_EVENT_AREAS[event];
  if (!area) return false;
  return area.keys.some((k) => staffCan(viewer, k));
}

/**
 * Whether this staff viewer may see the real/phantom split of a round still
 * taking bets, on any channel (REST or live): the same answer as the live
 * events that carry it, so the two can never disagree.
 */
export function maySeeLiveSplit(viewer) {
  return staffMayReceive(viewer, 'admin_bet_placed');
}

/**
 * The socket.io rooms a staff account joins, and the rooms an event goes to.
 * One room per AREA rather than one "admin-room", so an emit reaches exactly
 * the people `staffMayReceive` would allow.
 */
export const staffRoom = (key) => `staff-area:${key}`;
export const FULL_ADMIN_ROOM = 'staff-area:admin';
export const personalStaffRoom = (userId) => `staff:${userId}`;

export function roomsForEvent(event) {
  const area = STAFF_EVENT_AREAS[event];
  const rooms = [FULL_ADMIN_ROOM];
  if (!area) return rooms;
  rooms.push(...area.keys.map(staffRoom));
  return rooms;
}

export function roomsForViewer(viewer, keys) {
  if (!viewer) return [];
  const rooms = [personalStaffRoom(viewer.userId)];
  if (viewer.isAdmin === true) rooms.push(FULL_ADMIN_ROOM);
  else rooms.push(...keys.filter((k) => staffCan(viewer, k)).map(staffRoom));
  return rooms;
}

/** Emit an admin event on socket.io to exactly the staff allowed it. */
export function emitToStaff(io, event, data) {
  if (!io) return;
  // Full admins get the event whole; every other room gets it without contact
  // or payout details (staffContactShield.js, CLAUDE.md §24).
  io.to(FULL_ADMIN_ROOM).emit(event, data);
  const others = roomsForEvent(event).filter((r) => r !== FULL_ADMIN_ROOM);
  if (!others.length) return;
  // `except` keeps a full admin who also manages the queue from a second, shielded copy.
  const target = io.to(others);
  (typeof target.except === 'function' ? target.except(FULL_ADMIN_ROOM) : target).emit(event, shieldContact(data));
}
