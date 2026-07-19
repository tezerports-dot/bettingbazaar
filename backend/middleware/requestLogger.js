// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Structured Request Logger Middleware
 * Outputs production-ready logs for aggregation tools.
 */
export const requestLogger = (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const logData = {
            timestamp: new Date().toISOString(),
            reqId: req.id, // X-6: correlation id, echoed on the response too
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            userAgent: req.get('user-agent'),
            userId: req.user?.id || 'anonymous'
        };

        // In production, we log as stringified JSON for ingestion
        if (process.env.NODE_ENV === 'production') {
            console.log(JSON.stringify(logData));
        } else {
            const color = res.statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
            const rid = req.id ? ` \x1b[90m${String(req.id).slice(0, 8)}\x1b[0m` : '';
            console.log(`[API]${rid} ${color}${req.method} ${req.originalUrl} ${res.statusCode}\x1b[0m - ${duration}ms`);
        }
    });

    next();
};
