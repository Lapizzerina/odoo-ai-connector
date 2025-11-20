// index.js — odoo-ai-connector + DeepSeek + Odoo
// Node 18+ (Render) — usa fetch nativo

const express = require("express");

const app = express();

const SERVICE_NAME = "odoo-ai-connector";
const VERSION = "v1.2.1";

// ========= CONFIG ODOO =========
const ODOO_BASE_URL = process.env.ODOO_BASE_URL; // ej: https://piznalia1.odoo.com
const ODOO_DB = process.env.ODOO_DB;             // ej: piznalia1
const ODOO_USER_EMAIL = process.env.ODOO_USER_EMAIL;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

// cache simple de uid
let cachedOdooUid = null;

// ⚙️ Config básica
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

// ============ IA (DeepSeek) ============

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
- "maquina"
- "pizzas"
- "ambos"
- "operador"
- "soporte"
- "info"
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
  - "datos_detectados": objeto con "cantidad", "ubicacion", "plazo".
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

async function callDeepSeekJSON(systemPrompt, userPrompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

  if (!apiKey) {
    throw new Error("Falta la variable de entorno DEEPSEEK_API_KEY");
  }

  const url = "https://api.deepseek.com/chat/completions";

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 512,
    response_format: { type: "json_object" },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => "");
    const msg = `Error DeepSeek HTTP ${resp.status}: ${errorText}`;
    throw new Error(msg);
  }

  const data = await resp.json();

  const content =
    data?.choices?.[0]?.message?.content &&
    String(data.choices[0].message.content).trim();

  if (!content) {
    throw new Error("DeepSeek devolvió contenido vacío");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.error("[DeepSeek] Error parseando JSON:", e.message, content);
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

// ====== ENDPOINT IA PURO ======

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
    const parsed = await callDeepSeekJSON(systemPrompt, userPrompt);
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
        resumen:
          "No se pudo analizar correctamente el lead con IA.",
        motivo: isParseError ? "error_parseo" : err.message,
      },
    });
  }
});

// ============ ODOO JSON-RPC ============

async function authenticateOdoo() {
  if (cachedOdooUid) {
    return cachedOdooUid;
  }

  if (!ODOO_BASE_URL || !ODOO_DB || !ODOO_USER_EMAIL || !ODOO_API_KEY) {
    throw new Error("Faltan variables Odoo (BASE_URL, DB, USER_EMAIL, API_KEY)");
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
    throw new Error(`Error autenticando en Odoo: HTTP ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const uid = data.result;

  if (!uid) {
    throw new Error("Autenticación Odoo fallida (uid vacío)");
  }

  cachedOdooUid = uid;
  return uid;
}

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
    // Estos campos x_* solo tendrán efecto si luego los creamos en Odoo.
    x_intencion_ai: ai.intencion,
    x_pais_ai: ai.pais,
    x_idioma_ai: ai.idioma,
    x_urgencia_ai: ai.urgencia,
  };

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
    throw new Error(`Error creando lead en Odoo: HTTP ${resp.status} ${text}`);
  }

  const data = await resp.json();

  // 🔍 Nueva parte: mostrar el error real de Odoo si lo hay
  if (data.error) {
    console.error("[Odoo create lead] error:", JSON.stringify(data.error));
    const msg =
      (data.error.data && data.error.data.message) ||
      data.error.message ||
      JSON.stringify(data.error);
    throw new Error(`Odoo error creando lead: ${msg}`);
  }

  if (typeof data.result !== "number") {
    console.error("[Odoo create lead] respuesta sin result numérico:", data);
    throw new Error("Odoo no devolvió un ID numérico de lead");
  }

  return data.result; // id del lead
}

// ============ ENDPOINT IA + CREACIÓN LEAD ============

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
    const parsed = await callDeepSeekJSON(systemPrompt, userPrompt);
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

// 🌍 Fallback root
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
  console.log(
    `[${SERVICE_NAME}] v${VERSION} escuchando en puerto ${PORT}`
  );
});
