// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/accountTelegram.js — the signed-in account's own Telegram.
 *
 * One implementation, mounted on each panel behind that panel's own session
 * check (§5, §33.5):
 *
 *   player    GET|POST|PUT /api/v1/auth/telegram…       authenticatePlayer
 *   staff     GET|POST|PUT /api/admin/account/telegram…  authenticateStaff
 *   merchant  GET|POST|PUT /api/merchant/telegram…       merchantAuth
 *
 * Every mount leaves the account's id on `req.userId` — the `users` row, which
 * for a merchant is its login (merchantAuth) — and nothing here reads anything
 * else from the request to decide whose account it is.
 *
 * ── Relink, never unlink (owner reading, 2026-10-07) ───────────────────────
 * Every account was verified at signup, so there is no "link" button: there is
 * "move to another Telegram account", approved from THAT account with the same
 * matching contact. Nothing here leaves a verified account unlinked.
 */
import { db } from '#db';
import { miniAppBot } from '../telegram/telegramClient.js';
import { openChallenge } from './telegramChallenge.service.js';
import { respondError, refusal } from '../../shared/httpError.js';

async function accountOf(req) {
  const user = await db.users.getUser(req.userId);
  if (!user) throw refusal(404, 'NO_ACCOUNT', 'Account not found.');
  return user;
}

function view(link, { available, accountType }) {
  return {
    success: true,
    available,
    linked: Boolean(link),
    telegramUsername: link?.telegramUsername || '',
    firstName: link?.firstName || '',
    verifiedAt: link?.verifiedAt ?? null,
    linkedAt: link?.linkedAt ?? null,
    twoFactor: {
      enabled: link ? link.twoFactor : accountType !== 'PLAYER',
      // Staff and merchants always: the row's own CHECK
      // (`telegram_links_staff_two_factor`) says so.
      required: accountType !== 'PLAYER',
    },
  };
}

/** GET …/telegram — what the Profile screen shows. */
export async function telegramStatus(req, res) {
  try {
    const user = await accountOf(req);
    const [link, bot] = await Promise.all([db.telegram.getLinkByUserId(user.userId), miniAppBot()]);
    return res.json(view(link, { available: Boolean(bot), accountType: user.accountType }));
  } catch (e) {
    return respondError(res, e, 'account/telegram', { message: 'Could not read your Telegram link.' });
  }
}

/**
 * POST …/telegram/relink — move this account to another Telegram account.
 *
 * Opens a RELINK challenge; it is approved in the Mini App from the NEW
 * Telegram account by sharing its contact, whose phone must be this account's
 * mobile. The panel opens `telegram.url` and polls GET until `linkedAt` moves.
 */
export async function telegramRelink(req, res) {
  try {
    const user = await accountOf(req);
    const opened = await openChallenge({ purpose: 'RELINK', door: user.accountType, userId: user.userId, req });
    return res.json({
      success: true,
      telegram: opened.telegram,
      message: 'Open the link in the Telegram account you want to use, and share its contact there.',
    });
  } catch (e) {
    return respondError(res, e, 'account/telegram/relink', { message: 'Could not start moving your Telegram account.' });
  }
}

/**
 * PUT …/telegram/two-factor `{ enabled }` — a player's own switch.
 *
 * ON takes effect at once. OFF needs their Telegram's approval (202 and a Mini
 * App link): a stolen password must not be able to switch off the one thing
 * that would have stopped it. Staff and merchants cannot switch it at all.
 */
export async function telegramTwoFactor(req, res) {
  try {
    const user = await accountOf(req);
    if (user.accountType !== 'PLAYER') {
      throw refusal(403, 'TWO_FACTOR_MANDATORY',
        'Telegram approval of every sign-in is required for this account and cannot be switched off.');
    }
    if (typeof req.body?.enabled !== 'boolean') {
      throw refusal(400, 'ENABLED_REQUIRED', 'Say whether Telegram approval should be on or off.');
    }
    const link = await db.telegram.getLinkByUserId(user.userId);
    if (!link) throw refusal(409, 'TELEGRAM_NOT_LINKED', 'Verify your mobile number in Telegram first.');

    if (req.body.enabled) {
      const updated = link.twoFactor ? link : await db.telegram.enablePlayerTwoFactor(user.userId);
      return res.json({ success: true, twoFactor: { enabled: updated.twoFactor, required: false } });
    }
    if (!link.twoFactor) return res.json({ success: true, twoFactor: { enabled: false, required: false } });

    const opened = await openChallenge({ purpose: 'TWO_FACTOR_OFF', door: 'PLAYER', userId: user.userId, req });
    return res.status(202).json({
      success: true,
      approvalRequired: true,
      telegram: opened.telegram,
      message: 'Approve this in Telegram to switch Telegram approval off.',
    });
  } catch (e) {
    return respondError(res, e, 'account/telegram/two-factor', { message: 'Could not change Telegram approval.' });
  }
}
