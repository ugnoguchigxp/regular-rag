# regular-rag

PostgreSQL (`pgvector` + 全文検索 + Knowledge Graph) を使った **フレームワーク非依存** の RAG バックエンドパッケージです。  
Hono / Express / Next.js / NestJS 等、任意のフレームワークから利用できます。

## 特徴

- 🚀 **フレームワーク非依存**: コアロジックが分離されており、Node.js 環境であればどこでも動作します。
- 🧠 **ハイブリッド検索**: `pgvector` によるベクトル検索と、PostgreSQL 標準の全文検索 (`tsvector`) を組み合わせた高精度な検索。
- 🌐 **Web検索フォールバック**:
  - ユーザーが `Web検索` / `Webで検索` などを明示した場合は、ローカルRAG検索よりWeb検索を優先。
  - ローカルRAG（全文検索+ベクトル検索）でヒットしない場合は、見つからなかった旨を伝えつつWeb検索結果で補完。
- 🕸️ **Knowledge Graph 連携**: エンティティ抽出とグラフ探索により、単純な類似度検索では届かないコンテキストを補完。
- 🛡️ **堅牢な設計**:
  - **セキュリティ**: SQLインジェクション（LIKEメタキャラクタ）対策、入力値バリデーション。
  - **信頼性**: Zod による LLM 出力の構造検証、DB接続失敗時の適切なリソース解放。
  - **型安全**: TypeScript による完全な型定義、`any` 型の排除。
- 🔌 **柔軟な接続管理**: 独自に DB 接続を持つことも、既存の `pg.Pool` / `pg.Client` (Prisma等) を使い回すことも可能。

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  regular-rag パッケージ                               │
│                                                     │
│  ┌──────────┐   ┌────────────────────────────────┐  │
│  │ RagEngine│──▶│ ChatbotService                 │  │
│  │ (facade) │   │  ├── LlmProvider (interface)   │  │
│  │          │   │  ├── EmbeddingProvider (if)     │  │
│  │          │   │  ├── RagRepository             │  │
│  │          │   │  │    ├── pgvector search       │  │
│  │          │   │  │    └── 全文検索 (tsvector)     │  │
│  │          │   │  ├── CacheRepository           │  │
│  │          │   │  └── KnowledgeGraphService      │  │
│  │          │   │       └── KnowledgeGraphRepository │  │
│  └──────────┘   └────────────────────────────────┘  │
│                                                     │
│  Providers (差し替え可能):                             │
│    └── AzureOpenAiProvider (LLM + Embedding)        │
│                                                     │
│  DB: Drizzle ORM (内部のみ使用, 外部pgクライアント受入可) │
└─────────────────────────────────────────────────────┘
        ▲           ▲            ▲            ▲
     Hono        Express      Next.js      NestJS
```

## セットアップ

```sh
bun install
cp .env.example .env
```

`.env` の `DATABASE_URL` と Azure OpenAI 系の値を設定してください。

## npm パッケージとして利用する

- Node.js: `>= 18`
- インストール:

```sh
npm install regular-rag
```

## クイックスタート

### 基本的な使い方

```typescript
import { RagEngine, AzureOpenAiProvider } from 'regular-rag';

// Provider を準備
const provider = new AzureOpenAiProvider({
  endpoint: 'https://YOUR_RESOURCE.openai.azure.com',
  apiKey: 'YOUR_API_KEY',
  deployment: 'gpt-4o-mini',
  embeddingsDeployment: 'text-embedding-3-small',
});

// RagEngine を起動
const engine = await RagEngine.create({
  databaseUrl: 'postgres://...',
  llmProvider: provider,
  embeddingProvider: provider,
});

// クエリ実行
const result = await engine.query([
  { role: 'user', content: '糖尿病の食事療法について教えてください' }
]);
console.log(result.content);
```

### 既存の pg.Pool と共存（Prisma 等との競合回避）

```typescript
import { Pool } from 'pg';
import { RagEngine, AzureOpenAiProvider } from 'regular-rag';

const pool = new Pool({ connectionString: 'postgres://...' });
const provider = AzureOpenAiProvider.fromEnv();

const engine = await RagEngine.create({
  pgClient: pool,        // 外部の接続を渡す（close責任はホスト側）
  llmProvider: provider,
  embeddingProvider: provider,
});
```

### フレームワーク別の利用例

<details>
<summary>Hono</summary>

```typescript
import { Hono } from 'hono';
import { RagEngine, AzureOpenAiProvider, readEnv } from 'regular-rag';

const env = readEnv();
const provider = AzureOpenAiProvider.fromEnv();
const engine = await RagEngine.create({
  databaseUrl: env.databaseUrl,
  llmProvider: provider,
  embeddingProvider: provider,
});

const app = new Hono();
app.post('/api/rag', async (c) => {
  const { messages } = await c.req.json();
  const result = await engine.query(messages);
  return c.json(result);
});

export default { port: env.port, fetch: app.fetch };
```

</details>

<details>
<summary>Express</summary>

```typescript
import express from 'express';
import { RagEngine, AzureOpenAiProvider } from 'regular-rag';

const provider = AzureOpenAiProvider.fromEnv();
const engine = await RagEngine.create({
  databaseUrl: process.env.DATABASE_URL!,
  llmProvider: provider,
  embeddingProvider: provider,
});

const app = express();
app.use(express.json());
app.post('/api/rag', async (req, res) => {
  const result = await engine.query(req.body.messages);
  res.json(result);
});

app.listen(3000);
```

</details>

<details>
<summary>Next.js (App Router)</summary>

```typescript
// app/api/rag/route.ts
import { RagEngine, AzureOpenAiProvider } from 'regular-rag';

const provider = AzureOpenAiProvider.fromEnv();
const engine = await RagEngine.create({
  databaseUrl: process.env.DATABASE_URL!,
  llmProvider: provider,
  embeddingProvider: provider,
});

export async function POST(request: Request) {
  const { messages } = await request.json();
  const result = await engine.query(messages);
  return Response.json(result);
}
```

</details>

<details>
<summary>NestJS</summary>

```typescript
// rag.module.ts
import { Module } from '@nestjs/common';
import { RagEngine, AzureOpenAiProvider } from 'regular-rag';

@Module({
  providers: [
    {
      provide: 'RAG_ENGINE',
      useFactory: async () => {
        const provider = AzureOpenAiProvider.fromEnv();
        return RagEngine.create({
          databaseUrl: process.env.DATABASE_URL!,
          llmProvider: provider,
          embeddingProvider: provider,
        });
      },
    },
  ],
  exports: ['RAG_ENGINE'],
})
export class RagModule {}

// rag.controller.ts
import { Controller, Post, Body, Inject } from '@nestjs/common';
import type { RagEngine, ChatMessage } from 'regular-rag';

@Controller('api/rag')
export class RagController {
  constructor(@Inject('RAG_ENGINE') private engine: RagEngine) {}

  @Post()
  async query(@Body() body: { messages: ChatMessage[] }) {
    return this.engine.query(body.messages);
  }
}
```

</details>

## デモアプリの起動

```sh
bun run dev
```

`http://localhost:3000` でチャットUIが起動します。

## Drizzle マイグレーション

```sh
bunx drizzle-kit generate
bunx drizzle-kit migrate
```

## テーブル構成

| テーブル | 用途 |
|---------|------|
| `rag_documents` | ドキュメント本体 + embedding (pgvector) + 全文検索 (tsvector) |
| `chatbot_cache` | LLM応答キャッシュ |
| `knowledge_nodes` | Knowledge Graph ノード |
| `knowledge_edges` | Knowledge Graph エッジ |

## ディレクトリ構成

```
regular-rag/
├── src/
│   ├── index.ts             # パッケージ公開API
│   ├── core/
│   │   └── RagEngine.ts     # メインファサード
│   ├── providers/
│   │   ├── types.ts          # LlmProvider / EmbeddingProvider interface
│   │   └── AzureOpenAiProvider.ts
│   ├── services/
│   │   ├── ChatbotService.ts
│   │   ├── KnowledgeGraphService.ts
│   │   └── GraphExtractor.ts
│   ├── repositories/
│   │   ├── RagRepository.ts  # pgvector + 全文検索
│   │   ├── CacheRepository.ts
│   │   └── KnowledgeGraphRepository.ts
│   ├── db/
│   │   ├── index.ts          # DB接続（外部pgクライアント対応）
│   │   └── schema.ts         # Drizzle テーブル定義
│   ├── config/
│   │   └── readEnv.ts
│   └── types/
│       └── llm.ts
├── examples/
│   ├── index.ts              # エントリポイント
│   ├── app.ts                # Hono アプリ定義
│   └── views/
│       └── chat.html         # チャットUI
├── data/                     # サンプルデータ
├── drizzle.config.ts
└── package.json
```
