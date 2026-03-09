# PM Notes — BotForge Feature Priority
*Updated: 2026-03-09 03:25 UTC*

## Competitor Analysis
Researched: BotGhost, MEE6, Carl.gg, Arcane, Sapphire, ProBot, Dyno, YAGPDB

### Key Insights
1. **MEE6 charges $11.95/mo or $89.90 lifetime** — users hate the paywall but pay anyway
2. **Sapphire is fully free** and rising fast — "free" is a massive acquisition lever
3. **No one does AI bot HOSTING well** — BotGhost is closest but no-code only, ClawdHost is $29/mo
4. **Market gap: "bot-in-host" packages** — people want managed AI bots, not just pre-built bots
5. **Discord App Directory** is now the #1 discovery channel — bots listed there get massive installs
6. **Verification required for 100+ servers** — we need to plan for this

### What Makes Users Pay
- Unlimited features (free tiers are too limited)
- Auto-moderation + raid protection
- Custom welcome images/messages
- Analytics and insights
- 24/7 uptime guarantee
- No branding / white-label

## Feature Priority (Impact × Effort)

### 🔴 P0 — Ship This Week (Highest Impact)
1. **Discord OAuth Login** — Every competitor has this. Nobody wants email/password for a Discord product. Use discord.js OAuth2 flow.
2. **Guided Onboarding Wizard** — Step-by-step: "Create bot on Discord Developer Portal → Paste token → Pick personality → Deploy". Hand-hold users through it.
3. **Bot Templates Gallery** — Pre-built personalities with one-click deploy (Moderator, Study Buddy, Creative Writer, etc.). Users pick a template instead of writing prompts.

### 🟡 P1 — Ship This Month
4. **Conversation Logs UI** — Show what bots are saying in their servers. Users NEED visibility.
5. **Analytics Dashboard** — Messages/day chart, response time, most active channels. Simple Chart.js graphs.
6. **Stripe Integration** — Free: 1 bot. Pro $9/mo: 5 bots. Team $19/mo: unlimited.
7. **Auto-Moderation Module** — Word filter, spam detection, link blocking. Every competitor has this.

### 🟢 P2 — Ship This Quarter
8. **WebSocket Real-Time Updates** — Live bot status, live message feed in dashboard
9. **Slash Command Builder** — Visual builder for custom slash commands
10. **Welcome/Goodbye System** — Custom welcome messages + auto-role on join
11. **Bot Scheduling** — Auto start/stop at certain times
12. **Conversation Export** — JSON/CSV export of bot conversations
13. **Email Alerts** — Bot went down, usage spike, errors

### 🔵 P3 — Future
14. **Discord App Directory Listing** — Get BotForge listed officially
15. **Multi-language Bot Support**
16. **Webhook Integrations** — Slack/email notifications
17. **Admin Panel** — Platform-wide management
18. **White-label** — Remove BotForge branding for enterprise

## Current Wave 2 Agents (Running Now)
- README + Docker setup (kind-willow)
- Security hardening (faint-prairie)

## Next Agents to Spawn (Wave 3)
After Wave 2 merges:
1. **Discord OAuth Agent** — Add OAuth2 login flow
2. **Bot Templates Gallery Agent** — Visual template picker in dashboard
3. **Analytics Agent** — Usage charts with Chart.js
