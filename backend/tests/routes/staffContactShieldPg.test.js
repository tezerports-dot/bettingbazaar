// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A player's contact and payout details reach full admins only (owner,
 * 2026-10-21; CLAUDE.md §24), through the real `/api/admin` router on a real
 * database: a sub-admin holding the players area reads the table, the profile
 * and the download without a mobile, account number, IFSC or UPI ID; a full
 * admin reads all of them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { actor, as } from './_harness.js';
import { getXlsx, onlyTable } from '../_xlsx.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('contact and payout details on the admin panel', () => {
  let app, admin, subAdmin, player, mobile;
  const BANK = {
    accountHolderName: 'Shield Player', accountNumber: '502011223344', ifscCode: 'HDFC0001234',
    bankName: 'HDFC Bank', upiId: 'shield.player@okaxis',
  };

  beforeAll(async () => {
    await applySchema();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', (await import('../../routes/admin/index.js')).default);
    admin = await actor({ isAdmin: true });
    subAdmin = await actor({ isSubAdmin: true, permissions: { canManageUsers: true } });
    player = await actor({});
    await pgQuery('UPDATE users SET bank_details = $2 WHERE user_id = $1', [player.userId, BANK]);
    ({ rows: [{ mobile }] } = await pgQuery('SELECT mobile FROM users WHERE user_id = $1', [player.userId]));
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const secrets = () => [mobile, BANK.accountNumber, BANK.ifscCode, BANK.upiId];

  it('a sub-admin reads the players table and the profile with none of them', async () => {
    for (const path of ['/api/admin/users', `/api/admin/users/${player.userId}`]) {
      const res = await as(app, subAdmin).get(path).query({ search: player.userId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const text = JSON.stringify(res.body);
      for (const s of secrets()) expect(text, `${path} ${s}`).not.toContain(s);
    }
    const profile = await as(app, subAdmin).get(`/api/admin/users/${player.userId}`);
    expect(profile.body.user.username).toBeTruthy();
    expect(profile.body.user.bankDetails).toEqual({ accountHolderName: 'Shield Player', bankName: 'HDFC Bank' });
  });

  it('a sub-admin\'s download has no mobile column', async () => {
    const { res, book } = await getXlsx(as(app, subAdmin).get('/api/admin/users.xlsx').query({ search: player.userId }));
    expect(res.status).toBe(200);
    const t = onlyTable(book);
    expect(t.header).not.toContain('Mobile');
    expect(JSON.stringify(t.rows)).not.toContain(mobile);
  });

  it('only a full admin can find a player by mobile', async () => {
    const sub = await as(app, subAdmin).get('/api/admin/users').query({ search: mobile });
    expect(sub.body.users).toEqual([]);
    const full = await as(app, admin).get('/api/admin/users').query({ search: mobile });
    expect(full.body.users.map((u) => u.userId)).toContain(player.userId);
  });

  it('a full admin reads every one of them', async () => {
    const profile = await as(app, admin).get(`/api/admin/users/${player.userId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.user.mobile).toBe(mobile);
    expect(profile.body.user.bankDetails).toEqual(BANK);
    const { book } = await getXlsx(as(app, admin).get('/api/admin/users.xlsx').query({ search: player.userId }));
    expect(onlyTable(book).header).toContain('Mobile');
  });
});
