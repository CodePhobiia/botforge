# **⚡ BotForge**

Deploy AI Discord bots in one click with a secure, multi-bot control plane for teams.

[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-22.x-43853d?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/docker-ready-0db7ed?logo=docker&logoColor=white)

## Features
- 🤖 Multi-bot management from a single dashboard
- 🧠 Any AI model/provider with flexible configuration
- 🔐 BYOK (bring your own keys) with encrypted secrets
- 📊 Real-time dashboard for status, logs, and health
- 🧰 Tools system for web search and utilities
- 🤝 Collaboration modes for team-built bots
- 🎛️ Personality presets and trigger modes

## Quick Start
1. Clone the repo
   ```bash
   git clone https://github.com/CodePhobiia/botforge.git
   cd botforge
   ```
2. Install dependencies
   ```bash
   npm install
   ```
3. Start the server
   ```bash
   npm start
   ```

## Installation
### Prerequisites
- Node.js 22+
- A Discord bot token
- An AI provider API key (OpenAI, Anthropic, or custom)

### Local Setup
1. Copy the environment file:
   ```bash
   cp .env.example .env
   ```
2. Set values in `.env`.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the API server:
   ```bash
   npm start
   ```
5. Open the dashboard at `http://localhost:3000/dashboard`.

### Docker
```bash
docker compose up --build
```

## Configuration Reference
| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | No | `3000` | API server port. |
| `JWT_SECRET` | Yes | - | Secret used to sign auth tokens. |
| `ENCRYPTION_KEY` | Recommended | - | Master key for encrypting stored secrets. If omitted, a `.botforge-key` file is created on first run and must be persisted. |

## API Docs
Base URL: `http://localhost:3000`

Authentication: send `Authorization: Bearer <token>` on all protected endpoints.

### Auth
- `POST /api/auth/register` - Create a new user account.
- `POST /api/auth/login` - Log in and receive a JWT.

### Bots
- `GET /api/bots` - List bots for the authenticated user.
- `POST /api/bots` - Create a new bot.
- `PUT /api/bots/:id` - Update a bot configuration.
- `DELETE /api/bots/:id` - Delete a bot.
- `POST /api/bots/:id/start` - Start a bot.
- `POST /api/bots/:id/stop` - Stop a bot.
- `GET /api/bots/:id/status` - Get live status.
- `GET /api/bots/:id/logs` - Get bot message logs.
- `GET /api/bots/:id/health` - Get health metrics.
- `POST /api/bots/:id/tools` - Update enabled tools.
- `GET /api/bots/:id/conversations` - Fetch conversation history by channel.

### Platform
- `GET /api/stats` - Aggregate platform stats.

## Architecture Overview
- `src/api/server.js` exposes the REST API and serves the dashboard.
- `src/engine/BotManager.js` orchestrates bot lifecycles and runtime status.
- `src/engine/AIProvider.js` and `ToolSystem.js` handle model calls and tool routing.
- `src/db/` manages a SQLite database in `data/` with encrypted tokens.
- `public/` contains the dashboard UI.

## Contributing
1. Fork the repo and create a feature branch.
2. Make your changes and add tests if needed.
3. Open a pull request with a clear summary.

## License
MIT © 2026 BotForge
