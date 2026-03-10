jest.mock('discord.js', () => {
    const EventEmitter = require('events');
    class MockClient extends EventEmitter {
        constructor() {
            super();
            this.guilds = { cache: [] };
            this.user = { id: 'mock-bot' };
        }
        login() {
            return Promise.resolve('mock-token');
        }
        destroy() {
            return Promise.resolve();
        }
    }
    return {
        Client: MockClient,
        GatewayIntentBits: {
            Guilds: 1,
            GuildMessages: 2,
            MessageContent: 4,
            GuildMembers: 8
        },
        Events: {
            ClientReady: 'ready',
            MessageCreate: 'messageCreate',
            Error: 'error'
        }
    };
});

jest.mock('uuid', () => {
    let counter = 1;
    return {
        v4: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`
    };
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createTestApp } = require('./helpers');

const VALID_DISCORD_TOKEN = `${'a'.repeat(24)}.${'b'.repeat(7)}.${'c'.repeat(12)}`;

async function registerAndGetToken(app, overrides = {}) {
    const res = await request(app)
        .post('/api/auth/register')
        .send({
            email: 'botuser@example.com',
            password: 'Password123',
            name: 'Bot User',
            ...overrides
        });
    return res.body.token;
}

function buildBotPayload(overrides = {}) {
    return {
        name: 'Alpha Bot',
        runtime: 'openclaw',
        discordToken: VALID_DISCORD_TOKEN,
        aiProvider: 'openai',
        aiApiKey: 'test-api-key',
        model: 'gpt-4o-mini',
        personality: 'Helpful assistant',
        triggerMode: 'mention',
        prefix: '!',
        channels: ['123'],
        tools: ['calculator'],
        ...overrides
    };
}

function buildLegacyBotPayload(overrides = {}) {
    return buildBotPayload({
        runtime: 'legacy',
        ...overrides
    });
}

describe('Bot management API', () => {
    let app;
    let db;
    let cleanup;

    beforeEach(() => {
        ({ app, db, cleanup } = createTestApp());
    });

    afterEach(() => {
        cleanup();
    });

    test('CRUD operations (create, list, get, update, delete)', async () => {
        const token = await registerAndGetToken(app);

        const createRes = await request(app)
            .post('/api/bots')
            .set('Authorization', `Bearer ${token}`)
            .send(buildBotPayload());

        expect(createRes.status).toBe(200);
        const botId = createRes.body.bot.id;
        expect(createRes.body.bot.discordToken).toBe('***');
        expect(createRes.body.bot.runtime).toBe('openclaw');

        const listRes = await request(app)
            .get('/api/bots')
            .set('Authorization', `Bearer ${token}`);

        expect(listRes.status).toBe(200);
        expect(listRes.body.bots).toHaveLength(1);
        expect(listRes.body.bots[0].runtime).toBe('openclaw');
        expect(listRes.body.bots[0].status).toBe('external');

        const getRes = await request(app)
            .get(`/api/bots/${botId}/status`)
            .set('Authorization', `Bearer ${token}`);

        expect(getRes.status).toBe(200);
        expect(getRes.body.status).toBeDefined();
        expect(getRes.body.status.runtime).toBe('openclaw');

        const updateRes = await request(app)
            .put(`/api/bots/${botId}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'Updated Bot' });

        expect(updateRes.status).toBe(200);

        const listAfterUpdate = await request(app)
            .get('/api/bots')
            .set('Authorization', `Bearer ${token}`);
        expect(listAfterUpdate.body.bots[0].name).toBe('Updated Bot');

        const deleteRes = await request(app)
            .delete(`/api/bots/${botId}`)
            .set('Authorization', `Bearer ${token}`);

        expect(deleteRes.status).toBe(200);

        const listAfterDelete = await request(app)
            .get('/api/bots')
            .set('Authorization', `Bearer ${token}`);
        expect(listAfterDelete.body.bots).toHaveLength(0);
    });

    test('bot config PATCH (live editing)', async () => {
        const token = await registerAndGetToken(app);
        const createRes = await request(app)
            .post('/api/bots')
            .set('Authorization', `Bearer ${token}`)
            .send(buildBotPayload());

        const botId = createRes.body.bot.id;
        const patchRes = await request(app)
            .patch(`/api/bots/${botId}/config`)
            .set('Authorization', `Bearer ${token}`)
            .send({ personality: 'Updated personality' });

        expect(patchRes.status).toBe(200);
        expect(patchRes.body.bot.personality).toBe('Updated personality');
    });

    test('conversation endpoints (list, search, export)', async () => {
        const token = await registerAndGetToken(app);
        const createRes = await request(app)
            .post('/api/bots')
            .set('Authorization', `Bearer ${token}`)
            .send(buildBotPayload());

        const botId = createRes.body.bot.id;

        db.logConversation({
            botId,
            userId: 'user-1',
            username: 'User1',
            channelId: 'chan-1',
            channelName: 'general',
            messageContent: 'hello world',
            botResponse: 'hi there',
            timestamp: '2025-01-01T10:00:00Z'
        });

        const listRes = await request(app)
            .get(`/api/bots/${botId}/conversations?limit=10`)
            .set('Authorization', `Bearer ${token}`);
        expect(listRes.status).toBe(200);
        expect(listRes.body.conversations).toHaveLength(1);

        const searchRes = await request(app)
            .get(`/api/bots/${botId}/conversations/search?q=hello`)
            .set('Authorization', `Bearer ${token}`);
        expect(searchRes.status).toBe(200);
        expect(searchRes.body.conversations).toHaveLength(1);

        const exportRes = await request(app)
            .get(`/api/bots/${botId}/conversations/export?format=json`)
            .set('Authorization', `Bearer ${token}`);
        expect(exportRes.status).toBe(200);
        expect(exportRes.body.conversations).toHaveLength(1);
    });

    test('analytics endpoint', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2025-01-01T12:00:00Z'));

        const token = await registerAndGetToken(app);
        const createRes = await request(app)
            .post('/api/bots')
            .set('Authorization', `Bearer ${token}`)
            .send(buildLegacyBotPayload());

        const botId = createRes.body.bot.id;

        db.recordBotMessageReceived(botId, 'help', '2025-01-01T10:00:00Z');
        db.recordBotMessageSent(botId, 1, '2025-01-01T10:05:00Z');
        db.recordBotError(botId, '2025-01-01T10:06:00Z');
        db.recordBotUptime(botId, '2025-01-01T09:00:00Z', '2025-01-01T10:00:00Z');

        const res = await request(app)
            .get(`/api/bots/${botId}/analytics?range=24h`)
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.analytics.totals.messagesReceived).toBe(1);
        expect(res.body.analytics.totals.messagesSent).toBe(1);

        jest.useRealTimers();
    });

    test('OpenClaw lifecycle is external and legacy-only endpoints are explicit', async () => {
        const token = await registerAndGetToken(app, { email: 'openclaw@example.com' });
        const createRes = await request(app)
            .post('/api/bots')
            .set('Authorization', `Bearer ${token}`)
            .send(buildBotPayload());

        const botId = createRes.body.bot.id;

        const startRes = await request(app)
            .post(`/api/bots/${botId}/start`)
            .set('Authorization', `Bearer ${token}`);

        expect(startRes.status).toBe(202);
        expect(startRes.body.executed).toBe(false);
        expect(startRes.body.status.runtime).toBe('openclaw');
        expect(startRes.body.status.desiredStatus).toBe('running');

        const logsRes = await request(app)
            .get(`/api/bots/${botId}/logs`)
            .set('Authorization', `Bearer ${token}`);
        expect(logsRes.status).toBe(501);
        expect(logsRes.body.code).toBe('OPENCLAW_UNSUPPORTED');

        const healthRes = await request(app)
            .get(`/api/bots/${botId}/health`)
            .set('Authorization', `Bearer ${token}`);
        expect(healthRes.status).toBe(501);

        const analyticsRes = await request(app)
            .get(`/api/bots/${botId}/analytics`)
            .set('Authorization', `Bearer ${token}`);
        expect(analyticsRes.status).toBe(501);

        const syncRes = await request(app)
            .post(`/api/bots/${botId}/commands/sync`)
            .set('Authorization', `Bearer ${token}`);
        expect(syncRes.status).toBe(501);
    });

    test('auth middleware (missing, invalid, expired token)', async () => {
        const token = await registerAndGetToken(app, { email: 'authcheck@example.com' });
        const createRes = await request(app)
            .post('/api/bots')
            .set('Authorization', `Bearer ${token}`)
            .send(buildBotPayload());
        const botId = createRes.body.bot.id;

        const missing = await request(app)
            .get('/api/bots');
        expect(missing.status).toBe(401);

        const invalid = await request(app)
            .get('/api/bots')
            .set('Authorization', 'Bearer not-a-token');
        expect(invalid.status).toBe(401);

        const expiredToken = jwt.sign({ userId: 'x', email: 'x' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
        const expired = await request(app)
            .get(`/api/bots/${botId}/status`)
            .set('Authorization', `Bearer ${expiredToken}`);
        expect(expired.status).toBe(401);
    });
});
