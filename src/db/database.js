const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { encrypt, decrypt } = require('./encryption');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'botforge.db');

let db;

function ensureUserColumns(database) {
    const columns = database.prepare(`PRAGMA table_info(users)`).all().map((row) => row.name);
    const addColumn = (name, type) => {
        if (!columns.includes(name)) {
            database.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
        }
    };

    addColumn('discord_id', 'TEXT');
    addColumn('discord_username', 'TEXT');
    addColumn('avatar_url', 'TEXT');

    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id)');
}

function initDatabase() {
    if (db) return db;

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            name TEXT,
            discord_id TEXT,
            discord_username TEXT,
            avatar_url TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bots (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            discord_token_encrypted TEXT NOT NULL,
            ai_provider TEXT NOT NULL,
            ai_api_key_encrypted TEXT NOT NULL,
            model TEXT NOT NULL,
            personality TEXT NOT NULL,
            trigger_mode TEXT NOT NULL,
            prefix TEXT NOT NULL,
            channels_json TEXT NOT NULL,
            tools_json TEXT NOT NULL,
            max_tokens INTEGER NOT NULL,
            history_limit INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bot_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            message TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bot_analytics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            hour_start TEXT NOT NULL,
            messages_sent INTEGER NOT NULL DEFAULT 0,
            messages_received INTEGER NOT NULL DEFAULT 0,
            commands_used TEXT NOT NULL DEFAULT '{}',
            errors INTEGER NOT NULL DEFAULT 0,
            uptime_ms INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_bots_user_id ON bots(user_id);
        CREATE INDEX IF NOT EXISTS idx_bot_logs_bot_id ON bot_logs(bot_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_analytics_bot_hour ON bot_analytics(bot_id, hour_start);
        CREATE INDEX IF NOT EXISTS idx_bot_analytics_bot_id ON bot_analytics(bot_id);
    `);

    ensureUserColumns(db);

    return db;
}

const database = initDatabase();

const statements = {
    insertUser: database.prepare(`
        INSERT INTO users (id, email, password_hash, name, discord_id, discord_username, avatar_url, created_at)
        VALUES (@id, @email, @password_hash, @name, @discord_id, @discord_username, @avatar_url, @created_at)
    `),
    getUserByEmail: database.prepare('SELECT * FROM users WHERE email = ?'),
    getUserById: database.prepare('SELECT * FROM users WHERE id = ?'),
    getUserByDiscordId: database.prepare('SELECT * FROM users WHERE discord_id = ?'),
    updateDiscordProfile: database.prepare(`
        UPDATE users SET
            discord_id = @discord_id,
            discord_username = @discord_username,
            avatar_url = @avatar_url,
            email = COALESCE(@email, email)
        WHERE id = @id
    `),
    insertBot: database.prepare(`
        INSERT INTO bots (
            id, user_id, name, discord_token_encrypted, ai_provider,
            ai_api_key_encrypted, model, personality, trigger_mode, prefix,
            channels_json, tools_json, max_tokens, history_limit,
            created_at, updated_at
        ) VALUES (
            @id, @user_id, @name, @discord_token_encrypted, @ai_provider,
            @ai_api_key_encrypted, @model, @personality, @trigger_mode, @prefix,
            @channels_json, @tools_json, @max_tokens, @history_limit,
            @created_at, @updated_at
        )
    `),
    updateBot: database.prepare(`
        UPDATE bots SET
            name = @name,
            discord_token_encrypted = @discord_token_encrypted,
            ai_provider = @ai_provider,
            ai_api_key_encrypted = @ai_api_key_encrypted,
            model = @model,
            personality = @personality,
            trigger_mode = @trigger_mode,
            prefix = @prefix,
            channels_json = @channels_json,
            tools_json = @tools_json,
            max_tokens = @max_tokens,
            history_limit = @history_limit,
            updated_at = @updated_at
        WHERE id = @id AND user_id = @user_id
    `),
    deleteBot: database.prepare('DELETE FROM bots WHERE id = ? AND user_id = ?'),
    listBotsByUser: database.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at ASC'),
    getBotById: database.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?'),
    listAllBots: database.prepare('SELECT * FROM bots ORDER BY created_at ASC'),
    insertBotLog: database.prepare(`
        INSERT INTO bot_logs (bot_id, event_type, message, created_at)
        VALUES (@bot_id, @event_type, @message, @created_at)
    `),
    getLatestStatusLog: database.prepare(`
        SELECT * FROM bot_logs
        WHERE bot_id = ? AND event_type IN ('started', 'stopped')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `),
    getAnalyticsRow: database.prepare(`
        SELECT * FROM bot_analytics
        WHERE bot_id = ? AND hour_start = ?
        LIMIT 1
    `),
    insertAnalyticsRow: database.prepare(`
        INSERT INTO bot_analytics (
            bot_id, hour_start, messages_sent, messages_received,
            commands_used, errors, uptime_ms, created_at, updated_at
        ) VALUES (
            @bot_id, @hour_start, @messages_sent, @messages_received,
            @commands_used, @errors, @uptime_ms, @created_at, @updated_at
        )
    `),
    updateAnalyticsRow: database.prepare(`
        UPDATE bot_analytics SET
            messages_sent = @messages_sent,
            messages_received = @messages_received,
            commands_used = @commands_used,
            errors = @errors,
            uptime_ms = @uptime_ms,
            updated_at = @updated_at
        WHERE bot_id = @bot_id AND hour_start = @hour_start
    `),
    listAnalyticsRange: database.prepare(`
        SELECT * FROM bot_analytics
        WHERE bot_id = ? AND hour_start >= ?
        ORDER BY hour_start ASC
    `)
};

function toIso(value) {
    if (!value) return new Date().toISOString();
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
}

function toHourStart(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());
    date.setMinutes(0, 0, 0);
    return date.toISOString();
}

function safeJsonParse(value, fallback) {
    if (value === null || value === undefined) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function mergeCommandCounts(current, additions) {
    const merged = { ...(current || {}) };
    if (!additions) return merged;
    for (const [key, count] of Object.entries(additions)) {
        if (!key) continue;
        const normalized = key.toString().toLowerCase();
        const increment = Number.isFinite(count) ? count : 0;
        if (increment === 0) continue;
        merged[normalized] = (merged[normalized] || 0) + increment;
    }
    return merged;
}

function mapUserRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        name: row.name,
        discordId: row.discord_id,
        discordUsername: row.discord_username,
        avatarUrl: row.avatar_url,
        passwordHash: row.password_hash,
        createdAt: new Date(row.created_at)
    };
}

function mapBotRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        discordToken: decrypt(row.discord_token_encrypted),
        aiProvider: row.ai_provider,
        aiApiKey: decrypt(row.ai_api_key_encrypted),
        model: row.model,
        personality: row.personality,
        triggerMode: row.trigger_mode,
        prefix: row.prefix,
        channels: safeJsonParse(row.channels_json, []),
        tools: safeJsonParse(row.tools_json, []),
        maxTokens: row.max_tokens,
        historyLimit: row.history_limit,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at)
    };
}

function createUser({ id, email, passwordHash, name, discordId = null, discordUsername = null, avatarUrl = null }) {
    const createdAt = new Date().toISOString();
    statements.insertUser.run({
        id,
        email,
        password_hash: passwordHash,
        name,
        discord_id: discordId,
        discord_username: discordUsername,
        avatar_url: avatarUrl,
        created_at: createdAt
    });
    return {
        id,
        email,
        name,
        discordId,
        discordUsername,
        avatarUrl,
        passwordHash,
        createdAt: new Date(createdAt)
    };
}

function getUserByEmail(email) {
    return mapUserRow(statements.getUserByEmail.get(email));
}

function getUserById(id) {
    return mapUserRow(statements.getUserById.get(id));
}

function findByDiscordId(discordId) {
    return mapUserRow(statements.getUserByDiscordId.get(discordId));
}

function updateDiscordProfile(userId, { discordId, discordUsername, avatarUrl, email }) {
    statements.updateDiscordProfile.run({
        id: userId,
        discord_id: discordId,
        discord_username: discordUsername,
        avatar_url: avatarUrl,
        email: email ?? null
    });
    return getUserById(userId);
}

function createFromDiscord({ id, email, passwordHash, name, discordId, discordUsername, avatarUrl }) {
    return createUser({
        id,
        email,
        passwordHash,
        name,
        discordId,
        discordUsername,
        avatarUrl
    });
}

function createBot(config) {
    const createdAt = config.createdAt ? toIso(config.createdAt) : new Date().toISOString();
    const updatedAt = config.updatedAt ? toIso(config.updatedAt) : createdAt;
    const channelsValue = config.channels === undefined ? [] : config.channels;
    const toolsValue = config.tools === undefined ? [] : config.tools;
    const payload = {
        id: config.id,
        user_id: config.userId,
        name: config.name,
        discord_token_encrypted: encrypt(config.discordToken),
        ai_provider: config.aiProvider,
        ai_api_key_encrypted: encrypt(config.aiApiKey),
        model: config.model,
        personality: config.personality,
        trigger_mode: config.triggerMode,
        prefix: config.prefix,
        channels_json: JSON.stringify(channelsValue),
        tools_json: JSON.stringify(toolsValue),
        max_tokens: config.maxTokens ?? 1024,
        history_limit: config.historyLimit ?? 20,
        created_at: createdAt,
        updated_at: updatedAt
    };
    statements.insertBot.run(payload);
    return {
        ...config,
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt)
    };
}

function listBotsByUser(userId) {
    const rows = statements.listBotsByUser.all(userId);
    return rows.map(mapBotRow);
}

function listAllBots() {
    const rows = statements.listAllBots.all();
    return rows.map(mapBotRow);
}

function getBotById(userId, botId) {
    return mapBotRow(statements.getBotById.get(botId, userId));
}

function updateBot(userId, botId, updates) {
    const existingRow = statements.getBotById.get(botId, userId);
    if (!existingRow) return null;

    const config = mapBotRow(existingRow);
    const hasProp = (key) => Object.prototype.hasOwnProperty.call(updates, key);

    if (hasProp('name')) config.name = updates.name;
    if (hasProp('discordToken')) config.discordToken = updates.discordToken;
    if (hasProp('aiProvider')) config.aiProvider = updates.aiProvider;
    if (hasProp('aiApiKey')) config.aiApiKey = updates.aiApiKey;
    if (hasProp('model')) config.model = updates.model;
    if (hasProp('personality')) config.personality = updates.personality;
    if (hasProp('triggerMode')) config.triggerMode = updates.triggerMode;
    if (hasProp('prefix')) config.prefix = updates.prefix;
    if (hasProp('channels')) config.channels = updates.channels;
    if (hasProp('tools')) config.tools = updates.tools;
    if (hasProp('maxTokens')) config.maxTokens = updates.maxTokens;
    if (hasProp('historyLimit')) config.historyLimit = updates.historyLimit;

    const updatedAt = new Date();
    config.updatedAt = updatedAt;
    const channelsValue = config.channels === undefined ? [] : config.channels;
    const toolsValue = config.tools === undefined ? [] : config.tools;

    statements.updateBot.run({
        id: botId,
        user_id: userId,
        name: config.name,
        discord_token_encrypted: encrypt(config.discordToken),
        ai_provider: config.aiProvider,
        ai_api_key_encrypted: encrypt(config.aiApiKey),
        model: config.model,
        personality: config.personality,
        trigger_mode: config.triggerMode,
        prefix: config.prefix,
        channels_json: JSON.stringify(channelsValue),
        tools_json: JSON.stringify(toolsValue),
        max_tokens: config.maxTokens ?? 1024,
        history_limit: config.historyLimit ?? 20,
        updated_at: updatedAt.toISOString()
    });

    return config;
}

function deleteBot(userId, botId) {
    const result = statements.deleteBot.run(botId, userId);
    return result.changes > 0;
}

function logBotEvent(botId, eventType, message) {
    statements.insertBotLog.run({
        bot_id: botId,
        event_type: eventType,
        message: message || null,
        created_at: new Date().toISOString()
    });
}

function getLatestBotStatusEvent(botId) {
    const row = statements.getLatestStatusLog.get(botId);
    if (!row) return null;
    return {
        id: row.id,
        botId: row.bot_id,
        eventType: row.event_type,
        message: row.message,
        createdAt: row.created_at
    };
}

const applyAnalyticsUpdate = database.transaction((botId, hourStart, updates) => {
    if (!botId || !hourStart) return;
    const row = statements.getAnalyticsRow.get(botId, hourStart);
    const nowIso = new Date().toISOString();
    const deltaSent = Number.isFinite(updates.messagesSent) ? updates.messagesSent : 0;
    const deltaReceived = Number.isFinite(updates.messagesReceived) ? updates.messagesReceived : 0;
    const deltaErrors = Number.isFinite(updates.errors) ? updates.errors : 0;
    const deltaUptime = Number.isFinite(updates.uptimeMs) ? updates.uptimeMs : 0;
    const commandUpdates = updates.commandsUsed || null;

    if (row) {
        const mergedCommands = mergeCommandCounts(safeJsonParse(row.commands_used, {}), commandUpdates);
        statements.updateAnalyticsRow.run({
            bot_id: botId,
            hour_start: hourStart,
            messages_sent: (row.messages_sent || 0) + deltaSent,
            messages_received: (row.messages_received || 0) + deltaReceived,
            commands_used: JSON.stringify(mergedCommands),
            errors: (row.errors || 0) + deltaErrors,
            uptime_ms: (row.uptime_ms || 0) + deltaUptime,
            updated_at: nowIso
        });
        return;
    }

    const initialCommands = mergeCommandCounts({}, commandUpdates);
    statements.insertAnalyticsRow.run({
        bot_id: botId,
        hour_start: hourStart,
        messages_sent: deltaSent,
        messages_received: deltaReceived,
        commands_used: JSON.stringify(initialCommands),
        errors: deltaErrors,
        uptime_ms: deltaUptime,
        created_at: nowIso,
        updated_at: nowIso
    });
});

function recordBotMessageReceived(botId, commandName, timestamp) {
    if (!botId) return;
    const hourStart = toHourStart(timestamp);
    const commands = commandName ? { [commandName]: 1 } : null;
    applyAnalyticsUpdate(botId, hourStart, { messagesReceived: 1, commandsUsed: commands });
}

function recordBotMessageSent(botId, count = 1, timestamp) {
    if (!botId) return;
    const safeCount = Number.isFinite(count) ? count : 0;
    if (safeCount <= 0) return;
    const hourStart = toHourStart(timestamp);
    applyAnalyticsUpdate(botId, hourStart, { messagesSent: safeCount });
}

function recordBotError(botId, timestamp) {
    if (!botId) return;
    const hourStart = toHourStart(timestamp);
    applyAnalyticsUpdate(botId, hourStart, { errors: 1 });
}

function recordBotUptime(botId, startAt, endAt) {
    if (!botId || !startAt) return;
    const start = startAt instanceof Date ? new Date(startAt.getTime()) : new Date(startAt);
    const end = endAt ? (endAt instanceof Date ? new Date(endAt.getTime()) : new Date(endAt)) : new Date();
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return;
    if (end <= start) return;

    let cursor = new Date(start.getTime());
    while (cursor < end) {
        const hourStartDate = new Date(cursor.getTime());
        hourStartDate.setMinutes(0, 0, 0);
        const hourEnd = new Date(hourStartDate.getTime());
        hourEnd.setHours(hourEnd.getHours() + 1);

        const segmentEnd = end < hourEnd ? end : hourEnd;
        const durationMs = Math.max(0, segmentEnd - cursor);
        if (durationMs > 0) {
            applyAnalyticsUpdate(botId, hourStartDate.toISOString(), { uptimeMs: durationMs });
        }
        cursor = segmentEnd;
    }
}

function getBotAnalytics(botId, rangeHours = 24) {
    if (!botId) return null;
    const hours = Number.isFinite(rangeHours) && rangeHours > 0 ? Math.round(rangeHours) : 24;
    const now = new Date();
    const endHour = new Date(now.getTime());
    endHour.setMinutes(0, 0, 0);
    const startHour = new Date(endHour.getTime() - (hours - 1) * 60 * 60 * 1000);
    const rows = statements.listAnalyticsRange.all(botId, startHour.toISOString());
    const rowMap = new Map();
    rows.forEach(row => {
        rowMap.set(row.hour_start, row);
    });

    const labels = [];
    const messagesSent = [];
    const messagesReceived = [];
    const errors = [];
    const uptimeMs = [];

    let totalSent = 0;
    let totalReceived = 0;
    let totalErrors = 0;
    let totalUptime = 0;
    const commandTotals = {};

    for (let i = 0; i < hours; i++) {
        const hour = new Date(startHour.getTime() + i * 60 * 60 * 1000);
        const hourKey = hour.toISOString();
        const row = rowMap.get(hourKey);
        const sent = row ? row.messages_sent || 0 : 0;
        const received = row ? row.messages_received || 0 : 0;
        const errorCount = row ? row.errors || 0 : 0;
        const uptime = row ? row.uptime_ms || 0 : 0;

        labels.push(hourKey);
        messagesSent.push(sent);
        messagesReceived.push(received);
        errors.push(errorCount);
        uptimeMs.push(uptime);

        totalSent += sent;
        totalReceived += received;
        totalErrors += errorCount;
        totalUptime += uptime;

        if (row && row.commands_used) {
            const parsed = safeJsonParse(row.commands_used, {});
            for (const [cmd, count] of Object.entries(parsed)) {
                if (!cmd) continue;
                const normalized = cmd.toString().toLowerCase();
                commandTotals[normalized] = (commandTotals[normalized] || 0) + (Number.isFinite(count) ? count : 0);
            }
        }
    }

    const topCommands = Object.entries(commandTotals)
        .map(([command, count]) => ({ command, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    const rangeMs = hours * 60 * 60 * 1000;
    const uptimePct = rangeMs > 0 ? Math.min(100, (totalUptime / rangeMs) * 100) : 0;
    const totalMessages = totalSent + totalReceived;
    const errorRate = totalMessages > 0 ? (totalErrors / totalMessages) * 100 : 0;

    return {
        range: {
            hours,
            start: startHour.toISOString(),
            end: new Date(endHour.getTime() + 60 * 60 * 1000).toISOString()
        },
        totals: {
            messagesSent: totalSent,
            messagesReceived: totalReceived,
            errors: totalErrors,
            uptimeMs: totalUptime,
            uptimePct,
            errorRate
        },
        topCommands,
        series: {
            labels,
            messagesSent,
            messagesReceived,
            errors,
            uptimeMs
        }
    };
}

module.exports = {
    initDatabase,
    createUser,
    getUserByEmail,
    getUserById,
    findByDiscordId,
    updateDiscordProfile,
    createFromDiscord,
    createBot,
    listBotsByUser,
    listAllBots,
    getBotById,
    updateBot,
    deleteBot,
    logBotEvent,
    getLatestBotStatusEvent,
    recordBotMessageReceived,
    recordBotMessageSent,
    recordBotError,
    recordBotUptime,
    getBotAnalytics
};
