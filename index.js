// index.js
// Servicio IA sencillo para analizar LEADS de Odoo
// Lo desplegaremos en Render como Web Service

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');

const app = express();

// -------- Config básica --------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SECURITY_TOKEN = process.env.SECURITY_TOKEN || 'CAMBIA_ESTO';

// Middlewares
app.use(express.json({ limit: '1mb' }));
app.use(cors());
app.use(morgan('tiny'));

// ---------- Ruta raíz (para que no salga "Cannot GET /") ----------
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'odoo-ai-connector',
    message: 'Usa GET /health o POST /lead/analyze',
  });
});

// ---------- Healthcheck ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'odoo-ai-connector', uptime: process.uptime() });
});

// --------- Helper IA ----------
async function analyzeLeadWithAI(payload) {
  if (!OPENAI_API_KEY) {
    throw new Error('Falta OPENAI_API_KEY en variables de entorno');
  }

  const {
    id,
    name,
    description,
    email_from,
    phone,
    tags = [],
    origin,
  } = payload;

  const systemPrompt = `
Eres un asistente de ventas para Piznalia / La Pizzerina.
Analizas leads de Odoo y devuelves SIEMPRE un JSON válido.

Campos a devolver:
- "status": uno de ["pendiente", "priorizar", "no_interesado"]
- "respuesta": texto de respuesta profesional y cercana en ESPAÑOL para enviar al cliente (o cadena vacía si no procede).
- "resumen": resumen breve en español de la situación del lead.
- "motivo": etiqueta corta en minúsculas y sin espacios (por ejemplo: "solicitud_informacion", "precio_alto", "solo_curiosidad").

Reglas:
- Si parece un lead caliente o muy interesante => status = "priorizar".
- Si parece un lead normal => status = "pendiente".
- Si claramente no está interesado o es SPAM => status = "no_interesado".
- No añadas texto fuera del JSON.
  `;

  const userPrompt = `
Datos del lead de Odoo:

- ID: ${id}
- Nombre: ${name || ''}
- Descripción / notas: ${description || ''}
- Email: ${email_from || ''}
- Teléfono: ${phone || ''}
- Etiquetas: ${Array.isArray(tags) ? tags.join(', ') : ''}
- Origen: ${origin || ''}

Devuelve SOLO un JSON con esta estructura:

{
  "status": "...",
  "respuesta": "...",
  "resumen": "...",
  "motivo": "..."
}
  `;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini', // puedes cambiar a otro modelo si quieres
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  const content = response.data.choices?.[0]?.message?.content || '{}';

  // Intentamos parsear el JSON que devuelve el modelo
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error('Error parseando JSON de OpenAI:', err);
    // Fallback mínimo para no romper Odoo
    parsed = {
      status: 'pendiente',
      respuesta: '',
      resumen: 'No se pudo analizar correctamente el lead con IA.',
      motivo: 'error_parseo',
    };
  }

  return parsed;
}

// ---------- Endpoint principal ----------
// POST /lead/analyze
// Odoo llamará a este endpoint con los datos del lead
app.post('/lead/analyze', async (req, res) => {
  try {
    // Seguridad básica con token
    const token = req.headers['x-security-token'];
    if (!token || token !== SECURITY_TOKEN) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }

    const leadData = req.body || {};

    // Si marcamos que viene de "web" y quieres saltarlo, se puede hacer aquí:
    const tags = leadData.tags || [];
    const hasWebTag =
      Array.isArray(tags) && tags.some((t) => String(t).toLowerCase().includes('web'));
    if (hasWebTag) {
      return res.json({
        ok: true,
        skipped: true,
        reason: 'lead_origen_web',
        ai: {
          status: 'pendiente',
          respuesta: '',
          resumen: 'Lead proveniente de formulario web con automatización propia.',
          motivo: 'origen_web',
        },
      });
    }

    const aiResult = await analyzeLeadWithAI(leadData);

    return res.json({
      ok: true,
      skipped: false,
      ai: aiResult,
    });
  } catch (err) {
    console.error('Error en /lead/analyze:', err);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      details: err.message,
    });
  }
});

// ---------- Endpoint de prueba rápida (sin Odoo) ----------
// GET /debug/demo-lead
app.get('/debug/demo-lead', async (req, res) => {
  try {
    const demoLead = {
      id: 999,
      name: 'Prueba demo IA',
      description:
        'Hola, estoy interesado en vuestra máquina SmartChef24h para un local en Girona. Me gustaría saber precios y condiciones de renting.',
      email_from: 'demo@cliente.com',
      phone: '+34600111222',
      tags: ['demo', 'instagram'],
      origin: 'demo',
    };

    const aiResult = await analyzeLeadWithAI(demoLead);

    res.json({
      ok: true,
      demo: true,
      ai: aiResult,
    });
  } catch (err) {
    console.error('Error en /debug/demo-lead:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Arranque ----------
app.listen(PORT, () => {
  console.log(`✅ odoo-ai-connector escuchando en puerto ${PORT}`);
});
