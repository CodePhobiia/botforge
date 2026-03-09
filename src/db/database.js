const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { encrypt, decrypt } = require('./encryption');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = process.env.BOTFORGE_DB_PATH || path.join(DATA_DIR, 'botforge.db');

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

function ensureBotColumns(database) {
    const columns = database.prepare(`PRAGMA table_info(bots)`).all().map((row) => row.name);
    const addColumn = (name, type) => {
        if (!columns.includes(name)) {
            database.exec(`ALTER TABLE bots ADD COLUMN ${name} ${type}`);
        }
    };

    addColumn('rate_limits_json', 'TEXT');
    addColumn('automod_config_json', 'TEXT');
    addColumn('schedule_json', 'TEXT');
}

function initDatabase() {
    if (db) return db;

    if (DB_PATH !== ':memory:') {
        const dbDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
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
            rate_limits_json TEXT,
            automod_config_json TEXT,
            schedule_json TEXT,
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

        CREATE TABLE IF NOT EXISTS conversation_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            user_id TEXT,
            username TEXT,
            channel_id TEXT,
            channel_name TEXT,
            message_content TEXT,
            bot_response TEXT,
            timestamp TEXT NOT NULL,
            model_used TEXT,
            tokens_used INTEGER,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS bot_analytics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            command TEXT,
            count INTEGER,
            duration_ms INTEGER,
            start_at TEXT,
            end_at TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS automod_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            user_id TEXT,
            username TEXT,
            guild_id TEXT,
            channel_id TEXT,
            violation_type TEXT NOT NULL,
            action_taken TEXT NOT NULL,
            message_content TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS slash_commands (
            id TEXT PRIMARY KEY,
            bot_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            type TEXT NOT NULL,
            response_template TEXT,
            options_json TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_bots_user_id ON bots(user_id);
        CREATE INDEX IF NOT EXISTS idx_bot_logs_bot_id ON bot_logs(bot_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_logs_bot_id ON conversation_logs(bot_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_logs_bot_time ON conversation_logs(bot_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_bot_analytics_bot_id ON bot_analytics(bot_id);
        CREATE INDEX IF NOT EXISTS idx_bot_analytics_bot_time ON bot_analytics(bot_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_bot_analytics_bot_event ON bot_analytics(bot_id, event_type);
        CREATE INDEX IF NOT EXISTS idx_automod_logs_bot_id ON automod_logs(bot_id);
        CREATE INDEX IF NOT EXISTS idx_automod_logs_bot_time ON automod_logs(bot_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_automod_logs_violation ON automod_logs(bot_id, violation_type);
        CREATE INDEX IF NOT EXISTS idx_slash_commands_bot_id ON slash_commands(bot_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_slash_commands_bot_name ON slash_commands(bot_id, name);
    `);

    ensureUserColumns(db);
    ensureBotColumns(db);

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
            channels_json, tools_json, rate_limits_json, automod_config_json, schedule_json, max_tokens, history_limit,
            created_at, updated_at
        ) VALUES (
            @id, @user_id, @name, @discord_token_encrypted, @ai_provider,
            @ai_api_key_encrypted, @model, @personality, @trigger_mode, @prefix,
            @channels_json, @tools_json, @rate_limits_json, @automod_config_json, @schedule_json, @max_tokens, @history_limit,
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
            rate_limits_json = @rate_limits_json,
            automod_config_json = @automod_config_json,
            schedule_json = @schedule_json,
            max_tokens = @max_tokens,
            history_limit = @history_limit,
            updated_at = @updated_at
        WHERE id = @id AND user_id = @user_id
    `),
    deleteBot: database.prepare('DELETE FROM bots WHERE id = ? AND user_id = ?'),
    listBotsByUser: database.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at ASC'),
    getBotById: database.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?'),
    listAllBots: database.prepare('SELECT * FROM bots ORDER BY created_at ASC'),
    insertSlashCommand: database.prepare(`
        INSERT INTO slash_commands (
            id, bot_id, name, description, type, response_template, options_json, enabled, created_at
        ) VALUES (
            @id, @bot_id, @name, @description, @type, @response_template, @options_json, @enabled, @created_at
        )
    `),
    listSlashCommandsByBot: database.prepare(`
        SELECT * FROM slash_commands
        WHERE bot_id = ?
        ORDER BY created_at ASC, id ASC
    `),
    getSlashCommandById: database.prepare(`
        SELECT * FROM slash_commands
        WHERE id = ? AND bot_id = ?
    `),
    updateSlashCommand: database.prepare(`
        UPDATE slash_commands SET
            name = @name,
            description = @description,
            type = @type,
            response_template = @response_template,
            options_json = @options_json,
            enabled = @enabled
        WHERE id = @id AND bot_id = @bot_id
    `),
    deleteSlashCommand: database.prepare('DELETE FROM slash_commands WHERE id = ? AND bot_id = ?'),
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
    insertConversationLog: database.prepare(`
        INSERT INTO conversation_logs (
            bot_id, user_id, username, channel_id, channel_name,
            message_content, bot_response, timestamp, model_used, tokens_used
        ) VALUES (
            @bot_id, @user_id, @username, @channel_id, @channel_name,
            @message_content, @bot_response, @timestamp, @model_used, @tokens_used
        )
    `),
    insertAutomodLog: database.prepare(`
        INSERT INTO automod_logs (
            bot_id, user_id, username, guild_id, channel_id,
            violation_type, action_taken, message_content, timestamp
        ) VALUES (
            @bot_id, @user_id, @username, @guild_id, @channel_id,
            @violation_type, @action_taken, @message_content, @timestamp
        )
    `),
    getConversationsByBot: database.prepare(`
        SELECT * FROM conversation_logs
        WHERE bot_id = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT ? OFFSET ?
    `),
    getAutomodLogs: database.prepare(`
        SELECT * FROM automod_logs
        WHERE bot_id = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT ? OFFSET ?
    `),
    getAutomodStatsTotal: database.prepare(`
        SELECT COUNT(*) as total FROM automod_logs
        WHERE bot_id = ?
    `),
    getAutomodStatsByViolation: database.prepare(`
        SELECT violation_type, COUNT(*) as count
        FROM automod_logs
        WHERE bot_id = ?
        GROUP BY violation_type
        ORDER BY count DESC
    `),
    getAutomodStatsByAction: database.prepare(`
        SELECT action_taken, COUNT(*) as count
        FROM automod_logs
        WHERE bot_id = ?
        GROUP BY action_taken
        ORDER BY count DESC
    `),
    searchConversationsByBot: database.prepare(`
        SELECT * FROM conversation_logs
        WHERE bot_id = @bot_id AND (
            message_content LIKE @pattern OR
            bot_response LIKE @pattern OR
            username LIKE @pattern OR
            channel_name LIKE @pattern
        )
        ORDER BY timestamp DESC, id DESC
        LIMIT 200
    `),
    getAllConversationsByBot: database.prepare(`
        SELECT * FROM conversation_logs
        WHERE bot_id = ?
        ORDER BY timestamp ASC, id ASC
    `),
    insertBotAnalytics: database.prepare(`
        INSERT INTO bot_analytics (
            bot_id, event_type, command, count, duration_ms, start_at, end_at, timestamp
        ) VALUES (
            @bot_id, @event_type, @command, @count, @duration_ms, @start_at, @end_at, @timestamp
        )
    `),
    getBotAnalyticsByRange: database.prepare(`
        SELECT * FROM bot_analytics
        WHERE bot_id = ? AND timestamp >= ?
        ORDER BY timestamp ASC, id ASC
    `),
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
        rateLimits: safeJsonParse(row.rate_limits_json, null),
        automodConfig: safeJsonParse(row.automod_config_json, null),
        schedule: safeJsonParse(row.schedule_json, null),
        maxTokens: row.max_tokens,
        historyLimit: row.history_limit,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at)
    };
}

function mapConversationRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        botId: row.bot_id,
        userId: row.user_id,
        username: row.username,
        channelId: row.channel_id,
        channelName: row.channel_name,
        messageContent: row.message_content,
        botResponse: row.bot_response,
        timestamp: row.timestamp,
        modelUsed: row.model_used,
        tokensUsed: row.tokens_used
    };
}

function mapAutomodRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        botId: row.bot_id,
        userId: row.user_id,
        username: row.username,
        guildId: row.guild_id,
        channelId: row.channel_id,
        violationType: row.violation_type,
        actionTaken: row.action_taken,
        messageContent: row.message_content,
        timestamp: row.timestamp
    };
}

function mapSlashCommandRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        botId: row.bot_id,
        name: row.name,
        description: row.description,
        type: row.type,
        responseTemplate: row.response_template || '',
        options: safeJsonParse(row.options_json, []),
        enabled: Boolean(row.enabled),
        createdAt: new Date(row.created_at)
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
        rate_limits_json: config.rateLimits ? JSON.stringify(config.rateLimits) : null,
        automod_config_json: config.automodConfig ? JSON.stringify(config.automodConfig) : null,
        schedule_json: config.schedule ? JSON.stringify(config.schedule) : null,
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
    if (hasProp('rateLimits')) config.rateLimits = updates.rateLimits;
    if (hasProp('automodConfig')) config.automodConfig = updates.automodConfig;
    if (hasProp('schedule')) config.schedule = updates.schedule;
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
        rate_limits_json: config.rateLimits ? JSON.stringify(config.rateLimits) : null,
        automod_config_json: config.automodConfig ? JSON.stringify(config.automodConfig) : null,
        schedule_json: config.schedule ? JSON.stringify(config.schedule) : null,
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

function createSlashCommand({
    id,
    botId,
    name,
    description,
    type,
    responseTemplate = '',
    options = [],
    enabled = true,
    createdAt
}) {
    const stamped = createdAt ? toIso(createdAt) : new Date().toISOString();
    statements.insertSlashCommand.run({
        id,
        bot_id: botId,
        name,
        description,
        type,
        response_template: responseTemplate || '',
        options_json: JSON.stringify(Array.isArray(options) ? options : []),
        enabled: enabled ? 1 : 0,
        created_at: stamped
    });

    return {
        id,
        botId,
        name,
        description,
        type,
        responseTemplate: responseTemplate || '',
        options: Array.isArray(options) ? options : [],
        enabled: Boolean(enabled),
        createdAt: new Date(stamped)
    };
}

function listSlashCommands(botId) {
    const rows = statements.listSlashCommandsByBot.all(botId);
    return rows.map(mapSlashCommandRow);
}

function updateSlashCommand(botId, commandId, updates) {
    const existing = statements.getSlashCommandById.get(commandId, botId);
    if (!existing) return null;

    const command = mapSlashCommandRow(existing);
    const hasProp = (key) => Object.prototype.hasOwnProperty.call(updates, key);

    if (hasProp('name')) command.name = updates.name;
    if (hasProp('description')) command.description = updates.description;
    if (hasProp('type')) command.type = updates.type;
    if (hasProp('responseTemplate')) command.responseTemplate = updates.responseTemplate || '';
    if (hasProp('options')) command.options = Array.isArray(updates.options) ? updates.options : [];
    if (hasProp('enabled')) command.enabled = Boolean(updates.enabled);

    statements.updateSlashCommand.run({
        id: commandId,
        bot_id: botId,
        name: command.name,
        description: command.description,
        type: command.type,
        response_template: command.responseTemplate || '',
        options_json: JSON.stringify(Array.isArray(command.options) ? command.options : []),
        enabled: command.enabled ? 1 : 0
    });

    return command;
}

function deleteSlashCommand(botId, commandId) {
    const result = statements.deleteSlashCommand.run(commandId, botId);
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

function logConversation({
    botId,
    userId = null,
    username = null,
    channelId = null,
    channelName = null,
    messageContent = null,
    botResponse = null,
    timestamp = null,
    modelUsed = null,
    tokensUsed = null
}) {
    const stamped = timestamp ? toIso(timestamp) : new Date().toISOString();
    statements.insertConversationLog.run({
        bot_id: botId,
        user_id: userId,
        username,
        channel_id: channelId,
        channel_name: channelName,
        message_content: messageContent,
        bot_response: botResponse,
        timestamp: stamped,
        model_used: modelUsed,
        tokens_used: Number.isFinite(tokensUsed) ? tokensUsed : null
    });
}

function logModAction({
    botId,
    userId = null,
    username = null,
    guildId = null,
    channelId = null,
    violationType,
    actionTaken,
    messageContent = null,
    timestamp = null
}) {
    if (!botId || !violationType || !actionTaken) return;
    const stamped = timestamp ? toIso(timestamp) : new Date().toISOString();
    statements.insertAutomodLog.run({
        bot_id: botId,
        user_id: userId,
        username,
        guild_id: guildId,
        channel_id: channelId,
        violation_type: violationType,
        action_taken: actionTaken,
        message_content: messageContent,
        timestamp: stamped
    });
}

function getConversationsByBot(botId, limit = 50, offset = 0) {
    const rows = statements.getConversationsByBot.all(botId, limit, offset);
    return rows.map(mapConversationRow);
}

function searchConversations(botId, query) {
    const pattern = `%${query}%`;
    const rows = statements.searchConversationsByBot.all({ bot_id: botId, pattern });
    return rows.map(mapConversationRow);
}

function getAllConversationsByBot(botId) {
    const rows = statements.getAllConversationsByBot.all(botId);
    return rows.map(mapConversationRow);
}

function recordBotMessageReceived(botId, command, timestamp) {
    if (!botId) return;
    statements.insertBotAnalytics.run({
        bot_id: botId,
        event_type: 'message_received',
        command: command || null,
        count: 1,
        duration_ms: null,
        start_at: null,
        end_at: null,
        timestamp: timestamp ? toIso(timestamp) : new Date().toISOString()
    });
}

function recordBotMessageSent(botId, count = 1, timestamp) {
    if (!botId) return;
    const safeCount = Number.isFinite(count) ? count : 1;
    statements.insertBotAnalytics.run({
        bot_id: botId,
        event_type: 'message_sent',
        command: null,
        count: safeCount,
        duration_ms: null,
        start_at: null,
        end_at: null,
        timestamp: timestamp ? toIso(timestamp) : new Date().toISOString()
    });
}

function recordBotError(botId, timestamp) {
    if (!botId) return;
    statements.insertBotAnalytics.run({
        bot_id: botId,
        event_type: 'error',
        command: null,
        count: 1,
        duration_ms: null,
        start_at: null,
        end_at: null,
        timestamp: timestamp ? toIso(timestamp) : new Date().toISOString()
    });
}

function recordBotUptime(botId, startAt, endAt) {
    if (!botId) return;
    const start = startAt ? new Date(startAt) : null;
    const end = endAt ? new Date(endAt) : new Date();
    const durationMs = start && end && end.getTime() >= start.getTime()
        ? end.getTime() - start.getTime()
        : 0;
    statements.insertBotAnalytics.run({
        bot_id: botId,
        event_type: 'uptime',
        command: null,
        count: null,
        duration_ms: durationMs,
        start_at: start ? start.toISOString() : null,
        end_at: end.toISOString(),
        timestamp: end.toISOString()
    });
}

function getBotAnalytics(botId, rangeHours = 24) {
    if (!botId) return null;
    const hours = Number.isFinite(rangeHours) ? rangeHours : 24;
    const clampedHours = Math.max(1, Math.min(hours, 720));
    const endAt = new Date();
    const startAt = new Date(endAt.getTime() - clampedHours * 60 * 60 * 1000);
    const rows = statements.getBotAnalyticsByRange.all(botId, startAt.toISOString());

    const bucketCount = Math.max(1, Math.min(24, Math.ceil(clampedHours)));
    const rangeMs = endAt.getTime() - startAt.getTime();
    const bucketSizeMs = rangeMs / bucketCount;

    const series = {
        labels: [],
        messagesSent: Array(bucketCount).fill(0),
        messagesReceived: Array(bucketCount).fill(0),
        uptimeMs: Array(bucketCount).fill(0)
    };

    for (let i = 0; i < bucketCount; i += 1) {
        series.labels.push(new Date(startAt.getTime() + i * bucketSizeMs).toISOString());
    }

    const totals = {
        messagesSent: 0,
        messagesReceived: 0,
        errors: 0,
        uptimeMs: 0,
        uptimePct: 0,
        errorRate: 0
    };

    const commandCounts = new Map();

    for (const row of rows) {
        const timestamp = row.timestamp ? new Date(row.timestamp).getTime() : null;
        const index = timestamp
            ? Math.min(bucketCount - 1, Math.max(0, Math.floor((timestamp - startAt.getTime()) / bucketSizeMs)))
            : 0;

        if (row.event_type === 'message_sent') {
            const count = Number.isFinite(row.count) ? row.count : 1;
            totals.messagesSent += count;
            series.messagesSent[index] += count;
        } else if (row.event_type === 'message_received') {
            const count = Number.isFinite(row.count) ? row.count : 1;
            totals.messagesReceived += count;
            series.messagesReceived[index] += count;
            if (row.command) {
                commandCounts.set(row.command, (commandCounts.get(row.command) || 0) + count);
            }
        } else if (row.event_type === 'error') {
            totals.errors += Number.isFinite(row.count) ? row.count : 1;
        } else if (row.event_type === 'uptime') {
            const duration = Number.isFinite(row.duration_ms) ? row.duration_ms : 0;
            totals.uptimeMs += duration;
            series.uptimeMs[index] += duration;
        }
    }

    if (rangeMs > 0) {
        totals.uptimePct = (totals.uptimeMs / rangeMs) * 100;
    }
    const totalEvents = totals.messagesSent + totals.messagesReceived + totals.errors;
    if (totalEvents > 0) {
        totals.errorRate = (totals.errors / totalEvents) * 100;
    }

    const topCommands = Array.from(commandCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([command, count]) => ({ command, count }));

    return {
        range: {
            hours: clampedHours,
            start: startAt.toISOString(),
            end: endAt.toISOString()
        },
        totals,
        topCommands,
        series
    };
}

function getModLogs(botId, limit = 50, offset = 0) {
    const rows = statements.getAutomodLogs.all(botId, limit, offset);
    return rows.map(mapAutomodRow);
}

function getModStats(botId) {
    const totalRow = statements.getAutomodStatsTotal.get(botId);
    const byViolationRows = statements.getAutomodStatsByViolation.all(botId);
    const byActionRows = statements.getAutomodStatsByAction.all(botId);

    const byViolation = {};
    const byAction = {};

    for (const row of byViolationRows) {
        byViolation[row.violation_type] = row.count;
    }
    for (const row of byActionRows) {
        byAction[row.action_taken] = row.count;
    }

    return {
        total: totalRow?.total || 0,
        byViolation,
        byAction
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
    createSlashCommand,
    listSlashCommands,
    updateSlashCommand,
    deleteSlashCommand,
    logBotEvent,
    getLatestBotStatusEvent,
    recordBotMessageReceived,
    recordBotMessageSent,
    recordBotError,
    recordBotUptime,
    getBotAnalytics,
    logConversation,
    logModAction,
    getConversationsByBot,
    searchConversations,
    getAllConversationsByBot,
    getModLogs,
    getModStats
};
