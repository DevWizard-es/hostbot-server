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
  res.json({ biz, agentConfig });
});

// UPDATE config
router.post('/config', authenticateToken, async (req, res) => {
  const db = await initDb();
  const { bizName, bizAddress, bizSchedule, bizPhone, agentName, tone, instructions } = req.body;

  try {
    await db.run(`UPDATE businesses SET name = COALESCE(?, name), address = COALESCE(?, address), schedule = COALESCE(?, schedule), phone = COALESCE(?, phone) WHERE user_id = ?`, 
      [bizName, bizAddress, bizSchedule, bizPhone, req.user.userId]);
      
    if (agentName || tone || instructions) {
      await db.run('UPDATE agent_configs SET agent_name = COALESCE(?, agent_name), tone = COALESCE(?, tone), instructions = COALESCE(?, instructions) WHERE business_id = ?',
        [agentName, tone, instructions, req.user.bizId]);
    }
    res.json({ success: true });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Internal Error' });
  }
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
  const menuArray = req.body.menu; // [{category, name, description, price, available}]
  
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

module.exports = router;
