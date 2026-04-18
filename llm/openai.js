/**
 * OpenAI-compatible API client.
 * Handles OpenAI, OpenRouter, and local servers (Ollama, LM Studio).
 */
export class OpenAICompatibleClient {
  constructor({ apiKey, model, baseUrl = 'https://api.openai.com/v1', providerName = 'openai' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.providerName = providerName;
  }

  async complete(messages, { jsonMode = false, maxTokens = 4096 } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
    if (this.providerName === 'openrouter') {
      headers['HTTP-Referer'] = 'https://arxiv.org';
      headers['X-Title'] = 'TRarXiv';
    }

    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
    };
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? null;
    return { content, usage };
  }
}
