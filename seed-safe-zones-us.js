import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

const BASE = process.env.SEED_BASE_URL || "http://localhost:3000";

// BBox continental USA aprox
const US = { south: 24.396308, west: -124.848974, north: 49.384358, east: -66.885444 };

const Z = Number(process.env.SEED_Z || 8);
const DELAY_MS = Number(process.env.SEED_DELAY_MS || 1600);
const MAX_TILES = Number(process.env.SEED_MAX_TILES || 999999);

const CATEGORIES =
  process.env.SEED_CATEGORIES ||
  "fedex,usps,printing,shipping"; // 👈 por defecto SOLO lo nuevo (más estable)

const RETRIES_PER_TILE = Number(process.env.SEED_RETRIES_PER_TILE || 3);
const FAIL_FILE = process.env.SEED_FAIL_FILE || "failed_tiles.txt";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function lon2tileX(lon, z) { return Math.floor(((lon + 180) / 360) * (1 << z)); }
function lat2tileY(lat, z) {
  const latRad = (lat * Math.PI) / 180;
  const n = 1 << z;
  return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
}

async function hit(url) {
  try {
    const r = await fetch(url);
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); }
    catch { json = { ok: false, error: txt.slice(0, 250) }; }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: { ok: false, error: String(e?.message || e) } };
  }
}

function logFail(tile, status, err) {
  fs.appendFileSync(
    FAIL_FILE,
    `${tile}\tHTTP ${status}\t${String(err).slice(0, 180)}\n`,
    "utf8"
  );
}

async function runTile(tile) {
  const url =
    `${BASE}/api/safe-zones-us?tile=${tile}` +
    `&categories=${encodeURIComponent(CATEGORIES)}` +
    `&limit=250` +           // 👈 menos carga
    `&lock=0&force=1` +
    `&attempts=4&timeoutMs=35000`;

  for (let a = 0; a <= RETRIES_PER_TILE; a++) {
    const { status, json } = await hit(url);
    if (json?.ok) return { ok: true, status, json };

    // backoff progresivo
    if (a < RETRIES_PER_TILE) await sleep(900 + a * 1200);
    else return { ok: false, status, json };
  }
}

async function main() {
  try { fs.unlinkSync(FAIL_FILE); } catch {}

  const xMin = lon2tileX(US.west, Z);
  const xMax = lon2tileX(US.east, Z);
  const yMin = lat2tileY(US.north, Z);
  const yMax = lat2tileY(US.south, Z);

  console.log("=====================================");
  console.log("🚀 SAFE ZONES MASSIVE SEED START");
  console.log("Z =", Z);
  console.log("Tiles X:", xMin, "→", xMax);
  console.log("Tiles Y:", yMin, "→", yMax);
  console.log("Categories:", CATEGORIES);
  console.log("Delay:", DELAY_MS, "ms");
  console.log("Retries per tile:", RETRIES_PER_TILE);
  console.log("=====================================");

  let done = 0, ok = 0, fail = 0;
  let stop = false;

  for (let x = xMin; x <= xMax && !stop; x++) {
    for (let y = yMin; y <= yMax; y++) {
      done++;
      if (done > MAX_TILES) { stop = true; break; }

      const tile = `${Z}_${x}_${y}`;
      const r = await runTile(tile);

      if (r.ok) {
        ok++;
        console.log(`✅ ${tile} → fetched=${r.json.fetchedElements ?? 0} saved=${r.json.saved ?? 0}`);
      } else {
        fail++;
        console.log(`⚠️ ${tile} → HTTP ${r.status} → ${r.json?.error ?? "error"}`);
        logFail(tile, r.status, r.json?.error ?? "error");
      }

      await sleep(DELAY_MS);
    }
  }

  console.log("=====================================");
  console.log("🏁 DONE");
  console.log("Tiles processed:", done);
  console.log("Success:", ok);
  console.log("Fail:", fail);
  console.log(`Failed tiles saved in ./${FAIL_FILE}`);
  console.log("=====================================");
}

main().catch((e) => {
  console.error("❌ SEED CRASHED:", e);
  process.exit(1);
});