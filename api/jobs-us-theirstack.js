import admin from "firebase-admin";
import crypto from "crypto";

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
function sha256Hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}
function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(t) };
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithRetry(url, { method, headers, body, timeoutMs, retries }) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { signal, cancel } = withTimeout(timeoutMs);
    try {
      const r = await fetch(url, { method, headers, body, signal });
      const txt = await r.text();

      if (!r.ok) {
        if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
          lastErr = new Error(`HTTP ${r.status}: ${txt.slice(0, 250)}`);
          throw lastErr;
        }
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 250)}`);
      }

      try {
        return JSON.parse(txt);
      } catch {
        throw new Error(`Respuesta no-JSON: ${txt.slice(0, 200)}`);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const backoff = 350 * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
      throw lastErr;
    } finally {
      cancel();
    }
  }

  throw lastErr || new Error("fetchJsonWithRetry failed");
}

/* =========================
   SIMPLE GEOHASH (8 chars)
========================= */
const __base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohashEncode(lat, lon, precision = 8) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = "";

  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      const lonMid = (lonMin + lonMax) / 2;
      if (lon >= lonMid) { idx = (idx << 1) + 1; lonMin = lonMid; }
      else { idx = (idx << 1) + 0; lonMax = lonMid; }
    } else {
      const latMid = (latMin + latMax) / 2;
      if (lat >= latMid) { idx = (idx << 1) + 1; latMin = latMid; }
      else { idx = (idx << 1) + 0; latMax = latMid; }
    }

    evenBit = !evenBit;

    if (++bit === 5) {
      geohash += __base32.charAt(idx);
      bit = 0;
      idx = 0;
    }
  }
  return geohash;
}

/* =========================
   MAPBOX GEOCODING (fallback)
========================= */
async function geocodeWithMapbox(locationText, timeoutMs = 8000) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return null;

  const q = clean(locationText);
  if (!q) return null;

  const url =
    "https://api.mapbox.com/geocoding/v5/mapbox.places/" +
    encodeURIComponent(q) +
    `.json?access_token=${encodeURIComponent(token)}&limit=1&country=us`;

  const data = await fetchJsonWithRetry(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    body: null,
    timeoutMs,
    retries: 2,
  });

  const f = data?.features?.[0];
  const center = f?.center;
  if (!Array.isArray(center) || center.length !== 2) return null;

  const [lon, lat] = center;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function pickBestCoords(job) {
  const lat1 = toNum(job?.latitude);
  const lon1 = toNum(job?.longitude);
  if (Number.isFinite(lat1) && Number.isFinite(lon1)) return { lat: lat1, lon: lon1 };

  const loc0 = Array.isArray(job?.locations) ? job.locations[0] : null;
  const lat2 = toNum(loc0?.latitude);
  const lon2 = toNum(loc0?.longitude);
  if (Number.isFinite(lat2) && Number.isFinite(lon2)) return { lat: lat2, lon: lon2 };

  return null;
}

/* =========================
   LIBRETRANSLATE (SELF-HOST)
   - set LIBRETRANSLATE_URL (ex: http://localhost:5000/translate)
   - optional LIBRETRANSLATE_API_KEY
========================= */
async function libreTranslate({ text, source = "en", target = "es", timeoutMs = 15000, retries = 2 }) {
  const url = clean(process.env.LIBRETRANSLATE_URL);
  if (!url) return { ok: false, translatedText: null, error: "LIBRETRANSLATE_URL not set" };

  const apiKey = clean(process.env.LIBRETRANSLATE_API_KEY);

  const payload = {
    q: text,
    source,
    target,
    format: "text",
    ...(apiKey ? { api_key: apiKey } : {}),
  };

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { signal, cancel } = withTimeout(timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      const txt = await r.text();

      if (!r.ok) {
        // retry 429/5xx
        if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
          lastErr = new Error(`LibreTranslate HTTP ${r.status}: ${txt.slice(0, 200)}`);
          throw lastErr;
        }
        return { ok: false, translatedText: null, error: `LibreTranslate HTTP ${r.status}` };
      }

      let data;
      try { data = JSON.parse(txt); }
      catch { return { ok: false, translatedText: null, error: "LibreTranslate non-JSON" }; }

      const out = clean(data?.translatedText || "");
      if (!out) return { ok: false, translatedText: null, error: "LibreTranslate empty translation" };

      return { ok: true, translatedText: out, error: null };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(400 * Math.pow(2, attempt));
        continue;
      }
      return { ok: false, translatedText: null, error: lastErr?.message || "LibreTranslate failed" };
    } finally {
      cancel();
    }
  }
  return { ok: false, translatedText: null, error: lastErr?.message || "LibreTranslate failed" };
}

function makeTranslationKey({ title, description }) {
  const t = clean(title);
  const d = clean(description);
  return sha256Hex(`lt_v1|${t}|${d}`).slice(0, 40);
}

async function getOrCreateTranslationLT({
  db,
  title,
  description,
  maxChars,
  timeoutMs,
  retries,
}) {
  const key = makeTranslationKey({ title, description });
  const ref = db.collection("ofertas_trabajo_translations").doc(key);

  // cache read
  const snap = await ref.get();
  if (snap.exists) return { key, ...snap.data(), cached: true };

  const titleIn = clean(title);
  const descIn = clean(description);

  // controlar costo/tiempo (aunque sea “gratis”, evita cargas gigantes)
  const clipped = descIn.length > maxChars ? descIn.slice(0, maxChars) : descIn;
  const wasClipped = descIn.length > maxChars;

  const t1 = await libreTranslate({ text: titleIn, timeoutMs, retries });
  const t2 = await libreTranslate({ text: clipped, timeoutMs, retries });

  // si falló todo, no guardamos cache (para permitir futuros intentos)
  if (!t1.ok && !t2.ok) return null;

  const doc = {
    key,
    titleEs: t1.ok ? t1.translatedText : null,
    descriptionEs: t2.ok ? t2.translatedText : null,
    wasClipped,
    engine: "libretranslate",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(doc, { merge: true });
  return { ...doc, cached: false };
}

/* =========================
   THEIRSTACK SEARCH
========================= */
async function theirstackSearchJobs({
  apiKey,
  postedMaxAgeDays,
  discoveredMaxAgeDays,
  limit,
  page,
  jobTitleOr,
  jobDescriptionContainsOr,
  remote,
  employmentStatusesOr,
  urlDomainNot,
  timeoutMs,
  retries,
}) {
  const baseUrl = process.env.THEIRSTACK_BASE_URL || "https://api.theirstack.com";
  const url = `${baseUrl}/v1/jobs/search`;

  const payload = {
    page,
    limit,
    job_country_code_or: ["US"],
    posted_at_max_age_days: postedMaxAgeDays,
    discovered_at_max_age_days: discoveredMaxAgeDays ?? null,
    job_title_or: jobTitleOr?.length ? jobTitleOr : [],
    job_description_contains_or: jobDescriptionContainsOr?.length ? jobDescriptionContainsOr : [],
    remote: remote ?? null,
    employment_statuses_or: employmentStatusesOr?.length ? employmentStatusesOr : null,
    url_domain_not: urlDomainNot?.length ? urlDomainNot : [],
  };

  for (const k of Object.keys(payload)) {
    if (payload[k] === null) delete payload[k];
  }

  const data = await fetchJsonWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    timeoutMs,
    retries,
  });

  const jobs = Array.isArray(data?.data) ? data.data : [];
  const meta = data?.metadata || {};
  return { jobs, meta };
}

/* =========================
   NORMALIZER
========================= */
function normalizeTheirstackJob(job, areaKey) {
  const id = job?.id;
  if (!Number.isFinite(Number(id))) return null;

  const externalId = String(id);
  const docId = `ts_${externalId}`;

  const title = clean(job?.job_title);
  const company = clean(job?.company);
  const applyUrl = clean(job?.final_url || job?.url || job?.source_url);
  const sourceUrl = clean(job?.source_url || job?.url);
  const locationText = clean(job?.long_location || job?.short_location || job?.location);

  const datePosted = clean(job?.date_posted);
  const discoveredAt = clean(job?.discovered_at);

  return {
    docId,
    externalId,
    payload: {
      source: "theirstack",
      externalId,
      title: title || null,
      company: company || null,
      applyUrl: applyUrl || null,
      sourceUrl: sourceUrl || null,
      locationText: locationText || null,
      stateCode: clean(job?.state_code) || null,
      postalCode: clean(job?.postal_code) || null,
      countryCode: clean(job?.country_code) || "US",
      remote: job?.remote ?? null,
      hybrid: job?.hybrid ?? null,
      easyApply: job?.easy_apply ?? null,
      salaryString: clean(job?.salary_string) || null,
      salaryMin: toNum(job?.min_annual_salary_usd ?? job?.min_annual_salary),
      salaryMax: toNum(job?.max_annual_salary_usd ?? job?.max_annual_salary),
      salaryCurrency: clean(job?.salary_currency) || "USD",
      employmentStatuses: Array.isArray(job?.employment_statuses) ? job.employment_statuses : [],
      technologySlugs: Array.isArray(job?.technology_slugs) ? job.technology_slugs : [],
      seniority: clean(job?.seniority) || null,
      description: clean(job?.description) || null, // EN
      areaKey,
      postedAt: datePosted ? admin.firestore.Timestamp.fromDate(new Date(datePosted)) : null,
      discoveredAt: discoveredAt ? admin.firestore.Timestamp.fromDate(new Date(discoveredAt)) : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ingestedAt: admin.firestore.FieldValue.serverTimestamp(),
      active: true,
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

    const apiKey = process.env.THEIRSTACK_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Falta THEIRSTACK_API_KEY en el .env" });
    }

    // 🇺🇸 MODO USA GENERAL (sin bbox). q opcional.
    const q = clean(req.query.q || "");
    const terms = q ? q.split(",").map(clean).filter(Boolean).slice(0, 10) : [];

    const postedMaxAgeDays = clamp(toNum(req.query.postedMaxAgeDays) ?? 3, 0, 30);
    const discoveredMaxAgeDays = toNum(req.query.discoveredMaxAgeDays);
    const limit = clamp(toNum(req.query.limit) ?? 25, 1, 50);
    const maxPages = clamp(toNum(req.query.maxPages) ?? 3, 1, 10);

    const remote =
      req.query.remote === undefined
        ? null
        : (req.query.remote ?? "").toString() === "1" || (req.query.remote ?? "").toString() === "true";

    const rawEmployment = clean(req.query.employment || "");
    const employmentStatusesOr = rawEmployment ? rawEmployment.split(",").map(clean).filter(Boolean).slice(0, 5) : [];

    const timeoutMs = clamp(toNum(req.query.timeoutMs) ?? 20000, 8000, 30000);
    const geoTimeoutMs = clamp(toNum(req.query.geoTimeoutMs) ?? 8000, 3000, 15000);
    const retries = clamp(toNum(req.query.retries) ?? 3, 0, 5);

    // Traducción LibreTranslate (opcional)
    const translate = (req.query.translate ?? "1").toString() !== "0" && !!clean(process.env.LIBRETRANSLATE_URL);
    const maxTranslatePerRun = clamp(toNum(req.query.maxTranslate) ?? 60, 0, 300);
    const translateMaxChars = clamp(toNum(req.query.translateMaxChars) ?? 8000, 500, 20000);
    const translateTimeoutMs = clamp(toNum(req.query.translateTimeoutMs) ?? 15000, 5000, 60000);
    const translateRetries = clamp(toNum(req.query.translateRetries) ?? 2, 0, 5);

    // Lock diario por query
    const DAILY_LOCK = (req.query.lock ?? "1").toString() !== "0";
    const FORCE = (req.query.force ?? "0").toString() === "1";

    const queryKey = sha256Hex(
      JSON.stringify({
        terms,
        postedMaxAgeDays,
        discoveredMaxAgeDays: Number.isFinite(discoveredMaxAgeDays) ? discoveredMaxAgeDays : null,
        limit,
        maxPages,
        remote,
        employmentStatusesOr,
        translate,
        maxTranslatePerRun,
        translateMaxChars,
      })
    ).slice(0, 32);

    const today = new Date().toISOString().slice(0, 10);
    const metaRef = db.collection("ofertas_trabajo_meta").doc(`ts_${queryKey}`);

    if (DAILY_LOCK && !FORCE) {
      const metaSnap = await metaRef.get();
      const lastRun = metaSnap.exists ? metaSnap.data()?.lastRun : null;
      if (lastRun === today) {
        return res.json({
          ok: true,
          skippedByLock: true,
          queryKey,
          lastRun,
          message: "Lock diario activo: esta consulta ya corrió hoy.",
        });
      }
    }

    const jobTitleOr = terms.length ? terms : [];
    const jobDescriptionContainsOr = terms.length ? terms : [];

    const col = db.collection("ofertas_trabajo");

    let fetchedTotal = 0;
    let saved = 0;
    let geocoded = 0;
    let skippedNoCoords = 0;

    let translated = 0;
    let translationCached = 0;
    let translationFailed = 0;

    let batch = db.batch();
    let ops = 0;

    const seenDocIds = new Set();

    for (let page = 0; page < maxPages; page++) {
      const { jobs, meta } = await theirstackSearchJobs({
        apiKey,
        postedMaxAgeDays,
        discoveredMaxAgeDays: Number.isFinite(discoveredMaxAgeDays) ? discoveredMaxAgeDays : undefined,
        limit,
        page,
        jobTitleOr,
        jobDescriptionContainsOr,
        remote,
        employmentStatusesOr,
        urlDomainNot: [],
        timeoutMs,
        retries,
      });

      fetchedTotal += jobs.length;
      if (!jobs.length) break;

      for (const job of jobs) {
        const norm = normalizeTheirstackJob(job, `ts_${queryKey}`);
        if (!norm) continue;
        if (seenDocIds.has(norm.docId)) continue;
        seenDocIds.add(norm.docId);

        let coords = pickBestCoords(job);
        if (!coords) {
          const locText = clean(job?.long_location) || clean(job?.short_location) || clean(job?.location);
          const geo = await geocodeWithMapbox(locText, geoTimeoutMs);
          if (geo) {
            coords = { lat: geo.lat, lon: geo.lon };
            geocoded++;
          }
        }

        if (!coords) {
          skippedNoCoords++;
          continue;
        }

        const geoh = geohashEncode(coords.lat, coords.lon, 8);

        // Traducción ES (LibreTranslate) + cache en Firestore
        let titleEs = null;
        let descriptionEs = null;
        let clipped = null;

        if (translate && translated < maxTranslatePerRun) {
          try {
            const tr = await getOrCreateTranslationLT({
              db,
              title: norm.payload.title || "",
              description: norm.payload.description || "",
              maxChars: translateMaxChars,
              timeoutMs: translateTimeoutMs,
              retries: translateRetries,
            });

            if (tr) {
              titleEs = tr.titleEs ?? null;
              descriptionEs = tr.descriptionEs ?? null;
              clipped = tr.wasClipped ?? null;
              if (tr.cached) translationCached++;
              translated++;
            } else {
              translationFailed++;
            }
          } catch {
            translationFailed++;
          }
        }

        const docRef = col.doc(norm.docId);
        batch.set(
          docRef,
          {
            ...norm.payload,
            loc: new admin.firestore.GeoPoint(coords.lat, coords.lon),
            geohash: geoh,

            ...(titleEs ? { titleEs } : {}),
            ...(descriptionEs ? { descriptionEs } : {}),
            ...(clipped !== null ? { descriptionEsClipped: clipped } : {}),

            translation: {
              engine: translate ? "libretranslate" : "none",
              attempted: translate,
            },

            provider: { name: "theirstack", rawId: job?.id ?? null },

            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        saved++;
        ops++;

        if (ops >= 450) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }

      if (jobs.length < limit) break;
      if (meta?.truncated_results && meta.truncated_results > 0) {
        // informativo
      }
    }

    if (ops > 0) await batch.commit();

    await metaRef.set(
      {
        lastRun: today,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        queryKey,
        config: {
          postedMaxAgeDays,
          discoveredMaxAgeDays: Number.isFinite(discoveredMaxAgeDays) ? discoveredMaxAgeDays : null,
          limit,
          maxPages,
          remote,
          employmentStatusesOr,
          q: terms,
          translate,
          maxTranslatePerRun,
          translateMaxChars,
          libretranslateUrlSet: !!clean(process.env.LIBRETRANSLATE_URL),
        },
        stats: {
          fetchedTotal,
          saved,
          geocoded,
          skippedNoCoords,
          translated,
          translationCached,
          translationFailed,
        },
      },
      { merge: true }
    );

    res.setHeader("Cache-Control", "s-maxage=120");

    return res.json({
      ok: true,
      source: "theirstack",
      queryKey,
      q: terms,
      postedMaxAgeDays,
      discoveredMaxAgeDays: Number.isFinite(discoveredMaxAgeDays) ? discoveredMaxAgeDays : null,
      limit,
      maxPages,
      fetchedTotal,
      saved,
      geocoded,
      skippedNoCoords,
      translate,
      translated,
      translationCached,
      translationFailed,
      dailyLock: DAILY_LOCK,
      forced: FORCE,
      skippedByLock: false,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}