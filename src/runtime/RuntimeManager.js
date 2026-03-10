const {
    RUNTIMES,
    resolveBotRuntime,
    isLegacyRuntime,
    isOpenClawRuntime
} = require('./runtime-utils');

const OPENCLAW_STATUS = 'external';
const OPENCLAW_MESSAGE = 'Managed by OpenClaw outside the legacy discord.js runtime.';

function buildLifecycleMessage(action) {
    return `${action === 'start' ? 'Start' : 'Stop'} request recorded; OpenClaw lifecycle is managed externally.`;
}

class RuntimeFeatureUnavailableError extends Error {
    constructor(feature, runtime = RUNTIMES.OPENCLAW) {
        super(`${feature} is unavailable for ${runtime} bots`);
        this.name = 'RuntimeFeatureUnavailableError';
        this.code = 'RUNTIME_FEATURE_UNAVAILABLE';
        this.feature = feature;
        this.runtime = runtime;
        this.statusCode = 501;
    }
}

class RuntimeManager {
    constructor({ legacyManager, openclawManager, getLatestBotStatusEvent, listBotsByUser, listAllBots, logger } = {}) {
        this.legacyManager = legacyManager;
        this.openclawManager = openclawManager;
        this.getLatestBotStatusEvent = getLatestBotStatusEvent;
        this.listBotsByUser = listBotsByUser;
        this.listAllBots = listAllBots;
        this.logger = logger || console;
        this.configs = new Map();
    }

    resolveRuntime(config) {
        return resolveBotRuntime(config);
    }

    isLegacy(config) {
        return isLegacyRuntime(config);
    }

    isOpenClaw(config) {
        return isOpenClawRuntime(config);
    }

    registerBot(config) {
        if (!config?.id) return;
        this.configs.set(config.id, {
            ...config,
            runtime: this.resolveRuntime(config)
        });
    }

    unregisterBot(botId) {
        if (!botId) return;
        this.configs.delete(botId);
    }

    getConfig(botId, config = null) {
        if (config?.id) {
            this.registerBot(config);
            return this.configs.get(config.id);
        }
        return this.configs.get(botId) || null;
    }

    _getLifecycleEvent(botId) {
        if (!this.getLatestBotStatusEvent || !botId) return null;
        try {
            return this.getLatestBotStatusEvent(botId);
        } catch (err) {
            this.logger.warn(`[RuntimeManager] Failed to read lifecycle event for ${botId}:`, err.message);
            return null;
        }
    }

    _deriveDesiredStatus(eventType) {
        if (eventType === 'started' || eventType === 'start_requested') return 'running';
        if (eventType === 'stopped' || eventType === 'stop_requested') return 'stopped';
        return 'stopped';
    }

    _buildOpenClawStatus(config, { event = null } = {}) {
        const lifecycleEvent = event || this._getLifecycleEvent(config.id);
        return {
            id: config.id,
            userId: config.userId,
            name: config.name,
            runtime: RUNTIMES.OPENCLAW,
            status: OPENCLAW_STATUS,
            desiredStatus: this._deriveDesiredStatus(lifecycleEvent?.eventType),
            lifecycleManagedBy: RUNTIMES.OPENCLAW,
            observed: false,
            messageCount: 0,
            guilds: [],
            error: null,
            startedAt: null,
            lastEventType: lifecycleEvent?.eventType || null,
            lastEventAt: lifecycleEvent?.createdAt || null,
            message: lifecycleEvent?.message || OPENCLAW_MESSAGE
        };
    }

    async _ensureLegacyBot(config) {
        if (!config?.id || !this.legacyManager) return;
        if (this.legacyManager.bots?.has(config.id)) return;
        await this.legacyManager.createBot(config);
    }

    async createBot(config) {
        this.registerBot(config);
        if (this.isOpenClaw(config)) {
            if (this.openclawManager) {
                return this.openclawManager.getBotStatus(config.id);
            }
            return this._buildOpenClawStatus(config);
        }
        await this._ensureLegacyBot(config);
        return this.legacyManager.getBotStatus(config.id);
    }

    async startBot(botId, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved)) {
            const status = await this.openclawManager.startBot(botId);
            return {
                executed: true,
                eventType: 'started',
                message: 'OpenClaw bot started',
                status
            };
        }

        if (resolved) {
            await this._ensureLegacyBot(resolved);
        }

        const status = await this.legacyManager.startBot(botId);
        return {
            executed: true,
            eventType: 'started',
            message: 'Bot started',
            status
        };
    }

    async stopBot(botId, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved)) {
            const status = await this.openclawManager.stopBot(botId);
            return {
                executed: true,
                eventType: 'stopped',
                message: 'OpenClaw bot stopped',
                status
            };
        }

        if (resolved) {
            await this._ensureLegacyBot(resolved);
        }

        const status = await this.legacyManager.stopBot(botId);
        return {
            executed: true,
            eventType: 'stopped',
            message: 'Bot stopped',
            status
        };
    }

    async stopAllBots() {
        if (!this.legacyManager) return;
        await this.legacyManager.stopAllBots();
    }

    async removeBot(botId, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved) && this.openclawManager) {
            await this.openclawManager.deleteBot(botId);
        } else if (resolved && this.isLegacy(resolved) && this.legacyManager?.bots?.has(botId)) {
            await this.legacyManager.removeBot(botId);
        }
        this.unregisterBot(botId);
    }

    async updateBot(botId, nextConfig, { previousConfig = null } = {}) {
        const previous = this.getConfig(botId, previousConfig) || previousConfig;
        const next = {
            ...(previous || {}),
            ...(nextConfig || {}),
            id: botId,
            runtime: this.resolveRuntime(nextConfig || previous || {})
        };

        this.registerBot(next);

        const previousRuntime = this.resolveRuntime(previous || next);
        const nextRuntime = this.resolveRuntime(next);

        if (previousRuntime === RUNTIMES.LEGACY && nextRuntime === RUNTIMES.OPENCLAW) {
            if (this.legacyManager?.bots?.has(botId)) {
                await this.legacyManager.removeBot(botId);
            }
            const status = this.openclawManager
                ? await this.openclawManager.updateBot(botId, next)
                : this._buildOpenClawStatus(next);
            return {
                runtimeChanged: true,
                status
            };
        }

        if (previousRuntime === RUNTIMES.OPENCLAW && nextRuntime === RUNTIMES.LEGACY) {
            await this._ensureLegacyBot(next);
            return {
                runtimeChanged: true,
                status: this.legacyManager.getBotStatus(botId)
            };
        }

        if (nextRuntime === RUNTIMES.OPENCLAW) {
            const status = this.openclawManager
                ? await this.openclawManager.updateBot(botId, next)
                : this._buildOpenClawStatus(next);
            return {
                runtimeChanged: false,
                status
            };
        }

        await this._ensureLegacyBot(next);
        return {
            runtimeChanged: false,
            status: await this.legacyManager.updateBot(botId, nextConfig)
        };
    }

    async updateBotConfig(botId, updates, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved)) {
            const next = { ...resolved, ...updates, runtime: this.resolveRuntime(resolved) };
            this.registerBot(next);
            if (this.openclawManager) {
                return this.openclawManager.updateBot(botId, next);
            }
            return this._buildOpenClawStatus(next);
        }

        return this.legacyManager.updateBotConfig(botId, updates);
    }

    updateBotAutomod(botId, automodConfig, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved)) {
            const next = { ...resolved, automodConfig, runtime: this.resolveRuntime(resolved) };
            this.registerBot(next);
            return this._buildOpenClawStatus(next);
        }

        return this.legacyManager.updateBotAutomod(botId, automodConfig);
    }

    getBotStatus(botId, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved)) {
            if (this.openclawManager) {
                return this.openclawManager.getBotStatus(botId);
            }
            return this._buildOpenClawStatus(resolved);
        }
        return this.legacyManager.getBotStatus(botId);
    }

    getBotLogs(botId, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved)) {
            throw new RuntimeFeatureUnavailableError('logs');
        }
        return this.legacyManager.getBotLogs(botId);
    }

    getBotHealth(botId, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved)) {
            throw new RuntimeFeatureUnavailableError('health');
        }
        return this.legacyManager.getBotHealth(botId);
    }

    async syncSlashCommands(botId, { config = null } = {}) {
        const resolved = this.getConfig(botId, config);
        if (resolved && this.isOpenClaw(resolved)) {
            throw new RuntimeFeatureUnavailableError('slash sync');
        }
        return this.legacyManager.syncSlashCommands(botId);
    }

    getAllBots(userId) {
        const configs = this.listBotsByUser ? this.listBotsByUser(userId) : [...this.configs.values()]
            .filter((config) => !userId || config.userId === userId);
        return configs.map((config) => this.getBotStatus(config.id, { config }));
    }

    getStats() {
        const stats = {
            total: 0,
            running: 0,
            stopped: 0,
            errors: 0,
            totalMessages: 0,
            external: 0,
            legacy: 0,
            openclaw: 0
        };

        const configs = this.listAllBots ? this.listAllBots() : [...this.configs.values()];
        for (const config of configs) {
            stats.total += 1;
            if (this.isOpenClaw(config)) {
                stats.openclaw += 1;
                stats.external += 1;
                continue;
            }

            stats.legacy += 1;

            let status;
            try {
                status = this.getBotStatus(config.id, { config });
            } catch {
                status = { status: 'stopped', messageCount: 0 };
            }

            if (status.status === 'running') stats.running += 1;
            else if (status.status === 'error') stats.errors += 1;
            else stats.stopped += 1;

            stats.totalMessages += status.messageCount || 0;
        }

        return stats;
    }
}

module.exports = {
    RuntimeManager,
    RuntimeFeatureUnavailableError,
    RUNTIMES,
    OPENCLAW_STATUS
};
