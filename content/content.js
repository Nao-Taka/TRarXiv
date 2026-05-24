/**
 * TrArXiv - Content Script
 * Runs on arxiv.org/html/* pages.
 */
'use strict';

// ─── Provider Registry ────────────────────────────────────────────────────────
const PROVIDERS = [
  {
    name: 'arxiv-abs',
    isAbsPage: true,
    canHandle: (url) => /arxiv\.org\/abs\//i.test(url),
    getPaperId: (url) => {
      const m = url.match(/arxiv\.org\/abs\/([^/?#]+)/i);
      return m ? m[1].replace(/v\d+$/, '') : null;
    },
    getRawPaperId: (url) => {
      // 元の (v付きの) ID を保持。HTML/ar5iv リンクで使う
      const m = url.match(/arxiv\.org\/abs\/([^/?#]+)/i);
      return m ? m[1] : null;
    },
    getPaperTitle: () => {
      const el = document.querySelector('h1.title');
      if (!el) return document.title;
      return el.textContent.replace(/^\s*Title:\s*/i, '').trim();
    },
    getAbstract: () => {
      const el = document.querySelector('blockquote.abstract');
      return el ? el.textContent.replace(/^\s*Abstract:\s*/i, '').trim() : '';
    },
    hasHtmlVersion: () => {
      // arxiv abs ページは HTML 版がある時に "HTML (experimental)" リンクを表示する
      return !!document.querySelector('a[href*="/html/"]');
    },
    getSections: () => [],
  },
  {
    name: 'arxiv',
    // arxiv.org/html と ar5iv (labs.arxiv.org / ar5iv.org の html/abs) は同じ LaTeXML 出力構造 (ltx_*)
    // なので 1 つのプロバイダーで両方ハンドリングする
    canHandle: (url) => /(arxiv\.org\/html\/|ar5iv\.(?:labs\.arxiv\.org|org)\/(?:html|abs)\/)/i.test(url),
    getPaperId: (url) => {
      const m = url.match(/(?:arxiv\.org\/html\/|ar5iv\.(?:labs\.arxiv\.org|org)\/(?:html|abs)\/)([^/?#]+)/i);
      return m ? m[1].replace(/v\d+$/, '') : null;
    },
    getPaperTitle: () => {
      const el = document.querySelector('h1.ltx_title.ltx_title_document, .ltx_document > h1');
      return el ? el.textContent.trim() : document.title;
    },
    getAbstract: () => {
      const el = document.querySelector('.ltx_abstract');
      return el ? el.textContent.replace(/^Abstract\s*/i, '').trim() : '';
    },
    getSections: () => {
      const sections = [];
      const abstractEl = document.querySelector('.ltx_abstract');
      if (abstractEl) {
        const paras = getContentParagraphs(abstractEl);
        if (paras.length > 0) {
          sections.push({
            id: 'abstract', title: 'Abstract',
            headingEl: abstractEl.querySelector('.ltx_title') ?? abstractEl,
            paragraphEls: paras, element: abstractEl,
          });
        }
      }
      document.querySelectorAll(
        'section.ltx_section, section.ltx_subsection, section.ltx_subsubsection'
      ).forEach((sec, i) => {
        const heading = sec.querySelector(':scope > .ltx_title');
        const paras = getContentParagraphs(sec);
        if (paras.length === 0) return;
        sections.push({
          id: `section-${i}`,
          title: heading ? heading.textContent.trim() : `Section ${i + 1}`,
          headingEl: heading, paragraphEls: paras, element: sec,
        });
      });
      return sections;
    },
  },
];

function getContentParagraphs(container) {
  const paras = [];
  container.querySelectorAll(':scope > .ltx_para').forEach(para => {
    para.querySelectorAll('p.ltx_p').forEach(p => paras.push(p));
  });
  if (paras.length === 0) {
    container.querySelectorAll(':scope > p.ltx_p, :scope > p').forEach(p => paras.push(p));
  }
  return paras.filter(p => p.textContent.trim().length > 20);
}

// ─── Section classification ───────────────────────────────────────────────────
const CATEGORY_LABELS = {
  main:          '本文',
  references:    '引用文献',
  supplementary: '付録・補足',
};

function classifySection(section) {
  const title = (section.title ?? '').toLowerCase();
  const cls   = section.element?.className ?? '';
  if (/references?|bibliography|works?\s+cited|文献/.test(title) || cls.includes('ltx_bibliography')) {
    return 'references';
  }
  if (/appendix|appendice|supplement|additional\s+material|付録|補足/.test(title) || cls.includes('ltx_appendix')) {
    return 'supplementary';
  }
  return 'main';
}

function hasExistingTranslation(section) {
  return !!section.element?.querySelector('.trarxiv-translation-block');
}

// ─── Progress handler registry ────────────────────────────────────────────────
const progressHandlers = new Map(); // sectionId → fn(msg)

let bulkStopRequested = false;

// ─── Key unlock modal ──────────────────────────────────────────────────────────
let unlockModalPromise = null; // Singleton: prevents double modal

async function ensureKeysUnlocked() {
  if (unlockModalPromise) return unlockModalPromise;
  unlockModalPromise = showUnlockModal().finally(() => { unlockModalPromise = null; });
  return unlockModalPromise;
}

function showUnlockToast(container, msg) {
  container.querySelector('.trarxiv-unlock-toast')?.remove();
  const el = document.createElement('div');
  el.className = 'trarxiv-unlock-toast';
  el.textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, 2500);
}

function showUnlockModal() {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'trarxiv-unlock-overlay';

    const box = document.createElement('div');
    box.className = 'trarxiv-unlock-box';

    const title = document.createElement('div');
    title.className = 'trarxiv-unlock-title';
    title.textContent = '\u{1F512} TrArXiv — APIキー解除';

    const desc = document.createElement('p');
    desc.className = 'trarxiv-unlock-desc';
    desc.append(
      'APIキーが暗号化されています。',
      document.createElement('br'),
      '設定時に登録したパスワードを入力してください。'
    );

    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'trarxiv-unlock-input';
    input.placeholder = 'パスワード';
    input.autocomplete = 'off';

    const actions = document.createElement('div');
    actions.className = 'trarxiv-unlock-actions';
    const okBtnEl = document.createElement('button');
    okBtnEl.className = 'trarxiv-unlock-ok';
    okBtnEl.textContent = '解除';
    const cancelBtnEl = document.createElement('button');
    cancelBtnEl.className = 'trarxiv-unlock-cancel';
    cancelBtnEl.textContent = 'キャンセル';
    actions.append(okBtnEl, cancelBtnEl);

    box.append(title, desc, input, actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const okBtn     = okBtnEl;
    const cancelBtn = cancelBtnEl;

    input.focus();

    async function tryUnlock() {
      const password = input.value.trim();
      if (!password) return;
      okBtn.disabled = true;
      okBtn.textContent = '解除中...';

      const result = await sendMessage({ action: 'unlockKeys', password }).catch(() => null);
      if (result?.success) {
        overlay.remove();
        resolve(true);
      } else {
        showUnlockToast(overlay, 'パスワードが違います');
        okBtn.disabled = false;
        okBtn.textContent = '解除';
        input.select();
      }
    }

    okBtn.addEventListener('click', tryUnlock);
    cancelBtn.addEventListener('click', () => {
      overlay.remove();
      reject(new Error('cancelled'));
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  tryUnlock();
      if (e.key === 'Escape') cancelBtn.click();
    });
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === '_translateProgress' || msg.action === '_explainProgress') {
    progressHandlers.get(msg.sectionId)?.(msg);
  }
  // Do NOT return true — no async response needed
});

// ─── UI preferences ───────────────────────────────────────────────────────────
let collapseEnglishDefault = false;

const FONT_SIZES = {
  small:  { en: '11.5px', ja: '13px',   enLine: '1.5', jaLine: '1.65' },
  medium: { en: '13.5px', ja: '15px',   enLine: '1.55', jaLine: '1.7' },
  large:  { en: '15px',   ja: '17px',   enLine: '1.6',  jaLine: '1.75' },
  xlarge: { en: '17px',   ja: '19px',   enLine: '1.6',  jaLine: '1.75' },
};

function applyFontSize(key) {
  const s = FONT_SIZES[key] ?? FONT_SIZES.medium;
  const id = 'trarxiv-font-size-style';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent =
    `.trarxiv-en { font-size: ${s.en} !important; line-height: ${s.enLine} !important; }` +
    `.trarxiv-ja { font-size: ${s.ja} !important; line-height: ${s.jaLine} !important; }`;
}

async function loadUIPrefs() {
  return new Promise(resolve => {
    chrome.storage.local.get('trarxiv:config', r => {
      const ui = r['trarxiv:config']?.ui ?? {};
      collapseEnglishDefault = ui.collapseEnglish ?? false;
      applyFontSize(ui.translationFontSize ?? 'medium');
      resolve();
    });
  });
}

// ─── Dynamic provider (site-config from sync storage) ─────────────────────────
function loadDynamicProvider(hostname) {
  return new Promise(resolve =>
    chrome.storage.sync.get('trarxiv:sc:' + hostname, r =>
      resolve(r['trarxiv:sc:' + hostname] ?? null)
    )
  );
}

// Inline guard against pre-A4 storage / direct manipulation. background.js も
// 同じ検査をしているが、ここでは「使用前の最終防衛」として再チェックする。
// utils/selector-guard.js と同期して保つこと。
const DANGEROUS_SELECTOR_SUBSTRINGS = [
  'password', 'passwd', 'pwd', 'csrf', 'xsrf', 'token', 'secret',
  'apikey', 'api-key', 'api_key', 'auth', 'credit', 'cardnumber', 'card-number',
  'cvv', 'cvc', 'ssn', 'session', 'cookie', 'bearer', 'hidden',
];
const DANGEROUS_BARE_TAGS = [
  'input', 'form', 'button', 'select', 'textarea', 'option', 'fieldset',
  'iframe', 'script', 'style', 'meta', 'link',
  'html', 'head', 'body', 'document',
];

function isSafeSelector(sel) {
  if (sel == null) return true;                       // 未指定は OK (use 側で null チェック)
  if (typeof sel !== 'string') return false;
  const s = sel.trim();
  if (s === '' || s.length > 200) return s === '';
  if (/^\s*\*+(\s*[>+~]\s*\*+)*\s*$/.test(s)) return false;
  const lower = s.toLowerCase();
  if (DANGEROUS_SELECTOR_SUBSTRINGS.some(b => lower.includes(b))) return false;
  for (const tag of DANGEROUS_BARE_TAGS) {
    const re = new RegExp(`(^|[\\s,>+~(])${tag}(?=$|[\\s,>+~.#:\\[])`, 'i');
    if (re.test(s)) return false;
  }
  if (/[\x00-\x1f]/.test(s)) return false;
  return true;
}

function sanitizeDynamicConfig(cfg) {
  const out = { ...cfg };
  let droppedAny = false;
  for (const key of ['titleSel', 'abstractSel', 'sectionSel', 'headingSel', 'paragraphSel']) {
    if (cfg[key] != null && !isSafeSelector(cfg[key])) {
      console.warn('[TrArXiv] 危険なセレクターを破棄:', key, cfg[key]);
      out[key] = null;
      droppedAny = true;
    }
  }
  if (droppedAny && (!out.sectionSel || !out.paragraphSel)) {
    return null;                                       // 主要セレクターを失ったら無効化
  }
  return out;
}

function makeDynamicProvider(hostname, cfg) {
  return {
    name: hostname,
    canHandle: (url) => { try { return new URL(url).hostname === hostname; } catch { return false; } },
    getPaperId: (url) => {
      try { return hostname + new URL(url).pathname.replace(/\/$/, ''); } catch { return url; }
    },
    getPaperTitle: () => {
      const el = cfg.titleSel ? document.querySelector(cfg.titleSel) : null;
      return el?.textContent?.trim() ?? document.querySelector('h1')?.textContent?.trim() ?? document.title;
    },
    getAbstract: () =>
      cfg.abstractSel ? (document.querySelector(cfg.abstractSel)?.textContent?.trim() ?? '') : '',
    getSections: () => {
      const { sectionSel, headingSel, paragraphSel } = cfg;
      if (!sectionSel || !paragraphSel) return [];
      const sections = [];
      document.querySelectorAll(sectionSel).forEach((sec, i) => {
        const heading = headingSel ? sec.querySelector(headingSel) : null;
        const paras = [...sec.querySelectorAll(paragraphSel)]
          .filter(p => p.textContent.trim().length > 20);
        if (paras.length === 0) return;
        sections.push({
          id: `section-${i}`,
          title: heading?.textContent?.trim() ?? `Section ${i + 1}`,
          headingEl: heading ?? sec,
          paragraphEls: paras,
          element: sec,
        });
      });
      return sections;
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async function init() {
  if (window.__trarxivLoaded) return;
  window.__trarxivLoaded = true;

  let provider = PROVIDERS.find(p => p.canHandle(location.href));

  if (!provider) {
    const rawCfg = await loadDynamicProvider(location.hostname);
    const cfg = rawCfg ? sanitizeDynamicConfig(rawCfg) : null;
    if (cfg) provider = makeDynamicProvider(location.hostname, cfg);
  }

  if (!provider) return;
  const paperId    = provider.getPaperId(location.href);
  const paperTitle = provider.getPaperTitle();
  if (!paperId) return;

  await loadUIPrefs();

  // Register paper in library (fire-and-forget)
  sendMessage({ action: 'registerPaper', id: paperId, title: paperTitle, url: location.href }).catch(() => {});

  // ── arxiv.org/abs/ ページ: HTML/ar5iv 誘導 + 論文ブリーフィング ──
  if (provider.isAbsPage) {
    injectAbsLinkBtn(paperId, provider);
    injectPaperBriefingBtn(paperId, paperTitle, provider);
    injectPositioningBtn(paperId, paperTitle, provider);
    setupContextListener(provider, paperId, paperTitle, []);
    return;
  }

  const sections = provider.getSections();
  if (sections.length === 0) return;

  // A14: 参考文献マップを一度だけ構築 (ページ内で共有)
  _bibMap = buildBibliographyMap();

  sections.forEach(section => injectButtons(section, paperId, paperTitle));
  injectBulkBar(sections, paperId, paperTitle);
  injectPaperBriefingBtn(paperId, paperTitle, provider);
  injectPositioningBtn(paperId, paperTitle, provider);
  injectAuthorButtons(paperId, paperTitle);
  injectFigureButtons(paperId, paperTitle);
  setupContextListener(provider, paperId, paperTitle, sections);
})();

// ─── arxiv.org/abs/ — HTML or ar5iv link button ───────────────────────────────
// 配置: 右側ペイン "Access Paper" の <ul> (View PDF / TeX Source の並び) に追加。
// 見つからない場合は title 下にフォールバック。
function injectAbsLinkBtn(paperId, provider) {
  if (document.querySelector('.trarxiv-abs-link-btn')) return;

  const rawId  = provider.getRawPaperId?.(location.href) ?? paperId;
  const hasHtml = provider.hasHtmlVersion?.() ?? false;

  const link = document.createElement('a');
  link.className = 'abs-button trarxiv-abs-link-btn';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (hasHtml) {
    link.href = `https://arxiv.org/html/${rawId}`;
    link.textContent = '📄 TRarXiv で読む (HTML)';
    link.title = 'TRarXiv で翻訳・解説しながら読む';
  } else {
    link.href = `https://ar5iv.org/abs/${rawId}`;
    link.textContent = '📑 ar5iv で読む';
    link.title = 'arXiv に HTML 版がないため、サードパーティの ar5iv 経由で開く (TRarXiv は ar5iv にも対応)';
  }

  // Primary: arxiv abs ページの "Access Paper" リスト (.full-text ul) の末尾に追加
  const accessList = document.querySelector('.full-text ul');
  if (accessList) {
    const li = document.createElement('li');
    li.className = 'trarxiv-abs-link-li';
    li.appendChild(link);
    accessList.appendChild(li);
    return;
  }

  // Fallback: タイトル直下に wrap で配置 (構造が違う abs ページ用)
  const titleEl = document.querySelector('h1.title');
  if (!titleEl) return;
  const wrap = document.createElement('div');
  wrap.className = 'trarxiv-abs-link-wrap';
  wrap.appendChild(link);
  titleEl.after(wrap);
}

// ─── Button injection ─────────────────────────────────────────────────────────
function injectButtons(section, paperId, paperTitle) {
  if (!section.headingEl) return;
  if (section.headingEl.querySelector('.trarxiv-btn-group')) return;

  const group = document.createElement('span');
  group.className = 'trarxiv-btn-group';

  const btnTranslate = makeButton('翻訳', 'translate', 'trarxiv-btn-translate');
  const btnExplain   = makeButton('解説', 'explain',   'trarxiv-btn-explain');

  group.appendChild(btnTranslate);
  group.appendChild(btnExplain);
  section.headingEl.appendChild(group);

  btnTranslate.addEventListener('click', () => runTranslate(section, paperId, btnTranslate));
  btnExplain.addEventListener('click',   () => runExplain(section, paperId, paperTitle, btnExplain));
}

function makeButton(label, type, cls) {
  const btn = document.createElement('button');
  btn.className = `trarxiv-btn ${cls}`;
  btn.dataset.action = type;
  btn.textContent = label;
  return btn;
}

// ─── Translate ────────────────────────────────────────────────────────────────
async function runTranslate(section, paperId, btn) {
  if (btn.disabled) return;

  // If already translated once, next click is always forceRefresh (re-translate)
  const forceRefresh = btn.dataset.translated === '1';
  clearSectionMessages(section);

  const paragraphs = section.paragraphEls
    .map((el, i) => ({ id: `${section.id}-p${i}`, text: extractText(el) }))
    .filter(p => p.text.length > 0);

  // ── Token budget check ──
  if (!forceRefresh) {  // cache hits don't consume tokens, skip check
    const budgetOk = await checkTokenBudget(paperId, paragraphs, btn);
    if (!budgetOk) return;
  }

  // ── Start progress UI ──
  const startTime = Date.now();
  let progressState = { done: 0, total: paragraphs.length, rate: null };

  progressHandlers.set(section.id, ({ completed, total }) => {
    const elapsed = Date.now() - startTime;
    progressState.done  = completed;
    progressState.total = total;
    progressState.rate  = completed > 0 ? completed / elapsed : null; // paras/ms
    renderProgressBtn(btn, progressState, elapsed);
  });

  btn.disabled = true;
  renderProgressBtn(btn, progressState, 0);

  // Elapsed time ticker (updates between progress messages)
  const ticker = setInterval(() => {
    renderProgressBtn(btn, progressState, Date.now() - startTime);
  }, 500);

  try {
    const msg = { action: 'translate', paperId, sectionId: section.id, sectionTitle: section.title, paragraphs, forceRefresh };
    let result = await sendMessage(msg);

    if (result.error === 'NEEDS_PASSWORD') {
      try {
        await ensureKeysUnlocked();
        result = await sendMessage(msg);
      } catch {
        showSectionError(section, 'APIキーの解除がキャンセルされました');
        btn.disabled = false;
        btn.textContent = forceRefresh ? '再翻訳' : '翻訳';
        return;
      }
    }

    if (result.error) throw new Error(result.error);

    renderTranslations(section, result.results);

    btn.disabled = false;
    btn.dataset.translated = '1';
    btn.textContent = '再翻訳';

    if (result.fromCache) {
      appendBadge(btn, 'キャッシュ', 'trarxiv-cache-badge');
    } else {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      appendBadge(btn, `${elapsed}s`, 'trarxiv-time-badge');
    }

    if (result.limitExceeded) {
      showSectionWarning(section,
        `トークン上限に達したため翻訳を途中で停止しました。` +
        `(この論文の使用合計: ${result.paperTokensUsed?.toLocaleString() ?? '?'} tokens)`
      );
    }
  } catch (err) {
    showSectionError(section, err.message);
    btn.disabled = false;
    btn.textContent = forceRefresh ? '再翻訳' : '翻訳';
  } finally {
    clearInterval(ticker);
    progressHandlers.delete(section.id);
  }
}

// ─── Token budget ─────────────────────────────────────────────────────────────
async function checkTokenBudget(paperId, paragraphs, btn) {
  const budget = await sendMessage({ action: 'getTokenBudget', paperId }).catch(() => null);
  if (!budget?.enabled || !budget.limit) return true;

  const est = estimateTokens(paragraphs);

  // Already over limit
  if (budget.remaining <= 0) {
    const msg =
      `この論文のトークン上限（${budget.limit.toLocaleString()} tokens）に達しています。\n` +
      `（使用済み: ${budget.used.toLocaleString()} tokens）\n\n` +
      `それでも翻訳しますか？`;
    return confirm(msg);
  }

  // Estimated usage would exceed limit
  if (est.total > budget.remaining) {
    const msg =
      `このセクションの翻訳には約 ${est.total.toLocaleString()} tokens かかる見込みです。\n` +
      `論文の残り予算: ${budget.remaining.toLocaleString()} / ${budget.limit.toLocaleString()} tokens\n\n` +
      `翻訳を続けますか？`;
    return confirm(msg);
  }

  return true;
}

function estimateTokens(paragraphs) {
  const totalChars = paragraphs.reduce((s, p) => s + p.text.length, 0);
  // Input: system prompt + user message overhead per paragraph + text
  const input  = paragraphs.length * 280 + Math.ceil(totalChars / 3.5);
  // Output: JSON pairs (Japanese is slightly longer than English)
  const output = Math.ceil(totalChars / 2.5);
  return { input, output, total: input + output };
}

// ─── Progress button renderer ─────────────────────────────────────────────────
function renderProgressBtn(btn, { done, total, rate }, elapsedMs) {
  const elapsedS = (elapsedMs / 1000).toFixed(0);
  let label;

  if (total <= 0) {
    label = `翻訳中... ${elapsedS}s`;
  } else if (done === 0) {
    label = `0/${total}段落 ${elapsedS}s`;
  } else if (done >= total) {
    label = `${total}段落完了 ${elapsedS}s`;
  } else if (rate && rate > 0) {
    const remainS = Math.ceil((total - done) / rate / 1000);
    label = `${done}/${total}段落 • 残り~${remainS}s`;
  } else {
    label = `${done}/${total}段落 ${elapsedS}s`;
  }

  renderSpinnerLabel(btn, label);
}

function renderSpinnerLabel(btn, label) {
  btn.replaceChildren();
  const spin = document.createElement('span');
  spin.className = 'trarxiv-spinner';
  const lab = document.createElement('span');
  lab.className = 'trarxiv-progress-label';
  lab.textContent = label;
  btn.append(spin, lab);
}

// ─── Explain ──────────────────────────────────────────────────────────────────
async function runExplain(section, paperId, paperTitle, btn) {
  if (btn.disabled) return;

  const forceRefresh = btn.dataset.explained === '1';
  clearSectionMessages(section);

  // 解説では位置情報を正確に保持する必要がないので [数式] に戻して LLM に送る
  const fullText = section.paragraphEls.map(extractText).join('\n\n')
    .replace(/⟦MATH_\d+⟧/g, '[数式]')
    .replace(/⟦REF:[^⟧]+⟧/g, '[REF]');
  const startTime = Date.now();

  // Show generating state
  progressHandlers.set(section.id, ({ phase }) => {
    if (phase === 'generating') {
      renderSpinnerLabel(btn, '解説生成中...');
    }
  });

  btn.disabled = true;
  renderSpinnerLabel(btn, '0s');

  const ticker = setInterval(() => {
    const el = btn.querySelector('.trarxiv-progress-label');
    if (el && !el.textContent.includes('生成中')) {
      el.textContent = `${((Date.now() - startTime) / 1000).toFixed(0)}s`;
    }
  }, 500);

  try {
    const msg = { action: 'explain', paperId, sectionId: section.id, sectionTitle: section.title, text: fullText, paperTitle, forceRefresh };
    let result = await sendMessage(msg);

    if (result.error === 'NEEDS_PASSWORD') {
      try {
        await ensureKeysUnlocked();
        result = await sendMessage(msg);
      } catch {
        showSectionError(section, 'APIキーの解除がキャンセルされました');
        btn.disabled = false;
        btn.textContent = forceRefresh ? '再解説' : '解説';
        return;
      }
    }

    if (result.error) throw new Error(result.error);

    renderExplanation(section, result.explanation);

    btn.disabled = false;
    btn.dataset.explained = '1';
    btn.textContent = '再解説';

    if (result.fromCache) {
      appendBadge(btn, 'キャッシュ', 'trarxiv-cache-badge');
    } else {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      appendBadge(btn, `${elapsed}s`, 'trarxiv-time-badge');
    }
  } catch (err) {
    showSectionError(section, err.message);
    btn.disabled = false;
    btn.textContent = forceRefresh ? '再解説' : '解説';
  } finally {
    clearInterval(ticker);
    progressHandlers.delete(section.id);
  }
}

// ─── Render helpers ───────────────────────────────────────────────────────────
function renderTranslations(section, results) {
  section.paragraphEls.forEach(el => {
    el.parentElement?.querySelectorAll('.trarxiv-translation-block').forEach(b => b.remove());
  });
  results.forEach((paraResult) => {
    const idx = getParaIndex(section, paraResult.paraId);
    if (idx < 0) return;
    const paraEl = section.paragraphEls[idx];
    if (!paraEl || !paraResult.pairs?.length) return;
    insertTranslationBlock(paraEl, paraResult.pairs, paraResult.paraId, 'translate');
  });
}

function getParaIndex(section, paraId) {
  const m = paraId?.match(/-p(\d+)$/);
  return m ? parseInt(m[1], 10) : -1;
}

function renderExplanation(section, explanation) {
  section.element?.querySelectorAll('.trarxiv-translation-block[data-type="explain"]')
    .forEach(b => b.remove());
  const lastPara = section.paragraphEls[section.paragraphEls.length - 1];
  if (!lastPara) return;

  const block = document.createElement('div');
  block.className = 'trarxiv-translation-block';
  block.dataset.type = 'explain';

  const textEl = document.createElement('div');
  textEl.className = 'trarxiv-explain-text';
  textEl.textContent = explanation;
  block.appendChild(textEl);
  lastPara.after(block);
}

function insertTranslationBlock(paraEl, pairs, paraId, type = 'translate') {
  if (paraEl.nextElementSibling?.classList?.contains('trarxiv-translation-block')) {
    paraEl.nextElementSibling.remove();
  }
  const block = document.createElement('div');
  block.className = 'trarxiv-translation-block';
  block.dataset.type = type;
  block.dataset.paraId = paraId;

  // English (original paragraph) collapse toggle — translation blocks only
  if (type === 'translate') {
    const collapsed = collapseEnglishDefault;
    block.dataset.enCollapsed = collapsed ? '1' : '0';
    if (collapsed) paraEl.style.display = 'none';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'trarxiv-en-toggle';
    toggleBtn.textContent = collapsed ? '▶ 原文を表示' : '▼ 原文を隠す';
    toggleBtn.addEventListener('click', () => {
      const isNowCollapsed = block.dataset.enCollapsed === '1';
      block.dataset.enCollapsed = isNowCollapsed ? '0' : '1';
      paraEl.style.display = isNowCollapsed ? '' : 'none';
      toggleBtn.textContent = isNowCollapsed ? '▼ 原文を隠す' : '▶ 原文を表示';
    });
    block.appendChild(toggleBtn);
  }

  const mathClones = type === 'translate' ? collectMathClones(paraEl) : [];

  pairs.forEach((pair, i) => {
    if (!pair.en && !pair.ja) return;
    const pairEl = document.createElement('div');
    pairEl.className = 'trarxiv-pair';
    pairEl.dataset.pairId = `${paraId}-${i}`;

    const enEl = document.createElement('div');
    enEl.className = 'trarxiv-en';
    appendTextWithMath(enEl, pair.en ?? '', mathClones);

    const jaEl = document.createElement('div');
    jaEl.className = 'trarxiv-ja';
    appendTextWithMath(jaEl, pair.ja ?? '', mathClones);

    pairEl.appendChild(enEl);
    pairEl.appendChild(jaEl);

    // A14: ペアに含まれる参考文献を直下に小インデントで表示。ホバーで abstract 要約
    if (type === 'translate' && _bibMap) {
      const refsBlock = buildInlineRefList(pair.ja ?? '', pair.en ?? '', _bibMap);
      if (refsBlock) pairEl.appendChild(refsBlock);
    }

    block.appendChild(pairEl);

    pairEl.addEventListener('mouseenter', () => pairEl.classList.add('trarxiv-active'));
    pairEl.addEventListener('mouseleave', () => pairEl.classList.remove('trarxiv-active'));
  });

  paraEl.after(block);
}

// ─── UI utilities ─────────────────────────────────────────────────────────────
function clearSectionMessages(section) {
  section.headingEl?.querySelectorAll(
    '.trarxiv-error, .trarxiv-warning, .trarxiv-cache-badge, .trarxiv-time-badge'
  ).forEach(el => el.remove());
}

function showSectionError(section, message) {
  if (!section.headingEl) return;
  const el = document.createElement('span');
  el.className = 'trarxiv-error';
  el.textContent = `⚠ ${message}`;
  section.headingEl.appendChild(el);
}

function showSectionWarning(section, message) {
  if (!section.headingEl) return;
  const el = document.createElement('span');
  el.className = 'trarxiv-warning';
  el.textContent = `⚡ ${message}`;
  section.headingEl.appendChild(el);
}

function appendBadge(btn, text, cls) {
  // Remove existing badge of same class
  btn.parentElement?.querySelectorAll(`.${cls}`).forEach(el => el.remove());
  const badge = document.createElement('span');
  badge.className = cls;
  badge.textContent = text;
  btn.after(badge);
}

const MATH_SELECTOR = '.ltx_Math, .MathJax, .MathJax_Preview, math, .ltx_eqn_table';

// .ltx_Math が <math> をラップするケース等、入れ子になった math のうちトップレベルのみ返す。
// 抽出時 (extractText) と描画時 (collectMathClones) で同じフィルタを使うことで index 整合を保つ。
function selectTopLevelMath(root) {
  const all = [...root.querySelectorAll(MATH_SELECTOR)];
  return all.filter(m => !all.some(o => o !== m && o.contains(m)));
}

// A14: bib 参照キー抽出。'#bib.bib1' / 'bib.bib1' / 'bib1' → '1'
function extractRefKey(hrefOrId) {
  const cleaned = (hrefOrId ?? '').replace(/^#/, '');
  const m = cleaned.match(/^bib\.?(?:bib)?(.+)$/i);
  return m ? m[1] : cleaned;
}

function extractText(el) {
  const clone = el.cloneNode(true);
  // 数式 (A7) — トークン化
  selectTopLevelMath(clone).forEach((m, i) => {
    m.replaceWith(document.createTextNode(` ⟦MATH_${i}⟧ `));
  });
  // 参考文献リンク (A14) — トークン化
  clone.querySelectorAll('a[href^="#bib"]').forEach(a => {
    const key = extractRefKey(a.getAttribute('href'));
    a.replaceWith(document.createTextNode(` ⟦REF:${key}⟧ `));
  });
  clone.querySelectorAll('.ltx_biblio, .ltx_footnote').forEach(m => m.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

function collectMathClones(paraEl) {
  return selectTopLevelMath(paraEl).map(m => m.cloneNode(true));
}

// A14: 文書全体の参考文献マップ。bib key → {title, authors, year, refId}
function buildBibliographyMap() {
  const map = new Map();
  document.querySelectorAll('.ltx_bibitem, li[id^="bib"]').forEach(item => {
    const id = item.id;
    if (!id) return;
    const key = extractRefKey(id);

    const titleEl   = item.querySelector('.ltx_bib_title');
    const journalEl = item.querySelector('.ltx_bib_journal, .ltx_bib_publisher');
    const authorEl  = item.querySelector('.ltx_bib_author');
    const yearEl    = item.querySelector('.ltx_bib_year');

    const title   = (titleEl ?? journalEl)?.textContent?.trim() ?? '';
    const authors = authorEl?.textContent?.trim() ?? '';
    const year    = yearEl?.textContent?.trim() ?? '';

    let display = title;
    if (!display) {
      // 構造化フィールドなし → 全テキストから採取
      const text = item.textContent.replace(/^\[\d+\]\s*/, '').trim();
      display = text.length > 150 ? text.slice(0, 150) + '…' : text;
    }

    map.set(key, { title: display, authors, year, refId: id });
  });
  return map;
}

let _bibMap = null;  // init() で設定。論文ページ内で共有

// テキスト中の ⟦MATH_N⟧ と ⟦REF:X⟧ トークンを実 DOM に展開して target に流し込む。
// LLM がトークンを脱落/追加/改変しても安全 (literal フォールバック)。
function appendTextWithMathAndRefs(target, textContent, mathClones, bibMap) {
  // 1つの正規表現で MATH と REF の両方を扱う
  const TOKEN_RE = /⟦(?:MATH_(\d+)|REF:([^⟧]+))⟧/g;
  let lastEnd = 0;
  let m;
  while ((m = TOKEN_RE.exec(textContent))) {
    if (m.index > lastEnd) {
      target.appendChild(document.createTextNode(textContent.slice(lastEnd, m.index)));
    }
    if (m[1] !== undefined) {
      // MATH
      const idx  = parseInt(m[1], 10);
      const node = mathClones?.[idx];
      if (node) {
        const wrap = document.createElement('span');
        wrap.className = 'trarxiv-math';
        wrap.appendChild(node.cloneNode(true));
        target.appendChild(wrap);
      } else {
        target.appendChild(document.createTextNode(m[0]));
      }
    } else if (m[2] !== undefined) {
      // REF
      const key = m[2];
      const sup = document.createElement('sup');
      sup.className = 'trarxiv-ref-token';
      sup.textContent = `[${key}]`;
      if (bibMap?.has(key)) {
        const bib = bibMap.get(key);
        sup.dataset.refKey = key;
        sup.title = bib.title + (bib.authors ? ` — ${bib.authors}` : '') + (bib.year ? ` (${bib.year})` : '');
        const a = document.createElement('a');
        a.href = `#${bib.refId}`;
        a.textContent = sup.textContent;
        sup.replaceChildren(a);
      }
      target.appendChild(sup);
    }
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < textContent.length) {
    target.appendChild(document.createTextNode(textContent.slice(lastEnd)));
  }
}

// 後方互換のため math のみ版もエクスポート (内部で REFs なし版を呼ぶ)
function appendTextWithMath(target, textContent, mathClones) {
  appendTextWithMathAndRefs(target, textContent, mathClones, _bibMap);
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Bulk translation bar ─────────────────────────────────────────────────────
function injectBulkBar(sections, paperId, paperTitle) {
  // Group sections by category
  const groups = { main: [], references: [], supplementary: [] };
  sections.forEach(s => groups[classifySection(s)].push(s));

  // Only show buttons for non-empty categories
  const nonEmpty = Object.entries(groups).filter(([, list]) => list.length > 0);
  if (nonEmpty.length === 0) return;

  const bar = document.createElement('div');
  bar.className = 'trarxiv-bulk-bar';

  // Label
  const label = document.createElement('span');
  label.className = 'trarxiv-bulk-label';
  label.textContent = '📑 全文翻訳:';
  bar.appendChild(label);

  // Category buttons
  const btnWrap = document.createElement('span');
  btnWrap.className = 'trarxiv-bulk-btns';
  nonEmpty.forEach(([cat, list]) => {
    const btn = document.createElement('button');
    btn.className = `trarxiv-btn trarxiv-btn-translate trarxiv-bulk-cat-btn`;
    btn.dataset.cat = cat;
    btn.textContent = `${CATEGORY_LABELS[cat]} (${list.length})`;
    btn.addEventListener('click', () => runTranslateAll(cat, groups, paperId, paperTitle, bar));
    btnWrap.appendChild(btn);
  });
  bar.appendChild(btnWrap);

  // Stop button
  const stopBtn = document.createElement('button');
  stopBtn.className = 'trarxiv-bulk-stop';
  stopBtn.textContent = '■ 停止';
  stopBtn.style.display = 'none';
  stopBtn.addEventListener('click', () => { bulkStopRequested = true; });
  bar.appendChild(stopBtn);

  // Status
  const status = document.createElement('span');
  status.className = 'trarxiv-bulk-status';
  bar.appendChild(status);

  // Insert before abstract or first section
  const anchor = document.querySelector(
    '.ltx_abstract, section.ltx_section, section.ltx_chapter'
  );
  if (anchor) anchor.before(bar);
  else document.querySelector('.ltx_document')?.prepend(bar);
}

async function runTranslateAll(category, groups, paperId, paperTitle, barEl) {
  // Only translate sections that don't have translations yet
  const targets = (groups[category] ?? []).filter(s => !hasExistingTranslation(s));

  const statusEl = barEl.querySelector('.trarxiv-bulk-status');
  const stopBtn  = barEl.querySelector('.trarxiv-bulk-stop');
  const catBtns  = barEl.querySelectorAll('.trarxiv-bulk-cat-btn');

  if (targets.length === 0) {
    if (statusEl) statusEl.textContent = `${CATEGORY_LABELS[category]}: 全セクション翻訳済み`;
    return;
  }

  // ── Token budget check for whole batch ──
  const allParas = targets.flatMap(s =>
    s.paragraphEls.map((el, i) => ({ id: `${s.id}-p${i}`, text: extractText(el) }))
      .filter(p => p.text.length > 0)
  );
  const budget = await sendMessage({ action: 'getTokenBudget', paperId }).catch(() => null);
  if (budget?.enabled && budget.limit) {
    const est = estimateTokens(allParas);
    if (est.total > budget.remaining) {
      const ok = confirm(
        `「${CATEGORY_LABELS[category]}」一括翻訳の推定トークン: 約 ${est.total.toLocaleString()} tokens\n` +
        `論文の残り予算: ${budget.remaining.toLocaleString()} / ${budget.limit.toLocaleString()} tokens\n\n` +
        `続けますか？`
      );
      if (!ok) return;
    }
  }

  // ── Start ──
  bulkStopRequested = false;
  catBtns.forEach(b => { b.disabled = true; });
  if (stopBtn) stopBtn.style.display = '';

  let completed = 0;
  for (let i = 0; i < targets.length; i++) {
    if (bulkStopRequested) break;

    const section = targets[i];
    if (statusEl) {
      statusEl.textContent = `${i + 1}/${targets.length}: ${section.title.slice(0, 28)}…`;
    }

    const btn = section.headingEl?.querySelector('.trarxiv-btn-translate');
    if (btn && !btn.disabled) {
      // In bulk mode, use cache if available (don't force-refresh)
      btn.dataset.translated = '';  // ensure forceRefresh = false
      await runTranslate(section, paperId, btn);
    }
    completed++;

    // Brief pause between sections to respect rate limits
    if (i < targets.length - 1) await sleep(400);
  }

  // ── Done ──
  catBtns.forEach(b => { b.disabled = false; });
  if (stopBtn) stopBtn.style.display = 'none';
  if (statusEl) {
    statusEl.textContent = bulkStopRequested
      ? `停止 (${completed}/${targets.length} 完了)`
      : `✓ ${CATEGORY_LABELS[category]} ${completed}セクション完了`;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Paper Briefing ───────────────────────────────────────────────────────────
function injectPaperBriefingBtn(paperId, paperTitle, provider) {
  // arXiv html (.ltx_*), arXiv abs (h1.title), 動的サイト (汎用 h1) すべてカバー
  const titleEl = document.querySelector(
    'h1.ltx_title.ltx_title_document, .ltx_document > h1, h1.title'
  );
  if (!titleEl) return;
  // wrap が既に挿入されていたら二重注入を防ぐ
  let cursor = titleEl.nextElementSibling;
  while (cursor && cursor.classList?.contains('trarxiv-abs-link-wrap')) cursor = cursor.nextElementSibling;
  if (cursor?.classList?.contains('trarxiv-briefing-wrap')) return;

  const btn = document.createElement('button');
  btn.className = 'trarxiv-btn trarxiv-briefing-btn';
  btn.textContent = '⚡ 論文ブリーフィング';

  // Wrap button in a block container so it sits below the title
  const wrap = document.createElement('div');
  wrap.className = 'trarxiv-briefing-wrap';
  wrap.appendChild(btn);
  titleEl.after(wrap);

  // Card (hidden until fetched)
  const card = document.createElement('div');
  card.className = 'trarxiv-briefing-card';
  card.style.display = 'none';
  wrap.appendChild(card);

  btn.addEventListener('click', () => runPaperBriefing(
    paperId, paperTitle, provider, btn, card
  ));
}

async function runPaperBriefing(paperId, paperTitle, provider, btn, card) {
  if (btn.disabled) return;

  // Toggle: if card is already visible, hide it
  if (card.style.display !== 'none') {
    card.style.display = 'none';
    btn.textContent = '⚡ 論文ブリーフィング';
    return;
  }

  // If already populated (cached in DOM), just show
  if (card.dataset.populated === '1') {
    card.style.display = '';
    btn.textContent = '✕ ブリーフィングを閉じる';
    return;
  }

  const forceRefresh = btn.dataset.fetched === '1';
  const abstract = provider.getAbstract?.() ?? '';

  btn.disabled = true;
  renderSpinnerLabel(btn, '分析中...');
  const startTime = Date.now();
  const ticker = setInterval(() => {
    const el = btn.querySelector('.trarxiv-progress-label');
    if (el) el.textContent = `分析中... ${((Date.now() - startTime) / 1000).toFixed(0)}s`;
  }, 500);

  try {
    const msg = { action: 'paperBriefing', paperId, paperTitle, abstract, forceRefresh };
    let result = await sendMessage(msg);

    if (result.error === 'NEEDS_PASSWORD') {
      try {
        await ensureKeysUnlocked();
        result = await sendMessage(msg);
      } catch {
        btn.disabled = false;
        btn.textContent = '⚡ 論文ブリーフィング';
        return;
      }
    }

    if (result.error) throw new Error(result.error);

    renderBriefingCard(card, result.briefing);
    card.dataset.populated = '1';
    card.style.display = '';

    btn.disabled = false;
    btn.dataset.fetched = '1';
    btn.textContent = '✕ ブリーフィングを閉じる';

    if (result.fromCache) {
      appendBriefingBadge(btn, 'キャッシュ', 'trarxiv-cache-badge');
    } else {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      appendBriefingBadge(btn, `${elapsed}s`, 'trarxiv-time-badge');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '⚡ 論文ブリーフィング';
    const errEl = document.createElement('span');
    errEl.className = 'trarxiv-error';
    errEl.textContent = `⚠ ${err.message}`;
    btn.after(errEl);
    setTimeout(() => errEl.remove(), 6000);
  } finally {
    clearInterval(ticker);
  }
}

function renderBriefingCard(card, text) {
  card.replaceChildren();
  // Parse labeled sections: 🎯一言で / 🔬手法 / ✨新規性 / 📊比較 / ⚠️課題
  const LABELS = ['🎯一言で', '🔬手法', '✨新規性', '📊比較', '⚠️課題'];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let current = null;

  for (const line of lines) {
    const matchedLabel = LABELS.find(lb => line.startsWith(lb));
    if (matchedLabel) {
      if (current) card.appendChild(buildBriefingSection(current.label, current.lines));
      const colonIdx = line.indexOf('：') !== -1 ? line.indexOf('：') : line.indexOf(':');
      current = { label: matchedLabel, lines: [line.slice(colonIdx + 1).trim()].filter(Boolean) };
    } else if (current) {
      current.lines.push(line);
    } else {
      // Text before first label
      const pre = document.createElement('p');
      pre.className = 'trarxiv-briefing-pre';
      pre.textContent = line;
      card.appendChild(pre);
    }
  }
  if (current) card.appendChild(buildBriefingSection(current.label, current.lines));

  // Fallback: no labels found — show raw text
  if (card.children.length === 0) {
    const raw = document.createElement('div');
    raw.className = 'trarxiv-briefing-raw';
    raw.textContent = text;
    card.appendChild(raw);
  }
}

function buildBriefingSection(label, lines) {
  const div = document.createElement('div');
  div.className = 'trarxiv-briefing-section';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'trarxiv-briefing-label';
  labelSpan.textContent = label + ' ';
  div.appendChild(labelSpan);
  div.appendChild(document.createTextNode(lines.join(' ')));
  return div;
}

function appendBriefingBadge(btn, text, cls) {
  btn.parentElement?.querySelectorAll(`.${cls}`).forEach(el => el.remove());
  const badge = document.createElement('span');
  badge.className = cls;
  badge.textContent = text;
  btn.after(badge);
}

// ─── Paper Positioning (A11: 位置づけ + 関連論文) ──────────────────────────────
const ARXIV_ID_RE_NEW = /^\d{4}\.\d{4,5}$/;
const ARXIV_ID_RE_OLD = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/i;

function injectPositioningBtn(paperId, paperTitle, provider) {
  if (!ARXIV_ID_RE_NEW.test(paperId) && !ARXIV_ID_RE_OLD.test(paperId)) return;

  // 既存の briefing wrap に並べる (両 wrap は title 下に存在)
  const wrap = document.querySelector('.trarxiv-briefing-wrap');
  if (!wrap || wrap.querySelector('.trarxiv-positioning-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'trarxiv-btn trarxiv-positioning-btn';
  btn.textContent = '📊 位置づけ・関連論文';

  const card = document.createElement('div');
  card.className = 'trarxiv-positioning-card';
  card.style.display = 'none';

  wrap.appendChild(btn);
  wrap.appendChild(card);

  btn.addEventListener('click', () => runPaperPositioning(paperId, paperTitle, provider, btn, card));
}

async function runPaperPositioning(paperId, paperTitle, provider, btn, card) {
  if (btn.disabled) return;

  // Toggle
  if (card.style.display !== 'none') {
    card.style.display = 'none';
    btn.textContent = '📊 位置づけ・関連論文';
    return;
  }
  if (card.dataset.populated === '1') {
    card.style.display = '';
    btn.textContent = '✕ 位置づけを閉じる';
    return;
  }

  const forceRefresh = btn.dataset.fetched === '1';
  const abstract = provider.getAbstract?.() ?? '';

  btn.disabled = true;
  renderSpinnerLabel(btn, '分析中...');
  const startTime = Date.now();
  const ticker = setInterval(() => {
    const el = btn.querySelector('.trarxiv-progress-label');
    if (el) el.textContent = `分析中... ${((Date.now() - startTime) / 1000).toFixed(0)}s`;
  }, 500);

  try {
    const msg = { action: 'paperPositioning', paperId, paperTitle, abstract, forceRefresh };
    let result = await sendMessage(msg);

    if (result.error === 'NEEDS_PASSWORD') {
      try {
        await ensureKeysUnlocked();
        result = await sendMessage(msg);
      } catch {
        btn.disabled = false;
        btn.textContent = '📊 位置づけ・関連論文';
        return;
      }
    }

    if (result.error) throw new Error(result.error);

    renderPositioningCard(card, result);
    card.dataset.populated = '1';
    card.style.display = '';

    btn.disabled = false;
    btn.dataset.fetched = '1';
    btn.textContent = '✕ 位置づけを閉じる';

    if (result.fromCache) {
      appendBriefingBadge(btn, 'キャッシュ', 'trarxiv-cache-badge');
    } else {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      appendBriefingBadge(btn, `${elapsed}s`, 'trarxiv-time-badge');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '📊 位置づけ・関連論文';
    const errEl = document.createElement('span');
    errEl.className = 'trarxiv-error';
    errEl.textContent = `⚠ ${err.message}`;
    btn.after(errEl);
    setTimeout(() => errEl.remove(), 6000);
  } finally {
    clearInterval(ticker);
  }
}

function renderPositioningCard(card, result) {
  card.replaceChildren();

  // ── Positioning analysis (LLM output) ──
  const analysisDiv = document.createElement('div');
  analysisDiv.className = 'trarxiv-positioning-analysis';
  const LABELS = ['🎯立ち位置', '📜先行研究との関係', '🚀後続への影響', '➡️次に読むべき論文'];
  const lines = (result.positioning ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  let current = null;
  for (const line of lines) {
    const matched = LABELS.find(lb => line.startsWith(lb));
    if (matched) {
      if (current) analysisDiv.appendChild(buildPositioningSection(current));
      const colonIdx = line.indexOf('：') !== -1 ? line.indexOf('：') : line.indexOf(':');
      const body = colonIdx >= 0 ? line.slice(colonIdx + 1).trim() : '';
      current = { label: matched, body };
    } else if (current) {
      current.body += (current.body ? ' ' : '') + line;
    }
  }
  if (current) analysisDiv.appendChild(buildPositioningSection(current));
  if (analysisDiv.children.length === 0) {
    const raw = document.createElement('div');
    raw.textContent = result.positioning ?? '';
    analysisDiv.appendChild(raw);
  }
  card.appendChild(analysisDiv);

  // ── Related papers ──
  if (result.related) {
    const groups = [
      { key: 'references',      title: '📜 引用先 (References)' },
      { key: 'recommendations', title: '✨ 推薦類似 (Recommendations)' },
      { key: 'citations',       title: '🔗 被引用 (Cited by)' },
    ];
    for (const g of groups) {
      const papers = result.related[g.key];
      if (!Array.isArray(papers) || papers.length === 0) continue;

      const hdr = document.createElement('div');
      hdr.className = 'trarxiv-positioning-group-hdr';
      hdr.textContent = g.title;
      card.appendChild(hdr);

      const ul = document.createElement('ul');
      ul.className = 'trarxiv-positioning-papers';
      for (const p of papers.slice(0, 8)) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = p.url ?? `https://www.semanticscholar.org/paper/${encodeURIComponent(p.paperId ?? '')}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = p.title ?? '(no title)';
        li.appendChild(a);
        const meta = [];
        if (p.year)  meta.push(p.year);
        if (p.venue) meta.push(p.venue);
        if (p.citationCount != null) meta.push(`cited ${p.citationCount}`);
        if (Array.isArray(p.authors) && p.authors.length > 0) {
          meta.push(p.authors[0].name + (p.authors.length > 1 ? ' et al.' : ''));
        }
        if (meta.length > 0) li.append(' — ' + meta.join(', '));
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }
  }

  if (result.relatedError) {
    const warn = document.createElement('div');
    warn.className = 'trarxiv-positioning-warn';
    warn.textContent = `⚠ 関連論文の取得に一部失敗: ${result.relatedError}`;
    card.appendChild(warn);
  }

  // ── Footer note ──
  const note = document.createElement('div');
  note.className = 'trarxiv-author-note';
  const noteSpan = document.createElement('span');
  noteSpan.textContent = '出典: Semantic Scholar + LLM分析。チャットでも関連論文情報が活用されます';
  note.appendChild(noteSpan);
  card.appendChild(note);
}

// ─── Inline reference list (A14) ──────────────────────────────────────────────
function buildInlineRefList(jaText, enText, bibMap) {
  const refKeys = new Set();
  for (const text of [jaText, enText]) {
    for (const m of text.matchAll(/⟦REF:([^⟧]+)⟧/g)) refKeys.add(m[1]);
  }
  if (refKeys.size === 0) return null;

  const wrap = document.createElement('div');
  wrap.className = 'trarxiv-refs-inline';

  let addedAny = false;
  for (const key of refKeys) {
    const bib = bibMap.get(key);
    if (!bib) continue;

    const item = document.createElement('div');
    item.className = 'trarxiv-ref-item';
    item.dataset.refKey = key;

    const numSpan = document.createElement('span');
    numSpan.className = 'trarxiv-ref-num';
    numSpan.textContent = `[${key}]`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'trarxiv-ref-title';
    titleSpan.textContent = bib.title;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'trarxiv-ref-meta';
    const meta = [];
    if (bib.authors) meta.push(bib.authors);
    if (bib.year)    meta.push(bib.year);
    if (meta.length > 0) metaSpan.textContent = ' — ' + meta.join(', ');

    item.append(numSpan, ' ', titleSpan, metaSpan);

    // ホバー (500ms) で abstract 要約を遅延取得
    let hoverTimer = null;
    item.addEventListener('mouseenter', () => {
      if (item.dataset.summaryState) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => loadRefSummary(item, bib, key), 500);
    });
    item.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
    });

    wrap.appendChild(item);
    addedAny = true;
  }

  return addedAny ? wrap : null;
}

async function loadRefSummary(item, bib, key) {
  if (item.dataset.summaryState) return;
  item.dataset.summaryState = 'loading';

  const loadingEl = document.createElement('div');
  loadingEl.className = 'trarxiv-ref-summary loading';
  loadingEl.textContent = '⏳ 要約取得中...';
  item.appendChild(loadingEl);

  try {
    let result = await sendMessage({
      action: 'refSummary',
      refKey: key,
      title: bib.title,
      authors: bib.authors,
    });

    if (result?.error === 'NEEDS_PASSWORD') {
      try {
        await ensureKeysUnlocked();
        result = await sendMessage({
          action: 'refSummary', refKey: key, title: bib.title, authors: bib.authors,
        });
      } catch {
        loadingEl.remove();
        item.dataset.summaryState = '';
        return;
      }
    }

    if (result?.error) throw new Error(result.error);

    loadingEl.remove();
    if (result?.summary) {
      const sumEl = document.createElement('div');
      sumEl.className = 'trarxiv-ref-summary';
      sumEl.textContent = result.summary;
      if (result.s2Url) {
        const link = document.createElement('a');
        link.href = result.s2Url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'trarxiv-ref-s2link';
        link.textContent = ' [S2 ↗]';
        sumEl.appendChild(link);
      }
      item.appendChild(sumEl);
    }
    item.dataset.summaryState = 'done';
  } catch (err) {
    loadingEl.replaceChildren();
    loadingEl.classList.remove('loading');
    loadingEl.classList.add('error');
    loadingEl.textContent = `⚠ ${err.message}`;
    item.dataset.summaryState = 'error';
  }
}

function buildPositioningSection({ label, body }) {
  const div = document.createElement('div');
  div.className = 'trarxiv-positioning-section';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'trarxiv-positioning-label';
  labelSpan.textContent = label + ' ';
  div.appendChild(labelSpan);
  div.appendChild(document.createTextNode(body));
  return div;
}

// ─── Author Research ──────────────────────────────────────────────────────────
// `.ltx_personname` の中身を「個別著者名」のリストに分解する。
// arxiv.org/html では 1 author = 1 personname のことが多いが、ar5iv では
// 全著者が 1 つの personname に詰め込まれているケースがある。
// 同時に email / 所属 / 一行ブレイクも除外する。
function extractAuthorNames(nameEl) {
  const clone = nameEl.cloneNode(true);
  // 改行 / typewriter (email) / role_address は除去
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  clone.querySelectorAll('.ltx_font_typewriter, .ltx_role_address, .ltx_role_email').forEach(el => el.remove());

  const text = clone.textContent;
  // 改行で分割 → 各行を「2つ以上のスペース」「カンマ」「セミコロン」「and」で分割
  const candidates = text.split(/\n+/)
    .flatMap(line => line.split(/\s{2,}|,|;|\band\b/i))
    .map(s => s.trim())
    .filter(Boolean);

  // 著者名らしいものに絞る (簡易ヒューリスティック):
  // - 大文字を含む / 60文字以下 / 1〜5単語 / @ を含まない
  // - 所属を示す典型語を含まない
  return candidates.filter(s => {
    if (!/[A-Z]/.test(s)) return false;
    if (s.length > 60) return false;
    if (s.includes('@')) return false;
    if (s.split(/\s+/).length > 5) return false;
    if (/\b(research|university|institute|laboratory|department|inc|ltd|corp|team|group|brain|google|microsoft|meta|openai|deepmind)\b/i.test(s)) return false;
    return true;
  });
}

function injectAuthorButtons(paperId, paperTitle) {
  document.querySelectorAll('.ltx_personname').forEach(nameEl => {
    if (nameEl.dataset.trarxivAuthorInjected === '1') return;
    nameEl.dataset.trarxivAuthorInjected = '1';

    const names = extractAuthorNames(nameEl);
    if (names.length === 0) return;

    // ボタン群は personname の **外** (closest .ltx_creator / .ltx_role の後) に置く。
    // personname 内部に置くと、arxiv 側で当該 span のクリック領域が死んでいる場合に
    // ボタンも反応しなくなる現象がある (MathJax/select オーバーレイ等)。
    const anchor = nameEl.closest('.ltx_creator, .ltx_role') ?? nameEl;

    const wrap = document.createElement('div');
    wrap.className = 'trarxiv-author-btns';

    for (const authorName of names) {
      const item = document.createElement('span');
      item.className = 'trarxiv-author-item';

      const label = document.createElement('span');
      label.className = 'trarxiv-author-name';
      label.textContent = authorName;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'trarxiv-btn trarxiv-author-btn';
      btn.textContent = '🔍';
      btn.title = `${authorName} を調べる`;

      const card = document.createElement('div');
      card.className = 'trarxiv-author-card';
      card.style.display = 'none';

      item.append(label, btn);
      wrap.append(item);

      // card は wrap の直後にではなく、各 item の下にぶら下げる
      const cardWrap = document.createElement('div');
      cardWrap.className = 'trarxiv-author-card-wrap';
      cardWrap.appendChild(card);
      wrap.appendChild(cardWrap);

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        runAuthorResearch(authorName, paperId, paperTitle, btn, card);
      });
    }

    anchor.after(wrap);
  });
}

async function runAuthorResearch(authorName, paperId, paperTitle, btn, card) {
  if (btn.disabled) return;

  // Toggle
  if (card.style.display !== 'none') {
    card.style.display = 'none';
    btn.textContent = '🔍 調べる';
    return;
  }

  if (card.dataset.populated === '1') {
    card.style.display = '';
    btn.textContent = '✕ 閉じる';
    return;
  }

  btn.disabled = true;
  btn.replaceChildren();
  const spinEl = document.createElement('span');
  spinEl.className = 'trarxiv-spinner';
  btn.appendChild(spinEl);

  try {
    const msg = { action: 'authorResearch', authorName, paperTitle, paperId };
    let result = await sendMessage(msg);

    if (result.error === 'NEEDS_PASSWORD') {
      try {
        await ensureKeysUnlocked();
        result = await sendMessage(msg);
      } catch {
        btn.disabled = false;
        btn.textContent = '🔍';
        return;
      }
    }

    if (result.error) throw new Error(result.error);

    renderAuthorCard(card, result, { authorName, paperId });

    card.dataset.populated = '1';
    card.style.display = '';
    btn.disabled = false;
    btn.textContent = '✕';
    btn.title = '閉じる';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '🔍';
    btn.title = `${authorName} を調べる`;
    renderErrorCard(card, err.message);
    setTimeout(() => { card.style.display = 'none'; card.replaceChildren(); }, 6000);
  }
}

function renderErrorCard(container, message) {
  container.replaceChildren();
  const err = document.createElement('span');
  err.style.color = '#dc2626';
  err.textContent = `⚠ ${message}`;
  container.appendChild(err);
  container.style.display = '';
}

// ─── Author research card renderer (Semantic Scholar 構造化データ) ───────────
// A10 拡張: 候補ごとに分野バッジ + 関連度 + 代表論文 + ✓/✗ 選択ボタン +
// 「詳しく見る」で LLM 分析の遅延ロード
function renderAuthorCard(card, result, ctx) {
  card.replaceChildren();
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const currentPaperFields = result?.currentPaperFields ?? [];
  const confirmed = !!result?.confirmed;

  if (candidates.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = '該当する著者情報が見つかりませんでした';
    card.appendChild(empty);
    return;
  }

  // ── 現論文の分野ヘッダ (関連度の根拠) ──
  if (currentPaperFields.length > 0 && !confirmed) {
    const hdr = document.createElement('div');
    hdr.className = 'trarxiv-author-context';
    hdr.textContent = `現論文の分野: ${currentPaperFields.join(', ')}`;
    card.appendChild(hdr);
  }

  // ── 確定済みなら 1 件だけ、それ以外は候補リスト ──
  if (confirmed) {
    const confirmedBanner = document.createElement('div');
    confirmedBanner.className = 'trarxiv-author-confirmed';
    confirmedBanner.textContent = '✓ あなたが確定した候補です';
    card.appendChild(confirmedBanner);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'trarxiv-btn trarxiv-author-dismiss-confirmed';
    dismissBtn.textContent = '↻ 候補を再選択';
    dismissBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await sendMessage({ action: 'authorChoice', paperId: ctx.paperId, authorName: ctx.authorName, action: 'dismiss' });
      // カードを閉じてキャッシュも消えるよう dataset をクリア
      card.replaceChildren();
      card.dataset.populated = '';
      card.style.display = 'none';
      const item = card.closest('.trarxiv-author-item, .trarxiv-author-card-wrap');
      const btnEl = item?.querySelector('.trarxiv-author-btn');
      if (btnEl) {
        btnEl.textContent = '🔍';
        btnEl.title = `${ctx.authorName} を調べる`;
      }
    });
    card.appendChild(dismissBtn);
  }

  // ── 候補一覧 ──
  candidates.forEach((c, i) => {
    const block = document.createElement('div');
    block.className = 'trarxiv-author-candidate';
    if (i === 0 && !confirmed) block.classList.add('top');

    // 名前 + ランク
    const head = document.createElement('div');
    head.className = 'trarxiv-author-cand-head';
    if (!confirmed && candidates.length > 1) {
      const rank = document.createElement('span');
      rank.className = 'trarxiv-author-rank';
      rank.textContent = `#${i + 1}`;
      head.appendChild(rank);
    }
    const nameLink = document.createElement('a');
    nameLink.className = 'trarxiv-author-name-link';
    nameLink.href = c.url ?? `https://www.semanticscholar.org/author/${encodeURIComponent(c.authorId ?? '')}`;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.textContent = c.name ?? '(no name)';
    head.appendChild(nameLink);

    // 関連度バッジ
    if (!confirmed && currentPaperFields.length > 0) {
      const rel = document.createElement('span');
      const pct = Math.round((c.relevanceScore ?? 0) * 100);
      let cls = 'low';
      if (pct >= 50) cls = 'high';
      else if (pct >= 20) cls = 'mid';
      rel.className = `trarxiv-author-relevance ${cls}`;
      rel.textContent = `関連度 ${pct}%`;
      if (Array.isArray(c.matchedFields) && c.matchedFields.length > 0) {
        rel.title = `一致: ${c.matchedFields.join(', ')}`;
      }
      head.appendChild(rel);
    }
    block.appendChild(head);

    // 所属
    if (Array.isArray(c.affiliations) && c.affiliations.length > 0) {
      const aff = document.createElement('div');
      aff.className = 'trarxiv-author-aff';
      aff.textContent = c.affiliations.join(' / ');
      block.appendChild(aff);
    }

    // 統計
    const stats = [];
    if (c.paperCount != null)     stats.push(`論文 ${c.paperCount.toLocaleString()}`);
    if (c.citationCount != null)  stats.push(`被引用 ${c.citationCount.toLocaleString()}`);
    if (c.hIndex != null)         stats.push(`h-index ${c.hIndex}`);
    if (stats.length > 0) {
      const s = document.createElement('div');
      s.className = 'trarxiv-author-cand-stats';
      s.textContent = stats.join(' • ');
      block.appendChild(s);
    }

    // 分野バッジ
    if (Array.isArray(c.fields) && c.fields.length > 0) {
      const fieldsRow = document.createElement('div');
      fieldsRow.className = 'trarxiv-author-fields';
      for (const f of c.fields.slice(0, 5)) {
        const badge = document.createElement('span');
        badge.className = 'trarxiv-author-field-badge';
        if (currentPaperFields.includes(f.field)) badge.classList.add('matched');
        badge.textContent = `${f.field} (${f.count})`;
        fieldsRow.appendChild(badge);
      }
      block.appendChild(fieldsRow);
    }

    // 代表論文 (タイトル+年)
    if (Array.isArray(c.topPapers) && c.topPapers.length > 0) {
      const papHdr = document.createElement('div');
      papHdr.className = 'trarxiv-author-cand-papers-hdr';
      papHdr.textContent = '代表論文:';
      block.appendChild(papHdr);
      const ul = document.createElement('ul');
      ul.className = 'trarxiv-author-cand-papers';
      for (const p of c.topPapers.slice(0, 5)) {
        const li = document.createElement('li');
        const meta = [];
        if (p.year) meta.push(p.year);
        if (p.venue) meta.push(p.venue);
        li.textContent = `${p.title ?? '(no title)'} ${meta.length ? `(${meta.join(', ')})` : ''}`;
        ul.appendChild(li);
      }
      block.appendChild(ul);
    }

    // ── アクション行: 詳しく見る / ✓ / ✗ ──
    if (!confirmed) {
      const actions = document.createElement('div');
      actions.className = 'trarxiv-author-actions';

      // 詳しく見る (LLM 分析)
      if (c.authorId) {
        const analyzeBtn = document.createElement('button');
        analyzeBtn.type = 'button';
        analyzeBtn.className = 'trarxiv-btn trarxiv-author-analyze';
        analyzeBtn.textContent = '🧠 詳しく見る';
        const analysisHolder = document.createElement('div');
        analysisHolder.className = 'trarxiv-author-analysis-holder';
        analyzeBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await loadAuthorAnalysis(analysisHolder, analyzeBtn, c);
        });
        actions.appendChild(analyzeBtn);
        block.appendChild(actions);
        block.appendChild(analysisHolder);
      } else {
        block.appendChild(actions);
      }

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'trarxiv-btn trarxiv-author-confirm';
      confirmBtn.textContent = '✓ この人';
      confirmBtn.title = 'この候補で確定 (次回以降この人だけ表示)';
      confirmBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await sendMessage({
          action: 'authorChoice',
          paperId: ctx.paperId,
          authorName: ctx.authorName,
          action: 'confirm',
          candidate: c,
        });
        // 確定したのでカードを再描画 (確定状態へ)
        renderAuthorCard(card, {
          source: 'semantic-scholar',
          candidates: [c],
          confirmed: true,
        }, ctx);
      });
      actions.appendChild(confirmBtn);

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'trarxiv-btn trarxiv-author-dismiss';
      dismissBtn.textContent = '✗';
      dismissBtn.title = 'この候補を一覧から外す';
      dismissBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        block.style.display = 'none';
      });
      actions.appendChild(dismissBtn);
    }

    card.appendChild(block);
  });

  // ── フッター ──
  const note = document.createElement('div');
  note.className = 'trarxiv-author-note';
  const noteSpan = document.createElement('span');
  noteSpan.textContent = '出典: Semantic Scholar (LLMの推測ではなく実データ)';
  note.appendChild(noteSpan);
  if (result.fromCache) {
    const badge = document.createElement('span');
    badge.className = 'trarxiv-cache-badge';
    badge.textContent = 'キャッシュ';
    note.appendChild(badge);
  }
  card.appendChild(note);
}

async function loadAuthorAnalysis(holder, btn, candidate) {
  if (holder.dataset.state === 'loading' || holder.dataset.state === 'done') return;
  holder.dataset.state = 'loading';
  btn.disabled = true;
  btn.textContent = '🧠 分析中...';

  try {
    let result = await sendMessage({
      action: 'authorAnalysis',
      authorId: candidate.authorId,
      authorName: candidate.name,
      topPapers: candidate.topPapers,
    });

    if (result?.error === 'NEEDS_PASSWORD') {
      try {
        await ensureKeysUnlocked();
        result = await sendMessage({
          action: 'authorAnalysis',
          authorId: candidate.authorId,
          authorName: candidate.name,
          topPapers: candidate.topPapers,
        });
      } catch {
        btn.disabled = false;
        btn.textContent = '🧠 詳しく見る';
        holder.dataset.state = '';
        return;
      }
    }

    if (result?.error) throw new Error(result.error);

    const analysisEl = document.createElement('div');
    analysisEl.className = 'trarxiv-author-analysis';
    analysisEl.textContent = result.analysis ?? '';
    if (result.fromCache) {
      const badge = document.createElement('span');
      badge.className = 'trarxiv-cache-badge';
      badge.textContent = 'キャッシュ';
      analysisEl.appendChild(document.createTextNode(' '));
      analysisEl.appendChild(badge);
    }
    holder.replaceChildren(analysisEl);
    btn.textContent = '🧠 分析済';
    btn.disabled = true;
    holder.dataset.state = 'done';
  } catch (err) {
    const errEl = document.createElement('div');
    errEl.className = 'trarxiv-author-analysis error';
    errEl.textContent = `⚠ ${err.message}`;
    holder.replaceChildren(errEl);
    btn.disabled = false;
    btn.textContent = '🧠 詳しく見る';
    holder.dataset.state = '';
  }
}

// ─── Figure analysis ─────────────────────────────────────────────────────────
function injectFigureButtons(paperId, paperTitle) {
  document.querySelectorAll('figure').forEach(fig => {
    const imgEl = fig.querySelector('img');
    if (!imgEl || !imgEl.src) return;
    if (fig.querySelector('.trarxiv-fig-btn')) return; // already injected

    const btn = document.createElement('button');
    btn.className = 'trarxiv-btn trarxiv-fig-btn';
    btn.textContent = '図を解析';
    btn.title = '画像をAIで解説します';

    const resultEl = document.createElement('div');
    resultEl.className = 'trarxiv-fig-result';
    resultEl.style.display = 'none';

    // Insert button after the figure caption or at end of figure
    const caption = fig.querySelector('figcaption, .ltx_caption');
    if (caption) {
      caption.appendChild(btn);
    } else {
      fig.appendChild(btn);
    }
    fig.appendChild(resultEl);

    btn.addEventListener('click', () => runAnalyzeFigure(fig, imgEl, paperId, paperTitle, btn, resultEl));
  });
}

async function runAnalyzeFigure(fig, imgEl, paperId, paperTitle, btn, resultEl) {
  if (btn.disabled) return;

  // Toggle: hide if already showing
  if (resultEl.style.display !== 'none' && resultEl.dataset.populated === '1') {
    resultEl.style.display = 'none';
    btn.textContent = '図を解析';
    return;
  }

  const caption = fig.querySelector('figcaption, .ltx_caption')?.textContent?.trim() ?? '';
  const imageUrl = imgEl.src;

  btn.disabled = true;
  btn.replaceChildren();
  const figSpin = document.createElement('span');
  figSpin.className = 'trarxiv-spinner';
  btn.append(figSpin, ' 解析中…');

  try {
    const msg = { action: 'analyzeImage', imageUrl, caption, paperTitle, paperId };
    let result = await sendMessage(msg);

    if (result.error === 'NEEDS_PASSWORD') {
      try {
        await ensureKeysUnlocked();
        result = await sendMessage(msg);
      } catch {
        btn.disabled = false;
        btn.textContent = '図を解析';
        return;
      }
    }

    if (result.error) throw new Error(result.error);

    resultEl.replaceChildren();
    const label = document.createElement('div');
    label.className = 'trarxiv-fig-label';
    label.textContent = '🔬 AI解析';
    const text = document.createElement('div');
    text.className = 'trarxiv-fig-text';
    text.textContent = result.content;
    resultEl.appendChild(label);
    resultEl.appendChild(text);
    resultEl.dataset.populated = '1';
    resultEl.style.display = '';

    btn.disabled = false;
    btn.textContent = '✕ 解析を閉じる';
  } catch (err) {
    renderErrorCard(resultEl, err.message);
    setTimeout(() => { resultEl.style.display = 'none'; resultEl.replaceChildren(); }, 6000);
    btn.disabled = false;
    btn.textContent = '図を解析';
  }
}

// ─── Chat context listener ────────────────────────────────────────────────────
function setupContextListener(provider, paperId, paperTitle, sections) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'getPaperContext') {
      sendResponse({
        paperId, title: paperTitle,
        abstract: provider.getAbstract?.() ?? '',
        sections: sections.map(s => ({
          id: s.id, title: s.title,
          text: s.paragraphEls.map(extractText).join('\n')
            .replace(/⟦MATH_\d+⟧/g, '[数式]')
    .replace(/⟦REF:[^⟧]+⟧/g, '[REF]')
            .slice(0, 1000),
        })),
      });
      return true;
    }
  });
}
