import express from "express";
import dotenv from "dotenv";

// 👇 Handlers Vercel
import newsHandler from "./api/news-us-immigration.js";
import safeZonesHandler from "./api/safe-zones-us.js";

dotenv.config();

const app = express();
app.use(express.json());

// ✅ CORS simple (seguro para local)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.get("/", (req, res) => {
  res
    .status(200)
    .send(
      "OK - Local server running. Try /api/news-us-immigration or /api/safe-zones-us"
    );
});

/* =========================
   NEWS ENDPOINT
========================= */
app.get("/api/news-us-immigration", async (req, res) => {
  try {
    console.log("➡️  Hit /api/news-us-immigration", req.query);
    await newsHandler(req, res);
  } catch (e) {
    console.error("❌ news handler crashed:", e);
    res.status(500).json({ ok: false, error: e?.message || "handler crashed" });
  }
});

/* =========================
   SAFE ZONES ENDPOINT
========================= */
app.get("/api/safe-zones-us", async (req, res) => {
  try {
    console.log("➡️  Hit /api/safe-zones-us", req.query);
    await safeZonesHandler(req, res);
  } catch (e) {
    console.error("❌ safe-zones handler crashed:", e);
    res.status(500).json({ ok: false, error: e?.message || "handler crashed" });
  }
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`✅ Local running on http://localhost:${PORT}`);
  console.log(`➡️  http://localhost:${PORT}/api/news-us-immigration`);
  console.log(`➡️  http://localhost:${PORT}/api/safe-zones-us`);
});

// 🔍 Errores globales visibles
process.on("unhandledRejection", (err) =>
  console.error("unhandledRejection", err)
);
process.on("uncaughtException", (err) =>
  console.error("uncaughtException", err)
);