const crypto = require('crypto');
const { createTestDatabase } = require('./helpers');

function uuidv4() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
}

function buildUser(overrides = {}) {
    return {
        id: uuidv4(),
        email: `user-${Math.random().toString(36).slice(2, 8)}@example.com`,
        passwordHash: 'hashed-password',
        name: 'Test User',
        ...overrides
    };
}

function buildBot(userId, overrides = {}) {
    return {
        id: uuidv4(),
        userId,
        name: 'Test Bot',
        runtime: 'openclaw',
        discordToken: 'discord-token',
        aiProvider: 'openai',
        aiApiKey: 'test-api-key',
        model: 'gpt-4o-mini',
        personality: 'Friendly helper',
        triggerMode: 'mention',
        prefix: '!',
        channels: ['channel-1'],
        tools: ['calculator'],
        maxTokens: 512,
        historyLimit: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    };
}

describe('Database', () => {
    let db;
    let cleanup;

    beforeEach(() => {
        ({ db, cleanup } = createTestDatabase());
    });

    afterEach(() => {
        cleanup();
    });

    test('user CRUD: create and get by email/id', () => {
        const user = buildUser();
        db.createUser(user);

        const byEmail = db.getUserByEmail(user.email);
        expect(byEmail).not.toBeNull();
        expect(byEmail.email).toBe(user.email);

        const byId = db.getUserById(user.id);
        expect(byId).not.toBeNull();
        expect(byId.id).toBe(user.id);
    });

    test('user edge case: duplicate email throws', () => {
        const user = buildUser({ email: 'dup@example.com' });
        db.createUser(user);
        expect(() => db.createUser({ ...user, id: uuidv4() })).toThrow();
    });

    test('bot CRUD: create, list, get, update, delete', () => {
        const user = buildUser();
        db.createUser(user);

        const bot = buildBot(user.id, {
            engine: 'openclaw',
            openclawAgentId: 'bf-test-bot',
            openclawWorkspace: '/tmp/workspace-bf-test-bot',
            openclawAgentDir: '/tmp/agents/bf-test-bot/agent'
        });
        db.createBot(bot);

        const list = db.listBotsByUser(user.id);
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe(bot.id);
        expect(list[0].runtime).toBe('openclaw');
        expect(list[0].discordToken).toBe(bot.discordToken);
        expect(list[0].engine).toBe('openclaw');
        expect(list[0].openclawAgentId).toBe('bf-test-bot');

        const fetched = db.getBotById(user.id, bot.id);
        expect(fetched).not.toBeNull();
        expect(fetched.name).toBe(bot.name);
        expect(fetched.openclawWorkspace).toBe('/tmp/workspace-bf-test-bot');
        expect(fetched.openclawAgentDir).toBe('/tmp/agents/bf-test-bot/agent');

        const updated = db.updateBot(user.id, bot.id, {
            name: 'Updated Bot',
            maxTokens: 2048,
            openclawWorkspace: '/tmp/workspace-bf-renamed'
        });
        expect(updated).not.toBeNull();
        expect(updated.name).toBe('Updated Bot');
        expect(updated.maxTokens).toBe(2048);
        expect(updated.openclawWorkspace).toBe('/tmp/workspace-bf-renamed');

        const deleted = db.deleteBot(user.id, bot.id);
        expect(deleted).toBe(true);
        expect(db.getBotById(user.id, bot.id)).toBeNull();
    });

    test('bot edge case: non-existent bot returns null/false', () => {
        const user = buildUser();
        db.createUser(user);

        expect(db.getBotById(user.id, uuidv4())).toBeNull();
        expect(db.deleteBot(user.id, uuidv4())).toBe(false);
        expect(db.listBotsByUser(user.id)).toEqual([]);
    });

    test('conversation logging: log, search, export', () => {
        const user = buildUser();
        db.createUser(user);
        const bot = buildBot(user.id);
        db.createBot(bot);

        db.logConversation({
            botId: bot.id,
            userId: user.id,
            username: 'UserOne',
            channelId: 'chan-1',
            channelName: 'general',
            messageContent: 'Hello there',
            botResponse: 'Hi!',
            timestamp: '2025-01-01T10:00:00Z',
            modelUsed: 'gpt-4o-mini',
            tokensUsed: 10
        });

        db.logConversation({
            botId: bot.id,
            userId: user.id,
            username: 'UserTwo',
            channelId: 'chan-2',
            channelName: 'random',
            messageContent: 'Need help',
            botResponse: 'Sure',
            timestamp: '2025-01-01T11:00:00Z',
            modelUsed: 'gpt-4o-mini',
            tokensUsed: 8
        });

        const conversations = db.getConversationsByBot(bot.id, 10, 0);
        expect(conversations).toHaveLength(2);

        const search = db.searchConversations(bot.id, 'help');
        expect(search).toHaveLength(1);
        expect(search[0].messageContent).toMatch(/help/i);

        const exportAll = db.getAllConversationsByBot(bot.id);
        expect(exportAll).toHaveLength(2);
    });

    test('analytics recording and querying', () => {
        jest.useFakeTimers().setSystemTime(new Date('2025-01-01T12:00:00Z'));

        const user = buildUser();
        db.createUser(user);
        const bot = buildBot(user.id);
        db.createBot(bot);

        db.recordBotMessageReceived(bot.id, 'help', '2025-01-01T10:30:00Z');
        db.recordBotMessageSent(bot.id, 2, '2025-01-01T10:31:00Z');
        db.recordBotError(bot.id, '2025-01-01T10:32:00Z');
        db.recordBotUptime(bot.id, '2025-01-01T09:00:00Z', '2025-01-01T10:00:00Z');

        const analytics = db.getBotAnalytics(bot.id, 24);
        expect(analytics).toBeTruthy();
        expect(analytics.totals.messagesReceived).toBe(1);
        expect(analytics.totals.messagesSent).toBe(2);
        expect(analytics.totals.errors).toBe(1);
        expect(analytics.totals.uptimeMs).toBeGreaterThan(0);
        expect(analytics.topCommands[0].command).toBe('help');
        expect(analytics.series.labels.length).toBeGreaterThan(0);
        expect(analytics.series.messagesSent.length).toBe(analytics.series.labels.length);

        jest.useRealTimers();
    });

    test('automod log recording', () => {
        const user = buildUser();
        db.createUser(user);
        const bot = buildBot(user.id);
        db.createBot(bot);

        db.logModAction({
            botId: bot.id,
            userId: 'user-123',
            username: 'Spammer',
            violationType: 'spam_repeat',
            actionTaken: 'warn',
            messageContent: 'buy now'
        });

        const logs = db.getModLogs(bot.id, 10, 0);
        expect(logs).toHaveLength(1);
        expect(logs[0].actionTaken).toBe('warn');
    });

    test('encryption/decryption roundtrip', () => {
        const { encrypt, decrypt } = require('../src/db/encryption');
        const secret = 'super-secret-token';
        const encrypted = encrypt(secret);
        expect(encrypted).not.toBe(secret);
        const decrypted = decrypt(encrypted);
        expect(decrypted).toBe(secret);
    });

    test('edge case: empty conversation search results', () => {
        const user = buildUser();
        db.createUser(user);
        const bot = buildBot(user.id);
        db.createBot(bot);

        const results = db.searchConversations(bot.id, 'nothing');
        expect(results).toEqual([]);
    });
});
