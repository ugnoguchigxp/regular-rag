# 🚀 regular-rag

[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh/)
[![Hono](https://img.shields.io/badge/Hono-%23E36022.svg?style=for-the-badge&logo=hono&logoColor=white)](https://hono.dev/)
[![React](https://img.shields.io/badge/React-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-%23316192.svg?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)

Hono (Backend) + React & Vite (Frontend) で構築された、**ローカル Markdown 知識ベース専用のエンタープライズグレード RAG (Retrieval-Augmented Generation) プラットフォーム**です。  
独自のハイブリッド検索（pgvector + PostgreSQL 全文検索）と、OpenAI/Azure OpenAI の **Responses API を用いた自律的エージェント検索 (Agentic Search)** を備え、Claude風の **Artifact 自動抽出エンジン** や **堅牢なロールベースユーザー管理 (RBAC)** を完備しています。

---

## 🌟 主な機能 (Key Features)

### 1. 🔍 ハイブリッド・セマンティック検索 (RRF Hybrid Search)
* **セマンティック検索**: `pgvector` を用いた高精度な多次元ベクトル近傍探索。
* **高速全文検索**: PostgreSQL の `pg_trgm` と FTS (Full-Text Search) を利用した日本語対応トークナイズド探索。
* **RRF (Reciprocal Rank Fusion)**: ベクトルスコアとテキストスコアを自動で重み付け融合し、最適な順位で知識断片（Fragments）をマージ・抽出します。

### 2. 🤖 自律的エージェント検索 (Agentic Search)
OpenAI / Azure OpenAI の `function tools` や `Responses API` を用いた、LLM自身が能動的に情報収拾と検証を行うアドバンスド検索モードです。以下のツールを状況に応じて自律的に呼び出します。
* `full_text_search` / `vector_search`: ナレッジベースのインデックス検索。
* `wiki_read`: チャンク断片（Fragment）だけでなく、オリジナルのWikiドキュメント本文をまるごと動的に読み直して文脈を検証。
* `web_search`: ローカルナレッジにない時事問題や外部知識を補うため、**Exa Search** や **Brave Search** を用いてWeb検索。
* `fetch`: Web検索結果のURLからHTMLをフェッチし、`cheerio` を用いて不要タグ（広告・ナビゲーション等）を除去・最適化したクリーンな本文テキストを抽出してコンテキストに挿入。

### 3. 💎 Claude風 Artifacts エンジン
生成AIの出力に含まれるコードやデータ構造をリアルタイムで検知し、右側の専用パネルに美しいカードビューとして自動抽出・バージョン管理します。
* **サポート形式**: `markdown`, `table`, `mermaid` (ダイアグラム自動描画), `chart`, `json`, `code`, `diagram-dsl`。

### 4. 🔒 堅牢なロールベースユーザー管理 (RBAC & Auth)
セルフサインアップを意図的に排除し、クローズドな知識共有に適した強固な認証システムを実装しています。
* **暗号化アルゴリズム**: `scrypt` による安全なパスワードハッシュ。
* **セッション管理**: `jose` ライブラリを用いた、JWT Access/Refresh Tokens の httpOnly Cookie 管理。
* **安全な設計**: Refresh Token の SHA-256 ハッシュ化DB保存、およびワンタイム利用によるローテーション。
* **通信セキュリティ**: CORS許可オリジン制御 / CSRF保護 / Secure Headers / レート制限を標準適用。
* **管理者機能**: `admin` ロール専用のユーザー追加・無効化（`isActive` の制御）・パスワードリセットが可能な「管理者管理パネル」を内蔵。

---

## 🏗️ システムアーキテクチャ (Architecture)

```mermaid
graph TD
    subgraph Frontend (React + Vite)
        UI[App.tsx] -->|React Router / UI Components| Tabs[Knowledge | Chat | Search | Admin]
        UI -->|API Client| API[api.ts]
    end

    subgraph Backend (Hono + Bun)
        API -->|HTTP Requests| Hono[app/server.ts]
        Hono -->|Secure Auth Middleware| Auth[modules/auth]
        Hono -->|API Routes| Routes[routes/*]
        
        subgraph Services & Logic
            Routes -->|RAG Operations| Rag[modules/rag]
            Routes -->|Chat Completion| Chat[modules/chat]
            Routes -->|Agentic Loop| Agent[modules/agentic-search]
        end
    end

    subgraph Database & AI
        Rag -->|Hybrid Retriever / RRF| DB[(PostgreSQL + pgvector)]
        Chat -->|Context Construction| DB
        Agent -->|Tool Execution| Tools[Registry: Search, Wiki, Web, Fetch]
        Tools -->|Vector Search| DB
        Tools -->|Web Search| Exa[Exa / Brave API]
        Tools -->|Fetch Page| Cheerio[cheerio DOM Parser]
        
        Agent -->|Responses API| LLM[OpenAI / Azure OpenAI]
    end
```

---

## 🛠️ 前提条件 (Prerequisites)

* **Bun** (>= 1.0)
* **PostgreSQL** (with `vector` and `pg_trgm` extensions enabled)
* **AI API Credentials**:
  * **Azure OpenAI** or **OpenAI** API Key
  * **Exa Search** or **Brave Search** API Key (Web検索機能用)

---

## 📦 セットアップ & インストール (Installation)

### 1. 依存関係のインストール
```bash
bun install
```

### 2. 環境変数の設定
`.env.example` をコピーして `.env` を作成し、必要なパラメータを設定します。
```bash
cp .env.example .env
```

| 変数名 | 説明 | 既定値 / 例 |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL 接続文字列 | `postgres://user:pass@localhost:5432/regular_rag` |
| `REGULAR_RAG_CONTENT_ROOT` | Markdown知識ベースの格納ルートディレクトリ | `../wiki-knowledge` |
| `JWT_SECRET` | JWTアクセストークン署名用のシークレット | (ランダムな文字列を設定) |
| `COOKIE_SAME_SITE` | 認証Cookieの `SameSite` 属性 | `lax` (`none` の場合は HTTPS 必須) |
| `APP_URL` | 公開アプリURL (HTTPS 判定・Cookie secure 判定に利用) | `http://localhost:5173` |
| `CORS_ORIGIN` | API を許可する Origin (`,` 区切り) | `http://localhost:5173` |
| `TRUST_PROXY` | `x-forwarded-for` 等のプロキシヘッダを信頼するか | `false` |
| `WEB_SEARCH_PROVIDER` | Web検索プロバイダ名 | `exa` または `brave` |
| `EXA_API_KEY` | Exa Web Search API キー | (Exaを利用する場合設定) |
| `BRAVE_SEARCH_API_KEY` | Brave Search API キー | (Braveを利用する場合設定) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI の API キー | (Azure OpenAI利用時) |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI の エンドポイント URL | `https://xxxx.openai.azure.com/` |
| `AZURE_OPENAI_DEPLOYMENT` | チャット/エージェント用デプロイ名 | `gpt-5-4-mini` 等 |
| `OPENAI_API_KEY` | OpenAI 直利用時の API キー | (OpenAI直利用時) |

### 3. PostgreSQL のローカル起動 (Docker)
ローカルで Docker を用いてベクトル対応の PostgreSQL を立ち上げる場合は、以下を実行します。
```bash
docker compose up -d db
```

### 4. データベース・マイグレーション
Drizzle ORM を使ってテーブルを作成し、`vector` / `pg_trgm` エクステンションを有効化します。
```bash
bun run db:migrate
```

### 5. 初期管理者（Admin）のアカウント作成
セルフサインアップが無効化されているため、初回のみ CLI を用いて管理ユーザーを作成します。
```bash
bun run auth:create-admin -- --email admin@example.com --name Admin
```
*(実行時に対話形式でパスワードの入力が求められます)*

---

## 🚀 クイックスタート (Quick Start)

### 1. 開発用サーバーの起動
フロントエンド (Vite) と バックエンド (Hono) を同時に統合した開発サーバーを起動します。
```bash
bun run dev
```
* **UI アプリケーション**: [http://localhost:5173](http://localhost:5173)
* **API エンドポイント**: `http://localhost:5173/api/*`

### 2. 知識ベース (Markdown) のインデックス化
RAGの対象とするドキュメント（`pages/<category>/**/*.md`）を読み込み、FTSインデックスの作成と Embedding ベクトルの自動計算（バックフィル）を一括実行します。
```bash
bun run wiki:index:all
```

### 3. Agentic Search 疎通テスト
LLMの接続状態、Embeddingの作成能力、およびエージェントの自律応答フローに問題がないか確認できるスモークテスト用 CLI を備えています。
```bash
bun run agentic:smoke
```

---

## 📖 機能と仕様の詳細 (Deep Dive)

### 📂 Markdown 取り込みのカテゴリルール
知識ベースは以下のルールに従って配置してください。
* `pages/` 直下の第1階層フォルダがそのまま「カテゴリ」として認識されます。
  * `pages/tech/hono.md` ➔ カテゴリは `tech`、slugは `tech/hono`
  * `pages/finance/report.md` ➔ カテゴリは `finance`、slugは `finance/report`
* `pages/` 直下への直接的な Markdown ファイル配置はエラーとなるため避けてください。

### ⚙️ 品質ゲート (Quality Gates)
プロダクションリリースの品質を保証するため、以下のCIチェックを実行可能です。
```bash
bun run verify
```
これにより、以下のプロセスがシーケンシャルに検証されます。
1. **型チェック**: `tsc --noEmit`
2. **静的解析 (Biom Linter)**: `biome lint`
3. **コードフォーマットチェック**: `biome format`
4. **テストスイート実行 (Vitest)**: `vitest run`
5. **プロダクションビルドテスト**: `tsup` & `vite build`

---

## 📋 主要 API エンドポイント

### 🔐 認証 (Authentication)
* `POST /api/auth/login` - ログイン (httpOnly Cookie にトークンをセット)
* `POST /api/auth/refresh` - トークンのリフレッシュ・ローテーション
* `POST /api/auth/logout` - ログアウト (Cookieクリア)
* `GET /api/auth/me` - 現在ログインしているユーザー情報の取得

### 👥 管理者機能 (Admin Users - 要 Admin 権限)
* `GET /api/admin/users` - 登録ユーザー一覧の取得
* `POST /api/admin/users` - 新規ユーザーの招待/作成
* `PATCH /api/admin/users/:userId` - ユーザー名やロールの更新
* `POST /api/admin/users/:userId/disable` - ユーザーのアカウント有効化/無効化
* `POST /api/admin/users/:userId/reset-password` - パスワードの強制リセット

### 💬 チャット & 検索 (Chat & RAG Search)
* `POST /api/chat` - RAGを活用した対話 (履歴のユーザー保存)
* `GET /api/chat/conversations` - チャットセッション履歴の取得
* `DELETE /api/chat/conversations/:conversationId` - 会話セッションの削除
* `POST /api/search` - 通常のハイブリッド検索結果（全文 vs ベクトル）の比較結果取得
* `POST /api/agentic-search` - 自律的エージェント型検索の実行

---

## 💎 プロジェクトのディレクトリ構造

```txt
src/
  app/                    # Hono アプリのブートストラップ・サーバー設定
  routes/                 # API ルート定義 (認証、検索、管理機能など)
  middleware/             # JWT認証認証・管理者検証などのミドルウェア
  db/                     # Drizzle スキーマ、マイグレーション、DB接続
  modules/
    auth/                 # 認証ロジック、パスワードハッシュ (scrypt)
    settings/             # ユーザー設定・システムコンテキストの永続化
    rag/                  # ハイブリッドリトリーバー (RRFマージ)
    agentic-search/       # エージェントループ、MCP互換ツール、LLMアダプター
    sources/              # Wiki記事の解析、Slug生成、インポータ
    chat/                 # チャットサービス、RAGメッセージ管理
    artifacts/            # <artifact> XML抽出と解析
web/
  src/
    domains/              # 機能ドメイン別のコンポーネント (Chat, Search)
    admin-user-management/# 管理者向けユーザー管理パネル UI
    knowledge-workspace/  # 知識ベース (Wiki) の閲覧・編集ワークスペース
    api.ts                # バックエンドAPIへの接続クライアント
    App.tsx               # アプリケーションのメイン画面・認証ラッパー
    styles.css            # プレミアムでモダンな Vanilla CSS デザイン
```

---

## 🤝 貢献方法 (Contributing)

1. リポジトリをフォークします。
2. 機能追加やバグ修正を行い、ブランチを作成します。
3. コードがフォーマットされ、テストが通ることを確認します (`bun run verify`)。
4. プルリクエストを作成してください。

---

## 📄 ライセンス

本プロジェクトは [MIT License](LICENSE.md) のもとで公開されています。
