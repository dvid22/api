import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.SEED_BASE_URL || "http://localhost:3000";

// BBox continental USA aprox
const US = { south: 24.396308, west: -124.848974, north: 49.384358, east: -66.885444 };

const Z = Number(process.env.SEED_Z || 8);          // 8 recomendado para empezar
const DELAY_MS = Number(process.env.SEED_DELAY_MS || 900);
const MAX_TILES = Number(process.env.SEED_MAX_TILES || 999999);
const CATEGORIES = process.env.SEED_CATEGORIES || "hospital,clinic,pharmacy,shelter,food_bank,community";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function lon2tileX(lon, z) { return Math.floor(((lon + 180) / 360) * (1 << z)); }
function lat2tileY(lat, z) {
  const latRad = (lat * Math.PI) / 180;
  const n = 1 << z;
  return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
}

async function hit(url) {
  const r = await fetch(url);
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { j = { ok: false, error: txt.slice(0, 200) }; }
  return { status: r.status, json: j };
}

async function main() {
  const xMin = lon2tileX(US.west, Z);
  const xMax = lon2tileX(US.east, Z);
  const yMin = lat2tileY(US.north, Z);
  const yMax = lat2tileY(US.south, Z);

  console.log(`SEED start Z=${Z} X[${xMin}..${xMax}] Y[${yMin}..${yMax}]`);
  let done = 0, ok = 0, fail = 0;

  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      done++;
      if (done > MAX_TILES) break;

      const tile = `${Z}_${x}_${y}`;
      const url =
        `${BASE}/api/safe-zones-us?tile=${tile}` +
        `&categories=${encodeURIComponent(CATEGORIES)}` +
        `&limit=250&lock=1&attempts=4&timeoutMs=35000`;

      const { status, json } = await hit(url);

      if (json?.ok) {
        ok++;
        console.log(`✅ ${tile} fetched=${json.fetchedElements ?? "?"} saved=${json.saved ?? "?"}`);
      } else {
        fail++;
        console.log(`⚠️ ${tile} HTTP ${status} ${json?.error ?? "error"}`);
      }

      await sleep(DELAY_MS);
    }
  }

  console.log(`DONE tiles=${done} ok=${ok} fail=${fail}`);
}

main().catch((e) => {
  console.error("SEED crashed:", e);
  process.exit(1);
});