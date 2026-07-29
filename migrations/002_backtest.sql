-- 002_backtest.sql
-- Phase3: バックテスト基盤用テーブル
-- 適用: Supabase SQL Editor で1回だけ実行する。

-- ジョブ管理（Cloudflare Workerの1回の実行では81銘柄×3年分を計算しきれないため、
-- (stock_index, day_cursor) 単位でチャンク実行できるようにカーソルを保持する）
create table backtest_jobs (
  id bigserial primary key,
  status text not null default 'running',   -- running | done
  cursor int not null default 0,            -- SCAN_STOCKSの次に処理する銘柄インデックス
  day_cursor int not null default 0,        -- 現在の銘柄内での評価開始オフセット
  total_stocks int not null,
  period_days int not null,                 -- 評価対象とする直近営業日数の目安
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1営業日ごとのシグナル・その時点までのデータのみで計算したスコア・将来リターン
create table backtest_signals (
  id bigserial primary key,
  job_id bigint not null references backtest_jobs(id) on delete cascade,
  code text not null,
  signal_date date not null,        -- スコア計算に使った最終足の日付（未来データは一切含まない）
  score numeric not null,
  signal text not null,
  score_bucket text not null,       -- '0-30' | '30-50' | '50-75' | '75-90' | '90-100'
  entry_price numeric,              -- 翌営業日始値（分割調整済み）
  fwd_ret_1 numeric,                -- +1営業日後の生リターン(%)（コスト・税引前）
  fwd_ret_5 numeric,
  fwd_ret_20 numeric,
  mkt_fwd_ret_1 numeric,            -- 同期間の日経225リターン(%)（近似ベンチマーク）
  mkt_fwd_ret_5 numeric,
  mkt_fwd_ret_20 numeric,
  vol_pts numeric,                  -- 8項目それぞれの加点内訳（相関検証用）
  ema_pts numeric,
  rsi_pts numeric,
  macd_pts numeric,
  atr_pts numeric,
  gap_pts numeric,
  w52_pts numeric,
  material_pts numeric,
  created_at timestamptz not null default now(),
  unique(job_id, code, signal_date)
);

create index backtest_signals_job_bucket_idx on backtest_signals(job_id, score_bucket);
