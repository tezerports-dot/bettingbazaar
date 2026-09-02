// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/requireChannelMembership.js — betting, games and the wallet are
 * for members of the official Telegram channel.
 *
 * Placed AFTER `authenticate`, so `req.user` exists. It answers one question —
 * may this person act right now — and it is the only place the fail-open /
 * fail-closed policy is decided.
 *
 * ── The outage policy, and why it is a bounded window ───────────────────────
 * Telegram is a third party and will be unreachable sometimes. Two bad options
 * bracket the choice:
 *
 *   Fail closed — refuse everyone whose membership cannot be confirmed. A
 *   Telegram outage then halts betting platform-wide: a third party's bad
 *   afternoon becomes a total revenue stop, and every honest player is punished
 *   for it.
 *
 *   Fail open indefinitely — honour the last known answer forever. Someone who
 *   left the channel keeps full access for as long as the outage lasts, and a
 *   long outage silently turns the membership requirement off.
 *
 * So: honour a last-known "member" for a BOUNDED window (MEMBERSHIP_GRACE_MS,
 * default 24h) and refuse after it. Play continues through any realistic
 * outage; the exposure is capped at people who left the channel within the
 * window, which is small and self-correcting the moment Telegram answers again.
 *
 * The window is measured from when the status was last CONFIRMED, not from when
 * the outage began — a cache that was already stale does not earn a fresh grace
 * period by being read during an outage.
 */
/**
 * The Telegram model and membership layer are imported LAZILY, inside the
 * handler, rather than at module load.
 *
 * Defining a Mongoose schema is a side effect that needs a real `mongoose`.
 * This middleware is mounted on bet.routes and payment.routes, whose unit tests
 * substitute a light mongoose stub — a top-level import would drag schema
 * definition into every one of those suites and fail on the stub, for a module
 * the test never intended to exercise. Requiring it at call time keeps the
 * dependency where it is actually used; Node caches modules, so this is a map
 * lookup after the first request.
 */
async function deps() {
  const [{ TelegramIdentity }, membership] = await Promise.all([
    import('../domains/telegram/telegram.model.js'),
    import('../domains/telegram/telegramMembership.js'),
  ]);
  return { TelegramIdentity, membershipFor: membership.membershipFor, joinPrompt: membership.joinPrompt };
}

/** How long a last-known membership is honoured while Telegram is unreachable. */
const GRACE_MS = Number(process.env.TELEGRAM_MEMBERSHIP_GRACE_MS || 24 * 60 * 60 * 1000);

/**
 * Roles that are never gated.
 *
 * Staff do not authenticate through Telegram at all — their credentials must
 * not depend on a third party that can suspend an account — so there is no
 * membership to check and gating them would lock the operators out of the
 * platform during exactly the incident they need to manage.
 */
function isStaff(user) {
  return Boolean(user?.isAdmin || user?.isSubAdmin || user?.isQueueManager || user?.isMediator);
}

function withinGrace(identity) {
  if (!identity?.channelCheckedAt) return false;
  return Date.now() - new Date(identity.channelCheckedAt).getTime() < GRACE_MS;
}

/**
 * @param {{action?: string}} [opts] what is being attempted, for the message
 *   the player sees ("before you can place a bet").
 */
export function requireChannelMembership({ action = 'continue' } = {}) {
  return async function channelGate(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }
      if (isStaff(req.user)) return next();

      const { TelegramIdentity, membershipFor, joinPrompt } = await deps();

      const identity = await TelegramIdentity.findOne({ userId: req.user.userId })
        .select('telegramUserId channelStatus channelCheckedAt channelGeneration contactActive')
        .lean();

      // ASKED BEFORE the player is blamed for anything, including before "you
      // have no Telegram account linked". `membershipFor` accepts a null
      // identity precisely so this ordering is possible.
      //
      // The reverse order was a bug: an unlinked player was refused with "link
      // your Telegram account" even when the platform had NO bot configured, so
      // the prompt could not name one and the instruction was unfollowable. That
      // is the exact state a fresh deployment sits in between deploying and
      // activating generation 1, and it made the gate blame the player for an
      // operator's unfinished setup.
      const verdict = await membershipFor(identity);

      // No channel configured at all. That is an operator problem the player can
      // do nothing about, so the gate does not enforce a rule that does not yet
      // exist. Loud, because it means membership is currently unenforced.
      if (verdict.unconfigured) {
        console.error('[channel-gate] no active Telegram config — membership cannot be enforced');
        return next();
      }

      // A channel DOES exist and this account is not linked to it. Now the
      // message is actionable, and `joinPrompt()` can name the bot to use.
      if (!identity) {
        const prompt = await joinPrompt();
        return res.status(403).json({
          success: false,
          code: 'TELEGRAM_NOT_LINKED',
          message: `Link your Telegram account to ${action}.`,
          telegram: prompt,
        });
      }

      if (verdict.joined) {
        // A stale "member" honoured during an outage is allowed only inside the
        // window. Outside it, the answer expires.
        if (verdict.unreachable && !withinGrace(identity)) {
          return res.status(503).json({
            success: false,
            code: 'MEMBERSHIP_UNVERIFIABLE',
            message: 'We cannot confirm your channel membership right now. Please try again shortly.',
            retryAfterSeconds: 300,
          });
        }
        return next();
      }

      // A definite "not a member" — or an unreachable Telegram with nothing
      // usable cached, which is treated the same way because the player CAN act
      // on it: joining the channel resolves both.
      const prompt = await joinPrompt();
      return res.status(403).json({
        success: false,
        code: 'CHANNEL_MEMBERSHIP_REQUIRED',
        message: `Join our official Telegram channel to ${action}.`,
        telegram: prompt,
      });
    } catch (err) {
      // A gate that throws must not become a gate that admits. Refuse, and log
      // loudly enough that the cause is found rather than absorbed.
      console.error('[channel-gate] failed:', err.message);
      return res.status(503).json({
        success: false,
        code: 'MEMBERSHIP_CHECK_FAILED',
        message: 'We could not verify your account right now. Please try again shortly.',
      });
    }
  };
}

export default requireChannelMembership;
