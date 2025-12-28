import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";

// ===== Paths =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, "..", "client", "dist");

// ===== App =====
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ===== Simple Login (ID/PW) =====
// Render 환경변수로 설정: APP_USER / APP_PASS / SESSION_SECRET
const APP_USER = process.env.APP_USER || "admin";
const APP_PASS = process.env.APP_PASS || "1234";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";

function makeSessionToken(username) {
  // 아주 단순 토큰 (운영이면 JWT/세션스토어 권장)
  return Buffer.from(`${username}|${SESSION_SECRET}`).toString("base64");
}
function isAuthed(req) {
  const t = req.cookies?.session;
  if (!t) return false;
  try {
    const s = Buffer.from(t, "base64").toString("utf8");
    return s === `${APP_USER}|${SESSION_SECRET}`;
  } catch {
    return false;
  }
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === APP_USER && password === APP_PASS) {
    res.cookie("session", makeSessionToken(username), {
      httpOnly: true,
      sameSite: "lax",
      secure: true // Render는 https
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: "Invalid credentials" });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ authed: isAuthed(req) });
});

// ===== MEXC Proxy URL =====
// Worker 도메인 사용 (예: https://mexc-proxy-pch1211.workers.dev)
const MEXC_PROXY = process.env.MEXC_PROXY || "https://mexc-proxy-pch1211.workers.dev";

// ===== Scanner State =====
const state = {
  // 설정(기본값) - UI에서 변경 가능
  settings: {
    // Near/Confirm 기준(%) - MA30 밴드 기준으로 사용
    trendBandPct: 0.3,  // MA30 ±0.3%
    nearPct: 0.15,      // 밴드 경계와 0.15% 이내면 Near
    // 표시 관련
    maxActiveNear: 200,
    maxActiveConfirm: 200,
    // 스캔 표시 목록
    scanShowBatch: 100,     // "스캐닝 중인 코인명 100개씩 표시"
    scanHistoryMax: 1000    // 1000개까지 표시 후 삭제 반복
  },

  // 심볼 목록(사용자가 UI에서 입력)
  symbols: [],

  // 순차 스캔 커서
  cursor: 0,

  // 심볼별 이전 트렌드
  prevTrend: new Map(),

  // 심볼별 중복 알림 방지(타입별 쿨다운 ms)
  lastAlert: new Map(), // key: sym, value: { type, ts }

  // SSE clients
  clients: new Set(),

  // 스캔 로그 (심볼명만) - 1000개까지 유지 후 초기화
  scanHistory: [],

  // 스캔 루프 제어
  running: false
};

// ===== Helpers =====
function mexcSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

async function fetchTicker(sym) {
  const msym = mexcSymbol(sym);
  const url = `${MEXC_PROXY}/api/v1/contract/ticker?symbol=${encodeURIComponent(msym)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ticker HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.success || !j?.data) throw new Error("ticker fail");
  const last = Number(j.data.lastPrice);
  const fair = Number(j.data.fairPrice ?? j.data.fair_price ?? last);
  if (!Number.isFinite(fair)) throw new Error("fairPrice invalid");
  return { fair };
}

async function fetchDailyCloses(sym, needCount) {
  const msym = mexcSymbol(sym);
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 120 * 24 * 60 * 60;
  const url =
    `${MEXC_PROXY}/api/v1/contract/kline/${encodeURIComponent(msym)}` +
    `?interval=Day1&start=${startSec}&end=${nowSec}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`kline HTTP ${r.status}`);
  const j = await r.json();
  const closes = j?.data?.close?.map(Number)?.filter(Number.isFinite);
  if (!closes || closes.length < needCount) throw new Error("not enough candles");
  return closes;
}

function calcMA(closes, period) {
  const arr = closes.slice(-period);
  return arr.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  const arr = closes.slice(-(period + 1));
  if (arr.length < period + 1) return NaN;
  let gains = 0, losses = 0;
  for (let i = 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff >= 0) gains += diff;
    else losses += (-diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function trendFromPriceMa(price, ma30, prevTrend, trendBandPct) {
  const upper = ma30 * (1 + trendBandPct / 100);
  const lower = ma30 * (1 - trendBandPct / 100);
  if (price >= lower && price <= upper) return prevTrend || "NEUTRAL";
  if (price > upper) return "UP";
  if (price < lower) return "DOWN";
  return prevTrend || "NEUTRAL";
}

function turnType(price, ma30, prevTrend, curTrend, trendBandPct, nearPct) {
  const upper = ma30 * (1 + trendBandPct / 100);
  const lower = ma30 * (1 - trendBandPct / 100);

  if ((prevTrend === "UP" && curTrend === "DOWN") || (prevTrend === "DOWN" && curTrend === "UP")) {
    return "CONFIRM";
  }

  const distPct = (a, b) => Math.abs(a - b) / a * 100;

  if (prevTrend === "UP") {
    if (distPct(price, lower) <= nearPct) return "NEAR";
  } else if (prevTrend === "DOWN") {
    if (distPct(price, upper) <= nearPct) return "NEAR";
  } else {
    if (Math.min(distPct(price, lower), distPct(price, upper)) <= nearPct) return "NEAR";
  }
  return null;
}

function directionText(prevTrend, curTrend) {
  if (prevTrend === "UP" && curTrend === "DOWN") return "UP→DOWN";
  if (prevTrend === "DOWN" && curTrend === "UP") return "DOWN→UP";
  if (curTrend === "UP") return "UP";
  if (curTrend === "DOWN") return "DOWN";
  return "NEUTRAL";
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.clients) {
    try { res.write(data); } catch {}
  }
}

function pushScanHistory(sym) {
  state.scanHistory.push(sym);
  if (state.scanHistory.length > state.settings.scanHistoryMax) {
    // 1000개까지 표시 후 삭제 → 반복
    state.scanHistory = [];
  }
}

function currentScanningBatch() {
  const N = Math.max(1, state.settings.scanShowBatch);
  if (state.symbols.length === 0) return [];
  const start = state.cursor;
  const out = [];
  for (let i = 0; i < Math.min(N, state.symbols.length); i++) {
    out.push(state.symbols[(start + i) % state.symbols.length]);
  }
  return out;
}

function shouldDedup(sym, type) {
  // 중복 방지: 같은 심볼 같은 타입은 3분 동안 반복 울림 방지(원하면 조정)
  const now = Date.now();
  const last = state.lastAlert.get(sym);
  const cooldown = 3 * 60 * 1000;
  if (last && last.type === type && (now - last.ts) < cooldown) return true;
  state.lastAlert.set(sym, { type, ts: now });
  return false;
}

// ===== Scanner Loop =====
async function scannerTick() {
  if (!state.running) return;
  if (state.symbols.length === 0) {
    setTimeout(scannerTick, 1500);
    return;
  }

  const sym = state.symbols[state.cursor % state.symbols.length];
  state.cursor = (state.cursor + 1) % state.symbols.length;

  try {
    // 스캔 표시
    pushScanHistory(sym);
    broadcast({
      kind: "scan",
      sym,
      scanningBatch: currentScanningBatch(),
      scanHistory: state.scanHistory
    });

    const { fair: price } = await fetchTicker(sym);
    const closes = await fetchDailyCloses(sym, 31);
    const ma30 = calcMA(closes, 30);
    const rsi14 = calcRSI(closes, 14);

    const prev = state.prevTrend.get(sym) || "";
    const cur = trendFromPriceMa(price, ma30, prev, state.settings.trendBandPct);
    state.prevTrend.set(sym, cur);

    const type = turnType(price, ma30, prev, cur, state.settings.trendBandPct, state.settings.nearPct);

    const devPct = ((price - ma30) / ma30) * 100;

    if (type === "NEAR" || type === "CONFIRM") {
      if (!shouldDedup(sym, type)) {
        broadcast({
          kind: "alert",
          type, // NEAR | CONFIRM
          sym,
          dir: directionText(prev, cur),
          price,
          ma30,
          rsi14,
          devPct,
          // 화면 유지 시간
          ttlMs: type === "NEAR" ? 3 * 60 * 1000 : 5 * 60 * 1000
        });
      }
    }

  } catch (e) {
    broadcast({ kind: "error", sym, message: String(e?.message || e) });
  }

  // 호출 속도(원하면 UI에서 조정하는 기능도 추가 가능)
  setTimeout(scannerTick, 450);
}

function startScanner() {
  if (state.running) return;
  state.running = true;
  scannerTick();
}
function stopScanner() {
  state.running = false;
}

// ===== Auth Middleware for API (except login/me) =====
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ ok: false });
  next();
}

// ===== API =====
app.post("/api/config", requireAuth, (req, res) => {
  const { symbols, settings } = req.body || {};
  if (Array.isArray(symbols)) {
    state.symbols = symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);
    state.cursor = 0;
    state.prevTrend = new Map(); // 새 목록이면 상태 리셋
  }
  if (settings && typeof settings === "object") {
    state.settings = { ...state.settings, ...settings };
  }
  res.json({ ok: true, symbolsCount: state.symbols.length, settings: state.settings });
});

app.get("/api/state", requireAuth, (req, res) => {
  res.json({
    ok: true,
    running: state.running,
    symbolsCount: state.symbols.length,
    settings: state.settings
  });
});

app.post("/api/start", requireAuth, (req, res) => {
  startScanner();
  res.json({ ok: true, running: true });
});

app.post("/api/stop", requireAuth, (req, res) => {
  stopScanner();
  res.json({ ok: true, running: false });
});

// SSE stream
app.get("/api/stream", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // 초기 상태
  res.write(`data: ${JSON.stringify({
    kind: "hello",
    running: state.running,
    settings: state.settings,
    symbolsCount: state.symbols.length
  })}\n\n`);

  state.clients.add(res);

  req.on("close", () => {
    state.clients.delete(res);
  });
});

// ===== Static client =====
app.use(express.static(DIST_DIR));
app.get("*", (req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// ===== Listen =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
