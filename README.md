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

```bash
bun run import:markdown
```

取り込み元:

- `${REGULAR_RAG_CONTENT_ROOT}/pages/**/*.md`

補助ディレクトリ:

- `${REGULAR_RAG_CONTENT_ROOT}/wiki/`（UI/メタ用途）

## API 概要

### Health

- `GET /api/health`
- `GET /api/sources/health`

### Sources

- `GET /api/sources/tree`
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
