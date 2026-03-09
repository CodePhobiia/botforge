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

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'botforge-secret-change-me-' + uuidv4();

// In-memory store for MVP (replace with Supabase later)
const users = new Map();
const userBots = new Map(); // userId -> [botConfigs]

const botManager = new BotManager();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../public')));

// ============ AUTH ============

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        
        if (users.has(email)) return res.status(400).json({ error: 'Email already registered' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = { id: uuidv4(), email, name: name || email.split('@')[0], password: hashedPassword, createdAt: new Date() };
        users.set(email, user);
        userBots.set(user.id, []);
        
        const token = jwt.sign({ userId: user.id, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = users.get(email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        
        const valid = await bcrypt.compare(password, user.password);
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
    const configs = userBots.get(req.userId) || [];
    const bots = configs.map(config => {
        try {
            const status = botManager.getBotStatus(config.id);
            return { ...config, ...status, discordToken: '***', aiApiKey: '***' };
        } catch {
            return { ...config, status: 'stopped', discordToken: '***', aiApiKey: '***' };
        }
    });
    res.json({ bots });
});

// Create a new bot
app.post('/api/bots', auth, (req, res) => {
    try {
        const { name, discordToken, aiProvider, aiApiKey, model, personality, triggerMode, prefix, channels } = req.body;
        
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
            tools: [],
            maxTokens: 1024,
            historyLimit: 20,
            createdAt: new Date()
        };

        const userBotList = userBots.get(req.userId) || [];
        userBotList.push(config);
        userBots.set(req.userId, userBotList);

        botManager.createBot(config);

        res.json({ bot: { ...config, discordToken: '***', aiApiKey: '***' } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start a bot
app.post('/api/bots/:id/start', auth, async (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        const status = await botManager.startBot(config.id);
        res.json({ status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stop a bot
app.post('/api/bots/:id/stop', auth, async (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        const status = await botManager.stopBot(config.id);
        res.json({ status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update a bot
app.put('/api/bots/:id', auth, async (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        // Update stored config
        const updates = req.body;
        Object.assign(config, updates);
        
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
        const userBotList = userBots.get(req.userId) || [];
        const idx = userBotList.findIndex(b => b.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Bot not found' });
        
        await botManager.removeBot(req.params.id);
        userBotList.splice(idx, 1);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get bot status
app.get('/api/bots/:id/status', auth, (req, res) => {
    try {
        const config = findUserBot(req.userId, req.params.id);
        if (!config) return res.status(404).json({ error: 'Bot not found' });
        
        const status = botManager.getBotStatus(config.id);
        res.json({ status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Platform stats
app.get('/api/stats', (req, res) => {
    res.json({ stats: botManager.getStats() });
});

// Helper
function findUserBot(userId, botId) {
    const userBotList = userBots.get(userId) || [];
    return userBotList.find(b => b.id === botId);
}

// SPA fallback
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🔥 BotForge server running on http://localhost:${PORT}\n`);
});

module.exports = app;
