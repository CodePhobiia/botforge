const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const PRIMARY_KEY_ENV = 'ENCRYPTION_KEY';
const FALLBACK_KEY_ENV = 'BOTFORGE_ENCRYPTION_KEY';
const KEY_FILE = path.join(__dirname, '../../.botforge-key');

let cachedKey = null;

function deriveKeyFromString(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

function loadKeyFromFile() {
    if (!fs.existsSync(KEY_FILE)) return null;
    const contents = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (!contents) return null;
    try {
        const decoded = Buffer.from(contents, 'base64');
        if (decoded.length === 32) return decoded;
    } catch {
        // Fall through to hash-based derivation below.
    }
    return deriveKeyFromString(contents);
}

function ensureKey() {
    if (cachedKey) return cachedKey;

    const envKey = process.env[PRIMARY_KEY_ENV] || process.env[FALLBACK_KEY_ENV];
    if (envKey) {
        cachedKey = deriveKeyFromString(envKey);
        return cachedKey;
    }

    const fileKey = loadKeyFromFile();
    if (fileKey) {
        cachedKey = fileKey;
        return cachedKey;
    }

    const newKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, newKey.toString('base64'), { mode: 0o600 });
    cachedKey = newKey;
    return cachedKey;
}

function encrypt(value) {
    if (value === null || value === undefined) return null;
    const key = ensureKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(String(value), 'utf8'),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(payload) {
    if (payload === null || payload === undefined) return null;
    const key = ensureKey();
    const [ivB64, tagB64, dataB64] = String(payload).split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
        throw new Error('Invalid encrypted payload format');
    }
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
        decipher.update(data),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
}

module.exports = {
    encrypt,
    decrypt
};
