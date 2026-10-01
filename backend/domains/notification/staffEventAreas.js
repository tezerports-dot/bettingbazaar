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
 * `queueManager: true` also delivers it to queue managers, who hold no keys and
 * exist to work the payment queue.
 *
 * An event NOT listed here reaches full admins only. Failing closed is the right
 * default for a new event: the symptom is a screen that does not update for a
 * sub-admin, which somebody reports, rather than data reaching people it should
 * not, which nobody does.
 */
import { staffCan } from '../identity/staffPermissions.js';

const QUEUE = Object.freeze({ keys: ['canManageMerchants'], queueManager: true });
const DISPUTES = Object.freeze({ keys: ['canResolveDisputes'] });
const MERCHANTS = Object.freeze({ keys: ['canManageMerchants'] });
const CYCLES = Object.freeze({ keys: ['canViewAnalytics', 'canManageCycles'] });

export const STAFF_EVENT_AREAS = Object.freeze({
  // The payment queue
  queue_snapshot: QUEUE,
  queue_order_update: QUEUE,
  new_order: QUEUE,
  cash_link_demand: QUEUE,
  payment_mode_changed: { keys: ['canManageBusinessPolicy', 'canManageMerchants'], queueManager: true },
  // Disputes
  order_disputed: DISPUTES,
  order_red_flagged: DISPUTES,
  // Merchants
  merchant_status_changed: MERCHANTS,
  merchant_limits_updated: MERCHANTS,
  merchant_approved: MERCHANTS,
  merchant_rejected: MERCHANTS,
  merchant_assignment_paused: MERCHANTS,
  merchant_assignment_resumed: MERCHANTS,
  merchant_config_updated: MERCHANTS,
  // Players
  user_flagged: { keys: ['canManageUsers'] },
  kyc_update: { keys: ['canVerifyKYC'] },
  // Cycles and the live book
  admin_cycle_result: CYCLES,
  admin_new_cycle: CYCLES,
  admin_cycle_snapshot: CYCLES,
  phantom_equalized: CYCLES,
  admin_bet_placed: CYCLES,
  admin_stats_update: { keys: ['canViewAnalytics'] },
  admin_stats_delta: { keys: ['canViewAnalytics'] },
});

/** Whether this staff viewer may receive this event. */
export function staffMayReceive(viewer, event) {
  if (!viewer || viewer.isBlocked) return false;
  if (viewer.isAdmin === true) return true;
  const area = STAFF_EVENT_AREAS[event];
  if (!area) return false;
  if (area.queueManager && viewer.isQueueManager === true) return true;
  return area.keys.some((k) => staffCan(viewer, k));
}

/**
 * The socket.io rooms a staff account joins, and the rooms an event goes to.
 * One room per AREA rather than one "admin-room", so an emit reaches exactly
 * the people `staffMayReceive` would allow.
 */
export const staffRoom = (key) => `staff-area:${key}`;
export const QUEUE_ROOM = 'staff-area:queue';
export const FULL_ADMIN_ROOM = 'staff-area:admin';
export const personalStaffRoom = (userId) => `staff:${userId}`;

export function roomsForEvent(event) {
  const area = STAFF_EVENT_AREAS[event];
  const rooms = [FULL_ADMIN_ROOM];
  if (!area) return rooms;
  rooms.push(...area.keys.map(staffRoom));
  if (area.queueManager) rooms.push(QUEUE_ROOM);
  return rooms;
}

export function roomsForViewer(viewer, keys) {
  if (!viewer) return [];
  const rooms = [personalStaffRoom(viewer.userId)];
  if (viewer.isAdmin === true) rooms.push(FULL_ADMIN_ROOM);
  else rooms.push(...keys.filter((k) => staffCan(viewer, k)).map(staffRoom));
  if (viewer.isQueueManager === true) rooms.push(QUEUE_ROOM);
  return rooms;
}

/** Emit an admin event on socket.io to exactly the staff allowed it. */
export function emitToStaff(io, event, data) {
  io?.to(roomsForEvent(event)).emit(event, data);
}
