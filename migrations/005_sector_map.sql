-- 005_sector_map.sql
-- Step3-(3) セクター相対強度の検証用: 銘柄→業種のマッピングをキャッシュする。
-- bt_universe（umihico/kabu-json由来）には業種分類が含まれないため、
-- Yahoo Finance の quoteSummary(assetProfile) から取得してキャッシュする
-- （業種分類はほぼ変化しないため低頻度更新で十分）。

create table sector_map (
  code text primary key references bt_universe(code) on delete cascade,
  sector text,
  industry text,
  updated_at timestamptz not null default now()
);

alter table sector_map enable row level security;
create policy public_select on sector_map for select using (true);
