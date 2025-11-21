// index.js — odoo-ai-connector + Gemini + Odoo + Zadarma (webhook llamadas)
// Node 18+ (Render) — usa fetch nativo

const express = require("express");

const app = express();

const SERVICE_NAME = "odoo-ai-connector";
const VERSION = "v1.6.0";

// ========= CONFIG ODOO =========
const ODOO_BASE_URL = process.env.ODOO_BASE_URL; // ej: https://piznalia1.odoo.com
const ODOO_DB = process.env.ODOO_DB;             // ej: piznalia1
const ODOO_USER_EMAIL = process.env.ODOO_USER_EMAIL;
const ODOO_API_KEY = process.env.ODOO_API_KEY;
const ODOO_APPOINTMENT_URL = process.env.ODOO_APPOINTMENT_URL || "";

// ========= CONFIG GEMINI =========
// Debes tener al menos GEMINI_API_KEY definida en Render.
// Opcionalmente puedes definir GEMINI_MODEL (por defecto gemini-1.5-flash).
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

// cache simple de uid Odoo
let cachedOdooUid = null;

// ⚙️ Config básica Express
app.use(
  express.json({
    limit: "1mb",
  })
);

// CORS básico
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// 🟢 Healthcheck simple
app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    message: "Usa GET /health o POST /lead/analyze",
  });
});

/* =====================================================================
 *  IA CON GEMINI — CONFIG PROMPTS
 * ===================================================================== */

function buildSystemPrompt() {
  return `
Eres un analizador automático de leads para la empresa Piznalia / La Pizzerina / SmartChef24h.
Tu tarea es analizar mensajes de clientes y devolver SIEMPRE un JSON válido (json) con este formato:

EJEMPLO DE JSON DESEADO:
{
  "intencion": "maquina",
  "idioma": "es",
  "pais": "España",
  "urgencia": "alta",
  "resumen": "Quiere información para comprar una máquina SmartChef24h para su bar en Sevilla",
  "pregunta": "¿Qué precio tiene la máquina y cuáles son las condiciones?",
  "datos_detectados": {
    "cantidad": "1 máquina",
    "ubicacion": "Sevilla",
    "plazo": "próximos meses"
  }
}

Las intenciones posibles son SOLO estas:
- "maquina" (interesado en máquina SmartChef24h u otras máquinas)
- "pizzas" (solo producto pizzas / alimentación)
- "ambos"
- "operador" (quiere operar o gestionar máquinas)
- "soporte" (duda técnica / incidencia)
- "info" (pregunta general)
- "otros"

Reglas:
- Devuelve SIEMPRE un único objeto JSON, sin texto antes ni después.
- Campos obligatorios:
  - "intencion": una de las opciones indicadas.
  - "idioma": "es", "ca", "en", "fr", "pt".
  - "pais": nombre normalizado; si no se sabe, "Desconocido".
  - "urgencia": "alta", "media" o "baja".
  - "resumen": frase breve con lo que quiere el cliente.
  - "pregunta": resumen de la duda o petición principal.
  - "datos_detectados": objeto con:
      "cantidad": texto breve (ej. "1 máquina", "varias máquinas", "no especifica");
      "ubicacion": ciudad / zona si se menciona (o "no especifica");
      "plazo": plazo aproximado si se menciona (o "no especifica").
- No inventes datos. Si no sabes algo, pon "no especifica" o "Desconocido".
- RESPONDE SIEMPRE SOLO CON JSON VÁLIDO.
`;
}

function buildUserPrompt(text, meta) {
  const origen = meta?.origen || meta?.source || "";
  const canal = meta?.canal || meta?.channel || "";
  const nombre = meta?.nombre || meta?.name || "";
  const email = meta?.email || "";

  let contexto = "Mensaje de un cliente.\n\n";
  if (origen) contexto += `Origen: ${origen}\n`;
  if (canal) contexto += `Canal: ${canal}\n`;
  if (nombre) contexto += `Nombre: ${nombre}\n`;
  if (email) contexto += `Email: ${email}\n`;

  contexto += `\nTEXTO DEL CLIENTE:\n${text}\n\n`;
  contexto +=
    "Devuelve SOLO el JSON siguiendo exactamente el formato indicado en el prompt del sistema.";

  return contexto;
}

/* =====================================================================
 *  LLAMADA A GEMINI v1 (REST) PARA OBTENER JSON
 * ===================================================================== */

async function callGeminiJSON(systemPrompt, userPrompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("Falta la variable de entorno GEMINI_API_KEY");
  }

  const model = GEMINI_MODEL;

  // Endpoint oficial Gemini API v1 — generateContent
  // https://generativelanguage.googleapis.com/v1/models/{model}:generateContent
  const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`;

  // Combinamos system + user en un único contenido para evitar campos no soportados
  const combinedPrompt = `${systemPrompt}\n\n-----\n\n${userPrompt}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: combinedPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512,
      // No usamos JSON mode obligatorio; confiamos en el prompt
      // para mantener el formato JSON simple y luego hacemos JSON.parse.
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => "");
    const msg = `Error Gemini HTTP ${resp.status}: ${errorText}`;
    throw new Error(msg);
  }

  const data = await resp.json();

  // Estructura de respuesta v1:
  // { candidates: [ { content: { parts: [ { text: "..." } ] } } ] }
  const content =
    data?.candidates?.[0]?.content?.parts?.[0]?.text &&
    String(data.candidates[0].content.parts[0].text).trim();

  if (!content) {
    throw new Error("Gemini devolvió contenido vacío");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.error("[Gemini] Error parseando JSON:", e.message, content);
    throw new Error("error_parseo_json");
  }

  return parsed;
}

function normalizeAIResult(parsed) {
  const intencion = parsed.intencion || parsed.intent || "otros";
  const idioma = parsed.idioma || parsed.language || "es";
  const pais = parsed.pais || parsed.country || "Desconocido";
  const urgencia = parsed.urgencia || parsed.urgency || "media";
  const resumen = parsed.resumen || "";
  const pregunta = parsed.pregunta || "";
  const datos_detectados = parsed.datos_detectados || parsed.data || {};

  return {
    intencion,
    idioma,
    pais,
    urgencia,
    resumen,
    pregunta,
    datos_detectados,
    raw: parsed,
  };
}

/* =====================================================================
 *  ENDPOINT IA PURO
 * ===================================================================== */

app.post("/lead/analyze", async (req, res) => {
  const body = req.body || {};
  const text =
    body.text || body.mensaje || body.message || body.content || "";

  if (!text || !String(text).trim()) {
    return res.status(400).json({
      ok: false,
      service: SERVICE_NAME,
      error: "missing_text",
      message:
        "Debes enviar al menos un campo 'text', 'mensaje' o 'message' con contenido.",
    });
  }

  const meta = {
    origen: body.origen || body.source,
    canal: body.canal || body.channel,
    nombre: body.nombre || body.name,
    email: body.email,
  };

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(String(text), meta);

  try {
    const parsed = await callGeminiJSON(systemPrompt, userPrompt);
    const normalized = normalizeAIResult(parsed);

    return res.json({
      ok: true,
      service: SERVICE_NAME,
      demo: false,
      ai: {
        status: "ok",
        resumen: normalized.resumen,
        respuesta: normalized.raw,
        motivo: null,
        intencion: normalized.intencion,
        idioma: normalized.idioma,
        pais: normalized.pais,
        urgencia: normalized.urgencia,
        pregunta: normalized.pregunta,
        datos_detectados: normalized.datos_detectados,
      },
    });
  } catch (err) {
    console.error("[/lead/analyze] Error:", err.message);

    const isParseError = err.message === "error_parseo_json";

    return res.status(200).json({
      ok: true,
      service: SERVICE_NAME,
      demo: true,
      ai: {
        status: "pendiente",
        respuesta: "",
        resumen: "No se pudo analizar correctamente el lead con IA.",
        motivo: isParseError ? "error_parseo" : err.message,
      },
    });
  }
});

/* =====================================================================
 *  ODOO JSON-RPC
 * ===================================================================== */

async function authenticateOdoo() {
  if (cachedOdooUid) {
    return cachedOdooUid;
  }

  if (!ODOO_BASE_URL || !ODOO_DB || !ODOO_USER_EMAIL || !ODOO_API_KEY) {
    throw new Error(
      "Faltan variables Odoo (BASE_URL, DB, USER_EMAIL, API_KEY)"
    );
  }

  const url = `${ODOO_BASE_URL}/jsonrpc`;

  const body = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "common",
      method: "authenticate",
      args: [ODOO_DB, ODOO_USER_EMAIL, ODOO_API_KEY, {}],
    },
    id: 1,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Error autenticando en Odoo: HTTP ${resp.status} ${text}`
    );
  }

  const data = await resp.json();
  const uid = data.result;

  if (!uid) {
    throw new Error("Autenticación Odoo fallida (uid vacío)");
  }

  cachedOdooUid = uid;
  return uid;
}

// Buscar país por nombre (res.country)
async function getCountryIdByName(uid, countryName) {
  if (!countryName || countryName.toLowerCase() === "desconocido") {
    return null;
  }

  const url = `${ODOO_BASE_URL}/jsonrpc`;

  const body = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        "res.country",
        "search",
        [[["name", "ilike", countryName]]],
        { limit: 1 },
      ],
    },
    id: 10,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("Error buscando país:", text);
    return null;
  }

  const data = await resp.json();
  if (data.error) {
    console.error("Odoo error buscando país:", JSON.stringify(data.error));
    return null;
  }

  const ids = data.result || [];
  return ids.length ? ids[0] : null;
}

// Buscar tags por nombre (crm.tag)
async function getTagIdsByNames(uid, names) {
  const clean = (names || [])
    .map((n) => String(n || "").trim())
    .filter((n) => n.length > 0);

  if (!clean.length) return [];

  const url = `${ODOO_BASE_URL}/jsonrpc`;

  const body = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        "crm.tag",
        "search_read",
        [[["name", "in", clean]]],
        { fields: ["id", "name"], limit: clean.length },
      ],
    },
    id: 11,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("Error buscando tags:", text);
    return [];
  }

  const data = await resp.json();
  if (data.error) {
    console.error("Odoo error buscando tags:", JSON.stringify(data.error));
    return [];
  }

  const found = data.result || [];
  return found.map((t) => t.id);
}

// Construir tags a partir de IA + origen / canal
function buildTagNames(ai, originalBody) {
  const tagNames = [];

  // Intención → tags ya creadas
  const intencion = (ai.intencion || "").toLowerCase();
  switch (intencion) {
    case "maquina":
      tagNames.push("Máquina de Pizzas y comida");
      break;
    case "pizzas":
      tagNames.push("Pizza sector Horeca");
      break;
    case "ambos":
      tagNames.push("Ambos");
      break;
    case "operador":
      tagNames.push("Operador vending");
      break;
    case "soporte":
      tagNames.push("IA: Soporte técnico");
      break;
    case "info":
      tagNames.push("IA: Información general");
      break;
    case "otros":
      tagNames.push("Otros");
      break;
    default:
      tagNames.push("IA: Revisar manualmente");
      break;
  }

  // Urgencia
  const urg = (ai.urgencia || "").toLowerCase();
  if (urg === "alta") tagNames.push("Urgencia: alta");
  else if (urg === "media") tagNames.push("Urgencia: media");
  else if (urg === "baja") tagNames.push("Urgencia: baja");

  // Origen
  const origen =
    (originalBody.origen || originalBody.source || "").toLowerCase();
  if (origen === "web") tagNames.push("Origen: web");
  else if (origen === "email") tagNames.push("Origen: email");
  else if (origen === "telefono" || origen === "teléfono")
    tagNames.push("Origen: teléfono");
  else if (
    origen === "red_social" ||
    origen === "redes" ||
    origen === "social"
  )
    tagNames.push("Origen: redes sociales");
  else if (origen === "cita") tagNames.push("Origen: cita");

  // Canal
  const canal =
    (originalBody.canal || originalBody.channel || "").toLowerCase();
  if (canal === "formulario") tagNames.push("Canal: formulario");
  else if (canal === "llamada") tagNames.push("Canal: llamada");
  else if (canal === "whatsapp") tagNames.push("Canal: WhatsApp");
  else if (canal === "instagram") tagNames.push("Canal: Instagram");
  else if (canal === "facebook") tagNames.push("Canal: Facebook");
  else if (canal === "cita") tagNames.push("Canal: cita");

  // Tipo IA genérico si no se ha añadido nada aún
  if (
    !tagNames.some((n) => n.startsWith("IA:")) &&
    ["maquina", "pizzas", "ambos", "operador"].includes(intencion)
  ) {
    tagNames.push("IA: Lead válido");
  }

  if (!tagNames.some((n) => n.startsWith("IA:"))) {
    tagNames.push("IA: Revisar manualmente");
  }

  // Eliminar duplicados
  return Array.from(new Set(tagNames));
}

// Construir sugerencia de respuesta (x_respuesta_ia)
function buildSuggestedReply(ai, originalBody) {
  const nombre =
    originalBody.nombre ||
    originalBody.name ||
    originalBody.contact_name ||
    "Hola";
  const idioma = (ai.idioma || "es").toLowerCase();
  const intencion = (ai.intencion || "").toLowerCase();
  const urg = (ai.urgencia || "").toLowerCase();
  const pais = ai.pais || "";
  const datos = ai.datos_detectados || {};
  const ubicacion =
    datos.ubicacion && datos.ubicacion.toLowerCase() !== "no especifica"
      ? datos.ubicacion
      : "";
  const citaUrl = ODOO_APPOINTMENT_URL;

  const baseNombre = nombre ? `Hola ${nombre},` : "Hola,";

  // De momento nos centramos en español; en inglés hacemos versión simple
  const isSpanish = idioma === "es" || idioma === "ca";

  if (!isSpanish) {
    // Versión muy simple en inglés
    let msg = `${baseNombre} thank you for contacting us.\n\n`;
    if (
      intencion === "maquina" ||
      intencion === "operador" ||
      intencion === "ambos"
    ) {
      msg +=
        "We will send you information about our vending machines (SmartChef24h) and commercial conditions.\n";
    } else if (intencion === "pizzas") {
      msg +=
        "We will send you information about our pizzas catalog, formats and prices.\n";
    } else if (intencion === "soporte") {
      msg +=
        "We have received your technical support request and we'll review it as soon as possible.\n";
    } else {
      msg += "We will reply with the information you requested.\n";
    }
    if (
      citaUrl &&
      (intencion === "maquina" ||
        intencion === "operador" ||
        intencion === "ambos")
    ) {
      msg += `\nIf you prefer, you can book a call here: ${citaUrl}`;
    }
    return msg.trim();
  }

  // Versión española
  let msg = `${baseNombre} gracias por contactar con Piznalia / La Pizzerina.\n\n`;

  if (
    intencion === "maquina" ||
    intencion === "operador" ||
    intencion === "ambos"
  ) {
    msg +=
      "Hemos recibido tu consulta sobre nuestras máquinas SmartChef24h y las condiciones para instalarlas";
    if (ubicacion) {
      msg += ` en ${ubicacion}`;
    } else if (pais && pais !== "Desconocido") {
      msg += ` en ${pais}`;
    }
    msg +=
      ". Te enviaremos una propuesta adaptada a tu caso (ubicación, previsión de ventas y modelo de colaboración).\n";
  } else if (intencion === "pizzas") {
    msg +=
      "Hemos recibido tu interés por nuestras pizzas. Te enviaremos información sobre catálogo, formatos, precios y condiciones de suministro";
    if (pais && pais !== "Desconocido") msg += ` para ${pais}`;
    msg += ".\n";
  } else if (intencion === "soporte") {
    msg +=
      "Hemos recibido tu consulta de soporte técnico. Vamos a revisar el caso y te responderemos con las instrucciones y pasos a seguir lo antes posible.\n";
  } else if (intencion === "info") {
    msg +=
      "Hemos recibido tu consulta y te responderemos con la información que necesitas.\n";
  } else {
    msg +=
      "Hemos recibido tu mensaje y lo revisaremos para darte la mejor respuesta posible.\n";
  }

  // Propuesta de cita sólo si tiene sentido
  const puedeOfrecerCita =
    citaUrl &&
    (intencion === "maquina" ||
      intencion === "operador" ||
      intencion === "ambos" ||
      intencion === "info") &&
    urg !== "baja";

  if (puedeOfrecerCita) {
    msg += "\nSi lo prefieres, podemos comentarlo en detalle en una llamada.\n";
    msg += `Puedes agendar una cita directamente aquí: ${citaUrl}\n`;
  }

  msg += "\nUn saludo,\nEquipo Piznalia / La Pizzerina";

  return msg.trim();
}

// Crear lead en Odoo con todos los campos
async function createOdooLead(ai, originalBody) {
  const uid = await authenticateOdoo();

  const partnerName =
    originalBody.nombre ||
    originalBody.name ||
    originalBody.contact_name ||
    "Lead sin nombre";

  const emailFrom = originalBody.email || originalBody.email_from || "";
  const phone = originalBody.phone || originalBody.telefono || "";

  const origin = originalBody.origen || originalBody.source || "";
  const channel = originalBody.canal || originalBody.channel || "";

  const textoOriginal =
    originalBody.text ||
    originalBody.mensaje ||
    originalBody.message ||
    originalBody.content ||
    "";

  // City a partir de datos_detectados.ubicacion
  let city = "";
  if (ai.datos_detectados && ai.datos_detectados.ubicacion) {
    const u = String(ai.datos_detectados.ubicacion).trim();
    if (u && u.toLowerCase() !== "no especifica") {
      city = u;
    }
  }

  // Prioridad según urgencia
  let priority = "1"; // baja por defecto
  const urg = (ai.urgencia || "").toLowerCase();
  if (urg === "alta") priority = "3";
  else if (urg === "media") priority = "2";
  else if (urg === "baja") priority = "1";

  // País → country_id
  const countryId = await getCountryIdByName(uid, ai.pais);

  // Tags
  const tagNames = buildTagNames(ai, originalBody);
  const tagIds = await getTagIdsByNames(uid, tagNames);

  // Sugerencia de respuesta
  const suggestedReply = buildSuggestedReply(ai, originalBody);

  const vals = {
    name: ai.resumen || ai.pregunta || "Nuevo lead desde IA",
    contact_name: partnerName,
    email_from: emailFrom,
    phone: phone,
    description: `
Texto original:
${textoOriginal}

Resumen IA:
${ai.resumen || ""}

Pregunta:
${ai.pregunta || ""}

Intención: ${ai.intencion}
País: ${ai.pais}
Urgencia: ${ai.urgencia}
Datos detectados: ${JSON.stringify(ai.datos_detectados || {})}

Origen: ${origin}
Canal: ${channel}
    `.trim(),
    priority,
    city: city || undefined,
    country_id: countryId || undefined,
    // Campos personalizados de IA (dejamos fuera x_estado_ia por tipo de campo)
    x_resumen_ia: ai.resumen || "",
    x_respuesta_ia: suggestedReply,
  };

  if (tagIds.length) {
    // Many2many: set ids
    vals.tag_ids = [[6, 0, tagIds]];
  }

  const url = `${ODOO_BASE_URL}/jsonrpc`;

  const body = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [ODOO_DB, uid, ODOO_API_KEY, "crm.lead", "create", [vals]],
    },
    id: 2,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Error creando lead en Odoo: HTTP ${resp.status} ${text}`
    );
  }

  const data = await resp.json();

  if (data.error) {
    console.error("[Odoo create lead] error:", JSON.stringify(data.error));
    const msg =
      (data.error.data && data.error.data.message) ||
      data.error.message ||
      JSON.stringify(data.error);
    throw new Error(`Odoo error creando lead: ${msg}`);
  }

  if (typeof data.result !== "number") {
    console.error(
      "[Odoo create lead] respuesta sin result numérico:",
      data
    );
    throw new Error("Odoo no devolvió un ID numérico de lead");
  }

  return data.result;
}

/* =====================================================================
 *  ENDPOINT IA + CREACIÓN LEAD
 * ===================================================================== */

app.post("/lead/analyze-and-create", async (req, res) => {
  const body = req.body || {};
  const text =
    body.text || body.mensaje || body.message || body.content || "";

  if (!text || !String(text).trim()) {
    return res.status(400).json({
      ok: false,
      service: SERVICE_NAME,
      error: "missing_text",
      message:
        "Debes enviar al menos un campo 'text', 'mensaje' o 'message' con contenido.",
    });
  }

  const meta = {
    origen: body.origen || body.source,
    canal: body.canal || body.channel,
    nombre: body.nombre || body.name,
    email: body.email,
  };

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(String(text), meta);

  try {
    const parsed = await callGeminiJSON(systemPrompt, userPrompt);
    const normalized = normalizeAIResult(parsed);

    const leadId = await createOdooLead(normalized, body);

    return res.json({
      ok: true,
      service: SERVICE_NAME,
      demo: false,
      lead_id: leadId,
      ai: {
        status: "ok",
        resumen: normalized.resumen,
        respuesta: normalized.raw,
        motivo: null,
        intencion: normalized.intencion,
        idioma: normalized.idioma,
        pais: normalized.pais,
        urgencia: normalized.urgencia,
        pregunta: normalized.pregunta,
        datos_detectados: normalized.datos_detectados,
      },
    });
  } catch (err) {
    console.error("[/lead/analyze-and-create] Error:", err.message);
    return res.status(500).json({
      ok: false,
      service: SERVICE_NAME,
      error: "odoo_or_ai_error",
      message: err.message,
    });
  }
});

/* =====================================================================
 *  WEBHOOK ZADARMA — TRANSCRIPCIÓN DE LLAMADAS
 * ===================================================================== */

app.post("/webhooks/zadarma/call", async (req, res) => {
  const body = req.body || {};

  const transcript = String(body.transcript || "").trim();
  const callerName = body.caller_name || body.callerName || "";
  const callerId = body.caller_id || body.callerId || "";

  if (!transcript) {
    return res.status(400).json({
      ok: false,
      service: SERVICE_NAME,
      source: "zadarma",
      error: "missing_transcript",
      message:
        "Debes enviar un campo 'transcript' con el texto de la llamada.",
    });
  }

  // Reutilizamos el mismo flujo de IA + creación de lead
  const meta = {
    origen: "telefono",
    canal: "llamada",
    nombre: callerName,
    // no conocemos email en llamadas entrantes
  };

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(transcript, meta);

  try {
    const parsed = await callGeminiJSON(systemPrompt, userPrompt);
    const normalized = normalizeAIResult(parsed);

    // Construimos un cuerpo "tipo lead" para que createOdooLead meta bien los campos
    const leadBody = {
      text: transcript,
      nombre: callerName || "Llamada entrante",
      phone: callerId || "",
      origen: "telefono",
      canal: "llamada",
    };

    const leadId = await createOdooLead(normalized, leadBody);

    return res.json({
      ok: true,
      service: SERVICE_NAME,
      source: "zadarma",
      lead_id: leadId,
      ai: {
        status: "ok",
        resumen: normalized.resumen,
        respuesta: normalized.raw,
        motivo: null,
        intencion: normalized.intencion,
        idioma: normalized.idioma,
        pais: normalized.pais,
        urgencia: normalized.urgencia,
        pregunta: normalized.pregunta,
        datos_detectados: normalized.datos_detectados,
      },
    });
  } catch (err) {
    console.error("[/webhooks/zadarma/call] Error:", err.message);
    return res.status(500).json({
      ok: false,
      service: SERVICE_NAME,
      source: "zadarma",
      error: "zadarma_ai_or_odoo_error",
      message: err.message,
    });
  }
});

/* =====================================================================
 *  ROOT
 * ===================================================================== */

app.get("/", (req, res) => {
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    message: "Usa GET /health o POST /lead/analyze",
  });
});

// 🚀 Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] v${VERSION} escuchando en puerto ${PORT}`);
});
