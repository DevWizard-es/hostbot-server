const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { Pool } = require('pg');
const path = require('path');

let dbInstance = null;

async function initDb() {
  if (dbInstance) return dbInstance;

  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    console.log('🚀 DATABASE MODE: PostgreSQL (Persistent)');
    const pool = new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false }
    });

    // Wrapper to mimic SQLite interface over PostgreSQL
    dbInstance = {
      exec: async (sql) => {
        // Simple conversion for multi-line SQL
        const pgSql = sql
          .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
          .replace(/DATETIME DEFAULT CURRENT_TIMESTAMP/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
          .replace(/BOOLEAN DEFAULT 1/gi, 'BOOLEAN DEFAULT TRUE')
          .replace(/BOOLEAN DEFAULT 0/gi, 'BOOLEAN DEFAULT FALSE');
        return pool.query(pgSql);
      },
      get: async (sql, params = []) => {
        const pgSql = sql.replace(/\?/g, (_, i) => `$${i + 1}`);
        const res = await pool.query(pgSql, params);
        return res.rows[0];
      },
      all: async (sql, params = []) => {
        const pgSql = sql.replace(/\?/g, (_, i) => `$${i + 1}`);
        const res = await pool.query(pgSql, params);
        return res.rows;
      },
      run: async (sql, params = []) => {
        const pgSql = sql.replace(/\?/g, (_, i) => `$${i + 1}`);
        return pool.query(pgSql, params);
      }
    };
  } else {
    console.log('📦 DATABASE MODE: SQLite (Ephemeral)');
    const db = await open({
      filename: path.join(__dirname, 'atendia.sqlite'),
      driver: sqlite3.Database
    });
    dbInstance = db;
  }

  // Common Table Creation
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      name TEXT,
      type TEXT,
      phone TEXT,
      address TEXT,
      schedule TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_configs (
      id SERIAL PRIMARY KEY,
      business_id INTEGER,
      agent_name TEXT,
      tone TEXT,
      instructions TEXT,
      active BOOLEAN DEFAULT TRUE,
      take_orders BOOLEAN DEFAULT TRUE,
      manage_reservations BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS menus (
      id SERIAL PRIMARY KEY,
      business_id INTEGER,
      category TEXT,
      name TEXT,
      description TEXT,
      price DECIMAL(10,2),
      available BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS biolinks (
      id SERIAL PRIMARY KEY,
      business_id INTEGER,
      slug TEXT UNIQUE,
      display_name TEXT,
      description TEXT,
      color TEXT,
      btn_chat BOOLEAN DEFAULT TRUE,
      btn_menu BOOLEAN DEFAULT TRUE,
      btn_res BOOLEAN DEFAULT TRUE,
      btn_map BOOLEAN DEFAULT TRUE,
      btn_shop BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      business_id INTEGER,
      platform TEXT,
      identifier TEXT,
      status TEXT,
      token TEXT
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      business_id INTEGER,
      customer_name TEXT,
      party_size TEXT,
      res_time TEXT,
      status TEXT DEFAULT 'pending',
      channel TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Extra migrations (graceful fail)
  try { await dbInstance.run('ALTER TABLE agent_configs ADD COLUMN take_orders BOOLEAN DEFAULT TRUE;'); } catch (e) { }
  try { await dbInstance.run('ALTER TABLE agent_configs ADD COLUMN manage_reservations BOOLEAN DEFAULT TRUE;'); } catch (e) { }

  console.log('Database initialized successfully.');
  return dbInstance;
}

module.exports = { initDb };
