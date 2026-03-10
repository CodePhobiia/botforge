const RUNTIMES = Object.freeze({
    OPENCLAW: 'openclaw',
    LEGACY: 'legacy'
});

const DEFAULT_BOT_RUNTIME = RUNTIMES.OPENCLAW;

const RUNTIME_ALIASES = new Map([
    [RUNTIMES.OPENCLAW, RUNTIMES.OPENCLAW],
    ['ocl', RUNTIMES.OPENCLAW],
    ['open-claw', RUNTIMES.OPENCLAW],
    [RUNTIMES.LEGACY, RUNTIMES.LEGACY],
    ['discord.js', RUNTIMES.LEGACY],
    ['discordjs', RUNTIMES.LEGACY],
    ['botmanager', RUNTIMES.LEGACY]
]);

function normalizeBotRuntime(value) {
    if (typeof value !== 'string') return DEFAULT_BOT_RUNTIME;
    const normalized = String(value).trim().toLowerCase();
    return RUNTIME_ALIASES.get(normalized) || DEFAULT_BOT_RUNTIME;
}

function isKnownBotRuntimeValue(value) {
    if (typeof value !== 'string') return false;
    return RUNTIME_ALIASES.has(String(value).trim().toLowerCase());
}

function resolveBotRuntime(config) {
    return normalizeBotRuntime(
        config?.runtime
        ?? config?.runtimeType
        ?? config?.engine
    );
}

function isOpenClawRuntime(config) {
    return resolveBotRuntime(config) === RUNTIMES.OPENCLAW;
}

function isLegacyRuntime(config) {
    return resolveBotRuntime(config) === RUNTIMES.LEGACY;
}

module.exports = {
    DEFAULT_BOT_RUNTIME,
    RUNTIMES,
    normalizeBotRuntime,
    isKnownBotRuntimeValue,
    resolveBotRuntime,
    isOpenClawRuntime,
    isLegacyRuntime
};
