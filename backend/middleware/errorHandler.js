// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Global Error Handler Middleware
 * Catches and handles all errors in the application
 */
import { logger } from '../services/logger.js';

export const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    // ── What the caller is told is decided by the PRESENCE of a status ──────
    // The same rule as `respondError` (shared/httpError.js, §2). A status was
    // chosen by whoever threw — a body-parser 400, a 413, a refusal a handler
    // wrote — and its wording is the feature. No status means nobody decided:
    // a driver fault, a TypeError, a path. Before 2026-10-01 this handler sent
    // `err.message` (and, in development, the STACK) for those too, so every
    // route whose async handler threw past its own catch — Express 5 forwards
    // all of them here — handed the caller the server's internal text.
    const decided = Boolean(err?.status || err?.statusCode);
    const status = decided ? (err.status || err.statusCode) : 500;

    // X-6: structured error log carrying the correlation id + request context.
    // Logged in full either way: the operator needs the real error.
    logger.error(`Unhandled error: ${err?.message || err}`, {
        status,
        method: req.method,
        url: req.originalUrl,
        code: err?.code,
        stack: err?.stack,
    });

    // The correlation id is echoed so support/clients can quote it and it can
    // be found in the logs — which is where the detail lives.
    res.status(status).json({
        success: false,
        message: decided && err.message
            ? err.message
            : 'Something went wrong. Please try again.',
        requestId: req.id,
    });
};
