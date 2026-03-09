/**
 * BotManager - Core engine that manages multiple Discord bot instances
 * Each bot runs as a separate discord.js client with its own config
 */

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { generateResponse } = require('./AIProvider');
const { ToolSystem } = require('./ToolSystem');
const { RateLimiter } = require('./RateLimiter');

const DEFAULT_MESSAGE_LOG_LIMIT = 100;
const MAX_TOOL_ROUNDS = 2;
const DEFAULT_COLLAB_COOLDOWN_MS = 30000;

class BotInstance {
    constructor(config) {
        this.id = config.id;
        this.userId = config.userId;
        this.name = config.name;
        this.discordToken = config.discordToken;
        this.aiProvider = config.aiProvider || 'openai'; // openai | anthropic
        this.aiApiKey = config.aiApiKey;
        this.model = config.model || 'gpt-4o-mini';
        this.personality = config.personality || 'You are a helpful assistant.';
        this.tools = config.tools || [];
        this.channels = config.channels || []; // empty = all channels
        this.status = 'stopped'; // stopped | starting | running | error | reconnecting
        this.client = null;
        this.error = null;
        this.messageCount = 0;
        this.startedAt = null;
        this.guilds = [];
        this.onStatusChange = null;
        this.triggerMode = config.triggerMode || 'mention'; // mention | all | prefix
        this.prefix = config.prefix || '!';
        this.maxTokens = config.maxTokens || 1024;
        this.conversationHistory = new Map(); // channelId -> messages[]
        this.historyLimit = config.historyLimit || 20;
        this.messageLogs = new Map(); // channelId -> logs[]
        this.messageLogLimit = config.messageLogLimit || DEFAULT_MESSAGE_LOG_LIMIT;
        this.activeChannels = new Set();

        this.manager = config.manager || null;
        this.toolSystem = config.toolSystem || null;
        this.rateLimiter = config.rateLimiter || null;

        this.collaborationMode = config.collaborationMode || 'off'; // off | reactive | proactive
        this.collaborationCooldownMs = config.collaborationCooldownMs || DEFAULT_COLLAB_COOLDOWN_MS;
        this.lastCollaborationAt = new Map();

        this.createdAt = config.createdAt ? new Date(config.createdAt) : new Date();
        this.totalUptimeMs = 0;
        this.lastStartAt = null;

        this.restartAttempts = 0;
        this.maxRestartAttempts = config.maxRestartAttempts || 3;
        this.baseRestartDelayMs = config.baseRestartDelayMs || 1000;
        this.reconnectTimer = null;
        this.shouldReconnect = true;

        this.health = {
            totalResponses: 0,
            totalErrors: 0,
            totalResponseTimeMs: 0,
            responseTimes: [],
            lastErrorAt: null,
            lastResponseAt: null,
            lastError: null
        };
    }

    async start(options = {}) {
        if (this.status === 'running') return;

        this.status = options.isReconnect ? 'reconnecting' : 'starting';
        this._notifyStatus();
        this.shouldReconnect = true;

        try {
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.GuildMembers,
                ]
            });

            this._attachClientEvents();

            await this.client.login(this.discordToken);
        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            this._recordError(err);
            console.error(`[BotManager] Failed to start bot "${this.name}":`, err.message);
            this._notifyStatus();
            throw err;
        }
    }

    async stop(options = {}) {
        const isManual = options.isManual !== false;
        if (isManual) this.shouldReconnect = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.client) {
            await this.client.destroy();
            this.client = null;
        }

        this._recordUptimeStop();

        this.status = 'stopped';
        this.guilds = [];
        this.startedAt = null;
        console.log(`[BotManager] Bot "${this.name}" (${this.id}) stopped`);
        this._notifyStatus();
    }

    _attachClientEvents() {
        this.client.on(Events.ClientReady, () => {
            this.status = 'running';
            this.error = null;
            this.startedAt = new Date();
            this.lastStartAt = new Date();
            this.restartAttempts = 0;
            this.guilds = this.client.guilds.cache.map(g => ({
                id: g.id,
                name: g.name,
                memberCount: g.memberCount
            }));
            console.log(`[BotManager] Bot "${this.name}" (${this.id}) is online in ${this.guilds.length} server(s)`);
            this._notifyStatus();
        });

        this.client.on(Events.MessageCreate, async (message) => {
            await this._handleMessage(message);
        });

        this.client.on(Events.Error, (error) => {
            console.error(`[BotManager] Bot "${this.name}" error:`, error.message);
            this.error = error.message;
            this._recordError(error);
            this._notifyStatus();
        });

        this.client.on('shardDisconnect', (event, shardId) => {
            const reason = event?.reason || 'Unknown disconnect';
            console.warn(`[BotManager] Bot "${this.name}" disconnected (shard ${shardId}): ${reason}`);
            this.error = `Disconnected: ${reason}`;
            this._recordError(new Error(this.error));
            this._recordUptimeStop();
            if (this.shouldReconnect) {
                this._scheduleReconnect();
            } else {
                this.status = 'error';
                this._notifyStatus();
            }
        });

        this.client.on('shardResume', () => {
            this.restartAttempts = 0;
            this.error = null;
            this.status = 'running';
            this._notifyStatus();
        });

        this.client.on('shardError', (error) => {
            console.error(`[BotManager] Bot "${this.name}" shard error:`, error.message);
            this.error = error.message;
            this._recordError(error);
            this._notifyStatus();
        });
    }

    async _handleMessage(message) {
        // Ignore own messages and other bots
        if (message.author.bot) return;

        // Check channel filter
        if (this.channels.length > 0 && !this.channels.includes(message.channel.id)) return;

        // Check trigger mode
        const shouldRespond = this._shouldRespond(message);
        if (!shouldRespond) return;

        this._logIncomingMessage(message);

        const rateResult = this.rateLimiter?.checkAndRecord({
            userId: message.author.id,
            botId: this.id
        });

        if (rateResult && !rateResult.allowed) {
            await message.reply(rateResult.message).catch(() => {});
            return;
        }

        const channelId = message.channel.id;
        const history = this._getHistory(channelId);

        this._appendHistory(channelId, {
            role: 'user',
            content: `${this._displayName(message)}: ${message.content}`
        });

        const startTime = Date.now();

        try {
            if (message.channel.sendTyping) await message.channel.sendTyping();

            let response = await generateResponse({
                provider: this.aiProvider,
                apiKey: this.aiApiKey,
                model: this.model,
                systemPrompt: this.personality,
                messages: this._buildMessagesForAI(history),
                maxTokens: this.maxTokens
            });

            response = await this._processToolCalls(response, history, message);
            const finalResponse = this.toolSystem ? this.toolSystem.stripToolCalls(response) : response;

            const sentMessages = await this._sendResponseToMessage(message, finalResponse);
            this._appendHistory(channelId, { role: 'assistant', content: finalResponse });
            this._logOutgoingMessages(channelId, finalResponse, sentMessages);

            this.messageCount++;
            this._recordResponse(Date.now() - startTime);

            if (this.manager) {
                this.manager.notifyBotResponse({
                    bot: this,
                    channelId,
                    userMessage: message.content,
                    response: finalResponse,
                    isCollaborationResponse: false
                });
            }
        } catch (err) {
            console.error(`[Bot ${this.name}] Message handling error:`, err.message);
            this._recordError(err);
            if (err.message.includes('API key') || err.message.includes('auth')) {
                await message.reply('⚠️ AI API error — check your API key configuration.').catch(() => {});
            }
        }
    }

    _shouldRespond(message) {
        switch (this.triggerMode) {
            case 'all':
                return true;
            case 'mention':
                return message.mentions.has(this.client.user);
            case 'prefix':
                return message.content.startsWith(this.prefix);
            default:
                return message.mentions.has(this.client.user);
        }
    }

    _getHistory(channelId) {
        if (this.manager && this.userId) {
            return this.manager.getSharedHistory(this.userId, channelId, this.historyLimit);
        }
        return this._getLocalHistory(channelId);
    }

    _getLocalHistory(channelId) {
        if (!this.conversationHistory.has(channelId)) {
            this.conversationHistory.set(channelId, []);
        }
        return this.conversationHistory.get(channelId);
    }

    _appendHistory(channelId, entry) {
        const stampedEntry = {
            role: entry.role,
            content: entry.content,
            timestamp: new Date().toISOString()
        };

        const localHistory = this._getLocalHistory(channelId);
        localHistory.push(stampedEntry);
        while (localHistory.length > this.historyLimit) {
            localHistory.shift();
        }

        if (this.manager && this.userId) {
            this.manager.appendSharedHistory(this.userId, channelId, stampedEntry, this.historyLimit);
        }

        this.activeChannels.add(channelId);
    }

    _buildMessagesForAI(history) {
        return history.map(entry => ({ role: entry.role, content: entry.content }));
    }

    async _processToolCalls(initialResponse, history, message) {
        if (!this.toolSystem) return initialResponse;

        let response = initialResponse;
        let rounds = 0;

        while (rounds < MAX_TOOL_ROUNDS) {
            const toolCalls = this.toolSystem.parseToolCalls(response);
            if (toolCalls.length === 0) break;

            const cleaned = this.toolSystem.stripToolCalls(response);
            if (cleaned) {
                this._appendHistory(message.channel.id, { role: 'assistant', content: cleaned });
            }

            const toolContext = {
                userId: message.author.id,
                channelId: message.channel.id,
                sendMessage: async (content) => {
                    if (!message.channel) return null;
                    const sent = await message.channel.send(content);
                    this._appendHistory(message.channel.id, { role: 'assistant', content });
                    this._logOutgoingMessages(message.channel.id, content, [{ message: sent, content }]);
                    return sent;
                }
            };

            const results = [];
            for (const call of toolCalls) {
                // eslint-disable-next-line no-await-in-loop
                const result = await this.toolSystem.executeToolCall(call, toolContext, this.tools);
                results.push(result);
            }

            const toolSummary = this._formatToolResults(results);
            this._appendHistory(message.channel.id, {
                role: 'user',
                content: `Tool results:\n${toolSummary}\nPlease provide a final response to the user.`
            });

            response = await generateResponse({
                provider: this.aiProvider,
                apiKey: this.aiApiKey,
                model: this.model,
                systemPrompt: this.personality,
                messages: this._buildMessagesForAI(history),
                maxTokens: this.maxTokens
            });

            rounds++;
        }

        return response;
    }

    _formatToolResults(results) {
        return results.map(result => {
            if (result.error) return `${result.name} error: ${result.error}`;
            return `${result.name} result: ${JSON.stringify(result.result)}`;
        }).join('\n');
    }

    async respondToCollaboration({ channelId, originBot, userMessage, response }) {
        if (this.collaborationMode === 'off') return;
        if (!this.client) return;

        const lastAt = this.lastCollaborationAt.get(channelId) || 0;
        if (Date.now() - lastAt < this.collaborationCooldownMs) return;

        const shouldChime = this._shouldChimeIn(userMessage);
        if (!shouldChime) return;

        this.lastCollaborationAt.set(channelId, Date.now());

        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) return;

            if (channel.sendTyping) await channel.sendTyping();

            const history = this._getHistory(channelId);
            const prompt = `Another bot (${originBot.name}) replied: "${response}". Add a brief helpful follow-up (1-2 sentences). If there is nothing to add, reply with "SKIP".`;

            const collabResponse = await generateResponse({
                provider: this.aiProvider,
                apiKey: this.aiApiKey,
                model: this.model,
                systemPrompt: this.personality,
                messages: [...this._buildMessagesForAI(history), { role: 'user', content: prompt }],
                maxTokens: Math.min(this.maxTokens, 512)
            });

            const trimmed = collabResponse.trim();
            if (!trimmed || trimmed.toUpperCase() === 'SKIP') return;

            const finalResponse = this.toolSystem ? this.toolSystem.stripToolCalls(trimmed) : trimmed;
            const sentMessages = await this._sendResponseToChannel(channel, finalResponse);

            this._appendHistory(channelId, { role: 'assistant', content: finalResponse });
            this._logOutgoingMessages(channelId, finalResponse, sentMessages);
            this.messageCount++;

            if (this.manager) {
                this.manager.notifyBotResponse({
                    bot: this,
                    channelId,
                    userMessage,
                    response: finalResponse,
                    isCollaborationResponse: true
                });
            }
        } catch (err) {
            console.error(`[Bot ${this.name}] Collaboration error:`, err.message);
            this._recordError(err);
        }
    }

    _shouldChimeIn(userMessage) {
        if (this.collaborationMode === 'proactive') return true;
        if (this.collaborationMode === 'reactive') {
            return /\?|\bhelp\b|\bhow\b|\bwhy\b/i.test(userMessage || '');
        }
        return false;
    }

    async _sendResponseToMessage(message, response) {
        const chunks = this._splitResponse(response);
        const sent = [];

        for (let i = 0; i < chunks.length; i++) {
            if (i === 0) {
                // eslint-disable-next-line no-await-in-loop
                const reply = await message.reply(chunks[i]);
                sent.push({ message: reply, content: chunks[i] });
            } else {
                // eslint-disable-next-line no-await-in-loop
                const followUp = await message.channel.send(chunks[i]);
                sent.push({ message: followUp, content: chunks[i] });
            }
        }

        return sent;
    }

    async _sendResponseToChannel(channel, response) {
        const chunks = this._splitResponse(response);
        const sent = [];

        for (const chunk of chunks) {
            // eslint-disable-next-line no-await-in-loop
            const message = await channel.send(chunk);
            sent.push({ message, content: chunk });
        }

        return sent;
    }

    _splitResponse(response) {
        if (!response) return [''];
        if (response.length <= 2000) return [response];

        const chunks = [];
        let remaining = response;
        while (remaining.length > 0) {
            if (remaining.length <= 2000) {
                chunks.push(remaining);
                break;
            }
            let breakPoint = remaining.lastIndexOf('\n', 1990);
            if (breakPoint === -1 || breakPoint < 1000) breakPoint = 1990;
            chunks.push(remaining.substring(0, breakPoint));
            remaining = remaining.substring(breakPoint);
        }
        return chunks;
    }

    _displayName(message) {
        return message.member?.displayName || message.author?.username || 'User';
    }

    _logIncomingMessage(message) {
        const entry = {
            id: message.id,
            channelId: message.channel.id,
            authorId: message.author.id,
            authorName: this._displayName(message),
            content: message.content,
            timestamp: new Date(message.createdTimestamp || Date.now()).toISOString(),
            isBot: false,
            botId: this.id
        };
        this._appendMessageLog(message.channel.id, entry);
    }

    _logOutgoingMessages(channelId, response, sentMessages) {
        if (!sentMessages || sentMessages.length === 0) {
            const entry = this._buildBotLog(channelId, response, null);
            this._appendMessageLog(channelId, entry);
            return;
        }

        for (const sent of sentMessages) {
            const entry = this._buildBotLog(channelId, sent.content, sent.message);
            this._appendMessageLog(channelId, entry);
        }
    }

    _buildBotLog(channelId, content, message) {
        return {
            id: message?.id || `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            channelId,
            authorId: this.client?.user?.id || null,
            authorName: this.name,
            content,
            timestamp: new Date(message?.createdTimestamp || Date.now()).toISOString(),
            isBot: true,
            botId: this.id
        };
    }

    _appendMessageLog(channelId, entry) {
        if (!this.messageLogs.has(channelId)) {
            this.messageLogs.set(channelId, []);
        }
        const log = this.messageLogs.get(channelId);
        log.push(entry);
        while (log.length > this.messageLogLimit) {
            log.shift();
        }
    }

    _recordResponse(durationMs) {
        this.health.totalResponses += 1;
        this.health.totalResponseTimeMs += durationMs;
        this.health.responseTimes.push(durationMs);
        if (this.health.responseTimes.length > 100) this.health.responseTimes.shift();
        this.health.lastResponseAt = new Date().toISOString();
    }

    _recordError(err) {
        this.health.totalErrors += 1;
        this.health.lastErrorAt = new Date().toISOString();
        this.health.lastError = err?.message || 'Unknown error';
    }

    _recordUptimeStop() {
        if (this.lastStartAt) {
            this.totalUptimeMs += Date.now() - this.lastStartAt.getTime();
            this.lastStartAt = null;
        }
    }

    _getUptimeMs() {
        let uptime = this.totalUptimeMs;
        if (this.lastStartAt) {
            uptime += Date.now() - this.lastStartAt.getTime();
        }
        return uptime;
    }

    _getUptimePercentage() {
        const elapsed = Date.now() - this.createdAt.getTime();
        if (elapsed <= 0) return 0;
        return (this._getUptimeMs() / elapsed) * 100;
    }

    _getAverageResponseTime() {
        if (!this.health.totalResponses) return 0;
        return Math.round(this.health.totalResponseTimeMs / this.health.totalResponses);
    }

    _getErrorRate() {
        const total = this.health.totalResponses + this.health.totalErrors;
        if (!total) return 0;
        return this.health.totalErrors / total;
    }

    _scheduleReconnect() {
        if (!this.shouldReconnect) return;
        if (this.reconnectTimer) return;

        if (this.restartAttempts >= this.maxRestartAttempts) {
            this.status = 'error';
            this.error = 'Max reconnect attempts reached.';
            this._notifyStatus();
            return;
        }

        const delay = this.baseRestartDelayMs * Math.pow(2, this.restartAttempts);
        this.restartAttempts += 1;
        this.status = 'reconnecting';
        this._notifyStatus();

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.stop({ isManual: false });
                await this.start({ isReconnect: true });
            } catch (err) {
                console.error(`[BotManager] Reconnect attempt failed for "${this.name}":`, err.message);
                this._recordError(err);
                this._scheduleReconnect();
            }
        }, delay);
    }

    _notifyStatus() {
        if (this.onStatusChange) {
            this.onStatusChange(this.getStatus());
        }
    }

    getStatus() {
        return {
            id: this.id,
            name: this.name,
            status: this.status,
            error: this.error,
            messageCount: this.messageCount,
            startedAt: this.startedAt,
            guilds: this.guilds,
            model: this.model,
            aiProvider: this.aiProvider,
            triggerMode: this.triggerMode,
            collaborationMode: this.collaborationMode,
            uptime: this._getUptimeMs(),
            uptimePct: this._getUptimePercentage(),
            avgResponseTimeMs: this._getAverageResponseTime(),
            errorRate: this._getErrorRate()
        };
    }

    getHealth() {
        return {
            id: this.id,
            name: this.name,
            status: this.status,
            uptimeMs: this._getUptimeMs(),
            uptimePct: this._getUptimePercentage(),
            totalResponses: this.health.totalResponses,
            totalErrors: this.health.totalErrors,
            avgResponseTimeMs: this._getAverageResponseTime(),
            errorRate: this._getErrorRate(),
            lastResponseAt: this.health.lastResponseAt,
            lastErrorAt: this.health.lastErrorAt,
            lastError: this.health.lastError,
            recentResponseTimes: [...this.health.responseTimes]
        };
    }

    getLogs() {
        const logs = {};
        for (const [channelId, entries] of this.messageLogs.entries()) {
            logs[channelId] = entries;
        }
        return logs;
    }

    getConversations() {
        const conversations = {};
        const channels = Array.from(this.activeChannels.values());

        if (this.manager && this.userId) {
            for (const channelId of channels) {
                conversations[channelId] = this.manager.getSharedHistorySnapshot(this.userId, channelId, this.historyLimit);
            }
            return conversations;
        }

        for (const [channelId, entries] of this.conversationHistory.entries()) {
            conversations[channelId] = entries;
        }
        return conversations;
    }
}

class BotManager {
    constructor() {
        this.bots = new Map(); // id -> BotInstance
        this.sharedHistory = new Map(); // userId:channelId -> messages[]
        this.toolSystem = new ToolSystem();
        this.rateLimiter = new RateLimiter();
    }

    async createBot(config) {
        if (this.bots.has(config.id)) {
            throw new Error(`Bot with id ${config.id} already exists`);
        }

        const bot = new BotInstance({
            ...config,
            manager: this,
            toolSystem: this.toolSystem,
            rateLimiter: this.rateLimiter
        });
        this.bots.set(config.id, bot);
        return bot.getStatus();
    }

    async startBot(id) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);
        await bot.start();
        return bot.getStatus();
    }

    async stopBot(id) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);
        await bot.stop();
        return bot.getStatus();
    }

    async stopAllBots() {
        const stops = [];
        for (const bot of this.bots.values()) {
            if (bot.status !== 'stopped') {
                stops.push(bot.stop());
            }
        }
        if (!stops.length) return;
        await Promise.allSettled(stops);
    }

    async removeBot(id) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);
        if (bot.status === 'running') {
            await bot.stop();
        }
        this.bots.delete(id);
    }

    async updateBot(id, config) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);

        const wasRunning = bot.status === 'running' || bot.status === 'reconnecting';
        if (wasRunning) await bot.stop({ isManual: false });

        // Update config
        if (config.name) bot.name = config.name;
        if (config.personality) bot.personality = config.personality;
        if (config.model) bot.model = config.model;
        if (config.aiProvider) bot.aiProvider = config.aiProvider;
        if (config.aiApiKey) bot.aiApiKey = config.aiApiKey;
        if (config.discordToken) bot.discordToken = config.discordToken;
        if (config.triggerMode) bot.triggerMode = config.triggerMode;
        if (config.prefix) bot.prefix = config.prefix;
        if (Array.isArray(config.channels)) bot.channels = config.channels;
        if (Array.isArray(config.tools)) bot.tools = config.tools;
        if (Number.isFinite(config.maxTokens)) bot.maxTokens = config.maxTokens;
        if (Number.isFinite(config.historyLimit)) bot.historyLimit = config.historyLimit;
        if (config.collaborationMode) bot.collaborationMode = config.collaborationMode;
        if (Number.isFinite(config.messageLogLimit)) bot.messageLogLimit = config.messageLogLimit;

        if (wasRunning) await bot.start();
        return bot.getStatus();
    }

    getBotStatus(id) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);
        return bot.getStatus();
    }

    getBotLogs(id) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);
        return bot.getLogs();
    }

    getBotHealth(id) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);
        return bot.getHealth();
    }

    getBotConversations(id) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);
        return bot.getConversations();
    }

    notifyBotResponse({ bot, channelId, userMessage, response, isCollaborationResponse }) {
        if (isCollaborationResponse) return;
        if (!bot || !bot.userId) return;

        for (const peer of this.bots.values()) {
            if (peer.id === bot.id) continue;
            if (peer.userId !== bot.userId) continue;
            if (peer.status !== 'running') continue;
            if (peer.channels.length > 0 && !peer.channels.includes(channelId)) continue;

            peer.respondToCollaboration({
                channelId,
                originBot: bot,
                userMessage,
                response
            });
        }
    }

    getSharedHistory(userId, channelId, limit) {
        const key = `${userId}:${channelId}`;
        if (!this.sharedHistory.has(key)) {
            this.sharedHistory.set(key, []);
        }
        const history = this.sharedHistory.get(key);
        if (limit) {
            while (history.length > limit) history.shift();
        }
        return history;
    }

    getSharedHistorySnapshot(userId, channelId, limit) {
        const history = this.getSharedHistory(userId, channelId, limit);
        return history.map(entry => ({ ...entry }));
    }

    appendSharedHistory(userId, channelId, entry, limit) {
        const history = this.getSharedHistory(userId, channelId, limit);
        history.push({ ...entry });
        if (limit) {
            while (history.length > limit) history.shift();
        }
    }

    getAllBots(userId) {
        const bots = [];
        for (const [id, bot] of this.bots) {
            if (!userId || bot.userId === userId) {
                bots.push(bot.getStatus());
            }
        }
        return bots;
    }

    getStats() {
        let running = 0, stopped = 0, errors = 0, totalMessages = 0;
        for (const bot of this.bots.values()) {
            if (bot.status === 'running') running++;
            else if (bot.status === 'error') errors++;
            else stopped++;
            totalMessages += bot.messageCount;
        }
        return { total: this.bots.size, running, stopped, errors, totalMessages };
    }
}

module.exports = { BotManager, BotInstance };
