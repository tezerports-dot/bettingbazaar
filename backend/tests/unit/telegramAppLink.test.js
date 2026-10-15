// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sign-in's link to the Telegram app itself (`miniAppAppLink`, sent as
 * `telegram.appUrl`): the same Mini App and start parameter as the https link,
 * so a phone opens Telegram without a browser tab at t.me first.
 */
import { describe, it, expect } from 'vitest';
import { miniAppAppLink, miniAppLink } from '../../domains/telegram/telegramClient.js';
import { telegramBlock } from '../../domains/identity/telegramChallenge.service.js';

const PARAM = `c${'a'.repeat(32)}`;

describe('miniAppAppLink', () => {
  it('names the same bot, Mini App and start parameter as the https link', () => {
    expect(miniAppAppLink({ botUsername: '@BazaarBot', miniAppShortName: 'play' }, PARAM))
      .toBe(`tg://resolve?domain=BazaarBot&appname=play&startapp=${PARAM}`);
    expect(miniAppLink({ botUsername: '@BazaarBot', miniAppShortName: 'play' }, PARAM))
      .toBe(`https://t.me/BazaarBot/play?startapp=${PARAM}`);
  });

  it('opens the bot\'s main Mini App when none is named', () => {
    expect(miniAppAppLink({ botUsername: 'BazaarBot', miniAppShortName: null }, PARAM))
      .toBe(`tg://resolve?domain=BazaarBot&startapp=${PARAM}`);
  });

  it('refuses a start parameter Telegram would not accept, and answers null with no bot', () => {
    expect(() => miniAppAppLink({ botUsername: 'BazaarBot' }, 'not ok')).toThrow(/start parameter/);
    expect(miniAppAppLink(null, PARAM)).toBeNull();
  });
});

describe('telegramBlock', () => {
  it('sends both links for the same challenge', () => {
    const block = telegramBlock({ botUsername: 'BazaarBot', miniAppShortName: 'play' }, { challengeId: PARAM, expiresAt: 'soon' });
    expect(block).toEqual({
      url: `https://t.me/BazaarBot/play?startapp=${PARAM}`,
      appUrl: `tg://resolve?domain=BazaarBot&appname=play&startapp=${PARAM}`,
      botUsername: 'BazaarBot',
      expiresAt: 'soon',
    });
  });
});
