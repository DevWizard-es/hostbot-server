/**
 * HostBot Server — index.js
 * Servidor backend que recibe mensajes de Instagram y Facebook
 * y responde automáticamente usando IA (OpenRouter)
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { initDb } = require('./database');
const apiRoutes = require('./api_routes');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure DB is initialized
initDb();

// Mount SaaS authentication and APIs
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;

// ── Conversation memory (in-memory, resets on restart) ──────────
// Format: { senderId: [{ role, content }, ...] }
const conversations = new Map();
const MAX_HISTORY = 10; // últimos 10 mensajes por usuario

// ── Build system prompt ──────────────────────────────────────────
async function buildSystemPrompt() {
  const db = await initDb();
  
  // For MVP, fetch the latest configured business in the database
  const biz = await db.get('SELECT * FROM businesses ORDER BY id DESC LIMIT 1') 
    || { name: process.env.BUSINESS_NAME || 'Mi Negocio', type: 'Restaurante', phone: process.env.BUSINESS_PHONE, hours: '', address: '' };
  
  const agentConfig = biz.id ? await db.get('SELECT * FROM agent_configs WHERE business_id = ?', [biz.id]) : null;
  const menu = biz.id ? await db.all('SELECT * FROM menus WHERE business_id = ? AND available = 1', [biz.id]) : [];

  const tone = agentConfig?.tone || process.env.AGENT_TONE || 'friendly';
  const agentName = agentConfig?.agent_name || process.env.AGENT_NAME || 'Asistente';
  const additionalInstructions = agentConfig?.instructions || '';

  const toneInstructions = {
    Amigable: 'comunicarte de forma amigable, cálida y cercana. Usa emojis con moderación.',
    Profesional: 'comunicarte de forma formal y profesional. Evita el uso de emojis.',
    Informal: 'comunicarte de forma casual, divertida y desenfadada. Usa emojis libremente.',
    friendly: 'comunicarte de forma amigable, cálida y cercana. Usa emojis con moderación.',
  };

  let menuText = '';
  if (menu.length > 0) {
    menuText = '\n\n📋 MENÚ DISPONIBLE:\n';
    const categories = [...new Set(menu.map(m => m.category || 'General'))];
    categories.forEach(cat => {
      menuText += `\n${cat}:\n`;
      const items = menu.filter(m => (m.category || 'General') === cat);
      items.forEach(item => {
        menuText += `  - ${item.name}: €${Number(item.price).toFixed(2)}`;
        if (item.description) menuText += ` (${item.description})`;
        menuText += '\n';
      });
    });
  }

  return `Eres ${agentName}, el asistente virtual de ${biz.name} (${biz.type}).
Tu misión es atender a los clientes que escriben por Instagram y Facebook Messenger.
Debes ${toneInstructions[tone] || toneInstructions.Amigable}
${additionalInstructions ? '\nINSTRUCCIONES DEL DUEÑO: ' + additionalInstructions : ''}

📍 INFORMACIÓN DEL NEGOCIO:
- Nombre: ${biz.name}
- Tipo: ${biz.type}
- Dirección: ${biz.address || 'Consultar'}
- Teléfono: ${biz.phone || 'Consultar'}
- Horario: ${biz.schedule || 'Consultar'}
${menuText}

📌 INSTRUCCIONES IMPORTANTES:
- Responde SIEMPRE en el mismo idioma en que te escribe el cliente
- Sé conciso: las respuestas por mensajería deben ser cortas (máx. 3-4 líneas)
- Si preguntan por el menú, muestra los platos disponibles con precios
- Para reservas o pedidos, pide: nombre, cantidad y hora
- NO inventes precios ni productos`;
}

const { getLocalResponse } = require('./local_ai');

// ── Send message to OpenRouter ───────────────────────────────────
async function getAIResponse(senderId, userMessage) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  let modelToUse = process.env.AI_MODEL || 'openrouter/free';
  if (modelToUse.includes('meta-llama') || modelToUse.includes('gemini')) {
    modelToUse = 'openrouter/free';
  }

  if (!apiKey || apiKey.startsWith('sk-or-v1-xxx')) {
    // Return local response even if no API key
    const db = await initDb();
    const biz = await db.get('SELECT * FROM businesses ORDER BY id DESC LIMIT 1') || { name: 'Empresa' };
    const menu = await db.all('SELECT * FROM menus WHERE business_id = ? AND available = 1', [biz.id]) || [];
    return getLocalResponse(userMessage || '', biz, menu);
  }

  // Get/init conversation history
  if (!conversations.has(senderId)) {
    conversations.set(senderId, []);
  }
  const history = conversations.get(senderId);

  // Add user message to history
  history.push({ role: 'user', content: userMessage });

  // Keep only last MAX_HISTORY messages
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: modelToUse,
        messages: [
          { role: 'system', content: await buildSystemPrompt() },
          ...history,
        ],
        max_tokens: 300,
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://hostbot.app',
          'X-Title': 'HostBot Social',
        },
        timeout: 15000,
      }
    );

    const aiMessage = response.data.choices[0]?.message?.content || 'Lo siento, no pude procesar tu mensaje. Inténtalo de nuevo.';

    // Add AI response to history
    history.push({ role: 'assistant', content: aiMessage });

    return aiMessage;

  } catch (error) {
    console.error('OpenRouter error, falling back to Local AI:', error.message);
    const db = await initDb();
    const biz = await db.get('SELECT * FROM businesses ORDER BY id DESC LIMIT 1') || { name: 'Empresa' };
    const menu = await db.all('SELECT * FROM menus WHERE business_id = ? AND available = 1', [biz.id]) || [];
    return getLocalResponse(userMessage || '', biz, menu);
  }
}

// ── Send reply back to Meta ──────────────────────────────────────
async function sendMetaMessage(recipientId, messageText, platform = 'instagram') {
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN;

  if (!pageToken || pageToken.startsWith('EAAxx')) {
    console.log('[DEMO] Would send to', recipientId, ':', messageText);
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: messageText },
        messaging_type: 'RESPONSE',
      },
      {
        params: { access_token: pageToken },
        headers: { 'Content-Type': 'application/json' },
      }
    );
    console.log(`✅ Message sent to ${recipientId}`);
  } catch (error) {
    console.error('❌ Meta API error:', error.response?.data || error.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  WEBHOOK ROUTES
// ════════════════════════════════════════════════════════════════

// ── GET /webhook — Verificación del webhook por Meta ────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado por Meta');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Token de verificación incorrecto');
    res.sendStatus(403);
  }
});

// ── POST /webhook — Recibe mensajes de Instagram y Facebook ─────
app.post('/webhook', async (req, res) => {
  // Responder 200 inmediatamente para que Meta no reintente
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== 'instagram' && body.object !== 'page') return;

  for (const entry of (body.entry || [])) {
    const messaging = entry.messaging || entry.changes?.[0]?.value?.messages;
    if (!messaging) continue;

    for (const event of messaging) {
      // Instagram DM
      if (event.message && !event.message.is_echo) {
        const senderId = event.sender?.id;
        const messageText = event.message?.text;

        if (!senderId || !messageText) continue;

        console.log(`📨 Mensaje de ${senderId}: "${messageText}"`);

        // Show "typing" indicator
        const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
        if (pageToken && !pageToken.startsWith('EAAxx')) {
          await axios.post(
            `https://graph.facebook.com/v19.0/me/messages`,
            {
              recipient: { id: senderId },
              sender_action: 'typing_on',
            },
            { params: { access_token: pageToken } }
          ).catch(() => {});
        }

        // Get AI response
        const aiReply = await getAIResponse(senderId, messageText);
        console.log(`🤖 Respuesta IA: "${aiReply}"`);

        // Send reply
        await sendMetaMessage(senderId, aiReply, body.object);
      }
    }
  }
});

// ════════════════════════════════════════════════════════════════
//  ADMIN API ROUTES (para sincronizar config desde el panel web)
// ════════════════════════════════════════════════════════════════

// ── POST /api/config — Guarda la config exportada desde el admin panel
app.post('/api/config', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET && process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { business, menu, agent } = req.body;

  const configDir = path.join(__dirname, 'config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir);

  if (business) {
    fs.writeFileSync(path.join(configDir, 'business.json'), JSON.stringify(business, null, 2));
    if (agent) {
      process.env.AGENT_NAME = agent.name || 'Asistente';
      process.env.AGENT_TONE = agent.tone || 'friendly';
      process.env.AI_MODEL = agent.model || 'openai/gpt-4o-mini';
    }
  }
  if (menu) {
    fs.writeFileSync(path.join(configDir, 'menu.json'), JSON.stringify(menu, null, 2));
  }

  res.json({ ok: true, message: 'Config actualizada correctamente' });
});

// ── GET /api/status — Health check
app.get('/api/status', async (req, res) => {
  try {
    const db = await initDb();
    const biz = (await db.get('SELECT * FROM businesses ORDER BY id DESC LIMIT 1')) || { name: 'DB Started' };
    res.json({
      status: 'online',
      business: biz.name,
      aiModel: process.env.AI_MODEL || 'openai/gpt-4o-mini',
      webhookToken: process.env.META_VERIFY_TOKEN ? '✅ Configurado' : '❌ Falta configurar',
      metaToken: process.env.META_PAGE_ACCESS_TOKEN && !process.env.META_PAGE_ACCESS_TOKEN.startsWith('EAAxx') ? '✅ Configurado' : '❌ Falta configurar',
      openrouterKey: process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.startsWith('sk-or-v1-xxx') ? '✅ Configurado' : '❌ Falta configurar',
      activeConversations: conversations.size,
    });
  } catch (e) {
    res.status(500).json({ error: 'DB Error' });
  }
});

// ── GET / — Página de estado
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>HostBot Server</title>
      <style>
        body { font-family: system-ui; background: #0f0f1a; color: #e2e8f0; padding: 40px; max-width: 600px; margin: 0 auto; }
        h1 { color: #8b47ff; }
        .status { background: #1a1a2e; border: 1px solid #2d2d3d; border-radius: 12px; padding: 20px; margin: 20px 0; }
        .ok { color: #10b981; } .err { color: #ef4444; }
        code { background: #2d2d3d; padding: 4px 8px; border-radius: 6px; font-size: 0.85rem; }
      </style>
    </head>
    <body>
      <h1>🤖 HostBot Server</h1>
      <p>Servidor activo y listo para recibir mensajes de Instagram y Facebook.</p>
      <div class="status">
        <p><strong>Webhook URL:</strong><br><code>${process.env.PUBLIC_URL || 'http://tu-servidor.com'}/webhook</code></p>
        <p><small>Usa esta URL en Meta for Developers → Webhooks</small></p>
      </div>
      <p>Estado detallado: <a href="/api/status" style="color:#8b47ff">/api/status</a></p>
    </body>
    </html>
  `);
});

// ── Start server ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 HostBot Server corriendo en puerto ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`📊 Status: http://localhost:${PORT}/api/status\n`);
});
