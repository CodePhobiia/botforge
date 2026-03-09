/**
 * Simple in-memory rate limiting with TTL cleanup.
 */

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

function createRateLimiter({ limit, windowMs = DEFAULT_WINDOW_MS, message }) {
    const hits = new Map();

    const cleanup = () => {
        const now = Date.now();
        for (const [key, entry] of hits.entries()) {
            if (entry.resetAt <= now) {
                hits.delete(key);
            }
        }
    };

    const interval = setInterval(cleanup, windowMs);
    if (typeof interval.unref === 'function') {
        interval.unref();
    }

    return function rateLimiter(req, res, next) {
        const key = getClientIp(req);
        const now = Date.now();
        let entry = hits.get(key);

        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }

        entry.count += 1;

        res.setHeader('X-RateLimit-Limit', String(limit));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

        if (entry.count > limit) {
            return res.status(429).json({ error: message || 'Too many requests, please try again later.' });
        }

        return next();
    };
}

const apiRateLimiter = createRateLimiter({
    limit: 100,
    windowMs: DEFAULT_WINDOW_MS,
    message: 'Too many requests, please try again later.'
});

const authRateLimiter = createRateLimiter({
    limit: 5,
    windowMs: DEFAULT_WINDOW_MS,
    message: 'Too many authentication attempts, please try again later.'
});

module.exports = {
    createRateLimiter,
    apiRateLimiter,
    authRateLimiter
};
