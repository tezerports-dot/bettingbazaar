// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Cycle History is filtered by the server, and its totals describe
 * every matching cycle (owner, 2026-10-17).
 *
 * The screen's search box and date pickers were never sent, so they changed
 * nothing, and its totals cards added up only the page on screen. These cases
 * drive the REAL admin route against a real database: each filter narrows the
 * rows, the totals stay those of every match when the page is smaller, and the
 * CSV carries the same rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { ensureCycle, declareWinner, markSettled } from '#db/repositories/markets.js';
import { actor, as } from './_harness.js';
import { getXlsx, onlyTable } from '../_xlsx.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = `ach${Math.random().toString(36).slice(2, 8)}`;
// Far-future IST days, so no other suite's cycles fall in them.
const DAY1 = Date.UTC(2102, 2, 10, 6, 0);   // 2102-03-10 11:30 IST
const DAY2 = Date.UTC(2102, 2, 11, 6, 0);   // 2102-03-11 11:30 IST
const ids = [];

async function resolved(type, audience, at, winner, netProfitRupees) {
  const cycleId = `${RUN}-${ids.length + 1}`;
  ids.push(cycleId);
  const start = new Date(at + ids.length * 60_000);
  await ensureCycle({ cycleId, cycleType: type, audience, startTime: start, endTime: new Date(start.getTime() + 60_000) });
  await declareWinner(cycleId, winner);
  await markSettled(cycleId, { paidOutRupees: 10, netProfitRupees, platformFeesRupees: 0, feePercentUsed: 0 });
  return cycleId;
}

describePg('Admin › Cycle History filters and totals', () => {
  let app;
  let admin;

  beforeAll(async () => {
    await applySchema();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/admin', (await import('../../routes/admin/cycles.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
    await resolved('30_MIN', 'VIP', DAY1, 'DELHI', 5);
    await resolved('30_MIN', 'GENERAL', DAY1, 'BOMBAY', 7);
    await resolved('1_MIN', 'VIP', DAY1, 'DELHI', 11);
    await resolved('1_MIN', 'GENERAL', DAY2, 'BOMBAY', 13);
  }, 60_000);

  afterAll(async () => {
    await pgQuery('DELETE FROM cycles WHERE cycle_id = ANY($1::text[])', [ids]).catch(() => {});
    await closePg();
  });

  const history = (q) => as(app, admin).get('/admin/cycles/history').query(q);

  it('searches by cycle id, and totals every match while the page holds fewer', async () => {
    const res = await history({ search: RUN, limit: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cycles).toHaveLength(2);
    expect(res.body.pagination.total).toBe(4);
    const net = res.body.totals.reduce((n, t) => n + t.netProfit, 0);
    expect(net).toBe(5 + 7 + 11 + 13);
    const oneMin = res.body.totals.filter((t) => t.type === '1_MIN').reduce((n, t) => n + t.cycles, 0);
    expect(oneMin).toBe(2);
  });

  it('a search that matches nothing returns nothing (and is not read as a pattern)', async () => {
    const res = await history({ search: `${RUN}%` });
    expect(res.status).toBe(200);
    expect(res.body.cycles).toHaveLength(0);
    expect(res.body.totals).toEqual([]);
  });

  it('filters by profile and by board', async () => {
    const vip = await history({ search: RUN, audience: 'VIP' });
    expect(vip.body.cycles.map((c) => c.audience)).toEqual(['VIP', 'VIP']);
    const board = await history({ search: RUN, type: '30_MIN' });
    expect(board.body.cycles.every((c) => c.type === '30_MIN')).toBe(true);
    expect(board.body.pagination.total).toBe(2);
  });

  it('filters by the IST day the round ended on, both ends inclusive', async () => {
    const day1 = await history({ search: RUN, from: '2102-03-10', to: '2102-03-10' });
    expect(day1.body.pagination.total).toBe(3);
    const day2 = await history({ search: RUN, from: '2102-03-11' });
    expect(day2.body.pagination.total).toBe(1);
    expect(day2.body.cycles[0].netProfit).toBe(13);
  });

  it('refuses a date that is not YYYY-MM-DD, and an unknown profile, with a 400', async () => {
    expect((await history({ from: '10/03/2102' })).status).toBe(400);
    expect((await history({ audience: 'NOBODY' })).status).toBe(400);
  });

  it('a page past the end still carries the totals', async () => {
    const res = await history({ search: RUN, page: 9, limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.cycles).toHaveLength(0);
    expect(res.body.pagination.total).toBe(4);
  });

  it('downloads the same filtered rows as a workbook', async () => {
    const { res, book } = await getXlsx(as(app, admin).get('/admin/cycles/history.xlsx').query({ search: RUN, audience: 'GENERAL' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    const t = onlyTable(book);
    expect(t.header.slice(0, 4)).toEqual(['Cycle id', 'Board', 'Profile', 'Status']);
    expect(t.rows).toHaveLength(2);
    expect(t.rows.every((r) => t.cell(r, 'Profile') === 'GENERAL')).toBe(true);
  });

  it('is refused to a staff account without analytics', async () => {
    const staff = await actor({ isAdmin: false, isSubAdmin: true, permissions: {} });
    const res = await as(app, staff).get('/admin/cycles/history.xlsx');
    expect([401, 403]).toContain(res.status);
  });
});
