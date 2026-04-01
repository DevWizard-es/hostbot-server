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

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ── Conversation memory (in-memory, resets on restart) ──────────
// Format: { senderId: [{ role, content }, ...] }
const conversations = new Map();
const MAX_HISTORY = 10; // últimos 10 mensajes por usuario

// ── Load business config ─────────────────────────────────────────
function getBusinessConfig() {
  // Try loading from config/business.json first (exported from admin panel)
  const configPath = path.join(__dirname, 'config', 'business.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error('Error loading business.json:', e.message);
    }
  }

  // Fallback to environment variables
  return {
    name: process.env.BUSINESS_NAME || 'Mi Negocio',
    type: process.env.BUSINESS_TYPE || 'Bar',
    description: process.env.BUSINESS_DESCRIPTION || '',
    address: process.env.BUSINESS_ADDRESS || '',
    phone: process.env.BUSINESS_PHONE || '',
    hours: process.env.BUSINESS_HOURS || '',
    currency: process.env.BUSINESS_CURRENCY || '€',
  };
}

function getMenuConfig() {
  // Try loading from config/menu.json first
  const menuPath = path.join(__dirname, 'config', 'menu.json');
  if (fs.existsSync(menuPath)) {
    try {
      return JSON.parse(fs.readFileSync(menuPath, 'utf8'));
    } catch (e) {
      console.error('Error loading menu.json:', e.message);
    }
  }

  // Fallback to env variable
  if (process.env.BUSINESS_MENU) {
    try {
      return JSON.parse(process.env.BUSINESS_MENU);
    } catch (e) {}
  }
  return [];
}

// ── Build system prompt ──────────────────────────────────────────
function buildSystemPrompt() {
  const biz = getBusinessConfig();
  const menu = getMenuConfig();
  const tone = process.env.AGENT_TONE || 'friendly';
  const agentName = process.env.AGENT_NAME || 'Asistente';

  const toneInstructions = {
    friendly: 'comunicarte de forma amigable, cálida y cercana. Usa emojis con moderación.',
    formal: 'comunicarte de forma formal y profesional. Evita el uso de emojis.',
    casual: 'comunicarte de forma casual, divertida y desenfadada. Usa emojis libremente.',
  };

  let menuText = '';
  if (menu.length > 0) {
    menuText = '\n\n📋 MENÚ DISPONIBLE:\n';
    menu.forEach(cat => {
      menuText += `\n${cat.name || cat.category}:\n`;
      const items = cat.items || [];
      items.forEach(item => {
        if (item.available !== false) {
          menuText += `  - ${item.name}: ${biz.currency}${Number(item.price).toFixed(2)}`;
          if (item.description) menuText += ` (${item.description})`;
          if (item.popular) menuText += ' ⭐';
          menuText += '\n';
        }
      });
    });
  }

  return `Eres ${agentName}, el asistente virtual de ${biz.name} (${biz.type}).
Tu misión es atender a los clientes que escriben por Instagram y Facebook Messenger.
Debes ${toneInstructions[tone] || toneInstructions.friendly}

📍 INFORMACIÓN DEL NEGOCIO:
- Nombre: ${biz.name}
- Tipo: ${biz.type}
- Descripción: ${biz.description || 'No disponible'}
- Dirección: ${biz.address || 'No disponible'}
- Teléfono: ${biz.phone || 'No disponible'}
- Horario: ${biz.hours || 'Consultar por mensaje'}
${menuText}

📌 INSTRUCCIONES IMPORTANTES:
- Responde SIEMPRE en el mismo idioma en que te escribe el cliente
- Sé conciso: las respuestas por mensajería deben ser cortas (máx. 3-4 líneas)
- Si preguntan por el menú, muestra los platos disponibles con precios
- Para reservas o pedidos, pide: nombre, número de personas (reserva) o productos (pedido), y hora
- Si no sabes algo, di que lo consultas y que contacten al ${biz.phone || 'negocio directamente'}
- NO inventes precios, horarios ni información que no tengas
- Si el cliente parece molesto, muestra empatía y ofrece solución`;
}

// ── Send message to OpenRouter ───────────────────────────────────
async function getAIResponse(senderId, userMessage) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.AI_MODEL || 'openai/gpt-4o-mini';

  if (!apiKey || apiKey.startsWith('sk-or-v1-xxx')) {
    return '⚠️ El asistente no está configurado aún. Por favor contacta directamente con nosotros. ¡Gracias por tu paciencia!';
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
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
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
    console.error('OpenRouter error:', error.response?.data || error.message);
    const biz = getBusinessConfig();
    return `Lo siento, estoy teniendo problemas técnicos. Puedes contactarnos directamente al ${biz.phone || 'teléfono del negocio'}. ¡Disculpa las molestias!`;
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
app.get('/api/status', (req, res) => {
  const biz = getBusinessConfig();
  res.json({
    status: 'online',
    business: biz.name,
    aiModel: process.env.AI_MODEL || 'openai/gpt-4o-mini',
    webhookToken: process.env.META_VERIFY_TOKEN ? '✅ Configurado' : '❌ Falta configurar',
    metaToken: process.env.META_PAGE_ACCESS_TOKEN && !process.env.META_PAGE_ACCESS_TOKEN.startsWith('EAAxx') ? '✅ Configurado' : '❌ Falta configurar',
    openrouterKey: process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.startsWith('sk-or-v1-xxx') ? '✅ Configurado' : '❌ Falta configurar',
    activeConversations: conversations.size,
  });
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
