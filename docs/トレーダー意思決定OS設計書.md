# kabu 再設計: トレーダー意思決定OS

**目的**: 「明日上がる銘柄を当てるアプリ」から「プロトレーダーの意思決定プロセスを
再現・標準化し、その蓄積から自分自身の優位性を発見するシステム」へ。

本書は実装担当者に渡す設計仕様である。コードは含まない。

---

## 0. この転換が正しい定量的根拠

方針転換の理由は「Edgeが見つからなかったから」ではない。**測定可能性の非対称性**にある。

### トレードレベルでEdgeを検出するのに必要な件数（80%検出力・両側5%）

| 1トレードのRの標準偏差 | 真のEdge | 必要件数 |
|---|---|---|
| 1.5R | 0.10R | **1,764件** |
| 1.5R | 0.20R | **441件** |
| 1.5R | 0.30R | 196件 |
| 2.0R | 0.20R | 784件 |

### プロセス指標（比率）の精度

| 件数 | 比率の95%CI幅 |
|---|---|
| 20件 | ±21.9pt |
| 50件 | ±13.9pt |
| **100件** | **±9.8pt** |
| 200件 | ±6.9pt |

年間50トレードのスイングトレーダーの場合:

- **プロセス品質**（ルール遵守率・仮説的中率・損切り実行率）は **2〜4ヶ月**で有意に測れる
- **Edge**（平均R）は 0.2R想定でも441件＝**約9年**必要

我々は710万観測を使ってなお0.25%の効果を確定できなかった。個人が
トレードレベルでEdgeを検出するのは、時間軸として非現実的である。

**したがって: 測れないもの（Edge）を最適化対象にせず、測れるもの（プロセス）を
最適化対象にする。Edgeは副産物として、十分な件数が貯まった時点で検定する。**

これが本設計の全根拠である。

---

## PART 1. プロトレーダーの意思決定モデル

プロの判断を9工程に分解する。重要な性質は3つ。

1. **予測ではなく条件分岐**。「上がる」ではなく「Xを超えたら入る、Yを割ったら降りる」
2. **銘柄選択より資金管理に時間を使う**。選択は入口、生存は出口
3. **取引しない判断を明示的に下す**。見送りも意思決定であり記録対象

### 工程

| # | 工程 | 問い | 出力 |
|---|---|---|---|
| 1 | **Regime判定** | 今はどういう市場か | risk_on / neutral / risk_off ＋ 今日有効なSetup種別 |
| 2 | **Opportunity発見** | 今日はどの種類の機会を狙うか | Setup種別ごとの候補群 |
| 3 | **候補フィルタ** | 触ってよい銘柄か | 流動性・イベントリスク・既存ポジとの相関で除外 |
| 4 | **Setup定義** | どうなったら実際に入るか | Trigger / Zone / Stop / Target / 有効期限 |
| 5 | **シナリオ分岐** | 3つの未来それぞれで何をするか | Bull / Base / Bear ＋ 各分岐の行動 |
| 6 | **リスク設計** | この仮説にいくら賭けるか | 許容損失から逆算した株数 |
| 7 | **実行判断** | 今日は何をするか | **BUY / WAIT / PASS** |
| 8 | **保有管理** | 仮説はまだ生きているか | Stop調整 / 部分利確 / 撤退 |
| 9 | **振り返り** | 判断は正しかったか | プロセス評価（損益と独立） |

### 各工程でプロが実際に見ているもの

**工程1 Regime** — 指標を並べるのではなく、3つの問いに答える。

| 問い | 判定材料 | 意味 |
|---|---|---|
| 市場は上か下か | TOPIX/日経の200日線との位置、20日線の傾き | トレンド方向 |
| 参加者は広いか狭いか | 騰落レシオ、値上がり銘柄比率（Breadth） | 指数だけ上がって中身が悪い＝危険 |
| 荒れているか | 実現ボラ（20日）の分位、ギャップ頻度 | 高ボラ時はサイズを落とす |

この3つで regime を決め、**regimeが「今日どのSetupを許可するか」を決める**。
現行アプリのようにスコアから点数を引くのではない。

| Regime | 有効なSetup | 無効化するSetup |
|---|---|---|
| risk_on（上・広い・低ボラ） | Breakout, Trend continuation, Relative strength | Mean reversion |
| neutral（横・まちまち） | Pullback, Mean reversion, Range | Breakout |
| risk_off（下・狭い・高ボラ） | **原則なし（現金）**。例外はEvent driven のみ | ほぼ全て |

**工程3 候補フィルタ** — スコアより先に「触ってよいか」を判定する。

- 流動性: 平均売買代金がポジションサイズの一定倍以上あるか（スリッページ耐性）
- イベント: 決算まで一定日数以内でないか（ギャップリスク）
- 相関: 既存ポジションと同一セクター上限に達していないか
- 値幅: Stopまでの距離がコストを回収できる幅か

**このフィルタは「良い銘柄を探す」のではなく「危険な取引を排除する」ためのもの。**
実測で唯一支えられている機能（劣後帯の回避）と同じ思想。

---

## PART 2. kabuの新しい思想

### 変更前後

| | 旧: Edge Discovery App | 新: Trader Decision OS |
|---|---|---|
| 中心の問い | 何が上がるか | 今日何をすべきか / それは正しかったか |
| 主機能 | スコアリング・ランキング | 意思決定の記録と再評価 |
| 成功指標 | シグナルの的中率 | プロセス遵守率・仮説的中率 |
| Edgeの扱い | **前提**（あると仮定して使う） | **結論**（運用データから後で検定する） |
| 中心データ | 市場データ | **自分の意思決定履歴** |

### 三原則

**原則1: 記録されない判断は改善できない**

現行アプリは「取引した記録」だけを持つ。しかしプロの判断の大半は **見送り** である。
PASSとWAITを理由付きで記録しなければ、「自分のフィルタが正しかったか」は永久に
測定できない。**PASSした銘柄のその後を追跡することで、他の誰も持っていない
「自分の機会損失データ」が手に入る。**これは本設計の中核的な発明であり、PART 11に繋がる。

**原則2: 予測ではなく条件分岐**

画面に「買い」と表示しない。「¥4,250を出来高を伴って超えたら買い、
¥4,080を割ったら撤退、それ以外は待機」と表示する。
これはUIの問題ではなくデータモデルの問題である（PART 7）。

**原則3: すべてをR（リスク単位）で測る**

損益を円や%で持たない。**R = 1トレードで許容した損失額**を単位にする。
- Entry 4,250 / Stop 4,080 → 1R = 170円/株
- 4,600で利確 → +350円 = **+2.06R**

Rで持つことで、資金量・株価水準・時期の異なるトレードが**比較可能**になる。
現行アプリは円ベースで、これができていない。

---

## PART 3. システムアーキテクチャ

### データフロー

```
[日次バッチ / Worker cron 23:00 JST]
  市場データ取得
    ↓
  ① Regime判定 ──────────────→ market_regime テーブル
    ↓ （regimeが有効Setupを決定）
  ② Opportunity発見
    候補抽出（Setup種別ごとの条件）
    ↓
  ③ 候補フィルタ（流動性・イベント・値幅）
    ↓
  ④ Setup生成（Trigger/Stop/Target/期限）→ setups テーブル
    ↓
[ブラウザ / ユーザー操作]
  ⑤ シナリオ確認・⑥ リスク設計
    ↓
  ⑦ 実行判断 BUY / WAIT / PASS ────→ decisions テーブル（PASSも記録）
    ↓ BUYの場合
  ⑧ 保有管理（毎日 Thesis再評価）──→ position_checks テーブル
    ↓
  ⑨ 決済・振り返り ────────────→ trades テーブル（Before/During/After）
    ↓
[分析 / GitHub Actions 週次]
  ⑩ Analytics: Setup別・Regime別・プロセス別の成績集計
    ↓
  ⑪ 十分な件数が貯まった時点で Edge検定（DSR適用）
```

### 実行場所の分担（現行スタックを維持）

| 処理 | 実行場所 | 理由 |
|---|---|---|
| 市場データ取得・Regime判定・Setup生成 | Cloudflare Worker cron | 既存の日次スキャナーを拡張。Subrequest上限のため分割継続 |
| 意思決定・記録 | ブラウザ（localStorage） | 個人データ。低遅延・オフライン可 |
| 記録のバックアップ | Supabase（デバイスUUIDキー） | **journalは本設計の中核資産。消失は致命的** |
| Analytics・Edge検定 | GitHub Actions | 重い計算。Workerの制約外 |
| 過去データ・PIT財務 | Supabase | 既存 |

**制約として明記すべきこと**: データはYahoo Finance（15〜20分遅延）。
したがって **Triggerのリアルタイム監視はできない**。Triggerは「日足終値で判定」
または「ユーザーが手動で確認」する設計にする。ここを誤魔化して
「リアルタイム通知」を謳ってはならない。

---

## PART 4. 機能一覧: KEEP / MODIFY / REMOVE / NEW

**注**: ご提示のリストにあった DSR/PBO・テーマ別銘柄表示・ファクター分析は
現在**未実装**。以下は実コードに基づく。

### KEEP（そのまま活かす）

| 機能 | 理由 |
|---|---|
| 損益シミュレーター（リスクベース株数・1銘柄上限・セクター集中） | 既にPART 8の思想で作られている。Rベース化のみ追加 |
| 取引記録の仮説・反証条件・4象限レビュー | PART 9の中核。既に実装済み |
| 売買コスト可視化 | 実測で年-15%の確定的負けを示した機能。維持 |
| 決算veto（決算7日前は中立化） | イベントリスク回避。PART 1工程3のフィルタに統合 |
| スコア帯の実測エビデンス表示 | 正直さの担保。「上位帯でも市場平均並み」を出し続ける |
| アウトオブサンプル追跡（ret20記録） | PART 11の基盤 |
| PIT財務データ蓄積 | 将来のEdge検証用。継続 |
| バックテスト基盤（GitHub Actions 10種） | Analytics基盤として再利用 |

### MODIFY（目的を変えて作り替える）

| 機能 | 現在 | 変更後 |
|---|---|---|
| **スコア（calcTradeScore）** | 0-100点で銘柄をランク付けし「買い」を示唆 | **廃止せず、Setup検出の入力の一つに降格**。単独で売買判断に使わない。表示も順位帯のまま |
| **地合い調整** | スコアから-5〜-25点引く | **Regime判定に昇格**。点数を引くのではなく「今日どのSetupを許可するか」を決める |
| **日次スキャナー** | スコア順ランキング | **Setup種別ごとの候補リスト**に再編。「Breakout候補3件」「Pullback候補5件」 |
| **セクター相対強度** | 参考表示 | Regime判定とセクター集中チェックの入力に統合 |
| **損益シミュレーター** | 円ベース | **Rベース**。R:R、Portfolio heat、期待Rを表示 |
| **トレール損切り計算機** | 独立した計算機 | 保有中ポジションの**Stop調整提案**としてTrade Management（PART 6）に統合 |
| **取引記録** | localStorage のみ | **Supabaseバックアップ追加**（デバイスUUID）。中核資産の消失防止 |

### REMOVE（削除または大幅縮小）

| 機能 | 理由 |
|---|---|
| **個別テクニカル指標の大量表示**（一目均衡表・ADX・VWAP・OBV・フィボナッチ等） | 実測で全項目が非有意。判断材料として機能していない。**「プロっぽく見せるための飾り」であり、認知負荷を上げて判断を悪化させる**。詳細画面の最下部に折りたたみで残すか、削除 |
| **シグナル別的中率ダッシュボード** | スコアの的中率を測る機能。スコアを判断根拠にしない以上、Setup別成績に置き換える |
| **「今すぐスキャン」ボタン** | 日次バッチで足りる。手動更新は「何か見逃しているのでは」という不安を煽り過剰取引を誘発する |
| **STRONG BUY等のシグナルバッジ** | 既に順位帯表記に変更済みだが、Setup + BUY/WAIT/PASS に完全置換 |

### NEW（新規）

| 機能 | 優先度 |
|---|---|
| **Regimeエンジン**（3問判定 → 有効Setup決定） | P0 |
| **Setupモデル**（Trigger/Zone/Stop/Target/期限/シナリオ） | P0 |
| **BUY/WAIT/PASS 判定エンジン**（Gate方式） | P0 |
| **意思決定記録**（PASS/WAITも理由付きで記録） | P0 |
| **PASS追跡**（見送った銘柄のその後を自動記録） | P1 |
| **保有中のThesis再評価**（毎日のチェックリスト） | P1 |
| **Rベース Analytics**（Setup別・Regime別の期待R） | P1 |
| **AIによる反証生成**（買わない理由の列挙） | P2 |
| **Journalのクラウドバックアップ** | P0 |

---

## PART 5. ホーム画面

### 設計原則

開いた瞬間に答えるべき問いは1つだけ: **「今日、私は何をすべきか」**

市場情報は「行動を決めるための文脈」としてのみ表示する。数字の羅列にしない。
提示いただいた案を土台に、2点追加する。

1. **未処理の宿題を最上部に**（未レビューの決済済みトレード、Stop再評価が必要な保有）
2. **「何もしない」が正常な結果として表示される**設計

### 画面構成

```
┌─────────────────────────────────────┐
│ ① TODAY'S ACTION           ← 最重要 │
│                                     │
│  ⚠ 要対応 2件                       │
│   ・7203 決済済み・レビュー未完了    │
│   ・6758 Stop再評価（+1.8R到達）     │
│                                     │
│  監視中 3件 / 新規候補 1件           │
│  → 今日の新規エントリー: 0〜1件      │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ ② MARKET REGIME                     │
│                                     │
│  🟡 NEUTRAL                          │
│  方向: 横ばい（20日線 横這い）        │
│  広がり: 弱い（値上がり43%）          │
│  ボラ:   中（20日実現ボラ 62%ile）    │
│                                     │
│  今日有効なSetup:                    │
│   ✅ Pullback  ✅ Mean reversion      │
│   ❌ Breakout（regime不適合）         │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ ③ OPPORTUNITIES     Setup種別ごと    │
│                                     │
│  ▸ Pullback (2件)                   │
│    4502 武田薬品      WAIT           │
│      Trigger ¥4,250 / Stop ¥4,080   │
│      R:R 2.1  想定 +2.1R / -1.0R    │
│                                     │
│    6301 コマツ        PASS           │
│      理由: R:R 1.1（基準2.0未満）     │
│                                     │
│  ▸ Breakout (0件) — regime不適合     │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ ④ PORTFOLIO                         │
│                                     │
│  使用リスク  1.2% / 上限 3.0%        │
│  Portfolio heat  2.4R                │
│  保有 4銘柄 / 上限 8                 │
│  セクター集中 電機3（上限2）⚠         │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│ ⑤ PROCESS（今月）                    │
│  仮説的中率 58% (n=19)               │
│  ルール遵守率 84%                    │
│  ⚠ 運で勝ち 21%                      │
└─────────────────────────────────────┘
```

### 重要な設計判断

- **③でPASSを表示する**。「見送った」ことを可視化しないと、見送りが判断として
  定着しない。PASSは失敗ではなく成果である
- **候補0件を正常表示する**。「本日エントリー候補なし」を赤字の警告にしない。
  regime不適合で0件は正しい動作
- **⑤を常時表示する**。自分のプロセス品質が毎日目に入ることが行動を変える

---

## PART 6. 1銘柄詳細画面

### 情報の優先順位（上から順に配置）

現行アプリはスコアと指標が最上部にある。**これを反転する。**

| 順位 | ブロック | 内容 | なぜこの順位か |
|---|---|---|---|
| 1 | **判定** | BUY / WAIT / PASS ＋ その理由 | 唯一の結論。最初に見せる |
| 2 | **シナリオ** | Bull/Base/Bear の3分岐と各行動 | 判定の根拠。条件分岐そのもの |
| 3 | **リスク設計** | Entry/Stop/Target/株数/R:R/必要資金 | 実行に必要な数字 |
| 4 | **仮説記入** | Setup種別・仮説・反証条件（入力欄） | 実行前に必ず書かせる |
| 5 | **文脈** | Regime適合性・セクター強弱・既存ポジとの相関 | なぜ今この銘柄か |
| 6 | **イベント** | 決算日までの日数・直近の開示 | ギャップリスク |
| 7 | **価格・出来高チャート** | 日足＋Trigger/Stop/Targetのライン重ね | 視覚確認 |
| 8 | **実測エビデンス** | このSetupの過去成績（件数不足なら「不明」と表示） | 期待値の現実 |
| 9 | 参考指標（折りたたみ） | RSI/MACD等 | 実測で非有意。飾りとして最下部 |

### 判定ブロックの表示例

```
┌─────────────────────────────────┐
│  WAIT                            │
│  ¥4,250 を出来高1.5倍以上で       │
│  上抜けたらエントリー              │
│                                  │
│  現在 ¥4,180（Triggerまで +1.7%）  │
│  シナリオ有効期限: 8/13（残5営業日）│
│                                  │
│  ✅ Regime適合（Pullback可）       │
│  ✅ 流動性十分（平均売買代金12億）  │
│  ✅ 決算まで34日                   │
│  ✅ R:R 2.1（基準2.0以上）          │
│  ⚠ 電機セクター 既に2銘柄保有      │
└─────────────────────────────────┘
```

**PASSの場合は理由を必ず具体的に出す。**「スコアが低い」ではなく
「R:R 1.1 が基準2.0未満」「決算まで3日」のように、どの条件で落ちたかを示す。

---

## PART 7. Trade Setupモデル

### 設計思想

Setupは **「必ず儲かるパターン」ではなく「取引仮説の分類ラベル」**。
成績は後から検証する。設計上、Setupに期待値を埋め込まない。

### データ構造

```
Setup {
  // --- 識別 ---
  id
  code                  銘柄コード
  setup_type            breakout | pullback | trend_continuation
                        | mean_reversion | relative_strength
                        | earnings_reaction | catalyst | special_situation
  created_at
  expires_at            シナリオ有効期限（過ぎたら自動失効）

  // --- 発生時の文脈（後の分析用に必ず保存） ---
  regime_at_creation    risk_on | neutral | risk_off
  regime_detail         {direction, breadth, volatility}
  sector
  score_at_creation     参考値として保存（判断には使わない）

  // --- トリガー条件（条件分岐の本体） ---
  entry_trigger {
    type                price_above | price_below | price_in_zone
    level               ¥4,250
    confirmation        volume_ratio >= 1.5 | close_above | none
  }
  entry_zone            {min: 4250, max: 4320}  約定を許容する範囲

  // --- リスク定義 ---
  stop {
    type                fixed | atr_based | structure_based
    level               ¥4,080
    atr_multiple        1.5（type=atr_basedの場合）
  }
  targets [             複数目標（部分利確用）
    {level: 4600, portion: 0.5, r_multiple: 2.06},
    {level: 4850, portion: 0.5, r_multiple: 3.53}
  ]
  time_stop_bars        20（この営業日数で決着しなければ撤退）

  // --- 無効化条件 ---
  invalidation {
    price_level         ¥4,080（=stop）
    conditions [        価格以外の撤退条件
      "決算発表7日前に到達",
      "regime が risk_off に転換",
      "出来高が20日平均の50%を下回る状態が3日継続"
    ]
  }

  // --- シナリオ3分岐 ---
  scenarios {
    bull  {condition: "¥4,250を出来高増で上抜け", action: "ENTRY", target: 4600}
    base  {condition: "¥4,100-4,250で揉み合い",    action: "WAIT",  note: "期限まで待機"}
    bear  {condition: "¥4,080割れ",                action: "PASS",  note: "シナリオ破棄"}
  }

  // --- 評価結果（Gate通過状況。PART 8で算出） ---
  gates {
    regime_fit          pass | fail
    liquidity           pass | fail
    event_risk          pass | fail
    risk_reward         pass | fail   R:R >= 2.0
    correlation         pass | warn | fail
    cost_coverage       pass | fail   値幅がコストを回収できるか
  }
  decision              BUY | WAIT | PASS
  decision_reason       Gateのどれで落ちたか、またはBUY条件を満たした旨
}
```

### 重要な制約

- **setup_type はエントリー前に確定し、以後変更不可**。後から「これはBreakoutだった
  ことにする」を許すと、Setup別成績が意味を失う
- **expires_at を必ず持つ**。期限のないシナリオは「いつか上がる」という願望に劣化する
- **score_at_creation は保存するが判断に使わない**。後で「スコアは結局役に立ったのか」
  を検証するためのデータとして残す

---

## PART 8. Risk Engine

### 中心概念: R

**1R = このトレードで失うと決めた金額**。すべてをRで測る。

```
1株あたりリスク = |Entry − Stop|
1トレード許容損失 = 口座資金 × リスク% (既定0.5%)
理論株数 = 許容損失 ÷ 1株あたりリスク
実際の株数 = floor(理論株数 ÷ 100) × 100        単元100株に切り下げ
```

**例**（ご提示の例をそのまま採用）

```
資金 500万円 / 許容 0.5% = 25,000円 = 1R
Entry ¥4,250 / Stop ¥4,080 → 1株リスク ¥170
25,000 ÷ 170 = 147株 → 140株（単元切り下げ）
実際のリスク = 140 × 170 = ¥23,800 (0.48%)
必要資金 = 140 × 4,250 = ¥595,000
Target ¥4,600 到達時 = +¥49,000 = +2.06R
```

### 追加で必須の制約（現行アプリに一部実装済み）

| 制約 | 内容 | 既存 |
|---|---|---|
| 1銘柄上限 | 必要資金 ≤ 資金×25%。低ボラ銘柄で資金が集中するのを防ぐ | ✅実装済 |
| セクター集中 | 同一セクター同時保有 ≤ 2 | ✅実装済 |
| 同時保有数 | ≤ 8 | ✅実装済 |
| **Portfolio heat** | 全保有ポジションの現在リスク合計 ≤ 3R | **NEW** |
| **Gap risk** | 決算・イベント跨ぎはStopが機能しない前提で、サイズを半分に | **NEW** |
| **流動性** | 必要資金 ≤ 平均売買代金 × 0.5% | **NEW** |
| **コスト回収** | Target到達時の利益 > 往復コスト × 3 | **NEW** |

### Portfolio heat の定義

```
各ポジションの現在リスク = max(0, 現在値 − 現在のStop) × 株数   ロングの場合
                          ※ Stopを建値以上に上げたポジションはリスク0として扱う
Portfolio heat = Σ(各ポジションの現在リスク) ÷ 1R
```

**Stopを引き上げるとheatが下がる**ため、「利が乗ったらStopを上げる」という
プロの基本動作が数値で報われる設計になる。

### BUY / WAIT / PASS 判定（Gate方式）

**スコアで判定しない。全Gateを通過して初めてBUY候補になる。**

```
PASS ← いずれか1つでもfailなら即PASS（理由を記録）
  ・regime_fit      今日このSetupは有効か
  ・liquidity       流動性が足りるか
  ・event_risk      決算等が近すぎないか
  ・risk_reward     R:R >= 2.0 か
  ・cost_coverage   コストを回収できる値幅か
  ・portfolio       heat上限・保有数上限・セクター上限に抵触しないか

WAIT ← 全Gate通過。ただしTrigger未達
BUY  ← 全Gate通過 かつ Trigger到達
```

**「Opportunity Score 90でもR:R 1.1ならPASS」がこの構造で自動的に実現する。**
スコアはGateに一切登場しない。

---

## PART 9. Trade Journal

本アプリの中核データ。**localStorageを一次保管とし、Supabaseへ自動バックアップする**
（消失すればすべての分析が失われるため）。

### Before（エントリー前・必須入力）

```
setup_id
regime_at_entry       {state, direction, breadth, volatility}
setup_type
thesis                なぜ上がると考えるか（自由記述・必須）
invalidation          何が起きたら間違いと認めるか（自由記述・必須）
why_this_stock        なぜ他ではなくこの銘柄か（自由記述）
entry_planned
stop_planned
targets_planned
expected_rr
position_size
risk_amount_yen
risk_pct
portfolio_heat_before
gates_snapshot        全Gateの通過状況
```

### During（保有中・日次チェック）

```
date
price / volume
regime_current        entry時から変化したか
thesis_status         intact | weakening | invalidated
stop_current          変更履歴を配列で保持
target_current
partial_exits []      {date, price, portion, r_multiple}
mae_running           保有中の最大逆行（Rで記録）
mfe_running           保有中の最大順行（Rで記録）
alerts []             検知した警告（出来高減退・相対強度低下・regime転換等）
```

### After（決済後・レビュー必須）

```
exit_date / exit_price / exit_reason
   exit_reason: target_hit | stop_hit | time_stop | thesis_invalidated
                | regime_change | discretionary
pl_yen
r_multiple            ★主要指標
mae / mfe             最大逆行・最大順行
holding_days

// --- プロセス評価（損益と独立に評価する） ---
thesis_correct        true | false    仮説は結果的に妥当だったか
execution_correct     true | false    計画通りに実行したか（Stopを守ったか等）
regime_read_correct   true | false    市場環境の読みは正しかったか
lessons               自由記述
```

### 4象限分類（既に実装済みの拡張）

|  | 勝った | 負けた |
|---|---|---|
| **仮説◯ 実行◯** | 理想（再現すべき） | 不運（継続すべき） |
| **仮説◯ 実行✕** | 危険（規律の欠如が偶然報われた） | 実行の問題（学習可能） |
| **仮説✕ 実行◯** | **運（最も危険）** | 想定内（仮説を見直す） |
| **仮説✕ 実行✕** | 極めて危険 | 当然の結果 |

現行実装は仮説の正否のみ2×2。**実行の正否を加えて2×2×2に拡張する**。
「仮説は正しかったが損切りを守らずに大負けした」を「仮説の失敗」と誤診しないため。

---

## PART 10. AIの役割

### AIに任せてよいこと

| 用途 | 内容 |
|---|---|
| **反証生成（最重要）** | 「この銘柄を買わない理由」を必ず3つ以上生成する |
| 情報整理 | 決算短信・適時開示の要約 |
| 材料抽出 | ニュースから事実と観測を分離して列挙 |
| 異常検知 | 出来高・値動き・開示頻度の異常を指摘（判断はしない） |
| シナリオ生成の補助 | Bull/Base/Bearの条件案を提示（採否はユーザー） |
| リスク列挙 | このトレードで想定される損失シナリオの列挙 |
| Thesis作成の補助 | ユーザーの箇条書きを構造化された仮説文に整形 |
| 類似トレード検索 | 過去のJournalから似た状況のトレードと結果を提示 |

### AIに絶対に任せてはいけないこと

| 禁止 | 理由 |
|---|---|
| **方向の予測**（「上がります」） | 予測精度の根拠がない。我々の実測でも予測力は確認できていない |
| **BUY/WAIT/PASSの決定** | Gateは決定論的ルールであるべき。AIの気分で変わってはならない |
| **株数の決定** | リスク計算は数式。AIを挟む理由がない |
| **Stop/Targetの決定** | 同上 |
| **過去成績からの将来予測** | 「このSetupは勝率70%だから買い」は多重検定の罠 |

### 反証生成の必須仕様

エントリー前に必ず表示する。ユーザーが「買う理由」を書いた直後に、
AIが「買わない理由」を返す。

```
入力: 銘柄・Setup・ユーザーの仮説・現在の市場文脈
出力: 必ず以下の形式で3つ以上

  ⚠ この取引に反対する根拠
  1. [事実] 直近3ヶ月の出来高が前年同期比-32%。上抜けても
     追随買いが続かない可能性
  2. [文脈] 同セクターの主要3銘柄がいずれも20日線を下回っており、
     セクター全体の需給が悪い
  3. [統計] あなたのBreakout Setupの直近成績は n=12 で期待値 -0.15R。
     このSetup自体がまだ機能を確認できていない
```

**3番目のような「あなた自身のデータに基づく反証」が最も価値が高い。**
これはPART 11のAnalyticsと接続する。

---

## PART 11. Edge Discoveryへの接続

### 順序

```
TRADE PROCESS → DATA COLLECTION → EDGE DISCOVERY
（Edgeを前提にしない。運用の副産物として発見する）
```

### 段階1: プロセス品質の測定（n=50〜100 / 2〜4ヶ月で到達）

**この段階では期待値を測らない。測れないため。** 測るのは以下。

| 指標 | 意味 | 目標 |
|---|---|---|
| ルール遵守率 | 計画通りStopを実行した割合 | > 90% |
| 仮説的中率 | 損益と独立の判断妥当性 | ベースライン把握 |
| 「運で勝ち」比率 | 仮説✕なのに勝った割合 | < 20% |
| 計画外エントリー率 | Setupを作らずに入った割合 | < 10% |
| レビュー完了率 | 決済後にレビューした割合 | 100% |

### 段階2: Setup別・Regime別の記述統計（n=100〜200）

まだ「有意」とは言わない。**分布を見るだけ**。

- Setup別の期待R・勝率・平均利益R・平均損失R・保有日数
- Regime別の成績（risk_onでBreakoutは機能したか）
- MAE/MFE分析（Stopが近すぎないか、利確が早すぎないか）
- 曜日・時期・保有期間別の傾向

**この段階の出力は「仮説」であって「結論」ではない。**

### 段階3: Edge検定（n>200、Setupごとに）

ここで初めて統計的検定を行う。必須の補正:

1. **DSR（Deflated Sharpe Ratio）** — 試行回数で補正。
   **我々は既に10仮説を検証済みであり、その回数も試行に含める**
2. **Setup数による多重比較** — 8種類のSetupを同時評価するならBonferroni等
3. **コスト差引後**で評価
4. **サブ期間での安定性**

### 段階4: PASS追跡 — 本設計固有の資産

**PASSした銘柄のその後20営業日を自動記録する。**

これにより「自分のフィルタは正しかったか」が測定可能になる。

| 分析 | 意味 |
|---|---|
| PASSした銘柄の平均リターン vs 実際にBUYした銘柄 | フィルタが価値を生んでいるか |
| Gate別のPASS後リターン | どのGateが効いていて、どれが機会損失を生んでいるか |
| R:R不足でPASSした銘柄の実績 | 基準2.0は厳しすぎないか |

**これは市販のどのツールも持っていないデータである。** 通常、見送りは記録されない。
記録すれば、自分の判断基準そのものを検証できる。

### 検証再開時の必須ルール（過去の失敗から）

過去2回、測定器自体の欠陥で誤った結論を出しかけた。以下は必ず守る。

1. 事前登録（仮説・期待符号・判定基準を実行前に固定）
2. 全結果を報告（都合の良いものだけ選ばない）
3. 信頼区間は1.5倍に較正（ブロックブートストラップの過小評価分）
4. 日ごとの平均を使う（行ごとの平均は強気相場に重みが偏る）
5. コスト差引後で判断
6. 多重検定を数える（既に10仮説を試した事実を含める）

---

## PART 12. MVP

### P0（これがないとOSとして成立しない）

| # | 機能 | 概要 |
|---|---|---|
| 1 | **Regimeエンジン** | 3問（方向・広がり・ボラ）判定 → 有効Setup決定。日次バッチ |
| 2 | **Setupモデル + 生成** | Trigger/Stop/Target/期限/シナリオを持つデータ構造と、日次での候補生成 |
| 3 | **Gate方式の BUY/WAIT/PASS** | 6つのGateによる決定論的判定。スコアを使わない |
| 4 | **Rベース Risk Engine** | 既存シミュレーターのRベース化 + Portfolio heat |
| 5 | **意思決定の記録** | **PASS/WAITも理由付きで記録**。BUYだけ記録する設計にしない |
| 6 | **Journal 3層化** | Before/During/After。実行の正否を追加し2×2×2レビューへ |
| 7 | **Journalバックアップ** | Supabaseへの自動同期。中核資産の消失防止 |
| 8 | **新ホーム画面** | TODAY'S ACTION 最上部 |

### P1（プロセスを回すために早期に必要）

| # | 機能 |
|---|---|
| 9 | 保有中の日次Thesis再評価（チェックリスト + アラート検知） |
| 10 | PASS追跡（見送った銘柄のその後を自動記録） |
| 11 | Rベース Analytics（Setup別・Regime別の記述統計） |
| 12 | Stop調整提案（トレール計算機を保有ポジションに統合） |
| 13 | 部分利確の記録と管理 |

### P2（データが貯まってから価値が出る）

| # | 機能 |
|---|---|
| 14 | AI反証生成 |
| 15 | AI決算要約・材料抽出 |
| 16 | 類似トレード検索 |
| 17 | DSRによるEdge検定（n>200到達後） |
| 18 | PIT財務を使ったバリュー系Setupの追加 |

### 意図的に作らないもの

- 自動売買・発注連携（判断の外部化はプロセス改善に反する）
- リアルタイム通知（データが15〜20分遅延のため誠実に実装できない）
- 予測AI

---

## PART 13. 実装仕様

### 13.1 画面一覧

| 画面 | 主要素 | 遷移 |
|---|---|---|
| **HOME** | TODAY'S ACTION / REGIME / OPPORTUNITIES / PORTFOLIO / PROCESS | 各候補 → SETUP詳細 |
| **SETUP詳細** | 判定 / シナリオ / リスク設計 / 仮説入力 / 文脈 / チャート / 参考指標 | → 記録（BUY or PASS） |
| **POSITIONS** | 保有一覧・各ポジのThesis状態・Stop・現在R | → ポジション詳細 |
| **ポジション詳細** | 日次チェックリスト / Stop調整 / 部分利確 / 撤退 | → 決済 → レビュー |
| **JOURNAL** | 履歴・4象限バッジ・未レビュー強調 | → レビュー画面 |
| **ANALYTICS** | プロセス品質 / Setup別 / Regime別 / PASS追跡 | — |

### 13.2 データモデル（Supabase）

```sql
-- 市場レジーム（日次・Worker cronが書く）
market_regime (
  date date primary key,
  state text,                    -- risk_on | neutral | risk_off
  direction text, breadth text, volatility text,
  direction_detail jsonb, breadth_detail jsonb, volatility_detail jsonb,
  enabled_setups text[],         -- 今日有効なSetup種別
  computed_at timestamptz
)

-- 生成されたSetup候補（日次）
setups (
  id uuid primary key,
  date date, code text, setup_type text,
  regime_at_creation text, sector text, score_at_creation numeric,
  entry_trigger jsonb, entry_zone jsonb,
  stop jsonb, targets jsonb, time_stop_bars int,
  invalidation jsonb, scenarios jsonb,
  gates jsonb, decision text, decision_reason text,
  expires_at date
)

-- 意思決定の記録（PASS/WAITも記録する ← 最重要）
decisions (
  id uuid primary key,
  device_id uuid,                -- 認証なしの所有者識別
  setup_id uuid, date date, code text,
  decision text,                 -- BUY | WAIT | PASS
  reason text,                   -- PASSの場合はどのGateで落ちたか
  user_note text,
  -- PASS追跡用（後からバッチが埋める）
  price_at_decision numeric,
  ret20_after numeric, outcome_computed_at timestamptz
)

-- トレード（Journal本体。localStorageのバックアップ）
trades (
  id uuid primary key,
  device_id uuid,
  -- Before
  setup_id uuid, code text, setup_type text,
  regime_at_entry jsonb,
  thesis text, invalidation text, why_this_stock text,
  entry_planned numeric, stop_planned numeric, targets_planned jsonb,
  expected_rr numeric, position_size int,
  risk_amount_yen numeric, risk_pct numeric,
  portfolio_heat_before numeric, gates_snapshot jsonb,
  -- During
  checks jsonb,                  -- 日次チェックの配列
  stop_history jsonb, partial_exits jsonb,
  mae_r numeric, mfe_r numeric,
  -- After
  exit_date date, exit_price numeric, exit_reason text,
  pl_yen numeric, r_multiple numeric, holding_days int,
  thesis_correct boolean, execution_correct boolean,
  regime_read_correct boolean, lessons text,
  created_at timestamptz, updated_at timestamptz
)
```

RLSは `device_id` 一致で分離。device_idはブラウザ側でUUID生成しlocalStorageに保管。
**認証なしのため、device_idは実質ベアラートークン**である点をREADMEに明記すること。

### 13.3 Regime判定ロジック（決定論的）

```
direction:
  TOPIX終値 > 200日SMA かつ 20日SMAの傾き > 0  → up
  TOPIX終値 < 200日SMA かつ 20日SMAの傾き < 0  → down
  それ以外                                      → flat

breadth:
  ユニバース内の「20日SMA上」銘柄比率
  >= 60% → wide / 40-60% → mixed / < 40% → narrow

volatility:
  TOPIX 20日実現ボラの過去2年内パーセンタイル
  < 33%ile → low / 33-67 → mid / > 67 → high

state:
  direction=up   かつ breadth=wide  かつ volatility!=high  → risk_on
  direction=down かつ (breadth=narrow または volatility=high) → risk_off
  それ以外                                                   → neutral

enabled_setups:
  risk_on  → [breakout, trend_continuation, relative_strength, pullback]
  neutral  → [pullback, mean_reversion]
  risk_off → [] （原則なし。event_drivenのみ手動で許可）
```

### 13.4 Gate判定（決定論的・スコア不使用）

```
regime_fit:     setup_type ∈ market_regime.enabled_setups
liquidity:      必要資金 <= 20日平均売買代金 × 0.005
event_risk:     決算までの日数 > 7
risk_reward:    (target1 − entry) / (entry − stop) >= 2.0
cost_coverage:  (target1 − entry) × 株数 > 往復コスト額 × 3
portfolio:      heat + 本件リスク <= 3R
                かつ 保有数 < 8
                かつ 同セクター保有 < 2

decision:
  いずれかfail                → PASS（失敗したGate名を reason に記録）
  全pass かつ trigger未達      → WAIT
  全pass かつ trigger到達      → BUY
```

### 13.5 バッチ処理

| バッチ | 実行場所 | タイミング | 処理 |
|---|---|---|---|
| Regime判定 | Worker cron | 23:00 UTC | TOPIX等から regime 算出 → `market_regime` |
| Setup生成 | Worker cron | 23:05/23:10 UTC | 候補抽出 → Gate評価 → `setups`（分割実行） |
| PASS追跡 | Worker cron | 23:20 UTC | 20営業日経過した decisions の ret20 を記録 |
| Analytics | GitHub Actions | 週次 | Setup別・Regime別集計 → `backtest/results/` |
| PIT財務 | GitHub Actions | 週次 | 既存 |

Subrequest上限（50/呼び出し）のため、既存同様に分割実行する。

### 13.6 移行方針

既存の `stockedge_trades`（localStorage）は破棄しない。
新スキーマへマイグレーションする（`thesis`/`falsify`/`thesisCorrect` は
そのまま `thesis`/`invalidation`/`thesis_correct` に対応）。
`execution_correct`・`regime_read_correct`・`r_multiple` は
既存レコードでは null とし、レビュー画面で後から追記できるようにする。

---

## 現行設計への批判（依頼により遠慮なく）

1. **スコアが判断の中心にある構造が根本的に誤り。** 実測で予測力がないと確認済みの
   数値を、UIの最上部・最大フォントで表示し続けている。順位帯表記に変えたことで
   マシにはなったが、**構造としては依然「スコアを見て判断する」アプリ**である。
   Gate方式に置き換え、スコアをGateから完全に排除すべき

2. **見送りが記録されない。** 現行のTrade Journalは実行したトレードのみ記録する。
   プロの判断の大半は見送りであり、それが記録されないため**フィルタの品質を
   永久に測定できない**。これが最大の設計欠陥

3. **テクニカル指標の表示過多。** 一目均衡表・ADX・VWAP・OBV・フィボナッチ等を
   並べているが、実測で全項目が非有意だった。判断材料として機能しないものを
   大量に見せることは、認知負荷を上げて判断を悪化させる。**「プロっぽく見せる」ための
   飾りであり、実害がある**

4. **地合い調整がスコアの減算になっている。** -5〜-25点引くのは、
   「市場環境が悪いなら取引の種類を変える／取引しない」という
   プロの判断を、点数操作に矮小化している

5. **単位が円のまま。** R正規化されていないため、資金量・株価水準の異なる
   トレードを比較できず、Analytics段階で必ず行き詰まる

6. **Journalがローカルのみ。** 本設計における唯一かつ最重要の資産が、
   ブラウザのデータ削除で消える状態にある

7. **「今すぐスキャン」ボタン。** 日次バッチで足りるものを手動更新可能にすることで、
   「何か見逃しているのでは」という不安を煽り、過剰取引を誘発する
