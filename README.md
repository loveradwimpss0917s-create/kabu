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

同じ `ADMIN_TOKEN` は `/api/backtest-start`・`/api/backtest-trigger`（バックテスト操作）の認証にも使う。

### マイグレーション

`migrations/*.sql` はSupabase SQL Editorで番号順に1回ずつ実行する。

| ファイル | 内容 |
|---|---|
| `001_scan_results_unique.sql` | `scan_results` にupsert用のユニーク制約を追加 |
| `002_backtest.sql` | バックテスト用テーブル（`backtest_jobs`, `backtest_signals`）を作成 |
| `003_bt_cache.sql` | バックテスト用ユニバース・価格キャッシュ（`bt_universe`, `bt_prices_cache`）を作成 |
| `004_earnings_calendar.sql` | 決算日キャッシュ（`earnings_calendar`）を作成 |
| `005_sector_map.sql` | 業種分類キャッシュ（`sector_map`）を作成 |
| `006_signal_outcomes.sql` | `scan_results` に `ret20`/`outcome_computed_at` を追加（実運用シグナルのアウトオブサンプル追跡用） |

### バックテストAPI（Phase3・研究用）

過去3年の日足で `calcTradeScore` を日次シミュレーションし、スコア帯別の将来リターン・勝率・
市場（日経225）対比・8項目の加点別相関を集計する。81銘柄×3年分は1リクエストでは計算しきれないため、
`wrangler.toml` の2本目のcron（`*/2 * * * *`）が実行中ジョブを少しずつ進める。フロント右下の🧪ボタンから
操作できる（開始・手動での1チャンク進行・進捗確認・レポート表示）。

| エンドポイント | 認証 | 内容 |
|---|---|---|
| `POST /api/backtest-start` | ADMIN_TOKEN | 新規ジョブを作成しcursor=0から開始 |
| `POST /api/backtest-trigger` | ADMIN_TOKEN | 実行中ジョブを1チャンク（最大150営業日）進める |
| `GET /api/backtest-status` | 不要 | 最新（または指定`job_id`）のジョブ進捗を返す |
| `GET /api/backtest-report` | 不要 | `?job_id=&fee=&slippage=&tax=` でスコア帯別・項目別の集計レポートを返す |
