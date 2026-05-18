# Agentic Search 実装計画

作成日: 2026-05-18

## 目的

Search 画面に紫色の `Agentic Search` ボタンを追加し、通常の全文検索/Vector検索とは別に、OpenAI API を使った能動的な検索回答モードを作る。

このモードでは、LLM が内部ツールを必要に応じて呼び出し、十分に回答できるかを LLM 自身が判断してから自然言語の回答を返す。検索対象はローカル Wiki のチャンク検索だけに閉じず、チャンクから元 Wiki 本文を読み直す手段と、Web Search / fetch による外部情報取得も使える形にする。

この計画書は実装前の設計であり、現時点ではコード変更を行わない。

## 現状整理

### Frontend

- 画面本体は `web/src/App.tsx` に集約されている。
- `TabId` は `knowledge | chat | search | settings`。
- Search タブは `Fragment Search` として実装済み。
  - カテゴリ select
  - 検索 input
  - 青色の通常 `Search` ボタン
  - `Full-text Search` / `Vector Search` の2カラム表示
- `web/src/styles.css` には既に `.btn-primary` と `.btn-agentic` がある。
  - `.btn-agentic` は紫色ボタンとして定義済み。
  - App 側にはまだ `Agentic Search` ボタンがない。
- Settings タブは `API Health` と `Knowledge Git` の表示のみで、設定編集 UI はない。

### Backend / Retrieval

- `/api/search` は `src/routes/search.route.ts`。
- 検索実体は `SourceRetriever.evaluate()`。
  - `SourceRepository.searchSourceContent()` で全文検索。
  - `SourceRepository.vectorSearchSourceContent()` で Vector 検索。
  - RRF で `mergedResults` を作り、`selectedResults` として返す。
- Wiki は `sources` と `source_fragments` に保存されている。
  - `sources.body` は元本文。
  - `source_fragments.content` はチャンク本文。
  - `source_fragments.embedding` は pgvector 用。
  - `source_fragments.search_vector` / `content_trgm` は全文検索用。
- `resolveWikiLinkRef()` により検索結果から `wikiSlug`, `wikiApiPath`, `wikiRawPath` を復元できる。
- Wiki ファイルの読み書きは `src/modules/sources/wiki/content-repo.ts`。
  - `readPage(contentRoot, slug)` で現行 Wiki 本文を読める。
- Web Search Provider は Exa を標準にし、Brave は明示 fallback として残す。
- fetch 本文抽出用の `cheerio` は依存に存在する。

### LLM Provider

- 現在の `LlmProvider` は `chatCompletion(messages, options)` のみ。
- `AzureOpenAiProvider` は Chat Completions 形式で、tool calling の戻り値や tool result 再投入を表す型がない。
- Agentic Search は OpenAI API の tool calling が中心になるため、既存 Chat 用 Provider に直接押し込まず、Agentic Search 専用 Adapter を追加する。

## 実装方針

### 1. UI の責務

Search タブは通常検索と Agentic Search を同じクエリ入力から起動できるようにする。

実装対象:

- `web/src/App.tsx`
  - `handleAgenticSearch()` を追加。
  - 既存の `Search` ボタンの横に紫色の `Agentic Search` ボタンを追加。
  - アイコンは `lucide-react` の `Sparkles` か `Bot` を使う。
  - CSS は既存 `.search-btn.btn-agentic` を使う。
- `web/src/api.ts`
  - `agenticSearch()` client を追加。
  - `fetchSystemContext()` / `updateSystemContext()` client を追加。
- Search 結果 UI
  - 通常検索の2カラム表示は維持。
  - Agentic Search 実行後は同じ Search パネル内に回答ブロックを表示する。
  - 最低限表示するもの:
    - `answer`
    - citations / evidence links
    - tool trace summary
    - usage が取れた場合の token usage
  - Wiki citation は既存と同じく Knowledge タブへ遷移できるようにする。
  - Web citation は外部リンクとして開く。

ユーザー体験:

- 青い `Search`: 既存の全文/Vector比較。
- 紫の `Agentic Search`: LLM がツールを使って回答を生成。
- 同じクエリで両方を比較できるよう、通常検索結果を消さず、Agentic Search 結果は別ブロックに表示する。

### 2. Settings の SystemContext

Settings に SystemContext 編集用 TextArea を追加する。

実装対象:

- `web/src/App.tsx`
  - Settings タブに `System Context` パネルを追加。
  - TextArea と `Save` ボタンを置く。
  - 初期表示時に API から読み込む。
  - 保存成功/失敗は既存 `errorText` と軽い状態表示で扱う。
- `web/src/api.ts`
  - `fetchSystemContext()`
  - `updateSystemContext(systemContext: string)`

保存方針:

- localStorage ではなく DB に保存する。
- 現時点ではログイン/ユーザー概念がないため、サーバー側で仮ユーザー `local` を使う。
- 後日ログインを入れたら、クライアントから `userId` を送らせず、認証 middleware が `currentUserId` を解決する。

追加テーブル案:

```sql
create table user_settings (
  user_id text primary key,
  system_context text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

ルート案:

- `GET /api/settings/system-context`
- `PUT /api/settings/system-context`

リクエスト:

```json
{ "systemContext": "..." }
```

レスポンス:

```json
{
  "userId": "local",
  "systemContext": "...",
  "updatedAt": "2026-05-18T..."
}
```

後日の認証導入時:

- `resolveCurrentUserId(c)` のような小さい関数を route 層に置く。
- 初期実装では常に `"local"` を返す。
- 認証導入時にこの関数だけを置き換え、SystemContext の保存形式は変えない。

### 3. Agentic Search API

新規 route:

- `POST /api/agentic-search`

リクエスト:

```json
{
  "query": "質問",
  "category": "tech",
  "topK": 8
}
```

レスポンス:

```json
{
  "query": "質問",
  "answer": "LLM が生成した回答",
  "citations": [
    {
      "kind": "wiki_fragment",
      "title": "...",
      "uri": "...",
      "locator": "chunk:0001",
      "wikiSlug": "tech/..."
    },
    {
      "kind": "web",
      "title": "...",
      "url": "https://..."
    }
  ],
  "toolTrace": [
    {
      "tool": "full_text_search",
      "status": "ok",
      "resultCount": 5,
      "elapsedMs": 42
    }
  ],
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "totalTokens": 0
  }
}
```

初期実装では Agentic Search の回答履歴は永続化しない。必要になったら `agentic_search_runs` を追加する。まずは UI 表示と tool trace の返却に絞り、raw web content や raw page body を大量保存しない。

### 4. 内部ツール層

Agentic Search 専用に `src/modules/agentic-search/` を追加する。

想定構成:

```txt
src/modules/agentic-search/
  agentic-search.service.ts
  runner.ts
  system-context.ts
  types.ts
  llm/
    openai-responses-adapter.ts
  tools/
    registry.ts
    full-text-search.tool.ts
    vector-search.tool.ts
    wiki-read.tool.ts
    brave-search.tool.ts
    fetch.tool.ts
```

ツールは MCP に近い境界で定義する。

- name
- description
- JSON Schema parameters
- executor
- compact result formatter

OpenAI の Responses API は remote MCP server も扱えるが、OpenAI 側から直接呼べる MCP server は Streamable HTTP または HTTP/SSE で到達可能である必要がある。ローカル開発の Hono アプリをそのまま OpenAI から呼ばせるのは前提が重くなるため、初期実装では以下の形にする。

- regular-rag 内部では MCP-compatible な tool registry を作る。
- OpenAI API へは function tools として渡す。
- model が `function_call` を返したら、server-side runner が同じ registry の executor を実行する。
- 将来 remote MCP として公開する必要が出た場合、registry を MCP server wrapper に接続する。

これにより、ツール定義と実行責務は MCP 的に分離しつつ、ローカル環境でも安定して動かせる。

### 5. Tool 一覧

#### `full_text_search`

目的:

- Wiki チャンクに対して全文検索を行う。

実装:

- `SourceRepository.searchSourceContent(query, limit, ["wiki"], categories)` を使う。

入力:

```json
{
  "query": "string",
  "topK": 8,
  "category": "tech"
}
```

出力:

- `RetrievedFragment` 相当の compact 形式。
- `id`, `sourceId`, `sourceUri`, `sourceCategory`, `locator`, `heading`, `content`, `textScore`, `wikiSlug`。

#### `vector_search`

目的:

- Wiki チャンクに対して Vector 検索を行う。

実装:

- `embeddingProvider.createEmbedding(query)`
- `SourceRepository.vectorSearchSourceContent(embedding, limit, ["wiki"], categories)`

注意:

- embedding 未設定/Provider 未設定の場合は失敗ではなく degraded result として返す。
- LLM には `vector_search unavailable` のように明示し、全文検索や web search に進める材料にする。

#### `wiki_read`

目的:

- チャンク検索で引っかかった断片だけでは判断できない場合に、元 Wiki 本文を読む。

実装候補:

1. `wikiSlug` がある場合は `readPage(contentRoot, wikiSlug)` で現在の Wiki ファイル本文を読む。
2. `sourceId` しかない場合は `SourceRepository.getSourceById()` を追加して `sources.body` を読む。
3. `sourceUri` しかない場合は `SourceRepository.getSourceByUri()` を追加して読む。

入力:

```json
{
  "wikiSlug": "tech/hono/routing",
  "sourceId": "uuid",
  "sourceUri": "...",
  "maxChars": 12000
}
```

出力:

- `title`
- `wikiSlug`
- `sourceUri`
- `bodyExcerpt`
- `bodyLength`
- `truncated`

本文全体を無制限に LLM へ渡さない。`maxChars` を持たせ、必要なら LLM が再度 query を狭めて検索する。

#### `web_search`

目的:

- ローカル Wiki だけでは不足する場合に Web 検索する。

実装:

- `WEB_SEARCH_PROVIDER=exa` の場合は `ExaSearchProvider` を runtime に追加。
- `EXA_API_KEY` がない場合は degraded result を返す。

入力:

```json
{
  "query": "string",
  "maxResults": 5
}
```

出力:

- `title`
- `url`
- `snippet`
- `position`

#### `fetch`

目的:

- Web 検索結果 URL や、LLM が必要と判断した URL の本文を取得する。

実装:

- `fetch()` + timeout。
- `cheerio` で HTML から `script`, `style`, `noscript`, nav/footer などを除去。
- text content を whitespace normalize して compact に返す。
- URL は `http:` / `https:` のみ許可。
- localhost/private IP は SSRF 防止のため拒否する。

入力:

```json
{
  "url": "https://example.com",
  "maxChars": 12000
}
```

出力:

- `url`
- `title`
- `text`
- `textLength`
- `truncated`
- `contentType`

`fetch` は回答生成ツールではなく、LLM に渡す文脈を減量するためのツールに限定する。

### 6. LLM Runner

Agentic Search は既存 Chat Service とは分ける。

理由:

- 既存 `ChatMessage` は `system | user | assistant` だけで、tool call / tool output を表現できない。
- Chat Service は会話保存と artifact extraction が主目的。
- Agentic Search は検索ツール実行、tool trace、回答可能性判断が主目的。

Runner の基本フロー:

1. request を受ける。
2. `currentUserId` を解決する。初期値は `local`。
3. `user_settings.system_context` を読む。
4. Agentic Search 用 SystemContext を組み立てる。
5. OpenAI Responses API に tools 付きで問い合わせる。
6. model が function call を返したら registry executor を実行する。
7. tool result を Responses input に追加して次の問い合わせを行う。
8. model が最終回答を返したら終了する。
9. tool trace と citations を整形して UI に返す。

回答可能性の判断:

- コード側で「この件数なら十分」のような意味判定をしない。
- SystemContext で「十分な根拠が揃うまで `full_text_search`, `vector_search`, `wiki_read`, `web_search`, `fetch` を使う。十分でなければ不足点を明示する」と指示する。
- LLM が最終回答を返した時点を「回答可能と判断した」と扱う。
- 安全上の上限として max tool calls / max elapsed time は設ける。

推奨上限:

- `maxToolCalls`: 10
- `maxFetchCalls`: 3
- `maxTotalContextChars`: 50000
- `requestTimeoutMs`: 60000

上限に達した場合:

- それまでの evidence を使って回答するか、不足を明示するよう LLM に最終問い合わせを行う。
- それでも回答がない場合のみ、サーバーが `Agentic Search could not complete within the tool budget.` を返す。

### 7. OpenAI API 方針

Agentic Search は OpenAI Responses API を優先する。

理由:

- Responses API は tool using / agentic workflow を前提にした API。
- function tools と remote MCP を同じ `tools` パラメータで扱える。
- function call output を input に戻す流れが明示されている。

追加環境変数:

```txt
OPENAI_API_KEY=
AZURE_OPENAI_DEPLOYMENT=gpt-5-4-mini
```

Agentic Search の model/deployment 名は `AZURE_OPENAI_DEPLOYMENT` を使う。
tool call 上限、fetch 上限、context 上限、debug default は
`src/modules/agentic-search/constants.ts` に定義する。

Adapter:

```txt
src/modules/agentic-search/llm/openai-responses-adapter.ts
```

責務:

- `responses.create` 呼び出し。
- tool definitions 変換。
- function_call item の抽出。
- function_call_output item の組み立て。
- output_text / usage の抽出。
- OpenAI SDK の response shape をアプリ内部型に閉じ込める。

既存 `AzureOpenAiProvider` は Chat / embedding 用として維持する。Agentic Search の OpenAI Responses 用 adapter とは混ぜない。

### 8. Citation と Evidence

Agentic Search の出力は自然言語回答を主にしつつ、根拠を追える形にする。

Citation kind:

- `wiki_fragment`
- `wiki_page`
- `web_search_result`
- `web_page`

Wiki citation:

- `sourceId`
- `fragmentId`
- `sourceUri`
- `wikiSlug`
- `locator`
- `heading`

Web citation:

- `title`
- `url`
- `snippet`
- `fetched: boolean`

tool result の raw content はそのまま UI に出さない。UI には trace summary と citations を出す。

### 9. 実装ステップ

#### Phase 1: Settings / SystemContext

1. `drizzle/0003_user_settings.sql` を追加。
2. `src/db/schema.ts` に `userSettings` を追加。
3. `src/modules/settings/settings.repository.ts` を追加。
4. `src/routes/settings.route.ts` を追加。
5. `src/app/hono.ts` に `/api/settings` を mount。
6. `web/src/api.ts` に settings client を追加。
7. `web/src/App.tsx` Settings タブに TextArea と Save ボタンを追加。
8. route/repository の unit test を追加。

#### Phase 2: Agentic Search tool registry

1. `src/modules/agentic-search/types.ts` を追加。
2. `tools/registry.ts` を追加。
3. `full-text-search.tool.ts` を追加。
4. `vector-search.tool.ts` を追加。
5. `wiki-read.tool.ts` を追加。
6. `brave-search.tool.ts` を追加。
7. `fetch.tool.ts` を追加。
8. 各 tool の unit test を追加。

#### Phase 3: OpenAI Responses adapter / runner

1. `openai` SDK を追加するか、既存 fetch wrapper で Responses API を呼ぶか決める。
   - 推奨は SDK 追加。Responses の item 型変化を手書きしすぎないため。
2. `openai-responses-adapter.ts` を追加。
3. `system-context.ts` を追加。
4. `runner.ts` を追加。
5. fake adapter を使った runner test を追加。
   - full_text -> vector -> wiki_read -> final answer
   - local evidence insufficient -> web_search -> fetch -> final answer
   - vector unavailable -> full_text / web で継続
   - max tool calls 到達
   - tool error があっても次の判断に進む

#### Phase 4: API route

1. `src/routes/agentic-search.route.ts` を追加。
2. request schema を `zod` で定義。
3. `src/app/hono.ts` に `/api/agentic-search` を mount。
4. `AppRuntime` に Web Search Provider と Agentic runner deps を追加。
5. `OPENAI_API_KEY` 未設定時は route で分かりやすい 503/400 を返す。

#### Phase 5: Search UI

1. `web/src/api.ts` に `agenticSearch()` を追加。
2. `web/src/App.tsx`
   - `agenticSearchResult`
   - `handleAgenticSearch`
   - 紫色ボタン
   - 回答表示パネル
   - tool trace summary
   - citations links
3. `.btn-agentic` は既存 CSS を再利用。
4. 必要なら `.agentic-result` 系の CSS だけ追加。

#### Phase 6: Docs / README

1. README に `POST /api/agentic-search` と Settings API を追記。
2. `.env.example` に OpenAI / Agentic Search の環境変数を追記。
3. Agentic Search の使い方と制限を短く追記。

## Validation

実装時に最低限通すもの:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build
```

最終確認:

```bash
bun run verify
```

追加で確認するシナリオ:

- Settings で SystemContext を保存し、再読込後も残る。
- Agentic Search が `full_text_search` と `vector_search` を使える。
- チャンクだけでは足りない質問で `wiki_read` が呼ばれる。
- ローカル Wiki に根拠がない質問で `web_search` と `fetch` が使われる。
- `WEB_SEARCH_PROVIDER=exa` で `EXA_API_KEY` がない場合に、ローカル検索だけで degrade する。
- `OPENAI_API_KEY` がない場合に、UI/API が明確な設定エラーを出す。
- fetch が `localhost`, private IP, non-http URL を拒否する。
- tool trace が UI に表示され、raw fetched body は大量表示されない。

## 実装時の注意

- 通常 `/api/search` の挙動は変えない。
- Agentic Search は既存 Chat Service に混ぜない。
- LLM の回答可能性判断を regex やローカル scoring で代替しない。
- code-side の上限は安全/コスト制御に限定する。
- Wiki 本文取得は必須ツールとして設計し、チャンク検索結果だけで回答品質を決めない。
- SystemContext はクライアントだけに保存しない。将来の user ごとの設定に移行できる DB 形にする。
- MCP 互換の tool registry を先に作り、remote MCP 公開は必要になってから wrapper として足す。

## 参照した OpenAI 公式ドキュメント

- [Using tools](https://developers.openai.com/api/docs/guides/tools)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling?api-mode=responses)
- [MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
