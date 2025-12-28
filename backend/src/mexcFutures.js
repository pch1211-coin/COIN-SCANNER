const MEXC_PROXY_BASE =
  process.env.MEXC_PROXY_BASE || "https://contract.mexc.com";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// MEXC futures contract detail
export async function fetchAllContracts() {
  const url = `${MEXC_PROXY_BASE}/api/v1/contract/detail`;
  const j = await fetchJson(url);
  return j?.data || [];
}

// fair price
export async function fetchMexcFairPrice(symbol) {
  const url = `${MEXC_PROXY_BASE}/api/v1/contract/fair_price/${encodeURIComponent(symbol)}`;
  const j = await fetchJson(url);
  const fair = Number(j?.data?.fairPrice ?? j?.data?.fair_price);
  if (!Number.isFinite(fair)) throw new Error(`fairPrice invalid for ${symbol}`);
  return fair;
}

// daily closes for MA/RSI
export async function fetchDailyCloses(symbol, limit = 31) {
  const url =
    `${MEXC_PROXY_BASE}/api/v1/contract/kline/${encodeURIComponent(symbol)}` +
    `?interval=1d&limit=${Number(limit)}`;

  const j = await fetchJson(url);
  const arr = Array.isArray(j?.data) ? j.data : [];
  const closes = arr.map((k) => Number(k?.close)).filter((v) => Number.isFinite(v));
  if (closes.length < Math.min(15, Number(limit))) {
    throw new Error(`not enough candles for ${symbol}: ${closes.length}`);
  }
  return closes;
}
