/**
 * TrArXiv - Semantic Scholar API client
 *
 * Web 検索ベースの著者リサーチ。LLM の学習データから幻覚で返すのではなく、
 * Semantic Scholar の構造化データを取得する。失敗時はエラーを明示し、
 * LLM フォールバックは行わない (事実主張のハルシネーション回避方針)。
 *
 * 公開 API のため API キー不要だが、レート制限あり (5000 req / 5min / IP)。
 */
'use strict';

const BASE = 'https://api.semanticscholar.org/graph/v1';

/**
 * 著者名で検索。上位 limit 件を返す。
 * @param {string} name
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array>} S2 author 配列
 * @throws {Error} API エラー / 結果ゼロ
 */
export async function searchAuthor(name, { limit = 3 } = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('著者名が指定されていません');
  }

  const url = new URL(`${BASE}/author/search`);
  url.searchParams.set('query', name);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set(
    'fields',
    'name,affiliations,paperCount,citationCount,hIndex,homepage,url'
  );

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
  });

  if (res.status === 429) {
    throw new Error('Semantic Scholar APIのレート制限に達しました。少し待って再試行してください。');
  }
  if (!res.ok) {
    throw new Error(`Semantic Scholar APIエラー (HTTP ${res.status})`);
  }

  const data = await res.json();
  const authors = Array.isArray(data?.data) ? data.data : [];
  if (authors.length === 0) {
    throw new Error(`「${name}」に該当する著者が Semantic Scholar 上で見つかりませんでした`);
  }
  return authors;
}

/**
 * 著者IDから最新論文を取得。
 * @param {string} authorId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array>} papers 配列
 */
export async function getAuthorPapers(authorId, { limit = 5 } = {}) {
  if (!authorId) throw new Error('著者IDが指定されていません');

  const url = new URL(`${BASE}/author/${encodeURIComponent(authorId)}/papers`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', 'title,year,venue,citationCount');

  const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Semantic Scholar API (papers) エラー (HTTP ${res.status})`);

  const data = await res.json();
  const papers = Array.isArray(data?.data) ? data.data : [];
  // 新しい順
  papers.sort((a, b) => (b?.year ?? 0) - (a?.year ?? 0));
  return papers.slice(0, limit);
}

/**
 * 著者情報を一括取得 (検索 + 最良マッチの papers)。
 * 戻り値は content.js で構造的に描画する想定。
 *
 * @param {string} authorName
 * @returns {Promise<{
 *   candidates: Array<{name, affiliations, paperCount, citationCount, hIndex, homepage, url, authorId}>,
 *   topPapers: Array<{title, year, venue, citationCount}>,
 * }>}
 */
export async function fetchAuthorInfo(authorName) {
  const candidates = await searchAuthor(authorName, { limit: 3 });
  const top = candidates[0];
  let topPapers = [];
  if (top?.authorId) {
    try {
      topPapers = await getAuthorPapers(top.authorId, { limit: 5 });
    } catch (e) {
      // 論文一覧取得失敗は致命的ではない (候補情報だけでも返す)
      console.warn('[TrArXiv] getAuthorPapers failed:', e?.message);
    }
  }
  return { candidates, topPapers };
}
