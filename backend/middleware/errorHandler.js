// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Global Error Handler Middleware
 * Catches and handles all errors in the application
 */
export const errorHandler = (err, req, res, next) => {
    // Log error for debugging
    console.error('Error:', err);

    // Default error status and message
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    // Send error response
    res.status(status).json({
        success: false,
        message: message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};
