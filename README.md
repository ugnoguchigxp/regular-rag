# regular-rag

Hono 専用の Artifact RAG アプリです。  
`wiki/pages/**/*.md` を取り込み、ハイブリッド検索（pgvector + 全文）で根拠付き回答を返します。

## 構成

- Backend: Hono (`/api/**`)
- Frontend: React + Vite
- DB: PostgreSQL + pgvector + pg_trgm
- LLM / Embedding: Azure OpenAI

## 前提

- Bun
- PostgreSQL（`vector` と `pg_trgm` が有効化できること）
- Azure OpenAI の API キー（チャット/埋め込みを使う場合）

## セットアップ

```bash
bun install
cp .env.example .env
```

`.env` を編集し、最低限次を設定します。

- `DATABASE_URL`
- `REGULAR_RAG_CONTENT_ROOT`（既定: `../wiki-knowledge`）
- Azure OpenAI の各環境変数

PostgreSQL をローカル起動する場合:

```bash
docker compose up -d db
```

## 起動

開発:

```bash
bun run dev
```

- UI: [http://localhost:5173](http://localhost:5173)
- API: `http://localhost:5173/api/*`

本番相当サーバー:

```bash
bun run start
```

## マイグレーション

```bash
bun run db:migrate
```

`db:migrate` は `drizzle/*.sql` を順に適用します（適用履歴は `regular_rag_schema_migrations`）。
初回は `drizzle/0001_sources_chat_artifacts.sql` が適用され、以下を作成します。

- `sources`
- `source_fragments`
- `conversations`
- `messages`
- `artifacts`
- `retrieval_logs`

## Markdown 取り込み

カテゴリルール:

- `pages/` 直下のトップレベルフォルダをカテゴリとして扱います
  - 例: `pages/tech/**` は `tech` カテゴリ
- `pages/` 直下への Markdown 配置は不可です（`pages/index.md`, `pages/foo.md` など）
- ドキュメントは必ず `pages/<category>/...` 配下に配置してください
- 互換のため `pages/index.md` が残っていた場合は、`wiki:index` 実行時に
  `pages/tech/index.md` へ移行、または `pages/tech/index.legacy*.md` へ退避されます
- `wiki:index` は各ドキュメントを自動で slug 登録します
  - 例: `pages/tech/hono/routing.md` -> `tech/hono/routing`
  - 既存行も再取り込み時に `metadata.wikiSlug` / `relativePath` が更新されます

推奨: 2-phase で順次実行（全文検索登録 → embedding 登録）

```bash
bun run wiki:index:all
```

Phase を分けて実行する場合:

```bash
# Phase 1: 全文検索登録（embedding を付与しない）
bun run wiki:index:fts

# Phase 2: embedding バックフィル
bun run wiki:index:embed
```

詳細オプション（`wiki:index`）:

```bash
bun run wiki:index --phase=all --batch-size=25 --max-fragments=0 --sleep-ms=0
```

実行中は `[wiki:index]` プレフィックスで進捗ログ（phase開始、ファイル取り込み、embedding進捗）が出力され、
最後に JSON サマリが出力されます。

- `--phase=fts|embed|all`
  - `fts`: `sources` / `source_fragments` と全文検索向け `search_vector` を更新
  - `embed`: `source_fragments.embedding IS NULL` の行だけを順次埋める
  - `all`: `fts` → `embed` の順で実行
- `--batch-size`: embedding バックフィル時の1回あたり取得件数（既定: `25`）
- `--max-fragments`: embedding バックフィルの上限件数（`0` で無制限）
- `--sleep-ms`: 各 fragment の embedding 実行後に待機するミリ秒

既存DBで `wikiSlug` が未登録の行を一括登録する場合:

```bash
# 未登録（metadata.wikiSlug が空）のみ更新
bun run wiki:register:missing-slugs

# 反映せず確認のみ
bun run wiki:register:missing-slugs --dry-run

# 既存全件を再計算して更新
bun run wiki:register:missing-slugs --all
```

従来の単発取り込み（embedding 付与込み）:

```bash
bun run import:markdown
```

取り込み元:

- `${REGULAR_RAG_CONTENT_ROOT}/pages/<category>/**/*.md`

補助ディレクトリ:

- `${REGULAR_RAG_CONTENT_ROOT}/wiki/`（UI/メタ用途）

## API 概要

### Health

- `GET /api/health`
- `GET /api/sources/health`

### Sources

- `GET /api/sources/tree`
- `GET /api/sources/categories`
- `GET /api/sources/search?q=...`
- `POST /api/sources/reindex`
- `GET /api/sources/pages/*`
- `POST /api/sources/pages`
- `PUT /api/sources/pages/*`
- `DELETE /api/sources/pages/*`
- `GET /api/sources/folders`
- `POST /api/sources/folders`
- `PUT /api/sources/folders/*`
- `DELETE /api/sources/folders/*`
- `GET /api/sources/history/*`
- `GET /api/sources/diff/*?from=...&to=...`

### Chat / Retrieval

- `POST /api/chat`
- `POST /api/chat/stream`
- `GET /api/chat/conversations`
- `GET /api/chat/conversations/:conversationId/messages`
- `GET /api/chat/conversations/:conversationId/retrieval-logs`
- `POST /api/search`

`POST /api/chat`, `POST /api/chat/stream`, `POST /api/search` は
`category` を指定すると、そのカテゴリに限定して検索/RAG実行できます。

### Artifacts

- `GET /api/artifacts`
- `GET /api/artifacts/:artifactId`
- `PUT /api/artifacts/:artifactId`

## Artifact 形式

LLM 出力内の次形式を抽出して保存します。

```xml
<artifact type="markdown" title="...">
...
</artifact>
```

対応 type:

- `markdown`
- `table`
- `mermaid`
- `chart`
- `json`
- `code`
- `diagram-dsl`

## 品質ゲート

```bash
bun run verify
```

実行内容:

- `typecheck`
- `lint`
- `format:check`
- `test`
- `build`

## 主要ディレクトリ

```txt
src/
  app/                    # Hono app runtime / server
  routes/                 # API routes
  modules/
    sources/              # wiki content repo / markdown importer / source repository
    rag/                  # retriever (RRF merge)
    chat/                 # chat service
    artifacts/            # artifact extraction / parsing
  db/                     # drizzle schema / db connection
web/
  src/                    # React UI
drizzle/
  0001_sources_chat_artifacts.sql
```
