// index.js — odoo-ai-connector + DeepSeek
// Node 18+ (Render) — usa fetch nativo

const express = require("express");
const cors = require("cors");

const app = express();

const SERVICE_NAME = "odoo-ai-connector";
const VERSION = "v1.1.0";

// ⚙️ Configuración básica
app.use(cors());
app.use(
  express.json({
    limit: "1mb",
  })
);

// 🟢 Healthcheck simple
app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    message: "Usa GET /health o POST /lead/analyze",
  });
});

// 🧠 Prompt de sistema para DeepSeek (JSON estricto)
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
  "resumen": "Quiere información para comprar una máquina en Barcelona",
  "pregunta": "¿Qué precio tiene la máquina y cómo funciona el servicio?",
  "datos_detectados": {
    "cantidad": "1 máquina",
    "ubicacion": "Barcelona",
    "plazo": "próximos meses"
  }
}

Las intenciones posibles son SOLO estas:
- "maquina" (interesado en comprar una máquina SmartChef24h)
- "pizzas" (interesado solo en pizzas)
- "ambos"
- "operador" (quiere operar máquinas)
- "soporte" (duda técnica de máquina / ticket)
- "info" (pregunta general)
- "otros"

Reglas para el JSON de salida:
- Devuelve SIEMPRE un único objeto JSON, sin texto antes ni después.
- Campos obligatorios:
  - "intencion": una de las opciones indicadas.
  - "idioma": "es", "ca", "en", "fr", "pt" (elige el idioma principal del mensaje).
  - "pais": nombre normalizado: España, Portugal, Francia, Andorra, Chile, México, Argentina, etc.
    - Si no se puede saber, pon "Desconocido".
  - "urgencia": "alta", "media" o "baja".
  - "resumen": frase breve con lo que quiere el cliente.
  - "pregunta": resumen de la duda o petición principal.
  - "datos_detectados": objeto con:
      "cantidad": texto breve (ej. "1 máquina", "varias máquinas", "no especifica").
      "ubicacion": ciudad / zona si se menciona (o "no especifica").
      "plazo": plazo aproximado si se menciona (o "no especifica").
- No inventes datos que no estén en el mensaje. Si no sabes algo, pon "no especifica" o "Desconocido".
- RESPONDE SIEMPRE SOLO CON JSON VÁLIDO.
`;
}

// 🧾 Prompt de usuario: mensaje + meta
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

// 🧠 Llamada a DeepSeek
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
    // Log ligero, sin datos sensibles
    console.error("[DeepSeek] Error parseando JSON:", e.message, content);
    throw new Error("error_parseo_json");
  }

  return parsed;
}

// 🧩 Normalizar salida para que Odoo la use fácil
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

// 📥 Endpoint principal: analizar lead
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
        // compatibilidad con versión anterior
        resumen: normalized.resumen,
        respuesta: normalized.raw,
        motivo: null,

        // campos directos para Odoo / automatizaciones
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

    // Diferenciar fallo de parseo vs fallo HTTP u otros
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
  console.log
