const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { encrypt, decrypt } = require('./encryption');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'botforge.db');

let db;

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

        CREATE INDEX IF NOT EXISTS idx_bots_user_id ON bots(user_id);
        CREATE INDEX IF NOT EXISTS idx_bot_logs_bot_id ON bot_logs(bot_id);
    `);

    return db;
}

const database = initDatabase();

const statements = {
    insertUser: database.prepare(`
        INSERT INTO users (id, email, password_hash, name, created_at)
        VALUES (@id, @email, @password_hash, @name, @created_at)
    `),
    getUserByEmail: database.prepare('SELECT * FROM users WHERE email = ?'),
    getUserById: database.prepare('SELECT * FROM users WHERE id = ?'),
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
    `)
};

function toIso(value) {
    if (!value) return new Date().toISOString();
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
}

function safeJsonParse(value, fallback) {
    if (value === null || value === undefined) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function mapUserRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        name: row.name,
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

function createUser({ id, email, passwordHash, name }) {
    const createdAt = new Date().toISOString();
    statements.insertUser.run({
        id,
        email,
        password_hash: passwordHash,
        name,
        created_at: createdAt
    });
    return { id, email, name, passwordHash, createdAt: new Date(createdAt) };
}

function getUserByEmail(email) {
    return mapUserRow(statements.getUserByEmail.get(email));
}

function getUserById(id) {
    return mapUserRow(statements.getUserById.get(id));
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

module.exports = {
    initDatabase,
    createUser,
    getUserByEmail,
    getUserById,
    createBot,
    listBotsByUser,
    listAllBots,
    getBotById,
    updateBot,
    deleteBot,
    logBotEvent,
    getLatestBotStatusEvent
};
