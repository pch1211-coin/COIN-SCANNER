import React, { useEffect, useMemo, useRef, useState } from "react";

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

// WebAudio 비프: times번
function beep(times = 1) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let t = ctx.currentTime;

    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.14);
      t += 0.22;
    }
    setTimeout(() => ctx.close(), 700);
  } catch {}
}

async function apiGet(url) {
  const r = await fetch(url, { credentials: "include" });
  return r.json();
}
async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : "{}"
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.message || `HTTP ${r.status}`);
  }
  return r.json();
}

export default function App() {
  const [authed, setAuthed] = useState(false);

  // login form
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [loginErr, setLoginErr] = useState("");

  // server state
  const [running, setRunning] = useState(false);
  const [symbolsText, setSymbolsText] = useState("BTCUSDT\nETHUSDT\nXRPUSDT\nDOGEUSDT");
  const [settings, setSettings] = useState({
    trendBandPct: 0.3,
    nearPct: 0.15,
    scanShowBatch: 100,
    scanHistoryMax: 1000,
    maxActiveNear: 200,
    maxActiveConfirm: 200
  });

  // UI speaker on/off
  const [speakerOn, setSpeakerOn] = useState(true);

  // alerts (active for 3m / 5m)
  const [activeAlerts, setActiveAlerts] = useState([]);
  // scan display
  const [scanningBatch, setScanningBatch] = useState([]);
  const [scanHistory, setScanHistory] = useState([]);
  const [errors, setErrors] = useState([]);

  const mobile = useMemo(() => isMobileDevice(), []);
  const streamRef = useRef(null);

  // auth check
  useEffect(() => {
    apiGet("/api/me").then(r => setAuthed(!!r.authed)).catch(() => setAuthed(false));
  }, []);

  // load server state
  useEffect(() => {
    if (!authed) return;
    apiGet("/api/state").then(r => {
      setRunning(!!r.running);
      if (r.settings) setSettings(prev => ({ ...prev, ...r.settings }));
    }).catch(() => {});
  }, [authed]);

  // cleanup expired alerts every 1s
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setActiveAlerts(prev => prev.filter(a => a.expiresAt > now));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // SSE connect
  useEffect(() => {
    if (!authed) return;

    // close previous
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }

    const es = new EventSource("/api/stream", { withCredentials: true });
    streamRef.current = es;

    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);

        if (ev.kind === "hello") {
          setRunning(!!ev.running);
          if (ev.settings) setSettings(prev => ({ ...prev, ...ev.settings }));
          return;
        }

        if (ev.kind === "scan") {
          setScanningBatch(ev.scanningBatch || []);
          setScanHistory(ev.scanHistory || []);
          return;
        }

        if (ev.kind === "error") {
          setErrors(prev => [{ ts: Date.now(), sym: ev.sym, message: ev.message }, ...prev].slice(0, 50));
          return;
        }

        if (ev.kind === "alert") {
          const now = Date.now();
          const expiresAt = now + Number(ev.ttlMs || 0);

          setActiveAlerts(prev => {
            const next = [
              {
                id: `${ev.type}-${ev.sym}-${now}`,
                type: ev.type,
                sym: ev.sym,
                dir: ev.dir,
                price: ev.price,
                devPct: ev.devPct,
                expiresAt
              },
              ...prev
            ];

            // 표시 개수 제한(드롭다운으로 조정되는 값)
            const maxN = ev.type === "NEAR" ? settings.maxActiveNear : settings.maxActiveConfirm;
            const filtered = next.filter(a => a.type === ev.type).slice(0, maxN);
            const other = next.filter(a => a.type !== ev.type);
            return [...filtered, ...other].sort((a, b) => b.expiresAt - a.expiresAt);
          });

          // 비프 + 진동
          if (speakerOn) {
            if (ev.type === "NEAR") beep(1);
            if (ev.type === "CONFIRM") beep(3);
          }
          if (mobile && ev.type === "CONFIRM" && navigator.vibrate) {
            navigator.vibrate([200, 80, 200, 80, 200]);
          }
        }
      } catch {}
    };

    es.onerror = () => {
      // 자동 재연결됨 (EventSource 기본 동작)
    };

    return () => {
      es.close();
      streamRef.current = null;
    };
  }, [authed, speakerOn, mobile, settings.maxActiveNear, settings.maxActiveConfirm]);

  async function doLogin() {
    setLoginErr("");
    try {
      await apiPost("/api/login", { username: u, password: p });
      setAuthed(true);
    } catch (e) {
      setLoginErr("로그인 실패");
    }
  }

  async function doLogout() {
    await apiPost("/api/logout");
    setAuthed(false);
  }

  async function applyConfig() {
    const symbols = symbolsText
      .split(/\r?\n/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    await apiPost("/api/config", { symbols, settings });
    const st = await apiGet("/api/state");
    setRunning(!!st.running);
  }

  async function start() {
    await apiPost("/api/start");
    setRunning(true);
  }
  async function stop() {
    await apiPost("/api/stop");
    setRunning(false);
  }

  function speakerIcon() {
    return speakerOn ? "🔊" : "🔇";
  }

  const nearList = activeAlerts.filter(a => a.type === "NEAR");
  const confirmList = activeAlerts.filter(a => a.type === "CONFIRM");

  if (!authed) {
    return (
      <div className="container">
        <div className="card" style={{ maxWidth: 520, margin: "40px auto" }}>
          <div className="big">로그인</div>
          <div className="small" style={{ marginTop: 6, opacity: 0.9 }}>
            아이디/비밀번호 입력 방식
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <input className="input" placeholder="ID" value={u} onChange={e => setU(e.target.value)} />
            <input className="input" placeholder="PW" type="password" value={p} onChange={e => setP(e.target.value)} />
            <button className="btn" onClick={doLogin}>Login</button>
          </div>
          {loginErr && <div className="small" style={{ color: "#ff6b6b", marginTop: 10 }}>{loginErr}</div>}
          <div className="small" style={{ marginTop: 10 }}>
            ※ Render 환경변수 APP_USER / APP_PASS 로 고정됩니다.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="topbar">
        <div className="row">
          <div className="big">MEXC 선물 대시보드</div>
          <span className={`badge ${running ? "on" : "off"}`}>{running ? "SCANNING: ON" : "SCANNING: OFF"}</span>

          <button
            className="speaker"
            title="스피커 ON/OFF"
            onClick={() => setSpeakerOn(v => !v)}
          >
            {speakerIcon()}
          </button>

          <button className="btn" onClick={running ? stop : start}>
            {running ? "Stop" : "Start"}
          </button>

          <button className="btn" onClick={doLogout}>Logout</button>
        </div>
      </div>

      <div className="grid">
        {/* Left */}
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="big">설정</div>
            <button className="btn" onClick={applyConfig}>적용</button>
          </div>

          <div style={{ marginTop: 10 }}>
            <div className="small">심볼 목록 (최대 1000개까지 넣어도 서버가 순차 스캔)</div>
            <textarea
              className="input mono"
              value={symbolsText}
              onChange={e => setSymbolsText(e.target.value)}
              placeholder={"BTCUSDT\nETHUSDT\n..."}
            />
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <label className="small">표시 개수(NEAR)</label>
            <select
              value={settings.maxActiveNear}
              onChange={e => setSettings(s => ({ ...s, maxActiveNear: Number(e.target.value) }))}
            >
              {[50,100,200,300,500].map(v => <option key={v} value={v}>{v}</option>)}
            </select>

            <label className="small">표시 개수(CONFIRM)</label>
            <select
              value={settings.maxActiveConfirm}
              onChange={e => setSettings(s => ({ ...s, maxActiveConfirm: Number(e.target.value) }))}
            >
              {[50,100,200,300,500].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <label className="small">근접(%)</label>
            <select
              value={settings.nearPct}
              onChange={e => setSettings(s => ({ ...s, nearPct: Number(e.target.value) }))}
            >
              {[0.05,0.1,0.15,0.2,0.3,0.5].map(v => <option key={v} value={v}>{v}%</option>)}
            </select>

            <label className="small">밴드(%)</label>
            <select
              value={settings.trendBandPct}
              onChange={e => setSettings(s => ({ ...s, trendBandPct: Number(e.target.value) }))}
            >
              {[0.2,0.3,0.5,0.8,1.0].map(v => <option key={v} value={v}>{v}%</option>)}
            </select>

            <label className="small">스캐닝 표시(개)</label>
            <select
              value={settings.scanShowBatch}
              onChange={e => setSettings(s => ({ ...s, scanShowBatch: Number(e.target.value) }))}
            >
              {[50,100,150,200].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <span className="small">
              규칙: Near=비프 1회/파란 점멸/3분 표시 · Confirm=비프 3회/빨간 점멸/5분 표시 {mobile ? "· 모바일은 Confirm 진동" : ""}
            </span>
          </div>
        </div>

        {/* Right */}
        <div className="card">
          <div className="big">스캐닝 상태</div>
          <div className="small" style={{ marginTop: 6 }}>현재 표시(최대 {settings.scanShowBatch}개):</div>
          <div className="card scanBox" style={{ marginTop: 8, background:"#0e1522" }}>
            <div className="mono small">
              {scanningBatch.length ? scanningBatch.join(", ") : "대기 중..."}
            </div>
          </div>

          <div className="small" style={{ marginTop: 10 }}>
            스캔 히스토리(최대 {settings.scanHistoryMax}개 후 초기화 반복):
          </div>
          <div className="card scanBox" style={{ marginTop: 8, background:"#0e1522" }}>
            <div className="mono small">
              {scanHistory.slice().reverse().join(" · ")}
            </div>
          </div>

          {errors.length > 0 && (
            <>
              <div className="small" style={{ marginTop: 10, color: "#ffb3b3" }}>에러 로그</div>
              <div className="card scanBox" style={{ marginTop: 8, background:"#0e1522" }}>
                {errors.map((e, i) => (
                  <div key={i} className="mono small">[{new Date(e.ts).toLocaleTimeString()}] {e.sym}: {e.message}</div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="big">NEAR (3분 표시)</div>
          <div className="alertList" style={{ marginTop: 10 }}>
            {nearList.length === 0 && <div className="small">없음</div>}
            {nearList.map(a => (
              <div key={a.id} className={`alertItem blinkBlue`}>
                <div>
                  <div className="big">{a.sym} <span className="small">({a.dir})</span></div>
                  <div className="small">price: {Number(a.price).toFixed(6)} · dev: {Number(a.devPct).toFixed(3)}%</div>
                </div>
                <div className="small">
                  남은시간: {Math.max(0, Math.ceil((a.expiresAt - Date.now())/1000))}s
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="big">CONFIRM (5분 표시)</div>
          <div className="alertList" style={{ marginTop: 10 }}>
            {confirmList.length === 0 && <div className="small">없음</div>}
            {confirmList.map(a => (
              <div key={a.id} className={`alertItem blinkRed`}>
                <div>
                  <div className="big">{a.sym} <span className="small">({a.dir})</span></div>
                  <div className="small">price: {Number(a.price).toFixed(6)} · dev: {Number(a.devPct).toFixed(3)}%</div>
                </div>
                <div className="small">
                  남은시간: {Math.max(0, Math.ceil((a.expiresAt - Date.now())/1000))}s
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="small" style={{ marginTop: 14, opacity: .75 }}>
        ※ iOS Safari는 “사용자 제스처(터치)” 없으면 소리가 막힐 수 있어요. 상단 스피커 버튼 한 번 눌러주면 안정적입니다.
      </div>
    </div>
  );
}
