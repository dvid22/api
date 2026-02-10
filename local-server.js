import express from "express";
import dotenv from "dotenv";
import handler from "./api/news-us-immigration.js";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("OK - Local server running. Try /api/news-us-immigration");
});

app.get("/api/news-us-immigration", async (req, res) => {
  try {
    console.log("➡️ Hit /api/news-us-immigration", req.query);
    await handler(req, res);
  } catch (e) {
    console.error("❌ Handler crashed:", e);
    res.status(500).json({ ok: false, error: e?.message || "handler crashed" });
  }
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`✅ Local running on http://localhost:${PORT}`);
  console.log(`➡️  http://localhost:${PORT}/api/news-us-immigration`);
});

// Si hay errores silenciosos, que se vean:
process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));
process.on("uncaughtException", (err) => console.error("uncaughtException", err));