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
const { createTestApp } = require('./helpers');

function buildRegisterPayload(overrides = {}) {
    return {
        email: 'user@example.com',
        password: 'Password123',
        name: 'Test User',
        ...overrides
    };
}

describe('Auth API', () => {
    let app;
    let cleanup;

    beforeEach(() => {
        ({ app, cleanup } = createTestApp());
    });

    afterEach(() => {
        cleanup();
    });

    test('register success', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send(buildRegisterPayload());

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.user.email).toBe('user@example.com');
    });

    test('register duplicate email', async () => {
        await request(app)
            .post('/api/auth/register')
            .send(buildRegisterPayload());

        const res = await request(app)
            .post('/api/auth/register')
            .send(buildRegisterPayload());

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/email already/i);
    });

    test('register missing fields', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({});

        expect(res.status).toBe(400);
    });

    test('login success', async () => {
        await request(app)
            .post('/api/auth/register')
            .send(buildRegisterPayload());

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'user@example.com', password: 'Password123' });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
    });

    test('login wrong password', async () => {
        await request(app)
            .post('/api/auth/register')
            .send(buildRegisterPayload());

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'user@example.com', password: 'WrongPass123' });

        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid credentials/i);
    });

    test('login non-existent user', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'missing@example.com', password: 'Password123' });

        expect(res.status).toBe(401);
    });

    test('JWT token validation', async () => {
        const register = await request(app)
            .post('/api/auth/register')
            .send(buildRegisterPayload());

        const token = register.body.token;
        const res = await request(app)
            .get('/api/bots')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.bots).toEqual([]);
    });

    test('rate limiting on auth endpoints', async () => {
        const payload = { email: 'rate@example.com', password: 'Password123' };
        let lastStatus = null;

        for (let i = 0; i < 6; i += 1) {
            const res = await request(app)
                .post('/api/auth/login')
                .set('x-forwarded-for', '1.2.3.4')
                .send(payload);
            lastStatus = res.status;
        }

        expect(lastStatus).toBe(429);
    });
});
