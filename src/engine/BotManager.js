/**
 * BotManager - Core engine that manages multiple Discord bot instances
 * Each bot runs as a separate discord.js client with its own config
 */

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { generateResponse } = require('./AIProvider');

class BotInstance {
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.discordToken = config.discordToken;
        this.aiProvider = config.aiProvider || 'openai'; // openai | anthropic
        this.aiApiKey = config.aiApiKey;
        this.model = config.model || 'gpt-4o-mini';
        this.personality = config.personality || 'You are a helpful assistant.';
        this.tools = config.tools || [];
        this.channels = config.channels || []; // empty = all channels
        this.status = 'stopped'; // stopped | starting | running | error
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
    }

    async start() {
        if (this.status === 'running') return;
        
        this.status = 'starting';
        this._notifyStatus();

        try {
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.GuildMembers,
                ]
            });

            this.client.on(Events.ClientReady, () => {
                this.status = 'running';
                this.startedAt = new Date();
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
                this._notifyStatus();
            });

            await this.client.login(this.discordToken);
        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            console.error(`[BotManager] Failed to start bot "${this.name}":`, err.message);
            this._notifyStatus();
            throw err;
        }
    }

    async stop() {
        if (this.client) {
            await this.client.destroy();
            this.client = null;
        }
        this.status = 'stopped';
        this.guilds = [];
        this.startedAt = null;
        console.log(`[BotManager] Bot "${this.name}" (${this.id}) stopped`);
        this._notifyStatus();
    }

    async _handleMessage(message) {
        // Ignore own messages and other bots
        if (message.author.bot) return;

        // Check channel filter
        if (this.channels.length > 0 && !this.channels.includes(message.channel.id)) return;

        // Check trigger mode
        const shouldRespond = this._shouldRespond(message);
        if (!shouldRespond) return;

        try {
            await message.channel.sendTyping();

            // Get conversation history for this channel
            const history = this._getHistory(message.channel.id);
            
            // Add user message to history
            history.push({
                role: 'user',
                content: `${message.author.displayName}: ${message.content}`
            });

            // Trim history
            while (history.length > this.historyLimit) {
                history.shift();
            }

            // Generate AI response
            const response = await generateResponse({
                provider: this.aiProvider,
                apiKey: this.aiApiKey,
                model: this.model,
                systemPrompt: this.personality,
                messages: history,
                maxTokens: this.maxTokens
            });

            // Add response to history
            history.push({
                role: 'assistant',
                content: response
            });

            // Send response (split if too long)
            await this._sendResponse(message, response);
            this.messageCount++;
        } catch (err) {
            console.error(`[Bot ${this.name}] Message handling error:`, err.message);
            // Don't spam the channel with errors
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
        if (!this.conversationHistory.has(channelId)) {
            this.conversationHistory.set(channelId, []);
        }
        return this.conversationHistory.get(channelId);
    }

    async _sendResponse(message, response) {
        // Discord has a 2000 char limit
        if (response.length <= 2000) {
            await message.reply(response);
        } else {
            // Split into chunks
            const chunks = [];
            let remaining = response;
            while (remaining.length > 0) {
                if (remaining.length <= 2000) {
                    chunks.push(remaining);
                    break;
                }
                // Find a good break point
                let breakPoint = remaining.lastIndexOf('\n', 1990);
                if (breakPoint === -1 || breakPoint < 1000) breakPoint = 1990;
                chunks.push(remaining.substring(0, breakPoint));
                remaining = remaining.substring(breakPoint);
            }
            
            for (let i = 0; i < chunks.length; i++) {
                if (i === 0) {
                    await message.reply(chunks[i]);
                } else {
                    await message.channel.send(chunks[i]);
                }
            }
        }
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
            uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0
        };
    }
}

class BotManager {
    constructor() {
        this.bots = new Map(); // id -> BotInstance
    }

    async createBot(config) {
        if (this.bots.has(config.id)) {
            throw new Error(`Bot with id ${config.id} already exists`);
        }

        const bot = new BotInstance(config);
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
        
        const wasRunning = bot.status === 'running';
        if (wasRunning) await bot.stop();
        
        // Update config
        if (config.name) bot.name = config.name;
        if (config.personality) bot.personality = config.personality;
        if (config.model) bot.model = config.model;
        if (config.aiProvider) bot.aiProvider = config.aiProvider;
        if (config.aiApiKey) bot.aiApiKey = config.aiApiKey;
        if (config.discordToken) bot.discordToken = config.discordToken;
        if (config.triggerMode) bot.triggerMode = config.triggerMode;
        if (config.prefix) bot.prefix = config.prefix;
        if (config.channels) bot.channels = config.channels;
        if (config.tools) bot.tools = config.tools;
        if (config.maxTokens) bot.maxTokens = config.maxTokens;
        if (config.historyLimit) bot.historyLimit = config.historyLimit;
        
        if (wasRunning) await bot.start();
        return bot.getStatus();
    }

    getBotStatus(id) {
        const bot = this.bots.get(id);
        if (!bot) throw new Error(`Bot ${id} not found`);
        return bot.getStatus();
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
