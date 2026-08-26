// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The channel gate decides in the right ORDER.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * The gate used to refuse an unlinked player with "link your Telegram account"
 * BEFORE asking whether the platform had a Telegram channel at all. When no bot
 * is configured, `joinPrompt()` returns null — so the player was told to link an
 * account to a bot the response could not name, and told it by a rule that did
 * not yet exist.
 *
 * That is precisely the state a fresh deployment sits in between deploying the
 * app and activating generation 1, and it made the gate blame a player for an
 * operator's unfinished setup. It also 403'd every money-path integration test,
 * which is how it was found.
 *
 * These run the real middleware against stubbed dependencies, because the
 * property is about ORDER OF DECISIONS — something a source-text assertion
 * cannot see and a happy-path test never reaches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const identityFindOne = vi.fn();
const membershipFor = vi.fn();
const joinPrompt = vi.fn();

vi.mock('../../domains/telegram/telegram.model.js', () => ({
  TelegramIdentity: {
    findOne: (...a) => ({
      select: () => ({ lean: () => identityFindOne(...a) }),
    }),
  },
}));

vi.mock('../../domains/telegram/telegramMembership.js', () => ({
  membershipFor: (...a) => membershipFor(...a),
  joinPrompt: (...a) => joinPrompt(...a),
}));

const { requireChannelMembership } = await import('../../middleware/requireChannelMembership.js');

/** A minimal res that records what the handler did. */
function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function run({ user, identity, verdict, prompt = null }) {
  identityFindOne.mockResolvedValue(identity);
  membershipFor.mockResolvedValue(verdict);
  joinPrompt.mockResolvedValue(prompt);

  const res = makeRes();
  const next = vi.fn();
  await requireChannelMembership({ action: 'place a bet' })({ user }, res, next);
  return { res, next };
}

const PLAYER = { _id: 'u1' };

beforeEach(() => {
  identityFindOne.mockReset();
  membershipFor.mockReset();
  joinPrompt.mockReset();
});

describe('when the platform has no Telegram channel configured', () => {
  const UNCONFIGURED = { joined: false, status: 'unconfigured', unconfigured: true };

  it('lets an UNLINKED player through instead of blaming them', async () => {
    // The regression. There is no rule to enforce yet, and the player cannot
    // link to a bot that does not exist.
    const { res, next } = await run({ user: PLAYER, identity: null, verdict: UNCONFIGURED });
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('lets a linked player through too', async () => {
    const { res, next } = await run({
      user: PLAYER, identity: { telegramUserId: '42' }, verdict: UNCONFIGURED,
    });
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('asks about configuration BEFORE looking at the player', async () => {
    // Ordering stated directly: membershipFor is consulted, and joinPrompt —
    // the "here is where to go" step — is never reached.
    await run({ user: PLAYER, identity: null, verdict: UNCONFIGURED });
    expect(membershipFor).toHaveBeenCalledWith(null);
    expect(joinPrompt).not.toHaveBeenCalled();
  });
});

describe('when a channel IS configured', () => {
  it('refuses an unlinked player, with somewhere to go', async () => {
    // The gate must still do its job — the fix must not turn it off.
    const { res, next } = await run({
      user: PLAYER,
      identity: null,
      verdict: { joined: false, status: 'unlinked' },
      prompt: { botUsername: 'bb_bot', inviteLink: 'https://t.me/+abc' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('TELEGRAM_NOT_LINKED');
    expect(res.body.telegram.botUsername).toBe('bb_bot');
  });

  it('refuses a linked player who has left the channel', async () => {
    const { res, next } = await run({
      user: PLAYER,
      identity: { telegramUserId: '42' },
      verdict: { joined: false, status: 'left' },
      prompt: { inviteLink: 'https://t.me/+abc' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CHANNEL_MEMBERSHIP_REQUIRED');
  });

  it('admits a member', async () => {
    const { next } = await run({
      user: PLAYER,
      identity: { telegramUserId: '42' },
      verdict: { joined: true, status: 'member' },
    });
    expect(next).toHaveBeenCalled();
  });
});

describe('the outage window', () => {
  const UNREACHABLE_MEMBER = { joined: true, status: 'member', unreachable: true };

  it('honours a recent membership while Telegram is unreachable', async () => {
    const { next } = await run({
      user: PLAYER,
      identity: { telegramUserId: '42', channelCheckedAt: new Date() },
      verdict: UNREACHABLE_MEMBER,
    });
    expect(next).toHaveBeenCalled();
  });

  it('expires it once the window has passed', async () => {
    // Measured from the last CONFIRMED check, so a cache that was already stale
    // does not earn a fresh grace period by being read during an outage.
    const { res, next } = await run({
      user: PLAYER,
      identity: { telegramUserId: '42', channelCheckedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      verdict: UNREACHABLE_MEMBER,
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('MEMBERSHIP_UNVERIFIABLE');
  });
});

describe('staff and failures', () => {
  it('never gates staff', async () => {
    // Their credentials must not depend on a third party that can suspend an
    // account — gating them locks operators out during the exact incident they
    // are there to manage.
    for (const role of ['isAdmin', 'isSubAdmin', 'isQueueManager', 'isMediator']) {
      const { next } = await run({ user: { _id: 's1', [role]: true }, identity: null, verdict: {} });
      expect(next, role).toHaveBeenCalled();
    }
    // Not even a lookup — staff are decided before any Telegram work.
    expect(membershipFor).not.toHaveBeenCalled();
  });

  it('refuses rather than admits when the check throws', async () => {
    identityFindOne.mockRejectedValue(new Error('mongo is down'));
    const res = makeRes();
    const next = vi.fn();
    await requireChannelMembership()({ user: PLAYER }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('MEMBERSHIP_CHECK_FAILED');
  });

  it('401s an unauthenticated request', async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireChannelMembership()({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
