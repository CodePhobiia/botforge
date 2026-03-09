/**
 * AIProvider - Unified interface for multiple AI providers
 * Supports OpenAI, Anthropic, and more
 */

const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk').default;

async function generateResponse({ provider, apiKey, model, systemPrompt, messages, maxTokens = 1024 }) {
    switch (provider) {
        case 'openai':
            return await openaiGenerate({ apiKey, model, systemPrompt, messages, maxTokens });
        case 'anthropic':
            return await anthropicGenerate({ apiKey, model, systemPrompt, messages, maxTokens });
        default:
            throw new Error(`Unknown AI provider: ${provider}`);
    }
}

async function openaiGenerate({ apiKey, model, systemPrompt, messages, maxTokens }) {
    const client = new OpenAI({ apiKey });
    
    const formattedMessages = [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({
            role: m.role,
            content: m.content
        }))
    ];

    const response = await client.chat.completions.create({
        model: model || 'gpt-4o-mini',
        messages: formattedMessages,
        max_tokens: maxTokens,
        temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content || 'No response generated.';
    const tokensUsed = Number.isFinite(response.usage?.total_tokens) ? response.usage.total_tokens : null;
    return {
        content,
        tokensUsed,
        modelUsed: response.model || model || 'gpt-4o-mini'
    };
}

async function anthropicGenerate({ apiKey, model, systemPrompt, messages, maxTokens }) {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: messages.map(m => ({
            role: m.role,
            content: m.content
        }))
    });

    const content = response.content[0]?.text || 'No response generated.';
    const inputTokens = Number.isFinite(response.usage?.input_tokens) ? response.usage.input_tokens : null;
    const outputTokens = Number.isFinite(response.usage?.output_tokens) ? response.usage.output_tokens : null;
    const tokensUsed = Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
        ? inputTokens + outputTokens
        : null;
    return {
        content,
        tokensUsed,
        modelUsed: response.model || model || 'claude-sonnet-4-20250514'
    };
}

module.exports = { generateResponse };
