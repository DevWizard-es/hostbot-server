const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initDb } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'atendia12345secret';

// Helper for auth validation
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Denegado. Token no presente.' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

// ========================
// AUTHENTICATION
// ========================

// SIGNUP
router.post('/auth/register', async (req, res) => {
  try {
    const { email, password, bizName, bizType } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const db = await initDb();
    const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUser) return res.status(400).json({ error: 'El usuario ya existe' });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
    const userId = result.lastID;

    // Create Business
    const bizResult = await db.run('INSERT INTO businesses (user_id, name, type) VALUES (?, ?, ?)', [userId, bizName || 'Mi Negocio', bizType || '🍽️ Restaurante']);
    
    // Create initial generic agent config
    await db.run('INSERT INTO agent_configs (business_id, agent_name, tone, instructions) VALUES (?, ?, ?, ?)', 
      [bizResult.lastID, 'Asistente IA', 'Amigable', 'Siempre saludar cordialmente y ofrecer ayuda.']);

    // Generate token
    const token = jwt.sign({ userId, email, bizId: bizResult.lastID }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, userId });
  } catch(error) {
    console.error(error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// LOGIN
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const db = await initDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(400).json({ error: 'Credenciales inválidas' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Credenciales inválidas' });

    const biz = await db.get('SELECT id FROM businesses WHERE user_id = ?', [user.id]);
    
    const token = jwt.sign({ userId: user.id, email, bizId: biz?.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { email } });
  } catch(error) {
    console.error(error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ========================
// CONFIGURATION API
// ========================

// GET User & Business config
router.get('/config', authenticateToken, async (req, res) => {
  const db = await initDb();
  const biz = await db.get('SELECT * FROM businesses WHERE user_id = ?', [req.user.userId]);
  if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });

  const agentConfig = await db.get('SELECT * FROM agent_configs WHERE business_id = ?', [biz.id]);
  
  // Real KPI count for reservations
  const resCount = await db.get('SELECT COUNT(*) as c FROM reservations WHERE business_id = ?', [biz.id]);
  
  res.json({ 
    biz, 
    agentConfig, 
    userEmail: req.user.email,
    kpis: {
      messages: 0,
      orders: 0,
      reservations: resCount.c || 0
    }
  });
});

// UPDATE config
router.post('/config', authenticateToken, async (req, res) => {
  const db = await initDb();
  const { bizName, bizAddress, bizSchedule, bizPhone, agentName, tone, instructions, active, take_orders, manage_reservations } = req.body;

  try {
    await db.run(`UPDATE businesses SET name = COALESCE(?, name), address = COALESCE(?, address), schedule = COALESCE(?, schedule), phone = COALESCE(?, phone) WHERE user_id = ?`, 
      [bizName, bizAddress, bizSchedule, bizPhone, req.user.userId]);
      
    if (agentName !== undefined || tone !== undefined || instructions !== undefined || active !== undefined) {
      await db.run('UPDATE agent_configs SET agent_name = COALESCE(?, agent_name), tone = COALESCE(?, tone), instructions = COALESCE(?, instructions), active = COALESCE(?, active), take_orders = COALESCE(?, take_orders), manage_reservations = COALESCE(?, manage_reservations) WHERE business_id = ?',
        [agentName, tone, instructions, active !== undefined ? (active ? 1 : 0) : null, take_orders !== undefined ? (take_orders ? 1 : 0) : null, manage_reservations !== undefined ? (manage_reservations ? 1 : 0) : null, req.user.bizId]);
    }
    res.json({ success: true });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Error' });
  }
});

// ========================
// BIOLINK API
// ========================
router.get('/biolink', authenticateToken, async (req, res) => {
  const db = await initDb();
  let biolink = await db.get('SELECT * FROM biolinks WHERE business_id = ?', [req.user.bizId]);
  if (!biolink) {
    const defaultSlug = 'negocio-' + req.user.bizId;
    await db.run('INSERT INTO biolinks (business_id, slug, display_name) VALUES (?, ?, ?)', [req.user.bizId, defaultSlug, 'Mi Negocio']);
    biolink = await db.get('SELECT * FROM biolinks WHERE business_id = ?', [req.user.bizId]);
  }
  res.json(biolink);
});

router.post('/biolink', authenticateToken, async (req, res) => {
  const db = await initDb();
  const { slug, display_name, description, color, btn_chat, btn_menu, btn_res, btn_map, btn_shop } = req.body;
  try {
    const check = await db.get('SELECT id FROM biolinks WHERE slug = ? AND business_id != ?', [slug, req.user.bizId]);
    if (check) return res.status(400).json({ error: 'Ese enlace ya está en uso' });

    await db.run(`UPDATE biolinks SET slug = ?, display_name = ?, description = ?, color = ?, btn_chat = ?, btn_menu = ?, btn_res = ?, btn_map = ?, btn_shop = ? WHERE business_id = ?`,
      [slug, display_name, description, color, btn_chat?1:0, btn_menu?1:0, btn_res?1:0, btn_map?1:0, btn_shop?1:0, req.user.bizId]);
    res.json({ success: true });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/biolink/:slug', async (req, res) => {
  const db = await initDb();
  const biolink = await db.get('SELECT * FROM biolinks WHERE slug = ?', [req.params.slug]);
  if (!biolink) return res.status(404).json({ error: 'No encontrado' });
  res.json(biolink);
});

// ========================
// RESERVATIONS API
// ========================
router.get('/reservations', authenticateToken, async (req, res) => {
  const db = await initDb();
  const reservations = await db.all('SELECT * FROM reservations WHERE business_id = ? ORDER BY id DESC LIMIT 50', [req.user.bizId]);
  res.json(reservations);
});

router.post('/reservations/:id/status', authenticateToken, async (req, res) => {
  const db = await initDb();
  const { status } = req.body;
  await db.run('UPDATE reservations SET status = ? WHERE id = ? AND business_id = ?', [status, req.params.id, req.user.bizId]);
  res.json({ success: true });
});

router.post('/reservations/mock', authenticateToken, async (req, res) => {
  const db = await initDb();
  await db.run('INSERT INTO reservations (business_id, customer_name, party_size, res_time, status, channel) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.bizId, req.body.name || 'Cliente Prueba', req.body.size || '2 pax', req.body.time || '20:00', 'pending', 'Web']);
  res.json({ success: true });
});

// ========================
// CHANNELS API
// ========================
router.get('/channels', authenticateToken, async (req, res) => {
  const db = await initDb();
  const channels = await db.all('SELECT * FROM channels WHERE business_id = ?', [req.user.bizId]);
  res.json(channels);
});

router.post('/channels', authenticateToken, async (req, res) => {
  const db = await initDb();
  const { platform, identifier, status } = req.body;
  const exists = await db.get('SELECT id FROM channels WHERE business_id = ? AND platform = ?', [req.user.bizId, platform]);
  
  if (exists) {
    await db.run('UPDATE channels SET identifier = ?, status = ? WHERE id = ?', [identifier, status, exists.id]);
  } else {
    await db.run('INSERT INTO channels (business_id, platform, identifier, status) VALUES (?, ?, ?, ?)', [req.user.bizId, platform, identifier, status]);
  }
  res.json({ success: true });
});

// ========================
// MENU API
// ========================

router.get('/menu', authenticateToken, async (req, res) => {
  const db = await initDb();
  const menu = await db.all('SELECT * FROM menus WHERE business_id = ?', [req.user.bizId]);
  res.json(menu);
});

router.post('/menu', authenticateToken, async (req, res) => {
  const db = await initDb();
  const menuArray = req.body.menu;
  
  if (!menuArray || !Array.isArray(menuArray)) return res.status(400).json({ error: 'Formato de menú inválido' });

  try {
    await db.run('DELETE FROM menus WHERE business_id = ?', [req.user.bizId]);
    for (const item of menuArray) {
      await db.run('INSERT INTO menus (business_id, category, name, description, price, available) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.bizId, item.category || 'General', item.name, item.description, item.price, item.available ? 1 : 0]);
    }
    res.json({ success: true });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Error' });
  }
});

// ========================
// PUBLIC ROUTES
// ========================

router.get('/public/menu/:slug', async (req, res) => {
  const db = await initDb();
  const biolink = await db.get('SELECT business_id, display_name as bizName, color FROM biolinks WHERE slug = ?', [req.params.slug]);
  if (!biolink) return res.status(404).json({error: 'Not found'});
  
  const menu = await db.all('SELECT * FROM menus WHERE business_id = ? AND available = 1', [biolink.business_id]);
  
  // Agrupar por categoría
  const grouped = {};
  menu.forEach(item => {
    const cat = item.category || 'General';
    if (!grouped[cat]) grouped[cat] = { category: cat, items: [] };
    grouped[cat].items.push(item);
  });
  
  res.json({ bizName: biolink.bizName, color: biolink.color, menu: Object.values(grouped) });
});

router.post('/public/chat', async (req, res) => {
  const { slug, text } = req.body;
  const db = await initDb();
  
  const biolink = await db.get('SELECT business_id FROM biolinks WHERE slug = ?', [slug]);
  if (!biolink) return res.status(404).json({reply: 'Negocio no encontrado.'});

  let биз = await db.get('SELECT * FROM businesses WHERE id = ?', [biolink.business_id]);
  const agentConfig = await db.get('SELECT * FROM agent_configs WHERE business_id = ?', [биз.id]);
  if (!agentConfig || !agentConfig.active) return res.json({reply: 'El asistente de este negocio está apagado en este momento.'});

  const menu = await db.all('SELECT * FROM menus WHERE business_id = ? AND available = 1', [биз.id]);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('xxx')) return res.json({ reply: 'Sistema IA desactivado por el negocio.' });

  const agentName = agentConfig.agent_name || 'Asistente';
  const tone = agentConfig.tone || 'Amigable';
  const instructions = agentConfig.instructions || '';
  let menuText = '';
  if (menu && menu.length > 0) {
    menuText = 'MENÚ:\n' + menu.map(item => `- ${item.name} (${item.price}€): ${item.description || ''}`).join('\n');
  }

  const sysPrompt = `Eres ${agentName}, el asistente virtual de ${биз.name}.
Tono: ${tone}.
INFO NEGOCIO: ${биз.address || ''}, Horario: ${биз.schedule || ''}.
Instrucciones: ${instructions}.
${menuText}`;

  try {
    const aiRes = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: process.env.AI_MODEL || 'google/gemini-2.0-flash-exp:free', // Use highly available free endpoint
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: text || 'Hola' }
      ],
      max_tokens: 300,
      temperature: 0.7
    }, { headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, timeout: 10000 });
    
    res.json({ reply: aiRes.data.choices[0]?.message?.content || 'No pude procesar tu mensaje.' });
  } catch(e) {
    console.error('Public chat error:', e.message);
    res.json({ reply: '❌ La IA está experimentando problemas. Intenta más tarde.' });
  }
});

router.post('/public/reservations', async (req, res) => {
  const db = await initDb();
  const { slug, name, size, time } = req.body;
  if (!slug || !name || !size || !time) return res.status(400).json({error: 'Faltan campos'});

  const biolink = await db.get('SELECT business_id FROM biolinks WHERE slug = ?', [slug]);
  if (!biolink) return res.status(404).json({error: 'Enlace no valido'});

  try {
    await db.run('INSERT INTO reservations (business_id, customer_name, party_size, res_time, status, channel) VALUES (?, ?, ?, ?, ?, ?)',
      [biolink.business_id, name, size, time, 'pending', 'Web Biolink']);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({error: 'Error guardando reserva'});
  }
});

// ========================
// AI CHAT TEST
// ========================
const axios = require('axios');

router.post('/chat-test', authenticateToken, async (req, res) => {
  try {
    const db = await initDb();
    const { text } = req.body;
    
    let биз = await db.get('SELECT * FROM businesses WHERE user_id = ?', [req.user.userId]);
    // Fallback if business not created yet
    const biz = биз || { id: -1, name: 'Negocio de Prueba', address: 'Sin dirección', schedule: 'Sin horario' };
    
    const agentConfig = biz.id !== -1 ? await db.get('SELECT * FROM agent_configs WHERE business_id = ?', [biz.id]) : null;
    const menu = biz.id !== -1 ? await db.all('SELECT * FROM menus WHERE business_id = ? AND available = 1', [biz.id]) : [];

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey.includes('xxx')) {
      return res.json({ reply: '⚠️ Modo Simulación: La API Key de OpenRouter no ha sido reemplazada. Ve a Render y pega tu propia OPENROUTER_API_KEY.' });
    }

    const agentName = (agentConfig && agentConfig.agent_name) ? agentConfig.agent_name : 'Asistente';
    const tone = (agentConfig && agentConfig.tone) ? agentConfig.tone : 'Amigable';
    const instructions = (agentConfig && agentConfig.instructions) ? agentConfig.instructions : 'Si te preguntan algo fuera de lo normal, responde amablemente.';

    let menuText = '';
    if (menu && menu.length > 0) {
      menuText = 'MENÚ:\n';
      menu.forEach(item => {
        menuText += `- ${item.name} (${item.price}€): ${item.description || ''}\n`;
      });
    }

    const sysPrompt = `Eres ${agentName}, el asistente virtual de ${biz.name}.
Tono: ${tone}.
INFO NEGOCIO: ${biz.address || 'Consultar dirección'}, Horario: ${biz.schedule || 'Consultar horario'}.
Instrucciones extra: ${instructions}.
${menuText}`;

    const aiRes = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: process.env.AI_MODEL || 'openrouter/auto',
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: text || 'Hola' }
      ],
      max_tokens: 300,
      temperature: 0.7
    }, {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      timeout: 10000 
    });

    const aiMessage = aiRes.data.choices[0]?.message?.content || 'Error procesando respuesta del motor.';
    res.json({ reply: aiMessage });
    
  } catch(e) {
    console.error('Chat test error:', e.response?.data || e.message || e);
    // Return graceful JSON to avoid 500 error crashing frontend
    res.json({ reply: '❌ Error al contactar con la IA: ' + (e.response?.data?.error?.message || e.message) });
  }
});

module.exports = router;
