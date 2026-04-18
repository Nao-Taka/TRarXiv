/**
 * LLM client factory.
 * Reads provider config and returns a unified client.
 */
import { OpenAICompatibleClient } from './openai.js';
import { AnthropicClient }        from './anthropic.js';

/**
 * config shape:
 * {
 *   activeProvider: 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'local',
 *   providers: {
 *     openai:     { apiKey, model },
 *     anthropic:  { apiKey, model },
 *     gemini:     { apiKey, model },
 *     openrouter: { apiKey, model },
 *     local:      { apiKey, model, baseUrl },
 *   }
 * }
 */
export function createClient(config) {
  const provider = config.activeProvider ?? 'openai';
  const pc = config.providers?.[provider] ?? {};

  if (provider === 'anthropic') {
    return new AnthropicClient({ apiKey: pc.apiKey, model: pc.model });
  }

  const baseUrl =
    provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
    : provider === 'local'   ? (pc.baseUrl || 'http://localhost:11434/v1')
    : provider === 'gemini'  ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : 'https://api.openai.com/v1';

  return new OpenAICompatibleClient({
    apiKey:       pc.apiKey ?? 'ollama',
    model:        pc.model,
    baseUrl,
    providerName: provider,
  });
}

/** Returns the active model name from config. */
export function getActiveModel(config) {
  const provider = config.activeProvider ?? 'openai';
  return config.providers?.[provider]?.model ?? 'unknown';
}

/**
 * Unified complete() call that handles both Anthropic and OpenAI-compatible.
 * messages: [{role, content}] — 'system' role is extracted for Anthropic.
 */
export async function complete(client, messages, options = {}) {
  if (client instanceof AnthropicClient) {
    const system = messages.find(m => m.role === 'system')?.content ?? '';
    const userMessages = messages.filter(m => m.role !== 'system');
    return client.complete(userMessages, { ...options, systemPrompt: system });
  }
  return client.complete(messages, options);
}

/**
 * Vision call — sends a single image + text prompt.
 * Handles provider-specific image content format automatically.
 */
export async function completeWithImage(client, { base64, mediaType, text, systemPrompt = '' }, options = {}) {
  if (client instanceof AnthropicClient) {
    return client.complete(
      [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text },
      ]}],
      { ...options, systemPrompt }
    );
  }
  return client.complete(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        { type: 'text', text },
      ]},
    ],
    options
  );
}
