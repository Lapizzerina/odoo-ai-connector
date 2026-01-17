// index.js — odoo-ai-connector + Gemini + Odoo + Zadarma (webhook llamadas)
// Node 18+ (Render) — usa fetch nativo

const express = require("express");
const crypto = require("crypto");

const app = express();

const SERVICE_NAME = "odoo-ai-connector";
const VERSION = "v1.7.0";

// ========= CONFIG ODOO =========
const ODOO_BASE_URL = (process.env.ODOO_BASE_URL || "").replace(/\/+$/, ""); // ej: https://piznalia1.odoo.com
const ODOO_DB = process.env.ODOO_DB || ""; // ej: piznalia1
const ODOO_USER_EMAIL = process.env.ODOO_USER_EMAIL || "";
const ODOO_API_KEY = process.env.ODOO_API_KEY || "";
const ODOO_APPOINTMENT_URL = process.env.ODOO_APPOINTMENT_URL || "";

// Helpdesk
const ODOO_HELPDESK_TEAM_NAME =
  process.env.ODOO_HELPDESK_TEAM_NAME || "Atención al cliente";

// ========= CONFIG GEMINI =========
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// cache simple
let cachedOdooUid = null;
let cachedHelpdeskTeamId = null;
let cachedHelpdeskHasMachineField = null; // true/false

app.use(express.json({ limit: "1mb" }));

// CORS básico
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// 🟢 Healthcheck
app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    message: "Usa GET /health o POST /lead/analyze",
  });
});

/* =====================================================================
 *  PROMPTS IA
 * ===================================================================== */

function buildSystemPrompt() {
  return `
Eres un analizador automático de leads y llamadas para Piznalia / La Pizzerina / SmartChef24h.
Devuelve SIEMPRE un único JSON válido (sin texto antes ni después).

Formato:
{
  "intencion": "maquina|pizzas|ambos|operador|soporte|info|otros",
  "idioma": "es|ca|en|fr|pt",
  "pais": "España|...|Desconocido",
  "urgencia": "alta|media|baja",
  "resumen": "frase breve",
  "pregunta": "petición principal",
  "datos_detectados": {
    "cantidad": "1 máquina|varias|no especifica",
    "ubicacion": "ciudad/zona|no especifica",
    "plazo": "fecha/ventana|no especifica"
  },
  "soporte": {
    "tipo": "incidencia|consulta|mantenimiento|no especifica",
    "error_o_sintoma": "texto|no especifica",
    "pasos_sugeridos": ["paso 1", "paso 2"]
  }
}

Reglas:
- No inventes. Si no sabes, "no especifica" o "Desconocido".
- Si detectas incidencia técnica, usa intencion="soporte".
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

  contexto += `\nTEXTO:\n${text}\n\n`;
  contexto += "Devuelve SOLO el JSON según el formato indicado.";

  return contexto;
}

/* =====================================================================
 *  GEMINI JSON
 * ===================================================================== */

async function callGeminiJSON(systemPrompt, userPrompt) {
  if (!GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");

  const modelId = encodeURIComponent(GEMINI_MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => "");
    throw new Error(`Error Gemini HTTP ${resp.status}: ${errorText}`);
  }

  const data = await resp.json();

  const rawText =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim() || "";

  if (!rawText) throw new Error("Gemini devolvió contenido vacío");

  const tryParse = (str) => {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  };

  let parsed = tryParse(rawText);
  if (!parsed) {
    const first = rawText.indexOf("{");
    const last = rawText.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      parsed = tryParse(rawText.slice(first, last + 1));
    }
  }

  if (!parsed) {
    console.error("[Gemini] No parsea JSON. Raw:", rawText);
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
  const soporte = parsed.soporte || {};

  return {
    intencion: String(intencion || "otros").toLowerCase(),
    idioma: String(idioma || "es").toLowerCase(),
    pais: pais || "Desconocido",
    urgencia: String(urgencia || "media").toLowerCase(),
    resumen,
    pregunta,
    datos_detectados,
    soporte,
    raw: parsed,
  };
}

/* =====================================================================
 *  ENDPOINT IA PURO
 * ===================================================================== */

app.post("/lead/analyze", async (req, res) => {
  const body = req.body || {};
  const text = body.text || body.mensaje || body.message || body.content || "";

  if (!String(text || "").trim()) {
    return res.status(400).json({
      ok: false,
      service: SERVICE_NAME,
      error: "missing_text",
      message: "Envía 'text' (o 'mensaje'/'message') con contenido.",
    });
  }

  const meta = {
    origen: body.origen || body.source,
    canal: body.canal || body.channel,
    nombre: body.nombre || body.name,
    email: body.email,
  };

  try {
    const parsed = await callGeminiJSON(
      buildSystemPrompt(),
      buildUserPrompt(String(text), meta)
    );
    const ai = normalizeAIResult(parsed);

    return res.json({
      ok: true,
      service: SERVICE_NAME,
      demo: false,
      ai: {
        status: "ok",
        resumen: ai.resumen,
        respuesta: ai.raw,
        motivo: null,
        intencion: ai.intencion,
        idioma: ai.idioma,
        pais: ai.pais,
        urgencia: ai.urgencia,
        pregunta: ai.pregunta,
        datos_detectados: ai.datos_detectados,
        soporte: ai.soporte,
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
        resumen: "No se pudo analizar correctamente con IA.",
        motivo: isParseError ? "error_parseo" : err.message,
      },
    });
  }
});

/* =====================================================================
 *  ODOO JSON-RPC helpers
 * ===================================================================== */

async function odooJsonRpc(payload) {
  if (!ODOO_BASE_URL || !ODOO_DB || !ODOO_USER_EMAIL || !ODOO_API_KEY) {
    throw new Error(
      "Faltan variables Odoo (ODOO_BASE_URL, ODOO_DB, ODOO_USER_EMAIL, ODOO_API_KEY)"
    );
  }

  const resp = await fetch(`${ODOO_BASE_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Odoo HTTP ${resp.status}: ${t}`);
  }

  const data = await resp.json();
  if (data?.error) {
    const msg =
      (data.error.data && data.error.data.message) ||
      data.error.message ||
      JSON.stringify(data.error);
    throw new Error(`Odoo error: ${msg}`);
  }

  return data.result;
}

async function authenticateOdoo() {
  if (cachedOdooUid) return cachedOdooUid;

  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "common",
      method: "authenticate",
      args: [ODOO_DB, ODOO_USER_EMAIL, ODOO_API_KEY, {}],
    },
    id: 1,
  };

  const uid = await odooJsonRpc(payload);
  if (!uid) throw new Error("Autenticación Odoo fallida (uid vacío)");
  cachedOdooUid = uid;
  return uid;
}

async function odooExec(uid, model, method, args = [], kwargs = {}, id = 2) {
  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs],
    },
    id,
  };
  return odooJsonRpc(payload);
}

/* =====================================================================
 *  CONTACTOS / MÁQUINAS / HELP DESK
 * ===================================================================== */

function phoneLast9Digits(phone) {
  const digits = String(phone || "").replace(/\D+/g, "");
  if (!digits) return "";
  return digits.slice(-9);
}

async function findOrCreatePartner(uid, { name, phone, email }) {
  const last9 = phoneLast9Digits(phone);
  let partnerId = null;

  if (last9) {
    const domain = ["|", ["phone", "ilike", last9], ["mobile", "ilike", last9]];
    const ids = await odooExec(uid, "res.partner", "search", [domain], { limit: 1 }, 10);
    partnerId = Array.isArray(ids) && ids.length ? ids[0] : null;
  }

  if (partnerId) return partnerId;

  const vals = {
    name: name || (phone ? `Contacto ${phone}` : "Contacto"),
    phone: phone || undefined,
    email: email || undefined,
  };

  const newId = await odooExec(uid, "res.partner", "create", [[vals]], {}, 11);
  return newId;
}

async function getHelpdeskTeamId(uid) {
  if (cachedHelpdeskTeamId) return cachedHelpdeskTeamId;

  const teams = await odooExec(
    uid,
    "helpdesk.team",
    "search_read",
    [[["name", "ilike", ODOO_HELPDESK_TEAM_NAME]]],
    { fields: ["id", "name"], limit: 1 },
    12
  );

  cachedHelpdeskTeamId = Array.isArray(teams) && teams.length ? teams[0].id : null;
  return cachedHelpdeskTeamId;
}

async function helpdeskTicketHasMachineField(uid) {
  if (cachedHelpdeskHasMachineField !== null) return cachedHelpdeskHasMachineField;

  try {
    const fields = await odooExec(
      uid,
      "helpdesk.ticket",
      "fields_get",
      [["x_maquina_id"], ["string", "type"]],
      {},
      13
    );
    cachedHelpdeskHasMachineField = !!fields?.x_maquina_id;
  } catch {
    cachedHelpdeskHasMachineField = false;
  }
  return cachedHelpdeskHasMachineField;
}

async function findMachinesByPartner(uid, partnerId) {
  // Según tu modelo: x_maquina_operador tiene x_cliente (Many2one a res.partner)
  try {
    const recs = await odooExec(
      uid,
      "x_maquina_operador",
      "search_read",
      [[["x_cliente", "=", partnerId]]],
      { fields: ["id", "name", "x_studio_x_machine_uid"], limit: 20 },
      20
    );
    return Array.isArray(recs) ? recs : [];
  } catch (e) {
    console.warn("[machines] No se pudo leer x_maquina_operador:", e.message);
    return [];
  }
}

async function postToMachineChatter(uid, machineId, bodyHtml) {
  try {
    await odooExec(
      uid,
      "x_maquina_operador",
      "message_post",
      [[machineId]],
      { body: bodyHtml, message_type: "comment", subtype_xmlid: "mail.mt_note" },
      21
    );
    return true;
  } catch (e) {
    console.warn("[machine chatter] skip:", e.message);
    return false;
  }
}

function looksLikeSupport(text) {
  const t = String(text || "").toLowerCase();
  return /(incidenc|aver[ií]a|fall[oa]|no funciona|error|alarma|bloquead|no vend|sensor|temperatura|pago|tpv|tarjeta)/i.test(t);
}

function mapUrgencyToPriority(urg) {
  if (urg === "alta") return "3";
  if (urg === "media") return "2";
  return "1";
}

async function findExistingByCallId(uid, model, callId) {
  if (!callId) return null;
  const domain = [["description", "ilike", `call_id=${callId}`]];
  const ids = await odooExec(uid, model, "search", [domain], { limit: 1 }, 30);
  return Array.isArray(ids) && ids.length ? ids[0] : null;
}

/* =====================================================================
 *  TAGS / PAÍS (reuso de tu lógica original)
 * ===================================================================== */

async function getCountryIdByName(uid, countryName) {
  if (!countryName || countryName.toLowerCase() === "desconocido") return null;
  try {
    const ids = await odooExec(
      uid,
      "res.country",
      "search",
      [[["name", "ilike", countryName]]],
      { limit: 1 },
      40
    );
    return Array.isArray(ids) && ids.length ? ids[0] : null;
  } catch {
    return null;
  }
}

async function getTagIdsByNames(uid, names) {
  const clean = (names || [])
    .map((n) => String(n || "").trim())
    .filter((n) => n.length > 0);

  if (!clean.length) return [];

  const found = await odooExec(
    uid,
    "crm.tag",
    "search_read",
    [[["name", "in", clean]]],
    { fields: ["id", "name"], limit: clean.length },
    41
  );

  return (found || []).map((t) => t.id);
}

function buildTagNames(ai, originalBody) {
  const tagNames = [];

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

  const urg = (ai.urgencia || "").toLowerCase();
  if (urg === "alta") tagNames.push("Urgencia: alta");
  else if (urg === "media") tagNames.push("Urgencia: media");
  else if (urg === "baja") tagNames.push("Urgencia: baja");

  const origen = (originalBody.origen || originalBody.source || "").toLowerCase();
  if (origen === "web") tagNames.push("Origen: web");
  else if (origen === "email") tagNames.push("Origen: email");
  else if (origen === "telefono" || origen === "teléfono") tagNames.push("Origen: teléfono");
  else if (origen === "cita") tagNames.push("Origen: cita");

  const canal = (originalBody.canal || originalBody.channel || "").toLowerCase();
  if (canal === "formulario") tagNames.push("Canal: formulario");
  else if (canal === "llamada") tagNames.push("Canal: llamada");
  else if (canal === "whatsapp") tagNames.push("Canal: WhatsApp");
  else if (canal === "cita") tagNames.push("Canal: cita");

  if (
    !tagNames.some((n) => n.startsWith("IA:")) &&
    ["maquina", "pizzas", "ambos", "operador"].includes(intencion)
  ) {
    tagNames.push("IA: Lead válido");
  }
  if (!tagNames.some((n) => n.startsWith("IA:"))) tagNames.push("IA: Revisar manualmente");

  return Array.from(new Set(tagNames));
}

function buildSuggestedReply(ai, originalBody) {
  const nombre =
    originalBody.nombre || originalBody.name || originalBody.contact_name || "Hola";
  const idioma = (ai.idioma || "es").toLowerCase();
  const intencion = (ai.intencion || "").toLowerCase();
  const urg = (ai.urgencia || "").toLowerCase();
  const pais = ai.pais || "";
  const datos = ai.datos_detectados || {};
  const ubicacion =
    datos.ubicacion && String(datos.ubicacion).toLowerCase() !== "no especifica"
      ? String(datos.ubicacion)
      : "";
  const citaUrl = ODOO_APPOINTMENT_URL;

  const baseNombre = nombre ? `Hola ${nombre},` : "Hola,";

  const isSpanish = idioma === "es" || idioma === "ca";

  if (!isSpanish) {
    let msg = `${baseNombre} thank you for contacting us.\n\n`;
    if (["maquina", "operador", "ambos"].includes(intencion)) {
      msg += "We will send you information about our vending machines and conditions.\n";
    } else if (intencion === "pizzas") {
      msg += "We will send you information about our catalog, formats and prices.\n";
    } else if (intencion === "soporte") {
      msg += "We have received your technical support request and we'll review it ASAP.\n";
    } else {
      msg += "We will reply with the information you requested.\n";
    }
    if (citaUrl && ["maquina", "operador", "ambos"].includes(intencion)) {
      msg += `\nBook a call here: ${citaUrl}`;
    }
    return msg.trim();
  }

  let msg = `${baseNombre} gracias por contactar con Piznalia / La Pizzerina.\n\n`;

  if (["maquina", "operador", "ambos"].includes(intencion)) {
    msg += "Hemos recibido tu consulta sobre nuestras máquinas SmartChef24h";
    if (ubicacion) msg += ` en ${ubicacion}`;
    else if (pais && pais !== "Desconocido") msg += ` en ${pais}`;
    msg += ". Te enviaremos una propuesta adaptada a tu caso.\n";
  } else if (intencion === "pizzas") {
    msg += "Hemos recibido tu interés por nuestras pizzas. Te enviaremos catálogo y condiciones.\n";
  } else if (intencion === "soporte") {
    msg +=
      "Hemos recibido tu consulta de soporte técnico. Vamos a revisar el caso y te daremos los pasos a seguir lo antes posible.\n";
  } else if (intencion === "info") {
    msg += "Hemos recibido tu consulta y te responderemos con la información que necesitas.\n";
  } else {
    msg += "Hemos recibido tu mensaje y lo revisaremos para darte la mejor respuesta.\n";
  }

  const puedeOfrecerCita =
    citaUrl &&
    (["maquina", "operador", "ambos", "info"].includes(intencion)) &&
    urg !== "baja";

  if (puedeOfrecerCita) {
    msg += "\nSi lo prefieres, podemos comentarlo en una llamada.\n";
    msg += `Agenda aquí: ${citaUrl}\n`;
  }

  msg += "\nUn saludo,\nEquipo Piznalia / La Pizzerina";
  return msg.trim();
}

/* =====================================================================
 *  CREAR LEAD (con partner_id)
 * ===================================================================== */

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

  let city = "";
  if (ai.datos_detectados?.ubicacion) {
    const u = String(ai.datos_detectados.ubicacion).trim();
    if (u && u.toLowerCase() !== "no especifica") city = u;
  }

  const urg = (ai.urgencia || "").toLowerCase();
  let priority = "1";
  if (urg === "alta") priority = "3";
  else if (urg === "media") priority = "2";

  const countryId = await getCountryIdByName(uid, ai.pais);

  const tagNames = buildTagNames(ai, originalBody);
  const tagIds = await getTagIdsByNames(uid, tagNames);

  const suggestedReply = buildSuggestedReply(ai, originalBody);

  // Vincular al partner por teléfono (historial por contacto)
  const partnerId = await findOrCreatePartner(uid, {
    name: partnerName,
    phone,
    email: emailFrom,
  });

  const vals = {
    name: ai.resumen || ai.pregunta || "Nuevo lead desde IA",
    contact_name: partnerName,
    partner_id: partnerId || undefined,
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
    x_resumen_ia: ai.resumen || "",
    x_respuesta_ia: suggestedReply,
  };

  if (tagIds.length) vals.tag_ids = [[6, 0, tagIds]];

  const leadId = await odooExec(uid, "crm.lead", "create", [[vals]], {}, 50);
  return leadId;
}

/* =====================================================================
 *  CREAR TICKET SAT (helpdesk.ticket)
 * ===================================================================== */

async function createHelpdeskTicket(ai, enrichedBody, transcript, callId) {
  const uid = await authenticateOdoo();

  // Idempotencia si viene call_id
  const existing = await findExistingByCallId(uid, "helpdesk.ticket", callId);
  if (existing) return { ticketId: existing, reused: true, machineIds: [] };

  const callerName = enrichedBody.caller_name || enrichedBody.nombre || enrichedBody.name || "Llamada";
  const callerPhone = enrichedBody.caller_id || enrichedBody.phone || enrichedBody.telefono || "";
  const email = enrichedBody.email || "";

  const partnerId = await findOrCreatePartner(uid, {
    name: callerName,
    phone: callerPhone,
    email,
  });

  const teamId = await getHelpdeskTeamId(uid);
  const machines = partnerId ? await findMachinesByPartner(uid, partnerId) : [];

  const soporteTipo = ai?.soporte?.tipo || "no especifica";
  const sintoma = ai?.soporte?.error_o_sintoma || "no especifica";
  const pasos = Array.isArray(ai?.soporte?.pasos_sugeridos) ? ai.soporte.pasos_sugeridos : [];

  const pasosTxt = pasos.length ? pasos.map((p, i) => `${i + 1}. ${p}`).join("\n") : "No hay pasos sugeridos";

  const candidatesTxt =
    machines.length
      ? machines.map((m) => `- ${m.name} (id=${m.id}${m.x_studio_x_machine_uid ? `, uid=${m.x_studio_x_machine_uid}` : ""})`).join("\n")
      : "- No localizada por partner";

  const machineUnique = machines.length === 1 ? machines[0] : null;

  const ticketName = ai?.resumen ? `[SAT] ${ai.resumen}` : `[SAT] Incidencia telefónica ${callerPhone}`.trim();

  const description = `
call_id=${callId || "no"}
CLIENTE:
${callerName}
Tel: ${callerPhone}

RESUMEN IA:
${ai?.resumen || ""}

SÍNTOMA / ERROR:
${sintoma}

TIPO:
${soporteTipo}

PASOS SUGERIDOS:
${pasosTxt}

MÁQUINAS (candidatas por partner):
${candidatesTxt}

TRANSCRIPCIÓN:
${transcript}
  `.trim();

  const vals = {
    name: ticketName,
    description,
    partner_id: partnerId || undefined,
    team_id: teamId || undefined,
    user_id: uid, // tú (único usuario)
    priority: mapUrgencyToPriority(ai?.urgencia || "media"),
  };

  // Si tienes el campo x_maquina_id en helpdesk.ticket, lo rellenamos solo si hay match único
  const hasMachineField = await helpdeskTicketHasMachineField(uid);
  if (hasMachineField && machineUnique) {
    vals.x_maquina_id = machineUnique.id;
  }

  const ticketId = await odooExec(uid, "helpdesk.ticket", "create", [[vals]], {}, 60);

  // Nota en el chatter de la máquina (solo si match único; si hay varias, no ensuciamos)
  if (machineUnique) {
    const ticketUrl = `${ODOO_BASE_URL}/web#id=${ticketId}&model=helpdesk.ticket&view_type=form`;
    const noteHtml = `
<b>📞 Llamada SAT registrada</b><br/>
<b>Ticket:</b> <a href="${ticketUrl}">#${ticketId}</a><br/>
<b>Resumen IA:</b> ${ai?.resumen || ""}<br/>
<b>Síntoma:</b> ${sintoma}<br/>
`.trim();
    await postToMachineChatter(uid, machineUnique.id, noteHtml);
  }

  return { ticketId, reused: false, machineIds: machineUnique ? [machineUnique.id] : [] };
}

/* =====================================================================
 *  ENDPOINT IA + CREACIÓN LEAD (se mantiene)
 * ===================================================================== */

app.post("/lead/analyze-and-create", async (req, res) => {
  const body = req.body || {};
  const text = body.text || body.mensaje || body.message || body.content || "";

  if (!String(text || "").trim()) {
    return res.status(400).json({
      ok: false,
      service: SERVICE_NAME,
      error: "missing_text",
      message: "Debes enviar 'text' (o 'mensaje'/'message') con contenido.",
    });
  }

  const meta = {
    origen: body.origen || body.source,
    canal: body.canal || body.channel,
    nombre: body.nombre || body.name,
    email: body.email,
  };

  try {
    const parsed = await callGeminiJSON(
      buildSystemPrompt(),
      buildUserPrompt(String(text), meta)
    );
    const ai = normalizeAIResult(parsed);

    const leadId = await createOdooLead(ai, body);

    return res.json({
      ok: true,
      service: SERVICE_NAME,
      demo: false,
      lead_id: leadId,
      ai: {
        status: "ok",
        resumen: ai.resumen,
        respuesta: ai.raw,
        motivo: null,
        intencion: ai.intencion,
        idioma: ai.idioma,
        pais: ai.pais,
        urgencia: ai.urgencia,
        pregunta: ai.pregunta,
        datos_detectados: ai.datos_detectados,
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
 *  NUEVO:
 *   - Si soporte => helpdesk.ticket
 *   - Si no => crm.lead
 * ===================================================================== */

app.post("/webhooks/zadarma/call", async (req, res) => {
  const body = req.body || {};
  const transcript = body.transcript || body.text || body.mensaje || body.message || "";

  if (!String(transcript || "").trim()) {
    return res.status(400).json({
      ok: false,
      service: SERVICE_NAME,
      source: "zadarma",
      error: "missing_transcript",
      message: "Debes enviar 'transcript' (o 'text'/'mensaje') con la transcripción.",
    });
  }

  // Identificador de llamada (si Zadarma lo manda)
  const callId =
    body.call_id ||
    body.callid ||
    body.id ||
    body.unique_id ||
    body.uniqueid ||
    null;

  const enrichedBody = {
    ...body,
    text: transcript,
    origen: "telefono",
    canal: "llamada",
    nombre: body.caller_name || body.nombre || body.name,
    phone: body.caller_id || body.phone || body.telefono,
  };

  const meta = {
    origen: enrichedBody.origen,
    canal: enrichedBody.canal,
    nombre: enrichedBody.nombre,
    email: enrichedBody.email,
  };

  try {
    const parsed = await callGeminiJSON(
      buildSystemPrompt(),
      buildUserPrompt(String(transcript), meta)
    );
    const ai = normalizeAIResult(parsed);

    const shouldCreateTicket =
      ai.intencion === "soporte" || looksLikeSupport(transcript) || String(body.force_ticket || "").toLowerCase() === "true";

    if (shouldCreateTicket) {
      const r = await createHelpdeskTicket(ai, enrichedBody, transcript, callId);
      return res.json({
        ok: true,
        service: SERVICE_NAME,
        source: "zadarma",
        created: "ticket",
        ticket_id: r.ticketId,
        reused: r.reused,
        machine_ids: r.machineIds,
        ai: { intencion: ai.intencion, urgencia: ai.urgencia, resumen: ai.resumen },
      });
    }

    const leadId = await createOdooLead(ai, enrichedBody);
    return res.json({
      ok: true,
      service: SERVICE_NAME,
      source: "zadarma",
      created: "lead",
      lead_id: leadId,
      ai: { intencion: ai.intencion, urgencia: ai.urgencia, resumen: ai.resumen },
    });
  } catch (err) {
    console.error("[/webhooks/zadarma/call] Error:", err.message);

    // Fallback: si falla IA, creamos ticket básico para no perder incidencias
    try {
      const aiFallback = {
        intencion: "soporte",
        urgencia: "media",
        resumen: "Llamada SAT sin clasificar (fallo IA)",
        soporte: { tipo: "no especifica", error_o_sintoma: "no especifica", pasos_sugeridos: [] },
        datos_detectados: {},
      };

      const r = await createHelpdeskTicket(aiFallback, enrichedBody, transcript, callId);
      return res.status(200).json({
        ok: true,
        service: SERVICE_NAME,
        source: "zadarma",
        created: "ticket",
        ticket_id: r.ticketId,
        fallback: true,
        error: err.message,
      });
    } catch (e2) {
      return res.status(500).json({
        ok: false,
        service: SERVICE_NAME,
        source: "zadarma",
        error: "zadarma_ai_or_odoo_error",
        message: `${err.message} | fallback_ticket_failed: ${e2.message}`,
      });
    }
  }
});

/* =====================================================================
 *  ROOT
 * ===================================================================== */

app.get("/", (req, res) => {
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    message: "Usa GET /health o POST /lead/analyze",
  });
});

// 🚀 Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] v${VERSION} escuchando en puerto ${PORT}`);
});
