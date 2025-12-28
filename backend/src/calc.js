import { fetchAllContracts, fetchMexcFairPrice, fetchDailyCloses } from "./mexcFutures.js";

const TREND_BAND_PCT = Number(process.env.TREND_BAND_PCT || 0.3); // MA30 ±0.3%
const TURN_NEAR_PCT = Number(process.env.TURN_NEAR_PCT || 0.15);  // 경계 0.15% 이내
const USE_RSI_FILTER = String(process.env.RSI_FILTER || "true") === "true";
const RSI_THRESHOLD = Number(process.env.RSI_THRESHOLD || 50);

function ma(closes, period) {
  const arr = closes.slice(-period);
  return arr.reduce((a, b) => a + b, 0) / period;
}

function rsi14(closes) {
  const period = 14;
  const arr = closes.slice(-(period + 1));
  if (arr.length < period + 1) return NaN;

  let gains = 0, losses = 0;
  for (let i = 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function distPct(price, target) {
  return Math.abs(price - target) / target * 100;
}

function trendFromPriceMa(price, ma30, prevTrend) {
  const upper = ma30 * (1 + TREND_BAND_PCT / 100);
  const lower = ma30 * (1 - TREND_BAND_PCT / 100);
  if (price >= lower && price <= upper) return prevTrend || "NEUTRAL";
  if (price > upper) return "UP";
  if (price < lower) return "DOWN";
  return prevTrend || "NEUTRAL";
}

function turnType(price, ma30, prevTrend, curTrend) {
  const upper = ma30 * (1 + TREND_BAND_PCT / 100);
  const lower = ma30 * (1 - TREND_BAND_PCT / 100);

  // confirm
  if ((prevTrend === "UP" && curTrend === "DOWN") || (prevTrend === "DOWN" && curTrend === "UP")) {
    return "CONFIRM";
  }

  // near
  if (prevTrend === "UP") {
    if (distPct(price, lower) <= TURN_NEAR_PCT) return "NEAR";
  } else if (prevTrend === "DOWN") {
    if (distPct(price, upper) <= TURN_NEAR_PCT) return "NEAR";
  } else {
    if (Math.min(distPct(price, lower), distPct(price, upper)) <= TURN_NEAR_PCT) return "NEAR";
  }

  return "";
}

export async function scanTop({ top, maxSymbols }) {
  const contracts = await fetchAllContracts();

  // USDT 무기한 위주로 간단 필터
  const symbols = contracts
    .map((c) => c?.symbol)
    .filter(Boolean)
    .filter((s) => s.endsWith("_USDT"))
    .slice(0, maxSymbols);

  // ✅ “이전 트렌드”는 서버 메모리로만(간단) - Render 재시작하면 초기화
  globalThis.__prevTrend ??= {};
  const prevTrendMap = globalThis.__prevTrend;

  const rows = [];

  // 너무 무겁지 않게 순차 처리(안정)
  for (const sym of symbols) {
    try {
      const price = await fetchMexcFairPrice(sym);
      const closes = await fetchDailyCloses(sym, 31);

      const ma30 = ma(closes, 30);
      const rsi = rsi14(closes);
      const prevTrend = prevTrendMap[sym] || "";
      const curTrend = trendFromPriceMa(price, ma30, prevTrend);
      prevTrendMap[sym] = curTrend;

      const type = turnType(price, ma30, prevTrend, curTrend);
      if (!type) continue;

      // RSI 필터(방향 따라)
      if (USE_RSI_FILTER && Number.isFinite(rsi)) {
        if (curTrend === "UP" && rsi < RSI_THRESHOLD) continue;
        if (curTrend === "DOWN" && rsi > RSI_THRESHOLD) continue;
      }

      const devPct = ((price - ma30) / ma30) * 100;

      // 점수: confirm 우선 + |dev| 큰 순
      const score = (type === "CONFIRM" ? 1_000_000 : 0) + Math.abs(devPct) * 1000;

      rows.push({
        score,
        symbol: sym,
        direction:
          prevTrend === "UP" && curTrend === "DOWN"
            ? "상승 → 하락"
            : prevTrend === "DOWN" && curTrend === "UP"
              ? "하락 → 상승"
              : curTrend === "UP"
                ? "상승 후보"
                : curTrend === "DOWN"
                  ? "하락 후보"
                  : "중립",
        type: type === "CONFIRM" ? "전환확정" : "전환근접",
        bandPct: TREND_BAND_PCT,
        price,
        ma30,
        rsi,
        devPct
      });
    } catch {
      // 실패는 무시(안정 우선)
    }
  }

  rows.sort((a, b) => b.score - a.score);
  const topRows = rows.slice(0, top).map((r, i) => ({
    rank: i + 1,
    symbol: r.symbol,
    direction: r.direction,
    type: r.type,
    bandPct: r.bandPct,
    price: r.price,
    ma30: r.ma30,
    rsi14: r.rsi,
    devPct: r.devPct
  }));

  return {
    updated: new Date().toISOString(),
    top,
    maxSymbols,
    data: topRows
  };
}
