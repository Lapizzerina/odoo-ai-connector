// index.js — odoo-ai-connector v3.0.0
// Piznalia / La Pizzerina / SmartChef24h
// Node 18+ (Render) — fetch nativo
//
// FLUJO:
//  1. Zadarma NOTIFY_END  → guarda internal (extensión) en memoria
//  2. Zadarma NOTIFY_RECORD → descarga audio, transcribe (Whisper),
//                             resume + clasifica (Gemini),
//                             crea lead o ticket en Odoo
//
// LÓGICA IA:
//  - IA decide si es "lead" o "ticket"
//  - ticket solo si cliente tiene máquina en x_maquina_operador
//  - si no tiene máquina → lead siempre
//  - extensión se guarda como dato informativo, no condiciona

const express = require("express");
const crypto  = require("crypto");
const app     = express();

const SERVICE_NAME = "odoo-ai-connector";
const VERSION      = "v3.0.2";

// ── CONFIG ──────────────────────────────────────────────────────────────────
const ODOO_BASE_URL          = (process.env.ODOO_BASE_URL || "").replace(/\/+$/, "");
const ODOO_DB                = process.env.ODOO_DB || "";
const ODOO_USER_EMAIL        = process.env.ODOO_USER_EMAIL || "";
const ODOO_API_KEY           = process.env.ODOO_API_KEY || "";
const ODOO_APPOINTMENT_URL   = process.env.ODOO_APPOINTMENT_URL || "";
const ODOO_HELPDESK_TEAM_NAME = process.env.ODOO_HELPDESK_TEAM_NAME || "Atención al cliente";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || "gemini-2.5-flash";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const ZADARMA_API_KEY    = process.env.ZADARMA_API_KEY    || "";
const ZADARMA_API_SECRET = process.env.ZADARMA_API_SECRET || "";

// ── CACHE ────────────────────────────────────────────────────────────────────
let cachedOdooUid             = null;
let cachedHelpdeskTeamId      = null;

// Guarda el internal (extensión) de NOTIFY_END para usarlo en NOTIFY_RECORD
// clave: pbx_call_id → valor: { internal, caller_id, ttl }
const callCache = new Map();
const CALL_CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function cacheSet(pbxCallId, data) {
  callCache.set(pbxCallId, { ...data, ttl: Date.now() + CALL_CACHE_TTL });
}
function cacheGet(pbxCallId) {
  const entry = callCache.get(pbxCallId);
  if (!entry) return null;
  if (Date.now() > entry.ttl) { callCache.delete(pbxCallId); return null; }
  return entry;
}
// Limpieza periódica del cache
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of callCache.entries()) {
    if (now > v.ttl) callCache.delete(k);
  }
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
  whisper: !!OPENAI_API_KEY, gemini: !!GEMINI_API_KEY,
  zadarma: !!(ZADARMA_API_KEY && ZADARMA_API_SECRET),
  odoo: !!(ODOO_BASE_URL && ODOO_API_KEY),
}));

app.get("/", (req, res) => res.json({
  ok: true, service: SERVICE_NAME, version: VERSION,
  endpoints: {
    health:         "GET  /health",
    notifyRecord:   "POST /webhooks/zadarma/notify_record  ← principal",
    analyzeOnly:    "POST /lead/analyze",
    analyzeCreate:  "POST /lead/analyze-and-create",
  },
}));

// ════════════════════════════════════════════════════════════════════════════
//  WHISPER — transcripción de audio
// ════════════════════════════════════════════════════════════════════════════
async function transcribeAudioUrl(audioUrl) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
  console.log("[Whisper] Descargando audio:", audioUrl);

  const audioResp = await fetch(audioUrl, { redirect: "follow" });
  if (!audioResp.ok) throw new Error(`No se pudo descargar audio (HTTP ${audioResp.status})`);

  const audioBuffer = await audioResp.arrayBuffer();
  console.log("[Whisper] Audio descargado:", audioBuffer.byteLength, "bytes");

  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), "recording.mp3");
  formData.append("model", "whisper-1");
  formData.append("language", "es");
  formData.append("response_format", "text");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Whisper HTTP ${resp.status}: ${err}`);
  }

  const text = (await resp.text()).trim();
  console.log("[Whisper] Transcripción OK, chars:", text.length);
  return text;
}

// ════════════════════════════════════════════════════════════════════════════
//  ZADARMA API — firma HMAC + obtener URL grabación
// ════════════════════════════════════════════════════════════════════════════
function zadarmaSign(method, params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const rfc1738    = s => encodeURIComponent(String(s)).replace(/%20/g, "+");
  const paramsStr  = sortedKeys.map(k => `${rfc1738(k)}=${rfc1738(params[k])}`).join("&");
  const md5str     = crypto.createHash("md5").update(paramsStr).digest("hex");
  const toSign     = method + paramsStr + md5str;
  return crypto.createHmac("sha1", secret).update(toSign).digest("base64");
}

async function getZadarmaRecordingUrl(callIdWithRec) {
  if (!ZADARMA_API_KEY || !ZADARMA_API_SECRET) throw new Error("Faltan claves Zadarma");

  const method = "/v1/pbx/record/request/";
  const params = { call_id_with_rec: String(callIdWithRec), lifetime: "180" };
  const sign   = zadarmaSign(method, params, ZADARMA_API_SECRET);

  const qs  = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const url = `https://api.zadarma.com${method}?${qs}`;

  console.log("[Zadarma API] GET", url);
  const resp = await fetch(url, {
    headers: { Authorization: `${ZADARMA_API_KEY}:${sign}`, Accept: "application/json" },
  });

  const raw = await resp.text();
  console.log("[Zadarma API] Status:", resp.status, "Body:", raw.slice(0, 300));

  if (!resp.ok) throw new Error(`Zadarma HTTP ${resp.status}: ${raw}`);

  const data = JSON.parse(raw);
  const link = data.link || (Array.isArray(data.links) && data.links[0]) || null;
  if (data.status !== "success" || !link) throw new Error(`Sin link: ${raw}`);

  return link;
}

// ════════════════════════════════════════════════════════════════════════════
//  GEMINI — analizar llamada y decidir lead vs ticket
// ════════════════════════════════════════════════════════════════════════════
function buildSystemPrompt() {
  return `
Eres el analizador de llamadas de Piznalia / La Pizzerina / SmartChef24h.
Devuelve SIEMPRE un único JSON válido, sin texto antes ni después.

Formato:
{
  "tipo": "lead | ticket",
  "categoria": "venta_maquina | venta_pizza | operador_vending | averia | consulta_tecnica | info_general | otros",
  "interes": "Máquinas de pizzas y comida | Pizza sector Horeca | Ambos | Otros",
  "sector": "Pizzería o restauración | Operador vending | Inversor | Particular | Otros",
  "urgencia": "alta | media | baja",
  "resumen": "frase breve de máximo 2 líneas",
  "idioma": "es | ca | en | fr | pt"
}

Reglas:
- tipo="ticket" SOLO si el cliente describe claramente una avería o fallo técnico en una máquina
- tipo="lead" en cualquier otro caso (interés comercial, consulta general, información, etc.)
- Si el cliente no habla de avería → tipo="lead" siempre
- No inventes datos. Si no puedes determinar algo → pon el valor más genérico
- RESPONDE SOLO CON JSON VÁLIDO
`.trim();
}

async function callGemini(transcript, callerPhone, extensionInfo) {
  if (!GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");

  const userPrompt = `
Llamada telefónica recibida.
Teléfono: ${callerPhone || "desconocido"}
Extensión atendida: ${extensionInfo || "desconocida"}

TRANSCRIPCIÓN:
${transcript}

Devuelve el JSON de análisis.
`.trim();

  const modelId = encodeURIComponent(GEMINI_MODEL);
  const url     = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildSystemPrompt() + "\n\n---\n\n" + userPrompt }] }],
    }),
  });

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);

  const data    = await resp.json();
  const rawText = (data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "").trim();
  if (!rawText) throw new Error("Gemini devolvió contenido vacío");

  const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
  let parsed = tryParse(rawText);
  if (!parsed) {
    const i = rawText.indexOf("{"), j = rawText.lastIndexOf("}");
    if (i !== -1 && j > i) parsed = tryParse(rawText.slice(i, j + 1));
  }
  if (!parsed) throw new Error("No se pudo parsear JSON de Gemini: " + rawText.slice(0, 200));

  return {
    tipo:      String(parsed.tipo      || "lead").toLowerCase(),
    categoria: String(parsed.categoria || "otros").toLowerCase(),
    interes:   parsed.interes  || "Otros",
    sector:    parsed.sector   || "Otros",
    urgencia:  String(parsed.urgencia  || "media").toLowerCase(),
    resumen:   parsed.resumen  || "",
    idioma:    String(parsed.idioma    || "es").toLowerCase(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  ODOO — helpers
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

// Busca partner por teléfono (últimos 9 dígitos)
async function findOrCreatePartner(uid, { name, phone, email }) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-9);
  let partnerId = null;

  if (digits) {
    const ids = await odooExec(uid, "res.partner", "search",
      [["|", ["phone", "ilike", digits], ["mobile", "ilike", digits]]], { limit: 1 }, 10);
    partnerId = ids?.[0] || null;
  }

  if (!partnerId) {
    partnerId = await odooExec(uid, "res.partner", "create", [[{
      name:  name  || (phone ? `Contacto ${phone}` : "Contacto sin nombre"),
      phone: phone || undefined,
      email: email || undefined,
    }]], {}, 11);
  }

  return partnerId;
}

// Busca máquinas asociadas al partner
async function findMachinesByPartner(uid, partnerId) {
  try {
    const recs = await odooExec(uid, "x_maquina_operador", "search_read",
      [[["x_cliente", "=", partnerId]]],
      { fields: ["id", "x_name", "x_studio_x_machine_uid", "x_estado", "x_ubicacion"], limit: 10 }, 20);
    return Array.isArray(recs) ? recs : [];
  } catch (e) {
    console.warn("[machines] No se pudo leer x_maquina_operador:", e.message);
    return [];
  }
}

async function getHelpdeskTeamId(uid) {
  if (cachedHelpdeskTeamId) return cachedHelpdeskTeamId;
  const teams = await odooExec(uid, "helpdesk.team", "search_read",
    [[["name", "ilike", ODOO_HELPDESK_TEAM_NAME]]], { fields: ["id", "name"], limit: 1 }, 12);
  cachedHelpdeskTeamId = teams?.[0]?.id || null;
  return cachedHelpdeskTeamId;
}

function urgencyToPriority(urg) {
  if (urg === "alta")  return "3";
  if (urg === "media") return "2";
  return "1";
}

// ════════════════════════════════════════════════════════════════════════════
//  CREAR LEAD en crm.lead
//  Campos reales confirmados del PDF:
//    name, phone, email_from, partner_id, contact_name, description,
//    priority, type, tag_ids, partner_name, city,
//    x_Interes, x_Sector, x_resumen_ia, x_respuesta_ia, x_estado_ia
// ════════════════════════════════════════════════════════════════════════════
async function createLead(uid, ai, callerPhone, callerName, partnerId, extensionInfo, callId, transcript) {
  const citaUrl = ODOO_APPOINTMENT_URL;

  // Respuesta sugerida para mandar al cliente
  let respuesta = `Hola${callerName ? " " + callerName : ""},\n\nGracias por contactar con Piznalia / La Pizzerina.\n\n`;
  if (["venta_maquina", "operador_vending"].includes(ai.categoria)) {
    respuesta += "Hemos recibido tu consulta sobre nuestras máquinas SmartChef24h. Te enviaremos información adaptada a tu caso.\n";
    if (citaUrl) respuesta += `\nSi prefieres, agenda una llamada aquí: ${citaUrl}\n`;
  } else if (ai.categoria === "venta_pizza") {
    respuesta += "Hemos recibido tu interés por nuestras pizzas. Te enviaremos catálogo y condiciones.\n";
  } else {
    respuesta += "Hemos recibido tu consulta y te responderemos a la mayor brevedad.\n";
  }
  respuesta += "\nUn saludo,\nEquipo Piznalia / La Pizzerina";

  const description = [
    `📞 Llamada recibida`,
    `Teléfono: ${callerPhone || "desconocido"}`,
    `Extensión: ${extensionInfo || "desconocida"}`,
    callId ? `Call ID: ${callId}` : "",
    ``,
    `🤖 RESUMEN IA:`,
    ai.resumen || "",
    ``,
    `Categoría: ${ai.categoria}`,
    `Urgencia: ${ai.urgencia}`,
    `Idioma detectado: ${ai.idioma}`,
  ].filter(l => l !== null).join("\n").trim();

  const vals = {
    name:          ai.resumen || `Llamada entrante ${callerPhone || ""}`.trim(),
    type:          "lead",
    phone:         callerPhone || undefined,
    contact_name:  callerName  || undefined,
    partner_id:    partnerId   || undefined,
    description,
    priority:      urgencyToPriority(ai.urgencia),
    x_Interes:     ai.interes  || "Otros",
    x_Sector:      ai.sector   || "Otros",
    x_resumen_ia:  ai.resumen  || "",
    x_respuesta_ia: respuesta,
    x_estado_ia:   "procesado",
  };

  const leadId = await odooExec(uid, "crm.lead", "create", [[vals]], {}, 50);
  console.log(`[Odoo] Lead creado: #${leadId}`);
  return leadId;
}

// ════════════════════════════════════════════════════════════════════════════
//  CREAR TICKET en helpdesk.ticket
//  Campos reales confirmados del PDF:
//    name, partner_id, partner_phone, description, priority,
//    team_id, user_id, x_studio_x_maquina_id (campo personalizado máquina)
// ════════════════════════════════════════════════════════════════════════════
async function createTicket(uid, ai, callerPhone, callerName, partnerId, machines, extensionInfo, callId, transcript) {
  const teamId = await getHelpdeskTeamId(uid);

  // Si hay una sola máquina, la asignamos directamente
  const machineUnique = machines.length === 1 ? machines[0] : null;

  const machinesTxt = machines.length
    ? machines.map(m => `- ${m.x_name || "Sin nombre"} (ID: ${m.x_studio_x_machine_uid || m.id}, Estado: ${m.x_estado || "?"}, Ubicación: ${m.x_ubicacion || "?"})`).join("\n")
    : "- No se encontraron máquinas asociadas al contacto";

  const description = [
    `📞 Llamada SAT recibida`,
    `Teléfono: ${callerPhone || "desconocido"}`,
    `Extensión: ${extensionInfo || "desconocida"}`,
    callId ? `Call ID: ${callId}` : "",
    ``,
    `🤖 RESUMEN IA:`,
    ai.resumen || "",
    ``,
    `Categoría: ${ai.categoria}`,
    `Urgencia: ${ai.urgencia}`,
    ``,
    `🔧 MÁQUINAS DEL CLIENTE:`,
    machinesTxt,
  ].join("\n").trim();

  const vals = {
    name:          `[SAT] ${ai.resumen || "Incidencia " + (callerPhone || "")}`.trim(),
    partner_id:    partnerId || undefined,
    partner_phone: callerPhone || undefined,
    partner_name:  callerName  || undefined,
    description,
    priority:      urgencyToPriority(ai.urgencia),
    team_id:       teamId || undefined,
    user_id:       uid,
  };

  // Campo personalizado máquina (nombre real del PDF: x_studio_x_maquina_id)
  if (machineUnique) {
    vals.x_studio_x_maquina_id = machineUnique.id;
  }

  const ticketId = await odooExec(uid, "helpdesk.ticket", "create", [[vals]], {}, 60);
  console.log(`[Odoo] Ticket creado: #${ticketId}${machineUnique ? ` (máquina: ${machineUnique.x_name})` : ""}`);
  return ticketId;
}

// ════════════════════════════════════════════════════════════════════════════
//  LÓGICA PRINCIPAL — decide qué crear en Odoo
// ════════════════════════════════════════════════════════════════════════════
async function processCall({ transcript, callerPhone, callerName, extensionInfo, callId }) {
  const uid = await odooAuth();

  // 1. Analizar con Gemini
  const ai = await callGemini(transcript, callerPhone, extensionInfo);
  console.log(`[IA] tipo=${ai.tipo} categoria=${ai.categoria} urgencia=${ai.urgencia}`);
  console.log(`[IA] resumen: ${ai.resumen}`);

  // 2. Buscar/crear contacto
  const partnerId = await findOrCreatePartner(uid, {
    name:  callerName,
    phone: callerPhone,
    email: null,
  });

  // 3. Si la IA dice "ticket", verificar si tiene máquinas
  if (ai.tipo === "ticket") {
    const machines = partnerId ? await findMachinesByPartner(uid, partnerId) : [];

    if (machines.length > 0) {
      // Tiene máquinas → crear ticket SAT
      const ticketId = await createTicket(uid, ai, callerPhone, callerName, partnerId, machines, extensionInfo, callId, transcript);
      return { created: "ticket", id: ticketId, ai };
    } else {
      // IA dice ticket pero no tiene máquina → crear lead con nota
      console.log("[Lógica] IA detectó avería pero cliente sin máquina registrada → Lead");
      ai.resumen = `[Sin máquina registrada] ${ai.resumen}`.trim();
      const leadId = await createLead(uid, ai, callerPhone, callerName, partnerId, extensionInfo, callId, transcript);
      return { created: "lead", id: leadId, ai, note: "sin_maquina" };
    }
  }

  // 4. Cualquier otro caso → lead
  const leadId = await createLead(uid, ai, callerPhone, callerName, partnerId, extensionInfo, callId, transcript);
  return { created: "lead", id: leadId, ai };
}

// ════════════════════════════════════════════════════════════════════════════
//  WEBHOOK ZADARMA — GET (verificación zd_echo)
// ════════════════════════════════════════════════════════════════════════════
app.get("/webhooks/zadarma/notify_record", (req, res) => {
  const echo = req.query.zd_echo;
  if (echo !== undefined) {
    console.log("[Zadarma] Verificación zd_echo:", echo);
    res.setHeader("Content-Type", "text/plain");
    return res.send(String(echo));
  }
  return res.json({ ok: true, service: SERVICE_NAME, version: VERSION,
                    message: "Webhook Zadarma activo." });
});

// ════════════════════════════════════════════════════════════════════════════
//  WEBHOOK ZADARMA — POST (eventos)
// ════════════════════════════════════════════════════════════════════════════
app.post("/webhooks/zadarma/notify_record", async (req, res) => {
  const body = req.body || {};

  // Verificación zd_echo por POST (por si acaso)
  if (req.query.zd_echo !== undefined) {
    res.setHeader("Content-Type", "text/plain");
    return res.send(String(req.query.zd_echo));
  }

  const event = String(body.event || "").toUpperCase();
  console.log(`[Zadarma] Evento: ${event} | pbx_call_id: ${body.pbx_call_id || "?"}`);

  // ── NOTIFY_END: guardar extensión en cache ─────────────────────────────
  if (event === "NOTIFY_END") {
    const pbxCallId = body.pbx_call_id;
    if (pbxCallId) {
      cacheSet(pbxCallId, {
        internal:   body.internal    || body.last_internal || null,
        caller_id:  body.caller_id   || null,
        caller_name: body.caller_name || null,
      });
      console.log(`[Cache] NOTIFY_END guardado: pbx_call_id=${pbxCallId} internal=${body.internal || "?"}`);
    }
    return res.json({ ok: true, event: "NOTIFY_END", cached: !!pbxCallId });
  }

  // ── Ignorar eventos que no son NOTIFY_RECORD ───────────────────────────
  if (event !== "NOTIFY_RECORD") {
    return res.json({ ok: true, skipped: true, event });
  }

  // ── NOTIFY_RECORD: procesar grabación ─────────────────────────────────
  const callIdWithRec = body.call_id_with_rec || body.call_id || null;
  const pbxCallId     = body.pbx_call_id || null;

  if (!callIdWithRec) {
    console.warn("[Zadarma] NOTIFY_RECORD sin call_id_with_rec");
    return res.status(400).json({ ok: false, error: "missing_call_id_with_rec" });
  }

  // Responder inmediatamente a Zadarma
  res.json({ ok: true, service: SERVICE_NAME, received: callIdWithRec });

  // Recuperar datos de NOTIFY_END del cache
  const cached      = pbxCallId ? cacheGet(pbxCallId) : null;
  const callerPhone = body.caller_id   || cached?.caller_id   || null;
  const callerName  = body.caller_name || cached?.caller_name || null;
  const internal    = body.internal    || cached?.internal    || null;
  const extensionInfo = internal ? `ext. ${internal}` : "desconocida";

  // Procesamiento asíncrono
  setImmediate(async () => {
    try {
      // Zadarma recomienda esperar antes de pedir la grabación
      console.log("[Zadarma] Esperando 45s para que la grabación esté disponible...");
      await new Promise(r => setTimeout(r, 45000));

      // 1. Obtener URL del audio
      const audioUrl = await getZadarmaRecordingUrl(callIdWithRec);

      // 2. Transcribir con Whisper
      const transcript = await transcribeAudioUrl(audioUrl);
      if (!transcript || transcript.trim().length < 5) {
        console.warn("[Whisper] Transcripción vacía, descartando.");
        return;
      }

      // 3. Procesar y crear en Odoo
      const result = await processCall({
        transcript, callerPhone, callerName, extensionInfo,
        callId: callIdWithRec,
      });

      console.log(`[OK] Creado: ${result.created} #${result.id} | ${result.ai.resumen}`);
      if (result.note) console.log(`[Nota] ${result.note}`);

    } catch (err) {
      console.error("[ERROR] Procesamiento llamada:", err.message);
      // Fallback: crear lead básico para no perder la llamada
      try {
        const uid = await odooAuth();
        const partnerId = callerPhone
          ? await findOrCreatePartner(uid, { name: callerName, phone: callerPhone, email: null })
          : null;
        const aiFallback = {
          tipo: "lead", categoria: "otros", interes: "Otros", sector: "Otros",
          urgencia: "media", resumen: `Llamada no procesada (error: ${err.message.slice(0, 80)})`,
          idioma: "es",
        };
        const leadId = await createLead(uid, aiFallback, callerPhone, callerName, partnerId, extensionInfo, callIdWithRec, null);
        console.log(`[Fallback] Lead básico creado: #${leadId}`);
      } catch (e2) {
        console.error("[Fallback] También falló:", e2.message);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  ENDPOINT MANUAL — analizar texto sin crear en Odoo
// ════════════════════════════════════════════════════════════════════════════
app.post("/lead/analyze", async (req, res) => {
  const body = req.body || {};
  const text = body.text || body.mensaje || body.message || "";
  if (!text.trim()) return res.status(400).json({ ok: false, error: "missing_text" });

  try {
    const ai = await callGemini(text, body.phone || "", body.extension || "");
    return res.json({ ok: true, service: SERVICE_NAME, ai });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ENDPOINT MANUAL — analizar texto Y crear en Odoo
// ════════════════════════════════════════════════════════════════════════════
app.post("/lead/analyze-and-create", async (req, res) => {
  const body = req.body || {};
  const text = body.text || body.mensaje || body.message || "";
  if (!text.trim()) return res.status(400).json({ ok: false, error: "missing_text" });

  try {
    const result = await processCall({
      transcript:    text,
      callerPhone:   body.phone   || body.caller_id || null,
      callerName:    body.name    || body.nombre    || null,
      extensionInfo: body.extension || "manual",
      callId:        body.call_id || null,
    });
    return res.json({ ok: true, service: SERVICE_NAME, ...result });
  } catch (err) {
    console.error("[/lead/analyze-and-create]", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ARRANQUE ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] ${VERSION} escuchando en puerto ${PORT}`);
  console.log(`  Odoo:    ${ODOO_BASE_URL || "⚠ NO CONFIGURADO"}`);
  console.log(`  Gemini:  ${GEMINI_API_KEY ? "✓" : "⚠ NO CONFIGURADO"}`);
  console.log(`  Whisper: ${OPENAI_API_KEY ? "✓" : "⚠ NO CONFIGURADO"}`);
  console.log(`  Zadarma: ${ZADARMA_API_KEY ? "✓" : "⚠ NO CONFIGURADO"}`);
});
