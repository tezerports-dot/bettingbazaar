// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Signing in without leaving the site.
 *
 * ── What this replaces, and what it does not ────────────────────────────────
 * Signing UP still happens in the bot, once: the contact share is what proves
 * the phone number, and a bot cannot message somebody who has never started a
 * chat with it, so there is no first signup that avoids the trip. Every login
 * after that is on-site — type the mobile, the bot DMs a six-digit code, type
 * it back (owner decision 2026-09-08).
 *
 * ── Why the assertions are mostly about what is NOT revealed ────────────────
 * A six-digit code is only as safe as what surrounds it, and every property
 * that makes it safe is invisible in a screenshot of a working login:
 *
 *   the request endpoint answers identically for a registered number and an
 *   unknown one, because a form that says "no such account" is a way to test
 *   whether a given person gambles here;
 *
 *   the code is single-use, five-attempt, minutes-long and hashed, and a
 *   redemption that got any of that wrong still looks like a successful login
 *   to whoever is testing it;
 *
 *   wrong, expired, spent and out-of-attempts all read the same to the caller,
 *   because a caller who can tell them apart can map which codes were live.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { setBlocked } from '#db/repositories/users.js';
import { createIdentity } from '#db/repositories/telegram.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The Telegram boundary, stubbed so the CODE is what is under test rather than
// whether an HTTP call to Telegram succeeds. Capturing the outgoing message is
// also the only way to read the code a player would have received.
const tg = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../domains/telegram/telegramClient.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendMessage: tg.send };
});

describePg('on-site sign-in with a Telegram code', () => {
  let app;
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/telegram/telegram.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A player who finished the bot signup: account + live Telegram identity. */
  const linkedPlayer = async () => {
    // The account's OWN mobile — `updateUser` refuses to write the column at
    // all ("`mobile` is never mutable — it is the account's identity"), which
    // is the right rule and caught this fixture trying to break it.
    const player = await actor({});
    const telegramUserId = `tg-${Date.now().toString(36)}-${(seq += 1)}`;
    await createIdentity({
      telegramUserId, userId: player.userId,
      telegramUsername: 'player', firstName: 'Player',
      phone: player.mobile,
    });
    return { ...player, telegramUserId };
  };

  /** The six digits the bot actually sent. */
  const sentCode = () => {
    const body = tg.send.mock.calls.at(-1)?.[1] ?? '';
    return body.match(/<b>(\d{6})<\/b>/)?.[1] ?? null;
  };

  const requestCode = (mobile) => request(app).post('/otp/request').send({ mobile });
  const verify = (mobile, code) => request(app).post('/otp/verify').send({ mobile, code });

  beforeAll(() => { tg.send.mockResolvedValue({ ok: true }); });

  it('signs a linked player in with the code the bot sent', async () => {
    tg.send.mockResolvedValue({ ok: true });
    const player = await linkedPlayer();

    expect((await requestCode(player.mobile)).status).toBe(200);
    const code = sentCode();
    expect(code, 'no six-digit code in the message').toMatch(/^\d{6}$/);
    // Addressed to that player's Telegram, not broadcast.
    expect(tg.send.mock.calls.at(-1)[0]).toBe(player.telegramUserId);

    const res = await verify(player.mobile, code);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);
    // The same session the link path issues — `issueSession`, not a second
    // implementation that could grant different claims.
    expect(res.body.token || res.body.data?.token).toBeTruthy();
  });

  it('answers an unknown number exactly as it answers a real one', async () => {
    // The whole point. A different status, a different message, or a different
    // shape here turns the login form into a "does this person gamble?" oracle.
    tg.send.mockResolvedValue({ ok: true });
    const player = await linkedPlayer();

    const known = await requestCode(player.mobile);
    const unknown = await requestCode('9999999999');

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('sends nothing at all for an unknown number', async () => {
    tg.send.mockClear();
    await requestCode('9888888888');
    expect(tg.send).not.toHaveBeenCalled();
  });

  it('normalises the number, so +91 and spaces reach the same account', async () => {
    tg.send.mockResolvedValue({ ok: true });
    const player = await linkedPlayer();

    await requestCode(`+91 ${player.mobile.slice(0, 5)} ${player.mobile.slice(5)}`);
    const code = sentCode();
    expect(code).toMatch(/^\d{6}$/);
    // And the verify side normalises identically, or the code would be
    // unredeemable by whoever just received it.
    expect((await verify(`+91${player.mobile}`, code)).status).toBe(200);
  });




  it('refuses a code minted before the player was blocked', async () => {
    // The five-minute window is long enough for an admin to act, so the account
    // state is re-read at redemption rather than trusted from the request that
    // issued the code.
    tg.send.mockResolvedValue({ ok: true });
    const player = await linkedPlayer();
    await requestCode(player.mobile);
    const code = sentCode();

    await setBlocked(player.userId, { blocked: true, reason: 'Blocked mid-session', actor: 'admin-1' });
    expect((await verify(player.mobile, code)).status).toBe(401);
  });

  it('mints and sends nothing for a blocked player', async () => {
    tg.send.mockResolvedValue({ ok: true });
    const player = await linkedPlayer();
    await setBlocked(player.userId, { blocked: true, reason: 'Blocked before signing in', actor: 'admin-1' });

    tg.send.mockClear();
    const res = await requestCode(player.mobile);
    expect(res.status).toBe(200);          // still indistinguishable from success
    expect(tg.send).not.toHaveBeenCalled();
  });

  it('paces a second attempt on the same number, and says how long', async () => {
    // One per 10 seconds, per step. Without this a six-digit code is guessable
    // by a script however good the five-attempt cap is.
    tg.send.mockResolvedValue({ ok: true });
    const player = await linkedPlayer();
    await requestCode(player.mobile);
    const code = sentCode();

    expect((await verify(player.mobile, code)).status).toBe(200);
    const second = await verify(player.mobile, '000000');
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('LOGIN_PACED');
    expect(second.body.retryAfter).toBeGreaterThan(0);
    expect(Date.parse(second.body.retryAt)).toBeGreaterThan(Date.now() - 1000);
  });

  it('paces requesting and verifying in SEPARATE buckets', async () => {
    // A shared bucket refuses the code it just sent: request, then type it
    // eight seconds later, and the pace answers instead of the handler. That is
    // not a throttle, it is a login nobody who types quickly can complete.
    tg.send.mockResolvedValue({ ok: true });
    const player = await linkedPlayer();

    expect((await requestCode(player.mobile)).status).toBe(200);
    const code = sentCode();
    // Immediately after, with no wait at all.
    expect((await verify(player.mobile, code)).status).toBe(200);
  });

  it('refuses a code issued for a different number', async () => {
    // The code is bound to the mobile it was minted for. Without that, a code
    // overheard from one player redeems anybody's account.
    tg.send.mockResolvedValue({ ok: true });
    const a = await linkedPlayer();
    const b = await linkedPlayer();

    await requestCode(a.mobile);
    const codeForA = sentCode();
    expect((await verify(b.mobile, codeForA)).status).toBe(401);
  });


  it('still answers 200 when Telegram itself fails', async () => {
    // A delivery failure must not become a different response — that would
    // separate "we tried" from "there was nothing to do", which is the exact
    // distinction the identical response exists to hide.
    const player = await linkedPlayer();
    tg.send.mockResolvedValue({ ok: false, error: 'bot blocked by user' });
    const res = await requestCode(player.mobile);
    expect(res.status).toBe(200);
  });

  it('never returns the code, the account, or anything about the number', async () => {
    tg.send.mockResolvedValue({ ok: true });
    const player = await linkedPlayer();
    const res = await requestCode(player.mobile);
    const body = JSON.stringify(res.body);

    expect(body).not.toMatch(/\d{6}/);
    expect(body).not.toContain(player.userId);
    expect(body).not.toContain(player.mobile);
    expect(body).not.toContain(player.telegramUserId);
  });
});
