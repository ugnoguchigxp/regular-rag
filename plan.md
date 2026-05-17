# regular-rag Hono Artifact RAG 実装計画

## 1. 目的

`regular-rag` を起点に、Markdown で管理された大量のナレッジドキュメントを取り込み、根拠付き回答と編集可能な Artifact を扱える Hono 専用の RAG アプリケーションへ拡張する。

この計画では、既存の `regular-rag` を捨てずに、以下を活かす。

- `src/core/RagEngine.ts` のファサード設計
- `src/repositories/RagRepository.ts` の pgvector + 全文検索 + RRF 実装
- `src/providers/AzureOpenAiProvider.ts` の LLM / embedding adapter
- `src/services/ChatbotService.ts` の検索計画、RAG回答、Web検索フォールバックの骨格
- `examples/app.ts` の Hono route 実装
- 現行 Vitest テスト資産

一方で、既存の README にある Express / Next.js / NestJS などの汎用 framework 利用例は、このアプリの実装計画からは外す。今後の実装対象は Hono API + React/Vite UI に一本化する。

## 2. 方向性

### 2.1 Hono 専用

バックエンドは Hono のみを対象にする。

- API route は Hono route と Zod validator で定義する
- 開発時は Hono + Vite の単一 dev server 構成を目指す
- production build は Hono server が API と static assets を提供する
- Express / Next.js / NestJS adapter は作らない
- README から framework 横断の説明を削り、Hono アプリとしての起動方法に寄せる

### 2.2 Markdown knowledge first

ナレッジは大量の `.md` ファイルを主入力とする。

- Markdown content root を設定する
- frontmatter を読む
- slug / path / title / tags / updatedAt を保持する
- Markdown を見出し単位で chunk 化する
- source document と chunk fragment を DB に保存する
- content hash で差分取り込みする
- 削除された Markdown は stale source として消す
- Git 管理された knowledge repository との連携を前提にする

この部分は `../memoryRouter` の wiki / source ingestion 実装を移植する。

### 2.3 Artifact-first

AI の回答は単なる文字列ではなく、本文、引用、Artifact の集合として扱う。

```ts
type AssistantResponse = {
  text: string;
  citations: Citation[];
  artifacts: Artifact[];
};
```

Artifact はチャット本文に混ぜず、専用 panel で表示・編集する。

初期対象:

- Markdown
- table
- Mermaid
- chart
- JSON
- code

後続対象:

- diagram-dsl
- Konva diagram
- PNG / SVG export

### 2.4 LLM 出力を直接実行しない

LLM が生成した React / JavaScript / Konva code をアプリ内で直接実行しない。

LLM には以下のような安全な中間表現を出力させる。

- `<artifact>` block
- Markdown table
- Mermaid
- chart-dsl
- diagram-dsl
- loose JSON
- YAML

内部処理は必ず次の流れにする。

```txt
LLM raw output
  -> artifact block extraction
  -> loose parse / repair
  -> Zod validation
  -> normalization
  -> persistence
  -> safe renderer
```

### 2.5 現行 embedding 次元を尊重する

現行 `src/db/schema.ts` は `EMBEDDING_DIMENSIONS = 1536` を使っている。したがって最初の実装では 1536 次元を既定値として維持する。

512 次元へ切り替える場合は、既存データと同じ vector column に混在させない。将来対応として embedding profile を導入し、profile ごとに別 column または別 table を使う。

### 2.6 実装前に固定する決定事項

この計画では、実装者が最初に判断を補わなくてよいように以下を固定する。

- Markdown knowledge repository の root は `REGULAR_RAG_CONTENT_ROOT` で指定する
- 既定値は `../wiki-knowledge`
- Markdown page は `REGULAR_RAG_CONTENT_ROOT/pages/**/*.md` に置く
- `REGULAR_RAG_CONTENT_ROOT/wiki/` は UI / app metadata 用に予約し、RAG 取り込み対象にしない
- DB migration は Markdown importer より先に実装する
- source retrieval は新規 `sources` / `source_fragments` を使う
- 既存 `rag_documents` は互換用に残し、新規 Markdown RAG では使わない
- Hono + Vite は `@hono/vite-dev-server` で `/api/**` のみ Hono に渡す
- streaming は `StreamingLlmProvider` を追加してから実装する

## 3. 移植元

`../memoryRouter` から移植する候補は以下。

### 3.1 Markdown / wiki source 管理

- `../memoryRouter/src/modules/sources/wiki/content-repo.ts`
  - `pages/` 配下の Markdown 読み書き
  - folder 作成、削除、rename
  - Git init / commit / history / diff
- `../memoryRouter/src/modules/sources/wiki/slug.ts`
  - wildcard slug
  - path traversal 防止
  - file path と slug の相互変換
- `../memoryRouter/src/modules/sources/wiki/sanitize.ts`
  - Markdown 内 link / inline HTML の sanitize
- `../memoryRouter/src/modules/sources/markdown-importer.service.ts`
  - Markdown directory scan
  - frontmatter / heading title extraction
  - content hash
  - stale source deletion

### 3.2 Source DB / retrieval

- `../memoryRouter/drizzle/0001_wiki_sources.sql`
  - `sources`
  - `source_fragments`
  - `knowledge_source_links`
  - FTS index
  - HNSW vector index
- `../memoryRouter/src/modules/sources/source.repository.ts`
  - source upsert
  - fragment replacement
  - chunking
  - vector search
  - text search
  - repo/content-root scoped filtering

### 3.3 Hono routes

- `../memoryRouter/api/modules/sources/sources.routes.ts`
  - `/api/sources/health`
  - `/api/sources/tree`
  - `/api/sources/search`
  - `/api/sources/reindex`
  - `/api/sources/pages/*`
  - `/api/sources/folders/*`
  - `/api/sources/history/*`
  - `/api/sources/diff/*`

この route は Hono 専用としてそのまま思想を流用する。ただし app 名、config 名、DB repository は `regular-rag` 側に合わせる。

### 3.4 UI

- `../memoryRouter/web/src/modules/admin/components/sources.page.tsx`
  - icon-first explorer
  - folder / page tree
  - Markdown editor
  - search
  - reindex
  - history / diff
- `../memoryRouter/web/src/modules/admin/repositories/admin.repository.ts`
  - sources API client
- `../memoryRouter/web/src/modules/admin/components/app-shell.tsx`
  - app shell / navigation のベース
- `../memoryRouter/web/src/components/ui/*`
  - button / input / textarea / table / select / checkbox / badge / card / label

UI は memoryRouter の admin UI をそのまま製品名だけ変えて持ち込むのではなく、次の画面に整理して移植する。

- Knowledge Explorer
- Chat
- Artifact Panel
- Search / Retrieval Inspector
- Settings

### 3.5 移植しないもの

以下は今回のアプリには持ち込まない。

- MCP server / MCP tools
- vibe memory
- agent log sync
- distillation daemon
- launchd / automation
- context compiler control plane
- memoryRouter 固有の doctor / audit

必要になった場合でも、まず Markdown source / RAG / Artifact の完成を優先する。

### 3.6 移植時の adapter 境界

memoryRouter のコードは以下のように依存を置き換える。

| memoryRouter 側 | regular-rag 側 |
| --- | --- |
| `groupedConfig.sourceContent.root` | `readAppEnv().contentRoot` |
| `db` singleton | `DbConnection.db` または route factory に注入する repository |
| `embedOne(content, "passage")` | `EmbeddingProvider.createEmbedding(content)` |
| `recordAuditLogSafe` | 初期実装では呼ばない。必要なら `console.warn` ではなく no-op adapter を置く |
| `normalizeRepoPath` / `normalizeRepoKey` | 初期実装では `contentRoot` 単位の scope のみ使う |
| `source_distillation` / `knowledge_items` | 移植しない |

実装対象 adapter:

- `src/app/env.ts`
  - `DATABASE_URL`
  - `PORT`
  - `REGULAR_RAG_CONTENT_ROOT`
  - Azure OpenAI env
- `src/knowledge/source.repository.ts`
  - constructor で `NodePgDatabase<typeof schema>` と `EmbeddingProvider` を受け取る
  - global singleton に依存しない
- `src/routes/sources.route.ts`
  - `createSourcesRoute(deps)` を export する
  - `deps.contentRoot`, `deps.sourceRepository` を使う
- `src/routes/chat.route.ts`
  - `createChatRoute(deps)` を export する

この境界により、memoryRouter の source UI / wiki 操作を移植しても、MCP、doctor、audit、distillation daemon が混入しない。

## 4. 推奨構成

現行 repo を app 化する。package と app を分けすぎる前に、まず Hono + React/Vite の単一 workspace として成立させる。

```txt
regular-rag/
  src/
    index.ts

    app/
      server.ts
      hono.ts
      env.ts
      static.ts

    db/
      index.ts
      schema.ts
      migrations/

    providers/
      types.ts
      AzureOpenAiProvider.ts

    rag/
      RagEngine.ts
      retrieval/
      generation/
      citations/

    knowledge/
      markdown-importer.service.ts
      source.repository.ts
      chunk.service.ts
      reindex.service.ts

    knowledge/wiki/
      content-repo.ts
      slug.ts
      sanitize.ts

    routes/
      health.route.ts
      sources.route.ts
      search.route.ts
      chat.route.ts
      artifacts.route.ts

    artifacts/
      artifact.types.ts
      artifact.schemas.ts
      extractArtifactBlocks.ts
      parseLooseStructuredText.ts
      normalizeArtifact.ts

  web/
    src/
      app/
        main.tsx
        router.tsx
        app-shell.tsx
      features/
        knowledge/
        chat/
        artifacts/
        search/
        settings/
      components/ui/

  examples/
    legacy/

  docs/
    implementation-notes.md

  package.json
  docker-compose.yml
  Dockerfile
```

`examples/app.ts` は Hono 実装の参考として残してよいが、最終的な実行 entrypoint は `src/app/server.ts` に寄せる。

### 4.1 package / script 変更

Phase 1 で `package.json` を Hono app 前提に更新する。

追加する dependencies:

```txt
@hono/node-server
@hono/zod-validator
@tanstack/react-query
@tanstack/react-router
react
react-dom
lucide-react
gray-matter
sanitize-html
markdown-wysiwyg-editor
mermaid
clsx
class-variance-authority
tailwind-merge
```

追加する dev dependencies:

```txt
vite
@vitejs/plugin-react
@tailwindcss/vite
@types/react
@types/react-dom
@types/sanitize-html
@hono/vite-dev-server
tailwindcss
```

更新する scripts:

```json
{
  "scripts": {
    "dev": "bun ./node_modules/vite/bin/vite.js",
    "start": "bun run src/app/server.ts",
    "build": "tsup && vite build",
    "build:server": "tsup",
    "build:web": "vite build",
    "preview:web": "vite preview",
    "import:markdown": "bun run src/cli/import-markdown.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "biome lint src web",
    "format": "biome format --write src web",
    "format:check": "biome format src web",
    "verify": "bun run typecheck && bun run lint && bun run format:check && bun run test && bun run build"
  }
}
```

`examples/` は legacy sample として残す場合でも、quality gate の主対象は `src` と `web` にする。移行期間中に `examples/` を残して lint 対象に含める場合は、warning 7件を先に解消する。

### 4.2 Vite / Hono dev server

`vite.config.ts` は memoryRouter の構成をこの repo 用に調整する。

```ts
import path from "node:path";
import devServer from "@hono/vite-dev-server";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    devServer({
      entry: "src/app/server.ts",
      exclude: [/^\/(?!api(?:\/|$)).*/],
      injectClientScript: false,
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./web/src"),
      "@web": path.resolve(__dirname, "./web/src"),
      "@server": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ["markdown-wysiwyg-editor", "mermaid"],
  },
  build: {
    outDir: "dist-web",
  },
});
```

`src/app/server.ts` は Hono app を export し、dev server / Bun server の両方から使える形にする。

```ts
import { serve } from "@hono/node-server";
import { createHonoApp } from "./hono";
import { readAppEnv } from "./env";

const env = readAppEnv();
const app = createHonoApp(env);

if (import.meta.main) {
  serve({ fetch: app.fetch, port: env.port });
}

export default app;
```

### 4.3 env

`.env.example` に以下を追加する。

```env
REGULAR_RAG_CONTENT_ROOT=../wiki-knowledge
```

`src/app/env.ts` は既存 `src/config/readEnv.ts` を拡張するか置き換える。戻り値は最低限以下にする。

```ts
export type AppEnv = {
  port: number;
  databaseUrl: string;
  contentRoot: string;
  azureOpenAi: {
    endpoint: string;
    apiKey: string;
    deployment: string;
    embeddingsDeployment: string;
    apiVersion: string;
  };
};
```

## 5. データベース設計

### 5.1 現行 schema の扱い

現行の `rag_documents` は単一 document embedding を持つため、大量 Markdown の chunk retrieval には不足する。

移行方針:

- `rag_documents` は既存 API / tests の互換用に残す
- 新規 Markdown retrieval は `sources` / `source_fragments` を主軸にする
- `chatbot_cache` は non-stream chat の cache として継続利用してよい
- `knowledge_nodes` / `knowledge_edges` は Phase 5 では触らず、Markdown RAG が通ってから再評価する
- conversation / message / artifact / retrieval log は新規 table として追加する
- id は新規 table では `uuid` に統一する

### 5.2 Drizzle schema 追加対象

`src/db/schema.ts` に以下を追加する。現行の `EMBEDDING_DIMENSIONS = 1536` と `tsvector` custom type を再利用する。

`drizzle-orm/pg-core` の import には `uuid` と `uniqueIndex` を追加する。

```ts
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceKind: text("source_kind").notNull(),
    uri: text("uri").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
  },
  (table) => ({
    uriIdx: uniqueIndex("sources_uri_idx").on(table.uri),
    sourceKindIdx: index("sources_source_kind_idx").on(table.sourceKind),
    contentHashIdx: index("sources_content_hash_idx").on(table.contentHash),
    bodyTrgmIdx: index("sources_body_trgm_idx").using("gin", sql`${table.body} gin_trgm_ops`),
  }),
);

export const sourceFragments = pgTable(
  "source_fragments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    locator: text("locator").notNull(),
    heading: text("heading"),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    searchVector: tsvector("search_vector"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourceIdx: index("source_fragments_source_id_idx").on(table.sourceId),
    sourceLocatorIdx: uniqueIndex("source_fragments_source_locator_idx").on(
      table.sourceId,
      table.locator,
    ),
    searchVectorIdx: index("source_fragments_search_vector_idx").using(
      "gin",
      sql`${table.searchVector}`,
    ),
    contentTrgmIdx: index("source_fragments_content_trgm_idx").using(
      "gin",
      sql`${table.content} gin_trgm_ops`,
    ),
    embeddingHnswIdx: index("source_fragments_embedding_hnsw_idx").using(
      "hnsw",
      sql`${table.embedding} vector_cosine_ops`,
    ),
  }),
);
```

Conversation / artifact 系は同じ migration で追加する。

```ts
export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const artifacts = pgTable("artifacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title"),
  content: jsonb("content").notNull(),
  version: integer("version").notNull().default(1),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const retrievalLogs = pgTable("retrieval_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id").references(() => conversations.id, {
    onDelete: "set null",
  }),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  query: text("query").notNull(),
  fragmentIds: jsonb("fragment_ids").notNull().default([]),
  scores: jsonb("scores").notNull().default({}),
  context: jsonb("context").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 5.3 migration file

Phase 2 で `drizzle-kit generate` を使って migration を生成する。生成後、SQL に以下が含まれることを確認する。

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS source_fragments_embedding_hnsw_idx
  ON source_fragments USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS source_fragments_search_vector_idx
  ON source_fragments USING gin (search_vector);
CREATE INDEX IF NOT EXISTS source_fragments_content_trgm_idx
  ON source_fragments USING gin (content gin_trgm_ops);
```

Drizzle が extension SQL を生成しない場合は、生成 migration の先頭に手で追加する。

### 5.4 repository write rule

`source_fragments.search_vector` は repository の insert 時に明示的に設定する。

```ts
searchVector: sql`to_tsvector('simple', concat_ws(' ', ${heading}, ${content}, ${metadataJson}))`
```

generated column は初期実装では使わない。Drizzle の型と migration の複雑さを抑えるため、`upsertSourceDocument()` / `replaceSourceFragments()` が `searchVector` を更新する責務を持つ。

`source_kind` は初期実装では `"wiki"` のみ許可する。DB check constraint は Drizzle migration の生成結果が安定してから追加し、Phase 2 では repository / route の Zod validation で拒否する。

## 6. Markdown 取り込み

### 6.1 Content root

環境変数で Markdown knowledge root を指定する。

```env
REGULAR_RAG_CONTENT_ROOT=../wiki-knowledge
```

初期化時:

- content root がなければ作る
- `pages/` を作る
- `wiki/` を作る
- Git repo でなければ `git init` する

`REGULAR_RAG_CONTENT_ROOT` は Git-backed knowledge repository の root である。既定ではアプリ repo の sibling に `wiki-knowledge` を作る。

```txt
../wiki-knowledge/
  .git/
  pages/
    index.md
    product/
      overview.md
  wiki/
    config.json
```

役割:

- `pages/**/*.md`: RAG 取り込み対象の Markdown
- `wiki/`: UI / app metadata 用の予約ディレクトリ
- `.git/`: knowledge repository の履歴

`wiki/**/*.md` は取り込み対象にしない。stale source deletion も `pages/**/*.md` だけを対象にする。

### 6.2 対象ファイル

初期対象:

- `${REGULAR_RAG_CONTENT_ROOT}/pages/**/*.md`
- frontmatter 付き Markdown
- nested path
- `index.md`

対象外:

- binary
- generated files
- `.git`
- `node_modules`
- hidden working files
- `${REGULAR_RAG_CONTENT_ROOT}/wiki/**`

### 6.3 import flow

```txt
scan ${REGULAR_RAG_CONTENT_ROOT}/pages/**/*.md
  -> parse frontmatter
  -> infer title from frontmatter.title or first heading
  -> sanitize body for UI write path
  -> calculate sha256 content hash
  -> upsert sources
  -> split into source_fragments
  -> embed chunks
  -> update FTS/search_vector
  -> delete stale sources for root
```

### 6.4 chunking

最初は memoryRouter の `chunkSourceDocument` を移植して使う。

改善方針:

- heading boundary を優先
- default max chars: 2500
- 長すぎる heading section は段落単位で分割
- metadata に slug / heading / source path / frontmatter tags を残す
- chunk locator は安定した `chunk:0001` 形式から始める

## 7. Retrieval

### 7.1 Hybrid search

既存 `RagRepository.hybridSearch()` の RRF 方針を source fragment 用に拡張する。

検索 source:

- vector search against `source_fragments.embedding`
- PostgreSQL FTS against heading + content + metadata
- trigram fallback against content

ranking:

```txt
rrf_score =
  1 / (60 + vector_rank)
  + 1 / (60 + text_rank)
  + 1 / (60 + trigram_rank)
```

### 7.2 citation

回答には source fragment を引用として返す。

```ts
type Citation = {
  sourceId: string;
  fragmentId: string;
  uri: string;
  title: string;
  heading?: string;
  locator: string;
  score: number;
};
```

UI では citation click で Knowledge Explorer の該当 Markdown page を開けるようにする。

### 7.3 context packing

初期実装:

- final topK: 8
- chunk content をスコア順に詰める
- title / heading / path を context header に入れる
- 重複 fragment を除外する

後続:

- conversation history を圧縮
- same source の近接 chunk をまとめる
- retrieval log で実際に使った context を保存する

## 8. Chat API

### 8.1 routes

Hono route のみを提供する。

```txt
GET  /api/health
GET  /api/sources/health
GET  /api/sources/tree
GET  /api/sources/search
POST /api/sources/reindex
GET  /api/sources/pages/*
POST /api/sources/pages
PUT  /api/sources/pages/*
DELETE /api/sources/pages/*
GET  /api/sources/history/*
GET  /api/sources/diff/*

POST /api/search
POST /api/chat
POST /api/chat/stream
GET  /api/artifacts/:id
PATCH /api/artifacts/:id
```

### 8.2 non-stream chat

`POST /api/chat` は実装とテストを安定させるための基本 API とする。

処理:

```txt
validate request
  -> create/find conversation
  -> run retrieval
  -> build prompt
  -> call LLM
  -> extract citations
  -> extract artifacts
  -> persist message/artifacts/retrieval log
  -> return AssistantResponse
```

### 8.3 streaming chat

MVP の後半で SSE を追加する。

```ts
type ChatStreamEvent =
  | { type: "message_start"; messageId: string }
  | { type: "retrieval_start"; query: string }
  | { type: "retrieval_result"; citations: Citation[] }
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "artifact_delta"; artifactId: string; delta: string }
  | { type: "artifact_complete"; artifact: Artifact }
  | { type: "message_complete"; messageId: string }
  | { type: "error"; message: string };
```

Phase 9 に入る前に provider contract を拡張する。

```ts
export type ChatDelta = {
  id: string;
  delta: string;
  finishReason?: string;
};

export interface StreamingLlmProvider extends LlmProvider {
  streamChatCompletion(
    messages: ChatMessage[],
    options?: LlmCompletionOptions,
  ): AsyncIterable<ChatDelta>;
}

export function supportsStreaming(
  provider: LlmProvider,
): provider is StreamingLlmProvider {
  return "streamChatCompletion" in provider;
}
```

`POST /api/chat/stream` は `supportsStreaming(provider)` が false の場合、通常の `chatCompletion()` 結果を 1 回の `text_delta` として返す。この fallback により Azure streaming 実装を追加する前でも route の contract test を書ける。

WebSocket Event Bus は初期実装では作らない。必要になるまで SSE と通常 HTTP route で進める。

## 9. Artifact system

### 9.1 type

```ts
type Artifact = {
  id: string;
  type: "markdown" | "table" | "mermaid" | "chart" | "json" | "code" | "diagram-dsl";
  title?: string;
  content: unknown;
  version: number;
  metadata: Record<string, unknown>;
};
```

### 9.2 parser

初期実装:

- `<artifact type="...">...</artifact>` block extraction
- Markdown table parser
- Mermaid block extraction
- JSON / loose JSON parser
- Zod validation

追加候補:

- `jsonrepair`
- YAML
- chart-dsl
- diagram-dsl

### 9.3 renderer

React UI の Artifact Panel は type registry で renderer を選ぶ。

初期 renderer:

- Markdown renderer
- table renderer
- Mermaid renderer
- JSON viewer
- code viewer

Konva diagram は後続 phase に分ける。

## 10. UI

UI は memoryRouter の local wiki explorer を起点にする。

### 10.1 screens

```txt
Knowledge Explorer
  - folder/page tree
  - Markdown editor
  - page create/update/delete
  - folder create/rename/delete
  - search
  - reindex
  - history/diff

Chat
  - conversation list
  - message list
  - composer
  - citation chips
  - streaming text

Artifact Panel
  - selected artifact
  - type-specific renderer
  - edit/save where safe

Search Inspector
  - query
  - ranked source fragments
  - vector/text/trigram/RRF score
  - prompt context preview

Settings
  - content root
  - provider status
  - embedding dimensions
  - reindex status
```

### 10.2 design rule

- SaaS landing page は作らない
- 最初の画面は Knowledge Explorer + Chat の作業画面にする
- 操作は icon button を中心にする
- shadcn-style の小さな UI primitive を memoryRouter から移植する
- document-heavy UI なので、装飾より情報密度と操作性を優先する

### 10.3 dependencies

memoryRouter 移植で必要になる候補:

```txt
@hono/zod-validator
@hono/node-server
@tanstack/react-query
@tanstack/react-router
lucide-react
markdown-wysiwyg-editor
mermaid
gray-matter
sanitize-html
react
react-dom
vite
tailwindcss
@tailwindcss/vite
```

CSS import path は実装時に実パッケージの exports を確認して決める。

## 11. 実装フェーズ

### Phase 0: plan / repo cleanup

目的:

- 現行 `plan.md` をこの計画に更新する
- README の方向性を Hono 専用へ寄せる準備をする
- 既存 lint warning を解消する

対象:

- `plan.md`
- `README.md`
- `src/core/RagEngine.ts`
- `src/providers/BraveSearchProvider.ts`
- `src/services/WebSearchService.ts`
- `src/utils/httpClient.ts`

完了条件:

- `bun run test`
- `bun run typecheck`
- `bun run lint` が warning 0 件で通る
- `bun run build`

### Phase 1: Hono app baseline

目的:

- `examples/` ではなく `src/app/` に実行 entrypoint を作る
- Hono 専用 API と React/Vite UI の dev baseline を作る
- package scripts と dependencies を Hono app 前提に更新する

成果物:

- `package.json` scripts 更新
- `vite.config.ts`
- `tsconfig.json` の `DOM` / `react-jsx` / path alias 対応
- `web/index.html`
- `src/app/server.ts`
- `src/app/hono.ts`
- `src/app/env.ts`
- `src/routes/health.route.ts`
- `web/src/app/main.tsx`
- `web/src/app/app-shell.tsx`

完了条件:

- `bun run dev` で Hono API と UI が同じ origin で起動する
- `GET /api/health` が通る
- UI の初期画面が表示される
- `bun run typecheck`
- `bun run build`

### Phase 2: DB migration

目的:

- source/chunk/conversation/artifact/retrieval log の schema を追加する
- Markdown importer が書き込める DB 土台を先に作る

成果物:

- `src/db/schema.ts` 更新
- `drizzle/<timestamp>_sources_chat_artifacts.sql`
- `src/knowledge/source.repository.ts` の型だけ先に定義
- `test/source-schema.test.ts` または既存 repository test への schema assertion

完了条件:

- pgvector / pg_trgm が migration に含まれる
- `source_fragments.embedding` は `vector(1536)`
- `source_fragments.search_vector` の GIN index がある
- `source_fragments.content` の trigram index がある
- `sources.uri` は unique index
- `source_fragments(source_id, locator)` は unique index
- `bunx drizzle-kit generate` 後の SQL を確認する
- `bun run typecheck`

### Phase 3: Markdown knowledge source migration

目的:

- memoryRouter の wiki / source importer を adapter 境界つきで移植する
- Markdown content root を扱えるようにする

移植対象:

- `content-repo.ts`
- `slug.ts`
- `sanitize.ts`
- `markdown-importer.service.ts`
- `source.repository.ts` の source upsert / fragment replacement / search 部分

成果物:

- `src/knowledge/wiki/content-repo.ts`
- `src/knowledge/wiki/slug.ts`
- `src/knowledge/wiki/sanitize.ts`
- `src/knowledge/markdown-importer.service.ts`
- `src/knowledge/source.repository.ts`
- `src/knowledge/reindex.service.ts`
- `src/routes/sources.route.ts`
- `src/cli/import-markdown.ts`

完了条件:

- `POST /api/sources/reindex` で Markdown が DB に入る
- `GET /api/sources/tree` で page tree が返る
- `bun run import:markdown` で `REGULAR_RAG_CONTENT_ROOT/pages/**/*.md` を取り込める
- nested slug と path traversal 防止のテストがある
- stale file 削除がテストされる
- `${REGULAR_RAG_CONTENT_ROOT}/wiki/**` は取り込まれない
- source repository は global db singleton に依存しない

### Phase 4: source retrieval

目的:

- Markdown chunk を RAG 検索できるようにする

成果物:

- `src/rag/retrieval/source-retriever.ts`
- `src/rag/citations/citation.ts`
- `POST /api/search`

完了条件:

- vector / text / trigram の結果を RRF で統合する
- citation に source path / heading / locator が入る
- 検索結果の重複が除去される
- retrieval log を保存できる

### Phase 5: Chat RAG

目的:

- Hono chat API で Markdown knowledge を使った回答を返す

成果物:

- `src/routes/chat.route.ts`
- `src/rag/generation/prompt-builder.ts`
- `src/rag/generation/chat-orchestrator.ts`
- conversation / messages persistence

完了条件:

- `POST /api/chat` が citation 付き回答を返す
- answer に使われた fragment が retrieval log に残る
- 既存 `ChatbotService` のキャッシュ方針を移植または整理する

### Phase 6: Knowledge Explorer UI

目的:

- memoryRouter の Sources UI を regular-rag 用に移植する

成果物:

- `web/src/features/knowledge/knowledge-explorer.page.tsx`
- `web/src/features/knowledge/knowledge.repository.ts`
- `web/src/components/ui/*`

完了条件:

- page tree が表示される
- Markdown page を読める
- page を作成、編集、削除できる
- folder を作成、rename、削除できる
- reindex が UI から実行できる
- history / diff を見られる

### Phase 7: Chat + citation UI

目的:

- Knowledge Explorer と Chat を同じ作業画面で使えるようにする

成果物:

- `web/src/features/chat/chat.page.tsx`
- `web/src/features/chat/chat.repository.ts`
- citation click navigation

完了条件:

- user question を送信できる
- assistant answer が表示される
- citation から Markdown page を開ける
- retrieval result を inspector で確認できる

### Phase 8: Artifact MVP

目的:

- answer から Artifact を抽出して表示する

成果物:

- `src/artifacts/*`
- `src/routes/artifacts.route.ts`
- `web/src/features/artifacts/*`

完了条件:

- Markdown / table / Mermaid / JSON / code artifact が表示される
- invalid artifact は保存せず validation error を返す
- LLM 生成 code を直接実行しない

### Phase 9: Streaming

目的:

- SSE による逐次回答を追加する

成果物:

- `POST /api/chat/stream`
- stream event parser
- streaming UI

完了条件:

- retrieval event が先に表示される
- text delta が逐次表示される
- artifact completion event が Artifact Panel に反映される

### Phase 10: hardening

目的:

- 実運用で破綻しやすい箇所を固める

対象:

- large Markdown import
- duplicate slug
- deleted file cleanup
- provider timeout / retry
- embedding dimension mismatch
- citation correctness
- prompt/context size limits
- sanitize bypass

完了条件:

- `bun run verify` を追加する
- unit / integration / UI smoke をまとめて実行できる
- README が実装済み機能と一致している

## 12. 品質ゲート

`package.json` に `verify` を追加する。

```json
{
  "scripts": {
    "verify": "bun run typecheck && bun run lint && bun run format:check && bun run test && bun run build"
  }
}
```

初期移行中は現行 script に合わせて、最低限以下を通す。

```sh
bun run test
bun run typecheck
bun run lint
bun run build
```

UI 追加後:

```sh
bun run test:ui
bun run test:e2e
```

DB 変更を含む PR では以下も実行する。

```sh
bun run db:generate
bun run db:migrate
```

`db:generate` は migration 差分確認用に使い、意図しない既存 table 変更が出た場合は実装を止めて schema 方針を見直す。

## 13. README 更新方針

README は Hono 専用アプリとして書き直す。

削る内容:

- Express 利用例
- Next.js 利用例
- NestJS 利用例
- framework-agnostic を主張する説明

残す/強める内容:

- Hono app
- Markdown knowledge root
- Git-backed wiki source
- pgvector + FTS + trigram hybrid search
- citation-backed answer
- Artifact Panel
- Azure OpenAI provider
- `bun run dev`
- `bun run verify`

## 14. 初期 MVP

MVP に含めるもの:

- Hono API
- React/Vite UI
- Markdown content root
- Git-backed page/folder CRUD
- Markdown reindex
- source_fragments chunk storage
- vector + FTS + trigram hybrid retrieval
- citation-backed non-stream chat
- Knowledge Explorer
- Chat UI
- basic Artifact Panel

MVP に含めないもの:

- Express / Next.js / NestJS adapter
- WebSocket Event Bus
- multi-user auth
- real-time collaborative editing
- MCP
- background distillation daemon
- advanced reranker
- Konva diagram editing
- code execution sandbox

## 15. 実装上の注意

- memoryRouter のコードはそのまま丸ごとコピーせず、regular-rag の命名と責務に合わせて移植する
- source ingestion と wiki editing は app 機能として扱い、RAG retrieval core と混ぜすぎない
- `rag_documents` と `source_fragments` の役割を曖昧にしない
- embedding dimension は migration 前に必ず固定する
- Markdown sanitize と slug validation は UI だけでなく API 側で必ず実行する
- large import は後で job 化できるように service boundary を分ける
- LLM の artifact 出力は必ず validation してから保存する
- Hono route の request/response schema は Zod で明示する

## 16. 最初に着手する順序

1. README / plan / package scripts を Hono 専用方向へ合わせる
2. lint warning を潰して既存品質ゲートを安定させる
3. `src/app/hono.ts` と `src/app/server.ts` を作る
4. `sources` / `source_fragments` / chat / artifact schema と migration を追加する
5. memoryRouter から wiki slug / sanitize / content-repo を adapter 境界つきで移植する
6. Markdown reindex route と CLI を作る
7. source fragment retrieval を実装する
8. citation-backed `POST /api/chat` を作る
9. Knowledge Explorer UI を移植する
10. Chat + Artifact Panel を追加する
