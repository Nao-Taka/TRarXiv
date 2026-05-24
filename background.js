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
import { fetchAuthorInfo, fetchPaperContext, searchPaperByTitle, getAuthorPapers } from './utils/semantic-scholar.js';

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
    case 'paperPositioning': return handlePaperPositioning(msg);
    case 'getPaperRelated':  return handleGetPaperRelated(msg);
    case 'refSummary':       return handleRefSummary(msg);
    case 'authorResearch':   return handleAuthorResearch(msg);
    case 'authorAnalysis':   return handleAuthorAnalysis(msg);
    case 'authorChoice':     return handleAuthorChoice(msg);
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
      content:
        '学術論文の翻訳アシスタントです。番号付き英文を同じ番号で日本語に翻訳します。\n' +
        '⟦MATH_N⟧ 形式のトークン (例: ⟦MATH_0⟧) は数式、⟦REF:X⟧ 形式 (例: ⟦REF:1⟧) は文献参照' +
        'のプレースホルダーです。両方とも翻訳・変形せず、文中の同じ意味的位置に **そのまま** 残してください。',
    },
    {
      role: 'user',
      content:
        `以下の英文（セクション:「${sectionTitle}」）を番号を維持して日本語に翻訳してください。\n` +
        `【出力ルール】\n` +
        `- 番号付きの翻訳文のみを返す。前置き・説明・原文の繰り返し不要。\n` +
        `- ⟦MATH_N⟧ / ⟦REF:X⟧ トークンは改変せず、自然な位置に保持する (省略・追加禁止)。\n\n` +
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

// ─── Reference summary (A14) ─────────────────────────────────────────────────
// arxiv 論文の参考文献を Semantic Scholar paper search で検索 → abstract を LLM で
// 短く要約 (1〜2文)。失敗時は要約なしを返す (LLM 幻覚を避けるため fallback しない)。
async function handleRefSummary({ refKey, title, authors }) {
  if (!title || typeof title !== 'string') {
    throw new Error('参考文献のタイトルが取得できませんでした');
  }
  // 同じタイトルの ref はキャッシュ共有 (refKey は paper 横断で別なので使わない)
  const cacheKey = title.toLowerCase().replace(/\s+/g, '_').slice(0, 100);
  const cached = await cache.get('ref', cacheKey, 'summary');
  if (cached) return { ...cached, fromCache: true };

  // S2 paper search で abstract 取得
  let s2Paper = null;
  try {
    const papers = await searchPaperByTitle(title, { limit: 1 });
    s2Paper = papers[0] ?? null;
  } catch (e) {
    return { summary: `Semantic Scholar 検索失敗: ${e.message}`, s2Url: null };
  }

  if (!s2Paper) {
    const result = { summary: 'Semantic Scholar 上で該当論文が見つかりませんでした', s2Url: null };
    await cache.set('ref', cacheKey, 'summary', result);
    return result;
  }

  if (!s2Paper.abstract) {
    const result = {
      summary: 'アブストラクトが Semantic Scholar に登録されていません',
      s2Url: s2Paper.url ?? null,
    };
    await cache.set('ref', cacheKey, 'summary', result);
    return result;
  }

  // LLM で要約
  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'explain');

  const messages = [
    { role: 'system', content: '与えられた論文のアブストラクトを日本語で簡潔に要約します。' },
    {
      role: 'user',
      content:
        `タイトル: ${title}\n\n` +
        `アブストラクト:\n${s2Paper.abstract.slice(0, 2500)}\n\n` +
        `上記の論文を日本語で1〜2文で要約してください。前置きや「この論文は」等は不要、要約のみ返してください。`,
    },
  ];

  const { content, usage } = await complete(client, messages);
  await tracker.track(model, usage);

  const result = { summary: content, s2Url: s2Paper.url ?? null };
  await cache.set('ref', cacheKey, 'summary', result);
  return result;
}

// ─── Paper Positioning (A11) ─────────────────────────────────────────────────
// arXiv 論文限定。論文の研究分野での位置づけ + 関連論文を返す。
function isArxivPaperId(paperId) {
  // 新形式 'XXXX.YYYYY' or 旧形式 'cs.AI/0001001' 等
  return /^\d{4}\.\d{4,5}$/.test(paperId) || /^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/i.test(paperId);
}

async function handleGetPaperRelated({ paperId, forceRefresh = false }) {
  if (!isArxivPaperId(paperId)) {
    throw new Error('関連論文取得は arXiv 論文でのみ対応しています');
  }
  if (!forceRefresh) {
    const cached = await cache.get('related', paperId, 'main');
    if (cached) return { ...cached, fromCache: true };
  }
  const ctx = await fetchPaperContext(paperId);
  await cache.set('related', paperId, 'main', ctx);
  return ctx;
}

async function handlePaperPositioning({ paperId, paperTitle, abstract, forceRefresh = false }) {
  if (!isArxivPaperId(paperId)) {
    throw new Error('論文の位置づけ機能は arXiv 論文でのみ対応しています');
  }
  if (!forceRefresh) {
    const cached = await cache.get('positioning', paperId, 'main');
    if (cached) return { ...cached, fromCache: true };
  }

  // S2 から関連論文を取得 (失敗しても LLM 分析は続行、警告だけ付与)
  let related = null;
  let relatedError = null;
  try {
    related = await fetchPaperContext(paperId);
  } catch (e) {
    relatedError = e.message;
  }

  const refsText = (related?.references ?? []).slice(0, 8).map(r =>
    `- ${r.title} (${r.year ?? '?'}, ${r.authors?.[0]?.name ?? '?'} et al., cited ${r.citationCount ?? '?'})`
  ).join('\n');
  const citesText = (related?.citations ?? []).slice(0, 8).map(r =>
    `- ${r.title} (${r.year ?? '?'}, cited ${r.citationCount ?? '?'})`
  ).join('\n');
  const recsText = (related?.recommendations ?? []).slice(0, 5).map(r =>
    `- ${r.title} (${r.year ?? '?'})`
  ).join('\n');

  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'explain');

  const messages = [
    {
      role: 'system',
      content: 'あなたは学術論文の位置づけを分析するアシスタントです。' +
               '提供された Semantic Scholar の関連論文情報を踏まえて、日本語で簡潔に答えてください。',
    },
    {
      role: 'user',
      content:
        `論文「${paperTitle}」について、研究分野における位置づけを分析してください。\n\n` +
        `アブストラクト:\n${(abstract ?? '').slice(0, 2500)}\n\n` +
        `この論文が引用している先行研究 (Semantic Scholar, 最大8件):\n${refsText || '(取得失敗または無し)'}\n\n` +
        `この論文を引用している後続研究 (Semantic Scholar, 最大8件):\n${citesText || '(取得失敗または無し)'}\n\n` +
        `推薦される類似論文 (Semantic Scholar, 最大5件):\n${recsText || '(取得失敗または無し)'}\n\n` +
        `【出力形式】各行を必ず以下のラベルで始めてください:\n` +
        `🎯立ち位置: この論文が研究分野のどんな流れの中にあるか (1〜2文)\n` +
        `📜先行研究との関係: 主要な先行研究をどう発展/反証/組み合わせているか (2〜3文)\n` +
        `🚀後続への影響: どんな後続研究を生み出したか、影響範囲 (1〜2文)\n` +
        `➡️次に読むべき論文: 上記から重要そうな2〜3本を選び、選定理由とともに列挙`,
    },
  ];

  const { content, usage } = await complete(client, messages);
  await tracker.track(model, usage);
  addPaperTokens(paperId, usage);

  const result = { positioning: content, related, relatedError };
  await cache.set('positioning', paperId, 'main', result);
  return result;
}

// ─── Author Research (Semantic Scholar — no LLM fallback) ────────────────────
// 同名著者の判別のため、現論文 (paperId が arXiv ID) の分野との関連度を計算する。
// ユーザーが「合ってる/違う」を選んだ結果は chrome.storage.local に保存され、
// 次回は確定した authorId のみを返す。

const AUTHORCHOICE_PREFIX = 'trarxiv:authorchoice:';

function authorChoiceKey(paperId, authorName) {
  return AUTHORCHOICE_PREFIX + `${paperId}::${authorName.toLowerCase()}`;
}

async function loadAuthorChoice(paperId, authorName) {
  if (!paperId || !authorName) return null;
  const k = authorChoiceKey(paperId, authorName);
  return new Promise(resolve =>
    chrome.storage.local.get(k, r => resolve(r[k] ?? null))
  );
}

async function saveAuthorChoice(paperId, authorName, choice) {
  const k = authorChoiceKey(paperId, authorName);
  return new Promise(resolve =>
    chrome.storage.local.set({ [k]: choice }, resolve)
  );
}

async function handleAuthorResearch({ authorName, paperId }) {
  const authorKey = authorName.toLowerCase().replace(/\s+/g, '_');
  // paperId が arxiv 形式なら関連度計算用に渡す
  const arxivLike = paperId && (/^\d{4}\.\d{4,5}$/.test(paperId) || /^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/i.test(paperId));
  const currentArxivId = arxivLike ? paperId : null;

  // 確定済み choice があれば、その候補のみを返す
  const choice = await loadAuthorChoice(paperId, authorName);

  // キャッシュキーに paperId/choice を含めて、同名でも別論文で別結果を保てるように
  const cacheSubkey = `s2::${currentArxivId ?? 'none'}::${choice?.authorId ?? 'none'}`;
  const cached = await cache.get('author', authorKey, cacheSubkey);
  if (cached) return { ...cached, fromCache: true, choice };

  let result;
  if (choice?.authorId) {
    // 確定済み: その authorId だけ詳細取得
    let topPapers = [];
    try {
      topPapers = await getAuthorPapers(choice.authorId, { limit: 5 });
    } catch (e) {
      console.warn('[TrArXiv] confirmed-author getAuthorPapers failed:', e?.message);
    }
    result = {
      source: 'semantic-scholar',
      candidates: [{
        ...choice.snapshot,
        topPapers,
        fields: [],
        relevanceScore: 1,
        matchedFields: [],
      }],
      currentPaperFields: [],
      confirmed: true,
    };
  } else {
    // 通常: 候補列挙 + 関連度計算
    const { candidates, currentPaperFields } = await fetchAuthorInfo(authorName, { currentArxivId });
    result = { source: 'semantic-scholar', candidates, currentPaperFields };
  }

  await cache.set('author', authorKey, cacheSubkey, result);
  return { ...result, choice };
}

// 候補に対する LLM 分析 (代表論文ごとの1行要約 + 著者全体の研究スタンス)。
// ユーザーが「詳しく見る」を押した時だけ呼ばれる遅延ロード。
async function handleAuthorAnalysis({ authorId, authorName, topPapers }) {
  if (!authorId) throw new Error('authorId が指定されていません');
  const cacheKey = authorId;
  const cached = await cache.get('authoranalysis', cacheKey, 'main');
  if (cached) return { ...cached, fromCache: true };

  // abstract が無いと要約できないので abstract 付きで再取得 (初回時)
  let papersForLlm = topPapers ?? [];
  const needsAbstract = papersForLlm.some(p => !p.abstract);
  if (needsAbstract) {
    try {
      papersForLlm = await getAuthorPapers(authorId, { limit: 5, withAbstract: true });
    } catch (e) {
      // 失敗時は abstract 無しで進める
    }
  }

  const papersText = papersForLlm.slice(0, 5).map((p, i) =>
    `${i + 1}. ${p.title ?? '(no title)'} (${p.year ?? '?'}, ${p.venue ?? ''})\n` +
    `   ${p.abstract ? p.abstract.slice(0, 500) : '(abstract 未登録)'}`
  ).join('\n\n');

  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'explain');

  const messages = [
    {
      role: 'system',
      content: '研究者の代表論文を分析し、日本語で簡潔にまとめます。出力はラベル形式の構造化テキスト。',
    },
    {
      role: 'user',
      content:
        `研究者「${authorName ?? '?'}」の代表論文 (最大5本、Semantic Scholar より):\n\n${papersText}\n\n` +
        `以下の形式で **日本語** で答えてください。前置きや結びは不要、ラベルから始めてください:\n\n` +
        `【各論文の1行要約】\n` +
        `1. (1文の要約)\n` +
        `2. (1文の要約)\n` +
        `...\n\n` +
        `【研究スタンス】\n` +
        `(この研究者の研究領域・アプローチ・主な関心を 1〜2文で)`,
    },
  ];

  const { content, usage } = await complete(client, messages);
  await tracker.track(model, usage);

  const result = { analysis: content };
  await cache.set('authoranalysis', cacheKey, 'main', result);
  return result;
}

async function handleAuthorChoice({ paperId, authorName, action, candidate }) {
  // action: 'confirm' = この人で正しい / 'dismiss' = 違う (cache から外す)
  if (!paperId || !authorName) throw new Error('paperId / authorName が必要です');

  if (action === 'confirm' && candidate?.authorId) {
    await saveAuthorChoice(paperId, authorName, {
      authorId: candidate.authorId,
      savedAt: Date.now(),
      snapshot: {
        name: candidate.name,
        authorId: candidate.authorId,
        affiliations: candidate.affiliations,
        paperCount: candidate.paperCount,
        citationCount: candidate.citationCount,
        hIndex: candidate.hIndex,
        homepage: candidate.homepage,
        url: candidate.url,
      },
    });
    // 確定したので関連の author キャッシュをすべて invalidate (新しい cacheSubkey に切り替わる)
    return { success: true, action: 'confirmed' };
  }

  if (action === 'dismiss') {
    // 「違う」を選んだ場合は確定情報を削除して、再度候補を見せる
    const k = authorChoiceKey(paperId, authorName);
    await new Promise(resolve => chrome.storage.local.remove(k, resolve));
    return { success: true, action: 'dismissed' };
  }

  throw new Error(`未知の action: ${action}`);
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function handleChat({ messages, paperContext }) {
  const config = await loadConfig();
  const { client, model } = await buildClient(config, 'chat');

  // A11: 「位置づけ・関連論文」を一度でも開いたことのある論文は、その時取得した
  // Semantic Scholar データを chat の system prompt に注入する (キャッシュヒット時のみ)。
  // チャット中に「次に読むべき論文は?」「先行研究は?」等の質問に答えやすくなる。
  let relatedSummary = '';
  if (paperContext?.paperId) {
    try {
      const cachedRelated = await cache.get('related', paperContext.paperId, 'main');
      if (cachedRelated) {
        const parts = [];
        if (Array.isArray(cachedRelated.references) && cachedRelated.references.length > 0) {
          parts.push('引用先 (References):\n' + cachedRelated.references.slice(0, 6)
            .map(r => `- ${r.title} (${r.year ?? '?'}, ${r.authors?.[0]?.name ?? '?'} et al.)`).join('\n'));
        }
        if (Array.isArray(cachedRelated.citations) && cachedRelated.citations.length > 0) {
          parts.push('被引用 (Cited by):\n' + cachedRelated.citations.slice(0, 6)
            .map(r => `- ${r.title} (${r.year ?? '?'}, cited ${r.citationCount ?? '?'})`).join('\n'));
        }
        if (Array.isArray(cachedRelated.recommendations) && cachedRelated.recommendations.length > 0) {
          parts.push('推薦類似 (Recommendations):\n' + cachedRelated.recommendations.slice(0, 5)
            .map(r => `- ${r.title} (${r.year ?? '?'})`).join('\n'));
        }
        if (parts.length > 0) {
          relatedSummary = '\n\n【関連論文 (Semantic Scholar)】\n' + parts.join('\n');
        }
      }
    } catch {
      // キャッシュ無し or 取得失敗は無視 (関連論文無しで chat 続行)
    }
  }

  const systemContent =
    `あなたは学術論文の理解を支援するAIアシスタントです。\n` +
    `以下の論文に関する質問に、本文の文脈に沿って丁寧に回答してください。\n\n` +
    `【論文情報】\n` +
    `タイトル: ${paperContext.title ?? '不明'}\n` +
    `アブストラクト: ${(paperContext.abstract ?? '').slice(0, 2000)}\n` +
    `セクション: ${(paperContext.sections ?? []).map(s => s.title).join(', ')}` +
    relatedSummary;

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
