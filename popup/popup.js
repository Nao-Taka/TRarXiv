'use strict';

let paperContext = null;
let conversationHistory = [];

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadModelName();

  document.getElementById('btn-options').addEventListener('click', openOptions);
  document.getElementById('link-options').addEventListener('click', openOptions);
  document.getElementById('btn-clear').addEventListener('click', clearConversation);
  document.getElementById('send-btn').addEventListener('click', sendChatMessage);
  document.getElementById('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  const ta = document.getElementById('input');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
  });

  await detectPage();
});

async function loadModelName() {
  const config = await getConfig();
  const chat = config.tasks?.chat;
  document.getElementById('model-name').textContent =
    (chat?.provider && chat?.model) ? `${chat.provider} / ${chat.model}` : '未設定';
}

// ─── Page detection ────────────────────────────────────────────────────────────
async function detectPage() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    showNoPaper();
    return;
  }

  if (!tab?.id || !tab?.url) {
    showNoPaper();
    return;
  }

  if (/arxiv\.org\/html\//i.test(tab.url)) {
    await initChatMode(tab);
  } else {
    await initSiteMode(tab);
  }
}

function showNoPaper() {
  document.getElementById('no-paper').style.display = 'flex';
}

// ─── Chat mode (ArXiv pages) ───────────────────────────────────────────────────
async function initChatMode(tab) {
  try {
    paperContext = await chrome.tabs.sendMessage(tab.id, { action: 'getPaperContext' });
    if (!paperContext) throw new Error('no context');

    document.getElementById('paper-title').textContent = truncate(paperContext.title, 40);
    document.getElementById('btn-clear').style.display = '';
    document.getElementById('messages').style.display = 'flex';
    document.getElementById('input-area').style.display = 'flex';
    document.getElementById('input').disabled = false;
    document.getElementById('send-btn').disabled = false;
    document.getElementById('input').focus();

    appendMessage('assistant', `論文「${truncate(paperContext.title, 60)}」について何でもご質問ください。`);
  } catch {
    showNoPaper();
  }
}

// ─── Site mode (non-ArXiv pages) ──────────────────────────────────────────────
let currentTab = null;

async function initSiteMode(tab) {
  currentTab = tab;
  refinementHistory = []; // Reset per-session
  const hostname = new URL(tab.url).hostname;

  document.getElementById('site-section').style.display = 'flex';
  document.getElementById('site-hostname-label').textContent = hostname;
  document.getElementById('paper-title').textContent = hostname;

  // Check existing config
  const config = await new Promise(resolve =>
    chrome.storage.sync.get('trarxiv:sc:' + hostname, r =>
      resolve(r['trarxiv:sc:' + hostname] ?? null)
    )
  );

  const statusEl   = document.getElementById('site-config-status');
  const analyzeBtn = document.getElementById('btn-analyze-site');
  const reanalyzeBtn = document.getElementById('btn-reanalyze-site');

  if (config) {
    statusEl.innerHTML =
      `<span class="site-status-badge site-status-ok">✓ 設定済み</span>` +
      `<span class="site-status-conf">信頼度: ${config.confidence ?? '?'}</span>`;
    analyzeBtn.style.display = 'none';
    reanalyzeBtn.style.display = '';
    showSiteConfig(config);
  } else {
    statusEl.innerHTML = '<span class="site-status-badge site-status-none">未解析</span>';
  }

  analyzeBtn.addEventListener('click', () => runSiteAnalysis(tab, hostname));
  reanalyzeBtn.addEventListener('click', () => runSiteAnalysis(tab, hostname));

  if (config) {
    await showPostConfigUI(hostname, config);
  }
}

function showSiteConfig(config) {
  const resultEl = document.getElementById('site-result');
  const sels = [
    ['セクション', config.sectionSel],
    ['見出し',     config.headingSel],
    ['段落',       config.paragraphSel],
    ['タイトル',   config.titleSel],
    ['概要',       config.abstractSel],
  ].filter(([, v]) => v);

  if (sels.length === 0) { resultEl.style.display = 'none'; return; }

  resultEl.innerHTML = sels.map(([label, sel]) =>
    `<div class="site-sel-row"><span class="site-sel-label">${label}</span><code class="site-sel-val">${sel}</code></div>`
  ).join('');
  if (config.note) {
    resultEl.innerHTML += `<div class="site-note-text">${config.note}</div>`;
  }
  resultEl.style.display = 'block';
}

async function runSiteAnalysis(tab, hostname) {
  const analyzeBtn   = document.getElementById('btn-analyze-site');
  const reanalyzeBtn = document.getElementById('btn-reanalyze-site');
  const progressEl   = document.getElementById('site-progress');
  const progressMsg  = document.getElementById('site-progress-msg');
  const resultEl     = document.getElementById('site-result');
  const statusEl     = document.getElementById('site-config-status');

  analyzeBtn.disabled   = true;
  reanalyzeBtn.disabled = true;
  progressEl.style.display = 'flex';
  resultEl.style.display   = 'none';
  progressMsg.textContent  = 'DOM情報を収集中...';

  try {
    // Collect DOM summary from the page
    const [{ result: domData }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectDomSummary,
    });

    progressMsg.textContent = 'AIで解析中...';

    const domSummary = JSON.stringify(domData, null, 2);
    const res = await chrome.runtime.sendMessage({
      action: 'analyzeSite',
      url: tab.url,
      domSummary,
    });

    if (res.error === 'NEEDS_PASSWORD') {
      progressEl.style.display = 'none';
      try {
        await showPopupUnlockModal();
        progressEl.style.display = 'flex';
        progressMsg.textContent = 'AIで解析中...';
        const res2 = await chrome.runtime.sendMessage({
          action: 'analyzeSite', url: tab.url, domSummary,
        });
        if (res2.error) throw new Error(res2.error);
        await onAnalysisSuccess(res2.config, statusEl, resultEl, hostname);
      } catch (e) {
        if (e.message !== 'cancelled') throw e;
        return;
      }
    } else if (res.error) {
      throw new Error(res.error);
    } else {
      await onAnalysisSuccess(res.config, statusEl, resultEl, hostname);
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="site-status-badge site-status-err">⚠ エラー: ${err.message.slice(0, 60)}</span>`;
  } finally {
    progressEl.style.display = 'none';
    analyzeBtn.disabled   = false;
    reanalyzeBtn.disabled = false;

    // Show correct buttons
    document.getElementById('btn-analyze-site').style.display = 'none';
    document.getElementById('btn-reanalyze-site').style.display = '';
  }
}

async function onAnalysisSuccess(config, statusEl, resultEl, hostname) {
  statusEl.innerHTML =
    `<span class="site-status-badge site-status-ok">✓ 解析完了</span>` +
    `<span class="site-status-conf">信頼度: ${config?.confidence ?? '?'}</span>`;
  if (config) {
    showSiteConfig(config);
    await showPostConfigUI(hostname, config);
  }
}

// ─── Post-analysis UI: permission banner + refinement chat ────────────────────
async function showPostConfigUI(hostname, config) {
  // Check host permission
  const hasPerm = await chrome.permissions.contains({
    origins: [`*://${hostname}/*`],
  }).catch(() => false);

  const permBanner   = document.getElementById('site-perm-banner');
  const refineSection = document.getElementById('site-refine-section');
  const grantBtn     = document.getElementById('btn-grant-perm');
  const refineBtn    = document.getElementById('btn-refine-site');

  if (!hasPerm) {
    permBanner.style.display = 'flex';
    grantBtn.onclick = async () => {
      try {
        const granted = await chrome.permissions.request({
          origins: [`*://${hostname}/*`],
        });
        if (granted) {
          permBanner.style.display = 'none';
          // Re-register content script now that we have permission
          await chrome.runtime.sendMessage({ action: 'registerContentScript', hostname });
        }
      } catch (e) {
        console.error('Permission request failed:', e);
      }
    };
  } else {
    permBanner.style.display = 'none';
  }

  refineSection.style.display = 'block';
  refineBtn.onclick = () => runRefinement(hostname, config);
}

let refinementHistory = []; // [{role, content}]

async function runRefinement(hostname, currentConfig) {
  const input   = document.getElementById('site-refine-input');
  const histEl  = document.getElementById('site-refine-history');
  const refineBtn = document.getElementById('btn-refine-site');
  const statusEl = document.getElementById('site-config-status');
  const feedback = input.value.trim();
  if (!feedback) return;

  // Append user message to history display
  appendRefineMsg(histEl, 'user', feedback);
  input.value = '';
  refineBtn.disabled = true;
  refinementHistory.push({ role: 'user', content: feedback });

  const thinkingEl = appendRefineMsg(histEl, 'assistant', '...');

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'refineSiteConfig',
      hostname,
      currentConfig,
      history: refinementHistory,
    });

    thinkingEl.remove();

    if (res.error === 'NEEDS_PASSWORD') {
      try {
        await showPopupUnlockModal();
        const res2 = await chrome.runtime.sendMessage({
          action: 'refineSiteConfig', hostname, currentConfig, history: refinementHistory,
        });
        if (res2.error) throw new Error(res2.error);
        handleRefineSuccess(res2.config, hostname, histEl, statusEl, refinementHistory);
      } catch (e) {
        if (e.message !== 'cancelled') appendRefineMsg(histEl, 'error', e.message);
      }
      return;
    }

    if (res.error) throw new Error(res.error);
    handleRefineSuccess(res.config, hostname, histEl, statusEl, refinementHistory);
  } catch (err) {
    thinkingEl.remove();
    appendRefineMsg(histEl, 'error', err.message);
  } finally {
    refineBtn.disabled = false;
  }
}

function handleRefineSuccess(config, hostname, histEl, statusEl, history) {
  const msg = `セレクターを更新しました（信頼度: ${config.confidence ?? '?'}）`;
  appendRefineMsg(histEl, 'assistant', msg);
  history.push({ role: 'assistant', content: msg });
  showSiteConfig(config);
  statusEl.innerHTML =
    `<span class="site-status-badge site-status-ok">✓ 修正済み</span>` +
    `<span class="site-status-conf">信頼度: ${config.confidence ?? '?'}</span>`;
  // Update the refine button's closure config reference
  document.getElementById('btn-refine-site').onclick = () => runRefinement(hostname, config);
}

function appendRefineMsg(container, role, text) {
  const el = document.createElement('div');
  el.className = `refine-msg refine-msg-${role}`;
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

// DOM summary collector — injected into the target page
function collectDomSummary() {
  const headings = [...document.querySelectorAll('h1,h2,h3')].slice(0, 12).map(h => ({
    tag: h.tagName, cls: h.className.trim().slice(0, 60), text: h.textContent.trim().slice(0, 80),
  }));

  const paragraphs = [...document.querySelectorAll('p, [class*="para"], [class*="abstract"]')]
    .filter(el => el.textContent.trim().length > 80)
    .slice(0, 10)
    .map(el => ({
      tag: el.tagName,
      cls: el.className.trim().slice(0, 60),
      parentTag: el.parentElement?.tagName,
      parentCls: el.parentElement?.className?.trim()?.slice(0, 60),
      text: el.textContent.trim().slice(0, 150),
    }));

  const sections = [...document.querySelectorAll(
    'section, article, [class*="section"], [class*="chapter"], [class*="content"]'
  )].slice(0, 8).map(el => ({
    tag: el.tagName,
    cls: el.className.trim().slice(0, 60),
    heading: el.querySelector('h1,h2,h3,h4')?.textContent?.trim()?.slice(0, 50),
  }));

  return {
    url: location.href,
    title: document.title.slice(0, 100),
    h1: document.querySelector('h1')?.textContent?.trim()?.slice(0, 100),
    headings,
    paragraphs,
    sections,
  };
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function sendChatMessage() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  input.disabled = true;

  appendMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });

  const typingEl = appendTyping();

  const chatMsg = {
    action: 'chat',
    messages: conversationHistory,
    paperContext: {
      title:    paperContext?.title    ?? '',
      abstract: paperContext?.abstract ?? '',
      sections: paperContext?.sections ?? [],
    },
  };

  try {
    let result = await chrome.runtime.sendMessage(chatMsg);

    if (result.error === 'NEEDS_PASSWORD') {
      typingEl.remove();
      try {
        await showPopupUnlockModal();
        const typingEl2 = appendTyping();
        result = await chrome.runtime.sendMessage(chatMsg);
        typingEl2.remove();
      } catch {
        appendMessage('error', 'APIキーの解除がキャンセルされました');
        return;
      }
    } else {
      typingEl.remove();
    }

    if (result.error) throw new Error(result.error);

    appendMessage('assistant', result.content);
    conversationHistory.push({ role: 'assistant', content: result.content });
  } catch (err) {
    typingEl.remove();
    appendMessage('error', `エラー: ${err.message}`);
  } finally {
    input.disabled = false;
    document.getElementById('send-btn').disabled = false;
    input.focus();
  }
}

// ─── Popup unlock modal ───────────────────────────────────────────────────────
function showPopupToast(msg) {
  document.querySelector('.popup-toast')?.remove();
  const el = document.createElement('div');
  el.className = 'popup-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, 2500);
}

function showPopupUnlockModal() {
  return new Promise((resolve, reject) => {
    const overlay   = document.getElementById('unlock-overlay');
    const pwInput   = document.getElementById('unlock-pw');
    const okBtn     = document.getElementById('unlock-ok');
    const cancelBtn = document.getElementById('unlock-cancel');

    pwInput.value = '';
    okBtn.disabled = false;
    okBtn.textContent = '解除';
    overlay.style.display = 'flex';
    setTimeout(() => pwInput.focus(), 50);

    async function tryUnlock() {
      const password = pwInput.value.trim();
      if (!password) return;
      okBtn.disabled = true;
      okBtn.textContent = '解除中...';

      const result = await chrome.runtime.sendMessage({ action: 'unlockKeys', password }).catch(() => null);
      if (result?.success) {
        overlay.style.display = 'none';
        cleanup();
        resolve(true);
      } else {
        showPopupToast('パスワードが違います');
        okBtn.disabled = false;
        okBtn.textContent = '解除';
        pwInput.select();
      }
    }

    function onCancel() {
      overlay.style.display = 'none';
      cleanup();
      reject(new Error('cancelled'));
    }

    function onKeydown(e) {
      if (e.key === 'Enter')  tryUnlock();
      if (e.key === 'Escape') onCancel();
    }

    function cleanup() {
      okBtn.removeEventListener('click', tryUnlock);
      cancelBtn.removeEventListener('click', onCancel);
      pwInput.removeEventListener('keydown', onKeydown);
    }

    okBtn.addEventListener('click', tryUnlock);
    cancelBtn.addEventListener('click', onCancel);
    pwInput.addEventListener('keydown', onKeydown);
  });
}

function clearConversation() {
  conversationHistory = [];
  document.getElementById('messages').innerHTML = '';
  if (paperContext) {
    appendMessage('assistant', `会話をリセットしました。「${truncate(paperContext.title, 50)}」について何でもご質問ください。`);
  }
}

function openOptions(e) {
  e?.preventDefault();
  chrome.runtime.openOptionsPage();
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function appendMessage(role, text) {
  const container = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = `msg msg-${role === 'error' ? 'error' : role}`;
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function appendTyping() {
  const container = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  el.innerHTML =
    '<span class="typing-dot"></span>' +
    '<span class="typing-dot"></span>' +
    '<span class="typing-dot"></span>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : (str ?? '');
}

async function getStorageArea() {
  return new Promise(resolve =>
    chrome.storage.local.get('trarxiv:storageType', r =>
      resolve(r['trarxiv:storageType'] === 'sync' ? chrome.storage.sync : chrome.storage.local)
    )
  );
}

async function getConfig() {
  const area = await getStorageArea();
  return new Promise(resolve =>
    area.get('trarxiv:config', r => resolve(r['trarxiv:config'] ?? {}))
  );
}
