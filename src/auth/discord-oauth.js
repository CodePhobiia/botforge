const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const {
    findByDiscordId,
    getUserByEmail,
    createFromDiscord,
    updateDiscordProfile
} = require('../db/database');

const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';
const DISCORD_SCOPES = ['identify', 'email', 'guilds'];

function getDiscordRedirectUri() {
    return process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/api/auth/discord/callback';
}

function buildDiscordAuthUrl({ clientId, redirectUri = getDiscordRedirectUri() }) {
    if (!clientId) throw new Error('Missing Discord client id');
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: DISCORD_SCOPES.join(' ')
    });
    return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
}

async function readJson(res) {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        scope: DISCORD_SCOPES.join(' ')
    });

    const res = await fetch(DISCORD_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });

    const data = await readJson(res);
    if (!res.ok) {
        throw new Error(data.error_description || data.error || 'Discord token exchange failed');
    }

    if (!data.access_token) {
        throw new Error('Discord token response missing access token');
    }

    return data.access_token;
}

async function fetchDiscordProfile(accessToken) {
    const res = await fetch(DISCORD_USER_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    const data = await readJson(res);
    if (!res.ok) {
        throw new Error(data.message || 'Failed to fetch Discord profile');
    }

    return data;
}

function buildAvatarUrl(profile) {
    if (!profile?.id || !profile?.avatar) return null;
    return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128`;
}

async function findOrCreateUserFromDiscord(profile) {
    const discordId = profile.id;
    const discordUsername = profile.username;
    const email = profile.email || null;
    const avatarUrl = buildAvatarUrl(profile);

    if (!discordId || !discordUsername) {
        throw new Error('Discord profile missing required fields');
    }

    let user = findByDiscordId(discordId);
    if (user) {
        return updateDiscordProfile(user.id, {
            discordId,
            discordUsername,
            avatarUrl,
            email
        });
    }

    if (!email) {
        throw new Error('Discord did not provide an email for this account');
    }

    const existingByEmail = getUserByEmail(email);
    if (existingByEmail) {
        return updateDiscordProfile(existingByEmail.id, {
            discordId,
            discordUsername,
            avatarUrl,
            email
        });
    }

    const passwordHash = await bcrypt.hash(uuidv4(), 10);
    return createFromDiscord({
        id: uuidv4(),
        email,
        passwordHash,
        name: discordUsername,
        discordId,
        discordUsername,
        avatarUrl
    });
}

async function handleDiscordCallback({ code, clientId, clientSecret, redirectUri, jwtSecret }) {
    if (!code) throw new Error('Missing OAuth code');
    if (!clientId || !clientSecret) throw new Error('Discord OAuth not configured');

    const accessToken = await exchangeCodeForToken({
        code,
        clientId,
        clientSecret,
        redirectUri
    });

    const profile = await fetchDiscordProfile(accessToken);
    const user = await findOrCreateUserFromDiscord(profile);
    const token = jwt.sign({ userId: user.id, email: user.email }, jwtSecret, { expiresIn: '30d' });

    return { token, user };
}

module.exports = {
    buildDiscordAuthUrl,
    getDiscordRedirectUri,
    handleDiscordCallback
};
