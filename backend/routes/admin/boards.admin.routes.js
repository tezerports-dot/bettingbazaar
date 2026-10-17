// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * boards.admin.routes.js — the admin's boards (owner, 2026-10-08): create any
 * number of board games, each with its own timer, switch them on and off, and
 * set their order on the home page. The row's rules are the repository's
 * (`database/repositories/boards.js`) and the schema's; this file admits,
 * audits and drops the cached board list so the engine sees the change.
 *
 *   GET  /boards           every board, with the timer choices the server allows
 *   POST /boards           create (key and id prefix derived from the name)
 *   PUT  /boards/order     { keys: [every board, first to last] }
 *   PUT  /boards/:key      name, timer length, phases, stakes, enabled
 *   GET  /rtp              every board's RTP fund per profile (off when never set)
 *   PUT  /rtp/:game/:audience          { enabled, ratePercent }
 *   GET  /rtp/:game/:audience/entries  the fund's per-round entries, newest first
 */
import { authenticate, express, hasPermission } from './_adminShared.js';
import { db } from '#db';
import { invalidateBoards } from '../../domains/markets/cycleTypes.js';
import { respondError, refusal } from '../../shared/httpError.js';

const router = express.Router();
const ALLOWED = hasPermission('canManageGames');

const audit = (req, action, key, details) => db.audit.recordDetailed({
  performedBy: req.user.userId, action, category: 'GAMES',
  targetType: 'board', targetId: key, targetName: key, details,
  ip: req.ip, method: req.method, endpoint: req.originalUrl,
});

router.get('/boards', authenticate, ALLOWED, async (req, res) => {
  try {
    res.json({
      success: true,
      boards: await db.boards.listBoards(),
      intervalMinutes: db.boards.INTERVAL_DURATIONS_MIN,
      kinds: db.boards.BOARD_KINDS,
    });
  } catch (error) {
    return respondError(res, error, 'GET /admin/boards', { message: 'Failed to load boards' });
  }
});

router.post('/boards', authenticate, ALLOWED, async (req, res) => {
  try {
    const board = await db.boards.createBoard(req.body ?? {});
    invalidateBoards();
    await audit(req, 'BOARD_CREATED', board.key, { board });
    res.status(201).json({ success: true, board });
  } catch (error) {
    return respondError(res, error, 'POST /admin/boards', { message: 'Failed to create the board' });
  }
});

// Before `/boards/:key`, which would otherwise read "order" as a key.
router.put('/boards/order', authenticate, ALLOWED, async (req, res) => {
  try {
    const boards = await db.boards.setHomeOrder(req.body?.keys);
    invalidateBoards();
    await audit(req, 'BOARDS_REORDERED', 'ALL', { keys: boards.map((b) => b.key) });
    res.json({ success: true, boards });
  } catch (error) {
    return respondError(res, error, 'PUT /admin/boards/order', { message: 'Failed to save the order' });
  }
});

router.put('/boards/:key', authenticate, ALLOWED, async (req, res) => {
  try {
    const before = await db.boards.getBoard(req.params.key);
    if (!before) throw refusal(404, 'BOARD_NOT_FOUND', 'No such board.');
    const board = await db.boards.updateBoard(req.params.key, req.body ?? {});
    if (!board) throw refusal(404, 'BOARD_NOT_FOUND', 'No such board.');
    invalidateBoards();
    await audit(req, 'BOARD_UPDATED', board.key, { before, after: board });
    res.json({ success: true, board });
  } catch (error) {
    return respondError(res, error, 'PUT /admin/boards/:key', { message: 'Failed to save the board' });
  }
});

// ── RTP (owner, 2026-10-17): one fund per game and profile, rtp.js ──────────
router.get('/rtp', authenticate, ALLOWED, async (req, res) => {
  try {
    const [boards, funds] = await Promise.all([db.boards.listBoards(), db.rtp.listFunds()]);
    const byKey = new Map(funds.map((f) => [`${f.gameKey}:${f.audience}`, f]));
    const rows = boards.flatMap((b) => db.rtp.RTP_AUDIENCES.map((audience) => byKey.get(`${b.key}:${audience}`) ?? {
      gameKey: b.key, audience, enabled: false, rateBp: db.rtp.DEFAULT_RTP_RATE_BP,
      ratePercent: db.rtp.DEFAULT_RTP_RATE_BP / 100, balancePaise: 0, roundsHelped: 0, returnedPaise: 0,
    }));
    res.json({ success: true, funds: rows });
  } catch (error) {
    return respondError(res, error, 'GET /admin/rtp', { message: 'Failed to load the RTP funds' });
  }
});

router.put('/rtp/:game/:audience', authenticate, ALLOWED, async (req, res) => {
  try {
    if (!await db.boards.getBoard(req.params.game)) throw refusal(404, 'BOARD_NOT_FOUND', 'No such board.');
    const before = await db.rtp.getFund(req.params.game, req.params.audience);
    const fund = await db.rtp.saveSettings({
      gameKey: req.params.game, audience: req.params.audience,
      enabled: req.body?.enabled, ratePercent: req.body?.ratePercent, by: req.user.userId,
    });
    await audit(req, 'RTP_UPDATED', `${fund.gameKey}:${fund.audience}`, { before, after: fund });
    res.json({ success: true, fund });
  } catch (error) {
    return respondError(res, error, 'PUT /admin/rtp/:game/:audience', { message: 'Failed to save the RTP setting' });
  }
});

router.get('/rtp/:game/:audience/entries', authenticate, ALLOWED, async (req, res) => {
  try {
    res.json({ success: true, entries: await db.rtp.listEntries(req.params.game, req.params.audience, { limit: req.query.limit }) });
  } catch (error) {
    return respondError(res, error, 'GET /admin/rtp/:game/:audience/entries', { message: 'Failed to load the RTP entries' });
  }
});

export default router;
