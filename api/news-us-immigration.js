// ✅ Endpoint: trae noticias (NewsAPI), filtra barato, usa OpenAI para:
// 1) decidir si es realmente sobre migración en EEUU
// 2) traducir título + resumen al español
// 3) guardar en Firestore: image, titleEs, summaryEs, url exacta, source, publishedAt
//
// ✅ Fix clave: Responses API + Structured Outputs REQUIERE text.format.name
// ✅ Fix clave: el shape correcto es: text.format = { type, name, schema, strict }
// ✅ Incluye fallback automático a json_object si json_schema falla
//
// Requiere env:
// FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// NEWSAPI_KEY
// OPENAI_API_KEY
// OPENAI_MODEL (opcional) ej: gpt-4o-mini / gpt-4.1-mini

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

function isValidUrl(u) {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

function pickImage(a) {
  return isValidUrl(a?.urlToImage) ? a.urlToImage : null;
}

function makeDocIdFromUrl(url) {
  return Buffer.from(url)
    .toString("base64")
    .replace(/[/+=]/g, "")
    .slice(0, 120);
}

/**
 * Filtro rápido (barato) antes de gastar IA.
 */
function quickKeywordPass(article) {
  const t = `${article.title || ""} ${article.description || ""}`.toLowerCase();

  const mustHaveAny = [
    "immigrant",
    "immigrants",
    "immigration",
    "migrant",
    "migrants",
    "asylum",
    "refugee",
    "refugees",
    "deport",
    "deportation",
    "border",
    "ice",
    "dhs",
    "cbp",
    "visa",
  ];

  const contextUs = ["u.s.", "usa", "united states", "america", "texas", "border"];

  const hitsA = mustHaveAny.filter((k) => t.includes(k)).length;
  const hitsB = contextUs.filter((k) => t.includes(k)).length;

  return hitsA >= 1 && (hitsB >= 1 || hitsA >= 3);
}

/* =========================
   OPENAI (Responses API) + Structured Outputs
========================= */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => clean(t)).filter(Boolean).slice(0, 8);
}

function normalizeCategory(cat) {
  const allowed = new Set([
    "frontera",
    "asilo",
    "deportaciones",
    "visas",
    "refugiados",
    "politica_migratoria",
    "general",
  ]);
  const c = clean(cat);
  return allowed.has(c) ? c : "general";
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(t) };
}

function extractOutputTextFromResponsesAPI(payload) {
  // si viene directo
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const out = payload?.output;
  if (!Array.isArray(out)) return "";

  const chunks = [];
  for (const item of out) {
    const contentArr = item?.content;
    if (!Array.isArray(contentArr)) continue;

    for (const c of contentArr) {
      if (typeof c?.text === "string" && c.text.trim()) chunks.push(c.text);
      if (typeof c?.value === "string" && c.value.trim()) chunks.push(c.value);
    }
  }

  return chunks.join("\n").trim();
}

function buildAISchema() {
  // ✅ Schema PURO (sin envolverlo en "json_schema: { name, schema }" aquí)
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      isMigrationRelated: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      category: {
        type: "string",
        enum: [
          "frontera",
          "asilo",
          "deportaciones",
          "visas",
          "refugiados",
          "politica_migratoria",
          "general",
        ],
      },
      titleEs: { type: "string" },
      summaryEs: { type: "string" },
      tagsEs: { type: "array", items: { type: "string" }, maxItems: 8 },
      reason: { type: "string" },
    },
    required: [
      "isMigrationRelated",
      "confidence",
      "category",
      "titleEs",
      "summaryEs",
      "tagsEs",
      "reason",
    ],
  };
}

function shouldFallbackToJsonObject(errText) {
  const s = (errText || "").toLowerCase();
  return (
    s.includes("text.format") ||
    s.includes("json_schema") ||
    s.includes("missing required parameter") ||
    s.includes("invalid_request_error") ||
    s.includes("unsupported") ||
    s.includes("schema")
  );
}

async function callOpenAIResponses({ model, instructions, inputText, useSchema }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY en .env");

  const base = {
    model,
    instructions,
    input: inputText,
    temperature: 0.2,
    store: false,
  };

  const body = useSchema
    ? {
        ...base,
        text: {
          format: {
            type: "json_schema",
            name: "news_migration_classifier", // ✅ REQUIRED
            schema: buildAISchema(), // ✅ REQUIRED
            strict: true,
          },
        },
      }
    : {
        ...base,
        // fallback: solo JSON válido (no schema estricto)
        text: { format: { type: "json_object" } },
      };

  const { signal, cancel } = withTimeout(25_000);

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    const txt = await r.text();

    if (!r.ok) {
      const e = new Error(`OpenAI(${model}) HTTP ${r.status}: ${txt}`);
      e._raw = txt;
      e._status = r.status;
      throw e;
    }

    let payload;
    try {
      payload = JSON.parse(txt);
    } catch {
      throw new Error(`OpenAI(${model}) devolvió no-JSON: ${txt.slice(0, 200)}`);
    }

    const outText = extractOutputTextFromResponsesAPI(payload);
    if (!outText) throw new Error(`OpenAI(${model}) sin output de texto`);

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch {
      throw new Error(`OpenAI(${model}) output no parseable: ${outText.slice(0, 200)}`);
    }

    return parsed;
  } finally {
    cancel();
  }
}

async function openaiResponsesJSON({ inputText }) {
  const preferred = clean(process.env.OPENAI_MODEL) || "gpt-4o-mini";

  const modelCandidates = [
    preferred,
    "gpt-4.1-mini",
    "gpt-4o-mini",
    "gpt-4.1-nano",
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);

  const instructions =
    "Eres un editor de noticias. " +
    "Decide si la noticia trata PRINCIPALMENTE sobre migración/inmigración/migrantes/refugiados/asilo/deportaciones/visas en Estados Unidos. " +
    "Si solo lo menciona de pasada => isMigrationRelated=false. " +
    "Devuelve titleEs y summaryEs en español (neutros, 1–2 frases). " +
    "No inventes datos. Si falta información, resume con lo que haya.";

  let lastErr = null;

  for (const model of modelCandidates) {
    // 1) intentamos schema estricto
    try {
      const json = await callOpenAIResponses({
        model,
        instructions,
        inputText,
        useSchema: true,
      });
      return { modelUsed: model, json };
    } catch (e) {
      lastErr = e?.message || "OpenAI error";
      const raw = e?._raw || "";

      // 2) fallback a json_object si parece error de schema/formato
      if (shouldFallbackToJsonObject(raw)) {
        try {
          const json = await callOpenAIResponses({
            model,
            instructions: instructions + " Devuelve SOLO JSON válido.",
            inputText,
            useSchema: false,
          });
          return { modelUsed: model, json };
        } catch (e2) {
          lastErr = e2?.message || lastErr;
          continue;
        }
      }

      continue;
    }
  }

  throw new Error(lastErr || "OpenAI error desconocido");
}

async function aiEnrichArticle({ title, description, content, url }) {
  const inputText = [
    `URL: ${url}`,
    `TITLE: ${title || ""}`,
    `DESCRIPTION: ${description || ""}`,
    `CONTENT: ${content || ""}`,
  ].join("\n");

  const { modelUsed, json } = await openaiResponsesJSON({ inputText });

  const out = {
    isMigrationRelated: Boolean(json?.isMigrationRelated),
    confidence: clamp01(json?.confidence),
    category: normalizeCategory(json?.category),
    titleEs: clean(json?.titleEs),
    summaryEs: clean(json?.summaryEs),
    tagsEs: normalizeTags(json?.tagsEs),
    reason: clean(json?.reason || ""),
    aiModel: modelUsed,
  };

  // defaults razonables
  if (!out.titleEs) out.titleEs = clean(title);
  if (!out.summaryEs) out.summaryEs = clean(description);

  return out;
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

    const NEWS_API_KEY = process.env.NEWSAPI_KEY;
    if (!NEWS_API_KEY) throw new Error("Falta NEWSAPI_KEY en .env");

    // -------------------------
    // CONFIG
    // -------------------------
    const DEFAULT_QUERY = `(
      immigrant OR immigrants OR immigration OR migrant OR migrants OR asylum OR refugees OR deportation OR visa
    ) AND (
      "United States" OR "U.S." OR USA OR border OR ICE OR DHS OR CBP
    )`;

    const QUERY = clean(req.query.q) || DEFAULT_QUERY;

    const DAYS = Math.min(Math.max(Number(req.query.days || 3), 1), 7);
    const LIMIT = Math.min(Math.max(Number(req.query.limit || 30), 1), 50);

    // Control costos IA
    const MAX_AI = Math.min(Math.max(Number(req.query.maxAi || 12), 1), 20);

    // Lock diario por defecto ON
    const DAILY_LOCK = (req.query.lock ?? "1").toString() !== "0";

    // Umbral IA
    const MIN_CONF = Math.min(Math.max(Number(req.query.minConf || 0.6), 0), 1);

    // -------------------------
    // DAILY LOCK
    // -------------------------
    const metaRef = db.collection("news_meta").doc("us_immigration");
    const metaSnap = await metaRef.get();
    const today = new Date().toISOString().slice(0, 10);
    const lastRun = metaSnap.exists ? metaSnap.data()?.lastRun : null;

    if (DAILY_LOCK && lastRun === today) {
      return res.json({
        ok: true,
        skipped: true,
        message: "Ya actualizado hoy (ahorrando requests)",
      });
    }

    // -------------------------
    // NEWS API CALL
    // -------------------------
    const from = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

    const newsUrl =
      `https://newsapi.org/v2/everything` +
      `?q=${encodeURIComponent(QUERY)}` +
      `&from=${encodeURIComponent(from)}` +
      `&sortBy=publishedAt` +
      `&language=en` +
      `&pageSize=${LIMIT}` +
      `&apiKey=${NEWS_API_KEY}`;

    const { signal, cancel } = withTimeout(20_000);
    let data;

    try {
      const response = await fetch(newsUrl, { signal });
      const txt = await response.text();

      if (!response.ok) {
        throw new Error(`NewsAPI HTTP ${response.status}: ${txt.slice(0, 400)}`);
      }

      try {
        data = JSON.parse(txt);
      } catch {
        throw new Error(`NewsAPI devolvió no-JSON: ${txt.slice(0, 200)}`);
      }
    } finally {
      cancel();
    }

    if (data?.status === "error") {
      throw new Error(`NewsAPI error: ${data?.message || "sin message"}`);
    }

    if (!Array.isArray(data?.articles)) {
      throw new Error(`Respuesta inválida de NewsAPI: sin articles[]`);
    }

    // -------------------------
    // PROCESS + SAVE
    // -------------------------
    const col = db.collection("news_us_immigration");

    // 1) Pre-filtro barato
    const preFiltered = data.articles.filter(
      (a) => a?.title && isValidUrl(a?.url) && quickKeywordPass(a)
    );

    // 2) candidates máximo 30 para dedupe con "in"
    const candidates = preFiltered.slice(0, 30);
    const urls = candidates.map((a) => a.url);

    const existingUrls = new Set();
    if (urls.length > 0) {
      const snap = await col.where("url", "in", urls).get();
      snap.forEach((d) => {
        const u = d.data()?.url;
        if (u) existingUrls.add(u);
      });
    }

    let aiUsed = 0;
    let saved = 0;
    let skipped = 0;
    let filteredOut = 0;
    let aiFailed = 0;
    let lastAiError = "";

    const batch = db.batch();

    for (const a of candidates) {
      const url = a?.url;

      if (!isValidUrl(url)) {
        filteredOut++;
        continue;
      }

      if (existingUrls.has(url)) {
        skipped++;
        continue;
      }

      if (aiUsed >= MAX_AI) {
        filteredOut++;
        continue;
      }

      let ai;
      try {
        aiUsed++;
        ai = await aiEnrichArticle({
          title: a.title,
          description: a.description,
          content: a.content,
          url,
        });
      } catch (e) {
        aiFailed++;
        lastAiError = e?.message || "ai error";
        continue;
      }

      // ✅ solo guardamos si realmente es migración + supera confianza
      if (!ai?.isMigrationRelated || (ai.confidence ?? 0) < MIN_CONF) {
        filteredOut++;
        continue;
      }

      const docId = makeDocIdFromUrl(url);
      const ref = col.doc(docId);

      batch.set(ref, {
        // ✅ Lo que quieres mostrar en tu app:
        image: pickImage(a),          // imagen
        titleEs: clean(ai.titleEs),   // título en español
        summaryEs: clean(ai.summaryEs), // resumen en español
        url,                          // url exacta

        // Original (por si lo necesitas)
        title: clean(a.title),
        description: clean(a.description),
        source: a?.source?.name || null,
        publishedAt: a.publishedAt
          ? admin.firestore.Timestamp.fromDate(new Date(a.publishedAt))
          : null,

        // IA metadata (opcional)
        category: ai.category,
        tagsEs: Array.isArray(ai.tagsEs) ? ai.tagsEs : [],
        confidence: ai.confidence,
        aiReason: clean(ai.reason),
        aiModel: ai.aiModel,

        // Metadata general
        country: "US",
        topic: "immigration",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      saved++;
    }

    if (saved > 0) await batch.commit();

    if (DAILY_LOCK) {
      await metaRef.set(
        {
          lastRun: today,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStats: {
            fetched: data.articles.length,
            preFiltered: preFiltered.length,
            candidates: candidates.length,
            aiUsed,
            saved,
            skipped,
            filteredOut,
            aiFailed,
            lastAiError: lastAiError || null,
          },
        },
        { merge: true }
      );
    }

    res.setHeader("Cache-Control", "s-maxage=600");

    return res.json({
      ok: true,
      fetched: data.articles.length,
      preFiltered: preFiltered.length,
      candidates: candidates.length,
      aiUsed,
      saved,
      skipped,
      filteredOut,
      aiFailed,
      lastAiError: lastAiError || null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Unknown error",
    });
  }
}