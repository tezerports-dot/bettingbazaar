// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The Telegram link the "Can't connect" screen offers: kept only in its one
 * shape, kept through an outage, forgotten when the server says there is no bot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const get = vi.fn();
vi.mock('./api', () => ({ platform: { telegramEntry: () => get() } }));

beforeEach(() => { localStorage.clear(); get.mockReset(); });

describe('telegramEntry', () => {
  it('accepts only https://t.me/<bot>, /<bot>/<app> or the main-app form', async () => {
    const { isTelegramEntryUrl } = await import('./telegramEntry');
    for (const ok of ['https://t.me/BazaarBot/play', 'https://t.me/bazaar_bot?startapp']) expect(isTelegramEntryUrl(ok)).toBe(true);
    for (const bad of ['http://t.me/BazaarBot/play', 'https://t.me.evil.com/BazaarBot', 'https://evil.com/?https://t.me/BazaarBot',
      'https://t.me/BazaarBot/play?startapp=ref-X', 'javascript:alert(1)', 'https://t.me/ab', '', null]) {
      expect(isTelegramEntryUrl(bad)).toBe(false);
    }
  });

  it('remembers a good answer, keeps it through an outage, forgets it on "no bot"', async () => {
    const { refreshTelegramEntry, rememberedTelegramEntry } = await import('./telegramEntry');
    get.mockResolvedValueOnce({ url: 'https://t.me/BazaarBot/play' });
    expect(await refreshTelegramEntry()).toBe('https://t.me/BazaarBot/play');
    expect(rememberedTelegramEntry()).toBe('https://t.me/BazaarBot/play');

    get.mockRejectedValueOnce(Object.assign(new TypeError('Failed to fetch')));
    expect(await refreshTelegramEntry()).toBe('https://t.me/BazaarBot/play');
    get.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 502 }));
    expect(await refreshTelegramEntry()).toBe('https://t.me/BazaarBot/play');

    get.mockRejectedValueOnce(Object.assign(new Error('no bot'), { status: 404 }));
    expect(await refreshTelegramEntry()).toBe('');
    expect(rememberedTelegramEntry()).toBe('');
  });

  it('keeps the standby bots after the bot in use, and reads a list of one kept before them', async () => {
    const { refreshTelegramEntry, rememberedTelegramEntries } = await import('./telegramEntry');
    localStorage.setItem('bb_telegram_entry', 'https://t.me/BazaarBot/play');
    expect(rememberedTelegramEntries()).toEqual(['https://t.me/BazaarBot/play']);
    get.mockResolvedValueOnce({
      url: 'https://t.me/BazaarTwoBot/play',
      urls: ['https://t.me/BazaarTwoBot/play', 'https://evil.example/phish', 'https://t.me/BazaarThreeBot?startapp'],
    });
    expect(await refreshTelegramEntry()).toBe('https://t.me/BazaarTwoBot/play');
    expect(rememberedTelegramEntries()).toEqual(['https://t.me/BazaarTwoBot/play', 'https://t.me/BazaarThreeBot?startapp']);
  });

  it('never keeps or shows a link of another shape, from the server or from storage', async () => {
    const { refreshTelegramEntry, rememberedTelegramEntry } = await import('./telegramEntry');
    get.mockResolvedValueOnce({ url: 'https://evil.example/phish' });
    expect(await refreshTelegramEntry()).toBe('');
    localStorage.setItem('bb_telegram_entry', 'https://evil.example/phish');
    expect(rememberedTelegramEntry()).toBe('');
  });
});
