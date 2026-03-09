/**
 * RateLimiter - In-memory rate limiting for users and bots.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

class RateLimiter {
    constructor(options = {}) {
        const defaultUserLimits = { perMinute: 20, perHour: 200, perDay: 1000 };
        const defaultBotLimits = { perMinute: 60, perHour: 500, perDay: 5000 };

        this.userLimits = { ...defaultUserLimits, ...(options.userLimits || {}) };
        this.botLimits = { ...defaultBotLimits, ...(options.botLimits || {}) };

        this.userBuckets = new Map();
        this.botBuckets = new Map();

        this.messages = {
            minute: 'You are sending messages too fast. Please wait a bit and try again.',
            hour: 'You have hit the hourly message limit. Please try again later.',
            day: 'You have hit the daily message limit. Please try again tomorrow.',
            ...(options.messages || {})
        };
    }

    checkAndRecord({ userId, botId, limits } = {}) {
        const now = Date.now();

        const userLimits = this._mergeLimits(this.userLimits, limits?.user);
        const botLimits = this._mergeLimits(this.botLimits, limits?.bot);

        const userResult = this._checkBucket(this.userBuckets, userId, userLimits, now);
        if (!userResult.allowed) return userResult;

        const botResult = this._checkBucket(this.botBuckets, botId, botLimits, now);
        if (!botResult.allowed) return botResult;

        this._record(this.userBuckets, userId, now);
        this._record(this.botBuckets, botId, now);

        return { allowed: true };
    }

    _mergeLimits(base, overrides) {
        if (!overrides || typeof overrides !== 'object') return base;
        return { ...base, ...overrides };
    }

    _record(map, key, timestamp) {
        if (!key) return;
        const bucket = map.get(key) || [];
        bucket.push(timestamp);
        this._prune(bucket, timestamp - DAY_MS);
        map.set(key, bucket);
    }

    _checkBucket(map, key, limits, now) {
        if (!key) return { allowed: true };
        const bucket = map.get(key) || [];
        this._prune(bucket, now - DAY_MS);

        const windows = [
            { name: 'minute', limit: limits.perMinute, windowMs: MINUTE_MS },
            { name: 'hour', limit: limits.perHour, windowMs: HOUR_MS },
            { name: 'day', limit: limits.perDay, windowMs: DAY_MS }
        ];

        for (const window of windows) {
            if (!window.limit) continue;
            const windowStart = now - window.windowMs;
            const { count, earliest } = this._countSince(bucket, windowStart);

            if (count >= window.limit) {
                const retryAfterMs = earliest ? (earliest + window.windowMs - now) : window.windowMs;
                const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
                return {
                    allowed: false,
                    retryAfterSeconds,
                    message: `${this.messages[window.name]} Try again in ${retryAfterSeconds}s.`
                };
            }
        }

        return { allowed: true };
    }

    _countSince(bucket, windowStart) {
        let count = 0;
        let earliest = null;
        for (const ts of bucket) {
            if (ts >= windowStart) {
                count++;
                if (earliest === null) earliest = ts;
            }
        }
        return { count, earliest };
    }

    _prune(bucket, cutoff) {
        while (bucket.length > 0 && bucket[0] < cutoff) {
            bucket.shift();
        }
    }
}

module.exports = { RateLimiter };
