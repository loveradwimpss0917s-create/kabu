-- 003_bt_cache.sql
-- Phase「測定器の強化」: 検証ユニバース拡張・データキャッシュ用テーブル
-- 適用: Supabase SQL Editor で1回だけ実行する。

-- 検証対象銘柄リスト（umihico/kabu-jsonから抽出した普通株。ETF/REIT/ファンド等は除外）
create table bt_universe (
  code text primary key,
  name text not null,
  added_at timestamptz not null default now()
);

-- 日足OHLCVキャッシュ。1銘柄1行・JSONB配列で全期間を保持する
-- （1行/日の設計だと3,770銘柄×10年で約950万行になりSupabase無料枠を超えるため、
--   JSONB圧縮が効く1行/銘柄形式にして数百MB程度に収める）
create table bt_prices_cache (
  code text primary key references bt_universe(code) on delete cascade,
  fetched_at timestamptz not null default now(),
  bar_count int not null,
  start_date date,
  end_date date,
  status text not null default 'done', -- done | error
  error_message text,
  series jsonb -- { dates:[epoch秒...], open:[...], high:[...], low:[...], close:[...], adjclose:[...], volume:[...] }
);

create index bt_prices_cache_status_idx on bt_prices_cache(status);

-- RLS: 読み取りは誰でも可（backtest/run.mjsがanonキーで読む）。
-- 書き込みはSUPABASE_SERVICE_KEY（service_role、RLSを常にバイパスする）を使う
-- build-universe.mjs / fetch-cache.mjs のみが行うため、INSERT/UPDATE/DELETEの
-- ポリシーは意図的に作らない（anonキーでは書き込めない）
alter table bt_universe enable row level security;
alter table bt_prices_cache enable row level security;

create policy public_select on bt_universe for select using (true);
create policy public_select on bt_prices_cache for select using (true);
