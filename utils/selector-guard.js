/**
 * TrArXiv - Selector Guard
 *
 * LLM が動的サイト解析で返した CSS セレクターを保存・使用する前に検査する。
 * 攻撃モデル: ページ側プロンプトインジェクションで LLM が <input type="password">
 * 等の機微要素を指すセレクターを出力 → content.js がその値を「論文本文」として
 * 抽出し LLM プロバイダー API に送信 = 漏出。これを防ぐ。
 */
'use strict';

const MAX_LEN = 200;

// substring (case-insensitive) — どこかに含まれていたら拒否
const FORBIDDEN_SUBSTRINGS = [
  'password', 'passwd', 'pwd', 'pass-word',
  'csrf', 'xsrf', 'token', 'secret', 'apikey', 'api-key', 'api_key',
  'auth', 'credit', 'card-number', 'cardnumber', 'cvv', 'cvc',
  'ssn', 'social-security',
  'session', 'cookie', 'bearer',
  'hidden',           // type="hidden" 系
];

// 単独 (前後が単語境界) で出てきたら拒否するタグ — 機微要素 or 過剰一致
const FORBIDDEN_BARE_TAGS = [
  'input', 'form', 'button', 'select', 'textarea', 'option', 'fieldset',
  'iframe', 'script', 'style', 'meta', 'link',
  'html', 'head', 'body', 'document',
];

// 全選択 (`*`) 単独はもちろん、`* *` 等の過剰一致も拒否
const UNIVERSAL_ONLY = /^\s*\*+(\s*[>+~]\s*\*+)*\s*$/;

/**
 * @param {unknown} sel 検査対象。null / undefined / 空文字は「指定なし」として null を返す
 * @returns {string|null} サニタイズ済みセレクター。null は「使用しない」を意味する
 * @throws {Error} 危険パターンを検出した場合
 */
export function validateSelector(sel) {
  if (sel == null) return null;
  if (typeof sel !== 'string') {
    throw new Error(`セレクターが文字列ではありません (${typeof sel})`);
  }
  const trimmed = sel.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  if (trimmed.length > MAX_LEN) {
    throw new Error(`セレクターが長すぎます (${trimmed.length} > ${MAX_LEN})`);
  }
  if (UNIVERSAL_ONLY.test(trimmed)) {
    throw new Error(`過剰一致セレクター "${trimmed}" は拒否されました`);
  }

  const lower = trimmed.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(bad)) {
      throw new Error(`機微要素を指す可能性のあるセレクター "${trimmed}" は拒否されました (${bad})`);
    }
  }
  for (const tag of FORBIDDEN_BARE_TAGS) {
    const re = new RegExp(`(^|[\\s,>+~(])${tag}(?=$|[\\s,>+~.#:\\[])`, 'i');
    if (re.test(trimmed)) {
      throw new Error(`機微要素/過剰一致タグ "${tag}" を含むセレクター "${trimmed}" は拒否されました`);
    }
  }

  // 制御文字・改行禁止 (タブはタイプミスでもまず出ないので含めて拒否)
  if (/[\x00-\x1f]/.test(trimmed)) {
    throw new Error('セレクターに制御文字が含まれています');
  }
  // 属性セレクター内に JS スキーム (data:, javascript:) — 普通使わないので拒否
  if (/\[\s*[a-z-]+\s*[*^$|~]?=\s*["']?\s*(javascript|data|vbscript):/i.test(trimmed)) {
    throw new Error(`危険なスキームを含む属性セレクターは拒否されました`);
  }

  return trimmed;
}

/**
 * 設定オブジェクトに含まれるセレクター群を一括検証して新オブジェクトを返す。
 * 1 つでも危険判定なら全体を reject する (部分的に保存しない)。
 *
 * @param {object} cfg LLM が返した site config (titleSel, abstractSel, sectionSel, headingSel, paragraphSel)
 * @returns {object} 検証済み新オブジェクト
 * @throws {Error} 危険セレクター検出時
 */
export function validateSiteConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('サイト設定が不正です');
  }
  const out = { ...cfg };
  for (const key of ['titleSel', 'abstractSel', 'sectionSel', 'headingSel', 'paragraphSel']) {
    out[key] = validateSelector(cfg[key]);
  }
  return out;
}
