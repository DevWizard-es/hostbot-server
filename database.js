const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let db;

async function initDb() {
  if (db) return db;

  db = await open({
    filename: path.join(__dirname, 'atendia.sqlite'),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      type TEXT,
      phone TEXT,
      address TEXT,
      schedule TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS agent_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER,
      agent_name TEXT,
      tone TEXT,
      instructions TEXT,
      active BOOLEAN DEFAULT 1,
      FOREIGN KEY(business_id) REFERENCES businesses(id)
    );

    CREATE TABLE IF NOT EXISTS menus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER,
      category TEXT,
      name TEXT,
      description TEXT,
      price DECIMAL(10,2),
      available BOOLEAN DEFAULT 1,
      FOREIGN KEY(business_id) REFERENCES businesses(id)
    );

    CREATE TABLE IF NOT EXISTS biolinks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER,
      slug TEXT UNIQUE,
      display_name TEXT,
      description TEXT,
      color TEXT,
      btn_chat BOOLEAN DEFAULT 1,
      btn_menu BOOLEAN DEFAULT 1,
      btn_res BOOLEAN DEFAULT 1,
      btn_map BOOLEAN DEFAULT 1,
      btn_shop BOOLEAN DEFAULT 0,
      FOREIGN KEY(business_id) REFERENCES businesses(id)
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER,
      platform TEXT,
      identifier TEXT,
      status TEXT,
      token TEXT,
      FOREIGN KEY(business_id) REFERENCES businesses(id)
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER,
      customer_name TEXT,
      party_size TEXT,
      res_time TEXT,
      status TEXT DEFAULT 'pending',
      channel TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(business_id) REFERENCES businesses(id)
    );
  `);

  // Migrations for existing DBs
  try { await db.exec('ALTER TABLE agent_configs ADD COLUMN take_orders BOOLEAN DEFAULT 1;'); } catch(e) {}
  try { await db.exec('ALTER TABLE agent_configs ADD COLUMN manage_reservations BOOLEAN DEFAULT 1;'); } catch(e) {}


  console.log('Database initialized successfully.');
  return db;
}

module.exports = { initDb };
