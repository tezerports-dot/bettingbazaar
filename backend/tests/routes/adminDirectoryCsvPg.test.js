// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every admin directory table downloads as CSV (owner, 2026-10-17: "nowhere
 * can I download the full list of users"), and Admin › Transactions' date
 * pickers filter (they were sent and never read).
 *
 * The REAL routes against a real database: each CSV holds every row the
 * table's filters match, not one page; each asks the same area as its table;
 * and the ledger's dates narrow the rows by IST day.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { fundWallet } from '#db/tests/_funding.js';
import { actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('Admin directory CSV exports', () => {
  let app;
  let admin;
  let player;

  beforeAll(async () => {
    await applySchema();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/admin', (await import('../../routes/admin/users.admin.routes.js')).default);
    app.use('/admin', (await import('../../domains/merchant/merchant.admin.routes.js')).default);
    app.use('/admin', (await import('../../routes/admin/subadmins.admin.routes.js')).default);
    app.use('/admin', (await import('../../routes/admin/system.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
    player = await actor({});
    await fundWallet(player.userId, 321_00, `csv-fund-${player.userId}`);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it('downloads the matching players, with their balance in rupees', async () => {
    const res = await as(app, admin).get('/admin/users.csv').query({ search: player.userId });
    expect(res.status, res.text).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const [head, ...rows] = res.text.split('\n');
    expect(head.startsWith('user_id,username,mobile,status')).toBe(true);
    expect(rows).toHaveLength(1);
    const cols = head.split(',');
    const cells = rows[0].split(',');
    expect(cells[cols.indexOf('user_id')]).toBe(player.userId);
    expect(Number(cells[cols.indexOf('vip_balance')])).toBe(321);
  });

  it('downloads more rows than one page of the table holds', async () => {
    const page = await as(app, admin).get('/admin/users').query({ limit: 1 });
    const csv = await as(app, admin).get('/admin/users.csv');
    expect(csv.text.split('\n').length - 1).toBe(page.body.pagination.total);
  });

  it('downloads the merchants and the staff tables', async () => {
    const merchants = await as(app, admin).get('/admin/merchants.csv');
    expect(merchants.status, merchants.text).toBe(200);
    expect(merchants.headers['content-disposition']).toMatch(/merchants\.csv/);
    const staff = await as(app, admin).get('/admin/staff.csv').query({ search: admin.userId });
    expect(staff.status, staff.text).toBe(200);
    expect(staff.text.split('\n')[1]).toContain(admin.userId);
  });

  it('asks the same area as each table', async () => {
    const analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
    expect((await as(app, analyst).get('/admin/users.csv')).status).toBe(403);
    expect((await as(app, analyst).get('/admin/merchants.csv')).status).toBe(403);
    expect((await as(app, analyst).get('/admin/staff.csv')).status).toBe(403);
    expect((await as(app, analyst).get('/admin/transactions.csv')).status).toBe(403);
  });

  it('filters the transaction ledger by IST day, and downloads it', async () => {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const todays = await as(app, admin).get('/admin/transactions').query({ startDate: today, endDate: today, limit: 200 });
    expect(todays.status, JSON.stringify(todays.body)).toBe(200);
    expect(todays.body.transactions.some((t) => t.userId === player.userId)).toBe(true);
    const longAgo = await as(app, admin).get('/admin/transactions').query({ endDate: '2001-01-01' });
    expect(longAgo.body.transactions).toHaveLength(0);
    const csv = await as(app, admin).get('/admin/transactions.csv').query({ startDate: today });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(player.userId);
    expect((await as(app, admin).get('/admin/transactions').query({ startDate: 'today' })).status).toBe(400);
  });
});
