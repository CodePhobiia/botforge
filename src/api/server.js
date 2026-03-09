/**
 * BotForge API Server
 * REST API for managing bots + serves the dashboard
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { version: APP_VERSION } = require('../../package.json');
const { BotManager } = require('../engine/BotManager');
const { AutoMod } = require('../engine/AutoMod');
const { Scheduler } = require('../engine/Scheduler');
const { personalityPresets } = require('../engine/PersonalityPresets');
const { securityHeaders, corsMiddleware, jsonBodyParser, urlencodedBodyParser, requestIdMiddleware } = require('../middleware/security');
const { apiRateLimiter, authRateLimiter } = require('../middleware/rateLimit');
const { buildDiscordAuthUrl, getDiscordRedirectUri, handleDiscordCallback } = require('../auth/discord-oauth');
const {
    validateRegister,
    validateLogin,
    validateCreateBot,
    validateUpdateBot,
    validateUpdateBotConfig,
    validateBotIdParam,
    validateBotTools,
    validateBotSchedule,
    sanitizeObject
} = require('../middleware/validation');
const { errorHandler } = require('../middleware/errorHandler');
const {
    createUser,
    getUserByEmail,
    createBot: createBotRecord,
    listBotsByUser,
    listAllBots,
    getBotById,
    updateBot: updateBotRecord,
    deleteBot: deleteBotRecord,
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
    getConversationsByBot,
    searchConversations,
    getAllConversationsByBot,
    getModLogs,
    getModStats
} = require('../db/database');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET_ENV = process.env.JWT_SECRET;
const JWT_SECRET = JWT_SECRET_ENV || `botforge-secret-change-me-${uuidv4()}`;
const IS_DEFAULT_JWT = !JWT_SECRET_ENV;

const botManager = new BotManager();
const scheduler = new Scheduler({ botManager, logBotEvent });
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.disable('x-powered-by');
app.use(requestIdMiddleware);
app.use(securityHeaders);
app.use(corsMiddleware());
app.use(jsonBodyParser);
app.use(urlencodedBodyParser);
app.use(express.static(path.join(__dirname, '../../public'), { index: false }));
app.use('/api', apiRateLimiter);

function maskBotForResponse(config, status = null) {
    const { discordToken, aiApiKey, updatedAt, ...rest } = config;
    const payload = status ? { ...rest, ...status } : rest;
    return { ...payload, discordToken: '***', aiApiKey: '***' };
}

function normalizeAutomodConfig(raw) {
    const sanitized = sanitizeObject(raw || {});
    return AutoMod.normalizeConfig(sanitized);
}

function getCorsStatus() {
    const raw = process.env.CORS_ORIGINS;
    if (raw) {
        const origins = raw.split(',').map((item) => item.trim()).filter(Boolean);
        if (origins.length) return origins.join(', ');
    }
    return NODE_ENV === 'production' ? 'restricted (set CORS_ORIGINS)' : 'allow all (dev)';
}

function getEncryptionKeyStatus() {
    if (process.env.ENCRYPTION_KEY) return 'env (ENCRYPTION_KEY)';
    if (process.env.BOTFORGE_ENCRYPTION_KEY) return 'env (BOTFORGE_ENCRYPTION_KEY)';
    const keyPath = path.join(__dirname, '../../.botforge-key');
    if (fs.existsSync(keyPath)) return 'file (.botforge-key)';
    return 'auto-generated on first use';
}

function logStartupBanner() {
    const discordConfigured = Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
    const jwtStatus = IS_DEFAULT_JWT ? 'ephemeral (set JWT_SECRET)' : 'custom';
    console.log('\n🛠️  BotForge startup');
    console.log(`• Environment: ${NODE_ENV}`);
    console.log(`• Version: ${APP_VERSION}`);
    console.log(`• Port: ${PORT}`);
    console.log(`• JWT secret: ${jwtStatus}`);
    console.log(`• Discord OAuth: ${discordConfigured ? 'enabled' : 'disabled'}`);
    console.log(`• CORS: ${getCorsStatus()}`);
    console.log(`• Encryption key: ${getEncryptionKeyStatus()}`);
    console.log('• Request IDs: enabled');
    console.log('• WebSocket: enabled');
    if (NODE_ENV === 'production' && IS_DEFAULT_JWT) {
        console.warn('[BotForge] WARNING: JWT_SECRET is not set; sessions will reset on restart.');
    }
    if (NODE_ENV === 'production' && getCorsStatus().startsWith('restricted')) {
        console.warn('[BotForge] WARNING: CORS_ORIGINS not set; cross-origin requests will be blocked.');
    }
}

// ============ HEALTH ============

app.get('/api/health', (req, res) => {
    const stats = botManager.getStats();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        version: APP_VERSION,
        bots_running: stats.running
    });
});

// ============ WEBSOCKET ============

io.use((socket, next) => {
    const socketToken = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!socketToken) return next(new Error('Unauthorized'));
    try {
        const decoded = jwt.verify(socketToken, JWT_SECRET);
        socket.userId = decoded.userId;
        return next();
    } catch {
        return next(new Error('Unauthorized'));
    }
});

io.on('connection', (socket) => {
    if (!socket.userId) return;
    socket.join(socket.userId);
    socket.emit('bots_snapshot', botManager.getAllBots(socket.userId));
});

function emitToUser(userId, event, payload) {
    if (!userId) return;
    io.to(userId).emit(event, payload);
}

botManager.on('status', (payload) => {
    emitToUser(payload.userId, 'bot_status', payload);
});

botManager.on('message', (payload) => {
    emitToUser(payload.userId, 'bot_message', payload);
    if (payload.direction === 'received') {
        recordBotMessageReceived(payload.botId, payload.command, payload.timestamp);
    } else if (payload.direction === 'sent') {
        recordBotMessageSent(payload.botId, payload.count || 1, payload.timestamp);
    }
});

botManager.on('error', (payload) => {
    emitToUser(payload.userId, 'bot_error', payload);
    recordBotError(payload.botId, payload.timestamp);
});

botManager.on('uptime', (payload) => {
    recordBotUptime(payload.botId, payload.startAt, payload.endAt);
});

botManager.on('automod', (payload) => {
    emitToUser(payload.userId, 'bot_automod', payload);
});

scheduler.on('schedule', (payload) => {
    emitToUser(payload.userId, 'bot_schedule', payload);
});

function findUserBot(userId, botId) {
    return getBotById(userId, botId);
}

function escapeCsv(value) {
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    if (/[",\n\r]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
}

function buildConversationCsv(conversations) {
    const headers = [
        'id',
        'bot_id',
        'user_id',
        'username',
        'channel_id',
        'channel_name',
        'message_content',
        'bot_response',
        'timestamp',
        'model_used',
        'tokens_used'
    ];

    const lines = [headers.join(',')];
    for (const convo of conversations) {
        const row = [
            convo.id,
            convo.botId,
            convo.userId,
            convo.username,
            convo.channelId,
            convo.channelName,
            convo.messageContent,
            convo.botResponse,
            convo.timestamp,
            convo.modelUsed,
            convo.tokensUsed
        ].map(escapeCsv);
        lines.push(row.join(','));
    }
    return lines.join('\n');
}

const SLASH_NAME_REGEX = /^[a-z0-9_-]{1,32}$/;
const SLASH_TYPES = new Set(['text', 'ai', 'embed']);
const SLASH_OPTION_TYPES = new Set(['string', 'integer', 'boolean', 'user', 'channel', 'role']);

function normalizeSlashName(value) {
    return String(value || '').trim().toLowerCase();
}

function parseSlashOptions(options) {
    if (options === undefined) return { value: undefined };
    if (!Array.isArray(options)) return { error: 'Options must be an array' };
    if (options.length > 25) return { error: 'Slash commands support up to 25 options' };

    const parsed = [];
    for (const option of options) {
        const name = normalizeSlashName(option?.name);
        if (!name || !SLASH_NAME_REGEX.test(name)) {
            return { error: 'Option names must be lowercase and contain only letters, numbers, underscores, or dashes' };
        }
        const type = String(option?.type || '').trim().toLowerCase();
        if (!SLASH_OPTION_TYPES.has(type)) {
            return { error: `Unsupported option type: ${type}` };
        }
        const required = Boolean(option?.required);
        const description = String(option?.description || '').trim();
        parsed.push({ name, type, required, description });
    }

    return { value: parsed };
}

function parseSlashPayload(raw, { isUpdate = false } = {}) {
    const data = sanitizeObject(raw || {});
    const payload = {};

    if (!isUpdate || data.name !== undefined) {
        const name = normalizeSlashName(data.name);
        if (!name || !SLASH_NAME_REGEX.test(name)) {
            return { error: 'Command name must be lowercase and contain only letters, numbers, underscores, or dashes' };
        }
        payload.name = name;
    }

    if (!isUpdate || data.description !== undefined) {
        const description = String(data.description || '').trim();
        if (!description || description.length > 100) {
            return { error: 'Description must be 1-100 characters' };
        }
        payload.description = description;
    }

    if (!isUpdate || data.type !== undefined) {
        const type = String(data.type || '').trim().toLowerCase();
        if (!SLASH_TYPES.has(type)) {
            return { error: 'Command type must be text, ai, or embed' };
        }
        payload.type = type;
    }

    if (data.responseTemplate !== undefined) {
        payload.responseTemplate = String(data.responseTemplate || '');
    } else if (!isUpdate) {
        payload.responseTemplate = '';
    }

    if (data.enabled !== undefined) {
        payload.enabled = Boolean(data.enabled);
    }

    const optionsResult = parseSlashOptions(data.options);
    if (optionsResult.error) return { error: optionsResult.error };
    if (optionsResult.value !== undefined) {
        payload.options = optionsResult.value;
    } else if (!isUpdate) {
        payload.options = [];
    }

    if (isUpdate && Object.keys(payload).length === 0) {
        return { error: 'No fields provided for update' };
    }

    return { payload };
}

// ============ AUTH ============

app.post('/api/auth/register', authRateLimiter, validateRegister, async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        
        if (getUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = createUser({
            id: uuidv4(),
            email,
            name: name || email.split('@')[0],
            passwordHash: hashedPassword
        });
        
        const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', authRateLimiter, validateLogin, async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = getUserByEmail(email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        
        const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/discord', (req, res) => {
    try {
        const clientId = process.env.DISCORD_CLIENT_ID;
        if (!clientId) return res.status(500).json({ error: 'Discord OAuth not configured' });

        const authUrl = buildDiscordAuthUrl({
            clientId,
            redirectUri: getDiscordRedirectUri()
        });
        res.redirect(authUrl);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/discord/callback', async (req, res) => {
    try {
        if (req.query.error) {
            return res.status(400).send(`Discord OAuth error: ${req.query.error}`);
        }

        const { token } = await handleDiscordCallback({
            code: req.query.code,
            clientId: process.env.DISCORD_CLIENT_ID,
            clientSecret: process.env.DISCORD_CLIENT_SECRET,
            redirectUri: getDiscordRedirectUri(),
            jwtSecret: JWT_SECRET
        });

        res.redirect(`/dashboard?token=${encodeURIComponent(token)}`);
    } catch (err) {
        res.status(500).send(`Discord OAuth failed: ${err.message}`);
    }
});

// Auth middleware
function auth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ============ TEMPLATES ============

app.get('/api/templates', (req, res) => {
    res.json({ templates: personalityPresets });
});

app.get('/api/templates/:id', (req, res) => {
    const template = personalityPresets.find((item) => item.id === req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
});

// ============ BOTS ============

// List user's bots
app.get('/api/bots', auth, (req, res) => {
    const configs = listBotsByUser(req.userId);
    const bots = configs.map(config => {
        try {
            const status = botManager.getBotStatus(config.id);
            return maskBotForResponse(config, status);
        } catch {
            return maskBotForResponse(config, { status: 'stopped' });
        }
    });
    res.json({ bots });
});

// Create a new bot
app.post('/api/bots', auth, validateCreateBot, (req, res) => {
    try {
        const { name, discordToken, aiProvider, aiApiKey, model, personality, triggerMode, prefix, channels, collaborationMode, tools } = req.body;
        
        if (!name || !discordToken || !aiApiKey) {
            return res.status(400).json({ error: 'Name, Discord token, and AI API key are required' });
        }

        const config = {
            id: uuidv4(),
            userId: req.userId,
            name,
            discordToken,
            aiProvider: aiProvider || 'openai',
            aiApiKey,
            model: model || (aiProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini'),
            personality: personality || 'You are a helpful, friendly AI assistant.',
            triggerMode: triggerMode || 'mention',
            prefix: prefix || '!',
            channels: channels || [],
            tools: Array.isArray(tools) ? tools : [],
            maxTokens: 1024,
            historyLimit: 20,
            collaborationMode: collaborationMode || 'off',
            createdAt: new Date()
        };

        const storedConfig = createBotRecord(config);
        logBotEvent(config.id, 'created', 'Bot created');

        botManager.createBot(storedConfig);
        scheduler.registerBot(storedConfig);

        res.json({ bot: maskBotForResponse(storedConfig) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start a bot
app.post('/api/bots/:id/start', auth, validateBotIdParam, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        const status = await botManager.startBot(config.id);
        logBotEvent(config.id, 'started', 'Bot started');
        res.json({ status });
    } catch (err) {
        logBotEvent(req.params.id, 'error', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Stop a bot
app.post('/api/bots/:id/stop', auth, validateBotIdParam, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        const status = await botManager.stopBot(config.id);
        logBotEvent(config.id, 'stopped', 'Bot stopped');
        res.json({ status });
    } catch (err) {
        logBotEvent(req.params.id, 'error', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Update a bot
app.put('/api/bots/:id', auth, validateBotIdParam, validateUpdateBot, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        // Update stored config
        const updates = req.body || {};
        updateBotRecord(req.userId, req.params.id, updates);
        logBotEvent(req.params.id, 'updated', 'Bot updated');
        
        // Update running bot
        const status = await botManager.updateBot(config.id, updates);
        res.json({ status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update bot config without restarting
app.patch('/api/bots/:id/config', auth, validateBotIdParam, validateUpdateBotConfig, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const updates = req.body || {};
        const storedConfig = updateBotRecord(req.userId, req.params.id, updates);
        logBotEvent(req.params.id, 'config-updated', 'Bot config updated (live)');

        let status = null;
        try {
            status = botManager.updateBotConfig(config.id, updates);
        } catch (err) {
            console.warn(`[BotForge] Live config update skipped for ${config.id}:`, err.message);
        }

        res.json({ bot: maskBotForResponse(storedConfig || config, status) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot schedule
app.get('/api/bots/:id/schedule', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        res.json({ schedule: config.schedule || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update bot schedule
app.put('/api/bots/:id/schedule', auth, validateBotIdParam, validateBotSchedule, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const schedule = req.schedule;
        updateBotRecord(req.userId, req.params.id, { schedule });
        logBotEvent(req.params.id, 'schedule-updated', 'Schedule updated');

        scheduler.setSchedule(req.params.id, schedule, { userId: config.userId, name: config.name });
        scheduler.checkNow(req.params.id).catch((err) => {
            console.warn('[BotForge] Schedule check failed:', err.message);
        });

        res.json({ schedule });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove bot schedule
app.delete('/api/bots/:id/schedule', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        updateBotRecord(req.userId, req.params.id, { schedule: null });
        logBotEvent(req.params.id, 'schedule-removed', 'Schedule removed');
        scheduler.removeSchedule(req.params.id);

        res.json({ schedule: null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get automod config
app.get('/api/bots/:id/automod', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const automod = normalizeAutomodConfig(config.automodConfig || {});
        res.json({ automod });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update automod config
app.put('/api/bots/:id/automod', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const automodConfig = normalizeAutomodConfig(req.body || {});
        const storedConfig = updateBotRecord(req.userId, req.params.id, { automodConfig });
        logBotEvent(req.params.id, 'automod-updated', 'AutoMod config updated');

        try {
            botManager.updateBotAutomod(config.id, automodConfig);
        } catch (err) {
            console.warn(`[BotForge] Live automod update skipped for ${config.id}:`, err.message);
        }

        res.json({ automod: automodConfig });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get automod logs
app.get('/api/bots/:id/automod/logs', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const logs = getModLogs(config.id, limit, offset);
        res.json({ logs, limit, offset });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get automod stats
app.get('/api/bots/:id/automod/stats', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const stats = getModStats(config.id);
        res.json({ stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a bot
app.delete('/api/bots/:id', auth, validateBotIdParam, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        await botManager.removeBot(req.params.id);
        scheduler.unregisterBot(req.params.id);
        deleteBotRecord(req.userId, req.params.id);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot status
app.get('/api/bots/:id/status', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const status = botManager.getBotStatus(config.id);
        res.json({ status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot message logs
app.get('/api/bots/:id/logs', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const logs = botManager.getBotLogs(config.id);
        res.json({ logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot health metrics
app.get('/api/bots/:id/health', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const health = botManager.getBotHealth(config.id);
        res.json({ health });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot analytics
app.get('/api/bots/:id/analytics', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const range = (req.query.range || '24h').toString();
        const rangeMap = { '24h': 24, '7d': 168, '30d': 720 };
        const rangeHours = rangeMap[range] || 24;

        const analytics = getBotAnalytics(config.id, rangeHours);
        res.json({ analytics });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Configure bot tools
app.post('/api/bots/:id/tools', auth, validateBotIdParam, validateBotTools, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const { tools } = req.body;
        if (!Array.isArray(tools)) {
            return res.status(400).json({ error: 'Tools must be an array of tool names' });
        }

        config.tools = tools;
        const status = await botManager.updateBot(config.id, { tools });
        res.json({ status, tools });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SLASH COMMANDS ============

app.get('/api/bots/:id/commands', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        const commands = listSlashCommands(config.id);
        res.json({ commands });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/bots/:id/commands', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const { payload, error } = parseSlashPayload(req.body, { isUpdate: false });
        if (error) return res.status(400).json({ error });

        const existing = listSlashCommands(config.id).find(cmd => cmd.name === payload.name);
        if (existing) return res.status(400).json({ error: 'Command name already exists' });

        const command = createSlashCommand({
            id: uuidv4(),
            botId: config.id,
            name: payload.name,
            description: payload.description,
            type: payload.type,
            responseTemplate: payload.responseTemplate,
            options: payload.options,
            enabled: payload.enabled ?? true,
            createdAt: new Date()
        });

        res.json({ command });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/bots/:id/commands/:cmdId', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const cmdId = String(req.params.cmdId || '').trim();
        if (!cmdId) return res.status(400).json({ error: 'Command id required' });

        const { payload, error } = parseSlashPayload(req.body, { isUpdate: true });
        if (error) return res.status(400).json({ error });

        if (payload.name) {
            const existing = listSlashCommands(config.id).find(cmd => cmd.name === payload.name && cmd.id !== cmdId);
            if (existing) return res.status(400).json({ error: 'Command name already exists' });
        }

        const updated = updateSlashCommand(config.id, cmdId, payload);
        if (!updated) return res.status(404).json({ error: 'Command not found' });
        res.json({ command: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/bots/:id/commands/:cmdId', auth, validateBotIdParam, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const cmdId = String(req.params.cmdId || '').trim();
        if (!cmdId) return res.status(400).json({ error: 'Command id required' });

        const deleted = deleteSlashCommand(config.id, cmdId);
        if (!deleted) return res.status(404).json({ error: 'Command not found' });

        let synced = false;
        try {
            await botManager.syncSlashCommands(config.id);
            synced = true;
        } catch (err) {
            console.warn(`[BotForge] Slash command sync skipped for ${config.id}:`, err.message);
        }

        res.json({ success: true, synced });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/bots/:id/commands/sync', auth, validateBotIdParam, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const result = await botManager.syncSlashCommands(config.id);
        res.json({ synced: true, result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Get conversation history (paginated)
app.get('/api/bots/:id/conversations', auth, validateBotIdParam, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const conversations = getConversationsByBot(config.id, limit, offset);
        res.json({ conversations, limit, offset });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Search conversations
app.get('/api/bots/:id/conversations/search', auth, validateBotIdParam, (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const query = String(req.query.q || '').trim();
        if (!query) return res.status(400).json({ error: 'Search query required' });

        const conversations = searchConversations(config.id, query);
        res.json({ conversations, query });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export conversations
app.get('/api/bots/:id/conversations/export', auth, validateBotIdParam, (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const format = String(req.query.format || 'json').toLowerCase();
        const conversations = getAllConversationsByBot(config.id);

        if (format === 'csv') {
            const csv = buildConversationCsv(conversations);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="bot-${config.id}-conversations.csv"`);
            return res.send(csv);
        }

        if (format !== 'json') {
            return res.status(400).json({ error: 'Unsupported export format' });
        }

        res.json({ conversations });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Platform stats
app.get('/api/stats', (req, res) => {
    res.json({ stats: botManager.getStats() });
});

async function bootstrapBots() {
    const configs = listAllBots();
    for (const config of configs) {
        try {
            await botManager.createBot(config);
            scheduler.registerBot(config);
        } catch (err) {
            console.error(`[BotForge] Failed to load bot ${config.id}:`, err.message);
        }
    }

    scheduler.start();

    for (const config of configs) {
        if (config.schedule) continue;
        const lastStatus = getLatestBotStatusEvent(config.id);
        if (lastStatus?.eventType === 'started') {
            try {
                await botManager.startBot(config.id);
                logBotEvent(config.id, 'started', 'Auto-started on boot');
            } catch (err) {
                logBotEvent(config.id, 'error', err.message);
                console.error(`[BotForge] Auto-start failed for ${config.id}:`, err.message);
            }
        }
    }
}

// Landing + dashboard routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/landing.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

app.get('/dashboard/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

app.use(errorHandler);

let isShuttingDown = false;

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`[BotForge] Received ${signal}. Shutting down...`);
    const shutdownTimer = setTimeout(() => {
        console.error('[BotForge] Forced shutdown after timeout.');
        process.exit(1);
    }, 10000);
    shutdownTimer.unref();

    const serverClose = new Promise((resolve) => server.close(resolve));

    try {
        await botManager.stopAllBots();
    } catch (err) {
        console.error('[BotForge] Error while stopping bots:', err.message);
    }

    scheduler.stop();

    await serverClose;
    process.exit(0);
}

if (NODE_ENV !== 'test') {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    server.listen(PORT, () => {
        logStartupBanner();
        console.log(`\n🔥 BotForge server running on http://localhost:${PORT}\n`);
        bootstrapBots().catch((err) => {
            console.error('[BotForge] Failed to bootstrap bots:', err.message);
        });
    });
}

module.exports = app;
