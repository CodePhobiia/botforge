# PM Notes — BotForge Feature Priority
*Updated: 2026-03-09 04:55 UTC — Cycle 3*

## What's Shipped (22 modules, ~5,800 lines)
- ✅ Core bot engine (multi-bot discord.js management)
- ✅ Auth (email/password + Discord OAuth2)
- ✅ SQLite database + AES-256 encryption for tokens
- ✅ OpenAI + Anthropic AI providers (with token tracking)
- ✅ Tool system (web search, calc, time, reminders)
- ✅ Rate limiter (per-user, per-bot, configurable overrides)
- ✅ 12+ personality presets + template gallery
- ✅ Bot collaboration mode
- ✅ Security middleware (validation, rate limiting, headers, error handler, request IDs)
- ✅ Landing page (dark theme, features, pricing, FAQ)
- ✅ Dashboard (bot cards, create/start/stop/delete)
- ✅ Onboarding wizard (5-step guide for first-time users)
- ✅ Dockerfile + docker-compose
- ✅ README + LICENSE + badges
- ✅ WebSocket real-time updates (socket.io, live status, toasts)
- ✅ Analytics dashboard (hourly tracking, Chart.js, uptime, error rate)
- ✅ Conversation logs (search, export JSON/CSV, pagination, chat UI)
- ✅ Live config editing (hot-reload personality/model/trigger/tools/rate limits)
- ✅ Railway deployment configs (Procfile, railway.toml, nixpacks.toml)
- ✅ Health check endpoint (/api/health)
- ✅ Graceful shutdown (SIGTERM/SIGINT)
- ✅ Production CORS hardening

## Updated Priority Queue

### 🔴 P0 — Wave 6 (NEXT)
1. **Auto-Moderation Module** — Word filter, spam detection, link blocking, raid protection. Every competitor has this. Big differentiator.
2. **Email Notifications (Resend)** — Bot went down, usage alerts, daily digest. Free tier = 3k/month.
3. **Unit Tests** — Critical path coverage for auth, bot CRUD, analytics, conversations.

### 🟡 P1 — Wave 7
4. **LemonSqueezy Payments** — Easier than Stripe. Free: 1 bot. Pro $9/mo: 5 bots + analytics. Team $19/mo: unlimited.
5. **Bot Scheduling** — Auto start/stop at certain times (save API costs).
6. **Slash Command Builder** — Visual builder for custom slash commands.

### 🟢 P2 — Wave 8+
7. **Webhook Integrations** — External notifications on bot events
8. **Admin Panel** — Platform management
9. **White-label** — Remove branding for enterprise
10. **Multi-channel** — Support Slack/Telegram in addition to Discord

## Build Log
| Wave | Features | Status |
|------|----------|--------|
| 1 | Database, Landing Page, Advanced Features | ✅ Merged |
| 2 | README, Docker, Security | ✅ Merged |
| 3 | Discord OAuth, Templates Gallery, Onboarding | ✅ Merged |
| 4+5 | WebSocket, Analytics, Conv Logs, Live Config, Railway, README v2 | ✅ Merged |
| 6 | Auto-Mod, Email Notifications, Unit Tests | ⏳ Next |
