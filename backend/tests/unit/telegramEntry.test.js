// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Telegram link that always opens the player app's way in
 * (`miniAppEntryLink`, GET /api/v1/client/telegram-entry): Telegram's address,
 * so it outlives a blocked domain (docs/governance/DOMAIN_FAILOVER.md).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

const bot = { current: null };
vi.mock('../../domains/telegram/telegramClient.js', async (orig) => ({
  ...(await orig()),
  miniAppBot: async () => bot.current,
}));

let app;
let miniAppEntryLink;
beforeAll(async () => {
  ({ miniAppEntryLink } = await import('../../domains/telegram/telegramClient.js'));
  app = express().use('/api', (await import('../../routes/clientEndpoint.routes.js')).default);
});

describe('miniAppEntryLink', () => {
  it('a named Mini App opens at its own path; without one, the bot\'s main Mini App', () => {
    expect(miniAppEntryLink({ botUsername: '@BazaarBot', miniAppShortName: 'play' })).toBe('https://t.me/BazaarBot/play');
    expect(miniAppEntryLink({ botUsername: 'BazaarBot', miniAppShortName: null })).toBe('https://t.me/BazaarBot?startapp');
    expect(miniAppEntryLink(null)).toBeNull();
  });
});

describe('GET /api/v1/client/telegram-entry', () => {
  it('answers the link, or 404 with no bot saved', async () => {
    bot.current = { botUsername: 'BazaarBot', miniAppShortName: 'play' };
    const ok = await request(app).get('/api/v1/client/telegram-entry');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ url: 'https://t.me/BazaarBot/play' });
    bot.current = null;
    const none = await request(app).get('/api/v1/client/telegram-entry');
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('TELEGRAM_UNAVAILABLE');
  });
});
