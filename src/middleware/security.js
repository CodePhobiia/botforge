/**
 * Security middleware (headers, CORS, body size limits).
 */

const cors = require('cors');
const crypto = require('crypto');
const express = require('express');

const BODY_LIMIT = '1mb';

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
}

function parseAllowedOrigins() {
    const envValue = process.env.CORS_ORIGINS;
    if (!envValue) return null;
    const origins = envValue
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return origins.length ? origins : null;
}

function corsMiddleware(options = {}) {
    const allowedOrigins = options.origins || parseAllowedOrigins();
    const isProduction = process.env.NODE_ENV === 'production';
    const allowAll = !allowedOrigins && !isProduction;

    return cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowAll || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error('Not allowed by CORS'));
        },
        methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true
    });
}

const jsonBodyParser = express.json({ limit: BODY_LIMIT, strict: true });
const urlencodedBodyParser = express.urlencoded({ limit: BODY_LIMIT, extended: false });

function requestIdMiddleware(req, res, next) {
    const headerValue = req.headers['x-request-id'];
    const requestId = headerValue && String(headerValue).trim() ? String(headerValue).trim() : crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
}

module.exports = {
    securityHeaders,
    corsMiddleware,
    jsonBodyParser,
    urlencodedBodyParser,
    requestIdMiddleware
};
