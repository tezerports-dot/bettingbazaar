// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Mini App's signed strings (Step 3): a string Telegram signed for THIS bot
 * passes; anything else — another bot's, an edited one, a stale one, one with
 * no user, a contact with no phone — does not. Signed here with a test token,
 * never a real one.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  verifyInitData, verifyContact, INIT_DATA_REFUSAL, MAX_AGE_SECONDS, FUTURE_SKEW_SECONDS,
} from '../../domains/telegram/miniAppAuth.js';
import { signInitData, signContact, TEST_BOT_TOKEN } from '../miniAppFixture.js';

const now = Math.floor(Date.now() / 1000);
const opts = { botToken: TEST_BOT_TOKEN, nowSeconds: now };

describe('verifyInitData', () => {
  it('accepts a string Telegram signed for this bot, and reads the user and start_param', () => {
    const raw = signInitData({ telegramUserId: 123456789, startParam: 'abc_DEF-1', username: 'ravi', firstName: 'Ravi' });
    const r = verifyInitData(raw, opts);
    expect(r.ok).toBe(true);
    expect(r.user).toEqual({ id: '123456789', username: 'ravi', firstName: 'Ravi' });
    expect(r.startParam).toBe('abc_DEF-1');
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.expiresAt.getTime()).toBe((r.authDate + MAX_AGE_SECONDS + FUTURE_SKEW_SECONDS) * 1000);
  });

  it('refuses a string signed with ANOTHER bot\'s token', () => {
    const raw = signInitData({ telegramUserId: 1, token: '7000000002:another-bot' });
    expect(verifyInitData(raw, opts)).toEqual({ ok: false, reason: INIT_DATA_REFUSAL.BAD_SIGNATURE });
  });

  it('refuses a string whose user was edited after signing', () => {
    const raw = signInitData({ telegramUserId: 111 });
    const edited = raw.replace(encodeURIComponent('"id":111'), encodeURIComponent('"id":222'));
    expect(edited).not.toBe(raw);
    expect(verifyInitData(edited, opts).reason).toBe(INIT_DATA_REFUSAL.BAD_SIGNATURE);
  });

  it('refuses a start_param that was swapped for another challenge', () => {
    const raw = signInitData({ telegramUserId: 111, startParam: 'challenge-one' });
    const swapped = raw.replace('challenge-one', 'challenge-two');
    expect(verifyInitData(swapped, opts).reason).toBe(INIT_DATA_REFUSAL.BAD_SIGNATURE);
  });

  it('refuses a stale string, and one dated in the future beyond the skew', () => {
    const old = signInitData({ telegramUserId: 1, authDate: now - MAX_AGE_SECONDS - 1 });
    expect(verifyInitData(old, opts).reason).toBe(INIT_DATA_REFUSAL.STALE);
    const future = signInitData({ telegramUserId: 1, authDate: now + FUTURE_SKEW_SECONDS + 5 });
    expect(verifyInitData(future, opts).reason).toBe(INIT_DATA_REFUSAL.STALE);
    // The edge: exactly at the limit is still accepted.
    const edge = signInitData({ telegramUserId: 1, authDate: now - MAX_AGE_SECONDS });
    expect(verifyInitData(edge, opts).ok).toBe(true);
  });

  it('refuses a string with no user, or a bot as the user', () => {
    const noUser = signInitData({ telegramUserId: 1 }).replace(/user=[^&]*&?/, '');
    // Re-signed without the user, so the refusal is about the user, not the hash.
    const params = new URLSearchParams(noUser); params.delete('hash');
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TEST_BOT_TOKEN).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
    expect(verifyInitData(params.toString(), opts).reason).toBe(INIT_DATA_REFUSAL.NO_USER);
  });

  it('refuses nonsense, a missing hash, two hashes, and a repeated key', () => {
    expect(verifyInitData('', opts).reason).toBe(INIT_DATA_REFUSAL.MALFORMED);
    expect(verifyInitData(undefined, opts).reason).toBe(INIT_DATA_REFUSAL.MALFORMED);
    expect(verifyInitData('user=%7B%7D&auth_date=1', opts).reason).toBe(INIT_DATA_REFUSAL.MALFORMED);
    const raw = signInitData({ telegramUserId: 1 });
    const hash = new URLSearchParams(raw).get('hash');
    expect(verifyInitData(`${raw}&hash=${hash}`, opts).reason).toBe(INIT_DATA_REFUSAL.MALFORMED);
    expect(verifyInitData(`${raw}&auth_date=${now}`, opts).reason).toBe(INIT_DATA_REFUSAL.MALFORMED);
  });

  it('will not run without a token: a missing bot is the caller\'s question, never a pass', () => {
    expect(() => verifyInitData(signInitData({ telegramUserId: 1 }), { nowSeconds: now })).toThrow(/bot token/);
  });
});

describe('verifyContact', () => {
  it('accepts a contact Telegram signed, normalising +91 to the ten digits the form stores', () => {
    const raw = signContact({ telegramUserId: 42, phone: '+919876543210' });
    const r = verifyContact(raw, opts);
    expect(r.ok).toBe(true);
    expect(r.contact).toEqual({ userId: '42', phone: '9876543210' });
  });

  it('refuses a contact whose phone was edited after signing', () => {
    const raw = signContact({ telegramUserId: 42, phone: '919876543210' });
    const edited = raw.replace('919876543210', '919999999999');
    expect(verifyContact(edited, opts).reason).toBe(INIT_DATA_REFUSAL.BAD_SIGNATURE);
  });

  it('refuses an initData passed off as a contact (it carries no contact)', () => {
    const raw = signInitData({ telegramUserId: 42 });
    expect(verifyContact(raw, opts).reason).toBe(INIT_DATA_REFUSAL.MALFORMED);
  });

  it('refuses a stale contact', () => {
    const raw = signContact({ telegramUserId: 42, phone: '919876543210', authDate: now - MAX_AGE_SECONDS - 60 });
    expect(verifyContact(raw, opts).reason).toBe(INIT_DATA_REFUSAL.STALE);
  });
});
