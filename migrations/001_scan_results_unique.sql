-- 001_scan_results_unique.sql
-- 目的: scan_results への書き込みを DELETE→INSERT から upsert (ON CONFLICT) に変更するため、
--       (scan_date, code) の一意性を保証する制約を追加する。
-- 適用: Supabase SQL Editor で1回だけ実行する。

-- 1) 既存の重複行があれば、同一 (scan_date, code) のうち最新の ctid だけ残して削除
delete from scan_results a
using scan_results b
where a.scan_date = b.scan_date
  and a.code = b.code
  and a.ctid < b.ctid;

-- 2) (scan_date, code) にユニーク制約を追加
--    worker.js の runScanner は Prefer: resolution=merge-duplicates でこの制約に対して upsert する
alter table scan_results
  add constraint scan_results_date_code_uniq unique (scan_date, code);
