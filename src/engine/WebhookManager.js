const crypto = require('crypto');

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 8000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDeliveryId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
}

class WebhookManager {
    constructor({
        listWebhooks,
        logger = console,
        fetchImpl = fetch,
        maxRetries = DEFAULT_MAX_RETRIES,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        timeoutMs = DEFAULT_TIMEOUT_MS
    } = {}) {
        this.listWebhooks = listWebhooks;
        this.logger = logger;
        this.fetch = fetchImpl;
        this.maxRetries = Number.isFinite(maxRetries) ? maxRetries : DEFAULT_MAX_RETRIES;
        this.baseDelayMs = Number.isFinite(baseDelayMs) ? baseDelayMs : DEFAULT_BASE_DELAY_MS;
        this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    }

    async dispatch(eventName, payload) {
        if (!eventName || !payload?.botId || typeof this.listWebhooks !== 'function') return;

        let hooks = [];
        try {
            hooks = this.listWebhooks(payload.botId) || [];
        } catch (err) {
            this.logger.warn('[WebhookManager] Failed to list webhooks:', err.message);
            return;
        }

        const eligible = hooks.filter((hook) => {
            if (!hook?.enabled) return false;
            if (!Array.isArray(hook.events)) return false;
            return hook.events.includes(eventName);
        });

        if (!eligible.length) return;

        const tasks = eligible.map((hook) => this.sendWebhook({ webhook: hook, eventName, payload }));
        await Promise.allSettled(tasks);
    }

    async sendTestWebhook({ webhook, payload }) {
        if (!webhook?.url) {
            return { ok: false, error: 'Invalid webhook URL' };
        }

        const testPayload = payload || {
            botId: webhook.botId || null,
            userId: null,
            message: 'Webhook test',
            source: 'manual',
            timestamp: new Date().toISOString()
        };

        return this.sendWebhook({
            webhook,
            eventName: 'webhook_test',
            payload: testPayload,
            force: true
        });
    }

    async sendWebhook({ webhook, eventName, payload, force = false }) {
        if (!webhook?.url || !eventName) {
            return { ok: false, error: 'Missing webhook URL or event' };
        }

        if (!force) {
            if (!webhook.enabled) return { ok: false, skipped: true, reason: 'disabled' };
            if (!Array.isArray(webhook.events) || !webhook.events.includes(eventName)) {
                return { ok: false, skipped: true, reason: 'filtered' };
            }
        }

        const deliveryId = buildDeliveryId();
        const timestamp = new Date().toISOString();
        const bodyObject = {
            id: deliveryId,
            event: eventName,
            botId: payload?.botId || webhook.botId || null,
            userId: payload?.userId || null,
            timestamp,
            data: payload || {}
        };

        const body = JSON.stringify(bodyObject);
        const headers = this._buildHeaders({ webhook, eventName, deliveryId, timestamp, body });

        return this._postWithRetry(webhook.url, body, headers, {
            eventName,
            webhookId: webhook.id,
            deliveryId
        });
    }

    _buildHeaders({ webhook, eventName, deliveryId, timestamp, body }) {
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'BotForge-Webhook/1.0',
            'X-BotForge-Event': eventName,
            'X-BotForge-Delivery': deliveryId,
            'X-BotForge-Timestamp': timestamp
        };

        if (webhook?.id) headers['X-BotForge-Webhook-Id'] = webhook.id;

        if (webhook?.secret) {
            const signature = crypto
                .createHmac('sha256', webhook.secret)
                .update(`${timestamp}.${body}`)
                .digest('hex');
            headers['X-BotForge-Signature'] = `sha256=${signature}`;
        }

        return headers;
    }

    async _postWithRetry(url, body, headers, context) {
        const attempts = this.maxRetries + 1;
        let lastError = null;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const res = await this._postJson(url, body, headers);
                if (res.ok) {
                    return { ok: true, status: res.status };
                }
                const responseText = await res.text().catch(() => '');
                const err = new Error(`Webhook responded with ${res.status}`);
                err.status = res.status;
                err.body = responseText;
                throw err;
            } catch (err) {
                lastError = err;
                if (attempt < attempts - 1) {
                    const delay = this.baseDelayMs * Math.pow(2, attempt);
                    await sleep(delay);
                }
            }
        }

        this.logger.warn(
            `[WebhookManager] Delivery failed for ${context?.eventName || 'event'} (${context?.deliveryId || 'n/a'}):`,
            lastError?.message || lastError
        );

        return { ok: false, error: lastError?.message || 'Delivery failed' };
    }

    async _postJson(url, body, headers) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            return await this.fetch(url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
    }
}

module.exports = { WebhookManager };
