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

// ─── Paper search (A14: ref summary 用) ─────────────────────────────────────
/**
 * タイトルで論文検索。abstract を含む fields を要求する。
 * @param {string} title
 * @param {{limit?: number}} [opts]
 */
export async function searchPaperByTitle(title, { limit = 1 } = {}) {
  if (!title) throw new Error('検索クエリが空です');
  const url = new URL(`${BASE}/paper/search`);
  url.searchParams.set('query', title);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', 'title,abstract,year,authors.name,paperId,url,venue');
  const data = await s2Fetch(url.toString());
  return data?.data ?? [];
}

// ─── Paper context (A11: 位置づけ + 関連論文) ────────────────────────────────

const PAPER_FIELDS = 'title,year,venue,citationCount,authors.name';

async function s2Fetch(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (res.status === 429) throw new Error('Semantic Scholar APIのレート制限');
  if (!res.ok) throw new Error(`Semantic Scholar API (HTTP ${res.status})`);
  return res.json();
}

/**
 * arXiv ID から Semantic Scholar paper を取得
 * @param {string} arxivId 'XXXX.YYYYY' or 'cs.AI/0001001' 形式
 */
export async function getPaperByArxivId(arxivId) {
  const url = new URL(`${BASE}/paper/arXiv:${arxivId}`);
  url.searchParams.set('fields', 'paperId,title,year,venue,citationCount,referenceCount,influentialCitationCount');
  return s2Fetch(url.toString());
}

export async function getReferences(paperId, { limit = 10 } = {}) {
  const url = new URL(`${BASE}/paper/${encodeURIComponent(paperId)}/references`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', PAPER_FIELDS);
  const data = await s2Fetch(url.toString());
  return (data?.data ?? []).map(d => d.citedPaper).filter(Boolean);
}

export async function getCitations(paperId, { limit = 10 } = {}) {
  const url = new URL(`${BASE}/paper/${encodeURIComponent(paperId)}/citations`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', PAPER_FIELDS);
  const data = await s2Fetch(url.toString());
  return (data?.data ?? []).map(d => d.citingPaper).filter(Boolean);
}

export async function getRecommendations(paperId, { limit = 5 } = {}) {
  // recommendations は別エンドポイント (recommendations/v1)
  const url = new URL(
    `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}`
  );
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', PAPER_FIELDS);
  const data = await s2Fetch(url.toString());
  return data?.recommendedPapers ?? [];
}

/**
 * arXiv ID から関連論文情報を一括取得。
 * 各サブ取得は Promise.allSettled で並列実行し、部分失敗を許容。
 *
 * @param {string} arxivId
 * @returns {Promise<{paper, references, citations, recommendations, errors}>}
 */
export async function fetchPaperContext(arxivId) {
  const paper = await getPaperByArxivId(arxivId);
  if (!paper?.paperId) throw new Error('論文IDが取得できませんでした');

  const [refsR, citesR, recsR] = await Promise.allSettled([
    getReferences(paper.paperId, { limit: 10 }),
    getCitations(paper.paperId, { limit: 10 }),
    getRecommendations(paper.paperId, { limit: 5 }),
  ]);

  const errors = {};
  if (refsR.status === 'rejected')  errors.references = refsR.reason?.message ?? 'unknown';
  if (citesR.status === 'rejected') errors.citations  = citesR.reason?.message ?? 'unknown';
  if (recsR.status === 'rejected')  errors.recommendations = recsR.reason?.message ?? 'unknown';

  return {
    paper,
    references:      refsR.status  === 'fulfilled' ? refsR.value  : [],
    citations:       citesR.status === 'fulfilled' ? citesR.value : [],
    recommendations: recsR.status  === 'fulfilled' ? recsR.value  : [],
    errors,
  };
}
