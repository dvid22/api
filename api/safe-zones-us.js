import admin from "firebase-admin";

/* =========================
   FIREBASE INIT (SAFE)
========================= */
function initFirebase() {
  if (admin.apps.length) return;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } =
    process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error("Faltan variables de entorno de Firebase Admin");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

/* =========================
   HELPERS
========================= */
function clean(v) {
  return (v ?? "").toString().trim();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(t) };
}

/* =========================
   TILE HELPERS (Slippy map)
   tileX = floor((lon+180)/360 * 2^z)
   tileY = floor((1 - ln(tan(lat)+sec(lat))/pi)/2 * 2^z)
========================= */
function lon2tileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

function lat2tileY(lat, z) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, z);
  return Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
  );
}

function tileBBox(x, y, z) {
  // returns [south, west, north, east]
  const n = Math.pow(2, z);

  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;

  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));

  const north = (northRad * 180) / Math.PI;
  const south = (southRad * 180) / Math.PI;

  return [south, west, north, east];
}

function makeTilesForBBox({ south, west, north, east, z, maxTiles }) {
  // Clamp lat/lon to valid ranges
  south = clamp(south, -85, 85);
  north = clamp(north, -85, 85);
  west = clamp(west, -180, 180);
  east = clamp(east, -180, 180);

  // If bbox crosses antimeridian, split (simple safe approach)
  const bboxes = [];
  if (west <= east) {
    bboxes.push({ south, west, north, east });
  } else {
    // e.g. west=170, east=-170 -> split
    bboxes.push({ south, west, north, east: 180 });
    bboxes.push({ south, west: -180, north, east });
  }

  const tiles = new Map();

  for (const b of bboxes) {
    const xMin = lon2tileX(b.west, z);
    const xMax = lon2tileX(b.east, z);
    const yMin = lat2tileY(b.north, z);
    const yMax = lat2tileY(b.south, z);

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        const key = `${z}_${x}_${y}`;
        if (!tiles.has(key)) tiles.set(key, { z, x, y });
      }
    }
  }

  // limit tiles to avoid abusing Overpass
  return Array.from(tiles.values()).slice(0, maxTiles);
}

/* =========================
   OSM / OVERPASS QUERY
========================= */
// Categorías relevantes “seguras” para migrantes.
// Nota: OSM depende de lo que esté mapeado. Esto da una base muy buena.
const CATEGORY_QUERIES = {
  hospital: [
    'node["amenity"="hospital"]',
    'way["amenity"="hospital"]',
    'relation["amenity"="hospital"]',
  ],
  clinic: [
    'node["amenity"="clinic"]',
    'way["amenity"="clinic"]',
    'relation["amenity"="clinic"]',
    'node["healthcare"="clinic"]',
    'way["healthcare"="clinic"]',
    'relation["healthcare"="clinic"]',
  ],
  pharmacy: [
    'node["amenity"="pharmacy"]',
    'way["amenity"="pharmacy"]',
    'relation["amenity"="pharmacy"]',
  ],
  shelter: [
    'node["social_facility"="shelter"]',
    'way["social_facility"="shelter"]',
    'relation["social_facility"="shelter"]',
    'node["amenity"="shelter"]',
    'way["amenity"="shelter"]',
    'relation["amenity"="shelter"]',
  ],
  food_bank: [
    'node["amenity"="social_facility"]["social_facility"="food_bank"]',
    'way["amenity"="social_facility"]["social_facility"="food_bank"]',
    'relation["amenity"="social_facility"]["social_facility"="food_bank"]',
  ],
  community: [
    'node["amenity"="community_centre"]',
    'way["amenity"="community_centre"]',
    'relation["amenity"="community_centre"]',
    'node["amenity"="social_facility"]',
    'way["amenity"="social_facility"]',
    'relation["amenity"="social_facility"]',
  ],
  help_center: [
    // centros de ayuda / ONG cuando está mapeado
    'node["name"~"help center|assistance|resource center|aid",i]',
    'way["name"~"help center|assistance|resource center|aid",i]',
    'relation["name"~"help center|assistance|resource center|aid",i]',
  ],
  legal_aid: [
    'node["office"="lawyer"]',
    'way["office"="lawyer"]',
    'relation["office"="lawyer"]',
    'node["name"~"legal aid|immigration",i]',
    'way["name"~"legal aid|immigration",i]',
    'relation["name"~"legal aid|immigration",i]',
  ],
};

function buildOverpassQueryForBBox({ south, west, north, east, categories, limit }) {
  const parts = [];
  for (const c of categories) {
    const selectors = CATEGORY_QUERIES[c];
    if (!selectors) continue;
    for (const s of selectors) {
      parts.push(`${s}(${south},${west},${north},${east});`);
    }
  }

  return `
    [out:json][timeout:25];
    (
      ${parts.join("\n")}
    );
    out tags center ${limit};
  `;
}

function normalizeCategoryFromTags(tags, fallback) {
  const amenity = clean(tags?.amenity).toLowerCase();
  const healthcare = clean(tags?.healthcare).toLowerCase();
  const social = clean(tags?.social_facility).toLowerCase();

  if (amenity === "hospital") return "hospital";
  if (amenity === "clinic" || healthcare === "clinic") return "clinic";
  if (amenity === "pharmacy") return "pharmacy";
  if (amenity === "shelter" || social === "shelter") return "shelter";
  if (social === "food_bank") return "food_bank";
  if (amenity === "community_centre") return "community";
  return fallback || "general";
}

function normalizeOsmElement(el, tileKey) {
  const tags = el?.tags || {};
  const name = clean(tags.name || tags.brand || "");
  const phone = clean(tags.phone || tags["contact:phone"] || "");
  const website = clean(tags.website || tags["contact:website"] || tags.url || "");

  const address = clean(
    [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:city"],
      tags["addr:state"],
      tags["addr:postcode"],
    ]
      .filter(Boolean)
      .join(" ")
  );

  const lat = el?.lat ?? el?.center?.lat;
  const lon = el?.lon ?? el?.center?.lon;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const placeId = `${el.type}_${el.id}`;
  const docId = `osm_${placeId}`;

  const category = normalizeCategoryFromTags(tags, "general");

  return {
    docId,
    payload: {
      name: name || null,
      category,
      tags,
      address: address || null,
      phone: phone || null,
      website: website || null,
      source: "osm",
      placeId,
      tileKey,
      loc: new admin.firestore.GeoPoint(lat, lon),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

/* =========================
   ENDPOINT
========================= */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    initFirebase();
    const db = admin.firestore();

    // bbox can come as bbox=s,w,n,e OR south/west/north/east
    const bboxRaw = clean(req.query.bbox);
    let south, west, north, east;

    if (bboxRaw) {
      const parts = bboxRaw.split(",").map((x) => Number(x));
      if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x))) {
        return res.status(400).json({ ok: false, error: "bbox inválido. Usa bbox=south,west,north,east" });
      }
      [south, west, north, east] = parts;
    } else {
      south = toNum(req.query.south);
      west = toNum(req.query.west);
      north = toNum(req.query.north);
      east = toNum(req.query.east);
      if ([south, west, north, east].some((v) => v === null)) {
        return res.status(400).json({
          ok: false,
          error: "Falta bbox. Usa bbox=south,west,north,east (recomendado).",
        });
      }
    }

    // Zoom tile for grouping (12 funciona muy bien para mapas)
    const z = clamp(toNum(req.query.z) ?? 12, 6, 16);

    // Cuántos tiles máximo por llamada
    const maxTiles = clamp(toNum(req.query.maxTiles) ?? 24, 1, 40);

    // Overpass limit per tile response
    const limit = clamp(toNum(req.query.limit) ?? 350, 80, 800);

    // Lock por tile diario (default ON)
    const DAILY_LOCK = (req.query.lock ?? "1").toString() !== "0";
    const FORCE = (req.query.force ?? "0").toString() === "1";

    // Timeout configurable (default 25s)
    const timeoutMs = clamp(toNum(req.query.timeoutMs) ?? 25000, 8000, 30000);

    const rawCats = clean(
      req.query.categories ||
        "hospital,clinic,pharmacy,shelter,food_bank,community,legal_aid,help_center"
    );

    const categories = rawCats
      .split(",")
      .map((s) => clean(s))
      .filter(Boolean)
      .filter((c, i, arr) => arr.indexOf(c) === i)
      .slice(0, 10);

    // Build visible tiles from bbox
    const tiles = makeTilesForBBox({ south, west, north, east, z, maxTiles });

    const col = db.collection("safe_places_us");
    const metaCol = db.collection("safe_places_meta");

    const today = new Date().toISOString().slice(0, 10);

    const overpassUrl = "https://overpass-api.de/api/interpreter";

    let tilesTotal = tiles.length;
    let tilesSkippedByLock = 0;
    let tilesFetched = 0;

    let fetchedElements = 0;
    let saved = 0;
    let skippedNoCoords = 0;

    // batch handling
    let batch = db.batch();
    let ops = 0;

    for (const t of tiles) {
      const tileKey = `${t.z}_${t.x}_${t.y}`;
      const metaRef = metaCol.doc(tileKey);

      if (DAILY_LOCK && !FORCE) {
        const metaSnap = await metaRef.get();
        const lastRun = metaSnap.exists ? metaSnap.data()?.lastRun : null;
        if (lastRun === today) {
          tilesSkippedByLock++;
          continue;
        }
      }

      // bbox for this tile
      const [ts, tw, tn, te] = tileBBox(t.x, t.y, t.z);

      const query = buildOverpassQueryForBBox({
        south: ts,
        west: tw,
        north: tn,
        east: te,
        categories,
        limit,
      });

      const { signal, cancel } = withTimeout(timeoutMs);
      let data;

      try {
        const r = await fetch(overpassUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: `data=${encodeURIComponent(query)}`,
          signal,
        });

        const txt = await r.text();
        if (!r.ok) {
          throw new Error(`Overpass HTTP ${r.status}: ${txt.slice(0, 250)}`);
        }

        try {
          data = JSON.parse(txt);
        } catch {
          throw new Error(`Overpass devolvió no-JSON: ${txt.slice(0, 200)}`);
        }
      } finally {
        cancel();
      }

      const elements = Array.isArray(data?.elements) ? data.elements : [];
      fetchedElements += elements.length;
      tilesFetched++;

      for (const el of elements) {
        const norm = normalizeOsmElement(el, tileKey);
        if (!norm) {
          skippedNoCoords++;
          continue;
        }

        const ref = col.doc(norm.docId);
        batch.set(ref, norm.payload, { merge: true });
        saved++;
        ops++;

        if (ops >= 450) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }

      // Update meta tile
      batch.set(
        metaRef,
        {
          lastRun: today,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          bbox: { south: ts, west: tw, north: tn, east: te },
          z: t.z,
          x: t.x,
          y: t.y,
          lastStats: {
            fetched: elements.length,
            saved,
            skippedNoCoords,
          },
        },
        { merge: true }
      );
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) await batch.commit();

    res.setHeader("Cache-Control", "s-maxage=300");

    return res.json({
      ok: true,
      mode: "bbox_tiles",
      bbox: { south, west, north, east },
      z,
      categories,
      tilesTotal,
      tilesFetched,
      tilesSkippedByLock,
      fetchedElements,
      saved,
      skippedNoCoords,
      dailyLock: DAILY_LOCK,
      forced: FORCE,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}