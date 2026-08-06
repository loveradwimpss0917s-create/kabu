-- 007_fundamentals_pit.sql
-- バリュー・クオリティ系ファクター検証のための Point-in-Time 財務データ記録
--
-- ## なぜ必要か
-- これまでの検証(docs/検証結果まとめ_2026-08.md)はOHLCVのみを使い、テクニカル系の
-- 仮説を10件検証してすべて否定した。一方、日本株で学術的に最も頑健とされるのは
-- バリュー・クオリティ系である（Fama & French 2012 の日本のHMLは月0.47〜0.50%、
-- 年率約6%規模。Chan, Hamao & Lakonishok 1991 が古典）。我々はこの系統を一度も
-- 検証していない。
--
-- ## Point-in-Time が不可欠な理由
-- Yahoo Financeから取得できるのは「今日時点」の財務指標のみで、「2019年時点の
-- PBR」は取得できない。過去のバリュー戦略をバックテストするには、その時点で
-- 実際に入手可能だった値が必要になる。最新値で過去を評価すると、
--   (1) 業績修正・遡及修正（リステートメント）が未来情報として混入する
--   (2) そもそも当時は公表されていなかった値を使ってしまう
-- という形でルックアヘッドが発生し、バックテストが実運用で再現しなくなる。
--
-- 過去分は無料では入手できないため、**今日から記録を開始する**。
-- 1〜2年蓄積すれば、本物のPITデータでバリュー系ファクターを検証できる。
--
-- ## bitemporal（2つの時間軸）設計
--   fiscal_date … valid time: いつ時点の企業実態を表す値か（決算期末）
--   known_from  … transaction time: この値をいつ観測（DBが知った）か
-- 遡及修正は既存行を書き換えず、known_fromの異なる新しい行として追加する。
-- これにより「as_of時点で入手可能だった値」を
--   where known_from <= as_of  で正確に復元できる（過去を破壊しない）。
--
-- 適用: Supabase SQL Editor で1回だけ実行する。

create table fundamentals_pit (
  code text not null references bt_universe(code) on delete cascade,
  metric text not null,
  value numeric,
  -- valid time: どの決算期の実態か。Yahooが期末日を返さない指標ではnullになる
  fiscal_date date,
  -- transaction time: いつこの値を観測したか。PITスライスの基準になる
  known_from timestamptz not null default now(),
  source text not null default 'yahoo_quoteSummary',
  primary key (code, metric, known_from)
);

-- PITスライス（known_from <= as_of で最新のものを取る）を高速化する
create index fundamentals_pit_lookup_idx on fundamentals_pit(code, metric, known_from desc);
-- 特定指標の横断ソート（例: ある日の全銘柄PBRを並べる）を高速化する
create index fundamentals_pit_metric_idx on fundamentals_pit(metric, known_from desc);

alter table fundamentals_pit enable row level security;
create policy public_select on fundamentals_pit for select using (true);
