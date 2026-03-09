# PM Notes — BotForge Feature Priority
*Updated: 2026-03-09 04:20 UTC — Cycle 2*

## What's Shipped (15 modules, 4,641 lines)
- ✅ Core bot engine (multi-bot discord.js management)
- ✅ Auth (email/password + Discord OAuth2)
- ✅ SQLite database + AES-256 encryption for tokens
- ✅ OpenAI + Anthropic AI providers
- ✅ Tool system (web search, calc, time, reminders)
- ✅ Rate limiter (per-user, per-bot)
- ✅ 12+ personality presets + template gallery
- ✅ Bot collaboration mode
- ✅ Security middleware (validation, rate limiting, headers, error handler)
- ✅ Landing page (dark theme, features, pricing, FAQ)
- ✅ Dashboard (bot cards, create/start/stop/delete)
- ✅ Onboarding wizard (5-step guide for first-time users)
- ✅ Dockerfile + docker-compose
- ✅ README + LICENSE

## Currently Building (Wave 4)
- 🔄 Analytics dashboard (usage tracking, charts, stats)
- 🔄 WebSocket real-time updates (live bot status, message counts)

## Competitor Research — Cycle 2 Findings
Source: Perplexity research on Discord bot dashboards 2025-2026

### Key Insights
1. **Real-time sync is #1 request** — WebSocket for instant status/command updates (we're building this ✅)
2. **Live config editing** — change commands/settings WITHOUT restarting the bot. This is a differentiator.
3. **Dark SaaS UI** — modern dashboards trending hard. We have this ✅
4. **Third-party API integrations** — Thrivebot planning this for Phase 3. We could add webhook/API integrations.
5. **Per-guild API keys** — security for multi-server bots. Good idea for our Pro tier.
6. **Biggest dev struggle: simplicity vs power** — YAGPDB too complex, MEE6 too simple. We need to nail the middle.

### Competitor Pricing Reference
| Bot/Platform | Free | Paid |
|---|---|---|
| MEE6 | Limited | $11.95/mo or $89.90 lifetime |
| Carl-bot | Basic | $7.99/mo |
| Arcane | Most features | $7/mo |
| ProBot | Core | $5-10/mo |
| Sapphire | Everything | Free |
| Thrivebot | Basic | TBD |

### Our Positioning
BotForge is unique: we're not a bot, we're a **bot hosting platform**. Nobody else lets you deploy YOUR OWN AI bots with YOUR OWN keys through a managed dashboard. Closest is BotGhost (no-code, AWS hosting) but they don't do AI/LLM bots.

## Updated Priority Queue

### 🔴 P0 — Next Wave (Wave 5)
1. **Conversation Logs Viewer** — Show what bots are saying. Users NEED to see this. Simple chat-style UI in bot detail panel.
2. **Live Config Editing** — Edit personality, model, trigger mode, tools WITHOUT stopping the bot. Hot-reload. Research says this is the #1 request.
3. **Deploy to Railway** — Get a public URL so anyone can use BotForge. Free tier = 500 hours/month.

### 🟡 P1 — Wave 6
4. **Auto-Moderation Module** — Word filter, spam detection, link blocking, raid protection. Every competitor has this.
5. **LemonSqueezy Payments** — Easier than Stripe for digital products. Free: 1 bot. Pro $9/mo: 5 bots + analytics. Team $19/mo: unlimited.
6. **Bot Scheduling** — Auto start/stop at certain times (save API costs).

### 🟢 P2 — Wave 7+
7. **Slash Command Builder** — Visual builder for custom slash commands
8. **Webhook Integrations** — External notifications on bot events
9. **Unit Tests** — Critical path coverage
10. **Admin Panel** — Platform management
11. **White-label** — Remove branding for enterprise

## Build Log
| Wave | Features | Status |
|------|----------|--------|
| 1 | Database, Landing Page, Advanced Features | ✅ Merged |
| 2 | README, Docker, Security | ✅ Merged |
| 3 | Discord OAuth, Templates Gallery, Onboarding | ✅ Merged |
| 4 | Analytics, WebSocket | 🔄 Building |
| 5 | Conversation Logs, Live Config, Railway Deploy | ⏳ Next |
