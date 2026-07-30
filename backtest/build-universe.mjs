// backtest/build-universe.mjs — 検証対象ユニバース（普通株リスト）をSupabaseに構築する
// GitHub Actions上で実行する（.github/workflows/backtest-cache.yml）。
//
// データ源: umihico/kabu-json（JPX公式ファイルを毎日パースして公開しているミラー。
// JPX公式サイトはこのプロジェクトの実行環境から直接到達できないことを確認済み）。
// 市場区分（プライム/スタンダード/グロース）のフィールドは提供されていないため、
// 「TSE Prime限定」ではなく「ETF/REIT/ファンド等を除いた普通株全体」を対象とする
// （現状の大型株81銘柄よりはるかに広いユニバースにはなる）。
//
// 実行: node backtest/build-universe.mjs
// 必須環境変数: SUPABASE_SERVICE_KEY（GitHub Actionsのrepository secretとして設定すること。
//               このスクリプトのコードには一切埋め込まない）

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fhpwmafnbzmtjemldmcy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SOURCE_URL = 'https://raw.githubusercontent.com/umihico/kabu-json-all-stock-list/main/all_stocks.json';

if (!SUPABASE_SERVICE_KEY) {
  console.error('エラー: 環境変数 SUPABASE_SERVICE_KEY が未設定です。GitHub Actionsのrepository secretとして設定してください。');
  process.exit(1);
}

// ETF/ETN/REIT/インフラファンド/優先出資証券/ブル・ベア型等を名称パターンで除外する
// （umihico/kabu-jsonは市場区分フィールドを持たないため、この方法でしか選別できない）
const EXCLUDE_PATTERN = /(ETF|ETN|ＥＴＦ|ＥＴＮ|上場投信|投資法人|リート|ＲＥＩＴ|REIT|iFree|ｉＦｒｅｅ|NEXT FUNDS|ＮＥＸＴ|上場インデックス|MAXIS|ＭＡＸＩＳ|One ETF|ダイワ上場投信|日興上場投信|インフラ投資|優先出資証券|新株予約権|ブル|ベア|レバレッジ|ダブルインバース|指数連動|先物|グローバルX|Global X|シンプレクス|SMDAM)/i;

async function main() {
  console.log(`取得元: ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    console.error(`取得失敗: HTTP ${res.status}`);
    process.exit(1);
  }
  const all = await res.json();
  console.log(`元データ件数: ${all.length}`);

  const stocks = all.filter(x => {
    const code = String(x['コード'] || '').trim();
    const name = String(x['銘柄名'] || '');
    if (!/^[0-9]{4}$/.test(code)) return false;
    if (EXCLUDE_PATTERN.test(name)) return false;
    return true;
  });
  console.log(`普通株候補: ${stocks.length}件`);

  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal'
  };
  const records = stocks.map(x => ({ code: x['コード'], name: x['銘柄名'] }));

  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const res2 = await fetch(`${SUPABASE_URL}/rest/v1/bt_universe`, {
      method: 'POST', headers, body: JSON.stringify(chunk)
    });
    if (!res2.ok) {
      const body = await res2.text();
      console.error(`Supabase upsert失敗 (${i}件目〜): HTTP ${res2.status} ${body.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`  upsert済み: ${Math.min(i + BATCH, records.length)}/${records.length}`);
  }
  console.log('完了。');
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
