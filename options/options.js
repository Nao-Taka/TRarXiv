'use strict';

import { encryptText, decryptText } from '../utils/crypto.js';

const CONFIG_KEY      = 'trarxiv:config';
const STORAGE_TYPE_KEY = 'trarxiv:storageType';

// ─── Default config ───────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  tokenLimit: {
    enabled: true,
    perPaper: 150000,
  },
  ui: {
    collapseEnglish: false,
    translationFontSize: 'medium',
  },
  tasks: {
    translate: { provider: 'openai', model: 'gpt-4.1-mini' },
    explain:   { provider: 'openai', model: 'gpt-4.1' },
    chat:      { provider: 'openai', model: 'gpt-4.1' },
  },
  providers: {
    openai: {
      apiKey: '',
      models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o4-mini', 'o3'],
    },
    anthropic: {
      apiKey: '',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
    gemini: {
      apiKey: '',
      models: ['gemini-2.5-pro-preview-05-06', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    },
    openrouter: {
      apiKey: '',
      models: ['openai/gpt-4.1', 'openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4-5', 'google/gemini-2.0-flash-001', 'deepseek/deepseek-chat-v3-0324', 'meta-llama/llama-3.3-70b-instruct'],
    },
    local: {
      apiKey: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      serverUrls: ['http://localhost:11434/v1', 'http://localhost:1234/v1'],
      models: ['llama3.2', 'mistral', 'gemma2:9b', 'phi4-mini'],
    },
  },
  pricing: {},
};

const DEFAULT_PRICING = {
  // OpenAI
  'gpt-4.1':         { input: 2.00,  output: 8.00  },
  'gpt-4.1-mini':    { input: 0.40,  output: 1.60  },
  'gpt-4.1-nano':    { input: 0.10,  output: 0.40  },
  'gpt-4o':          { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':     { input: 0.15,  output: 0.60  },
  'o4-mini':         { input: 1.10,  output: 4.40  },
  'o3':              { input: 10.00, output: 40.00 },
  'gpt-3.5-turbo':   { input: 0.50,  output: 1.50  },
  // Anthropic
  'claude-opus-4-7': { input: 15.00, output: 75.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  // Gemini
  'gemini-2.5-pro-preview-05-06': { input: 1.25,  output: 10.00 },
  'gemini-2.0-flash':             { input: 0.10,  output: 0.40  },
  'gemini-2.0-flash-lite':        { input: 0.075, output: 0.30  },
  'gemini-1.5-pro':               { input: 1.25,  output: 5.00  },
  'gemini-1.5-flash':             { input: 0.075, output: 0.30  },
};

// モデル情報（コスト・説明）。タスク選択UIで参照
const MODEL_INFO = {
  // OpenAI
  'gpt-4.1':         { input: 2.00,  output: 8.00,  desc: '最新フラッグシップ' },
  'gpt-4.1-mini':    { input: 0.40,  output: 1.60,  desc: '高速・コスパ優秀' },
  'gpt-4.1-nano':    { input: 0.10,  output: 0.40,  desc: '超軽量・最安値' },
  'gpt-4o':          { input: 2.50,  output: 10.00, desc: 'マルチモーダル対応' },
  'gpt-4o-mini':     { input: 0.15,  output: 0.60,  desc: '軽量・安価' },
  'o4-mini':         { input: 1.10,  output: 4.40,  desc: '推論特化・高精度' },
  'o3':              { input: 10.00, output: 40.00, desc: '最高推論能力' },
  'gpt-3.5-turbo':   { input: 0.50,  output: 1.50,  desc: '旧世代・安価' },
  // Anthropic
  'claude-opus-4-7': { input: 15.00, output: 75.00, desc: '最高精度' },
  'claude-opus-4-6': { input: 15.00, output: 75.00, desc: '高精度' },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, desc: 'バランス型' },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, desc: '高速・安価' },
  // Gemini
  'gemini-2.5-pro-preview-05-06': { input: 1.25,  output: 10.00, desc: '最高精度・100万token対応' },
  'gemini-2.0-flash':             { input: 0.10,  output: 0.40,  desc: '高速・コスパ最良' },
  'gemini-2.0-flash-lite':        { input: 0.075, output: 0.30,  desc: '超軽量・最安値' },
  'gemini-1.5-pro':               { input: 1.25,  output: 5.00,  desc: '長文処理・コスパ良' },
  'gemini-1.5-flash':             { input: 0.075, output: 0.30,  desc: '高速・安価' },
};

const TASK_DEFS = [
  { key: 'translate', label: '翻訳',     icon: '🔤', hint: '軽量モデル推奨 (例: gpt-4.1-mini, gemini-2.0-flash)' },
  { key: 'explain',   label: '解説',     icon: '📖', hint: '高性能モデル推奨 (例: gpt-4.1, gemini-2.5-pro)' },
  { key: 'chat',      label: 'チャット', icon: '💬', hint: '高性能モデル推奨 (例: gpt-4.1, claude-opus-4-7)' },
];

const ALL_PROVIDERS    = ['openai', 'anthropic', 'gemini', 'openrouter', 'local'];
const ENCRYPTED_PROVIDERS = ['openai', 'anthropic', 'gemini', 'openrouter'];

let config = structuredClone(DEFAULT_CONFIG);
let pwResolve = null;
let pwReject  = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  config = await loadConfig();

  setupNavigation();
  setupStatSubtabs();
  setupProviderTabs();
  renderTaskAssignment();
  populateForms();
  populateTokenLimit();
  populateUIPrefs();
  await populateStorageType();
  setupEventListeners();
  setupPasswordModal();

  await refreshStats();
  await refreshCacheStats();
});

// ─── Stat subtabs ─────────────────────────────────────────────────────────────
function setupStatSubtabs() {
  document.querySelectorAll('.stat-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stat-subtab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.stat-subpage').forEach(p =>
        p.classList.toggle('active', p.id === `statpage-${btn.dataset.subtab}`)
      );
      if (btn.dataset.subtab === 'pricing') renderPricingTable();
    });
  });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('nav a[data-tab]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = link.dataset.tab;
      document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
      document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
      link.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      if (tab === 'stats')        refreshStats();
      if (tab === 'cache')        refreshCacheStats();
      if (tab === 'library')      renderLibrary();
      if (tab === 'site-configs') renderSiteConfigs();
    });
  });
}

// ─── Provider tabs ────────────────────────────────────────────────────────────
function setupProviderTabs() {
  document.querySelectorAll('.provider-tab').forEach(btn => {
    btn.addEventListener('click', () => switchProviderTab(btn.dataset.provider));
  });
}

function switchProviderTab(provider) {
  document.querySelectorAll('.provider-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.provider === provider)
  );
  document.querySelectorAll('.provider-section').forEach(s =>
    s.classList.toggle('active', s.id === `section-${provider}`)
  );
}

// ─── Task assignment ──────────────────────────────────────────────────────────
function renderTaskAssignment() {
  const container = document.getElementById('task-assignment');
  if (!container) return;

  container.innerHTML = TASK_DEFS.map(({ key, label, icon, hint }) => {
    const task = config.tasks?.[key] ?? {};
    return `
      <div class="task-row" data-task="${key}">
        <div class="task-row-header">
          <span class="task-icon">${icon}</span>
          <span class="task-label-text">${label}</span>
          <span class="task-hint">${hint}</span>
        </div>
        <div class="task-row-controls">
          <select class="task-provider-sel" data-task="${key}">
            ${providerOptions(task.provider)}
          </select>
          <select class="task-model-sel" data-task="${key}">
            ${modelOptions(task.provider, task.model)}
          </select>
        </div>
        <div class="task-model-info" id="task-info-${key}">${modelInfoHtml(task.provider, task.model)}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.task-provider-sel').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const taskKey  = e.target.dataset.task;
      const provider = e.target.value;
      const modelSel = container.querySelector(`.task-model-sel[data-task="${taskKey}"]`);
      modelSel.innerHTML = modelOptions(provider, null);
      config.tasks[taskKey] = { provider, model: modelSel.value };
      updateTaskInfo(taskKey, provider, modelSel.value);
    });
  });

  container.querySelectorAll('.task-model-sel').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const taskKey  = e.target.dataset.task;
      const provider = container.querySelector(`.task-provider-sel[data-task="${taskKey}"]`).value;
      config.tasks[taskKey].model = e.target.value;
      updateTaskInfo(taskKey, provider, e.target.value);
    });
  });
}

function updateTaskInfo(taskKey, provider, model) {
  const el = document.getElementById(`task-info-${taskKey}`);
  if (el) el.innerHTML = modelInfoHtml(provider, model);
}

function modelInfoHtml(provider, model) {
  if (!model || provider === 'local') return '';
  const bareModel = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  const info = MODEL_INFO[model] ?? MODEL_INFO[bareModel];
  if (!info) return '';
  return `<span class="info-cost">$${info.input} 入力 / $${info.output} 出力 <small>per 1M tokens</small></span>` +
         `<span class="info-sep">·</span>` +
         `<span class="info-desc">${info.desc}</span>`;
}

function providerOptions(selected) {
  const labels = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', openrouter: 'OpenRouter', local: 'ローカル' };
  return ALL_PROVIDERS
    .map(p => `<option value="${p}" ${p === selected ? 'selected' : ''}>${labels[p] ?? p}</option>`)
    .join('');
}

function modelOptions(provider, selectedModel) {
  const models = config.providers?.[provider]?.models ?? [];
  if (models.length === 0) return '<option value="">（モデルなし）</option>';
  return models
    .map(m => `<option value="${m}" ${m === selectedModel ? 'selected' : ''}>${m}</option>`)
    .join('');
}

function refreshTaskModelSelects(changedProvider) {
  document.querySelectorAll('.task-provider-sel').forEach(provSel => {
    if (provSel.value !== changedProvider) return;
    const taskKey  = provSel.dataset.task;
    const modelSel = document.querySelector(`.task-model-sel[data-task="${taskKey}"]`);
    if (!modelSel) return;
    const current = modelSel.value;
    modelSel.innerHTML = modelOptions(changedProvider, current);
  });
}

async function saveTaskAssignment() {
  document.querySelectorAll('.task-provider-sel').forEach(sel => {
    const taskKey  = sel.dataset.task;
    const modelSel = document.querySelector(`.task-model-sel[data-task="${taskKey}"]`);
    config.tasks[taskKey] = { provider: sel.value, model: modelSel?.value ?? '' };
  });
  await saveConfig(config);
  showSaved('task-saved');
}

// ─── Populate provider forms ──────────────────────────────────────────────────
function populateForms() {
  switchProviderTab('openai');
  ALL_PROVIDERS.forEach(p => populateProvider(p));
  renderPricingTable();
}

function populateProvider(provider) {
  const pc = config.providers[provider] ?? {};

  if (ENCRYPTED_PROVIDERS.includes(provider)) {
    const keyEl     = document.getElementById(`${provider}-apikey`);
    const toggleBtn = document.getElementById(`${provider}-toggle-pw`);
    const unlockBtn = document.getElementById(`${provider}-unlock`);
    const lockBadge = document.getElementById(`${provider}-key-lock`);

    if (pc.apiKeyEnc) {
      if (keyEl)     { keyEl.value = ''; keyEl.placeholder = '（暗号化済み）'; keyEl.readOnly = true; }
      if (toggleBtn) toggleBtn.style.display = 'none';
      if (unlockBtn) unlockBtn.style.display = '';
      if (lockBadge) lockBadge.style.display = '';
    } else {
      if (keyEl)     { keyEl.value = pc.apiKey ?? ''; keyEl.readOnly = false; }
      if (toggleBtn) toggleBtn.style.display = '';
      if (unlockBtn) unlockBtn.style.display = 'none';
      if (lockBadge) lockBadge.style.display = 'none';
    }
  }

  if (provider === 'local') {
    if (!pc.serverUrls || pc.serverUrls.length === 0) {
      pc.serverUrls = [...DEFAULT_CONFIG.providers.local.serverUrls];
    }
    if (!pc.baseUrl) pc.baseUrl = pc.serverUrls[0];
    renderServerUrlList();
    const akEl = document.getElementById('local-apikey');
    if (akEl) akEl.value = pc.apiKey ?? 'ollama';
  }

  renderModelList(provider, pc.models ?? []);
}

function renderModelList(provider, models) {
  const list = document.getElementById(`${provider}-model-list`);
  if (!list) return;
  list.innerHTML = models.map(m => `
    <div class="model-item" data-model="${m}">
      <span class="model-name">${m}</span>
      <button class="model-remove" data-provider="${provider}" data-model="${m}" title="削除">×</button>
    </div>
  `).join('');
  list.querySelectorAll('.model-remove').forEach(btn => {
    btn.addEventListener('click', () => removeModel(btn.dataset.provider, btn.dataset.model));
  });
}

function addModel(provider) {
  const input = document.getElementById(`${provider}-custom-model`);
  const model = input.value.trim();
  if (!model) return;
  const pc = config.providers[provider];
  if (!pc) return;
  if (!pc.models.includes(model)) pc.models.push(model);
  input.value = '';
  renderModelList(provider, pc.models);
  refreshTaskModelSelects(provider);
}

function removeModel(provider, model) {
  const pc = config.providers[provider];
  if (!pc) return;
  pc.models = pc.models.filter(m => m !== model);
  renderModelList(provider, pc.models);
  refreshTaskModelSelects(provider);
}

// ─── Local server URL list ────────────────────────────────────────────────────
function renderServerUrlList() {
  const pc   = config.providers.local ?? {};
  const urls = pc.serverUrls ?? [];
  const sel  = pc.baseUrl;
  const list = document.getElementById('local-server-url-list');
  if (!list) return;

  list.innerHTML = urls.map(url => `
    <div class="server-url-item${url === sel ? ' selected' : ''}" data-url="${escHtml(url)}">
      <span class="url-dot">${url === sel ? '●' : '○'}</span>
      <code class="url-text">${escHtml(url)}</code>
      <button class="url-remove" data-url="${escHtml(url)}" title="削除">×</button>
    </div>
  `).join('');

  list.querySelectorAll('.server-url-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('url-remove')) return;
      config.providers.local.baseUrl = item.dataset.url;
      renderServerUrlList();
    });
  });

  list.querySelectorAll('.url-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = btn.dataset.url;
      const pc  = config.providers.local;
      pc.serverUrls = (pc.serverUrls ?? []).filter(u => u !== url);
      if (pc.baseUrl === url) pc.baseUrl = pc.serverUrls[0] ?? '';
      renderServerUrlList();
    });
  });
}

function addServerUrl() {
  const input = document.getElementById('local-new-url');
  const url   = input.value.trim().replace(/\/$/, '');
  if (!url) return;
  const pc = config.providers.local;
  if (!pc.serverUrls) pc.serverUrls = [];
  if (!pc.serverUrls.includes(url)) pc.serverUrls.push(url);
  if (!pc.baseUrl) pc.baseUrl = url;
  input.value = '';
  renderServerUrlList();
}

// ─── Event listeners ──────────────────────────────────────────────────────────
function setupEventListeners() {
  // Password toggles
  document.querySelectorAll('[data-toggle-pw]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.togglePw);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? '表示' : '隠す';
    });
  });

  // Unlock encrypted keys
  ENCRYPTED_PROVIDERS.forEach(p => {
    document.getElementById(`${p}-unlock`)?.addEventListener('click', () => unlockProvider(p));
  });

  // Add model
  ALL_PROVIDERS.forEach(p => {
    document.getElementById(`${p}-add-model`)?.addEventListener('click', () => addModel(p));
    document.getElementById(`${p}-custom-model`)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addModel(p);
    });
  });

  // Save provider
  ALL_PROVIDERS.forEach(p => {
    document.getElementById(`${p}-save`)?.addEventListener('click', () => saveProvider(p));
  });

  // Local: server URL add
  document.getElementById('local-add-url')?.addEventListener('click', addServerUrl);
  document.getElementById('local-new-url')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addServerUrl();
  });

  // Task save
  document.getElementById('task-save')?.addEventListener('click', saveTaskAssignment);

  // Token limit
  document.getElementById('token-limit-enabled')?.addEventListener('change', (e) => {
    document.getElementById('token-limit-row').style.display = e.target.checked ? '' : 'none';
  });
  document.getElementById('token-limit-save')?.addEventListener('click', saveTokenLimit);

  // Storage type
  document.getElementById('storage-type-save')?.addEventListener('click', saveStorageType);

  // Lock all
  document.getElementById('lock-all-keys')?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'lockKeys' });
    showSaved('lock-all-saved');
  });

  // Local test
  document.getElementById('local-test')?.addEventListener('click', testLocalConnection);

  // Stats
  document.getElementById('clear-stats')?.addEventListener('click', clearStats);

  // Cache
  document.getElementById('refresh-cache')?.addEventListener('click', refreshCacheStats);
  document.getElementById('clear-cache')?.addEventListener('click', clearCache);

  // Pricing
  document.getElementById('pricing-add')?.addEventListener('click', addPricingRow);
  document.getElementById('pricing-save')?.addEventListener('click', savePricing);

  // UI prefs
  document.getElementById('ui-collapse-english-save')?.addEventListener('click', saveUIPrefs);

  // Library tab
  document.getElementById('library-refresh')?.addEventListener('click', renderLibrary);
  document.getElementById('library-clear-all')?.addEventListener('click', clearLibrary);

  // Site configs tab
  document.getElementById('site-configs-refresh')?.addEventListener('click', renderSiteConfigs);
}

// ─── Save provider ────────────────────────────────────────────────────────────
async function saveProvider(provider) {
  const pc = config.providers[provider] ?? {};

  if (ENCRYPTED_PROVIDERS.includes(provider)) {
    const keyEl      = document.getElementById(`${provider}-apikey`);
    const inputValue = keyEl?.value?.trim() ?? '';

    if (inputValue) {
      try {
        const password = await promptPassword(
          'APIキーを暗号化して保存',
          `${provider} のAPIキーを暗号化します。\nパスワード（英数字）を設定してください。`
        );
        pc.apiKeyEnc = await encryptText(password, inputValue);
        delete pc.apiKey;
        if (keyEl) { keyEl.value = ''; keyEl.placeholder = '（暗号化済み）'; keyEl.readOnly = true; }
        document.getElementById(`${provider}-toggle-pw`).style.display = 'none';
        document.getElementById(`${provider}-unlock`).style.display = '';
        document.getElementById(`${provider}-key-lock`).style.display = '';
      } catch (err) {
        if (err.message !== 'cancelled') throw err;
        return;
      }
    }
  }

  if (provider === 'local') {
    // baseUrl and serverUrls are managed in-memory via the URL list UI
    const akEl = document.getElementById('local-apikey');
    if (akEl) pc.apiKey = akEl.value.trim() || 'ollama';
  }

  config.providers[provider] = pc;
  await saveConfig(config);
  showSaved(`${provider}-saved`);
}

// ─── Unlock encrypted key for editing ─────────────────────────────────────────
async function unlockProvider(provider) {
  const pc = config.providers[provider] ?? {};
  if (!pc.apiKeyEnc) return;
  try {
    const password  = await promptPassword(
      'APIキーを解除して編集',
      `${provider} のAPIキーを復号します。\n保存時に設定したパスワードを入力してください。`
    );
    const decrypted = await decryptText(password, pc.apiKeyEnc);
    const keyEl     = document.getElementById(`${provider}-apikey`);
    const toggleBtn = document.getElementById(`${provider}-toggle-pw`);
    const unlockBtn = document.getElementById(`${provider}-unlock`);
    const lockBadge = document.getElementById(`${provider}-key-lock`);
    if (keyEl)     { keyEl.value = decrypted; keyEl.readOnly = false; keyEl.type = 'password'; }
    if (toggleBtn) toggleBtn.style.display = '';
    if (unlockBtn) unlockBtn.style.display = 'none';
    if (lockBadge) lockBadge.style.display = 'none';
    keyEl?.focus();
  } catch (err) {
    if (err.message === 'cancelled') return;
    showToast('パスワードが違います');
  }
}

// ─── Password modal ───────────────────────────────────────────────────────────
function setupPasswordModal() {
  document.getElementById('pw-modal-ok')?.addEventListener('click', submitPassword);
  document.getElementById('pw-modal-cancel')?.addEventListener('click', cancelPassword);
  document.getElementById('pw-modal-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  submitPassword();
    if (e.key === 'Escape') cancelPassword();
  });
}

function submitPassword() {
  const pw = document.getElementById('pw-modal-input').value;
  if (!pw) { showToast('パスワードを入力してください'); return; }
  document.getElementById('pw-modal').style.display = 'none';
  if (pwResolve) { const r = pwResolve; pwResolve = pwReject = null; r(pw); }
}

function cancelPassword() {
  document.getElementById('pw-modal').style.display = 'none';
  if (pwReject) { const r = pwReject; pwResolve = pwReject = null; r(new Error('cancelled')); }
}

function showToast(msg) {
  document.querySelector('.options-toast')?.remove();
  const el = document.createElement('div');
  el.className = 'options-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, 2500);
}

function promptPassword(title, desc) {
  document.getElementById('pw-modal-title').textContent = title;
  document.getElementById('pw-modal-desc').textContent  = desc;
  document.getElementById('pw-modal-input').value = '';
  document.getElementById('pw-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('pw-modal-input').focus(), 50);
  return new Promise((resolve, reject) => { pwResolve = resolve; pwReject = reject; });
}

// ─── Storage type ─────────────────────────────────────────────────────────────
async function populateStorageType() {
  const current = await getStorageType();
  const sel = document.getElementById('storage-type');
  if (sel) sel.value = current;
}

async function getStorageType() {
  return new Promise(resolve =>
    chrome.storage.local.get(STORAGE_TYPE_KEY, r => resolve(r[STORAGE_TYPE_KEY] ?? 'local'))
  );
}

async function saveStorageType() {
  const newType = document.getElementById('storage-type')?.value ?? 'local';
  const oldType = await getStorageType();
  if (newType !== oldType) {
    const oldArea = oldType === 'sync' ? chrome.storage.sync : chrome.storage.local;
    const newArea = newType === 'sync' ? chrome.storage.sync : chrome.storage.local;
    const existing = await new Promise(resolve =>
      oldArea.get(CONFIG_KEY, r => resolve(r[CONFIG_KEY] ?? null))
    );
    if (existing) {
      await new Promise(resolve => newArea.set({ [CONFIG_KEY]: existing }, resolve));
      await new Promise(resolve => oldArea.remove(CONFIG_KEY, resolve));
    }
  }
  await new Promise(resolve =>
    chrome.storage.local.set({ [STORAGE_TYPE_KEY]: newType }, resolve)
  );
  showSaved('storage-type-saved');
}

// ─── Local connection test ────────────────────────────────────────────────────
async function testLocalConnection() {
  const btn     = document.getElementById('local-test');
  const baseUrl = (config.providers.local.baseUrl ?? '').replace(/\/$/, '');
  const apiKey  = document.getElementById('local-apikey')?.value ?? 'ollama';

  btn.disabled = true;
  btn.textContent = 'テスト中…';

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data   = await res.json();
    const models = data.data?.map(m => m.id) ?? [];
    if (models.length > 0) {
      const pc = config.providers.local;
      models.forEach(m => { if (!pc.models.includes(m)) pc.models.push(m); });
      renderModelList('local', pc.models);
      refreshTaskModelSelects('local');
      btn.textContent = `✓ 接続成功 (${models.length}モデル)`;
    } else {
      btn.textContent = '✓ 接続成功';
    }
  } catch (err) {
    btn.textContent = `✗ 失敗: ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '接続テスト'; }, 3000);
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function refreshStats() {
  const result = await chrome.runtime.sendMessage({ action: 'getTokenStats' });
  const tbody  = document.getElementById('stats-tbody');
  if (!tbody) return;
  if (!result || Object.keys(result).length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:20px">データなし</td></tr>';
    return;
  }
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing ?? {}) };
  let totalCost = 0;
  const rows = Object.entries(result).map(([model, stats]) => {
    const p    = pricing[model] ?? { input: 0, output: 0 };
    const cost = (stats.promptTokens / 1e6) * p.input + (stats.completionTokens / 1e6) * p.output;
    totalCost += cost;
    return `<tr>
      <td class="col-model">${escHtml(model)}</td>
      <td>${stats.promptTokens.toLocaleString()}</td>
      <td>${stats.completionTokens.toLocaleString()}</td>
      <td>${stats.totalTokens.toLocaleString()}</td>
      <td class="cost-cell">$${cost.toFixed(4)}</td>
    </tr>`;
  });
  rows.push(`<tr style="font-weight:700;background:#f8fafc">
    <td>合計</td><td colspan="3"></td><td class="cost-cell">$${totalCost.toFixed(4)}</td>
  </tr>`);
  tbody.innerHTML = rows.join('');
}

async function clearStats() {
  if (!confirm('トークン使用量をリセットしますか？')) return;
  await chrome.storage.local.remove('trarxiv:tokenStats');
  await refreshStats();
}

// ─── Cache ────────────────────────────────────────────────────────────────────
async function refreshCacheStats() {
  const result = await chrome.runtime.sendMessage({ action: 'getCacheStats' });
  document.getElementById('cache-count').textContent = result?.count ?? '—';
  const size = result?.sizeBytes ?? 0;
  document.getElementById('cache-size').textContent =
    size > 1024*1024 ? `${(size/1024/1024).toFixed(1)}MB`
    : size > 1024    ? `${(size/1024).toFixed(1)}KB`
    : `${size}B`;
}

async function clearCache() {
  if (!confirm('翻訳キャッシュをすべて削除しますか？')) return;
  await chrome.runtime.sendMessage({ action: 'clearCache' });
  await refreshCacheStats();
}

// ─── Pricing ──────────────────────────────────────────────────────────────────
function allRegisteredModels() {
  const seen = new Set();
  ALL_PROVIDERS.forEach(p => {
    (config.providers[p]?.models ?? []).forEach(m => seen.add(m));
  });
  // also include any models already in DEFAULT_PRICING but not in any provider list
  Object.keys(DEFAULT_PRICING).forEach(m => seen.add(m));
  return [...seen].sort();
}

function renderPricingTable() {
  const container = document.getElementById('pricing-list');
  if (!container) return;
  container.innerHTML = '';
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing ?? {}) };
  Object.entries(pricing).forEach(([model, p]) => {
    container.appendChild(makePricingRow(model, p.input, p.output));
  });
}

function makePricingRow(model = '', input = '', output = '') {
  const row = document.createElement('div');
  row.className = 'btn-row';
  row.style.cssText = 'margin-bottom:6px;gap:6px';
  row.innerHTML = `
    <input type="text"   value="${escHtml(model)}"  placeholder="モデル名"   style="flex:2;min-width:0;font-family:monospace;font-size:12px">
    <input type="number" value="${input}"  placeholder="入力 $/1M" step="0.001" style="flex:1;min-width:0">
    <input type="number" value="${output}" placeholder="出力 $/1M" step="0.001" style="flex:1;min-width:0">
    <button class="btn btn-secondary btn-sm" data-remove>削除</button>
  `;
  row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
  return row;
}

function addPricingRow() {
  document.getElementById('pricing-list')?.appendChild(makePricingRow());
}

async function savePricing() {
  const pricing = {};
  document.querySelectorAll('#pricing-list .btn-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    const model  = inputs[0]?.value?.trim();
    const input  = parseFloat(inputs[1]?.value);
    const output = parseFloat(inputs[2]?.value);
    if (model && !isNaN(input) && !isNaN(output)) pricing[model] = { input, output };
  });
  config.pricing = pricing;
  await saveConfig(config);
  showSaved('pricing-saved');
}

// ─── Token limit ─────────────────────────────────────────────────────────────
function populateTokenLimit() {
  const tl        = config.tokenLimit ?? DEFAULT_CONFIG.tokenLimit;
  const enabledEl = document.getElementById('token-limit-enabled');
  const valueEl   = document.getElementById('token-limit-value');
  const rowEl     = document.getElementById('token-limit-row');
  if (enabledEl) enabledEl.checked = tl.enabled ?? true;
  if (valueEl)   valueEl.value     = tl.perPaper ?? 150000;
  if (rowEl)     rowEl.style.display = (tl.enabled ?? true) ? '' : 'none';
}

async function saveTokenLimit() {
  const enabled  = document.getElementById('token-limit-enabled')?.checked ?? true;
  const perPaper = parseInt(document.getElementById('token-limit-value')?.value, 10);
  config.tokenLimit = { enabled, perPaper: isNaN(perPaper) ? 150000 : perPaper };
  await saveConfig(config);
  showSaved('token-limit-saved');
}

// ─── UI preferences ──────────────────────────────────────────────────────────
function populateUIPrefs() {
  const collapse = document.getElementById('ui-collapse-english');
  if (collapse) collapse.checked = config.ui?.collapseEnglish ?? false;

  const size = document.getElementById('ui-font-size');
  if (size) size.value = config.ui?.translationFontSize ?? 'medium';
}

async function saveUIPrefs() {
  config.ui = config.ui ?? {};
  config.ui.collapseEnglish     = document.getElementById('ui-collapse-english')?.checked ?? false;
  config.ui.translationFontSize = document.getElementById('ui-font-size')?.value ?? 'medium';
  await saveConfig(config);
  showSaved('ui-prefs-saved');
}

// ─── Library ─────────────────────────────────────────────────────────────────
async function renderLibrary() {
  const container = document.getElementById('library-list');
  if (!container) return;
  container.innerHTML = '<div style="color:#94a3b8;padding:16px 0">読み込み中…</div>';

  const papers = await chrome.runtime.sendMessage({ action: 'getLibrary' });
  if (!papers || papers.length === 0) {
    container.innerHTML = '<div style="color:#94a3b8;padding:16px 0">論文はまだありません。ArXivの論文ページを開くと自動的に登録されます。</div>';
    return;
  }

  container.innerHTML = papers.map(p => `
    <div class="library-item" data-id="${escHtml(p.id)}">
      <div class="library-item-header">
        <a class="library-title" href="${escHtml(p.url)}" target="_blank">${escHtml(p.title || p.id)}</a>
        <span class="library-meta">${new Date(p.lastVisitedAt).toLocaleDateString('ja-JP')} • ${p.visitCount}回</span>
      </div>
      ${p.tags?.length ? `<div class="library-tags">${p.tags.map(t => `<span class="library-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
      ${p.summary ? `<div class="library-summary">${escHtml(p.summary)}</div>` : ''}
      <div class="library-actions">
        <input type="text" class="library-tag-input" placeholder="タグを追加 (カンマ区切り)" value="${escHtml((p.tags ?? []).join(', '))}">
        <button class="btn btn-secondary btn-sm library-tag-save" data-id="${escHtml(p.id)}">タグ保存</button>
        <button class="btn btn-danger btn-sm library-delete" data-id="${escHtml(p.id)}">削除</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.library-tag-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row   = btn.closest('.library-item');
      const id    = btn.dataset.id;
      const tags  = row.querySelector('.library-tag-input').value.split(',').map(t => t.trim()).filter(Boolean);
      await chrome.runtime.sendMessage({ action: 'setPaperTags', id, tags });
      renderLibrary();
    });
  });

  container.querySelectorAll('.library-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('この論文をライブラリから削除しますか？')) return;
      await chrome.runtime.sendMessage({ action: 'deletePaper', id: btn.dataset.id });
      renderLibrary();
    });
  });
}

async function clearLibrary() {
  if (!confirm('ライブラリをすべてクリアしますか？')) return;
  const papers = await chrome.runtime.sendMessage({ action: 'getLibrary' });
  for (const p of (papers ?? [])) {
    await chrome.runtime.sendMessage({ action: 'deletePaper', id: p.id });
  }
  renderLibrary();
}

// ─── Site configs ─────────────────────────────────────────────────────────────
async function renderSiteConfigs() {
  const container = document.getElementById('site-configs-list');
  if (!container) return;
  container.innerHTML = '<div style="color:#94a3b8;padding:16px 0">読み込み中…</div>';

  const configs = await chrome.runtime.sendMessage({ action: 'getAllSiteConfigs' });
  if (!configs || configs.length === 0) {
    container.innerHTML = '<div style="color:#94a3b8;padding:16px 0">登録済みサイトはありません。ポップアップから未対応サイトを解析できます。</div>';
    return;
  }

  container.innerHTML = configs.map(c => `
    <div class="library-item">
      <div class="library-item-header">
        <span class="library-title">${escHtml(c.hostname)}</span>
        <span class="library-meta">${c.savedAt ? new Date(c.savedAt).toLocaleDateString('ja-JP') : ''} • 信頼度: ${c.confidence ?? '?'}</span>
      </div>
      <div style="font-size:11.5px;color:#64748b;margin:4px 0">
        セクション: <code>${escHtml(c.sectionSel ?? '')}</code> 　段落: <code>${escHtml(c.paragraphSel ?? '')}</code>
      </div>
      <div class="library-actions">
        <button class="btn btn-danger btn-sm" data-hostname="${escHtml(c.hostname)}">削除</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-hostname]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`${btn.dataset.hostname} のサイト設定を削除しますか？`)) return;
      await chrome.runtime.sendMessage({ action: 'deleteSiteConfig', hostname: btn.dataset.hostname });
      renderSiteConfigs();
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showSaved(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function getStorageArea() {
  return new Promise(resolve =>
    chrome.storage.local.get(STORAGE_TYPE_KEY, r =>
      resolve(r[STORAGE_TYPE_KEY] === 'sync' ? chrome.storage.sync : chrome.storage.local)
    )
  );
}

async function loadConfig() {
  const area = await getStorageArea();
  return new Promise(resolve => {
    area.get(CONFIG_KEY, (r) => {
      const saved  = r[CONFIG_KEY] ?? {};
      const merged = structuredClone(DEFAULT_CONFIG);

      if (saved.tasks) {
        Object.keys(merged.tasks).forEach(t => {
          if (saved.tasks[t]) Object.assign(merged.tasks[t], saved.tasks[t]);
        });
      }
      if (!saved.tasks && saved.activeProvider) {
        const prov  = saved.activeProvider;
        const model = saved.providers?.[prov]?.model ?? '';
        merged.tasks.translate = { provider: prov, model };
        merged.tasks.explain   = { provider: prov, model };
        merged.tasks.chat      = { provider: prov, model };
      }
      if (saved.providers) {
        Object.keys(merged.providers).forEach(p => {
          if (saved.providers[p]) Object.assign(merged.providers[p], saved.providers[p]);
        });
      }
      if (saved.pricing)    merged.pricing    = saved.pricing;
      if (saved.tokenLimit) merged.tokenLimit = { ...merged.tokenLimit, ...saved.tokenLimit };
      if (saved.ui)         merged.ui         = { ...merged.ui, ...saved.ui };
      resolve(merged);
    });
  });
}

async function saveConfig(cfg) {
  const area = await getStorageArea();
  return new Promise(resolve => area.set({ [CONFIG_KEY]: cfg }, resolve));
}
