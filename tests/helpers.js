const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function createTempDbPath() {
    const name = `botforge-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`;
    return path.join(os.tmpdir(), name);
}

function cleanupDatabaseFiles(dbPath) {
    if (!dbPath) return;
    const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    for (const filePath of paths) {
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch {
                // Best-effort cleanup.
            }
        }
    }
}

function closeDatabase(dbModule) {
    if (!dbModule || typeof dbModule.initDatabase !== 'function') return;
    try {
        const db = dbModule.initDatabase();
        if (db && typeof db.close === 'function') {
            db.close();
        }
    } catch {
        // Ignore cleanup errors.
    }
}

function createTestDatabase() {
    const dbPath = createTempDbPath();
    process.env.NODE_ENV = 'test';
    process.env.BOTFORGE_DB_PATH = dbPath;
    process.env.BOTFORGE_ENCRYPTION_KEY = 'test-encryption-key';

    if (typeof jest !== 'undefined' && jest.resetModules) {
        jest.resetModules();
    }

    const db = require('../src/db/database');

    const cleanup = () => {
        closeDatabase(db);
        cleanupDatabaseFiles(dbPath);
    };

    return { db, dbPath, cleanup };
}

function createTestApp() {
    const dbPath = createTempDbPath();
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.BOTFORGE_DB_PATH = dbPath;
    process.env.BOTFORGE_ENCRYPTION_KEY = 'test-encryption-key';

    if (typeof jest !== 'undefined' && jest.resetModules) {
        jest.resetModules();
    }

    const app = require('../src/api/server');
    const db = require('../src/db/database');

    const cleanup = () => {
        closeDatabase(db);
        cleanupDatabaseFiles(dbPath);
    };

    return { app, db, dbPath, cleanup };
}

function generateAuthToken(payload = {}, options = {}) {
    const secret = process.env.JWT_SECRET || 'test-jwt-secret';
    return jwt.sign(payload, secret, { expiresIn: '30d', ...options });
}

module.exports = {
    createTestDatabase,
    createTestApp,
    generateAuthToken
};
