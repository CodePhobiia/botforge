/**
 * BotForge API Server
 * REST API for managing bots + serves the dashboard
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { BotManager } = require('../engine/BotManager');
const {
    createUser,
    getUserByEmail,
    createBot: createBotRecord,
    listBotsByUser,
    listAllBots,
    getBotById,
    updateBot: updateBotRecord,
    deleteBot: deleteBotRecord,
    logBotEvent,
    getLatestBotStatusEvent
} = require('../db/database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'botforge-secret-change-me-' + uuidv4();

const botManager = new BotManager();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../public'), { index: false }));

function maskBotForResponse(config, status = null) {
    const { discordToken, aiApiKey, updatedAt, ...rest } = config;
    const payload = status ? { ...rest, ...status } : rest;
    return { ...payload, discordToken: '***', aiApiKey: '***' };
}

// ============ AUTH ============

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        
        if (getUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = createUser({
            id: uuidv4(),
            email,
            name: name || email.split('@')[0],
            passwordHash: hashedPassword
        });
        
        const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = getUserByEmail(email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        
        const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Auth middleware
function auth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ============ BOTS ============

// List user's bots
app.get('/api/bots', auth, (req, res) => {
    const configs = listBotsByUser(req.userId);
    const bots = configs.map(config => {
        try {
            const status = botManager.getBotStatus(config.id);
            return maskBotForResponse(config, status);
        } catch {
            return maskBotForResponse(config, { status: 'stopped' });
        }
    });
    res.json({ bots });
});

// Create a new bot
app.post('/api/bots', auth, (req, res) => {
    try {
        const { name, discordToken, aiProvider, aiApiKey, model, personality, triggerMode, prefix, channels, collaborationMode, tools } = req.body;
        
        if (!name || !discordToken || !aiApiKey) {
            return res.status(400).json({ error: 'Name, Discord token, and AI API key are required' });
        }

        const config = {
            id: uuidv4(),
            userId: req.userId,
            name,
            discordToken,
            aiProvider: aiProvider || 'openai',
            aiApiKey,
            model: model || (aiProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini'),
            personality: personality || 'You are a helpful, friendly AI assistant.',
            triggerMode: triggerMode || 'mention',
            prefix: prefix || '!',
            channels: channels || [],
            tools: Array.isArray(tools) ? tools : [],
            maxTokens: 1024,
            historyLimit: 20,
            collaborationMode: collaborationMode || 'off',
            createdAt: new Date()
        };

        const storedConfig = createBotRecord(config);
        logBotEvent(config.id, 'created', 'Bot created');

        botManager.createBot(storedConfig);

        res.json({ bot: maskBotForResponse(storedConfig) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start a bot
app.post('/api/bots/:id/start', auth, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        const status = await botManager.startBot(config.id);
        logBotEvent(config.id, 'started', 'Bot started');
        res.json({ status });
    } catch (err) {
        logBotEvent(req.params.id, 'error', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Stop a bot
app.post('/api/bots/:id/stop', auth, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        const status = await botManager.stopBot(config.id);
        logBotEvent(config.id, 'stopped', 'Bot stopped');
        res.json({ status });
    } catch (err) {
        logBotEvent(req.params.id, 'error', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Update a bot
app.put('/api/bots/:id', auth, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        // Update stored config
        const updates = req.body || {};
        updateBotRecord(req.userId, req.params.id, updates);
        logBotEvent(req.params.id, 'updated', 'Bot updated');
        
        // Update running bot
        const status = await botManager.updateBot(config.id, updates);
        res.json({ status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a bot
app.delete('/api/bots/:id', auth, async (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        await botManager.removeBot(req.params.id);
        deleteBotRecord(req.userId, req.params.id);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot status
app.get('/api/bots/:id/status', auth, (req, res) => {
    try {
        const config = getBotById(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const status = botManager.getBotStatus(config.id);
        res.json({ status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot message logs
app.get('/api/bots/:id/logs', auth, (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const logs = botManager.getBotLogs(config.id);
        res.json({ logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot health metrics
app.get('/api/bots/:id/health', auth, (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const health = botManager.getBotHealth(config.id);
        res.json({ health });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Configure bot tools
app.post('/api/bots/:id/tools', auth, async (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const { tools } = req.body;
        if (!Array.isArray(tools)) {
            return res.status(400).json({ error: 'Tools must be an array of tool names' });
        }

        config.tools = tools;
        const status = await botManager.updateBot(config.id, { tools });
        res.json({ status, tools });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get conversation history by channel
app.get('/api/bots/:id/conversations', auth, (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });

        const conversations = botManager.getBotConversations(config.id);
        res.json({ conversations });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Platform stats
app.get('/api/stats', (req, res) => {
    res.json({ stats: botManager.getStats() });
});

async function bootstrapBots() {
    const configs = listAllBots();
    for (const config of configs) {
        try {
            await botManager.createBot(config);
        } catch (err) {
            console.error(`[BotForge] Failed to load bot ${config.id}:`, err.message);
        }
    }

    for (const config of configs) {
        const lastStatus = getLatestBotStatusEvent(config.id);
        if (lastStatus?.eventType === 'started') {
            try {
                await botManager.startBot(config.id);
                logBotEvent(config.id, 'started', 'Auto-started on boot');
            } catch (err) {
                logBotEvent(config.id, 'error', err.message);
                console.error(`[BotForge] Auto-start failed for ${config.id}:`, err.message);
            }
        }
    }
}

// Landing + dashboard routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/landing.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

app.get('/dashboard/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🔥 BotForge server running on http://localhost:${PORT}\n`);
    bootstrapBots().catch((err) => {
        console.error('[BotForge] Failed to bootstrap bots:', err.message);
    });
});

module.exports = app;
