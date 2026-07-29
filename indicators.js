// indicators.js — worker.js と index.html で共有するテクニカル指標・スコアリングエンジン
// worker.js: import { ... } from './indicators.js'
// index.html: <script type="module"> で import し、window.* に橋渡しして既存の非moduleスクリプトから使う

// Yahoo Finance chart API のレスポンス（chart.result[0]）から、
// adjclose(分割・配当調整後終値)の比率をO/H/L/Cにも適用した系列を作る。
// 未調整のcloseのままだと配当落ちが指標・リターン計算に混入するため。
// 画面/DBに表示する「現在値」は rawClose（未調整の実際の株価）を使うこと。
export function buildAdjustedSeries(chart) {
  const q = chart.indicators?.quote?.[0] || {};
  const adj = chart.indicators?.adjclose?.[0]?.adjclose || null;
  const timestamps = chart.timestamp || [];
  const o = [], h = [], l = [], c = [], v = [], dates = [], rawClose = [];
  for (let i = 0; i < timestamps.length; i++) {
    const rawO = q.open?.[i], rawH = q.high?.[i], rawL = q.low?.[i], rawC = q.close?.[i], rawV = q.volume?.[i];
    if (rawO == null || rawH == null || rawL == null || rawC == null || rawV == null || rawC <= 0) continue;
    const adjC = (adj && adj[i] != null) ? adj[i] : rawC;
    const ratio = rawC > 0 ? adjC / rawC : 1;
    o.push(rawO * ratio); h.push(rawH * ratio); l.push(rawL * ratio); c.push(adjC); v.push(rawV);
    rawClose.push(rawC);
    dates.push(timestamps[i]);
  }
  return { o, h, l, c, v, dates, rawClose };
}

export function calcSMA(arr, p) {
  return arr.map((_, i) => i < p - 1 ? null : arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);
}

// EMA: 先頭p本のSMAでシードする（誤ったclosest[0]シードや、null前置き配列を渡した際の
// シード汚染を避けるため、有効値がp件連続するまでシードを開始しない）
export function calcEMA(arr, p) {
  const k = 2 / (p + 1);
  const result = new Array(arr.length).fill(null);
  let e = null, seedSum = 0, seedCount = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    const valid = v != null && !isNaN(v);
    if (e === null) {
      if (!valid) { seedSum = 0; seedCount = 0; continue; }
      seedSum += v; seedCount++;
      if (seedCount === p) { e = seedSum / p; result[i] = e; }
      continue;
    }
    if (!valid) continue; // eは維持したまま、この点はnullのままにする
    e = v * k + e * (1 - k);
    result[i] = e;
  }
  return result;
}

// RSI: Wilderの平滑化法（両実装で一致していた方式をそのまま採用）
export function calcRSI(closes, period) {
  period = period || 14;
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  result[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(0, d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return result;
}

// MACD: 系列長を保ったまま計算する（null前置きを正しく処理できるcalcEMAに統一したため、
// 旧index.html実装のような「null除去→EMA→インデックス再マッピング」は不要）
export function calcMACD(closes) {
  const fast = calcEMA(closes, 12);
  const slow = calcEMA(closes, 26);
  const macd = closes.map((_, i) => (fast[i] != null && slow[i] != null) ? fast[i] - slow[i] : null);
  const signal = calcEMA(macd, 9);
  const hist = macd.map((m, i) => (m != null && signal[i] != null) ? m - signal[i] : null);
  return { macd, signal, hist };
}

// ATR: Wilderの平滑化法（旧index.html実装の「直近14本の単純平均」は不採用）
export function calcATR(highs, lows, closes, period) {
  period = period || 14;
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const result = new Array(highs.length).fill(null);
  if (tr.length < period) return result;
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = atr;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }
  return result;
}

export function calcBB(c, p, k) {
  p = p || 20; k = k || 2;
  const sma = calcSMA(c, p);
  return {
    sma,
    upper: sma.map((m, i) => { if (m == null) return null; const s = c.slice(i - p + 1, i + 1); const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / p); return m + k * sd; }),
    lower: sma.map((m, i) => { if (m == null) return null; const s = c.slice(i - p + 1, i + 1); const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / p); return m - k * sd; }),
  };
}

export function calcStoch(hi, lo, cl, p, sk, sd) {
  p = p || 14; sk = sk || 3; sd = sd || 3;
  const rk = cl.map((_, i) => {
    if (i < p - 1) return null;
    const hh = Math.max(...hi.slice(i - p + 1, i + 1)), ll = Math.min(...lo.slice(i - p + 1, i + 1));
    return hh === ll ? 50 : (cl[i] - ll) / (hh - ll) * 100;
  });
  const kv = calcSMA(rk.filter(v => v !== null), sk);
  const dv = calcSMA(kv.filter(v => v !== null), sd);
  return { k: kv[kv.length - 1] ?? 50, d: dv[dv.length - 1] ?? 50 };
}

// 52週高値の判定に必要な最低バー数（時間軸ごと）。
// 分足・時間足は取得できるレンジが数日〜数ヶ月しかなく「52週」に相当するデータが
// 存在しないため、常に対象外（データ不足）として扱う。
function get52wBarsNeeded(interval) {
  if (interval === '1d') return 200;
  if (interval === '1wk') return 40;
  return Infinity;
}

// 0〜100点のトレードスコアエンジン（worker.jsのスキャナーとindex.htmlの詳細分析で共通利用）
// summaryData省略時（スキャナー呼び出し時）は⑧材料・アナリスト評価は加点0でスキップされる
export function calcTradeScore(opens, highs, lows, closes, volumes, summaryData, interval) {
  const last = closes.length - 1;
  const cur = closes[last];
  let score = 50;
  const details = [];
  function add(name, pts, d, icon) {
    score += pts;
    details.push({ name, pts, d, icon: icon || '●' });
  }

  // ① 出来高前日比
  let volRatio = 1;
  if (last >= 1 && volumes[last - 1] > 0) {
    const volPrev = volumes[last - 1], volCur = volumes[last];
    volRatio = volCur / volPrev;
    const volPct = ((volRatio - 1) * 100).toFixed(0);
    if (volRatio >= 3) add('出来高', +20, '前日比+' + volRatio.toFixed(1) + 'x — 急騰シグナル！', '🔥');
    else if (volRatio >= 2.5) add('出来高', +15, '前日比+' + volPct + '% — 大幅増加', '📊');
    else if (volRatio >= 2) add('出来高', +10, '前日比+' + volPct + '% — 増加', '📊');
    else if (volRatio <= 0.5) add('出来高', -10, '前日比' + volPct + '% — 閑散相場', '📉');
    else add('出来高', 0, '前日比' + (volRatio >= 1 ? '+' : '') + volPct + '%', '📊');
  }

  // ② EMA20/50/200トレンド配列
  const ema20 = calcEMA(closes, 20), ema50 = calcEMA(closes, 50), ema200 = calcEMA(closes, Math.min(200, closes.length));
  const e20 = ema20[last], e50 = ema50[last], e200 = ema200[last];
  let emaSignal = 'neutral';
  if (e20 && e50 && e200 && e20 > e50 && e50 > e200) {
    add('EMA配列', +15, 'EMA20>50>200 完全上昇配列', '📐'); emaSignal = 'perfect-up';
  } else if (e20 && e50 && e200 && e20 < e50 && e50 < e200) {
    add('EMA配列', -10, 'EMA20<50<200 下降配列', '📐'); emaSignal = 'perfect-down';
  } else if (e20 && e50 && e20 > e50) {
    add('EMA配列', +8, 'EMA20>50 上昇傾向', '📐'); emaSignal = 'partial-up';
  } else if (e20 && e50 && e20 < e50) {
    add('EMA配列', -5, 'EMA20<50 下降傾向', '📐'); emaSignal = 'partial-down';
  } else {
    add('EMA配列', 0, 'EMA配列 データ不足', '📐');
  }

  // ③ RSI
  const rsiArr = calcRSI(closes, 14);
  const rsi = rsiArr[last] || 50;
  if (rsi >= 50 && rsi <= 65) add('RSI', +10, 'RSI=' + rsi.toFixed(1) + ' 理想的な強気域(50-65)', '📊');
  else if (rsi > 65 && rsi <= 70) add('RSI', +3, 'RSI=' + rsi.toFixed(1) + ' やや過熱気味', '📊');
  else if (rsi > 70) add('RSI', -10, 'RSI=' + rsi.toFixed(1) + ' 買われすぎ — 反落注意', '📊');
  else if (rsi < 30) add('RSI', +5, 'RSI=' + rsi.toFixed(1) + ' 売られすぎ — 反発期待', '📊');
  else if (rsi >= 30 && rsi < 50) add('RSI', -3, 'RSI=' + rsi.toFixed(1) + ' 弱気域', '📊');

  // ④ MACD GC/DC
  // hist[last-1]がnull/undefined/NaNの場合に||0で0扱いすると偽のGC/DCが成立するため、
  // 明示的に有効値チェックし、無効なら加点0でGC/DC判定自体をスキップする
  const macdObj = calcMACD(closes);
  const histRaw = macdObj.hist[last], histPrevRaw = macdObj.hist[last - 1];
  const histValid = histRaw != null && !isNaN(histRaw) && histPrevRaw != null && !isNaN(histPrevRaw);
  let hist = null, histPrev = null, isGC = false, isDC = false;
  if (!histValid) {
    add('MACD', 0, 'MACD データ不足', '📊');
  } else {
    hist = histRaw; histPrev = histPrevRaw;
    isGC = hist > 0 && histPrev <= 0; isDC = hist < 0 && histPrev >= 0;
    if (isGC) add('MACD', +10, 'ゴールデンクロス発生！', '📈');
    else if (isDC) add('MACD', -10, 'デッドクロス発生！', '📉');
    else if (hist > 0 && hist > histPrev) add('MACD', +7, 'ヒストグラム拡大 上昇加速', '📈');
    else if (hist > 0) add('MACD', +5, 'MACDプラス圏 上昇継続', '📈');
    else if (hist < 0 && hist < histPrev) add('MACD', -7, 'ヒストグラム拡大 下落加速', '📉');
    else add('MACD', -5, 'MACDマイナス圏 下落継続', '📉');
  }

  // ⑤ ATRボラティリティ
  const atrArr = calcATR(highs, lows, closes, 14);
  const atrRaw = atrArr[last];
  const atrPct = (cur > 0 && atrRaw != null) ? atrRaw / cur * 100 : 0;
  if (atrPct >= 5) add('ATRボラ', -10, 'ATR=' + atrPct.toFixed(2) + '% 過熱 — リスク大', '⚡');
  else if (atrPct >= 3) add('ATRボラ', -5, 'ATR=' + atrPct.toFixed(2) + '% やや高め — 注意', '⚡');
  else add('ATRボラ', 0, 'ATR=' + atrPct.toFixed(2) + '% 安定範囲', '⚡');

  // ⑥ ギャップ率（始値 vs 前日終値）
  let gapPct = 0;
  if (opens && opens[last] && last >= 1 && closes[last - 1] > 0) {
    gapPct = (opens[last] - closes[last - 1]) / closes[last - 1] * 100;
    if (gapPct >= 3 && gapPct <= 8) add('GU/GD', +10, 'GU=+' + gapPct.toFixed(1) + '% 理想的ギャップアップ', '🎯');
    else if (gapPct > 1) add('GU/GD', +5, 'GU=+' + gapPct.toFixed(1) + '%', '🎯');
    else if (gapPct > 8) add('GU/GD', 0, 'GU=+' + gapPct.toFixed(1) + '% 過度なGU', '🎯');
    else if (gapPct < -3) add('GU/GD', -10, 'GD=' + gapPct.toFixed(1) + '% ギャップダウン', '🎯');
    else add('GU/GD', 0, 'ギャップ=' + gapPct.toFixed(1) + '%', '🎯');
  }

  // ⑦ 年初来高値（52週高値） — 時間軸に応じたバー数が無ければ「データ不足」として加点対象から除外する
  const needed52w = get52wBarsNeeded(interval);
  let pct52w = null, nearHigh52w = false;
  if (highs.length >= needed52w) {
    const nBars = Math.min(252, highs.length);
    const high52 = Math.max.apply(null, highs.slice(-nBars));
    pct52w = high52 > 0 ? (cur / high52 * 100) : 50;
    nearHigh52w = pct52w >= 97;
    if (cur >= high52 * 0.995) add('52W高値', +10, '52週高値更新中！ 強モメンタム', '🏆');
    else if (cur >= high52 * 0.97) add('52W高値', +5, '52週高値の3%圏内 ブレイク候補', '🏆');
    else add('52W高値', 0, '高値から' + ((1 - cur / high52) * 100).toFixed(1) + '%下', '🏆');
  } else {
    add('52W高値', 0, 'データ不足（' + (interval || '1d') + '足では52週相当のデータが取得できません）', '🏆');
  }

  // ⑧ 決算・アナリスト（summaryData未指定時はスキップされる）
  // 過去時点のシミュレーション（バックテスト）では決算日履歴・アナリスト評価はYahooから
  // 取得できず検証不能なため、スコアには一切加点しない。決算接近は「拒否権(veto)」として
  // 別扱いし、アナリスト評価は情報表示のみとする（Task E-1）
  let earningsVeto = { active: false, days: null };
  let analystInfo = null;
  if (summaryData) {
    const cal = summaryData.calendarEvents || {};
    const earArr = cal.earnings && cal.earnings.earningsDate;
    const nextEar = earArr && earArr[0] && earArr[0].raw;
    const now = Date.now() / 1000;
    if (nextEar) {
      const daysEar = Math.ceil((nextEar - now) / 86400);
      if (daysEar >= 0 && daysEar <= 7) {
        earningsVeto = { active: true, days: daysEar };
        add('決算リスク', 0, '決算まで' + daysEar + '日 — イベントリスクのためスコアを中立表示にします', '📅');
      } else if (daysEar >= 0 && daysEar <= 30) {
        add('決算', 0, '決算まで' + daysEar + '日（スコアには反映されません）', '📅');
      }
    }
    const fd = summaryData.financialData || {};
    const recKey = fd.recommendationKey || '';
    const recLabel = { strong_buy: 'STRONG BUY', buy: 'BUY', hold: 'HOLD', sell: 'SELL', strong_sell: 'STRONG SELL' }[recKey];
    if (recLabel) {
      analystInfo = { recommendationKey: recKey, label: recLabel };
      add('アナリスト(参考)', 0, 'コンセンサス: ' + recLabel + '（過去時点の検証ができないためスコアには反映されません）', '👨‍💼');
    }
  }

  score = Math.max(0, Math.min(100, score));

  let signal, signalClass, signalIcon, signalJa;
  if (earningsVeto.active) {
    // 数値そのものを中立化する（ラベルだけ書き換えると数値だけBUY相当のまま残ってしまうため）
    score = 50;
    signal = 'NEUTRAL'; signalClass = 'neutral'; signalIcon = '⏸️'; signalJa = '決算前(様子見)';
  } else if (score >= 90) { signal = 'STRONG BUY'; signalClass = 'strong-buy'; signalIcon = '🚀'; signalJa = '強い買い'; }
  else if (score >= 75) { signal = 'BUY'; signalClass = 'buy'; signalIcon = '📈'; signalJa = '買い'; }
  else if (score >= 50) { signal = 'NEUTRAL'; signalClass = 'neutral'; signalIcon = '⚖️'; signalJa = '中立'; }
  else if (score >= 30) { signal = 'SELL'; signalClass = 'sell'; signalIcon = '📉'; signalJa = '売り'; }
  else { signal = 'STRONG SELL'; signalClass = 'strong-sell'; signalIcon = '⬇️'; signalJa = '強い売り'; }

  const vClass = earningsVeto.active ? 'hold' : (signalClass === 'buy' || signalClass === 'strong-buy') ? 'buy' : (signalClass === 'sell' || signalClass === 'strong-sell') ? 'sell' : 'hold';

  return {
    score, signal, signalClass, signalIcon, signalJa, details, vClass,
    rsi, atrPct, gapPct, pct52w, nearHigh52w, volRatio,
    hist, isGC, isDC, macdGc: isGC, emaSignal, e20, e50, e200,
    earningsVeto, analystInfo
  };
}
