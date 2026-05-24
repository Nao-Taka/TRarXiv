/**
 * TrArXiv - Background Service Worker (Manifest V3)
 * Handles all LLM API calls, caching, and token tracking.
 */
import { createClient, complete, completeWithImage } from './llm/llm-client.js';
import { CacheManager }    from './utils/cache.js';
import { TokenTracker }    from './utils/token-tracker.js';
import { decryptText }     from './utils/crypto.js';
import { registerPaper, getLibrary, setPaperSummary, setPaperTags, deletePaper } from './utils/library.js';
import { saveSiteConfig, getSiteConfig, getAllSiteConfigs, deleteSiteConfig } from './utils/site-configs.js';
import { validateSiteConfig } from './utils/selector-guard.js';

const cache   = new CacheManager();
const tracker = new TokenTracker();

// Per-session per-paper token accumulator (resets when service worker restarts)
const paperTokensMap = new Map(); // paperId → { input: number, output: number }

// Decrypted API keys: stored in chrome.storage.session so they survive SW restarts
// within a browser session, but are cleared when Chrome closes.
const SESSION_KEYS_KEY = 'trarxiv:session:keys';

async function getSessionKeys() {
  return new Promise(resolve =>
    chrome.storage.session.get(SESSION_KEYS_KEY, r => resolve(r[SESSION_KEYS_KEY] ?? {}))
  );
}

async function setSessionKeys(keys) {
  return new Promise(resolve =>
    chrome.storage.session.set({ [SESSION_KEYS_KEY]: keys }, resolve)
  );
}

// ─── Storage area ─────────────────────────────────────────────────────────────
async function getStorageArea() {
  return new Promise(resolve =>
    chrome.storage.local.get('trarxiv:storageType', r =>
      resolve(r['trarxiv:storageType'] === 'sync' ? chrome.storage.sync : chrome.storage.local)
    )
  );
}

// ─── Restore dynamic content scripts on SW startup ────────────────────────────
chrome.runtime.onInstalled.addListener(restoreDynamicContentScripts);
chrome.runtime.onStartup.addListener(restoreDynamicContentScripts);

async function restoreDynamicContentScripts() {
  const configs = await getAllSiteConfigs().catch(() => []);
  for (const cfg of configs) {
    try {
      await chrome.scripting.registerContentScripts([{
        id: `dynamic-${cfg.hostname}`,
        matches: [`https://${cfg.hostname}/*`],
        js: ['content/content.js'],
        css: ['content/content.css'],
        runAt: 'document_idle',
      }]);
    } catch {
      // Already registered or no permission — ignore
    }
  }
}

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id ?? null;
  dispatch(msg, tabId)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});

async function dispatch(msg, tabId) {
  switch (msg.action) {
    case 'translate':        return handleTranslate(msg, tabId);
    case 'explain':          return handleExplain(msg, tabId);
    case 'chat':             return handleChat(msg);
    case 'paperBriefing':    return handlePaperBriefing(msg);
    case 'authorResearch':   return handleAuthorResearch(msg);
    case 'getTokenStats':    return tracker.getStats();
    case 'getTokenBudget':   return handleGetTokenBudget(msg);
    case 'clearCache':       return cache.clear();
    case 'getCacheStats':    return cache.getStats();
    case 'analyzeImage':      return handleAnalyzeImage(msg);
    case 'registerPaper':     return registerPaper(msg);
    case 'getLibrary':        return getLibrary();
    case 'setPaperSummary':   return setPaperSummary(msg.id, msg.summary);
    case 'setPaperTags':      return setPaperTags(msg.id, msg.tags);
    case 'deletePaper':       return deletePaper(msg.id);
    case 'analyzeSite':            return handleAnalyzeSite(msg);
    case 'refineSiteConfig':       return handleRefineSiteConfig(msg);
    case 'registerContentScript':  return handleRegisterContentScript(msg.hostname);
    case 'getSiteConfig':     return getSiteConfig(msg.hostname);
    case 'getAllSiteConfigs':  return getAllSiteConfigs();
    case 'deleteSiteConfig':  return handleDeleteSiteConfig(msg.hostname);
    case 'unlockKeys':        return handleUnlockKeys(msg);
    case 'lockKeys':         return handleLockKeys();
    case 'isUnlocked':       return handleIsUnlocked();
    default: throw new Error(`Unknown action: ${msg.action}`);
  }
}

// ─── Key unlock / lock ────────────────────────────────────────────────────────
async function handleUnlockKeys({ password }) {
  const config = await loadConfig();
  const providers = config.providers ?? {};
  let anyDecrypted = false;
  let hasEncrypted = false;
  const keys = await getSessionKeys();

  for (const [provider, pc] of Object.entries(providers)) {
    if (provider === 'local') continue;
    if (!pc.apiKeyEnc) continue;
    hasEncrypted = true;
    try {
      keys[provider] = await decryptText(password, pc.apiKeyEnc);
      anyDecrypted = true;
    } catch {
      delete keys[provider];
    }
  }

  if (anyDecrypted) await setSessionKeys(keys);
  if (!hasEncrypted) return { success: true };
  if (anyDecrypted)  return { success: true };
  return { success: false, error: 'パスワードが正しくありません' };
}

async function handleLockKeys() {
  await setSessionKeys({});
  return { success: true };
}

async function handleIsUnlocked() {
  const config = await loadConfig();
  const providers = config.providers ?? {};
  const keys = await getSessionKeys();
  for (const [provider, pc] of Object.entries(providers)) {
    if (provider === 'local') continue;
    if (pc.apiKeyEnc && !keys[provider]) return { unlocked: false };
  }
  return { unlocked: true };
}

// ─── Site analyzer ────────────────────────────────────────────────────────────
async function handleAnalyzeSite({ url, domSummary }) {
  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'explain');

  const messages = [
    {
      role: 'system',
      content: 'あなたはウェブページのDOM構造を解析し、論文コンテンツのCSSセレクターを特定する専門家です。JSON形式のみで回答してください。',
    },
    {
      role: 'user',
      content:
        `以下のウェブページ（${url}）のDOM構造から、論文のセクション・段落を取得するためのCSSセレクターを特定してください。\n\n` +
        `DOM概要:\n${domSummary.slice(0, 6000)}\n\n` +
        `以下のJSON形式のみで回答してください（値が不明な場合はnull）:\n` +
        `{"titleSel":"h1のセレクター","abstractSel":"アブストラクト要素","sectionSel":"セクション要素","headingSel":"セクション見出し","paragraphSel":"本文段落","confidence":"high/medium/low","note":"補足"}`,
    },
  ];

  const { content, usage } = await complete(client, messages, { jsonMode: false });
  await tracker.track(model, usage);

  let parsed;
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || !parsed.sectionSel) {
    return { success: false, error: 'セレクターを特定できませんでした' };
  }

  let safeParsed;
  try {
    safeParsed = validateSiteConfig(parsed);
  } catch (e) {
    return { success: false, error: `LLM出力に危険なセレクターが含まれていました: ${e.message}` };
  }

  const hostname = new URL(url).hostname;
  const siteConfig = { hostname, url, ...safeParsed };
  await saveSiteConfig(siteConfig);

  // Dynamically register content script for this hostname (best-effort)
  try {
    await chrome.scripting.registerContentScripts([{
      id: `dynamic-${hostname}`,
      matches: [`https://${hostname}/*`],
      js: ['content/content.js'],
      css: ['content/content.css'],
      runAt: 'document_idle',
    }]);
  } catch (e) {
    // Already registered or insufficient host permissions — both are acceptable
    if (!e?.message?.includes('already')) {
      console.warn('Content script registration skipped:', e?.message);
    }
  }

  return { success: true, config: siteConfig };
}

async function handleDeleteSiteConfig(hostname) {
  await deleteSiteConfig(hostname);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [`dynamic-${hostname}`] });
  } catch {
    // Script not registered — ignore
  }
  try {
    await chrome.permissions.remove({ origins: [`https://${hostname}/*`] });
  } catch {
    // Permission may have been granted via a broader pattern — ignore
  }
  return { success: true };
}

async function handleRegisterContentScript(hostname) {
  try {
    await chrome.scripting.registerContentScripts([{
      id: `dynamic-${hostname}`,
      matches: [`https://${hostname}/*`],
      js: ['content/content.js'],
      css: ['content/content.css'],
      runAt: 'document_idle',
    }]);
  } catch (e) {
    if (!e?.message?.includes('already')) throw e;
  }
  return { success: true };
}

async function handleRefineSiteConfig({ hostname, currentConfig, history }) {
  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'explain');

  const systemPrompt =
    'あなたはウェブページのCSSセレクター修正の専門家です。' +
    'ユーザーのフィードバックを受けて設定を改善し、JSON形式のみで回答してください。';

  // Build conversation: previous turns + current config context
  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content:
        `論文サイト「${hostname}」の現在の解析設定:\n` +
        `${JSON.stringify(currentConfig, null, 2)}\n\n` +
        `上記設定についてのフィードバックを受け取りました。修正をお願いします。\n` +
        `修正後は以下のJSON形式のみで返してください:\n` +
        `{"titleSel":"...","abstractSel":"...","sectionSel":"...","headingSel":"...","paragraphSel":"...","confidence":"high/medium/low","note":"..."}`,
    },
    ...history,
  ];

  const { content, usage } = await complete(client, messages, { jsonMode: false });
  await tracker.track(model, usage);

  let parsed;
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || !parsed.sectionSel) {
    return { success: false, error: '修正後のセレクターを取得できませんでした' };
  }

  let safeParsed;
  try {
    safeParsed = validateSiteConfig(parsed);
  } catch (e) {
    return { success: false, error: `LLM出力に危険なセレクターが含まれていました: ${e.message}` };
  }

  const siteConfig = { ...currentConfig, ...safeParsed, hostname };
  await saveSiteConfig(siteConfig);
  return { success: true, config: siteConfig };
}

// ─── Image analysis (vision) ─────────────────────────────────────────────────
// Reject URLs targeting loopback / private / link-local / mDNS hosts to prevent
// the page from coaxing us into fetching internal resources (SSRF).
function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); }
  catch { throw new Error('画像URLが不正です'); }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`画像URLのスキームは http/https のみ許可されています (${u.protocol})`);
  }

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`内部ホストの画像URLは拒否されました (${host})`);
  }

  // IPv4 literal
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    const privateV4 =
      a === 10 ||                                // 10.0.0.0/8
      a === 127 ||                                // 127.0.0.0/8 loopback
      (a === 169 && b === 254) ||                 // 169.254.0.0/16 link-local (AWS metadata)
      (a === 172 && b >= 16 && b <= 31) ||        // 172.16.0.0/12
      (a === 192 && b === 168) ||                 // 192.168.0.0/16
      a === 0;
    if (privateV4) throw new Error(`プライベートIPの画像URLは拒否されました (${host})`);
  }

  // IPv6 literal (URL.hostname strips brackets)
  if (host.includes(':')) {
    const v6 = host;
    if (v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) {
      throw new Error(`プライベートIPv6の画像URLは拒否されました (${host})`);
    }
    if (v6.startsWith('::ffff:')) {
      // IPv4-mapped IPv6 — recurse on the embedded v4
      assertPublicHttpUrl(`${u.protocol}//${v6.slice(7)}${u.pathname}`);
    }
  }
}

async function handleAnalyzeImage({ imageUrl, caption, paperTitle, paperId }) {
  assertPublicHttpUrl(imageUrl);

  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'explain');

  // Fetch image from arXiv and convert to base64
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`画像の取得に失敗しました (HTTP ${res.status})`);
  const blob       = await res.blob();
  const mediaType  = blob.type || 'image/png';
  const arrayBuf   = await blob.arrayBuffer();
  const base64     = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));

  const captionPart = caption ? `\nキャプション: ${caption}` : '';
  const titlePart   = paperTitle ? `\n論文: ${paperTitle}` : '';
  const text = `この図を日本語で詳しく解説してください。グラフや表であればその意味・傾向も説明してください。${captionPart}${titlePart}`;

  const { content, usage } = await completeWithImage(client, {
    base64, mediaType, text,
    systemPrompt: '学術論文の図・グラフ・表の解説アシスタントです。図の内容を正確かつ分かりやすく日本語で説明してください。',
  });

  await tracker.track(model, usage);
  if (paperId) addPaperTokens(paperId, usage);
  return { content };
}

// ─── Config helpers ───────────────────────────────────────────────────────────
async function loadConfig() {
  const area = await getStorageArea();
  return new Promise(resolve =>
    area.get('trarxiv:config', r => resolve(r['trarxiv:config'] ?? {}))
  );
}

const TASK_LABELS = { translate: '翻訳', explain: '解説', chat: 'チャット' };

async function buildClient(config, taskType) {
  const task = config.tasks?.[taskType];
  if (!task?.provider || !task?.model) {
    throw new Error(`「${TASK_LABELS[taskType] ?? taskType}」のモデルが設定されていません。オプション画面で設定してください。`);
  }
  const provider = task.provider;
  const model    = task.model;
  const pc       = config.providers?.[provider] ?? {};

  let apiKey;
  if (provider === 'local') {
    apiKey = pc.apiKey ?? 'ollama';
  } else {
    const keys = await getSessionKeys();
    if (keys[provider]) {
      apiKey = keys[provider];
    } else if (pc.apiKeyEnc) {
      throw new Error('NEEDS_PASSWORD');
    } else if (pc.apiKey) {
      apiKey = pc.apiKey; // legacy unencrypted key
    } else {
      throw new Error(`${provider} のAPIキーが設定されていません。`);
    }
  }

  const clientConfig = {
    activeProvider: provider,
    providers: { [provider]: { ...pc, apiKey, model } },
  };
  return { client: createClient(clientConfig), model };
}

// ─── Token budget ─────────────────────────────────────────────────────────────
async function handleGetTokenBudget({ paperId }) {
  const config = await loadConfig();
  const limit   = config.tokenLimit?.perPaper ?? 0;
  const enabled = config.tokenLimit?.enabled  ?? false;
  const stats   = paperTokensMap.get(paperId) ?? { input: 0, output: 0 };
  const used    = stats.input + stats.output;
  return { enabled, limit, used, remaining: Math.max(0, limit - used) };
}

function addPaperTokens(paperId, usage) {
  if (!usage || !paperId) return;
  const prev = paperTokensMap.get(paperId) ?? { input: 0, output: 0 };
  paperTokensMap.set(paperId, {
    input:  prev.input  + (usage.prompt_tokens     ?? usage.input_tokens  ?? 0),
    output: prev.output + (usage.completion_tokens ?? usage.output_tokens ?? 0),
  });
}

function getPaperTokensUsed(paperId) {
  const s = paperTokensMap.get(paperId) ?? { input: 0, output: 0 };
  return s.input + s.output;
}

// ─── Translate ────────────────────────────────────────────────────────────────
async function handleTranslate({ paperId, sectionId, sectionTitle, paragraphs, forceRefresh = false }, tabId) {
  if (!forceRefresh) {
    const cached = await cache.get('trans', paperId, sectionId);
    if (cached) return { ...cached, fromCache: true };
  }

  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'translate');
  const limit   = config.tokenLimit?.enabled ? (config.tokenLimit.perPaper ?? 0) : 0;

  const results = [];
  let limitExceeded = false;
  const batchSize = 5;

  for (let i = 0; i < paragraphs.length; i += batchSize) {
    if (limit > 0 && getPaperTokensUsed(paperId) >= limit) {
      limitExceeded = true;
      break;
    }

    const batch = paragraphs.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(para => translateParagraph(client, model, para, sectionTitle, paperId))
    );
    results.push(...batchResults);

    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: '_translateProgress',
        sectionId,
        completed: Math.min(i + batchSize, paragraphs.length),
        total:     paragraphs.length,
      }).catch(() => {});
    }
  }

  const result = { results, limitExceeded, paperTokensUsed: getPaperTokensUsed(paperId) };
  if (!limitExceeded) {
    await cache.set('trans', paperId, sectionId, { results });
  }
  return result;
}

async function translateParagraph(client, model, para, sectionTitle, paperId) {
  const sentences = splitSentences(para.text);
  if (sentences.length === 0) return { paraId: para.id, pairs: [] };

  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const messages = [
    {
      role: 'system',
      content: '学術論文の翻訳アシスタントです。番号付き英文を同じ番号で日本語に翻訳します。',
    },
    {
      role: 'user',
      content:
        `以下の英文（セクション:「${sectionTitle}」）を番号を維持して日本語に翻訳してください。\n` +
        `【出力ルール】番号付きの翻訳文のみを返す。前置き・説明・原文の繰り返し不要。\n\n` +
        numbered,
    },
  ];

  const { content, usage } = await complete(client, messages);
  await tracker.track(model, usage);
  addPaperTokens(paperId, usage);

  return { paraId: para.id, pairs: parseNumberedTranslation(content, sentences) };
}

// ─── Explain ──────────────────────────────────────────────────────────────────
async function handleExplain({ paperId, sectionId, sectionTitle, text, paperTitle, forceRefresh = false }, tabId) {
  if (!forceRefresh) {
    const cached = await cache.get('expl', paperId, sectionId);
    if (cached) return { ...cached, fromCache: true };
  }

  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'explain');

  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      action: '_explainProgress', sectionId, phase: 'generating',
    }).catch(() => {});
  }

  const messages = [
    {
      role: 'system',
      content: 'あなたは学術論文を分かりやすく解説するアシスタントです。専門用語を噛み砕き、背景知識や関連研究も交えて説明してください。',
    },
    {
      role: 'user',
      content:
        `論文「${paperTitle}」のセクション「${sectionTitle}」を、専門外の研究者が理解できるよう日本語で解説してください。\n` +
        `- 重要な概念や手法をわかりやすく説明する\n` +
        `- 必要に応じて関連する先行研究や背景に言及する\n` +
        `- 専門用語には括弧内で簡単な説明を加える\n\n` +
        `本文:\n${text.slice(0, 8000)}`,
    },
  ];

  const { content, usage } = await complete(client, messages);
  await tracker.track(model, usage);
  addPaperTokens(paperId, usage);

  const result = { explanation: content };
  await cache.set('expl', paperId, sectionId, result);
  return result;
}

// ─── Paper Briefing ───────────────────────────────────────────────────────────
async function handlePaperBriefing({ paperId, paperTitle, abstract, forceRefresh = false }) {
  if (!forceRefresh) {
    const cached = await cache.get('brief', paperId, 'briefing');
    if (cached) return { ...cached, fromCache: true };
  }

  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'explain');

  const messages = [
    {
      role: 'system',
      content: 'あなたは学術論文を分析するアシスタントです。指定された形式で簡潔に答えてください。',
    },
    {
      role: 'user',
      content:
        `以下の論文について、5つの観点から日本語で簡潔に分析してください。\n\n` +
        `論文タイトル: ${paperTitle}\n` +
        `アブストラクト:\n${abstract.slice(0, 3000)}\n\n` +
        `【出力形式】各行を必ず以下のラベルで始めてください：\n` +
        `🎯一言で: （論文を一文で要約）\n` +
        `🔬手法: （具体的な手法・アプローチを2〜3文で）\n` +
        `✨新規性: （何が新しいか、既存研究との違いを2〜3文で）\n` +
        `📊比較: （関連する既存手法と比較してどう優れているか）\n` +
        `⚠️課題: （残された課題・限界を1〜2文で）`,
    },
  ];

  const { content, usage } = await complete(client, messages);
  await tracker.track(model, usage);
  addPaperTokens(paperId, usage);

  const result = { briefing: content };
  await cache.set('brief', paperId, 'briefing', result);
  return result;
}

// ─── Author Research ──────────────────────────────────────────────────────────
async function handleAuthorResearch({ authorName, paperTitle }) {
  const authorKey = authorName.toLowerCase().replace(/\s+/g, '_');
  const cached = await cache.get('author', authorKey, 'info');
  if (cached) return { ...cached, fromCache: true };

  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'chat');

  const messages = [
    {
      role: 'system',
      content: 'あなたは研究者の経歴調査を支援するアシスタントです。学習データに基づいて簡潔に回答してください。',
    },
    {
      role: 'user',
      content:
        `研究者「${authorName}」について教えてください（論文「${paperTitle}」の著者）。\n\n` +
        `以下の観点で日本語で簡潔にまとめてください（不明な場合は「不明」と記載）：\n` +
        `- 所属機関・役職\n` +
        `- 研究分野・専門領域\n` +
        `- 代表的な研究・主な業績\n\n` +
        `3〜5文程度でまとめてください。`,
    },
  ];

  const { content, usage } = await complete(client, messages);
  await tracker.track(model, usage);

  const result = { info: content };
  await cache.set('author', authorKey, 'info', result);
  return result;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function handleChat({ messages, paperContext }) {
  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'chat');

  const systemContent =
    `あなたは学術論文の理解を支援するAIアシスタントです。\n` +
    `以下の論文に関する質問に、本文の文脈に沿って丁寧に回答してください。\n\n` +
    `【論文情報】\n` +
    `タイトル: ${paperContext.title ?? '不明'}\n` +
    `アブストラクト: ${(paperContext.abstract ?? '').slice(0, 2000)}\n` +
    `セクション: ${(paperContext.sections ?? []).map(s => s.title).join(', ')}`;

  const fullMessages = [{ role: 'system', content: systemContent }, ...messages];
  const { content, usage } = await complete(client, fullMessages);
  await tracker.track(model, usage);

  return { content };
}

// ─── Numbered translation parser ──────────────────────────────────────────────
function parseNumberedTranslation(response, originalSentences) {
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
  const map = new Map();

  for (const line of lines) {
    if (/^(translation|翻訳|output|以下|here|below)/i.test(line)) continue;

    const m =
      line.match(/^[（(](\d+)[）)]\s*(.+)/) ??
      line.match(/^([\u2460-\u2473])\s*(.+)/) ??
      line.match(/^(\d+)[.):\s、]\s*(.+)/);

    if (m) {
      let idx;
      if (m[1].charCodeAt(0) >= 0x2460) {
        idx = m[1].charCodeAt(0) - 0x2460;
      } else {
        idx = parseInt(m[1], 10) - 1;
      }
      if (idx >= 0 && idx < originalSentences.length && !map.has(idx)) {
        map.set(idx, m[2].trim());
      }
    }
  }

  if (map.size === 0 && lines.length > 0) {
    lines.forEach((l, i) => {
      if (i < originalSentences.length) map.set(i, l);
    });
  }

  return originalSentences.map((en, i) => ({
    en,
    ja: map.get(i) ?? '—',
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function splitSentences(text) {
  if (!text || text.trim().length === 0) return [];
  const abbrevRe = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|i\.e|e\.g|Fig|Figs|Eq|Sec|Tab|Ref|cf|al|No|Vol|pp|Ch)\./g;
  const protected_ = text.replace(abbrevRe, m => m.replace('.', '\x00'));
  const raw = protected_
    .split(/(?<=[.!?])\s+(?=[A-Z"(])/g)
    .map(s => s.replace(/\x00/g, '.').trim())
    .filter(s => s.length > 2);
  return raw.length > 0 ? raw : [text.trim()];
}
