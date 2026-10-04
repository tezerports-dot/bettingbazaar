// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The pure halves of team oversight (PROJECT_STATUS §3.10, Step 2f): the
 * low-activity rule, what a member is shown of the team, and hiding mobile
 * numbers from a supervisor. The database halves are teamOversightPg.
 */
import { describe, it, expect } from 'vitest';
import { lowActivityFlags, redFlagSettings } from '#db/repositories/teamOversight.js';
import { hideMobiles, teamPerformanceFor } from '../../domains/team/teamOversight.service.js';

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
    expect(redFlagSettings({})).toEqual({ lowActivityPercent: 25, farmingMinRounds: 3, farmingHedgePercent: 80 });
    expect(redFlagSettings({ redFlags: { lowActivityPercent: 40 } }).lowActivityPercent).toBe(40);
  });
});

describe('what a member sees of the team', () => {
  it('the totals, the average and their own row, never a teammate\'s', () => {
    const out = teamPerformanceFor({
      days: 7, from: 'x',
      members: [member('me', 2, 120.4, 100_000_00), member('other', 4, 600, 200_000_00)],
    }, 'me');
    expect(out).toEqual({
      days: 7, from: 'x', members: 2,
      team: { completedOrders: 6, completedTokens: 300_000, averageOrders: 3, averageOnlineSeconds: 360 },
      me: { completedOrders: 2, completedTokens: 100_000, onlineSeconds: 120 },
    });
    expect(JSON.stringify(out)).not.toContain('other');
  });
});

describe('a supervisor is shown no mobile number', () => {
  it('hides every spelling of an Indian mobile and keeps the words around it', () => {
    expect(hideMobiles('call 9876543210 now')).toBe('call [number hidden] now');
    expect(hideMobiles('call +91 98765-43210.')).toBe('call [number hidden].');
    expect(hideMobiles('0091 9876543210')).toBe('[number hidden]');
    expect(hideMobiles('09876543210, then 8123456789')).toBe('[number hidden], then [number hidden]');
  });

  it('leaves what is not a mobile alone: a UTR, an amount, a short number', () => {
    expect(hideMobiles('UTR 412345678901 for 50,000')).toBe('UTR 412345678901 for 50,000');
    expect(hideMobiles('order 5123456789')).toBe('order 5123456789');
    expect(hideMobiles(null)).toBeNull();
  });
});
