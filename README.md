# kabu (StockEdge)

日本株の売買タイミング判定PWA。Cloudflare Workers + Supabase。

## セットアップ

### 環境変数・Secret

`wrangler.toml` の `[vars]` には公開されても問題ない値（Supabase URL・anonキー）のみを置く。
以下は **Secret** としてのみ設定し、`wrangler.toml` には書かないこと。

| 変数名 | 用途 | 設定コマンド |
|---|---|---|
| `ADMIN_TOKEN` | `/api/scan-trigger`（手動スキャン起動）の認証トークン | `wrangler secret put ADMIN_TOKEN` |
| `SUPABASE_SERVICE_KEY` | Supabaseへの書き込み（cron / scan-trigger）用のservice_roleキー | `wrangler secret put SUPABASE_SERVICE_KEY` |

`ADMIN_TOKEN` は任意の十分に長いランダム文字列を自分で生成して設定する（例: `openssl rand -hex 32`）。
フロントエンド（index.html）にはこの値を一切埋め込んでいない。手動スキャンボタンを初めて押したときに
ブラウザの `prompt()` でトークン入力を求め、以後はその端末の `localStorage` にのみ保存される。
