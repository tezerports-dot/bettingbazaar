// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * playerAuth.routes.js — the player sign-in door, and the invite check.
 *
 * ── "Continue with Telegram" (owner, 2026-10-13/14) ────────────────────────
 * A player signs in, and signs up, with one button: the Mini App's Verify. No
 * password, no form, no reset. The first Verify shares the contact once,
 * which makes the account (with the invite the sign-in carried) or links the
 * one on that mobile (routes.js, repositories/telegram.js).
 *
 * ── Rate limiting is per ROUTE, never on the router ────────────────────────
 * The sign-in legs carry their door's chain (`loginDoors.js`). The router also
 * serves `/invite/:code`, which checks no credential (§32 S27, S28).
 */
import express from 'express';
import { db } from '#db';
import { normaliseReferralCode } from './signupFields.js';
import { respondError } from '../../shared/httpError.js';
import { doorRoute } from './loginDoors.js';

const router = express.Router();

// ── The player sign-in door: routes.js's handlers, with this door's limits ──
router.post('/login/telegram', ...doorRoute('PLAYER', 'telegram'));
router.post('/login/telegram/complete', ...doorRoute('PLAYER', 'telegramComplete'));
router.post('/login/telegram/ticket', ...doorRoute('PLAYER', 'telegramTicket'));

/**
 * GET /api/v1/auth/invite/:code — is this invite code real, and whose?
 *
 * A referral link's code rides with "Continue with Telegram" and cannot be
 * changed (owner decision), so the sign-in screen checks it first and says
 * whose it is — "Invited by Rahul" is the confirmation that a link worked.
 *
 * It answers about a CODE, never about a person: the code is already public (it
 * is in the link that was shared), and the name is the referrer's `username`,
 * which is `player<last four digits>` — not their number, not their mobile.
 * There is no lookup in the other direction.
 */
router.get('/invite/:code', async (req, res) => {
  try {
    const code = normaliseReferralCode(req.params.code);
    if (!code) return res.json({ success: true, valid: false });
    const referrer = await db.users.getUserByReferralCode(code);
    return res.json({
      success: true,
      valid: Boolean(referrer),
      code,
      invitedBy: referrer?.username || '',
    });
  } catch (err) {
    return respondError(res, err, 'auth/invite',
      { message: 'Could not check that invite code.' });
  }
});

export default router;
