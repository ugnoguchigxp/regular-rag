# 認証・ユーザー管理 UI 実装計画

作成日: 2026-05-18

## 目的

`regular-rag` にログイン機能を追加し、ローカル Wiki、Chat、Search、Settings をユーザー単位で安全に扱えるようにする。

`../hono-standard` の認証実装は土台として採用する。ただし、誰でもアカウントを作れる公開 `register` は導入しない。ユーザー作成は管理者だけが実行できる管理メニュー/API に限定する。

## 基本方針

- 公開セルフサインアップは作らない。
- 初期管理者アカウントだけは CLI または明示的な bootstrap 環境変数で作成する。
- 2人目以降のユーザーは、管理者が管理画面から作成する。
- 管理メニューは `admin` ロールのユーザーにだけ表示する。
- 管理 API は UI 表示制御とは別に、サーバー側 middleware で必ず `admin` ロールを検証する。
- ユーザー削除は初期実装では物理削除せず、`isActive=false` の無効化を基本にする。
- `hono-standard` からは認証コアを移植し、OpenAPI/TanStack Router 前提の構造は持ち込まない。

## 移植するもの

`../hono-standard` から以下を regular-rag の構造に合わせて移植する。

- Argon2id による password hash / verify
- `jose` による access token / refresh token
- refresh token の SHA-256 ハッシュ保存
- refresh token のワンタイム消費とローテーション
- httpOnly cookie helper
- auth middleware
- auth service
- auth route
- CSRF middleware
- secure headers
- 認証系 rate limit

移植しないもの、または後回しにするもの:

- 公開 `POST /api/auth/register`
- OAuth login
- `@hono/zod-openapi` 前提の route 定義
- Hono RPC 前提の frontend client

## データモデル

### users

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text,
  display_name text not null,
  role text not null default 'member',
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`role` は初期実装では `admin | member` の2値に限定する。将来権限が増えるまでは RBAC テーブルを作らず、列で十分にする。

### refresh_tokens

```sql
create table refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

`token` には refresh token 本体ではなく SHA-256 hash を保存する。

### user_settings

現在の `user_settings.user_id text` は一旦維持し、認証導入時に実ユーザー ID を保存する形へ寄せる。

移行方針:

- 既存の `__global_system_context__` は migration 後も残す。
- ログイン済みユーザーの Settings は `users.id` 文字列を `user_settings.user_id` に保存する。
- 初期表示時にユーザー固有の SystemContext がなければ global を fallback として表示する。
- 保存時は必ずユーザー固有レコードとして保存する。

後で厳密化したくなったら `user_settings.user_id uuid references users(id)` へ migration する。

## 初期管理者作成

公開登録を作らないため、初回ログイン可能ユーザーはサーバー側で作る必要がある。

推奨は CLI:

```bash
bun run auth:create-admin -- --email admin@example.com --name Admin
```

挙動:

- email と name を受け取る。
- パスワードは対話入力、または `--password-stdin` のみ許可する。
- 既に同じ email があれば失敗する。
- 初回作成ユーザーの role は `admin`。
- password hash は Argon2id。

開発用途としてだけ、以下の bootstrap env も検討できる。

- `REGULAR_RAG_BOOTSTRAP_ADMIN_EMAIL`
- `REGULAR_RAG_BOOTSTRAP_ADMIN_PASSWORD`
- `REGULAR_RAG_BOOTSTRAP_ADMIN_NAME`

ただし env bootstrap は誤運用しやすいため、実装する場合も `users` が空のときだけ有効にする。

## API 設計

### Public Auth

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me`

`/api/auth/login` は email/password を受け取り、成功時に access/refresh cookie を設定する。レスポンスには user id, email, displayName, role を返す。

`/api/auth/me` は未ログインなら `401`。ログイン済みなら現在ユーザーを返す。

### Admin Users

全て `requireAdmin` middleware を通す。

- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:userId`
- `POST /api/admin/users/:userId/reset-password`
- `POST /api/admin/users/:userId/disable`
- `POST /api/admin/users/:userId/enable`

`POST /api/admin/users` は管理者だけが使える実質的なユーザー作成 API とする。

作成時の入力:

```json
{
  "email": "user@example.com",
  "displayName": "User Name",
  "role": "member",
  "initialPassword": "temporary-password"
}
```

初期実装ではメール送信を持たないため、管理者が仮パスワードを設定する。将来メール送信を入れる場合は invitation token 方式へ置き換える。

### Route Protection

初期導入では、以下を除く `/api/*` を認証必須にする。

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- 静的 frontend assets

`/api/sources` の write 系、`/api/settings`、`/api/chat`、`/api/agentic-search` はログイン必須にする。管理者専用にする範囲は別途決めるが、少なくとも user management は admin-only とする。

## Frontend 設計

### Auth State

`web/src/auth.tsx` か `web/src/auth-context.tsx` を追加する。

状態:

- `user`
- `isLoading`
- `isAuthenticated`
- `isAdmin`
- `login()`
- `logout()`
- `reloadMe()`

`web/src/api.ts` の `requestJson` は `credentials: "include"` を標準にし、`401` の場合は一度だけ `/api/auth/refresh` を試してから再実行する。

### Login 画面

未ログイン時はアプリ本体を表示せず、ログイン画面を表示する。

構成:

- email input
- password input
- login button
- error message

公開登録リンクは置かない。

### Admin Menu

`web/src/App.tsx` の `TabId` に `admin` を追加する。ただし `tabItems` には `isAdmin` のときだけ含める。

表示名:

- `Admin`

アイコン候補:

- `Shield`
- `Users`

管理者でないユーザーが URL や state 操作で Admin タブを開こうとしても、frontend では Settings または Chat に戻す。加えて backend の admin API で必ず拒否する。

### User Management UI

Admin タブに `Users` パネルを作る。

表示項目:

- email
- display name
- role
- status
- last login
- created at

操作:

- Create user
- Edit display name
- Change role
- Enable / disable
- Reset password

初期 UI はテーブル中心にする。既存 UI は業務ツール寄りなので、カードを並べるより、一覧・操作ボタン・ダイアログの構成が適している。

詳細:

- disable は自分自身には実行不可。
- 最後の admin を member に変更または disable できないようにする。
- password reset は新しい仮パスワードを管理者が入力する。
- ユーザー作成時も password reset 時も、パスワードは画面に再表示しない。

## SystemContext との接続

ログイン導入後の Settings は、現在の global SystemContext からユーザー別 SystemContext へ移行する。

挙動:

- member は自分の SystemContext だけ編集できる。
- admin も通常は自分の SystemContext を編集する。
- global fallback は読み取り fallback として残す。
- admin が全体既定値を編集する UI は初期実装では必須にしない。必要なら Admin タブに `Global Defaults` として追加する。

Agentic Search / Chat は、実行時に `currentUser.id` を使って SystemContext を取得する。

## 実装順序

1. 認証 DB schema と migration を追加する。
2. `src/modules/auth` に password/token/user/auth service を追加する。
3. `src/routes/auth.route.ts` と `src/middleware/auth.ts` を追加する。
4. `src/app/hono.ts` に cookie, CSRF, secure headers, rate limit, auth route を組み込む。
5. `auth:create-admin` CLI を追加する。
6. frontend に AuthProvider と Login 画面を追加する。
7. `requestJson` に cookie と refresh retry を追加する。
8. Admin tab と user management API/UI を追加する。
9. Settings/SystemContext を current user 対応に変える。
10. Chat / Agentic Search / Sources の API をログイン必須にする。

## 検証

最低限のテスト:

- password hash / verify
- access token verify
- refresh token hash 保存
- refresh token one-time rotation
- login cookie 設定
- logout cookie clear
- unauthenticated request が `401`
- member が `/api/admin/users` にアクセスすると `403`
- admin が user 作成できる
- 自分自身 disable が拒否される
- 最後の admin 降格/disable が拒否される
- SystemContext が user ごとに保存される

手動確認:

- CLI で admin 作成
- admin でログイン
- Admin タブが表示される
- member を作成
- member でログイン
- Admin タブが表示されない
- member が direct API で admin API を叩いても拒否される

品質ゲート:

```bash
bun run verify
```

## 推奨判断

`hono-standard` の認証コアは移植推奨。ただし regular-rag では公開登録を持たない運用が前提なので、`register` ではなく admin-only user creation と bootstrap admin を中心に設計する。

この方針なら、今の単一ユーザー前提を壊さずにログインを追加でき、後で user-specific SystemContext、会話履歴のユーザー分離、管理者用監査ログへ段階的に広げられる。
