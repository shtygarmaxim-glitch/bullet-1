const Database = require('better-sqlite3');
const db = new Database('data.sqlite');

db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prize TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  winners_count INTEGER NOT NULL,
  blanks_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  turn_user_id TEXT,
  target_user_id TEXT,
  remaining_place INTEGER,
  chamber TEXT,
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  turn_started_at INTEGER
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id INTEGER NOT NULL REFERENCES battles(id),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  alive INTEGER NOT NULL DEFAULT 1,
  place INTEGER,
  join_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id INTEGER NOT NULL REFERENCES battles(id),
  text TEXT NOT NULL,
  cls TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  avatar TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS allowed_creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
`);

// Миграции: добавляем отсутствующие колонки
try {
  const tableInfo = db.pragma("table_info(battles)");
  const columns = tableInfo.map(col => col.name);
  
  if (!columns.includes('turn_started_at')) {
    db.exec(`ALTER TABLE battles ADD COLUMN turn_started_at INTEGER;`);
    console.log('✅ Добавлена колонка turn_started_at');
  }
  
  if (!columns.includes('target_user_id')) {
    db.exec(`ALTER TABLE battles ADD COLUMN target_user_id TEXT;`);
    console.log('✅ Добавлена колонка target_user_id');
  }
  
  if (!columns.includes('remaining_place')) {
    db.exec(`ALTER TABLE battles ADD COLUMN remaining_place INTEGER;`);
    console.log('✅ Добавлена колонка remaining_place');
  }
  
} catch (e) {
  console.error('⚠️  Ошибка при миграции базы данных:', e.message);
}

module.exports = db;
