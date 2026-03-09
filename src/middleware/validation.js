/**
 * Request validation + sanitization middleware for API routes.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_TOKEN_REGEX = /^[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{10,}$/;

const LIMITS = {
    passwordMin: 8,
    userNameMin: 2,
    userNameMax: 50,
    botNameMin: 2,
    botNameMax: 64,
    modelMax: 100,
    personalityMax: 2000,
    prefixMax: 10,
    arrayItemsMax: 100,
    arrayItemMaxLen: 100,
    apiKeyMax: 500
};

const ALLOWED_PROVIDERS = new Set(['openai', 'anthropic']);
const ALLOWED_TRIGGER_MODES = new Set(['mention', 'all', 'prefix']);
const ALLOWED_COLLAB_MODES = new Set(['off', 'reactive', 'proactive']);
const { normalizeSchedule } = require('../engine/Scheduler');

function stripHtml(input) {
    return input.replace(/<[^>]*>/g, '');
}

function sanitizeString(value) {
    return stripHtml(String(value)).trim();
}

function sanitizeObject(value) {
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeObject(item));
    }
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = sanitizeObject(item);
        }
        return result;
    }
    if (typeof value === 'string') {
        return sanitizeString(value);
    }
    return value;
}

function badRequest(res, message) {
    return res.status(400).json({ error: message });
}

function validateEmail(email) {
    return typeof email === 'string' && EMAIL_REGEX.test(email);
}

function validatePassword(password) {
    return typeof password === 'string' && password.length >= LIMITS.passwordMin;
}

function validateName(name, minLen, maxLen) {
    return typeof name === 'string' && name.length >= minLen && name.length <= maxLen;
}

function validateDiscordToken(token) {
    return typeof token === 'string' && DISCORD_TOKEN_REGEX.test(token);
}

function validateStringArray(value, { field, maxItems, maxLen }) {
    if (!Array.isArray(value)) {
        return `${field} must be an array`;
    }
    if (value.length > maxItems) {
        return `${field} exceeds maximum of ${maxItems} items`;
    }
    for (const item of value) {
        if (typeof item !== 'string') {
            return `${field} must contain only strings`;
        }
        if (!item.length || item.length > maxLen) {
            return `${field} items must be 1-${maxLen} characters`;
        }
    }
    return null;
}

function validateRateLimits(value) {
    if (value === null) return null;
    if (!value || typeof value !== 'object') {
        return 'rateLimits must be an object';
    }
    const sections = ['user', 'bot'];
    for (const section of sections) {
        if (value[section] === undefined) continue;
        if (!value[section] || typeof value[section] !== 'object') {
            return `${section} limits must be an object`;
        }
        for (const key of ['perMinute', 'perHour', 'perDay']) {
            if (value[section][key] === undefined) continue;
            const val = value[section][key];
            if (!Number.isInteger(val) || val < 0) {
                return `${section}.${key} must be a non-negative integer`;
            }
        }
    }
    return null;
}

function validateBotIdParam(req, res, next) {
    if (req.params) {
        req.params = sanitizeObject(req.params);
    }
    const { id } = req.params || {};
    if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
        return badRequest(res, 'Invalid bot id');
    }
    return next();
}

function validateRegister(req, res, next) {
    req.body = sanitizeObject(req.body || {});
    const { email, password, name } = req.body;

    if (!validateEmail(email)) {
        return badRequest(res, 'Valid email required');
    }
    if (!validatePassword(password)) {
        return badRequest(res, `Password must be at least ${LIMITS.passwordMin} characters`);
    }
    if (name && !validateName(name, LIMITS.userNameMin, LIMITS.userNameMax)) {
        return badRequest(res, `Name must be ${LIMITS.userNameMin}-${LIMITS.userNameMax} characters`);
    }
    return next();
}

function validateLogin(req, res, next) {
    req.body = sanitizeObject(req.body || {});
    const { email, password } = req.body;

    if (!validateEmail(email)) {
        return badRequest(res, 'Valid email required');
    }
    if (!validatePassword(password)) {
        return badRequest(res, `Password must be at least ${LIMITS.passwordMin} characters`);
    }
    return next();
}

function validateCreateBot(req, res, next) {
    req.body = sanitizeObject(req.body || {});
    const {
        name,
        discordToken,
        aiProvider,
        aiApiKey,
        model,
        personality,
        triggerMode,
        prefix,
        channels,
        collaborationMode,
        tools
    } = req.body;

    if (!validateName(name, LIMITS.botNameMin, LIMITS.botNameMax)) {
        return badRequest(res, `Bot name must be ${LIMITS.botNameMin}-${LIMITS.botNameMax} characters`);
    }
    if (!validateDiscordToken(discordToken)) {
        return badRequest(res, 'Valid Discord token required');
    }
    if (typeof aiApiKey !== 'string' || !aiApiKey.length || aiApiKey.length > LIMITS.apiKeyMax) {
        return badRequest(res, 'Valid AI API key required');
    }
    if (aiProvider && (!ALLOWED_PROVIDERS.has(aiProvider))) {
        return badRequest(res, 'Unsupported AI provider');
    }
    if (model && (typeof model !== 'string' || model.length > LIMITS.modelMax)) {
        return badRequest(res, `Model must be at most ${LIMITS.modelMax} characters`);
    }
    if (personality && (typeof personality !== 'string' || personality.length > LIMITS.personalityMax)) {
        return badRequest(res, `Personality must be at most ${LIMITS.personalityMax} characters`);
    }
    if (triggerMode && !ALLOWED_TRIGGER_MODES.has(triggerMode)) {
        return badRequest(res, 'Invalid trigger mode');
    }
    if (prefix && (typeof prefix !== 'string' || !prefix.length || prefix.length > LIMITS.prefixMax)) {
        return badRequest(res, `Prefix must be 1-${LIMITS.prefixMax} characters`);
    }
    if (channels !== undefined) {
        const error = validateStringArray(channels, {
            field: 'channels',
            maxItems: LIMITS.arrayItemsMax,
            maxLen: LIMITS.arrayItemMaxLen
        });
        if (error) return badRequest(res, error);
    }
    if (tools !== undefined) {
        const error = validateStringArray(tools, {
            field: 'tools',
            maxItems: LIMITS.arrayItemsMax,
            maxLen: LIMITS.arrayItemMaxLen
        });
        if (error) return badRequest(res, error);
    }
    if (collaborationMode && !ALLOWED_COLLAB_MODES.has(collaborationMode)) {
        return badRequest(res, 'Invalid collaboration mode');
    }

    return next();
}

function validateUpdateBot(req, res, next) {
    req.body = sanitizeObject(req.body || {});
    const updates = req.body;

    if (updates.name !== undefined && !validateName(updates.name, LIMITS.botNameMin, LIMITS.botNameMax)) {
        return badRequest(res, `Bot name must be ${LIMITS.botNameMin}-${LIMITS.botNameMax} characters`);
    }
    if (updates.discordToken !== undefined && !validateDiscordToken(updates.discordToken)) {
        return badRequest(res, 'Valid Discord token required');
    }
    if (updates.aiApiKey !== undefined) {
        if (typeof updates.aiApiKey !== 'string' || !updates.aiApiKey.length || updates.aiApiKey.length > LIMITS.apiKeyMax) {
            return badRequest(res, 'Valid AI API key required');
        }
    }
    if (updates.aiProvider !== undefined && !ALLOWED_PROVIDERS.has(updates.aiProvider)) {
        return badRequest(res, 'Unsupported AI provider');
    }
    if (updates.model !== undefined && (typeof updates.model !== 'string' || updates.model.length > LIMITS.modelMax)) {
        return badRequest(res, `Model must be at most ${LIMITS.modelMax} characters`);
    }
    if (updates.personality !== undefined) {
        if (typeof updates.personality !== 'string' || updates.personality.length > LIMITS.personalityMax) {
            return badRequest(res, `Personality must be at most ${LIMITS.personalityMax} characters`);
        }
    }
    if (updates.triggerMode !== undefined && !ALLOWED_TRIGGER_MODES.has(updates.triggerMode)) {
        return badRequest(res, 'Invalid trigger mode');
    }
    if (updates.prefix !== undefined) {
        if (typeof updates.prefix !== 'string' || !updates.prefix.length || updates.prefix.length > LIMITS.prefixMax) {
            return badRequest(res, `Prefix must be 1-${LIMITS.prefixMax} characters`);
        }
    }
    if (updates.channels !== undefined) {
        const error = validateStringArray(updates.channels, {
            field: 'channels',
            maxItems: LIMITS.arrayItemsMax,
            maxLen: LIMITS.arrayItemMaxLen
        });
        if (error) return badRequest(res, error);
    }
    if (updates.tools !== undefined) {
        const error = validateStringArray(updates.tools, {
            field: 'tools',
            maxItems: LIMITS.arrayItemsMax,
            maxLen: LIMITS.arrayItemMaxLen
        });
        if (error) return badRequest(res, error);
    }
    if (updates.collaborationMode !== undefined && !ALLOWED_COLLAB_MODES.has(updates.collaborationMode)) {
        return badRequest(res, 'Invalid collaboration mode');
    }
    if (updates.maxTokens !== undefined) {
        if (!Number.isInteger(updates.maxTokens) || updates.maxTokens < 1 || updates.maxTokens > 16384) {
            return badRequest(res, 'maxTokens must be an integer between 1 and 16384');
        }
    }
    if (updates.historyLimit !== undefined) {
        if (!Number.isInteger(updates.historyLimit) || updates.historyLimit < 1 || updates.historyLimit > 1000) {
            return badRequest(res, 'historyLimit must be an integer between 1 and 1000');
        }
    }
    if (updates.rateLimits !== undefined) {
        const error = validateRateLimits(updates.rateLimits);
        if (error) return badRequest(res, error);
    }

    return next();
}

function validateUpdateBotConfig(req, res, next) {
    req.body = sanitizeObject(req.body || {});
    const updates = req.body;

    if (updates.personality !== undefined) {
        if (typeof updates.personality !== 'string' || updates.personality.length > LIMITS.personalityMax) {
            return badRequest(res, `Personality must be at most ${LIMITS.personalityMax} characters`);
        }
    }
    if (updates.model !== undefined && (typeof updates.model !== 'string' || updates.model.length > LIMITS.modelMax)) {
        return badRequest(res, `Model must be at most ${LIMITS.modelMax} characters`);
    }
    if (updates.triggerMode !== undefined && !ALLOWED_TRIGGER_MODES.has(updates.triggerMode)) {
        return badRequest(res, 'Invalid trigger mode');
    }
    if (updates.tools !== undefined) {
        const error = validateStringArray(updates.tools, {
            field: 'tools',
            maxItems: LIMITS.arrayItemsMax,
            maxLen: LIMITS.arrayItemMaxLen
        });
        if (error) return badRequest(res, error);
    }
    if (updates.rateLimits !== undefined) {
        const error = validateRateLimits(updates.rateLimits);
        if (error) return badRequest(res, error);
    }

    return next();
}

function validateBotTools(req, res, next) {
    req.body = sanitizeObject(req.body || {});
    const { tools } = req.body;
    if (tools === undefined) {
        return badRequest(res, 'Tools array required');
    }
    const error = validateStringArray(tools, {
        field: 'tools',
        maxItems: LIMITS.arrayItemsMax,
        maxLen: LIMITS.arrayItemMaxLen
    });
    if (error) return badRequest(res, error);
    return next();
}

function validateBotSchedule(req, res, next) {
    req.body = sanitizeObject(req.body || {});
    const payload = req.body && Object.prototype.hasOwnProperty.call(req.body, 'schedule')
        ? req.body.schedule
        : req.body;
    const { schedule, error } = normalizeSchedule(payload);
    if (error) return badRequest(res, error);
    req.schedule = schedule;
    return next();
}

module.exports = {
    validateRegister,
    validateLogin,
    validateCreateBot,
    validateUpdateBot,
    validateUpdateBotConfig,
    validateBotIdParam,
    validateBotTools,
    validateBotSchedule,
    sanitizeObject
};
