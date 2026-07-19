// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Global Error Handler Middleware
 * Catches and handles all errors in the application
 */
import { logger } from '../services/logger.js';

export const errorHandler = (err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    // X-6: structured error log carrying the correlation id + request context.
    logger.error(`Unhandled error: ${message}`, {
        status,
        method: req.method,
        url: req.originalUrl,
        code: err.code,
        stack: err.stack,
    });

    // Send error response — echo the correlation id so support/clients can
    // quote it and it can be found in the logs.
    res.status(status).json({
        success: false,
        message: message,
        requestId: req.id,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};
