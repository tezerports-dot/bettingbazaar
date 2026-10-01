// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The IP deny-list, end to end: an admin blocks a range through the real route,
 * and a request from inside it is refused on a real route while a request from
 * outside it is served.
 *
 * The previous deny-list had a table, a repository and a passing test of its
 * REPOSITORY — and was mounted nowhere (F-030). A test of the rows proves the
 * rows; this file mounts the real middleware in front of a route and asks the
 * question a player's request asks.
 *
 * Addresses come from X-Forwarded-For with `trust proxy` on, which is how
 * `req.ip` is set behind the production balancer. All of them are documentation
 * ranges (RFC 5737), so nothing here can collide with a real client.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { actor, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const ADMIN_IP = '198.51.100.10';
const BYSTANDER = '198.51.100.77';

describePg('the IP deny-list', () => {
  let app;
  let admin;
  let player;
  let refresh;
  const made = [];

  const from = (ip) => ({ get: (url) => request(app).get(url).set('X-Forwarded-For', ip) });
  const asAdmin = (ip = ADMIN_IP) => ({
    get: (url) => request(app).get(url).set('X-Forwarded-For', ip).set('Authorization', admin.auth),
    post: (url) => request(app).post(url).set('X-Forwarded-For', ip).set('Authorization', admin.auth),
  });
  const block = async (body) => {
    const res = await asAdmin().post('/security/ip-blocks').send(body);
    if (res.body?.block?.blockId) made.push(res.body.block.blockId);
    return res;
  };

  beforeAll(async () => {
    await applySchema();
    const mw = await import('../../middleware/ipBlocklist.js');
    refresh = mw.refreshIpBlocklistNow;
    await refresh();
    const router = (await import('../../routes/admin/ipBlocks.admin.routes.js')).default;
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use(mw.ipBlocklist);
    app.get('/probe', (_req, res) => res.json({ ok: true }));
    app.use(router);
    admin = await actor({ isAdmin: true });
    player = await actor({});
  }, 60_000);

  afterAll(async () => {
    // Every block this run made is lifted, outside any assertion (trap 10): a
    // server started against this database loads live blocks at boot.
    if (made.length) {
      await pgQuery(
        `UPDATE ip_blocks SET released_at = now(), released_by = 'test-teardown'
          WHERE block_id = ANY($1) AND released_at IS NULL`, [made]).catch(() => {});
    }
    await closePg();
  });

  it('is admin-only', async () => {
    expect((await from(ADMIN_IP).get('/security/ip-blocks')).status).toBe(401);
    const res = await request(app).get('/security/ip-blocks').set('Authorization', player.auth);
    expect(res.status).toBe(403);
  });

  it('refuses a request from inside a blocked range, and serves one from outside it', async () => {
    const res = await block({ network: '203.0.113.0/24', reason: 'Credential stuffing from this range' });
    expect(res.status, res.body?.message).toBe(201);
    expect(res.body.block.network).toBe('203.0.113.0/24');

    const blocked = await from('203.0.113.9').get('/probe');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('IP_BLOCKED');
    // The IPv4-mapped form `req.ip` takes without a proxy is the same address.
    expect((await from('::ffff:203.0.113.9').get('/probe')).status).toBe(403);
    // A bystander is served.
    expect((await from(BYSTANDER).get('/probe')).status).toBe(200);
  });

  it('writes an audit row for the block', async () => {
    const id = made[0];
    const { rows } = await pgQuery(
      `SELECT count(*)::int AS n FROM enhanced_audit_logs WHERE action = 'IP_BLOCKED' AND target_id = $1`, [id]);
    expect(rows[0].n).toBe(1);
  });

  it('lifts a block, and keeps the row', async () => {
    const id = made[0];
    const res = await asAdmin().post(`/security/ip-blocks/${id}/release`).send({});
    expect(res.status).toBe(200);
    expect(res.body.block.releasedAt).toBeTruthy();
    expect((await from('203.0.113.9').get('/probe')).status).toBe(200);
    const { rows } = await pgQuery('SELECT released_by FROM ip_blocks WHERE block_id = $1', [id]);
    expect(rows[0].released_by).toBe(admin.userId);
  });

  it('blocks a single address as a /32, and nothing beside it', async () => {
    const res = await block({ network: '203.0.113.50', reason: 'One abusive client' });
    expect(res.status).toBe(201);
    expect(res.body.block.network).toBe('203.0.113.50/32');
    expect((await from('203.0.113.50').get('/probe')).status).toBe(403);
    expect((await from('203.0.113.51').get('/probe')).status).toBe(200);
  });

  it('accepts a narrow IPv4 range written in IPv6-mapped form, and enforces it on IPv4 clients', async () => {
    // ::ffff:198.18.5.0/120 is IPv4 198.18.5.0/24 — inside the floor, so allowed.
    const res = await block({ network: '::ffff:198.18.5.0/120', reason: 'Mapped spelling of a /24' });
    expect(res.status, res.body?.message).toBe(201);
    expect((await from('198.18.5.9').get('/probe')).status).toBe(403);
    expect((await from('198.18.6.9').get('/probe')).status).toBe(200);
  });

  it('stores a range with its host bits cleared, so one range has one spelling', async () => {
    const res = await block({ network: '203.0.113.77/28', reason: 'Normalised range' });
    expect(res.status).toBe(201);
    expect(res.body.block.network).toBe('203.0.113.64/28');
  });

  it('re-blocking an open range refreshes it rather than stacking a second row', async () => {
    const first = await block({ network: '203.0.113.128/25', reason: 'first reason' });
    const second = await block({ network: '203.0.113.128/25', reason: 'corrected reason' });
    expect(second.body.block.blockId).toBe(first.body.block.blockId);
    const { rows } = await pgQuery(
      `SELECT count(*)::int AS n FROM ip_blocks WHERE network = '203.0.113.128/25' AND released_at IS NULL`, []);
    expect(rows[0].n).toBe(1);
    expect(second.body.block.reason).toBe('corrected reason');
  });

  // ── Whose clock decides an expiry (verification of PR #198, §7) ─────────
  // The route computed `expires_at` from the APP's clock while the CHECK that
  // it lies after `blocked_at` ran on the DATABASE's. With the app two minutes
  // behind, a one-minute block was "in the past" to the database: 500. Two
  // clocks on one question is the shape the Android publish fix removed too.
  it('takes a short block when the app clock runs behind the database, and dates it by the database', async () => {
    const realNow = Date.now();
    const behind = vi.spyOn(Date, 'now').mockReturnValue(realNow - 2 * 60_000);
    let res;
    try {
      res = await block({ network: '192.0.2.64/26', reason: 'Clock skew', expiresInMinutes: 1 });
    } finally {
      behind.mockRestore();
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { rows: [row] } = await pgQuery(
      `SELECT EXTRACT(EPOCH FROM (expires_at - blocked_at))::int AS secs FROM ip_blocks WHERE block_id = $1`,
      [res.body.block.blockId]);
    expect(row.secs).toBe(60);
    await pgQuery(`UPDATE ip_blocks SET released_at = now(), released_by = 'test' WHERE block_id = $1`, [res.body.block.blockId]);
  });

  it('a re-block refreshes the expiry from the database clock too (the retry neighbour)', async () => {
    const first = await block({ network: '192.0.2.192/26', reason: 'first', expiresInMinutes: 5 });
    expect(first.status).toBe(201);
    const behind = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10 * 60_000);
    let again;
    try {
      again = await block({ network: '192.0.2.192/26', reason: 'refreshed', expiresInMinutes: 1 });
    } finally {
      behind.mockRestore();
    }
    expect([200, 201]).toContain(again.status);
    const { rows: [row] } = await pgQuery(
      `SELECT EXTRACT(EPOCH FROM (expires_at - blocked_at))::int AS secs FROM ip_blocks WHERE block_id = $1`,
      [first.body.block.blockId]);
    expect(row.secs).toBe(60);
    await pgQuery(`UPDATE ip_blocks SET released_at = now(), released_by = 'test' WHERE block_id = $1`, [first.body.block.blockId]);
  });

  it('lets a temporary block lapse on its own, with no sweep', async () => {
    const res = await block({ network: '192.0.2.0/24', reason: 'Temporary', expiresInMinutes: 5 });
    expect(res.status).toBe(201);
    expect((await from('192.0.2.1').get('/probe')).status).toBe(403);
    await pgQuery(
      `UPDATE ip_blocks SET blocked_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute'
        WHERE block_id = $1`, [res.body.block.blockId]);
    await refresh();
    expect((await from('192.0.2.1').get('/probe')).status).toBe(200);
  });

  it.each([
    ['a range wider than /16', { network: '10.0.0.0/8', reason: 'x' }, /too broad/],
    // The same /8, respelled as IPv6. It cleared the /48 IPv6 floor and Node's
    // matcher applies it to plain IPv4 clients (2026-10-01).
    ['an IPv4 /8 written in IPv6-mapped form', { network: '::ffff:10.0.0.0/104', reason: 'x' }, /covers an IPv4 \/8/],
    ['an IPv6 range that contains all of IPv4', { network: '::ffff:1.2.3.4/80', reason: 'x' }, /too broad/],
    ['loopback', { network: '127.0.0.1', reason: 'x' }, /Loopback/],
    ['the admin\'s own address', { network: '198.51.100.0/24', reason: 'x' }, /lock you out/],
    ['something that is not an address', { network: 'evil.example.com', reason: 'x' }, /not an IP address/],
    ['a block with no reason', { network: '203.0.113.200', reason: '   ' }, /reason is required/],
    ['a nonsense expiry', { network: '203.0.113.201', reason: 'x', expiresInMinutes: -3 }, /whole number of minutes/],
  ])('refuses %s with a 400 that names the problem', async (_label, body, message) => {
    const res = await block(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  it('lists live blocks, and the history on request', async () => {
    const live = await asAdmin().get('/security/ip-blocks');
    expect(live.status).toBe(200);
    expect(live.body.enforcer.enforcing).toBe(true);
    expect(live.body.blocks.every((b) => b.live)).toBe(true);
    const all = await asAdmin().get('/security/ip-blocks?includeReleased=1');
    expect(all.body.blocks.some((b) => b.blockId === made[0] && b.releasedAt)).toBe(true);
  });
});
