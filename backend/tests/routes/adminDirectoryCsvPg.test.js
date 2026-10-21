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
import { getXlsx, onlyTable } from '../_xlsx.js';

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
    const { res, book } = await getXlsx(as(app, admin).get('/admin/users.xlsx').query({ search: player.userId }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    const t = onlyTable(book);
    expect(t.header.slice(0, 4)).toEqual(['User id', 'Username', 'Mobile', 'Status']);
    expect(t.rows).toHaveLength(1);
    expect(t.cell(t.rows[0], 'User id')).toBe(player.userId);
    expect(t.cell(t.rows[0], 'Vip balance')).toBe(321);
  });

  it('downloads more rows than one page of the table holds', async () => {
    const page = await as(app, admin).get('/admin/users').query({ limit: 1 });
    const { book } = await getXlsx(as(app, admin).get('/admin/users.xlsx'));
    expect(onlyTable(book).rows).toHaveLength(page.body.pagination.total);
  });

  it('downloads the merchants and the staff tables', async () => {
    const merchants = await getXlsx(as(app, admin).get('/admin/merchants.xlsx'));
    expect(merchants.res.status).toBe(200);
    expect(merchants.res.headers['content-disposition']).toMatch(/merchants\.xlsx/);
    const staff = await getXlsx(as(app, admin).get('/admin/staff.xlsx').query({ search: admin.userId }));
    expect(staff.res.status).toBe(200);
    expect(onlyTable(staff.book).rows[0]).toContain(admin.userId);
  });

  it('asks the same area as each table', async () => {
    const analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
    expect((await as(app, analyst).get('/admin/users.xlsx')).status).toBe(403);
    expect((await as(app, analyst).get('/admin/merchants.xlsx')).status).toBe(403);
    expect((await as(app, analyst).get('/admin/staff.xlsx')).status).toBe(403);
    expect((await as(app, analyst).get('/admin/transactions.xlsx')).status).toBe(403);
  });

  it('filters the transaction ledger by IST day, and downloads it', async () => {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const todays = await as(app, admin).get('/admin/transactions').query({ startDate: today, endDate: today, limit: 200 });
    expect(todays.status, JSON.stringify(todays.body)).toBe(200);
    expect(todays.body.transactions.some((t) => t.userId === player.userId)).toBe(true);
    const longAgo = await as(app, admin).get('/admin/transactions').query({ endDate: '2001-01-01' });
    expect(longAgo.body.transactions).toHaveLength(0);
    const { res, book } = await getXlsx(as(app, admin).get('/admin/transactions.xlsx').query({ startDate: today }));
    expect(res.status).toBe(200);
    expect(onlyTable(book).rows.some((r) => r.includes(player.userId))).toBe(true);
    expect((await as(app, admin).get('/admin/transactions').query({ startDate: 'today' })).status).toBe(400);
  });
});
