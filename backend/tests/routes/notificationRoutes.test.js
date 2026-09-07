// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A player can read the notifications the platform was already writing them.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The write side worked and had no read side. `notify()` persists a row on real
 * events — an admin blocking or unblocking an account is the live one — and the
 * IN_APP channel's own comment called it "the existing bell-icon inbox all
 * three panels already read". No panel read it, and no route existed to read it
 * through.
 *
 * So the worst case was not a missing feature: a player was blocked, the system
 * recorded the explanation intended for them, and they found themselves locked
 * out with no way to see it.
 *
 * ── What is actually being protected ────────────────────────────────────────
 * A notification is addressed to one person and can carry why their account was
 * blocked. The isolation cases below are the point of this file; listing your
 * own is the easy part.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { notify, listNotifications } from '#db/repositories/engagement.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('player notification inbox', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/user/user.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const player = () => actor({});
  const send = (who, over = {}) => notify({
    userId: who.userId, kind: 'INFO', title: 'Account Blocked',
    message: 'Contact support.', ...over,
  });

  it('refuses every notification route without a token', async () => {
    expect((await request(app).get('/user/notifications')).status).toBe(401);
    expect((await request(app).get('/user/notifications/unread-count')).status).toBe(401);
    expect((await request(app).post('/user/notifications/read').send({})).status).toBe(401);
  });

  it('lists what was written for that player, newest first', async () => {
    const alice = await player();
    await send(alice, { title: 'first' });
    await send(alice, { title: 'second' });

    const res = await as(app, alice).get('/user/notifications');
    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n) => n.title)).toEqual(['second', 'first']);
    expect(res.body.unreadCount).toBe(2);
  });

  it('carries the message, not just the title', async () => {
    // The whole point is that a blocked player can read WHY. A list of titles
    // would satisfy a weaker test and tell them nothing.
    const alice = await player();
    await send(alice, { title: 'Account Blocked', message: 'Suspicious deposit pattern.' });
    const [n] = (await as(app, alice).get('/user/notifications')).body.notifications;
    expect(n.message).toBe('Suspicious deposit pattern.');
    expect(n.type).toBe('INFO');
    expect(n.isRead).toBe(false);
  });

  it("never shows one player another player's notifications", async () => {
    const alice = await player();
    const bob = await player();
    await send(alice, { title: 'for alice' });

    const res = await as(app, bob).get('/user/notifications');
    expect(res.body.notifications).toHaveLength(0);
    expect(res.body.unreadCount).toBe(0);
  });

  it('marks everything read when no ids are given', async () => {
    const alice = await player();
    await send(alice, { title: 'a' });
    await send(alice, { title: 'b' });

    const res = await as(app, alice).post('/user/notifications/read').send({});
    expect(res.body.marked).toBe(2);
    expect((await as(app, alice).get('/user/notifications/unread-count')).body.unreadCount).toBe(0);
  });

  it('marks only the ids it was given', async () => {
    const alice = await player();
    const keep = await send(alice, { title: 'unread' });
    const hit = await send(alice, { title: 'read me' });

    const res = await as(app, alice).post('/user/notifications/read').send({ ids: [hit.id] });
    expect(res.body.marked).toBe(1);

    const listed = await as(app, alice).get('/user/notifications');
    const rows = listed.body.notifications;
    expect(rows.find((n) => n.id === hit.id).isRead).toBe(true);
    expect(rows.find((n) => n.id === keep.id).isRead).toBe(false);

    // The badge counts UNREAD, not what the list happens to contain. Two rows
    // are listed and one is unread, so a handler returning `notifications.length`
    // cannot satisfy both of these.
    expect(rows).toHaveLength(2);
    expect(listed.body.unreadCount).toBe(1);
  });

  it("cannot mark another player's notification read", async () => {
    // Ownership is in the WHERE clause, so naming a real id belonging to
    // somebody else changes nothing and reports 0 rather than succeeding.
    const alice = await player();
    const mallory = await player();
    const hers = await send(alice, { title: 'hers' });

    const res = await as(app, mallory).post('/user/notifications/read').send({ ids: [hers.id] });
    expect(res.body.marked).toBe(0);
    expect((await listNotifications(alice.userId))[0].isRead).toBe(false);
  });

  it('filters to unread on request', async () => {
    const alice = await player();
    const read = await send(alice, { title: 'already read' });
    await send(alice, { title: 'still unread' });
    await as(app, alice).post('/user/notifications/read').send({ ids: [read.id] });

    const res = await as(app, alice).get('/user/notifications?unreadOnly=true');
    expect(res.body.notifications.map((n) => n.title)).toEqual(['still unread']);
    // The badge still counts only unread, whatever the list was filtered to.
    expect(res.body.unreadCount).toBe(1);
  });

  it('hides an expired notification from the list and the count', async () => {
    const alice = await player();
    await send(alice, { title: 'gone', expiresAt: new Date(Date.now() - 1000) });
    await send(alice, { title: 'live' });

    const res = await as(app, alice).get('/user/notifications');
    expect(res.body.notifications.map((n) => n.title)).toEqual(['live']);
    expect(res.body.unreadCount).toBe(1);
  });

  it('refuses a malformed ids field instead of marking everything', async () => {
    // `{ids: 'all'}` marking the whole inbox read would silently acknowledge
    // notices the player never saw.
    const alice = await player();
    await send(alice, { title: 'keep me unread' });

    const bad = await as(app, alice).post('/user/notifications/read').send({ ids: 'all' });
    expect(bad.status).toBe(400);

    // An array with nothing usable in it is not "mark everything" either.
    const empty = await as(app, alice).post('/user/notifications/read').send({ ids: ['x', -1] });
    expect(empty.body.marked).toBe(0);

    expect((await as(app, alice).get('/user/notifications/unread-count')).body.unreadCount).toBe(1);
  });

  it('bounds the page size a caller can ask for', async () => {
    const alice = await player();
    await send(alice, { title: 'one' });
    const res = await as(app, alice).get('/user/notifications?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.notifications.length).toBeLessThanOrEqual(200);
  });
});
