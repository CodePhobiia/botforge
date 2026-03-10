const EventEmitter = require('events');
const { Cron } = require('croner');

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MAP = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    weds: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CRON_FIELD_COUNT = 5;
const DEFAULT_TIMEZONE = 'UTC';

function normalizeTime(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    const match = TIME_REGEX.exec(trimmed);
    if (!match) return null;
    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    const normalized = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return { normalized, minutes: hours * 60 + minutes };
}

function normalizeDays(raw) {
    if (!Array.isArray(raw)) return null;
    const values = [];
    for (const entry of raw) {
        if (typeof entry === 'number' && Number.isInteger(entry)) {
            values.push(entry);
            continue;
        }
        if (typeof entry === 'string') {
            const key = entry.trim().toLowerCase();
            if (Object.prototype.hasOwnProperty.call(DAY_MAP, key)) {
                values.push(DAY_MAP[key]);
                continue;
            }
            const asNumber = Number.parseInt(key, 10);
            if (!Number.isNaN(asNumber)) {
                values.push(asNumber);
            }
        }
    }

    const unique = Array.from(new Set(values))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
        .sort((a, b) => a - b);

    return unique.length ? unique : null;
}

function validateCronExpression(expression) {
    if (typeof expression !== 'string' || !expression.trim()) {
        return 'Cron expression required';
    }
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== CRON_FIELD_COUNT) {
        return 'Cron expression must have 5 fields (minute hour day month day-of-week)';
    }
    try {
        new Cron(expression.trim(), { timezone: DEFAULT_TIMEZONE, paused: true });
    } catch (err) {
        return 'Invalid cron expression';
    }
    return null;
}

function normalizeSchedule(raw) {
    if (!raw || typeof raw !== 'object') {
        return { error: 'Schedule must be an object' };
    }

    const type = String(raw.type || '').trim().toLowerCase();
    if (!type) {
        return { error: 'Schedule type required' };
    }

    if (type === 'daily' || type === 'weekly') {
        const startValue = raw.startTime ?? raw.start_time ?? raw.start;
        const stopValue = raw.stopTime ?? raw.stop_time ?? raw.stop;
        const start = normalizeTime(startValue);
        const stop = normalizeTime(stopValue);
        if (!start || !stop) {
            return { error: 'startTime and stopTime must be in HH:MM (UTC) format' };
        }
        if (start.minutes === stop.minutes) {
            return { error: 'startTime and stopTime cannot be the same' };
        }

        const schedule = {
            type,
            startTime: start.normalized,
            stopTime: stop.normalized,
            timezone: DEFAULT_TIMEZONE
        };

        if (type === 'weekly') {
            const days = normalizeDays(raw.days ?? raw.dayOfWeek ?? raw.day_of_week ?? raw.weekdays);
            if (!days || !days.length) {
                return { error: 'Weekly schedules require at least one day (0-6)' };
            }
            schedule.days = days;
        }

        return { schedule };
    }

    if (type === 'cron') {
        const expression = raw.cron ?? raw.expression;
        const cronError = validateCronExpression(expression);
        if (cronError) {
            return { error: cronError };
        }
        return {
            schedule: {
                type,
                cron: String(expression).trim(),
                timezone: DEFAULT_TIMEZONE
            }
        };
    }

    return { error: 'Unsupported schedule type' };
}

function getUtcTimeContext(now = new Date()) {
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const day = now.getUTCDay();
    const minuteDate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        now.getUTCMinutes(),
        0,
        0
    ));
    return { now, minutes, day, minuteDate };
}

function isTimeInWindow(startMinutes, stopMinutes, nowMinutes) {
    if (startMinutes < stopMinutes) {
        return nowMinutes >= startMinutes && nowMinutes < stopMinutes;
    }
    return nowMinutes >= startMinutes || nowMinutes < stopMinutes;
}

function buildCronJob(expression) {
    return new Cron(expression, { timezone: DEFAULT_TIMEZONE, paused: true });
}

function cronMatches(job, minuteDate) {
    if (!job || !minuteDate) return false;
    const probe = new Date(minuteDate.getTime() - 1000);
    const next = job.nextRun(probe);
    return next && next.getTime() === minuteDate.getTime();
}

class Scheduler extends EventEmitter {
    constructor({ botManager, botController, logBotEvent, logger } = {}) {
        super();
        this.botController = botController || botManager;
        this.logBotEvent = logBotEvent;
        this.logger = logger || console;
        this.botMeta = new Map();
        this.schedules = new Map();
        this.interval = null;
        this.timeout = null;
        this.isTicking = false;
        this.inFlight = new Set();
    }

    registerBot(config) {
        if (!config || !config.id) return;
        this.botMeta.set(config.id, { userId: config.userId, name: config.name });
        if (config.schedule) {
            this.setSchedule(config.id, config.schedule, { userId: config.userId, name: config.name });
        }
    }

    unregisterBot(botId) {
        if (!botId) return;
        this.schedules.delete(botId);
        this.botMeta.delete(botId);
        this.inFlight.delete(botId);
    }

    setSchedule(botId, schedule, meta = {}) {
        if (!botId) return;
        if (meta.userId || meta.name) {
            const existing = this.botMeta.get(botId) || {};
            this.botMeta.set(botId, { ...existing, ...meta });
        }

        if (!schedule) {
            this.schedules.delete(botId);
            return;
        }

        const entry = this._buildEntry(schedule, botId);
        if (!entry) {
            this.schedules.delete(botId);
            return;
        }
        this.schedules.set(botId, entry);
    }

    removeSchedule(botId) {
        if (!botId) return;
        this.schedules.delete(botId);
    }

    start() {
        if (this.interval || this.timeout) return;
        this._tick();
        const now = new Date();
        const delay = 60000 - (now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());
        this.timeout = setTimeout(() => {
            this.timeout = null;
            this._tick();
            this.interval = setInterval(() => this._tick(), 60000);
        }, delay);
    }

    stop() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    async checkNow(botId) {
        if (!botId) return;
        const entry = this.schedules.get(botId);
        if (!entry) return;
        const context = getUtcTimeContext(new Date());
        await this._evaluateEntry(entry, context);
    }

    async _tick() {
        if (this.isTicking) return;
        if (!this.schedules.size) return;
        this.isTicking = true;
        const context = getUtcTimeContext(new Date());
        const tasks = [];

        for (const entry of this.schedules.values()) {
            tasks.push(this._evaluateEntry(entry, context));
        }

        await Promise.allSettled(tasks);
        this.isTicking = false;
    }

    async _evaluateEntry(entry, context) {
        if (!entry || !entry.botId) return;
        if (this.inFlight.has(entry.botId)) return;

        const shouldRun = this._shouldRun(entry, context);

        let status;
        try {
            status = this.botController.getBotStatus(entry.botId);
        } catch {
            return;
        }

        const state = status?.desiredStatus || status?.status || 'stopped';

        if (shouldRun && (state === 'stopped' || state === 'error')) {
            await this._startBot(entry, status);
        } else if (!shouldRun && (state === 'running' || state === 'starting' || state === 'reconnecting')) {
            await this._stopBot(entry, status);
        }
    }

    _shouldRun(entry, context) {
        const { schedule } = entry;
        if (!schedule) return false;
        if (schedule.type === 'cron') {
            return cronMatches(entry.cronJob, context.minuteDate);
        }

        const nowMinutes = context.minutes;
        if (schedule.type === 'daily') {
            return isTimeInWindow(entry.startMinutes, entry.stopMinutes, nowMinutes);
        }

        if (schedule.type === 'weekly') {
            const day = context.day;
            const prevDay = (day + 6) % 7;
            if (entry.startMinutes < entry.stopMinutes) {
                return entry.days.has(day) && nowMinutes >= entry.startMinutes && nowMinutes < entry.stopMinutes;
            }
            if (entry.days.has(day) && nowMinutes >= entry.startMinutes) return true;
            return entry.days.has(prevDay) && nowMinutes < entry.stopMinutes;
        }

        return false;
    }

    async _startBot(entry, status) {
        this.inFlight.add(entry.botId);
        try {
            const result = await this.botController.startBot(entry.botId);
            const eventType = result?.eventType || 'started';
            const message = result?.executed === false
                ? `Scheduled start request${this._scheduleLabel(entry)}`
                : `Scheduled start${this._scheduleLabel(entry)}`;
            this._logScheduleEvent(entry, eventType, message);
            this.emit('schedule', {
                botId: entry.botId,
                userId: entry.userId,
                name: entry.name,
                action: result?.executed === false ? 'start_requested' : 'start',
                schedule: entry.schedule,
                previousStatus: status?.status,
                status: result?.status || status,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            this._logScheduleError(entry, err);
        } finally {
            this.inFlight.delete(entry.botId);
        }
    }

    async _stopBot(entry, status) {
        this.inFlight.add(entry.botId);
        try {
            const result = await this.botController.stopBot(entry.botId);
            const eventType = result?.eventType || 'stopped';
            const message = result?.executed === false
                ? `Scheduled stop request${this._scheduleLabel(entry)}`
                : `Scheduled stop${this._scheduleLabel(entry)}`;
            this._logScheduleEvent(entry, eventType, message);
            this.emit('schedule', {
                botId: entry.botId,
                userId: entry.userId,
                name: entry.name,
                action: result?.executed === false ? 'stop_requested' : 'stop',
                schedule: entry.schedule,
                previousStatus: status?.status,
                status: result?.status || status,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            this._logScheduleError(entry, err);
        } finally {
            this.inFlight.delete(entry.botId);
        }
    }

    _logScheduleEvent(entry, eventType, message) {
        if (this.logBotEvent) {
            try {
                this.logBotEvent(entry.botId, eventType, message);
            } catch (err) {
                this.logger.warn('[Scheduler] Failed to log schedule event:', err.message);
            }
        }
    }

    _logScheduleError(entry, err) {
        this.logger.warn(`[Scheduler] Failed to apply schedule for ${entry.botId}:`, err.message);
        if (this.logBotEvent) {
            try {
                this.logBotEvent(entry.botId, 'error', err.message);
            } catch (logErr) {
                this.logger.warn('[Scheduler] Failed to log schedule error:', logErr.message);
            }
        }
    }

    _scheduleLabel(entry) {
        if (!entry.schedule) return '';
        if (entry.schedule.type === 'cron') return ' (cron)';
        if (entry.schedule.type === 'daily') return ` (${entry.schedule.startTime}-${entry.schedule.stopTime} UTC)`;
        if (entry.schedule.type === 'weekly') {
            const days = Array.from(entry.days || [])
                .map((day) => DAYS[day] || String(day))
                .join(',');
            return ` (${entry.schedule.startTime}-${entry.schedule.stopTime} UTC ${days})`;
        }
        return '';
    }

    _buildEntry(schedule, botId) {
        if (!schedule || typeof schedule !== 'object' || !schedule.type) {
            this.logger.warn(`[Scheduler] Invalid schedule for ${botId}; skipping.`);
            return null;
        }
        const meta = this.botMeta.get(botId) || {};
        const entry = {
            botId,
            schedule,
            userId: meta.userId,
            name: meta.name
        };

        if (schedule.type === 'cron') {
            try {
                entry.cronJob = buildCronJob(schedule.cron);
            } catch (err) {
                this.logger.warn(`[Scheduler] Invalid cron schedule for ${botId}:`, err.message);
                return null;
            }
            return entry;
        }

        const start = normalizeTime(schedule.startTime);
        const stop = normalizeTime(schedule.stopTime);
        if (!start || !stop) {
            this.logger.warn(`[Scheduler] Invalid time window for ${botId}; skipping.`);
            return null;
        }
        entry.startMinutes = start ? start.minutes : 0;
        entry.stopMinutes = stop ? stop.minutes : 0;

        if (schedule.type === 'weekly') {
            const days = normalizeDays(schedule.days);
            if (!days || !days.length) {
                this.logger.warn(`[Scheduler] Invalid weekly days for ${botId}; skipping.`);
                return null;
            }
            entry.days = new Set(days || []);
        }

        return entry;
    }
}

module.exports = {
    Scheduler,
    normalizeSchedule,
    validateCronExpression
};
