const fs = require('fs');
const path = require('path');
const { RateLimiter } = require('../src/engine/RateLimiter');
const { ToolSystem } = require('../src/engine/ToolSystem');
const { personalityPresets } = require('../src/engine/PersonalityPresets');

describe('Engine: RateLimiter', () => {
    test('allows within limit and blocks after limit', () => {
        jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00Z'));

        const limiter = new RateLimiter({
            userLimits: { perMinute: 2, perHour: 2, perDay: 2 },
            botLimits: { perMinute: 2, perHour: 2, perDay: 2 }
        });

        const first = limiter.checkAndRecord({ userId: 'u1', botId: 'b1' });
        const second = limiter.checkAndRecord({ userId: 'u1', botId: 'b1' });
        const third = limiter.checkAndRecord({ userId: 'u1', botId: 'b1' });

        expect(first.allowed).toBe(true);
        expect(second.allowed).toBe(true);
        expect(third.allowed).toBe(false);
        expect(third.retryAfterSeconds).toBeGreaterThan(0);

        jest.useRealTimers();
    });

    test('bucket cleanup after window', () => {
        jest.useFakeTimers().setSystemTime(new Date('2025-01-01T00:00:00Z'));

        const limiter = new RateLimiter({
            userLimits: { perMinute: 1, perHour: 1, perDay: 1 },
            botLimits: { perMinute: 1, perHour: 1, perDay: 1 }
        });

        limiter.checkAndRecord({ userId: 'u1', botId: 'b1' });
        const blocked = limiter.checkAndRecord({ userId: 'u1', botId: 'b1' });
        expect(blocked.allowed).toBe(false);

        jest.setSystemTime(new Date('2025-01-02T00:00:01Z'));
        const allowedAgain = limiter.checkAndRecord({ userId: 'u1', botId: 'b1' });
        expect(allowedAgain.allowed).toBe(true);

        jest.useRealTimers();
    });
});

describe('Engine: ToolSystem', () => {
    test('tool registration and execution', async () => {
        const toolSystem = new ToolSystem({
            tools: [
                {
                    name: 'echo',
                    description: 'Echo back args',
                    execute: async (args) => args
                }
            ]
        });

        const result = await toolSystem.executeToolCall({ name: 'echo', args: 'hello' });
        expect(result.result).toBe('hello');
    });

    test('built-in tools are listed', () => {
        const toolSystem = new ToolSystem();
        const names = toolSystem.listTools().map((tool) => tool.name);
        expect(names).toContain('calculator');
    });
});

describe('Engine: PersonalityPresets', () => {
    test('list and get by name', () => {
        expect(personalityPresets.length).toBeGreaterThan(0);
        const preset = personalityPresets.find((item) => item.name === 'Coding Assistant');
        expect(preset).toBeTruthy();
    });
});

describe('Engine: AutoMod', () => {
    const automodPath = path.join(__dirname, '../src/engine/AutoMod.js');

    if (!fs.existsSync(automodPath)) {
        test.skip('AutoMod module not present', () => {});
        return;
    }

    // If the module exists, basic smoke tests to cover word filter + spam detection.
    const automodModule = require(automodPath);
    const AutoMod = automodModule.AutoMod || automodModule.default || automodModule;

    test('word filter blocks banned content', () => {
        const automod = new AutoMod({ wordFilter: { enabled: true, bannedWords: ['banned'] } });
        const fakeMsg = { content: 'this is banned', author: { id: '1' }, member: null, guild: { id: 'g1' }, channel: { id: 'c1' } };
        const result = automod.checkMessage(fakeMsg);
        expect(result).not.toBeNull();
        expect(result.violationType).toBe('word_filter');
    });

    test('spam detection flags repeated content', () => {
        const automod = new AutoMod({ spam: { enabled: true, repeatWindowSeconds: 10 } });
        const fakeMsg = { content: 'spammy', author: { id: '1' }, member: null, guild: { id: 'g1' }, channel: { id: 'c1' } };
        automod.checkMessage(fakeMsg); // first - no violation
        const second = automod.checkMessage(fakeMsg); // repeat - should flag
        expect(second).not.toBeNull();
        expect(second.violationType).toBe('spam_repeat');
    });
});
