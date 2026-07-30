-- 004_earnings_calendar.sql
-- 決算日キャッシュ: 日次スキャナーが「決算まで7日以内はスコアを中立化する」veto判定を
-- 適用できるようにするためのテーブル。
--
-- 背景: worker.jsの日次スキャン(scanStock)は、CloudflareのSubrequest数上限(50/呼び出し)の
-- 制約から、1銘柄につき株価チャートのみ取得しており、決算日情報(quoteSummary/calendarEvents)
-- を毎回取得すると銘柄数が同じでも通信回数が2倍になり上限を超える。
-- そのため決算日は週次など低頻度のジョブ(scripts/fetch-earnings-calendar.mjs)で
-- このテーブルに事前キャッシュしておき、日次スキャンはテーブルを1回読むだけで済ませる。

create table earnings_calendar (
  code text primary key,
  next_earnings_epoch bigint,
  updated_at timestamptz not null default now()
);

alter table earnings_calendar enable row level security;
create policy public_select on earnings_calendar for select using (true);
