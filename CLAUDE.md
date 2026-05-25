# TrArXiv — Claude Code 作業コンテキスト

このファイルは Claude Code が起動時に自動で読み込みます。別環境・別セッションからでも前回の続きから作業できるよう、設計方針・ロードマップ・進捗状況を集約しています。

## プロジェクト概要

ArXiv をはじめとする論文 HTML を LLM で翻訳・解説する Chrome 拡張 (Manifest V3)。個人配布・非公開、ユーザー = 開発者本人 (ntaka-ti) のみ。外部依存ゼロ・ビルドなし・バニラ JS 実装。

- リポジトリ: https://github.com/Nao-Taka/TRarXiv
- 現バージョン: **v0.2.0 + v0.3.0 + v0.4.0 部分 が概ね完了** (v0.5.0 として継続: A9/A13/A14強化が残)

## ファイル構成

```
manifest.json         # MV3, content_scripts:
                     #   arxiv.org/html/* / arxiv.org/abs/*
                     #   ar5iv.org/* / ar5iv.labs.arxiv.org/*
                     # host_permissions: api.semanticscholar.org/* も含む
                     # optional_host_permissions: https://*/*
                     # CSP: extension_pages に script-src 'self'; object-src 'none' 明示

background.js        # Service Worker — LLM呼び出し・キャッシュ・鍵管理・サイト解析・
                     # 著者検索 (S2)・論文位置づけ・参考文献要約・著者選択保存

llm/
  llm-client.js      # createClient() + complete() + completeWithImage()
  openai.js          # OpenAI / Gemini / OpenRouter / Local 共通
  anthropic.js       # Anthropic (dangerous-direct-browser-access ヘッダ使用)

utils/
  cache.js           # LRU キャッシュ (chrome.storage.local)
  crypto.js          # PBKDF2 200k iter + AES-256-GCM
  token-tracker.js   # モデル別トークン・コスト記録
  library.js         # 論文ライブラリ
  site-configs.js    # 動的サイト設定 (chrome.storage.sync)
  selector-guard.js  # 【A4】LLM が返した CSS セレクターを保存前に検査
                     # (password/csrf/hidden/input等の機微要素拒否)
  semantic-scholar.js# 【A10/A11/A14】Semantic Scholar API クライアント:
                     #   searchAuthor / getAuthorPapers / fetchAuthorInfo (関連度算出)
                     #   getPaperFieldsOfStudy / getPaperByArxivId / fetchPaperContext
                     #   getReferences / getCitations / getRecommendations
                     #   searchPaperByTitle (ref 要約用)

content/content.js   # DOM操作・ボタン注入・翻訳表示・動的プロバイダー
                     # arxiv html / arxiv abs / ar5iv の 3 系統を 1 つの provider で
                     # ハンドル (canHandle 正規表現で URL 分岐)
popup/popup.js       # チャット + サイト解析 UI
                     # arxiv.org/(html|abs)/ + ar5iv.* で chat mode に
options/options.js   # 設定ページ
```

## 主要設計

### 翻訳系の基本フロー
- **プロバイダーパターン**: `content.js` の `PROVIDERS` 配列で対応サイトを宣言。未対応サイトは `chrome.storage.sync` の設定から動的に生成
- **LLM抽象化**: OpenAI互換 (OpenAI / Gemini / OpenRouter / Local Ollama) + Anthropic の2クライアント
- **文単位翻訳**: 段落→文分割 (`splitSentences`、略語保護)→番号付きでLLM送信→番号で英日対応
- **バッチ並列**: 5段落並列 `Promise.all`、batchごとに進捗を content にプッシュ
- **キャッシュキー**: `trarxiv:cache:{type}:{paperId}:{sectionId}` (LRU、`QUOTA_BYTES` 時に古いものから削除)
- **APIキー暗号化**: PBKDF2 200k iter + AES-256-GCM。復号後は `chrome.storage.session` に常駐 (Chrome終了でクリア)
- **動的サイト**: LLM が DOM サマリから CSS セレクター推定 → `chrome.scripting.registerContentScripts` で動的登録 → セレクターは A4 でホワイトリスト検証してから保存

### プレースホルダ方式 (A7 / A14)
- **数式 (A7)**: `extractText()` で数式要素を `⟦MATH_N⟧` トークンに置換 (top-level math のみ、入れ子は除外して index 整合維持)。LLM に「トークン保持」と指示、翻訳後に paragraphEl から数式 DOM をクローンして埋め戻す。LLM が数式を読まないのでトークン消費ゼロ
- **参考文献 (A14)**: `<a href="#bib.bibN">` を `⟦REF:X⟧` プレースホルダ (X = 末尾ID) に置換し文単位で追跡。和訳ペア直下にミニ参考文献リスト (タイトル + 著者 + 年)。ホバー (500ms 遅延) で S2 paper search → abstract → LLM 1〜2文要約。translate プロンプトに「⟦MATH_N⟧ / ⟦REF:X⟧ は保持」を明示
- **解説/チャット**: ⟦MATH_N⟧ / ⟦REF:X⟧ は `[数式]` / `[REF]` に置換してから LLM に送る (位置情報不要なため)

### 著者検索 (A10 + 拡張)
- **基本**: Semantic Scholar `/author/search` で上位3候補。失敗時 LLM フォールバックなし、エラー明示
- **拡張**: 各候補ごとに `getAuthorPapers` で代表論文5本取得 (並列)。`s2FieldsOfStudy` 集計で「分野」を割り出し。現論文 (arxiv ID 経由で `getPaperFieldsOfStudy`) との **Jaccard 類似度** で `relevanceScore` を算出、降順ソート
- **ユーザー確認**: 各候補に「✓ この人 / ✗ / 🧠 詳しく見る」。「✓」を押すと `chrome.storage.local` に `trarxiv:authorchoice:{paperId}::{authorName}` で保存、次回以降は確定候補のみ表示。`↻ 候補を再選択` で確定解除
- **LLM分析 (遅延ロード)**: 「🧠 詳しく見る」押下時のみ `handleAuthorAnalysis` を呼ぶ。代表論文5本を1プロンプトで送り「各論文の1行要約 + 研究スタンス」を一括取得。キャッシュ kind=`authoranalysis`
- **キャッシュ key 分離**: 同名でも論文 ID / 確定 authorId が違えば別キャッシュ (`s2::{currentArxivId}::{choiceAuthorId}`)

### 論文の位置づけ (A11)
- `fetchPaperContext(arxivId)`: `/paper/arXiv:{id}` でメタ取得 → `/references`, `/citations`, `/recommendations` を `Promise.allSettled` で並列、部分失敗は `errors` に記録して続行
- LLM で 4 観点分析: 立ち位置 / 先行研究との関係 / 後続への影響 / 次に読むべき論文
- **チャット強化**: `handleChat` が `cache.get('related', paperId, 'main')` を覗き、位置づけを一度開いた論文では関連論文を chat の system prompt に自動注入 (「次に読むべき論文は?」等に答えられる)

### セキュリティ多重防御 (A1〜A5)
- **A1 (XSS)**: 全 `innerHTML` の LLM 出力流入を `textContent` + DOM API に。CSP `extension_pages` 明示
- **A2 (権限)**: `optional_host_permissions: <all_urls>` → `https://*/*` に縮小。サイト設定削除時に `chrome.permissions.remove` で host permission も revoke
- **A3 (SSRF)**: `handleAnalyzeImage` で `assertPublicHttpUrl()`。loopback/private/link-local/.local/.internal を全部拒否、IPv4-mapped IPv6 も再帰
- **A4 (漏出)**: LLM が返した CSS セレクターを `utils/selector-guard.js` で検査。`password/csrf/hidden/auth/token`等のキーワード、`input/form/textarea/iframe/body`等の機微タグ単独、`*`過剰一致、制御文字、危険スキームを全部拒否。background と content の両方で検査 (二重防御)
- **A5 (Anthropic警告)**: `options.html` の Anthropic セクション冒頭に非推奨化バナー

## 開発方針

### 後方互換よりセキュリティ優先
個人配布・既存ユーザー = 開発者本人のみのため、storage マイグレーションや旧データ互換コードは作り込まない。問題があれば拡張アンインストール (→storage 全消去) で対応。**A6 が保留扱いなのもこのため**: 「拡張を Remove して再インストール」で完全初期化される。

### 失敗時はLLMフォールバックせずエラー明示
外部API (Semantic Scholar 等) が失敗した時、LLM の学習データから情報を生成するフォールバックは実装しない。「取得できませんでした」と明示する。事実主張のハルシネーションを避ける方針。

### message listener は同期登録
content script の `chrome.runtime.onMessage.addListener()` は **モジュール最上位で同期登録** すること。init() 内の `await` 後に登録すると、popup から `chrome.tabs.sendMessage` を投げたタイミングで競合し「Receiving end does not exist」が出る。`_paperContextSupplier` クロージャ経由で実データは init() 後にセットする (現状の content.js の参考実装あり)。

## ロードマップ

### v0.2.0 — Safer & Smarter ✅ (A6 のみ保留)

| # | アクション | なぜ | 状態 | 編集対象 |
|---|---|---|---|---|
| **A1** | popup XSS 全廃 + CSP明示 | LLM 出力が `innerHTML` 経由で popup/content/options に流入 → スクリプト注入されるリスクを断つ | ✅ 完了 | popup.js / content.js / options.js / manifest.json |
| **A2** | `<all_urls>` 撤廃 + ドメイン単位許可 | 万一の侵害時に銀行など未知サイトで暴走しないよう、optional_host_permissions を狭め、サイト設定削除時に Chrome 権限も revoke | ✅ 完了 | manifest.json / background.js / popup.js |
| **A3** | 画像 fetch URL検証 (SSRF防止) | `imageUrl` 引数に `127.0.0.1` / `169.254.169.254` 等を仕込まれて内部資源が侵害されるのを防ぐ | ✅ 完了 | background.js (handleAnalyzeImage) |
| **A4** | LLMセレクター検証 | プロンプトインジェクションで LLM が `input[type=password]` 等 機微要素を指すセレクターを返すと、その値が「論文本文」として LLM API に**漏出**する | ✅ 完了 | utils/selector-guard.js / background.js / content.js |
| **A5** | Anthropic 警告バナー | Anthropic がブラウザ直叩き (`dangerous-direct-browser-access`) を非推奨化 | ✅ 完了 | options.html |
| **A6** | データ管理UI (3段階リセット) | A1〜A5 以前のコードで保存された侵害リスクのある既存データを段階的にクリア (※拡張アンインストールで storage 全消去なので、再インストールで代替可能) | ⏸ 保留 | options.* |
| **A7** | 数式プレースホルダ復元 (`⟦MATH_N⟧`) | `[数式]` 置換で破棄され、和訳側に数式が出ず読解不十分 | ✅ 完了 | content.js / content.css / background.js |

### v0.3.0 — Wider & Deeper ✅ (A9 のみ未着手)

| # | アクション | なぜ | 状態 | 編集対象 |
|---|---|---|---|---|
| **A8** | arxiv.org/abs ページサポート | やや古い ArXiv 論文は HTML 版リンクがなく PDF 強制。ar5iv 経由ボタンと abs ページでのブリーフィング・位置づけを提供。ar5iv 統合済 (構造が LaTeXML で同じため canHandle 正規表現を拡張) | ✅ 完了 | manifest.json / content.js |
| **A9** | T5 第1陣 (bioRxiv, medRxiv, PMC, OpenReview, ACL Anthology) | 動的解析でも一応動くが、よく使うサイトは静的設定で表現力・安定性を上げたい | ⏳ 未着手 | content.js PROVIDERS / manifest.json |
| **A10** | Semantic Scholar 著者検索 + 分野推定 + 関連度 + ユーザー確認 UI | LLM 幻覚を実データに置換 + 同名研究者の判別 (分野/関連度) + ✓/✗ 選択保存 + 🧠 LLM分析 (代表論文1行要約 + 研究スタンス、遅延ロード) | ✅ 完了 | utils/semantic-scholar.js / background.js / content.js / content.css |
| **A11** | 論文の位置づけ + 関連論文 + チャット強化 | 「次に読む論文」「全体の中での位置づけ」で論文を有機的に評価 | ✅ 完了 | background.js / content.js / utils/semantic-scholar.js |

### v0.4.0 — Reading Companion (A13 未, A14 強化が残)

| # | アクション | なぜ | 状態 | 編集対象 |
|---|---|---|---|---|
| **A13** | T5 第2陣 (Nature, Cell, eLife, PLOS) | A9 と同じく対応サイト拡大 | ⏳ 未着手 | content.js PROVIDERS |
| **A14** | インライン参考文献注釈 + ホバー詳細 | 参考文献にいちいち飛ぶのが面倒。和訳ペア直下に著者/タイトル常時表示 + ホバーで abstract 要約 | ✅ 基本完了 | content.js / content.css / background.js / utils/semantic-scholar.js |

### 保留

- **A12** Cloudflare Workers プロキシ対応 — Anthropic キー漏洩の根本対策だが、ユーザー (=自分) が運用を理解できないため将来検討

## セキュリティ監査 (2026-05-25 実施、先入観なし再走査)

A1-A5 で対処済の領域は除いた **追加の懸念点**。優先順位は「拡張内部での攻撃成立可能性」「実装規模」のバランスで判定。

### 🔴 Medium — 取り組む価値あり

#### S1. 論文本文経由のプロンプトインジェクション
- 経路: arxiv 投稿論文の本文 → `extractText()` → `translateParagraph()` の user message に素のまま埋め込み
- 攻撃の主な影響:
  - 翻訳結果の改ざん (機能を壊す)
  - **`handleChat` で paperContext + chat history が一緒に system prompt に入る**ため、悪意あるテキストで chat 履歴を引き出される可能性
- API キーは `Authorization` ヘッダで LLM 側に渡るので、LLM のメッセージ内には現れない → キー直接漏出はなし
- 対策案: 翻訳 prompt に「以下は untrusted な文書本文」と明示し XML タグ等で区切る

#### S2. サイズ上限なし → DoS / コスト爆発
- `paragraphs` 配列, `refinementHistory` (popup), `conversationHistory` (popup) いずれも蓄積に上限なし
- 巨大論文 / 長セッションで `chrome.runtime.sendMessage` が肥大、LLM プロンプトも巨大化 (請求事故)
- `handleExplain` の `text.slice(0, 8000)` や `handleAuthorAnalysis` の `abstract 500 文字 × 5` のような **個別上限はある** が、全体ガードがない
- 対策案: history を `.slice(-20)` などで上限化、paragraphs はバッチ分割

#### S3. 外部 URL を `.href` に検証なしで代入 (defense-in-depth)
- 場所:
  - `content.js` 著者カード: `nameLink.href = c.url` / `hp.href = top.homepage`
  - 関連論文カード: `a.href = p.url`
  - refSummary: `link.href = result.s2Url`
- すべて Semantic Scholar API レスポンスから取得。S2 が compromise されて `javascript:fetch(...)` を返した場合、ユーザーのクリックで **arxiv.org の origin** で JS 実行 (`rel="noopener noreferrer"` は javascript: スキームを防げない)
- 対策案: `safeExternalHref(url)` ヘルパーを作り `https?:` のみ受理、それ以外は `#` 等にフォールバック

### 🟡 Low

#### S4. Anthropic ブラウザ直叩き (A5 で警告済)
`dangerous-direct-browser-access: true` でキーがブラウザメモリに常駐。chrome 拡張は他拡張と完全分離されているので隣から取られはしないが、ローカルマルウェアからは脆弱。根本対策は A12 (Cloudflare Workers プロキシ) — 個人運用上保留

#### S5. PBKDF2 200k は妥当だがパスワード強度未強制
ユーザーが弱いマスターパスワードを設定可能。`chrome.storage.sync` で encrypted key が他デバイスに同期されるため、Google 垢侵害 + 弱パスワード = オフライン総当たり成立。対策: 最低文字数チェック追加

#### S6. `⟦MATH_N⟧` / `⟦REF:X⟧` トークン衝突
論文本文に偶然このリテラルを含む論文があればレンダリング時に置換暴走。実害は誤動作のみ、極めて稀

#### S7. `splitSentences` の NUL 文字 (`\x00`) を略語マーカに使用
論文本文に NUL があると略語復元が壊れる。HTML テキストではほぼ皆無

#### S8. `paperTokensMap` は SW 寿命のみ
Service Worker 休眠で予算累計がリセット → 予算チェックが甘くなる。token-tracker (永続化) はあるので致命傷ではないが、予算機能としては不完全

#### S9. JSON 抽出が greedy regex `/\{[\s\S]*\}/`
LLM が複数 JSON ブロックを返したとき最初の `{` から最後の `}` まで貪欲マッチ → 不正 JSON → catch で null fallback。安全だが意図と違う結果になりうる

### 🟢 既対策確認済 (再走査結果)
- popup/content/options の XSS (A1)
- 銀行サイト等での暴走 (A2 + per-domain permission)
- 画像 fetch SSRF (A3 `assertPublicHttpUrl`)
- LLM 漏出セレクター (A4 `selector-guard.js`)
- 他拡張からの message 注入: `externally_connectable` 未宣言で不可
- LLM 出力 → DOM XSS: `textContent` + DOM API 徹底
- cache の sync 誤同期: cache.js は常に `chrome.storage.local` のみ

## 翻訳パイプラインの記録 (実装の現状)

```
[content.js]
  provider.getSections() → [{id, title, headingEl, paragraphEls, element}]
  ↓
  extractText(paragraphEl):
    cloneNode(true) → top-level math を ⟦MATH_N⟧ に置換 → <a href="#bib*"> を ⟦REF:X⟧ に置換
    → .ltx_biblio/.ltx_footnote 除去 → 空白正規化 → trim
  ↓
  paragraphs = [{id, text}]
  checkTokenBudget() で見積もり (input ≈ N*280 + chars/3.5, output ≈ chars/2.5)
  ↓ chrome.runtime.sendMessage({action: 'translate', paperId, sectionId, paragraphs, forceRefresh})

[background.js handleTranslate]
  キャッシュ確認 (trarxiv:cache:trans:{paperId}:{sectionId})
  ↓ MISS なら
  5段落バッチ並列 Promise.all → 各段落で translateParagraph:
    splitSentences (NUL マーカで略語保護、'. [A-Z"(]' で分割)
    → 番号付き user message ("1. ...\n2. ...")
    → system prompt 「⟦MATH_N⟧/⟦REF:X⟧ は保持」
    → LLM
    → parseNumberedTranslation で 4 種の番号フォーマット対応 (1./(1)/①/1,)
    → 一致しなければ行順 fallback
  バッチごとに _translateProgress を tab に送信
  ↓ 完了したら addPaperTokens で paper 別累計、token-tracker に記録
  キャッシュに保存
  ↓ {results: [{paraId, pairs: [{en, ja}]}], fromCache, limitExceeded}

[content.js insertTranslationBlock]
  各 pair を <div class="trarxiv-pair">[en + ja] でラップ
  appendTextWithMathAndRefs() でトークン展開:
    ⟦MATH_N⟧ → paragraphEl からクローンした実 math DOM
    ⟦REF:X⟧  → <sup><a href="#bib.bibX">[X]</a></sup>
  A14: ペア直下に buildInlineRefList() で参考文献小リスト (ホバーで abstract 要約遅延ロード)
  insert after paragraphEl
```

### 設計上の重要不変条件
- **`selectTopLevelMath()` を `extractText` と `collectMathClones` の双方で使用** → math index がずれない
- **`bibMap` はページごとに一度だけ構築** (`init()` 内で `_bibMap` にキャッシュ)
- **再翻訳ボタン**: `btn.dataset.translated = '1'` のあと次回クリックは `forceRefresh: true` でキャッシュバイパス
- **MV3 SW 休眠対策**: `progressHandlers` Map は SW 側ではなく content 側、SW 死んでも UI は復活する (ただし進行中翻訳は中断)

## 次に着手すべきタスク (v0.5.0 候補)

### セキュリティ追加対策 (上の監査結果より)
1. **S3** 外部 URL の `https?:` スキーム検証ヘルパー (小、効果大、最優先)
2. **S2** history/paragraphs サイズ上限 (小)
3. **S1** 翻訳プロンプトに untrusted 区切り追加 (中)
4. **S5** マスターパスワード最低強度チェック (小)
5. **S8** token tracker に paperId 別永続化 (中)

### 機能追加

1. **A14 強化 — 参考文献の多様性対応** (高優先度)
   - 現状の `buildBibliographyMap()` は `.ltx_bib_title` / `.ltx_bib_author` / `.ltx_bib_year` 構造化フィールド前提。arxiv.org/html や ar5iv の **`.ltx_bibblock` 連続**スタイルではフォールバックして textContent.slice(150) になっており、タイトル/著者/年が分離できていない
   - ar5iv の例: `<li class="ltx_bibitem"><span class="ltx_tag">Ahn et al. (2022)</span><span class="ltx_bibblock">Michael Ahn, ...</span><span class="ltx_bibblock"><a>Do as I can ...</a></span><span class="ltx_bibblock"><em>arXiv preprint ...</em></span></li>`
   - **構文ベース** (LLM 解析ではなく) で複数パターンに対応:
     - `.ltx_tag` から「Author et al. (Year)」を抽出
     - `.ltx_bibblock` 連続の場合: 1番目=著者, タイトルは `<a>` 内 or 2番目, 雑誌は `<em>` 内 のヒューリスティック
     - クラス無しスタイル (古い arxiv) にも対応
   - 本文中の引用パターンも `[N]` / `Author et al., Year` / `(Author, Year)` / `<cite>` タグ など複数パターン対応
   - 段落単位で参考文献を集約

2. **A9 T5 第1陣** (中優先度) — bioRxiv / medRxiv / PMC / OpenReview / ACL Anthology を静的 PROVIDERS に追加

3. **A13 T5 第2陣** — Nature / Cell / eLife / PLOS

## 完了内容のサマリ (コミット粒度)

- A1: popup/content/options の `innerHTML` を全廃、CSP 明示
- A2: `<all_urls>` → `https://*/*`、削除時に host permission revoke
- A3: SSRF ガード (loopback/private/link-local/メタデータ全部拒否)
- A4: 新規 utils/selector-guard.js、background/content 両方で検査
- A5: Anthropic 警告バナー
- A7: 数式 `⟦MATH_N⟧` プレースホルダ + 復元
- A8: arxiv abs ページ対応 + ar5iv 統合 (Access Paper リストにボタン配置)
- A10: S2 著者検索 + 分野/関連度/ユーザー確認 UI + LLM 分析 (遅延)
- A11: 関連論文 (refs/cites/recommendations) + LLM 位置づけ分析 + chat 強化
- A14: ⟦REF:X⟧ プレースホルダ + ペア下ミニ参考文献 + ホバー abstract 要約

### バグ修正 (今日のセッションで完了)

- **🔍 著者ボタンが押せない問題**: arxiv の `.ltx_personname` 内に直接 append していたボタンが、何らかの理由 (MathJax/select overlay 等) でクリック領域が死ぬケースに巻き込まれていた。対処として:
  - `extractAuthorNames()` で改行/2+スペース/カンマ/'and' 分割により個別著者名を抽出 (ar5iv の「全著者を1つの personname に詰める」形式も分離)
  - ボタン群を personname の **外** (closest `.ltx_creator/.ltx_role` の後) に配置
  - CSS で `pointer-events: auto !important; position: relative; z-index: 10`
  - click ハンドラに `preventDefault` / `stopPropagation`

- **"Receiving end does not exist" エラー**: content の getPaperContext リスナーが `setupContextListener` 関数内で登録されており、init() の `await` の後に走るため、popup から早期に message を投げると競合。対処:
  - リスナーをモジュール最上位で **同期登録**
  - 実データは `_paperContextSupplier` クロージャ経由で init() 完了時にセット
  - `setupContextListener` を `sections.length === 0` early return の **前** に移動
  - popup.js URL 判定を arxiv.org/abs と ar5iv.* も含むように拡張

- **abs ページのリンクボタン配置**: 当初 title 下に置いていたが、`.full-text ul` (View PDF / TeX Source の並び) に `<li>` として追加するほうが UX 的に自然。`abs-button` クラスを使い arxiv 標準スタイルを継承

## リポジトリ規約

- **コミット粒度**: 1 アクション = 1 コミット (関連の小修正は同コミットに含める)
- **ブランチ戦略**: main 直接コミット (個人開発のため)
- **コミットメッセージ**: 日本語/英語混在可、件名は変更の意図を1行で
- **テスト**: 自動テストなし。各リリース前に「ArXiv翻訳 / 解説 / ブリーフィング / 著者リサーチ / 図解析 / チャット / 位置づけ / 参考文献ホバー」のスモークテストを手動実施
- **Git auth**: リポジトリ owner は `Nao-Taka` だが、push 用の認証は `ntaka-ti` アカウント (会社 PAT)。両者は別アカウント (`ntaka-ti` が `Nao-Taka/TRarXiv` の Collaborator として招待されている)

## 次セッションへの引き継ぎ

このファイルがある = Claude Code は自動でロードマップを把握できる。`git log --oneline` で完了済みコミットを確認し、ロードマップ表の「状態」と照合して次のアクションに着手すれば良い。

進行中のアクションがある場合は、コミット前にこのファイルの該当アクションを `🚧 進行中` にマークする運用にすると分かりやすい。

ユーザーは Chrome 拡張のローカル開発 (`chrome://extensions` の Load unpacked) で動作確認。**チャット履歴は保存されない** ので、設計議論は CLAUDE.md に書き残すこと。
