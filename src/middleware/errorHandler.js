/**
 * Global error handler for API/server errors.
 */

const path = require('path');

function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    const timestamp = new Date().toISOString();
    const status = err.statusCode || err.status || 500;
    const requestId = req.requestId;

    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body too large (max 1MB)' });
    }

    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'CORS origin denied' });
    }

    const isProd = process.env.NODE_ENV === 'production';
    const safeMessage = status >= 500 && isProd ? 'Internal server error' : err.message || 'Request failed';

    const logMessage = err.stack || err.message || String(err);
    if (requestId) {
        console.error(`[${timestamp}] [${requestId}] ${logMessage}`);
    } else {
        console.error(`[${timestamp}] ${logMessage}`);
    }

    if (status >= 500 && !req.path.startsWith('/api') && req.accepts('html')) {
        return res.status(status).sendFile(path.join(__dirname, '../../public/500.html'));
    }

    const payload = requestId ? { error: safeMessage, requestId } : { error: safeMessage };
    return res.status(status).json(payload);
}

module.exports = {
    errorHandler
};
