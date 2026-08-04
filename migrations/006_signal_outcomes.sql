-- 006_signal_outcomes.sql
-- アウトオブサンプル追跡: scan_resultsに記録済みの日次シグナルについて、
-- 20営業日後の実際の株価を後から記録できるようカラムを追加する。
--
-- これまでの検証(docs/検証結果まとめ_2026-08.md)はすべてイン・サンプル
-- （過去データに対する事後検証）だった。実際に「今後出るシグナル」を
-- 追跡することで、初めてアウト・オブ・サンプルの検証ができるようになる。
--
-- 適用: Supabase SQL Editor で1回だけ実行する。

alter table scan_results add column if not exists ret20 numeric;
alter table scan_results add column if not exists outcome_computed_at timestamptz;

-- outcome_computed_at is null のシグナル（＝まだ結果を計算していないシグナル）を
-- 古い順に探すクエリを高速化する
create index if not exists scan_results_outcome_pending_idx
  on scan_results(scan_date) where outcome_computed_at is null;
