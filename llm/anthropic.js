/**
 * Anthropic Messages API client.
 */
export class AnthropicClient {
  constructor({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.anthropic.com';
  }

  /**
   * messages: [{role: 'user'|'assistant', content: string}]
   * systemPrompt: optional string
   */
  async complete(messages, { systemPrompt = '', maxTokens = 4096 } = {}) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages,
    };
    if (systemPrompt) body.system = systemPrompt;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const content = data.content?.[0]?.text ?? '';
    const usage = {
      prompt_tokens:     data.usage?.input_tokens  ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens:      (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    };
    return { content, usage };
  }
}
