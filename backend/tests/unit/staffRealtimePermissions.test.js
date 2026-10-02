// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A permission that stops at the REST API is half a permission (§32 S32).
 *
 * The admin SSE stream and the socket admin room delivered every order,
 * dispute and bet to every staff account that connected, whatever
 * it had been given. These are the realtime halves of the owner's rule (2026-10-01):
 * a sub-admin receives the live events of the areas they hold, and nothing else.
 */
import { describe, it, expect } from 'vitest';
import SSEManager from '../../domains/notification/sseManager.service.js';
import {
  STAFF_EVENT_AREAS, staffMayReceive, roomsForEvent, roomsForViewer, staffRoom,
  FULL_ADMIN_ROOM, QUEUE_ROOM, personalStaffRoom, emitToStaff,
} from '../../domains/notification/staffEventAreas.js';
import { PERMISSION_KEYS } from '../../domains/identity/staffPermissions.js';

function fakeClient() {
  const frames = [];
  let ended = false;
  return {
    write(chunk) { frames.push(chunk); return true; },
    on() {},
    end() { ended = true; },
    get ended() { return ended; },
    events: () => frames.filter((f) => f.startsWith('event:')).map((f) => f.match(/^event: (.+)$/m)[1]),
  };
}

const admin = { userId: 'a1', isAdmin: true };
const merchants = { userId: 's1', isSubAdmin: true, subAdminPermissions: { canManageMerchants: true } };
const contentOnly = { userId: 's2', isSubAdmin: true, subAdminPermissions: { canManageContent: true } };
const disputes = { userId: 's3', isSubAdmin: true, subAdminPermissions: { canResolveDisputes: true } };
const queueManager = { userId: 'q1', isQueueManager: true };

describe('who may receive a live staff event', () => {
  it('names only areas that exist', () => {
    for (const [event, area] of Object.entries(STAFF_EVENT_AREAS)) {
      for (const k of area.keys) expect(PERMISSION_KEYS, `${event} → ${k}`).toContain(k);
    }
  });

  it('a sub-admin gets the events of the areas they hold, and no others', () => {
    expect(staffMayReceive(merchants, 'new_order')).toBe(true);
    expect(staffMayReceive(merchants, 'order_disputed')).toBe(false);
    expect(staffMayReceive(disputes, 'order_disputed')).toBe(true);
    expect(staffMayReceive(contentOnly, 'new_order')).toBe(false);
    expect(staffMayReceive(contentOnly, 'order_disputed')).toBe(false);
  });

  it('a full admin gets everything; a queue manager gets the queue', () => {
    for (const event of Object.keys(STAFF_EVENT_AREAS)) expect(staffMayReceive(admin, event)).toBe(true);
    expect(staffMayReceive(queueManager, 'queue_order_update')).toBe(true);
    expect(staffMayReceive(queueManager, 'order_disputed')).toBe(false);
  });

  it('an event nobody declared reaches full admins only — fails closed', () => {
    expect(staffMayReceive(admin, 'something_new')).toBe(true);
    expect(staffMayReceive({ ...merchants, subAdminPermissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) }, 'something_new')).toBe(false);
  });

  it('a blocked account gets nothing, admin or not', () => {
    expect(staffMayReceive({ ...admin, isBlocked: true }, 'new_order')).toBe(false);
  });
});

describe('the admin SSE stream', () => {
  it('delivers each event only to the staff allowed it', () => {
    const sse = new SSEManager();
    try {
      const [a, m, c] = [fakeClient(), fakeClient(), fakeClient()];
      sse.addAdminClient(a, admin);
      sse.addAdminClient(m, merchants);
      sse.addAdminClient(c, contentOnly);
      sse.broadcastToAdmins('new_order', { orderId: 'o1' });
      sse.broadcastToAdmins('order_disputed', { orderId: 'o2' });
      expect(a.events()).toEqual(['new_order', 'order_disputed']);
      expect(m.events()).toEqual(['new_order']);
      expect(c.events()).toEqual([]);
    } finally { sse.destroy(); }
  });

  it('refuses a stream with no viewer rather than guessing what to send it', () => {
    const sse = new SSEManager();
    try {
      expect(() => sse.addAdminClient(fakeClient())).toThrow(/viewer is required/);
    } finally { sse.destroy(); }
  });

  it('closes a staff member\'s streams when their permissions change, and only theirs', () => {
    const sse = new SSEManager();
    try {
      const [m, other] = [fakeClient(), fakeClient()];
      sse.addAdminClient(m, merchants);
      sse.addAdminClient(other, { ...merchants, userId: 's9' });
      sse.closeAdminClientsFor('s1');
      expect(m.ended).toBe(true);
      sse.broadcastToAdmins('new_order', { orderId: 'o3' });
      expect(m.events()).toEqual([]);
      expect(other.events()).toEqual(['new_order']);
    } finally { sse.destroy(); }
  });
});

describe('the socket admin room', () => {
  it('a staff socket joins one room per area it holds, plus its own', () => {
    expect(roomsForViewer(merchants, PERMISSION_KEYS)).toEqual([personalStaffRoom('s1'), staffRoom('canManageMerchants')]);
    expect(roomsForViewer(admin, PERMISSION_KEYS)).toEqual([personalStaffRoom('a1'), FULL_ADMIN_ROOM]);
    expect(roomsForViewer(queueManager, PERMISSION_KEYS)).toEqual([personalStaffRoom('q1'), QUEUE_ROOM]);
  });

  it('an event is emitted to the rooms of its areas, and full admins', () => {
    expect(roomsForEvent('order_disputed')).toEqual([FULL_ADMIN_ROOM, staffRoom('canResolveDisputes')]);
    expect(roomsForEvent('undeclared_event')).toEqual([FULL_ADMIN_ROOM]);
    const sent = [];
    const io = { to: (rooms) => ({ emit: (event, data) => sent.push({ rooms, event, data }) }) };
    emitToStaff(io, 'admin_bet_placed', { x: 1 });
    expect(sent[0].rooms).toEqual([FULL_ADMIN_ROOM, staffRoom('canViewAnalytics'), staffRoom('canManageCycles')]);
  });

  it('the rooms a viewer joins and the rooms an event reaches agree with staffMayReceive', () => {
    for (const viewer of [admin, merchants, contentOnly, disputes, queueManager]) {
      const joined = new Set(roomsForViewer(viewer, PERMISSION_KEYS));
      for (const event of [...Object.keys(STAFF_EVENT_AREAS), 'undeclared_event']) {
        const reaches = roomsForEvent(event).some((r) => joined.has(r));
        expect(reaches, `${viewer.userId} / ${event}`).toBe(staffMayReceive(viewer, event));
      }
    }
  });
});
