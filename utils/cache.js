/**
 * LRU cache backed by chrome.storage.local.
 * Keys: trarxiv:cache:{type}:{paperId}:{sectionId}
 * Each entry: { ...data, cachedAt: ms, lastAccessed: ms }
 */
export class CacheManager {
  constructor(prefix = 'trarxiv') {
    this.cachePrefix = `${prefix}:cache:`;
  }

  _key(type, paperId, sectionId) {
    return `${this.cachePrefix}${type}:${paperId}:${sectionId}`;
  }

  async get(type, paperId, sectionId) {
    const key = this._key(type, paperId, sectionId);
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        const entry = result[key] ?? null;
        if (entry) {
          // Touch: refresh lastAccessed timestamp (LRU update)
          entry.lastAccessed = Date.now();
          chrome.storage.local.set({ [key]: entry });
        }
        resolve(entry);
      });
    });
  }

  async set(type, paperId, sectionId, data) {
    const key   = this._key(type, paperId, sectionId);
    const entry = { ...data, cachedAt: Date.now(), lastAccessed: Date.now() };
    return this._setWithEviction(key, entry);
  }

  async _setWithEviction(key, entry, retries = 3) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: entry }, async () => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message ?? '';
          if (msg.includes('QUOTA_BYTES') && retries > 0) {
            await this._evictOldest(5);
            resolve(this._setWithEviction(key, entry, retries - 1));
          } else {
            resolve(); // give up silently — translation still displayed
          }
        } else {
          resolve();
        }
      });
    });
  }

  async _evictOldest(n) {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (all) => {
        const entries = Object.entries(all)
          .filter(([k]) => k.startsWith(this.cachePrefix))
          .sort(([, a], [, b]) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));

        const toRemove = entries.slice(0, n).map(([k]) => k);
        if (toRemove.length === 0) return resolve(0);
        chrome.storage.local.remove(toRemove, () => resolve(toRemove.length));
      });
    });
  }

  async clear() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (all) => {
        const keys = Object.keys(all).filter(k => k.startsWith(this.cachePrefix));
        if (keys.length === 0) return resolve(0);
        chrome.storage.local.remove(keys, () => resolve(keys.length));
      });
    });
  }

  async getStats() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (all) => {
        const entries = Object.entries(all).filter(([k]) => k.startsWith(this.cachePrefix));
        const size    = entries.reduce((acc, [, v]) => acc + JSON.stringify(v).length, 0);
        resolve({ count: entries.length, sizeBytes: size });
      });
    });
  }
}
