// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The standby switch (owner, 2026-10-14): `checkBotHealth` suspends a bot
 * whose token Telegram REFUSES, so new links name the next standby, and
 * suspends nothing on Telegram's weather (a timeout, a 5xx, a 429).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = { current: [] };
const setBotSuspended = vi.fn(async ({ slot }) => ({ slot }));
vi.mock('#db', () => ({ db: { telegram: { getBotSecrets: async () => rows.current, setBotSuspended } } }));
vi.mock('../../domains/identity/fieldCrypto.util.js', () => ({ decryptField: (c) => `token-${c}` }));

const { checkBotHealth, miniAppBot, invalidateBotCache } = await import('../../domains/telegram/telegramClient.js');

const row = (slot, suspended = false) => ({
  slot, botId: String(slot), botUsername: `bot${slot}`, tokenEncrypted: String(slot), miniAppShortName: '', suspended,
});

beforeEach(() => { setBotSuspended.mockClear(); invalidateBotCache(); });

describe('checkBotHealth', () => {
  it('suspends only a bot Telegram refuses, and the next standby is in use', async () => {
    rows.current = [row(1), row(2), row(3)];
    const answers = {
      'token-1': { ok: false, status: 401, error: 'Unauthorized' },
      'token-2': { ok: false, status: 502, error: 'Bad Gateway' },
      'token-3': { ok: false, error: 'timeout' },
    };
    const onSuspended = vi.fn();
    expect(await checkBotHealth({ verify: async (t) => answers[t], onSuspended })).toEqual([1]);
    expect(setBotSuspended).toHaveBeenCalledTimes(1);
    expect(setBotSuspended.mock.calls[0][0]).toMatchObject({ slot: 1, botId: '1', updatedBy: 'system:bot-health' });
    expect(onSuspended).toHaveBeenCalledTimes(1);

    rows.current = [row(1, true), row(2), row(3)];
    expect((await miniAppBot()).slot).toBe(2);
  });

  it('asks nothing of a bot already suspended, and with every bot suspended there is none in use', async () => {
    rows.current = [row(1, true), row(2, true)];
    const verify = vi.fn();
    expect(await checkBotHealth({ verify })).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    expect(await miniAppBot({ force: true })).toBeNull();
  });

  it('asks every bot at once, and never twice while the last probe is still out', async () => {
    rows.current = [row(1), row(2)];
    let release;
    const gate = new Promise((r) => { release = r; });
    const verify = vi.fn(() => gate);
    const first = checkBotHealth({ verify });
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
    expect(await checkBotHealth({ verify })).toEqual([]);
    release({ ok: true });
    expect(await first).toEqual([]);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
