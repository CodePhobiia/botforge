<div align="center">
  <img src="https://placehold.co/140x140?text=BotForge" alt="BotForge logo" width="120" height="120" />
  <h1>BotForge</h1>
  <p><strong>Ship AI-powered Discord bots in minutes.</strong></p>
  <p>Secure multi-bot control plane with OAuth, encrypted secrets, and live ops visibility.</p>

  [![Node.js](https://img.shields.io/badge/node-18%2B-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
  [![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
  [![Docker](https://img.shields.io/badge/docker-ready-0db7ed?logo=docker&logoColor=white)](https://www.docker.com/)

  [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/...)
</div>

---

## Features
- 🤖 Multi-bot management from a single dashboard
- 🧠 Bring any AI provider (OpenAI, Anthropic, etc.)
- 🔐 Encrypted secrets stored in SQLite
- 📊 Live status, logs, and health metrics
- 🧰 Tool system for web + utility actions
- 🤝 Collaboration modes across bot fleets
- 🎛️ Presets for personalities and triggers

## Quick Start

### Local
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env template and fill values:
   ```bash
   cp .env.example .env
   ```
3. Start the server:
   ```bash
   npm start
   ```
4. Open the dashboard at `http://localhost:3000/dashboard`.

### Docker
```bash
docker compose up --build
```

### Railway (One-Click)
1. Click the deploy button above.
2. Add required environment variables in Railway.
3. Deploy and open the provided public URL.

## Architecture
```
┌───────────────────────────┐
│        Web Client         │
│  /public (dashboard UI)   │
└──────────────┬────────────┘
               │
               ▼
┌───────────────────────────┐
│        API Server         │
│  src/api/server.js        │
│  - auth, bots, templates  │
└──────────────┬────────────┘
               │
               ▼
┌───────────────────────────┐
│       Bot Manager         │
│  src/engine/BotManager.js │
│  - lifecycle, health      │
└──────────────┬────────────┘
               │
               ▼
┌───────────────────────────┐
│       SQLite Store        │
│  data/botforge.db         │
│  (encrypted secrets)      │
└───────────────────────────┘
```

## API Documentation
Base URL: `http://localhost:3000`

Authentication: send `Authorization: Bearer <token>` on protected endpoints.

### Health
- `GET /api/health` — Service status + uptime

### Auth
- `POST /api/auth/register` — Create a new user account
- `POST /api/auth/login` — Log in and receive a JWT
- `GET /api/auth/discord` — Start Discord OAuth
- `GET /api/auth/discord/callback` — OAuth redirect handler

### Templates
- `GET /api/templates` — List personality presets
- `GET /api/templates/:id` — Fetch a preset by id

### Bots (Protected)
- `GET /api/bots` — List bots for the authenticated user
- `POST /api/bots` — Create a new bot
- `PUT /api/bots/:id` — Update a bot configuration
- `DELETE /api/bots/:id` — Delete a bot
- `POST /api/bots/:id/start` — Start a bot
- `POST /api/bots/:id/stop` — Stop a bot
- `GET /api/bots/:id/status` — Get live status
- `GET /api/bots/:id/logs` — Get bot message logs
- `GET /api/bots/:id/health` — Get health metrics
- `POST /api/bots/:id/tools` — Update enabled tools
- `GET /api/bots/:id/conversations` — Fetch conversation history by channel

### Platform
- `GET /api/stats` — Aggregate platform stats

## Environment Variables
| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | No | `3000` | API server port. |
| `NODE_ENV` | No | `development` | Runtime environment. |
| `JWT_SECRET` | Yes (prod) | Ephemeral | Secret used to sign auth tokens. |
| `DISCORD_CLIENT_ID` | No | - | Discord OAuth client id. |
| `DISCORD_CLIENT_SECRET` | No | - | Discord OAuth client secret. |
| `DISCORD_REDIRECT_URI` | No | `http://localhost:3000/api/auth/discord/callback` | OAuth redirect URL. |
| `ENCRYPTION_KEY` | Recommended | Auto | Master key for encrypting stored secrets. |
| `CORS_ORIGINS` | Recommended (prod) | - | Comma-separated list of allowed origins. |

Notes:
- If `ENCRYPTION_KEY` is not set, a `.botforge-key` file is generated on first use and must be persisted.
- In production, set `JWT_SECRET` and `CORS_ORIGINS` explicitly.

## Contributing
1. Fork the repo and create a feature branch.
2. Make your changes and add tests if needed.
3. Open a pull request with a clear summary and screenshots (if UI changes).

## License
MIT © 2026 BotForge. See `LICENSE` for details.
