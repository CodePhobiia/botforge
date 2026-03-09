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

    return response.choices[0]?.message?.content || 'No response generated.';
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

    return response.content[0]?.text || 'No response generated.';
}

module.exports = { generateResponse };
