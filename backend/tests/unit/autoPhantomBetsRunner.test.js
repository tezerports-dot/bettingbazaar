// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The cycle generator's auto phantom-bet step (owner, 2026-10-15): a plan for
 * the cycle's board offers this tick's seconds with the list's sizes in order,
 * other boards' plans are left alone, the public update carries the total
 * only, and the split goes to admins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const place = vi.fn();
const recordBet = vi.fn();
const emitToStaff = vi.fn();

vi.mock('#db', () => ({
  db: { markets: { placeAutoPhantomBets: (...a) => place(...a), realPools: async () => ({ realDelhi: 70, realBombay: 30 }) } },
}));
vi.mock('#db/repositories/markets.js', () => ({ AUDIENCES: ['VIP', 'GENERAL'] }));
vi.mock('../../domains/markets/cycleSnapshotPublisher.js', () => ({ cycleSnapshotPublisher: { recordBet: (...a) => recordBet(...a) } }));
vi.mock('../../domains/notification/staffEventAreas.js', () => ({ emitToStaff: (...a) => emitToStaff(...a) }));
vi.mock('../../domains/notification/realtimeEmitters.js', () => ({ emitCyclePhase: vi.fn(), emitCycleResult: vi.fn() }));
vi.mock('../../domains/markets/roundResult.service.js', () => ({ announceRoundResults: vi.fn() }));
vi.mock('../../domains/markets/cycleTypes.js', () => ({
  allBoards: vi.fn(), enabledBoards: vi.fn(), boardOf: vi.fn(), cycleLabel: vi.fn(), boardMessages: vi.fn(),
}));
vi.mock('../../services/metrics.service.js', () => ({ recordRealtimeEvent: vi.fn() }));
vi.mock('../../domains/markets/rtpHouseBet.js', () => ({ planHouseBet: vi.fn() }));
vi.mock('../../domains/risk/riskValidation.service.js', () => ({ getRiskRules: vi.fn() }));
vi.mock('../../services/alerting.service.js', () => ({ sendAlert: vi.fn(async () => {}) }));
vi.mock('../../domains/markets/playerBet.service.js', () => ({ placePlayerBet: vi.fn(), announcePlacedBet: vi.fn() }));
vi.mock('#db/repositories/config.js', () => ({ getSystemConfig: vi.fn(async () => ({})) }));
vi.mock('../../domains/communication/communication.service.js', () => ({ notify: vi.fn(async () => []) }));

const { default: CycleGenerator } = await import('../../domains/markets/cycleGenerator.service.js');

const START = Date.UTC(2026, 9, 15, 10, 0, 0);
const cycle = { cycleId: 'C1', type: 'b1', audience: 'VIP', status: 'OPEN', startTime: new Date(START), phantomDelhi: 0, phantomBombay: 0 };
const plans = [
  { userId: 'ag1', boardKey: 'b1', audience: 'VIP', side: 'DELHI', amountsPaise: [100_00, 200_00, 300_00], startsAtMs: 0 },
  { userId: 'ag1', boardKey: 'other', audience: 'VIP', side: 'BOMBAY', amountsPaise: [5_00], startsAtMs: 0 },
  { userId: 'ag1', boardKey: 'b1', audience: 'GENERAL', side: 'BOMBAY', amountsPaise: [7_00], startsAtMs: 0 },
];

describe('runAutoPhantomBets', () => {
  let gen;
  beforeEach(() => {
    place.mockReset().mockResolvedValue({
      ok: true, placed: 3, delhiRupees: 600, bombayRupees: 0,
      cycle: { phantomDelhi: 600, phantomBombay: 0, status: 'OPEN' },
    });
    recordBet.mockReset();
    emitToStaff.mockReset();
    gen = new CycleGenerator(null, null);
  });

  it('offers this tick\'s seconds with the sizes in order, for this board only', async () => {
    await gen.runAutoPhantomBets({ ...cycle }, plans, START + 2_500, START + 60_000);
    expect(place).toHaveBeenCalledTimes(1);
    const { cycleId, bets } = place.mock.calls[0][0];
    expect(cycleId).toBe('C1');
    expect(bets).toEqual([
      { userId: 'ag1', side: 'DELHI', second: 0, amountPaise: 100_00 },
      { userId: 'ag1', side: 'DELHI', second: 1, amountPaise: 200_00 },
      { userId: 'ag1', side: 'DELHI', second: 2, amountPaise: 300_00 },
    ]);
  });

  it('sends the public total only, and the split to admins', async () => {
    await gen.runAutoPhantomBets({ ...cycle }, plans, START + 2_500, START + 60_000);
    expect(recordBet).toHaveBeenCalledWith('C1', expect.objectContaining({ totalDelhi: 670, totalBombay: 30 }));
    const publicPayload = recordBet.mock.calls[0][1];
    expect(Object.keys(publicPayload).some((k) => /real|phantom/i.test(k))).toBe(false);
    expect(emitToStaff).toHaveBeenCalledWith(null, 'admin_bet_placed', expect.objectContaining({ isAuto: true, newPhantomDelhi: 600 }));
  });

  it('a plan saved in an earlier round runs every new round from its first second, never restarted', async () => {
    // Saved halfway through the round before; the next round starts an hour later.
    const saved = [{ ...plans[0], startsAtMs: START - 3_600_000 + 30_000 }];
    const next = { ...cycle, cycleId: 'C2', startTime: new Date(START) };
    await gen.runAutoPhantomBets(next, saved, START + 1_200, START + 60_000);
    expect(place.mock.calls[0][0]).toMatchObject({ cycleId: 'C2' });
    expect(place.mock.calls[0][0].bets).toEqual([
      { userId: 'ag1', side: 'DELHI', second: 0, amountPaise: 100_00 },
      { userId: 'ag1', side: 'DELHI', second: 1, amountPaise: 200_00 },
    ]);
  });

  it('runs each audience\'s plans on that audience\'s rounds only', async () => {
    await gen.runAutoPhantomBets({ ...cycle, cycleId: 'G1', audience: 'GENERAL' }, plans, START + 500, START + 60_000);
    expect(place.mock.calls[0][0].bets).toEqual([{ userId: 'ag1', side: 'BOMBAY', second: 0, amountPaise: 7_00 }]);
  });

  it('places nothing at or after the equalizer, and nothing for a board with no plan', async () => {
    await gen.runAutoPhantomBets({ ...cycle }, plans, START + 60_000, START + 60_000);
    await gen.runAutoPhantomBets({ ...cycle, type: 'b9' }, plans, START + 2_500, START + 60_000);
    expect(place).not.toHaveBeenCalled();
  });

  it('a refused batch announces nothing', async () => {
    place.mockResolvedValue({ ok: false, reason: 'PHANTOM_CLOSED' });
    await gen.runAutoPhantomBets({ ...cycle }, plans, START + 2_500, START + 60_000);
    expect(recordBet).not.toHaveBeenCalled();
    expect(emitToStaff).not.toHaveBeenCalled();
  });
});
