// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * boardRules.admin.routes.js — the rules pop-up players accept before betting,
 * edited by an admin (owner, 2026-10-14: "we can have a edit button in the
 * admin panel where we can edit and update the rules pop up"). The text and
 * its versions are `database/repositories/boardRules.js`; this file admits,
 * audits and answers.
 *
 *   GET /board-rules   the current text as written (placeholders kept), the
 *                      same text as players see it, the placeholders, the
 *                      limits and the published versions
 *   PUT /board-rules   publish { heading, intro, sections: [{ title, body }] }
 *                      as the next version; every player accepts it again
 *                      before their next bet
 */
import { authenticate, express, hasPermission } from './_adminShared.js';
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { renderBoardRules, BOARD_RULES_TOKENS, BOARD_RULES_LIMITS } from '../../domains/markets/boardRules.js';
import { respondError } from '../../shared/httpError.js';

const router = express.Router();
const ALLOWED = hasPermission('canManageContent');

const live = (config) => ({
  feePercent: config.winningsFeePercent,
  multiplier: config.payoutMultiplier,
  // schema default: false (database/spec/config.spec.js riskRules)
  bothSides: !(config.riskRules?.blockOppositeSideBetting ?? false),
});

router.get('/board-rules', authenticate, ALLOWED, async (req, res) => {
  try {
    const [text, config, history] = await Promise.all([
      db.boardRules.currentText(), getSystemConfig(), db.boardRules.history(),
    ]);
    res.json({
      success: true,
      text,
      preview: renderBoardRules(text, live(config)),
      tokens: BOARD_RULES_TOKENS,
      limits: BOARD_RULES_LIMITS,
      history,
    });
  } catch (error) {
    return respondError(res, error, 'GET /admin/board-rules', { message: 'Failed to load the rules pop-up' });
  }
});

router.put('/board-rules', authenticate, ALLOWED, async (req, res) => {
  try {
    const before = await db.boardRules.currentText();
    const text = await db.boardRules.publish(req.body ?? {}, req.user.userId);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'BOARD_RULES_PUBLISHED', category: 'CONTENT',
      targetType: 'board_rules', targetId: String(text.version), targetName: text.heading,
      details: { fromVersion: before.version, toVersion: text.version },
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    const config = await getSystemConfig();
    res.json({ success: true, text, preview: renderBoardRules(text, live(config)) });
  } catch (error) {
    return respondError(res, error, 'PUT /admin/board-rules', { message: 'Failed to publish the rules pop-up' });
  }
});

export default router;
