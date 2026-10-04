// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The pure halves of team oversight (PROJECT_STATUS §3.10, Step 2f): the
 * low-activity rule, what a member is shown of the team, and what a
 * supervisor is not shown of the player. The database halves are
 * teamOversightPg; every spelling of a mobile is mobileInText.
 */
import { describe, it, expect } from 'vitest';
import { lowActivityFlags, redFlagSettings } from '#db/repositories/teamOversight.js';
import { hideForSupervisor, supervisorMaySee, teamPerformanceFor } from '../../domains/team/teamOversight.service.js';

const member = (merchantId, completedOrders, onlineSeconds, completedPaise = 0) => ({
  merchantId, completedOrders, onlineSeconds, completedPaise, name: merchantId, publicRef: merchantId, isOnline: false,
});

describe('the low-activity rule', () => {
  // Average 10 orders and 1,000 s; at 25% the cuts are 7.5 and 750.
  const team = [member('m1', 10, 1000), member('m2', 12, 1200), member('m3', 8, 800)];

  it('flags a member below the cut in BOTH orders and online time', () => {
    const rows = [...team, member('low', 7, 700)];
    // Averages now 9.25 and 925; cuts 6.9375 and 693.75 — 7 / 700 is above both.
    expect(lowActivityFlags(rows, 25)).toEqual([]);
    const flagged = lowActivityFlags([...team, member('low', 1, 100)], 25);
    expect(flagged.map((f) => f.merchantId)).toEqual(['low']);
    expect(flagged[0].details).toMatchObject({ completedOrders: 1, onlineSeconds: 100, members: 4, percent: 25 });
  });

  it('does not flag a member below in only one of the two', () => {
    expect(lowActivityFlags([...team, member('idle-online', 0, 5000)], 25)).toEqual([]);
    expect(lowActivityFlags([...team, member('busy-offline', 30, 0)], 25)).toEqual([]);
  });

  it('a member exactly on the cut is not below it', () => {
    // Average 8 orders, 800 s; at 25% the cuts are exactly 6 and 600.
    const rows = [member('a', 6, 600), member('b', 9, 900), member('c', 9, 900)];
    expect(lowActivityFlags(rows, 25)).toEqual([]);
  });

  it('the threshold is the admin\'s: a stricter one flags fewer', () => {
    const rows = [...team, member('low', 6, 600)];
    expect(lowActivityFlags(rows, 25).map((f) => f.merchantId)).toEqual(['low']);
    expect(lowActivityFlags(rows, 50)).toEqual([]);
  });

  it('flags nobody in a team that did nothing, or of one member', () => {
    expect(lowActivityFlags([member('a', 0, 0), member('b', 0, 0)], 25)).toEqual([]);
    expect(lowActivityFlags([member('alone', 0, 0)], 25)).toEqual([]);
  });

  it('reads the schema defaults for anything not stored', () => {
    expect(redFlagSettings({})).toEqual({ lowActivityPercent: 25 });
    expect(redFlagSettings({ redFlags: { lowActivityPercent: 40 } }).lowActivityPercent).toBe(40);
  });
});

describe('what a member sees of the team', () => {
  it('the totals, the average and their own row, never a teammate\'s', () => {
    const out = teamPerformanceFor({
      days: 7, from: 'x',
      members: [member('me', 2, 120.4, 100_000_00), member('other', 4, 600, 200_000_00), member('third', 0, 360, 0)],
    }, 'me');
    expect(out).toEqual({
      days: 7, from: 'x', members: 3,
      team: { completedOrders: 6, completedTokens: 300_000, averageOrders: 2, averageOnlineSeconds: 360 },
      me: { completedOrders: 2, completedTokens: 100_000, onlineSeconds: 120 },
    });
    expect(JSON.stringify(out)).not.toContain('other');
  });

  it('no team figures in a team of two, where the total less your own is your teammate\'s', () => {
    const out = teamPerformanceFor({ days: 7, from: 'x', members: [member('me', 2, 100), member('other', 4, 600)] }, 'me');
    expect(out.team).toBeNull();
    expect(out.me).toEqual({ completedOrders: 2, completedTokens: 0, onlineSeconds: 100 });
  });
});

describe('a supervisor is shown nothing of the player', () => {
  it('hides mobiles, UPI handles and long numbers, and keeps the words around them', () => {
    expect(hideForSupervisor('call +91 98765-43210 now')).toBe('call [number hidden] now');
    expect(hideForSupervisor('paid from rahul.k@okaxis.')).toBe('paid from [handle hidden].');
    expect(hideForSupervisor('UTR 412345678901, a/c 5010 0123 4567 89')).toBe('UTR [number hidden], a/c [number hidden]');
  });

  it('leaves amounts, times and short numbers readable', () => {
    expect(hideForSupervisor('₹1,00,000 at 14:02, order 50000')).toBe('₹1,00,000 at 14:02, order 50000');
    expect(hideForSupervisor(null)).toBeNull();
  });

  it('reads their own messages, their member\'s and the dispute manager\'s; never the player\'s or a system notice', () => {
    const m = (senderType, isSystem = false) => supervisorMaySee({ senderType, isSystem });
    expect([m('SUPERVISOR'), m('MERCHANT'), m('ADMIN')]).toEqual([true, true, true]);
    expect([m('USER'), m('SYSTEM', true), m('ADMIN', true), m('MERCHANT', true)]).toEqual([false, false, false, false]);
  });
});
