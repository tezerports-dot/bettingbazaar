// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/verificationEndpoint.js — the gate's endpoint, once.
 *
 * ── Why this is one function and three mounts ──────────────────────────────
 * All three panels gate now (owner, 2026-09-24). The question each one asks is
 * identical — "may this account use this panel yet, and if not, what next?" —
 * and `verificationStateFor` already answers it for any account, because it
 * derives the audience from `users.account_type` rather than being told.
 *
 * So the ONLY thing that differs between the three is how the request's account
 * is found: the player and staff doors have already put the row on `req.user`,
 * and the merchant door has put a merchant on `req.merchant` and its owner's id
 * on `req.userId`. That difference is one function argument.
 *
 * Written this way because §5 names the failure precisely: the system-config
 * payload was built twice with independently written fallbacks and the two had
 * already diverged, so a client got a different answer about the platform
 * depending on which one it asked. Three copies of a gate would diverge the
 * same way, and the symptom would be a panel that lets somebody in while
 * another panel refuses them — with nothing on either screen saying which is
 * right.
 *
 * The live-check floor is shared too, and deliberately: it is keyed by user id,
 * and one person's three accounts are three different ids, so nothing is
 * conflated. A per-panel floor would be three independent budgets aimed at one
 * Bot API.
 */
import { verificationStateFor } from './signupVerification.service.js';
import { respondError } from '../../shared/httpError.js';

/**
 * A floor on how often one account may force a LIVE check against Telegram.
 *
 * ── Why it matters more than it looks ─────────────────────────────────────
 * The default read is CACHE ONLY, and joining a channel emits a `chat_member`
 * update that writes the cache within about a second — so a poll costs nothing.
 * `?verify=1` is what the "I have joined" button sends, and a button is a
 * button: people press it.
 *
 * Replacing a channel makes every cached membership for that panel stale in one
 * instant, so the prompt appears for every logged-in account at once. Without
 * this floor, a flip would aim the whole active population at the Bot API in
 * the same few seconds — at the exact moment everybody is trying to get back
 * in, which is the worst moment to spend that budget.
 */
const lastLiveCheck = new Map();  // userId -> epoch ms
const LIVE_CHECK_FLOOR_MS = 20_000;

function mayCheckLive(userId) {
  const now = Date.now();
  // Bounded: a large logged-in population must not be able to grow this without
  // limit. Clearing is safe — the only cost is one extra live check each.
  if (lastLiveCheck.size > 50_000) lastLiveCheck.clear();
  const last = lastLiveCheck.get(String(userId)) || 0;
  if (now - last < LIVE_CHECK_FLOOR_MS) return false;
  lastLiveCheck.set(String(userId), now);
  return true;
}

/**
 * Build the handler for one panel.
 *
 * @param {(req: import('express').Request) => Promise<object|null>|object|null} resolveUser
 *   how this panel's authentication has already identified the account. It
 *   returns a `users` row — the row, not an id and not a merchant, because
 *   `verificationStateFor` reads `account_type` off it and that column is what
 *   decides which bot and which channel the answer is about.
 */
export function verificationEndpoint(resolveUser) {
  return async function verification(req, res) {
    try {
      const user = await resolveUser(req);
      if (!user) {
        // The panel authenticated somebody whose `users` row is gone. Not a
        // verification answer at all — answering `verified: false` would send
        // them to a bot to fix an account that does not exist.
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }

      const wantsLive = req.query.verify === '1';
      const refresh = wantsLive && mayCheckLive(user.userId);
      const state = await verificationStateFor(user, { refresh });

      return res.json({
        success: true,
        ...state,
        // True when a live check was ASKED for and declined by the floor, so the
        // screen can say "checking again shortly" instead of "you have not
        // joined" — which is a different sentence and, for somebody who HAS just
        // joined, the wrong one.
        throttled: wantsLive && !refresh,
      });
    } catch (err) {
      return respondError(res, err, 'auth/verification',
        { message: 'Could not check your verification right now. Please try again shortly.' });
    }
  };
}
