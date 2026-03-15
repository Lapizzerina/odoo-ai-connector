// index.js — odoo-ai-connector v3.3.1
// Piznalia / La Pizzerina / SmartChef24h
// Node 18+ (Render) — fetch nativo
//
// FLUJO PRINCIPAL:
//  1. Zadarma NOTIFY_END    → guarda extensión en cache
//  2. Zadarma NOTIFY_RECORD → espera 60s → busca audio en Odoo (ir.attachment)
//                           → Gemini analiza audio directamente (transcribe+clasifica)
//                           → si falla por tamaño → Whisper transcribe + Gemini analiza texto
//                           → crea lead/ticket/nota en Odoo
//
// COSTE: 0€ (Gemini gratis) + ~2€/mes solo si se activa fallback Whisper

const express = require("express");
const crypto  = require("crypto");
const app     = express();

const SERVICE_NAME = "odoo-ai-connector";
const VERSION      = "v3.5.7";

// ── CONFIG ──────────────────────────────────────────────────────────────────
const ODOO_BASE_URL           = (process.env.ODOO_BASE_URL || "").replace(/\/+$/, "");
const ODOO_DB                 = process.env.ODOO_DB || "";
const ODOO_USER_EMAIL         = process.env.ODOO_USER_EMAIL || "";
const ODOO_API_KEY            = process.env.ODOO_API_KEY || "";
const ODOO_APPOINTMENT_URL    = process.env.ODOO_APPOINTMENT_URL || "";
const ODOO_HELPDESK_TEAM_NAME = process.env.ODOO_HELPDESK_TEAM_NAME || "Atención al cliente";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // solo fallback Whisper

// ── CACHE (extensión por llamada) ────────────────────────────────────────────
const callCache = new Map();
const CALL_CACHE_TTL = 10 * 60 * 1000;

function cacheSet(pbxCallId, data) {
  callCache.set(pbxCallId, { ...data, ttl: Date.now() + CALL_CACHE_TTL });
}
function cacheGet(pbxCallId) {
  const e = callCache.get(pbxCallId);
  if (!e) return null;
  if (Date.now() > e.ttl) { callCache.delete(pbxCallId); return null; }
  return e;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of callCache.entries()) if (now > v.ttl) callCache.delete(k);
}, 5 * 60 * 1000);

// ── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  ok: true, service: SERVICE_NAME, version: VERSION,
  gemini:           !!GEMINI_API_KEY,
  whisper_fallback: !!OPENAI_API_KEY,
  odoo:             !!(ODOO_BASE_URL && ODOO_API_KEY),
}));

app.get("/", (req, res) => res.json({
  ok: true, service: SERVICE_NAME, version: VERSION,
  endpoints: {
    health:        "GET  /health",
    webhook:       "POST /webhooks/zadarma/notify_record",
    analyze:       "POST /lead/analyze",
    analyzeCreate: "POST /lead/analyze-and-create",
  },
}));

// ════════════════════════════════════════════════════════════════════════════
//  ODOO — helpers JSON-RPC
// ════════════════════════════════════════════════════════════════════════════
async function odooRpc(payload) {
  if (!ODOO_BASE_URL || !ODOO_DB || !ODOO_USER_EMAIL || !ODOO_API_KEY)
    throw new Error("Faltan variables de Odoo");
  const resp = await fetch(`${ODOO_BASE_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Odoo HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.error) {
    const msg = data.error?.data?.message || data.error?.message || JSON.stringify(data.error);
    throw new Error(`Odoo error: ${msg}`);
  }
  return data.result;
}

let cachedOdooUid = null;
async function odooAuth() {
  if (cachedOdooUid) return cachedOdooUid;
  const uid = await odooRpc({
    jsonrpc: "2.0", method: "call", id: 1,
    params: { service: "common", method: "authenticate",
              args: [ODOO_DB, ODOO_USER_EMAIL, ODOO_API_KEY, {}] },
  });
  if (!uid) throw new Error("Autenticación Odoo fallida");
  cachedOdooUid = uid;
  return uid;
}

async function odooExec(uid, model, method, args = [], kwargs = {}, id = 2) {
  return odooRpc({
    jsonrpc: "2.0", method: "call", id,
    params: { service: "object", method: "execute_kw",
              args: [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs] },
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  ODOO AUDIO — buscar y descargar audio subido por Zadarma
//  Zadarma sube el audio como ir.attachment en res.partner
//  Nombre: 539601-{call_id_with_rec}-{telefono}-{fecha}.ogg
// ════════════════════════════════════════════════════════════════════════════
async function getAudioFromOdoo(uid, callIdWithRec) {
  console.log("[Odoo Audio] Buscando adjunto:", callIdWithRec);

  const attachments = await odooExec(uid, "ir.attachment", "search_read",
    [[["name", "ilike", callIdWithRec]]],
    { fields: ["id", "name", "mimetype", "datas"], limit: 5 }, 90
  );

  if (!attachments || attachments.length === 0)
    throw new Error(`Adjunto no encontrado para: ${callIdWithRec}`);

  const att = attachments[0];
  console.log(`[Odoo Audio] Encontrado: id=${att.id} | ${att.name} | ${att.mimetype}`);

  let datas = att.datas;
  if (!datas) {
    const read = await odooExec(uid, "ir.attachment", "read",
      [[att.id]], { fields: ["datas"] }, 91);
    datas = read?.[0]?.datas;
  }

  if (!datas) throw new Error(`Sin contenido en adjunto id=${att.id}`);

  const buffer = Buffer.from(datas, "base64");
  const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);
  console.log(`[Odoo Audio] Listo: ${sizeMB}MB | ${att.mimetype}`);
  return { buffer, mimetype: att.mimetype || "audio/ogg" };
}

// ════════════════════════════════════════════════════════════════════════════
//  IA — Prompt y parser
// ════════════════════════════════════════════════════════════════════════════
function buildSystemPrompt() {
  return `
Eres el analizador de llamadas de Piznalia / La Pizzerina / SmartChef24h.
Devuelve SIEMPRE un único JSON válido, sin texto antes ni después, sin markdown.

Formato exacto:
{
  "tipo": "lead | ticket",
  "categoria": "venta_maquina | venta_pizza | operador_vending | averia | consulta_tecnica | info_general | otros",
  "interes": "Máquinas de pizzas y comida | Pizza sector Horeca | Ambos | Otros",
  "sector": "Pizzería o restauración | Operador vending | Inversor | Particular | Otros",
  "urgencia": "alta | media | baja",
  "resumen": "frase breve máximo 2 líneas de qué trató la llamada",
  "idioma": "es | ca | en | fr | pt",
  "accion": "agendar_visita | confirmar_cita | enviar_info | enviar_presupuesto | llamar_cliente | esperar_cliente | cerrar_ticket | ninguna",
  "accion_detalle": "descripción exacta de lo acordado, incluyendo fecha/hora si se mencionó",
  "sintoma": "descripción exacta del problema o avería que describe el cliente | null",
  "desde_cuando": "cuándo empezó el problema si lo menciona | null",
  "contacto": {
    "nombre": "nombre completo del cliente si lo menciona | null",
    "empresa": "nombre del local, bar, restaurante, pizzería o empresa si lo menciona | null",
    "email": "email si lo menciona | null",
    "direccion": "ciudad o dirección donde está la máquina si la menciona | null",
    "fecha_visita": "fecha y hora acordada si se agendó visita | null",
    "mac_digitos": "últimos dígitos del código MAC o número de máquina si los menciona | null"
  }
}

Reglas:
- tipo="ticket" SOLO si el cliente describe claramente una avería o fallo técnico
- tipo="lead" en cualquier otro caso
- accion: extrae SIEMPRE la acción acordada. Si se agendó visita → "agendar_visita"
- accion_detalle: sé específico. Ej: "Visita acordada para el martes 18 a las 10h en Barcelona"
- contacto: extrae SOLO lo que el cliente diga explícitamente, no inventes
- Para averías/soporte: extrae en contacto.direccion la ciudad o local donde está la máquina
- Si el cliente menciona números como "la 32", "la de Granollers", "los últimos dígitos XX" → ponlos en accion_detalle
- sintoma: describe con precisión qué falla según el cliente (ej: "no dispensa pizzas", "pantalla bloqueada", "no acepta pagos")
- desde_cuando: extrae cuándo empezó el problema (ej: "desde esta mañana", "desde ayer", "hace 2 días")
- RESPONDE SOLO CON JSON VÁLIDO
`.trim();
}


function parseGeminiJSON(rawText) {
  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  let parsed = tryParse(rawText);
  if (!parsed) {
    const i = rawText.indexOf("{"), j = rawText.lastIndexOf("}");
    if (i !== -1 && j > i) parsed = tryParse(rawText.slice(i, j + 1));
  }
  if (!parsed) throw new Error("JSON no parseable: " + rawText.slice(0, 200));
  return {
    tipo:           String(parsed.tipo      || "lead").toLowerCase(),
    categoria:      String(parsed.categoria || "otros").toLowerCase(),
    interes:        parsed.interes       || "Otros",
    sector:         parsed.sector        || "Otros",
    urgencia:       String(parsed.urgencia  || "media").toLowerCase(),
    resumen:        parsed.resumen       || "",
    idioma:         String(parsed.idioma    || "es").toLowerCase(),
    accion:         String(parsed.accion    || "ninguna").toLowerCase(),
    accion_detalle: parsed.accion_detalle || "",
    sintoma:        parsed.sintoma        || "",
    desde_cuando:   parsed.desde_cuando   || "",
    contacto: {
      ...(parsed.contacto || {}),
      mac_digitos: parsed.contacto?.mac_digitos || null,
    },
  };
}

async function geminiRequest(parts) {
  const model = "gemini-2.0-flash";
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const t0    = Date.now();
  const resp  = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }] }),
  });
  console.log(`[Gemini] HTTP ${resp.status} en ${((Date.now()-t0)/1000).toFixed(1)}s`);
  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0,300)}`);
  const data    = await resp.json();
  const rawText = (data?.candidates?.[0]?.content?.parts?.map(p => p.text||"").join("")||"").trim();
  if (!rawText) throw new Error("Gemini devolvió contenido vacío");
  return rawText;
}

// ════════════════════════════════════════════════════════════════════════════
//  GEMINI AUDIO — transcribe + clasifica en una sola llamada (gratis)
// ════════════════════════════════════════════════════════════════════════════
async function analyzeAudioWithGemini(buffer, mimetype, callerPhone, extensionInfo) {
  const audioBase64  = Buffer.from(buffer).toString("base64");
  const audioSizeMB  = (buffer.byteLength / 1024 / 1024).toFixed(2);
  const base64SizeMB = (audioBase64.length / 1024 / 1024).toFixed(2);
  console.log(`[Gemini Audio] ${audioSizeMB}MB audio | ${base64SizeMB}MB base64`);

  // Límite de seguridad: 15MB base64 (límite real Gemini inline: 20MB)
  if (audioBase64.length > 15 * 1024 * 1024)
    throw new Error(`Audio demasiado grande (${base64SizeMB}MB > 15MB) → fallback Whisper`);

  const prompt = buildSystemPrompt() +
    `\n\n---\nEscucha esta llamada de Piznalia/SmartChef24h.\n` +
    `Teléfono: ${callerPhone||"?"} | Extensión: ${extensionInfo||"?"}\n` +
    `Transcribe el audio y devuelve el JSON de análisis.`;

  const rawText = await geminiRequest([
    { inline_data: { mime_type: mimetype || "audio/ogg", data: audioBase64 } },
    { text: prompt },
  ]);
  console.log("[Gemini Audio] Raw:", rawText.slice(0, 200));
  return parseGeminiJSON(rawText);
}

// ════════════════════════════════════════════════════════════════════════════
//  WHISPER — fallback si Gemini no puede con el audio
// ════════════════════════════════════════════════════════════════════════════
async function transcribeWithWhisper(buffer, mimetype) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY para fallback Whisper");
  console.log("[Whisper] Transcribiendo como fallback...");
  const ext      = (mimetype || "").includes("ogg") ? "recording.ogg" : "recording.mp3";
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimetype || "audio/ogg" }), ext);
  formData.append("model", "whisper-1");
  formData.append("language", "es");
  formData.append("response_format", "text");
  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: formData,
  });
  if (!resp.ok) throw new Error(`Whisper HTTP ${resp.status}: ${await resp.text()}`);
  const text = (await resp.text()).trim();
  console.log(`[Whisper] OK: ${text.length} chars`);
  return text;
}

// ════════════════════════════════════════════════════════════════════════════
//  GEMINI TEXTO — analizar transcripción ya hecha
// ════════════════════════════════════════════════════════════════════════════
// DeepSeek — análisis de texto (fallback a Gemini si no hay key)
// Muy barato (~0.001$/1K tokens) y sin rate limits agresivos
async function analyzeTextWithDeepSeek(transcript, callerPhone, extensionInfo) {
  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
  if (!DEEPSEEK_API_KEY) throw new Error("Falta DEEPSEEK_API_KEY");

  const prompt = buildSystemPrompt() + "\n\n---\n" +
    `Llamada de Piznalia/SmartChef24h.\n` +
    `Teléfono: ${callerPhone||"?"} | Extensión: ${extensionInfo||"?"}\n\n` +
    `TRANSCRIPCIÓN:\n${transcript}\n\nDevuelve el JSON.`;

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 500,
    }),
  });

  if (!resp.ok) throw new Error(`DeepSeek HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const rawText = data?.choices?.[0]?.message?.content || "";
  if (!rawText) throw new Error("DeepSeek devolvió contenido vacío");
  console.log("[DeepSeek] Respuesta:", rawText.slice(0, 200));
  return parseGeminiJSON(rawText);
}

// GPT-4o mini — análisis de texto (misma cuenta que Whisper, ~0.01€/mes)
async function analyzeTextWithGPT(transcript, callerPhone, extensionInfo) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

  const prompt = buildSystemPrompt() + "\n\n---\n" +
    `Llamada de Piznalia/SmartChef24h.\n` +
    `Teléfono: ${callerPhone||"?"} | Extensión: ${extensionInfo||"?"}\n\n` +
    `TRANSCRIPCIÓN:\n${transcript}\n\nDevuelve el JSON.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 500,
    }),
  });

  if (!resp.ok) throw new Error(`GPT HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const rawText = data?.choices?.[0]?.message?.content || "";
  if (!rawText) throw new Error("GPT devolvió contenido vacío");
  console.log("[GPT-4o mini] Respuesta:", rawText.slice(0, 200));
  return parseGeminiJSON(rawText);
}

// Analizar texto — usa GPT-4o mini (misma cuenta Whisper), fallback Gemini
async function analyzeText(transcript, callerPhone, extensionInfo) {
  if (OPENAI_API_KEY) {
    try {
      return await analyzeTextWithGPT(transcript, callerPhone, extensionInfo);
    } catch (e) {
      console.warn(`[GPT] Falló: ${e.message} → usando Gemini`);
    }
  }
  return await analyzeTextWithGemini(transcript, callerPhone, extensionInfo);
}

async function analyzeTextWithGemini(transcript, callerPhone, extensionInfo) {
  const prompt = buildSystemPrompt() +
    `\n\n---\nLlamada de Piznalia/SmartChef24h.\n` +
    `Teléfono: ${callerPhone||"?"} | Extensión: ${extensionInfo||"?"}\n\n` +
    `TRANSCRIPCIÓN:\n${transcript}\n\nDevuelve el JSON.`;
  const rawText = await geminiRequest([{ text: prompt }]);
  return parseGeminiJSON(rawText);
}

// ════════════════════════════════════════════════════════════════════════════
//  FLUJO COMPLETO DE ANÁLISIS
//  1º Gemini audio directo (gratis)
//  2º si falla → Whisper + Gemini texto (fallback, ~2€/mes)
// ════════════════════════════════════════════════════════════════════════════
async function analyzeCallFromOdoo(uid, callIdWithRec, callerPhone, extensionInfo) {
  console.log("[Audio] Esperando 60s para que Zadarma suba el audio a Odoo...");
  await new Promise(r => setTimeout(r, 60000));

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { buffer, mimetype } = await getAudioFromOdoo(uid, callIdWithRec);

      // Intentar Gemini con audio directo
      try {
        const ai = await analyzeAudioWithGemini(buffer, mimetype, callerPhone, extensionInfo);
        console.log(`[IA] Gemini audio OK: tipo=${ai.tipo} | ${ai.resumen}`);
        return ai;
      } catch (geminiErr) {
        console.warn(`[Gemini Audio] Falló: ${geminiErr.message}`);
      }

      // Fallback Whisper → Gemini texto
      if (OPENAI_API_KEY) {
        console.log("[Audio] Intentando fallback Whisper...");
        const transcript = await transcribeWithWhisper(buffer, mimetype);
        const ai = await analyzeText(transcript, callerPhone, extensionInfo);
        console.log(`[IA] Whisper+GPT OK: tipo=${ai.tipo} | ${ai.resumen}`);
        return ai;
      }

      throw new Error("Gemini audio falló y no hay OPENAI_API_KEY para fallback");

    } catch (e) {
      lastError = e;
      console.warn(`[Audio] Intento ${attempt}/4: ${e.message}`);
      if (attempt < 4) {
        const wait = attempt * 20000;
        console.log(`[Audio] Esperando ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastError;
}

// ════════════════════════════════════════════════════════════════════════════
//  ODOO CRM — contactos, máquinas, leads, tickets, notas
// ════════════════════════════════════════════════════════════════════════════
async function findOrCreatePartner(uid, { name, phone, email }) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-9);
  if (digits) {
    const ids = await odooExec(uid, "res.partner", "search",
      [[["phone", "ilike", digits]]], { limit: 1 }, 10);
    if (ids?.[0]) {
      console.log(`[Odoo] Contacto existente: #${ids[0]}`);
      return { partnerId: ids[0], isNew: false };
    }
  }
  const partnerName = (name && name.trim().length > 2 && name.toLowerCase() !== "llamada")
    ? name.trim() : (phone ? `Tel. ${phone}` : "Contacto sin nombre");
  const newId = await odooExec(uid, "res.partner", "create", [[{
    name: partnerName, phone: phone || undefined, email: email || undefined,
  }]], {}, 11);
  console.log(`[Odoo] Contacto nuevo: #${newId} — ${partnerName}`);
  return { partnerId: newId, isNew: true };
}

async function findMachinesByPartner(uid, partnerId) {
  try {
    const recs = await odooExec(uid, "x_maquina_operador", "search_read",
      [[["x_cliente", "=", partnerId]]],
      { fields: ["id", "x_name", "x_studio_x_machine_uid", "x_estado", "x_ubicacion", "x_site", "x_mac_code"], limit: 10 }, 20);
    return Array.isArray(recs) ? recs : [];
  } catch (e) {
    console.warn("[machines] Error:", e.message);
    return [];
  }
}

// Búsqueda avanzada de máquinas cuando el cliente no está vinculado
// Busca por ubicación, últimos dígitos MAC, nombre del local
async function findMachinesByHints(uid, ai) {
  const hints = [];
  const c = ai.contacto || {};

  // Extraer pistas de la conversación
  const textoCompleto = [
    ai.resumen, ai.accion_detalle,
    c.empresa, c.direccion, c.nombre,
  ].filter(Boolean).join(" ").toLowerCase();

  // Buscar últimos dígitos numéricos mencionados (ej: "la 32", "máquina 4")
  const digitMatches = textoCompleto.match(/(\d{1,4})/g) || [];
  // Si la IA detectó dígitos MAC explícitos, priorizarlos
  if (ai.contacto?.mac_digitos) {
    const macD = String(ai.contacto.mac_digitos).replace(/[^0-9]/g, "");
    if (macD && !digitMatches.includes(macD)) digitMatches.unshift(macD);
  }
  const ubicacion = c.direccion || c.empresa || "";

  if (!ubicacion && digitMatches.length === 0) return [];

  const domain = [];

  // Buscar por nombre del local (lo más fácil de recordar para el cliente)
  if (c.empresa) {
    domain.push("|");
    domain.push(["x_name", "ilike", c.empresa]);
    domain.push(["x_name", "ilike", c.empresa]);
  }

  // Buscar por ubicación/ciudad
  if (ubicacion) {
    domain.push("|");
    domain.push(["x_ubicacion", "ilike", ubicacion]);
    domain.push(["x_site",      "ilike", ubicacion]);
  }

  // Buscar por nombre del cliente si lo menciona
  if (c.nombre) {
    domain.push("|");
    domain.push(["x_name", "ilike", c.nombre]);
    domain.push(["x_notas", "ilike", c.nombre]);
  }

  // Buscar por últimos dígitos del MAC o UID
  for (const digits of digitMatches.slice(0, 3)) {
    if (parseInt(digits) > 0) {
      domain.push("|");
      domain.push(["x_mac_code",              "ilike", digits]);
      domain.push(["x_studio_x_machine_uid",  "ilike", digits]);
    }
  }

  if (domain.length === 0) return [];

  try {
    const recs = await odooExec(uid, "x_maquina_operador", "search_read",
      [domain],
      { fields: ["id", "x_name", "x_studio_x_machine_uid", "x_estado", "x_ubicacion", "x_site", "x_mac_code", "x_cliente"], limit: 5 }, 22);
    const results = Array.isArray(recs) ? recs : [];
    if (results.length > 0) {
      console.log(`[machines] ${results.length} máquinas encontradas por pistas:`, results.map(m => m.x_name).join(", "));
    }
    return results;
  } catch (e) {
    console.warn("[machines] Búsqueda por pistas fallida:", e.message);
    return [];
  }
}

let cachedHelpdeskTeamId = null;
async function getHelpdeskTeamId(uid) {
  if (cachedHelpdeskTeamId) return cachedHelpdeskTeamId;
  const teams = await odooExec(uid, "helpdesk.team", "search_read",
    [[["name", "ilike", ODOO_HELPDESK_TEAM_NAME]]], { fields: ["id"], limit: 1 }, 12);
  cachedHelpdeskTeamId = teams?.[0]?.id || null;
  return cachedHelpdeskTeamId;
}

function urgencyToPriority(u) {
  if (u === "alta") return "3"; if (u === "media") return "2"; return "1";
}

function buildLeadName(ai, callerName, callerPhone) {
  const quien = callerName || callerPhone || "Desconocido";
  const temas = {
    venta_maquina: "Comercial - Maquina pizza", venta_pizza: "Comercial - Pizzas",
    operador_vending: "Comercial - Operador vending", averia: "SAT - Averia",
    consulta_tecnica: "SAT - Consulta tecnica", info_general: "Info general", otros: "Otros",
  };
  return `LLAMADA | ${quien} | ${temas[ai.categoria] || "Otros"}`;
}

function buildTicketName(ai, callerName, callerPhone) {
  return `[SAT LLAMADA] ${callerName||callerPhone||"Desconocido"} - ${(ai.resumen||"Incidencia").slice(0,60)}`;
}

async function postNoteToPartner(uid, partnerId, ai, callerPhone, extensionInfo, callId) {
  const catMap = {
    venta_maquina: "Venta máquina", venta_pizza: "Venta pizzas",
    operador_vending: "Operador vending", averia: "Avería",
    consulta_tecnica: "Consulta técnica", info_general: "Info general", otros: "Otros",
  };
  const urgMap = { alta: "🔴 Alta", media: "🟡 Media", baja: "🟢 Baja" };
  const accionMap = {
    agendar_visita: "📅 Agendar visita", confirmar_cita: "✅ Confirmar cita",
    enviar_info: "📧 Enviar información", enviar_presupuesto: "💶 Enviar presupuesto",
    llamar_cliente: "📞 Llamar al cliente", esperar_cliente: "⏳ Esperar al cliente",
    cerrar_ticket: "🔒 Cerrar ticket", ninguna: "—",
  };
  const c = ai.contacto || {};
  const contactoLines = [
    c.nombre     ? `<strong>Nombre:</strong> ${c.nombre}` : "",
    c.empresa    ? `<strong>Empresa:</strong> ${c.empresa}` : "",
    c.email      ? `<strong>Email:</strong> ${c.email}` : "",
    c.direccion  ? `<strong>Dirección:</strong> ${c.direccion}` : "",
    c.fecha_visita ? `<strong>📅 Fecha visita:</strong> ${c.fecha_visita}` : "",
    c.mac_digitos  ? `<strong>🔢 Dígitos máquina:</strong> ${c.mac_digitos}` : "",
  ].filter(Boolean).join("<br/>");

  const calLink = ODOO_APPOINTMENT_URL
    ? `<br/><a href="${ODOO_APPOINTMENT_URL}" target="_blank">📅 Abrir calendario para agendar</a>` : "";

  const accionHtml = (ai.accion && ai.accion !== "ninguna")
    ? `<p style="background:#fff3cd;padding:8px;border-radius:4px;margin:4px 0;">
       <strong>⚡ Acción requerida:</strong> ${accionMap[ai.accion]||ai.accion}<br/>
       ${ai.accion_detalle ? `<em>${ai.accion_detalle}</em>` : ""}
       ${ai.accion === "agendar_visita" ? calLink : ""}
       </p>` : "";

  const now = new Date();
  const horaLlamada = now.toLocaleString("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  const body = `
<p><strong>📞 Llamada recibida</strong> &nbsp; <em>${horaLlamada}</em><br/>
<strong>Tel:</strong> ${callerPhone||"?"} &nbsp; <strong>Ext:</strong> ${extensionInfo||"?"}</p>
<p><strong>🤖 Resumen:</strong> ${ai.resumen||""}</p>
${accionHtml}
${contactoLines ? `<p><strong>👤 Datos:</strong><br/>${contactoLines}</p>` : ""}
<p><strong>Categoría:</strong> ${catMap[ai.categoria]||ai.categoria} &nbsp; <strong>Urgencia:</strong> ${urgMap[ai.urgencia]||ai.urgencia}</p>
`.trim();

  try {
    await odooExec(uid, "res.partner", "message_post", [[partnerId]], {
      body:            body,
      message_type:  "comment",
      subtype_xmlid: "mail.mt_note",
    }, 55);
    console.log(`[Odoo] Nota en contacto #${partnerId}`);
  } catch (e) { console.warn("[Odoo] Nota fallida:", e.message); }
}

async function createLead(uid, ai, callerPhone, callerName, partnerId, extensionInfo, callId) {
  const citaUrl = ODOO_APPOINTMENT_URL;
  let respuesta = `Hola${callerName ? " " + callerName : ""},\n\nGracias por contactar con Piznalia / La Pizzerina.\n\n`;
  if (["venta_maquina","operador_vending"].includes(ai.categoria)) {
    respuesta += "Hemos recibido tu consulta sobre nuestras máquinas SmartChef24h. Te enviaremos información adaptada.\n";
    if (citaUrl) respuesta += `\nAgenda una llamada: ${citaUrl}\n`;
  } else if (ai.categoria === "venta_pizza") {
    respuesta += "Hemos recibido tu interés por nuestras pizzas. Te enviaremos catálogo y condiciones.\n";
  } else {
    respuesta += "Hemos recibido tu consulta y te responderemos a la mayor brevedad.\n";
  }
  respuesta += "\nUn saludo,\nEquipo Piznalia / La Pizzerina";

  const catMap = {
    venta_maquina: "Venta máquina", venta_pizza: "Venta pizzas",
    operador_vending: "Operador vending", averia: "Avería",
    consulta_tecnica: "Consulta técnica", info_general: "Info general", otros: "Otros",
  };
  const urgMap = { alta: "🔴 Alta", media: "🟡 Media", baja: "🟢 Baja" };

  const accionMap2 = {
    agendar_visita: "📅 Agendar visita", confirmar_cita: "✅ Confirmar cita",
    enviar_info: "📧 Enviar información", enviar_presupuesto: "💶 Enviar presupuesto",
    llamar_cliente: "📞 Llamar al cliente", esperar_cliente: "⏳ Esperar al cliente",
    cerrar_ticket: "🔒 Cerrar ticket", ninguna: "—",
  };
  const c2 = ai.contacto || {};
  const contactoLines2 = [
    c2.nombre    ? `<strong>Nombre:</strong> ${c2.nombre}` : "",
    c2.empresa   ? `<strong>Empresa:</strong> ${c2.empresa}` : "",
    c2.email     ? `<strong>Email:</strong> ${c2.email}` : "",
    c2.direccion ? `<strong>Dirección:</strong> ${c2.direccion}` : "",
    c2.fecha_visita ? `<strong>📅 Fecha visita:</strong> ${c2.fecha_visita}` : "",
  ].filter(Boolean).join("<br/>");

  const nowL = new Date();
  const horaLead = nowL.toLocaleString("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
  const description = `
<p><strong>📞 Llamada recibida</strong> &nbsp; <em>${horaLead}</em><br/>
<strong>Teléfono:</strong> ${callerPhone||"?"} &nbsp; <strong>Extensión:</strong> ${extensionInfo||"?"}</p>
<p><strong>🤖 Resumen:</strong> ${ai.resumen||""}</p>
${ai.accion && ai.accion !== "ninguna" ? `<p style="background:#fff3cd;padding:8px;border-radius:4px;"><strong>⚡ Acción requerida:</strong> ${accionMap2[ai.accion]||ai.accion}<br/>${ai.accion_detalle ? `<em>${ai.accion_detalle}</em>` : ""}</p>` : ""}
${contactoLines2 ? `<p><strong>👤 Datos del cliente:</strong><br/>${contactoLines2}</p>` : ""}
<p><strong>Categoría:</strong> ${catMap[ai.categoria]||ai.categoria} &nbsp; <strong>Urgencia:</strong> ${urgMap[ai.urgencia]||ai.urgencia} &nbsp; <strong>Sector:</strong> ${ai.sector||"?"}</p>
`.trim();

  const vals = {
    name:           buildLeadName(ai, callerName, callerPhone),
    type:           "lead",
    phone:          callerPhone || undefined,
    contact_name:   callerName  || undefined,
    partner_id:     partnerId   || undefined,
    description,
    priority:       urgencyToPriority(ai.urgencia),
    x_Interes:      ai.interes  || "Otros",
    x_Sector:       ai.sector   || "Otros",
    x_resumen_ia:   ai.resumen  || "",
    x_respuesta_ia: respuesta,
    x_estado_ia:    "procesado",
  };
  const leadId = await odooExec(uid, "crm.lead", "create", [[vals]], {}, 50);
  console.log(`[Odoo] Lead #${leadId}: ${vals.name}`);
  return leadId;
}

async function createTicket(uid, ai, callerPhone, callerName, partnerId, machines, extensionInfo, callId) {
  const teamId        = await getHelpdeskTeamId(uid);
  const machineUnique = machines.length === 1 ? machines[0] : null;
  const machinesTxt   = machines.length
    ? machines.map(m => `- ${m.x_name||"?"} (ID: ${m.x_studio_x_machine_uid||m.id}, Estado: ${m.x_estado||"?"}, Ub: ${m.x_ubicacion||"?"})`).join("\n")
    : "- Sin máquinas registradas";

  const urgMap  = { alta: "🔴 Alta", media: "🟡 Media", baja: "🟢 Baja" };
  const c = ai.contacto || {};
  const nowT = new Date();
  const horaTicket = nowT.toLocaleString("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  const description = `
<p><strong>📞 Llamada SAT recibida</strong> &nbsp; <em>${horaTicket}</em><br/>
<strong>Teléfono:</strong> ${callerPhone||"?"} &nbsp; <strong>Extensión:</strong> ${extensionInfo||"?"}</p>

<p><strong>🤖 Resumen:</strong> ${ai.resumen||""}</p>

${ai.sintoma ? `<p style="background:#ffe0e0;padding:8px;border-radius:4px;">
<strong>🔧 Síntoma / Avería:</strong><br/>
${ai.sintoma}
${ai.desde_cuando ? `<br/><strong>Desde cuándo:</strong> ${ai.desde_cuando}` : ""}
</p>` : ""}

${ai.accion && ai.accion !== "ninguna" ? `<p style="background:#fff3cd;padding:8px;border-radius:4px;">
<strong>⚡ Acción requerida:</strong> ${ai.accion_detalle||ai.accion}
</p>` : ""}

<p><strong>🔧 Máquinas del cliente:</strong><br/>
${machinesTxt.replace(/\n/g, "<br/>")}</p>

${c.mac_digitos ? `<p><strong>🔢 Dígitos máquina mencionados:</strong> ${c.mac_digitos}</p>` : ""}

<p><strong>Urgencia:</strong> ${urgMap[ai.urgencia]||ai.urgencia}</p>
`.trim();

  const vals = {
    name:          buildTicketName(ai, callerName, callerPhone),
    partner_id:    partnerId   || undefined,
    partner_phone: callerPhone || undefined,
    partner_name:  callerName  || undefined,
    description,
    priority:      urgencyToPriority(ai.urgencia),
    team_id:       teamId      || undefined,
    user_id:       uid,
  };
  if (machineUnique) vals.x_studio_x_maquina_id = machineUnique.id;

  const ticketId = await odooExec(uid, "helpdesk.ticket", "create", [[vals]], {}, 60);
  console.log(`[Odoo] Ticket #${ticketId}${machineUnique ? ` — ${machineUnique.x_name}` : ""}`);
  return ticketId;
}

// ════════════════════════════════════════════════════════════════════════════
//  LÓGICA PRINCIPAL — decide qué crear en Odoo
// ════════════════════════════════════════════════════════════════════════════
async function processCallWithAI({ ai, callerPhone, callerName, extensionInfo, callId }) {
  const uid = await odooAuth();
  console.log(`[IA] tipo=${ai.tipo} | cat=${ai.categoria} | urg=${ai.urgencia} | ${ai.resumen}`);

  const { partnerId, isNew } = await findOrCreatePartner(uid, {
    name: callerName, phone: callerPhone, email: null,
  });

  // Crear cita en Calendar si se acordó visita
  if (ai.accion === "agendar_visita" && ai.contacto?.fecha_visita) {
    const event = await createCalendarEvent(uid, ai, partnerId, callerName);
    if (event) {
      console.log(`[Calendar] Cita creada #${event.eventId} para ${event.start}`);
    }
  }

  // Actualizar contacto con datos que la IA haya extraído de la llamada
  if (partnerId && ai.contacto) {
    const c = ai.contacto;
    const updates = {};
    if (c.nombre && c.nombre !== "null" && isNew) updates.name = c.nombre;
    if (c.email  && c.email  !== "null") updates.email = c.email;
    if (c.empresa && c.empresa !== "null") updates.company_name = c.empresa;
    if (Object.keys(updates).length > 0) {
      try {
        await odooExec(uid, "res.partner", "write", [[partnerId], updates], {}, 56);
        console.log(`[Odoo] Contacto #${partnerId} actualizado:`, Object.keys(updates).join(", "));
      } catch (e) { console.warn("[Odoo] Update contacto fallido:", e.message); }
    }
  }

  if (ai.tipo === "ticket") {
    // Buscar máquinas: primero por cliente, luego por pistas (ubicación, dígitos MAC)
    let machines = partnerId ? await findMachinesByPartner(uid, partnerId) : [];
    if (machines.length === 0) {
      console.log("[machines] Sin máquinas por cliente, buscando por pistas...");
      machines = await findMachinesByHints(uid, ai);
    }
    if (machines.length > 0) {
      const ticketId = await createTicket(uid, ai, callerPhone, callerName, partnerId, machines, extensionInfo, callId);
      await postNoteToPartner(uid, partnerId, ai, callerPhone, extensionInfo, callId);
      return { created: "ticket", id: ticketId, ai };
    }
    console.log("[Lógica] Avería sin máquina → Lead");
    ai.resumen = `[Sin máquina registrada] ${ai.resumen}`.trim();
    if (!isNew) await postNoteToPartner(uid, partnerId, ai, callerPhone, extensionInfo, callId);
    const leadId = await createLead(uid, ai, callerPhone, callerName, partnerId, extensionInfo, callId);
    return { created: "lead", id: leadId, ai, note: "sin_maquina" };
  }

  if (!isNew && partnerId) {
    await postNoteToPartner(uid, partnerId, ai, callerPhone, extensionInfo, callId);
    return { created: "note", id: partnerId, ai };
  }

  const leadId = await createLead(uid, ai, callerPhone, callerName, partnerId, extensionInfo, callId);
  return { created: "lead", id: leadId, ai };
}

// ════════════════════════════════════════════════════════════════════════════
//  WEBHOOK ZADARMA
// ════════════════════════════════════════════════════════════════════════════
app.get("/webhooks/zadarma/notify_record", (req, res) => {
  const echo = req.query.zd_echo;
  if (echo !== undefined) {
    console.log("[Zadarma] zd_echo:", echo);
    res.setHeader("Content-Type", "text/plain");
    return res.send(String(echo));
  }
  return res.json({ ok: true, service: SERVICE_NAME, version: VERSION });
});

app.post("/webhooks/zadarma/notify_record", async (req, res) => {
  const body = req.body || {};

  if (req.query.zd_echo !== undefined) {
    res.setHeader("Content-Type", "text/plain");
    return res.send(String(req.query.zd_echo));
  }

  const event     = String(body.event || "").toUpperCase();
  const pbxCallId = body.pbx_call_id || null;
  console.log(`[Zadarma] ${event} | pbx: ${pbxCallId || "?"}`);

  if (event === "NOTIFY_END") {
    if (pbxCallId) {
      cacheSet(pbxCallId, {
        internal:    body.internal    || body.last_internal || null,
        caller_id:   body.caller_id   || null,
        caller_name: body.caller_name || null,
      });
      console.log(`[Cache] Guardado: pbx=${pbxCallId} ext=${body.internal||"?"}`);
    }
    return res.json({ ok: true, event: "NOTIFY_END" });
  }

  if (event !== "NOTIFY_RECORD")
    return res.json({ ok: true, skipped: true, event });

  const callIdWithRec = body.call_id_with_rec || body.call_id || null;
  if (!callIdWithRec)
    return res.status(400).json({ ok: false, error: "missing_call_id_with_rec" });

  res.json({ ok: true, service: SERVICE_NAME, received: callIdWithRec });

  const cached      = pbxCallId ? cacheGet(pbxCallId) : null;
  const callerPhone = body.caller_id   || cached?.caller_id   || null;
  const callerName  = body.caller_name || cached?.caller_name || null;
  const internal    = body.internal    || cached?.internal    || null;
  const extInfo     = internal ? `ext. ${internal}` : "desconocida";

  setImmediate(async () => {
    try {
      const uid    = await odooAuth();
      const ai     = await analyzeCallFromOdoo(uid, callIdWithRec, callerPhone, extInfo);
      const result = await processCallWithAI({ ai, callerPhone, callerName, extensionInfo: extInfo, callId: callIdWithRec });
      console.log(`[OK] ${result.created} #${result.id} | ${result.ai.resumen}`);
    } catch (err) {
      console.error("[ERROR]", err.message);
      try {
        const uid        = await odooAuth();
        const partnerRes = callerPhone
          ? await findOrCreatePartner(uid, { name: callerName, phone: callerPhone, email: null })
          : null;
        const aiFallback = {
          tipo: "lead", categoria: "otros", interes: "Otros", sector: "Otros",
          urgencia: "media", idioma: "es",
          resumen: `Llamada no procesada (error: ${err.message.slice(0, 80)})`,
        };
        // Si el contacto ya existe → solo nota, sin lead nuevo
        if (partnerRes && !partnerRes.isNew) {
          await postNoteToPartner(uid, partnerRes.partnerId, aiFallback, callerPhone, extInfo, callIdWithRec);
          console.log(`[Fallback] Nota en contacto existente #${partnerRes.partnerId}`);
        } else {
          const leadId = await createLead(uid, aiFallback, callerPhone, callerName, partnerRes?.partnerId || null, extInfo, callIdWithRec);
          console.log(`[Fallback] Lead nuevo #${leadId}`);
        }
      } catch (e2) { console.error("[Fallback] Falló:", e2.message); }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  ENDPOINT TEST — verificar que HTML renderiza en Odoo
// ════════════════════════════════════════════════════════════════════════════
app.post("/test/nota", async (req, res) => {
  const { partner_id } = req.body || {};
  if (!partner_id) return res.status(400).json({ ok: false, error: "Envía partner_id" });
  try {
    const uid  = await odooAuth();
    const body = `
<p><strong>📞 Llamada recibida</strong> &nbsp; <em>TEST ${new Date().toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}</em><br/>
<strong>Tel:</strong> +34600000000 &nbsp; <strong>Ext:</strong> ext. 200</p>
<p><strong>🤖 Resumen:</strong> Esta es una nota de prueba para verificar que el HTML renderiza correctamente.</p>
<p style="background:#fff3cd;padding:8px;border-radius:4px;">
<strong>⚡ Acción requerida:</strong> 📅 Agendar visita<br/>
<em>Visita acordada para el martes 18 a las 10h</em>
</p>
<p><strong>👤 Datos:</strong><br/>
<strong>Nombre:</strong> Juan García<br/>
<strong>Empresa:</strong> Pizzería Roma<br/>
<strong>Dirección:</strong> Granollers</p>
<p><strong>Categoría:</strong> Venta máquina &nbsp; <strong>Urgencia:</strong> 🟡 Media</p>
`.trim();
    await odooExec(uid, "res.partner", "message_post", [[parseInt(partner_id)]], {
      body, message_type: "comment", subtype_xmlid: "mail.mt_note",
    }, 55);
    return res.json({ ok: true, message: `Nota enviada al contacto #${partner_id}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ENDPOINTS MANUALES
// ════════════════════════════════════════════════════════════════════════════
app.post("/lead/analyze", async (req, res) => {
  const text = req.body?.text || req.body?.mensaje || req.body?.message || "";
  if (!text.trim()) return res.status(400).json({ ok: false, error: "missing_text" });
  try {
    const ai = await analyzeTextWithGemini(text, req.body?.phone || "", req.body?.extension || "");
    return res.json({ ok: true, service: SERVICE_NAME, ai });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/lead/analyze-and-create", async (req, res) => {
  const body = req.body || {};
  const text = body.text || body.mensaje || body.message || "";
  if (!text.trim()) return res.status(400).json({ ok: false, error: "missing_text" });
  try {
    const ai     = await analyzeTextWithGemini(text, body.phone || "", body.extension || "");
    const result = await processCallWithAI({
      ai,
      callerPhone:   body.phone   || body.caller_id || null,
      callerName:    body.name    || body.nombre    || null,
      extensionInfo: body.extension || "manual",
      callId:        body.call_id   || null,
    });
    return res.json({ ok: true, service: SERVICE_NAME, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ARRANQUE ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] ${VERSION} puerto ${PORT}`);
  console.log(`  Odoo:    ${ODOO_BASE_URL || "⚠ NO CONFIG"}`);
  console.log(`  Gemini:  ${GEMINI_API_KEY ? "✓ activo (principal)" : "⚠ NO CONFIG"}`);
  console.log(`  Whisper: ${OPENAI_API_KEY ? "✓ disponible (fallback)" : "— no configurado (opcional)"}`);
});
