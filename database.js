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
  `);

  console.log('Database initialized successfully.');
  return db;
}

module.exports = { initDb };
