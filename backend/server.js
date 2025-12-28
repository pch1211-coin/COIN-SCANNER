import express from "express";
import cors from "cors";
import { scanTop } from "./src/calc.js";

const app = express();

app.use(express.json());

// ✅ CORS: Render 프론트 도메인만 허용 (나중에 환경변수로 바꿀 수 있음)
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || "*";
app.use(
  cors({
    origin: FRONT_ORIGIN === "*" ? true : FRONT_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"]
  })
);

// health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// top endpoint
// 예: /api/top?top=30&maxSymbols=120
app.get("/api/top", async (req, res) => {
  try {
    const apiKey = req.header("x-api-key") || "";
    const viewKey = process.env.API_KEY_VIEW || "";
    const adminKey = process.env.API_KEY_ADMIN || "";

    // 간단 권한
    if (viewKey && apiKey !== viewKey && apiKey !== adminKey) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const top = Math.max(1, Math.min(300, Number(req.query.top || process.env.TOP_N || 30)));
    const maxSymbols = Math.max(
      10,
      Math.min(500, Number(req.query.maxSymbols || process.env.MAX_SYMBOLS || 120))
    );

    const out = await scanTop({ top, maxSymbols });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("server listening on", port));
