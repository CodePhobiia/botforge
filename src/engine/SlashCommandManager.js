/**
 * SlashCommandManager - Registers and handles custom Discord slash commands.
 */

const { REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { listSlashCommands } = require('../db/database');
const { generateResponse } = require('./AIProvider');

const SUPPORTED_TYPES = new Set(['text', 'ai', 'embed']);
const SUPPORTED_OPTION_TYPES = new Set(['string', 'integer', 'boolean', 'user', 'channel', 'role']);
const OPTION_BUILDERS = {
    string: 'addStringOption',
    integer: 'addIntegerOption',
    boolean: 'addBooleanOption',
    user: 'addUserOption',
    channel: 'addChannelOption',
    role: 'addRoleOption'
};

const COMMAND_NAME_REGEX = /^[a-z0-9_-]{1,32}$/;

function normalizeName(value) {
    return String(value || '').trim().toLowerCase();
}

function isValidName(value) {
    return COMMAND_NAME_REGEX.test(value);
}

function sanitizeDescription(value, fallback) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return fallback;
    return trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
}

function splitResponse(response) {
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

function replacePlaceholders(template, context, optionsMap) {
    if (!template) return '';
    return String(template).replace(/\{([a-zA-Z0-9_:\-]+)\}/g, (_, token) => {
        if (token.startsWith('option:')) {
            const key = token.slice('option:'.length).toLowerCase();
            return optionsMap?.[key] ?? '';
        }
        const lower = token.toLowerCase();
        if (context[lower] !== undefined && context[lower] !== null) {
            return String(context[lower]);
        }
        return '';
    });
}

function replaceInObject(value, context, optionsMap) {
    if (typeof value === 'string') return replacePlaceholders(value, context, optionsMap);
    if (Array.isArray(value)) return value.map(item => replaceInObject(item, context, optionsMap));
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = replaceInObject(item, context, optionsMap);
        }
        return result;
    }
    return value;
}

function parseEmbedTemplate(template, context, optionsMap) {
    const trimmed = String(template || '').trim();
    if (!trimmed) {
        return new EmbedBuilder().setDescription('');
    }
    try {
        const parsed = JSON.parse(trimmed);
        const hydrated = replaceInObject(parsed, context, optionsMap);
        if (hydrated.color && typeof hydrated.color === 'string') {
            const hex = hydrated.color.trim();
            if (/^#?[0-9a-fA-F]{6}$/.test(hex)) {
                const hexValue = hex.startsWith('#') ? hex.slice(1) : hex;
                hydrated.color = parseInt(hexValue, 16);
            }
        }
        return new EmbedBuilder(hydrated);
    } catch {
        const fallback = replacePlaceholders(trimmed, context, optionsMap);
        return new EmbedBuilder().setDescription(fallback);
    }
}

class SlashCommandManager {
    constructor(bot) {
        this.bot = bot;
        this.client = null;
        this.applicationId = null;
        this.commandCache = new Map();
        this._rest = null;
    }

    get rest() {
        if (!this._rest) {
            this._rest = new REST({ version: '10' });
            if (this.bot?.discordToken) {
                this._rest.setToken(this.bot.discordToken);
            }
        }
        return this._rest;
    }

    updateFromBot() {
        if (this.bot?.discordToken && this._rest) {
            this._rest.setToken(this.bot.discordToken);
        }
    }

    async attachClient(client) {
        this.client = client;
        this.updateFromBot();
        if (!client) return;

        if (!this.applicationId) {
            this.applicationId = client.application?.id || client.user?.id || null;
        }

        if (!this.applicationId && client.application?.fetch) {
            try {
                const app = await client.application.fetch();
                this.applicationId = app?.id || client.application?.id || null;
            } catch (err) {
                console.warn(`[SlashCommandManager] Failed to fetch application id for ${this.bot?.name || 'bot'}:`, err.message);
            }
        }
    }

    _setCache(commands) {
        this.commandCache.clear();
        commands.forEach(command => {
            if (!command || !command.name) return;
            this.commandCache.set(command.name.toLowerCase(), command);
        });
    }

    async syncCommands() {
        if (!this.client) throw new Error('Bot client not ready');
        await this.attachClient(this.client);
        if (!this.applicationId) throw new Error('Missing application id');

        const commands = listSlashCommands(this.bot.id)
            .filter(command => command && command.enabled !== false);
        this._setCache(commands);

        const payload = [];
        const seen = new Set();

        for (const command of commands) {
            if (!command || !command.name || !command.description) continue;
            const name = normalizeName(command.name);
            if (!isValidName(name) || seen.has(name)) continue;
            if (!SUPPORTED_TYPES.has(command.type)) continue;

            const description = sanitizeDescription(command.description, 'Custom command');
            const builder = new SlashCommandBuilder()
                .setName(name)
                .setDescription(description);

            const options = Array.isArray(command.options) ? command.options : [];
            options.slice(0, 25).forEach(option => {
                const optionName = normalizeName(option?.name);
                const optionType = String(option?.type || '').toLowerCase();
                const method = OPTION_BUILDERS[optionType];
                if (!optionName || !isValidName(optionName)) return;
                if (!method) return;
                const optionDescription = sanitizeDescription(option?.description, `Option ${optionName}`);
                builder[method](opt => opt
                    .setName(optionName)
                    .setDescription(optionDescription)
                    .setRequired(Boolean(option?.required))
                );
            });

            payload.push(builder.toJSON());
            seen.add(name);
        }

        await this.rest.put(Routes.applicationCommands(this.applicationId), { body: payload });
        return { total: payload.length };
    }

    async deregisterAll() {
        if (!this.client) return;
        await this.attachClient(this.client);
        if (!this.applicationId) throw new Error('Missing application id');
        await this.rest.put(Routes.applicationCommands(this.applicationId), { body: [] });
        this.commandCache.clear();
    }

    async getCommand(name) {
        if (!name) return null;
        const key = name.toLowerCase();
        if (this.commandCache.has(key)) return this.commandCache.get(key);
        const commands = listSlashCommands(this.bot.id);
        this._setCache(commands);
        return this.commandCache.get(key) || null;
    }

    _buildTemplateContext(interaction, command, optionsMap) {
        const memberName = interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || 'User';
        const userMention = interaction.user?.id ? `<@${interaction.user.id}>` : memberName;
        const channelName = interaction.channel?.name || 'channel';
        const channelMention = interaction.channel?.id ? `<#${interaction.channel.id}>` : `#${channelName}`;
        const guildName = interaction.guild?.name || 'server';

        return {
            user: userMention,
            username: memberName,
            usertag: interaction.user?.tag || memberName,
            userid: interaction.user?.id || '',
            channel: channelMention,
            channelname: channelName,
            channelid: interaction.channel?.id || '',
            guild: guildName,
            guildname: guildName,
            guildid: interaction.guild?.id || '',
            command: command?.name || interaction.commandName,
            options: Object.values(optionsMap || {}).filter(Boolean).join(', ') || ''
        };
    }

    _extractOptionValues(interaction, command) {
        const options = Array.isArray(command?.options) ? command.options : [];
        const optionValues = {};
        const optionLabels = {};

        const resolveValue = (opt) => {
            const name = opt.name;
            const type = String(opt.type || '').toLowerCase();
            if (!interaction.options) return null;
            switch (type) {
                case 'string':
                    return interaction.options.getString(name);
                case 'integer':
                    return interaction.options.getInteger(name);
                case 'boolean':
                    return interaction.options.getBoolean(name);
                case 'user':
                    return interaction.options.getUser(name);
                case 'channel':
                    return interaction.options.getChannel(name);
                case 'role':
                    return interaction.options.getRole(name);
                default:
                    return null;
            }
        };

        options.forEach(opt => {
            const optionName = normalizeName(opt.name);
            if (!optionName) return;
            const type = String(opt.type || '').toLowerCase();
            const raw = resolveValue(opt);
            if (raw === null || raw === undefined) return;

            let display = '';
            if (raw && typeof raw === 'object') {
                if (type === 'user' && raw.id) {
                    display = `<@${raw.id}>`;
                    optionLabels[optionName] = raw.username || raw.globalName || raw.id;
                } else if (type === 'channel' && raw.id) {
                    display = `<#${raw.id}>`;
                    optionLabels[optionName] = raw.name || raw.id;
                } else if (type === 'role' && raw.id) {
                    display = `<@&${raw.id}>`;
                    optionLabels[optionName] = raw.name || raw.id;
                }
            } else {
                display = String(raw);
            }

            optionValues[optionName] = display || String(raw);
        });

        if (interaction.options?.data?.length) {
            interaction.options.data.forEach(entry => {
                const optionName = normalizeName(entry.name);
                if (!optionName || optionValues[optionName]) return;
                const raw = entry.value;
                if (raw === undefined || raw === null) return;
                optionValues[optionName] = String(raw);
            });
        }

        return { optionValues, optionLabels };
    }

    _formatOptionSummary(optionValues, optionLabels) {
        const entries = Object.entries(optionValues || {});
        if (!entries.length) return '';
        return entries.map(([key, value]) => {
            const label = optionLabels?.[key];
            const display = label ? `${label} (${value})` : value;
            return `${key}: ${display}`;
        }).join(', ');
    }

    _emitCommandEvent(direction, interaction, command, count = 1) {
        if (!this.bot?.manager || !this.bot.manager.emitBotEvent) return;
        const payload = {
            botId: this.bot.id,
            userId: this.bot.userId,
            direction,
            command: command?.name || interaction?.commandName || null,
            count: direction === 'sent' ? count : undefined,
            channelId: interaction?.channelId || null,
            timestamp: new Date().toISOString()
        };
        this.bot.manager.emitBotEvent('message', payload);
    }

    async _sendText(interaction, content, { defer = false } = {}) {
        const chunks = splitResponse(content);
        if (defer && !interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        const first = chunks.shift() || '';
        if (interaction.deferred) {
            await interaction.editReply(first);
        } else if (!interaction.replied) {
            await interaction.reply(first);
        } else {
            await interaction.followUp(first);
        }

        for (const chunk of chunks) {
            // eslint-disable-next-line no-await-in-loop
            await interaction.followUp(chunk);
        }
        return chunks.length + 1;
    }

    async _sendEmbed(interaction, embed, { defer = false } = {}) {
        if (defer && !interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        const payload = { embeds: [embed] };
        if (interaction.deferred) {
            await interaction.editReply(payload);
        } else if (!interaction.replied) {
            await interaction.reply(payload);
        } else {
            await interaction.followUp(payload);
        }
        return 1;
    }

    async handleInteraction(interaction) {
        if (!interaction?.isChatInputCommand || !interaction.isChatInputCommand()) return;
        if (Array.isArray(this.bot?.channels) && this.bot.channels.length > 0) {
            if (!interaction.channelId || !this.bot.channels.includes(interaction.channelId)) {
                return;
            }
        }

        const command = await this.getCommand(interaction.commandName);
        if (!command || command.enabled === false) {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'This command is not available.', ephemeral: true }).catch(() => {});
            }
            return;
        }

        const startTime = Date.now();
        const { optionValues, optionLabels } = this._extractOptionValues(interaction, command);
        const context = this._buildTemplateContext(interaction, command, optionValues);
        const optionSummary = this._formatOptionSummary(optionValues, optionLabels);
        const responseTemplate = command.responseTemplate || '';

        this._emitCommandEvent('received', interaction, command);

        let responseContent = '';
        let modelUsed = null;
        let tokensUsed = null;
        let sentCount = 0;

        try {
            if (command.type === 'ai') {
                const userPrompt = responseTemplate
                    ? replacePlaceholders(responseTemplate, context, optionValues)
                    : `Slash command /${command.name} invoked. ${optionSummary ? `Options: ${optionSummary}` : 'No options provided.'}`;
                const aiResult = await generateResponse({
                    provider: this.bot.aiProvider,
                    apiKey: this.bot.aiApiKey,
                    model: this.bot.model,
                    systemPrompt: this.bot.personality,
                    messages: [{ role: 'user', content: userPrompt }],
                    maxTokens: this.bot.maxTokens
                });
                responseContent = aiResult?.content || '';
                modelUsed = aiResult?.modelUsed || this.bot.model;
                tokensUsed = aiResult?.tokensUsed ?? null;
                sentCount = await this._sendText(interaction, responseContent, { defer: true });
            } else if (command.type === 'embed') {
                const embed = parseEmbedTemplate(responseTemplate, context, optionValues);
                sentCount = await this._sendEmbed(interaction, embed, { defer: false });
                responseContent = embed?.data?.description || embed?.data?.title || '';
            } else {
                responseContent = replacePlaceholders(responseTemplate, context, optionValues) || 'Command executed.';
                sentCount = await this._sendText(interaction, responseContent, { defer: false });
            }
        } catch (err) {
            console.error(`[SlashCommandManager] Failed to handle /${command.name}:`, err.message);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '⚠️ Command failed to run.', ephemeral: true }).catch(() => {});
            } else if (interaction.deferred) {
                await interaction.editReply('⚠️ Command failed to run.').catch(() => {});
            }
            return;
        }

        const duration = Date.now() - startTime;
        if (this.bot) {
            this.bot.messageCount += sentCount;
            if (this.bot._recordResponse) {
                this.bot._recordResponse(duration);
            }
            if (this.bot._logConversationEntry) {
                const channelName = interaction.channel?.name || null;
                const userLabel = interaction.member?.displayName || interaction.user?.username || 'User';
                const messageContent = `/${command.name}${optionSummary ? ` ${optionSummary}` : ''}`;
                this.bot._logConversationEntry({
                    userId: interaction.user?.id || null,
                    username: userLabel,
                    channelId: interaction.channelId || null,
                    channelName,
                    messageContent,
                    botResponse: responseContent,
                    timestamp: interaction.createdTimestamp || Date.now(),
                    modelUsed,
                    tokensUsed
                });
            }
        }

        this._emitCommandEvent('sent', interaction, command, sentCount);
    }
}

module.exports = { SlashCommandManager };
