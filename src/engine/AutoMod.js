/**
 * AutoMod - Lightweight auto-moderation engine for Discord messages.
 */

const { PermissionsBitField } = require('discord.js');

const ACTIONS = new Set(['warn', 'delete', 'mute', 'kick', 'ban']);
const URL_REGEX = /\b(https?:\/\/[^\s<]+|www\.[^\s<]+)\b/gi;

const DEFAULT_CONFIG = {
    defaultAction: 'warn',
    muteDurationSeconds: 600,
    wordFilter: {
        enabled: false,
        bannedWords: [],
        action: null
    },
    spam: {
        enabled: false,
        repeatWindowSeconds: 6,
        capsThresholdPercent: 70,
        mentionsLimit: 5,
        minCapsLength: 8,
        action: null
    },
    linkFilter: {
        enabled: false,
        whitelist: [],
        action: null
    },
    raidProtection: {
        enabled: false,
        joinThreshold: 10,
        joinWindowSeconds: 60,
        lockdownDurationSeconds: 300,
        action: 'delete'
    }
};

const DEFAULT_AUTOMOD_CONFIG = DEFAULT_CONFIG;

function clampNumber(value, { min, max, fallback }) {
    if (!Number.isFinite(value)) return fallback;
    if (min !== undefined && value < min) return min;
    if (max !== undefined && value > max) return max;
    return value;
}

function normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    return fallback;
}

function normalizeAction(value, fallback) {
    if (typeof value === 'string' && ACTIONS.has(value)) return value;
    return fallback;
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(item => item.length > 0);
}

function normalizeConfig(input = {}) {
    const config = input && typeof input === 'object' ? input : {};
    const normalized = {
        defaultAction: normalizeAction(config.defaultAction, DEFAULT_CONFIG.defaultAction),
        muteDurationSeconds: clampNumber(config.muteDurationSeconds, { min: 60, max: 86400, fallback: DEFAULT_CONFIG.muteDurationSeconds }),
        wordFilter: {
            enabled: normalizeBoolean(config.wordFilter?.enabled, DEFAULT_CONFIG.wordFilter.enabled),
            bannedWords: normalizeStringArray(config.wordFilter?.bannedWords || config.wordFilter?.banned || []),
            action: normalizeAction(config.wordFilter?.action, null)
        },
        spam: {
            enabled: normalizeBoolean(config.spam?.enabled, DEFAULT_CONFIG.spam.enabled),
            repeatWindowSeconds: clampNumber(config.spam?.repeatWindowSeconds, { min: 2, max: 60, fallback: DEFAULT_CONFIG.spam.repeatWindowSeconds }),
            capsThresholdPercent: clampNumber(config.spam?.capsThresholdPercent, { min: 30, max: 100, fallback: DEFAULT_CONFIG.spam.capsThresholdPercent }),
            mentionsLimit: clampNumber(config.spam?.mentionsLimit, { min: 1, max: 50, fallback: DEFAULT_CONFIG.spam.mentionsLimit }),
            minCapsLength: clampNumber(config.spam?.minCapsLength, { min: 4, max: 50, fallback: DEFAULT_CONFIG.spam.minCapsLength }),
            action: normalizeAction(config.spam?.action, null)
        },
        linkFilter: {
            enabled: normalizeBoolean(config.linkFilter?.enabled, DEFAULT_CONFIG.linkFilter.enabled),
            whitelist: normalizeStringArray(config.linkFilter?.whitelist),
            action: normalizeAction(config.linkFilter?.action, null)
        },
        raidProtection: {
            enabled: normalizeBoolean(config.raidProtection?.enabled, DEFAULT_CONFIG.raidProtection.enabled),
            joinThreshold: clampNumber(config.raidProtection?.joinThreshold, { min: 2, max: 200, fallback: DEFAULT_CONFIG.raidProtection.joinThreshold }),
            joinWindowSeconds: clampNumber(config.raidProtection?.joinWindowSeconds, { min: 10, max: 600, fallback: DEFAULT_CONFIG.raidProtection.joinWindowSeconds }),
            lockdownDurationSeconds: clampNumber(config.raidProtection?.lockdownDurationSeconds, { min: 60, max: 3600, fallback: DEFAULT_CONFIG.raidProtection.lockdownDurationSeconds }),
            action: normalizeAction(config.raidProtection?.action, DEFAULT_CONFIG.raidProtection.action)
        }
    };

    return normalized;
}

class AutoMod {
    constructor(config = {}) {
        this.messageHistory = new Map();
        this.joinHistory = new Map();
        this.lockdowns = new Map();
        this.updateConfig(config);
    }

    static normalizeConfig(config) {
        return normalizeConfig(config);
    }

    getConfig() {
        return { ...this.config };
    }

    updateConfig(config = {}) {
        this.config = normalizeConfig(config);
    }

    handleMemberJoin(member) {
        if (!member || !member.guild) return null;
        if (!this.config.raidProtection.enabled) return null;

        const guildId = member.guild.id;
        const now = Date.now();
        const windowMs = this.config.raidProtection.joinWindowSeconds * 1000;
        const bucket = this._getJoinBucket(guildId);

        bucket.push(now);
        this._prune(bucket, now - windowMs);

        if (bucket.length >= this.config.raidProtection.joinThreshold) {
            const until = now + this.config.raidProtection.lockdownDurationSeconds * 1000;
            this.lockdowns.set(guildId, until);
            return {
                triggered: true,
                guildId,
                count: bucket.length,
                lockdownUntil: until
            };
        }

        return { triggered: false, guildId, count: bucket.length };
    }

    isLockdownActive(guildId) {
        if (!guildId) return false;
        const until = this.lockdowns.get(guildId);
        if (!until) return false;
        if (Date.now() > until) {
            this.lockdowns.delete(guildId);
            return false;
        }
        return true;
    }

    checkMessage(message) {
        if (!message) return null;
        if (this._isExempt(message)) return null;

        const content = message.content || '';
        const guildId = message.guild?.id || null;

        if (this.config.raidProtection.enabled && this.isLockdownActive(guildId)) {
            return {
                violationType: 'raid_lockdown',
                action: this._resolveAction(this.config.raidProtection.action),
                reason: 'Server is in lockdown'
            };
        }

        if (this.config.wordFilter.enabled) {
            const hit = this._findBanned(content);
            if (hit) {
                return {
                    violationType: 'word_filter',
                    action: this._resolveAction(this.config.wordFilter.action),
                    reason: `Matched banned term "${hit}"`
                };
            }
        }

        if (this.config.linkFilter.enabled) {
            const blocked = this._findBlockedLink(content);
            if (blocked) {
                return {
                    violationType: 'link_blocked',
                    action: this._resolveAction(this.config.linkFilter.action),
                    reason: `Blocked link "${blocked}"`
                };
            }
        }

        if (this.config.spam.enabled) {
            if (this._isRepeat(message)) {
                return {
                    violationType: 'spam_repeat',
                    action: this._resolveAction(this.config.spam.action),
                    reason: 'Repeated message within spam window'
                };
            }

            const caps = this._capsStats(content);
            if (caps.letters >= this.config.spam.minCapsLength && caps.percent >= this.config.spam.capsThresholdPercent) {
                return {
                    violationType: 'spam_caps',
                    action: this._resolveAction(this.config.spam.action),
                    reason: `Excessive caps (${caps.percent}%)`
                };
            }

            const mentionCount = this._countMentions(message);
            if (mentionCount > this.config.spam.mentionsLimit) {
                return {
                    violationType: 'spam_mentions',
                    action: this._resolveAction(this.config.spam.action),
                    reason: `Too many mentions (${mentionCount})`
                };
            }
        }

        return null;
    }

    async applyAction(message, violation) {
        const action = this._resolveAction(violation?.action);
        const result = { action, applied: false, error: null };

        try {
            if (!message) throw new Error('Missing message');

            if (action === 'warn') {
                const notice = violation?.reason
                    ? `AutoMod warning: ${violation.reason}`
                    : 'AutoMod warning: your message violated server rules.';
                if (message.reply) {
                    await message.reply(notice);
                } else if (message.channel?.send) {
                    await message.channel.send(notice);
                }
                result.applied = true;
                return result;
            }

            if (action === 'delete') {
                if (message.deletable && message.delete) {
                    await message.delete();
                } else if (message.delete) {
                    await message.delete();
                } else {
                    throw new Error('Message not deletable');
                }
                result.applied = true;
                return result;
            }

            const member = message.member;
            if (!member) throw new Error('Member not available for moderation');

            if (action === 'mute') {
                const durationMs = this.config.muteDurationSeconds * 1000;
                await member.timeout(durationMs, violation?.reason || 'AutoMod timeout');
                result.applied = true;
                return result;
            }

            if (action === 'kick') {
                await member.kick(violation?.reason || 'AutoMod kick');
                result.applied = true;
                return result;
            }

            if (action === 'ban') {
                await member.ban({ reason: violation?.reason || 'AutoMod ban' });
                result.applied = true;
                return result;
            }
        } catch (err) {
            result.error = err.message;
        }

        return result;
    }

    _resolveAction(actionOverride) {
        return normalizeAction(actionOverride, this.config.defaultAction);
    }

    _isExempt(message) {
        const member = message.member;
        if (!member || !member.permissions) return false;
        return member.permissions.has(PermissionsBitField.Flags.Administrator)
            || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
            || member.permissions.has(PermissionsBitField.Flags.ManageMessages);
    }

    _findBanned(content) {
        if (!content) return null;
        const lower = content.toLowerCase();
        for (const term of this.config.wordFilter.bannedWords) {
            const cleaned = term.toLowerCase();
            if (!cleaned) continue;
            if (/\W/.test(cleaned)) {
                if (lower.includes(cleaned)) return term;
            } else {
                const regex = new RegExp(`\\b${this._escapeRegex(cleaned)}\\b`, 'i');
                if (regex.test(content)) return term;
            }
        }
        return null;
    }

    _findBlockedLink(content) {
        if (!content) return null;
        const links = content.match(URL_REGEX) || [];
        if (!links.length) return null;
        for (const link of links) {
            if (!this._isWhitelisted(link)) {
                return link;
            }
        }
        return null;
    }

    _isWhitelisted(link) {
        const whitelist = this.config.linkFilter.whitelist || [];
        if (!whitelist.length) return false;
        const normalized = link.startsWith('http') ? link : `https://${link}`;
        let host = '';
        try {
            host = new URL(normalized).hostname.toLowerCase();
        } catch {
            host = normalized.toLowerCase();
        }
        return whitelist.some((allowed) => {
            const cleaned = allowed.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
            if (!cleaned) return false;
            return host === cleaned || host.endsWith(`.${cleaned}`);
        });
    }

    _isRepeat(message) {
        if (!message || !message.author) return false;
        const windowMs = this.config.spam.repeatWindowSeconds * 1000;
        const now = Date.now();
        const key = `${message.guild?.id || message.channel?.id || 'dm'}:${message.author.id}`;
        const bucket = this.messageHistory.get(key) || [];
        const normalized = this._normalizeContent(message.content || '');

        const repeated = bucket.some(entry => entry.content === normalized && (now - entry.timestamp) <= windowMs);
        bucket.push({ content: normalized, timestamp: now });
        this._prune(bucket, now - windowMs * 2);
        while (bucket.length > 20) bucket.shift();
        this.messageHistory.set(key, bucket);
        return repeated;
    }

    _normalizeContent(content) {
        return content.trim().toLowerCase();
    }

    _capsStats(content) {
        if (!content) return { percent: 0, letters: 0 };
        const letters = content.match(/[a-z]/gi);
        if (!letters || !letters.length) return { percent: 0, letters: 0 };
        const upper = letters.filter(char => char === char.toUpperCase()).length;
        const percent = Math.round((upper / letters.length) * 100);
        return { percent, letters: letters.length };
    }

    _countMentions(message) {
        if (!message) return 0;
        let count = 0;
        if (message.mentions) {
            count += message.mentions.users?.size || 0;
            count += message.mentions.roles?.size || 0;
        }
        const content = message.content || '';
        const extra = (content.match(/<@!?(\d+)>/g) || []).length;
        const roleMentions = (content.match(/<@&(\d+)>/g) || []).length;
        count = Math.max(count, extra + roleMentions);
        return count;
    }

    _getJoinBucket(guildId) {
        if (!this.joinHistory.has(guildId)) {
            this.joinHistory.set(guildId, []);
        }
        return this.joinHistory.get(guildId);
    }

    _prune(bucket, cutoff) {
        while (bucket.length && bucket[0] < cutoff) {
            bucket.shift();
        }
    }

    _escapeRegex(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

module.exports = { AutoMod, DEFAULT_AUTOMOD_CONFIG };
