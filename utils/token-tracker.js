/**
 * Tracks token usage and estimates costs per model.
 * Stored in chrome.storage.local under key 'trarxiv:tokenStats'
 */

const STORAGE_KEY = 'trarxiv:tokenStats';

// Default pricing table (USD per 1M tokens)
export const DEFAULT_PRICING = {
  // OpenAI
  'gpt-4o':            { input: 5.00,  output: 15.00 },
  'gpt-4o-mini':       { input: 0.15,  output: 0.60  },
  'gpt-3.5-turbo':     { input: 0.50,  output: 1.50  },
  // Anthropic
  'claude-opus-4-6':              { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':            { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001':    { input: 0.25,  output: 1.25  },
  // Local / unknown
  'local': { input: 0, output: 0 },
};

export class TokenTracker {
  async track(model, usage) {
    if (!usage) return;
    const stats = await this._load();
    if (!stats[model]) {
      stats[model] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }
    stats[model].promptTokens     += (usage.prompt_tokens     ?? usage.input_tokens  ?? 0);
    stats[model].completionTokens += (usage.completion_tokens ?? usage.output_tokens ?? 0);
    stats[model].totalTokens      += (usage.total_tokens      ?? (stats[model].promptTokens + stats[model].completionTokens));
    await this._save(stats);
  }

  async getStats() {
    return this._load();
  }

  async estimateCost(model, pricing = null) {
    const stats = await this._load();
    const modelStats = stats[model];
    if (!modelStats) return 0;

    const p = pricing ?? DEFAULT_PRICING[model] ?? DEFAULT_PRICING['local'];
    const inputCost  = (modelStats.promptTokens     / 1_000_000) * p.input;
    const outputCost = (modelStats.completionTokens / 1_000_000) * p.output;
    return inputCost + outputCost;
  }

  async clear() {
    return new Promise((resolve) => chrome.storage.local.remove(STORAGE_KEY, resolve));
  }

  async _load() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (r) => resolve(r[STORAGE_KEY] ?? {}));
    });
  }

  async _save(stats) {
    return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: stats }, resolve));
  }
}
