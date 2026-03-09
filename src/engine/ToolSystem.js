/**
 * ToolSystem - Modular tool system for bots.
 */

const DEFAULT_MAX_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_REMINDER_MS = 1000;

function parseToolArgs(rawArgs) {
    if (!rawArgs) return null;
    const trimmed = rawArgs.trim();
    if (!trimmed) return null;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.parse(trimmed);
        } catch (err) {
            return trimmed;
        }
    }
    return trimmed;
}

function stripToolCalls(text) {
    return text.replace(/\[TOOL:[^\]]+\]/g, '').trim();
}

function parseDurationString(text) {
    if (!text) return null;
    const match = text.trim().match(/^(\d+(?:\.\d+)?)(\s*)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/i);
    if (!match) return null;

    const value = parseFloat(match[1]);
    const unit = match[3].toLowerCase();

    if (Number.isNaN(value)) return null;

    if (unit.startsWith('s')) return Math.round(value * 1000);
    if (unit.startsWith('m')) return Math.round(value * 60 * 1000);
    if (unit.startsWith('h')) return Math.round(value * 60 * 60 * 1000);
    if (unit.startsWith('d')) return Math.round(value * 24 * 60 * 60 * 1000);
    if (unit.startsWith('w')) return Math.round(value * 7 * 24 * 60 * 60 * 1000);

    return null;
}

function safeEvaluate(expression) {
    if (typeof expression !== 'string') {
        throw new Error('Expression must be a string.');
    }
    const trimmed = expression.trim();
    if (!trimmed) throw new Error('Expression is empty.');

    if (!/^[0-9+\-*/%^().\s]+$/.test(trimmed)) {
        throw new Error('Expression contains invalid characters.');
    }

    const normalized = trimmed.replace(/\^/g, '**');

    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${normalized});`)();

    if (Number.isNaN(result) || result === Infinity || result === -Infinity) {
        throw new Error('Expression did not produce a valid number.');
    }

    return result;
}

function extractQuery(args) {
    if (!args) return null;
    if (typeof args === 'string') return args;
    if (typeof args === 'object') {
        return args.query || args.q || args.search || null;
    }
    return null;
}

function extractExpression(args) {
    if (!args) return null;
    if (typeof args === 'string') return args;
    if (typeof args === 'object') return args.expression || args.expr || null;
    return null;
}

function extractTimezone(args) {
    if (!args) return 'UTC';
    if (typeof args === 'string') return args;
    if (typeof args === 'object') return args.timezone || args.tz || 'UTC';
    return 'UTC';
}

function parseReminderArgs(args) {
    if (!args) return null;

    if (typeof args === 'string') {
        const durationMs = parseDurationString(args);
        const remainder = durationMs ? args.replace(/^(\d+(?:\.\d+)?\s*\w+)\s*/i, '') : args;
        return {
            delayMs: durationMs,
            message: remainder.trim() || 'Reminder'
        };
    }

    if (typeof args === 'object') {
        const delayMs =
            args.delayMs ||
            (args.delaySeconds ? args.delaySeconds * 1000 : null) ||
            (args.delayMinutes ? args.delayMinutes * 60 * 1000 : null) ||
            (args.delayHours ? args.delayHours * 60 * 60 * 1000 : null) ||
            (args.in ? parseDurationString(args.in) : null) ||
            (args.delay ? parseDurationString(args.delay) : null);

        return {
            delayMs,
            message: (args.message || args.text || args.note || 'Reminder').toString().trim()
        };
    }

    return null;
}

function flattenRelatedTopics(relatedTopics) {
    const results = [];

    const walk = (items) => {
        for (const item of items || []) {
            if (item.Text) results.push(item.Text);
            if (Array.isArray(item.Topics)) walk(item.Topics);
        }
    };

    walk(relatedTopics);
    return results;
}

function createBuiltInTools({ reminderStore, maxReminderMs, minReminderMs }) {
    const reminders = reminderStore || new Map();
    const maxDelay = maxReminderMs || DEFAULT_MAX_REMINDER_MS;
    const minDelay = minReminderMs || DEFAULT_MIN_REMINDER_MS;

    return [
        {
            name: 'web_search',
            description: 'Search the web using DuckDuckGo instant answers.',
            execute: async (args) => {
                const query = extractQuery(args);
                if (!query) throw new Error('Missing search query.');

                if (typeof fetch !== 'function') {
                    throw new Error('Fetch API is not available in this runtime.');
                }

                const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`DuckDuckGo request failed (${response.status}).`);
                }

                const data = await response.json();
                const related = flattenRelatedTopics(data.RelatedTopics).slice(0, 5);

                return {
                    query,
                    heading: data.Heading || null,
                    abstract: data.AbstractText || null,
                    answer: data.Answer || null,
                    definition: data.Definition || null,
                    source: data.AbstractURL || null,
                    related
                };
            }
        },
        {
            name: 'calculator',
            description: 'Safely evaluate math expressions.',
            execute: async (args) => {
                const expression = extractExpression(args);
                if (!expression) throw new Error('Missing math expression.');
                const result = safeEvaluate(expression);
                return { expression, result };
            }
        },
        {
            name: 'current_time',
            description: 'Return the current time for a given timezone.',
            execute: async (args) => {
                const timezone = extractTimezone(args);
                const now = new Date();
                try {
                    const formatter = new Intl.DateTimeFormat('en-US', {
                        timeZone: timezone,
                        dateStyle: 'full',
                        timeStyle: 'long'
                    });

                    return {
                        timezone,
                        time: formatter.format(now),
                        iso: now.toISOString()
                    };
                } catch (err) {
                    throw new Error(`Invalid timezone: ${timezone}`);
                }
            }
        },
        {
            name: 'reminder',
            description: 'Set a reminder that will be delivered after a delay.',
            execute: async (args, context = {}) => {
                const parsed = parseReminderArgs(args);
                if (!parsed || !parsed.delayMs) {
                    throw new Error('Missing reminder delay. Example: "10m take a break"');
                }
                if (parsed.delayMs < minDelay) {
                    throw new Error('Reminder delay is too short.');
                }
                if (parsed.delayMs > maxDelay) {
                    throw new Error('Reminder delay is too long.');
                }
                if (!context.sendMessage) {
                    throw new Error('Reminder tool requires a messaging context.');
                }

                const id = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const dueAt = new Date(Date.now() + parsed.delayMs);

                const timer = setTimeout(async () => {
                    try {
                        const mention = context.userId ? `<@${context.userId}> ` : '';
                        await context.sendMessage(`${mention}⏰ Reminder: ${parsed.message}`.trim());
                    } finally {
                        reminders.delete(id);
                    }
                }, parsed.delayMs);

                reminders.set(id, {
                    id,
                    userId: context.userId || null,
                    channelId: context.channelId || null,
                    message: parsed.message,
                    dueAt: dueAt.toISOString(),
                    createdAt: new Date().toISOString(),
                    timer
                });

                return {
                    id,
                    message: parsed.message,
                    dueAt: dueAt.toISOString()
                };
            }
        }
    ];
}

class ToolSystem {
    constructor(options = {}) {
        this.tools = new Map();
        this.reminderStore = options.reminderStore || new Map();
        this.maxReminderMs = options.maxReminderMs || DEFAULT_MAX_REMINDER_MS;
        this.minReminderMs = options.minReminderMs || DEFAULT_MIN_REMINDER_MS;

        const builtIns = createBuiltInTools({
            reminderStore: this.reminderStore,
            maxReminderMs: this.maxReminderMs,
            minReminderMs: this.minReminderMs
        });
        builtIns.forEach((tool) => this.registerTool(tool));

        (options.tools || []).forEach((tool) => this.registerTool(tool));
    }

    registerTool(tool) {
        if (!tool || !tool.name || typeof tool.execute !== 'function') {
            throw new Error('Invalid tool definition.');
        }
        this.tools.set(tool.name, tool);
    }

    getTool(name) {
        return this.tools.get(name);
    }

    listTools() {
        return Array.from(this.tools.values()).map((tool) => ({
            name: tool.name,
            description: tool.description
        }));
    }

    parseToolCalls(text) {
        if (!text) return [];
        const regex = /\[TOOL:([a-zA-Z0-9_\-]+):([\s\S]*?)\]/g;
        const calls = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
            calls.push({
                name: match[1].trim(),
                args: parseToolArgs(match[2]),
                raw: match[0]
            });
        }
        return calls;
    }

    stripToolCalls(text) {
        return stripToolCalls(text || '');
    }

    async executeToolCall(call, context = {}, allowedTools = null) {
        if (!call || !call.name) {
            return { name: 'unknown', error: 'Invalid tool call.' };
        }

        if (Array.isArray(allowedTools) && !allowedTools.includes(call.name)) {
            return { name: call.name, error: 'Tool is not enabled for this bot.' };
        }

        const tool = this.getTool(call.name);
        if (!tool) {
            return { name: call.name, error: 'Tool not found.' };
        }

        try {
            const result = await tool.execute(call.args, context);
            return { name: call.name, result };
        } catch (err) {
            return { name: call.name, error: err.message };
        }
    }
}

module.exports = { ToolSystem };
