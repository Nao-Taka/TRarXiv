# TrArXiv — Claude Code 作業コンテキスト

このファイルは Claude Code が起動時に自動で読み込みます。別環境・別セッションからでも前回の続きから作業できるよう、設計方針・ロードマップ・進捗状況を集約しています。

## プロジェクト概要

ArXiv をはじめとする論文 HTML を LLM で翻訳・解説する Chrome 拡張 (Manifest V3)。個人配布・非公開、ユーザー = 開発者本人 (ntaka-ti) のみ。外部依存ゼロ・ビルドなし・バニラ JS 実装。

- リポジトリ: https://github.com/Nao-Taka/TRarXiv
- 現バージョン: v0.1.0 (リリース済み) → v0.2.0 開発中

## ファイル構成

```
manifest.json         # MV3, content_scripts: arxiv.org/html/*, CSP明示
background.js         # Service Worker — LLM呼び出し・キャッシュ・鍵管理・サイト解析
llm/
  llm-client.js       # createClient() + complete() + completeWithImage()
  openai.js           # OpenAI / Gemini / OpenRouter / Local 共通
  anthropic.js        # Anthropic (dangerous-direct-browser-access ヘッダ使用)
utils/
  cache.js            # LRU キャッシュ (chrome.storage.local)
  crypto.js           # PBKDF2 200k iter + AES-256-GCM
  token-tracker.js    # モデル別トークン・コスト記録
  library.js          # 論文ライブラリ
  site-configs.js     # 動的サイト設定 (chrome.storage.sync)
content/content.js    # DOM操作・ボタン注入・翻訳表示・動的プロバイダー
popup/popup.js        # チャット + サイト解析 UI
options/options.js    # 設定ページ
```

## 主要設計

- **プロバイダーパターン**: `content.js` の `PROVIDERS` 配列で対応サイトを宣言。未対応サイトは `chrome.storage.sync` の設定から動的に生成
- **LLM抽象化**: OpenAI互換 (OpenAI / Gemini / OpenRouter / Local Ollama) + Anthropic の2クライアント
- **文単位翻訳**: 段落→文分割 (`splitSentences`、略語保護)→番号付きでLLM送信→番号で英日対応
- **バッチ並列**: 5段落並列 `Promise.all`、batchごとに進捗を content にプッシュ
- **キャッシュキー**: `trarxiv:cache:{type}:{paperId}:{sectionId}` (LRU、`QUOTA_BYTES` 時に古いものから削除)
- **APIキー暗号化**: PBKDF2 200k iter + AES-256-GCM。復号後は `chrome.storage.session` に常駐 (Chrome終了でクリア)
- **動的サイト**: LLM が DOM サマリから CSS セレクター推定 → `chrome.scripting.registerContentScripts` で動的登録

## 開発方針

### 後方互換よりセキュリティ優先
個人配布・既存ユーザー = 開発者本人のみのため、storage マイグレーションや旧データ互換コードは作り込まない。問題があれば A6 のデータ管理 UI で全データ初期化で対応する。

### 失敗時はLLMフォールバックせずエラー明示
外部API (Semantic Scholar 等) が失敗した時、LLM の学習データから情報を生成するフォールバックは実装しない。「取得できませんでした」と明示する。事実主張のハルシネーションを避ける方針。

### プレースホルダ方式
- **数式 (A7)**: `extractText()` で数式要素を `⟦MATH_N⟧` トークンに置換、Map に元ノード保存。LLM に「トークンは保持」と指示、翻訳後に DOM 構築で復元。LLM が数式を読まないのでトークン消費ゼロ・破壊リスクなし
- **参考文献 (A14)**: `<a href="#bib.bibN">` を `[REF:N]` プレースホルダに置換し文単位で追跡。和訳ペアの下にタイトル小インデント常時表示、ホバーで abstract 要約

## ロードマップ

### v0.2.0 — Safer & Smarter (進行中)

| # | アクション | なぜ | 状態 | 編集対象 |
|---|---|---|---|---|
| **A1** | popup XSS 全廃 + CSP明示 | LLM 出力が `innerHTML` 経由で popup/content/options に流入 → スクリプト注入されるリスクを断つ | ✅ 完了 | popup.js / content.js / options.js (renderSiteConfigs) / manifest.json |
| **A2** | `<all_urls>` 撤廃 + ドメイン単位許可 | 万一の侵害時に銀行など未知サイトで暴走しないよう、optional_host_permissions を狭め、サイト設定削除時に Chrome 権限も revoke する | ✅ 完了 | manifest.json / background.js / popup.js |
| **A3** | 画像 fetch URL検証 (SSRF防止) | `handleAnalyzeImage` の `imageUrl` 引数に `127.0.0.1` / `169.254.169.254` (クラウドメタデータ) 等を仕込まれて内部資源が侵害されるのを防ぐ | ✅ 完了 | background.js (handleAnalyzeImage) |
| **A4** | LLMセレクター検証 | プロンプトインジェクションで LLM が `input[type=password]` 等 機微要素を指すセレクターを返すと、その値が「論文本文」として LLM API に**漏出**する。構文/対象範囲を検証 | ✅ 完了 | 新規 utils/selector-guard.js / background.js / content.js |
| **A5** | Anthropic 警告バナー | Anthropic がブラウザ直叩き (`dangerous-direct-browser-access`) を非推奨化。ユーザーに明示 | ✅ 完了 | options.html |
| **A6** | データ管理UI (3段階リセット) | A1〜A5 以前のコードで保存された侵害リスクのある既存データを段階的にクリアする手段が必要 | ⏳ 未着手 | options.html / options.css / options.js |
| **A7** | 数式プレースホルダ復元 (`⟦MATH_N⟧`) | 現状 `[数式]` 置換で破棄され、和訳側に数式が出ず読解として不十分 | ⏳ 未着手 | content.js / background.js |

**着手順**: A1 → A2 → A3 → A4 → A5 → (次) **A6** → A7
(当初は A6 を先に予定していたが、セキュリティ系 A2-A5 を一括処理した経緯)

### v0.3.0 — Wider & Deeper

| # | アクション | なぜ | 編集対象 |
|---|---|---|---|
| **A8** | arxiv.org/abs ページサポート (a: ar5iv ボタン HTML版なし時 / b: 論文ブリーフィング) | やや古い ArXiv 論文は HTML 版リンクがなく PDF 強制 = 翻訳不可。ar5iv 経由のボタンと abs ページでのブリーフィングを提供 | manifest.json / content.js (新プロバイダ + abs ページロジック) |
| **A9** | T5 第1陣 (bioRxiv, medRxiv, PMC, OpenReview, ACL Anthology) | 対応サイトを増やす。動的解析でも一応動くが、よく使うサイトは静的設定で表現力・安定性を上げたい | content.js PROVIDERS / manifest.json |
| **A10** | Semantic Scholar 著者検索 (**失敗時エラー明示**) | 現行の著者リサーチは LLM がタイトル等から幻覚を吐く。Web 検索ベースに置換 (失敗時はフォールバックせずエラー明示) | 新規 utils/semantic-scholar.js / background.js |
| **A11** | 論文の位置づけ + 関連論文 + チャット強化 | 「次に読む論文」「全体の中での位置づけ」を出すことで論文を有機的に評価できるようにする | background.js / content.js / popup.js |

### v0.4.0 — Reading Companion

| # | アクション | なぜ | 編集対象 |
|---|---|---|---|
| **A13** | T5 第2陣 (Nature, Cell, eLife, PLOS) | A9 と同じく対応サイト拡大 (動的より静的の方が表現力高い) | content.js PROVIDERS |
| **A14** | インライン参考文献注釈 + ホバー詳細 | 参考文献にいちいち飛ぶのが面倒。和訳ペア直下に著者/タイトルを常時表示 + ホバーで abstract 要約を出す | content.js / background.js / utils/cache.js |

### 保留

- **A12** Cloudflare Workers プロキシ対応 — Anthropic キー漏洩の根本対策だが、ユーザー (=自分) が運用を理解できないため将来検討

## A1 完了の詳細

- 全 `innerHTML` の LLM 出力流入経路を `textContent` + DOM API に置換
- popup の `setStatusBadge()` ヘルパー追加
- content の `renderErrorCard()` / `renderSpinnerLabel()` ヘルパー追加
- options の `renderSiteConfigs()` を全面 DOM API 化、`c.confidence` の escape 漏れ修正
- manifest に `content_security_policy.extension_pages` を明示

残った `innerHTML` (options.js) はすべて `escHtml()` 経由 or 静的文字列のみで XSS 不可能。

## リポジトリ規約

- **コミット粒度**: 1 アクション = 1 コミット (関連の小修正は同コミットに含める)
- **ブランチ戦略**: main 直接コミット (個人開発のため)
- **コミットメッセージ**: 日本語/英語混在可、件名は変更の意図を1行で
- **テスト**: 自動テストなし。各リリース前に「ArXiv翻訳 / 解説 / ブリーフィング / 著者リサーチ / 図解析 / チャット」のスモークテストを手動実施

## 次セッションへの引き継ぎ

このファイルがある = Claude Code は自動でロードマップを把握できる。`git log` で完了済みコミットを確認し、ロードマップ表の「状態」と照合して次のアクションに着手すれば良い。

進行中のアクションがある場合は、コミット前にこのファイルの該当アクションを `🚧 進行中` にマークする運用にすると分かりやすい。
