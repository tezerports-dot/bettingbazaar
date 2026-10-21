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
 *   GET  /boards/demo-results        every board's typed demo results, per profile
 *   GET  /boards/demo-results.csv    the same as one file (the template)
 *   POST /boards/demo-results/import { text }: that file back, all boards at once
 *   PUT  /boards/:key/demo-results   { audience, results: "B,D,B,…" }
 *   GET  /rtp              every board's RTP fund per profile, and each in-house
 *                          game's (`IN_HOUSE_GAMES`: Cricket, VIP only); off when never set
 *   PUT  /rtp/:game/:audience          { enabled, ratePercent }
 *   GET  /rtp/:game/:audience/entries  the fund's per-round entries, newest first
 */
import { authenticate, express, hasPermission } from './_adminShared.js';
import { db } from '#db';
import { invalidateBoards } from '../../domains/markets/cycleTypes.js';
import { respondError, refusal } from '../../shared/httpError.js';
import { toCsv } from '../../domains/reporting/csv.util.js';

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

// ── Demo results the admin types (owner, 2026-10-20) ─────────────────────────
// B (Bombay) and D (Delhi), oldest first, up to the analytics window, per board
// and profile (boards.js `setDemoResults`). They fill the analytics before the
// oldest real result exactly as the drawn ones do (redesign/DemoResults.tsx).
const demoSummary = (stored) => ({
  results: db.boards.demoResultsText(stored),
  count: stored.length,
  bombay: (stored.match(/B/g) ?? []).length,
  delhi: (stored.match(/D/g) ?? []).length,
});

router.get('/boards/demo-results', authenticate, ALLOWED, async (req, res) => {
  try {
    const boards = await db.boards.listBoards();
    res.json({
      success: true,
      max: db.boards.DEMO_RESULTS_MAX,
      audiences: db.boards.DEMO_AUDIENCES,
      boards: boards.map((b) => ({
        key: b.key, name: b.name, enabled: b.enabled,
        ...Object.fromEntries(db.boards.DEMO_AUDIENCES.map((a) => [a, demoSummary(b.demoResults[a])])),
      })),
    });
  } catch (error) {
    return respondError(res, error, 'GET /admin/boards/demo-results', { message: 'Failed to load the demo results' });
  }
});

router.get('/boards/demo-results.csv', authenticate, ALLOWED, async (req, res) => {
  try {
    const boards = await db.boards.listBoards();
    const rows = boards.flatMap((b) => db.boards.DEMO_AUDIENCES.map((a) => ({
      board: b.key, profile: a, results: db.boards.demoResultsText(b.demoResults[a]),
    })));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="demo-results.csv"');
    res.send(toCsv(rows));
  } catch (error) {
    return respondError(res, error, 'GET /admin/boards/demo-results.csv', { message: 'Could not build the file' });
  }
});

router.post('/boards/demo-results/import', authenticate, ALLOWED, async (req, res) => {
  try {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) throw refusal(400, 'EMPTY_DEMO_FILE', 'Choose a file to upload.');
    if (text.length > 200_000) throw refusal(400, 'DEMO_FILE_TOO_BIG', 'That file is too big for demo results.');
    const saved = await db.boards.importDemoResults(text);
    invalidateBoards();
    await audit(req, 'DEMO_RESULTS_IMPORTED', 'ALL', { saved });
    res.json({ success: true, saved });
  } catch (error) {
    return respondError(res, error, 'POST /admin/boards/demo-results/import', { message: 'Could not read that file' });
  }
});

router.put('/boards/:key/demo-results', authenticate, ALLOWED, async (req, res) => {
  try {
    const { audience, results } = req.body ?? {};
    if (typeof results !== 'string') throw refusal(400, 'INVALID_DEMO_RESULT', 'Send the results as text, e.g. "B,D,B,D".');
    const board = await db.boards.setDemoResults(req.params.key, audience, results);
    if (!board) throw refusal(404, 'BOARD_NOT_FOUND', 'No such board.');
    invalidateBoards();
    await audit(req, 'DEMO_RESULTS_SET', board.key, { audience, count: board.demoResults[audience].length });
    res.json({ success: true, key: board.key, audience, ...demoSummary(board.demoResults[audience]) });
  } catch (error) {
    return respondError(res, error, 'PUT /admin/boards/:key/demo-results', { message: 'Failed to save the demo results' });
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
    const games = [
      ...boards.map((b) => ({ key: b.key, name: b.name, audiences: db.rtp.RTP_AUDIENCES })),
      ...db.rtp.IN_HOUSE_GAMES,
    ];
    const rows = games.flatMap((g) => g.audiences.map((audience) => ({
      gameName: g.name,
      ...(byKey.get(`${g.key}:${audience}`) ?? {
        gameKey: g.key, audience, enabled: false, rateBp: db.rtp.DEFAULT_RTP_RATE_BP,
        ratePercent: db.rtp.DEFAULT_RTP_RATE_BP / 100, balancePaise: 0, roundsHelped: 0, returnedPaise: 0,
      }),
    })));
    res.json({ success: true, funds: rows });
  } catch (error) {
    return respondError(res, error, 'GET /admin/rtp', { message: 'Failed to load the RTP funds' });
  }
});

router.put('/rtp/:game/:audience', authenticate, ALLOWED, async (req, res) => {
  try {
    const inHouse = db.rtp.IN_HOUSE_GAMES.find((g) => g.key === req.params.game);
    if (inHouse && !inHouse.audiences.includes(req.params.audience)) {
      throw refusal(400, 'AUDIENCE_NOT_PLAYED', `${inHouse.name} is played from the ${inHouse.audiences.join(' and ')} wallet only.`);
    }
    if (!inHouse && !await db.boards.getBoard(req.params.game)) throw refusal(404, 'BOARD_NOT_FOUND', 'No such board.');
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
