import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "polymarket.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialised. Call initDb() first.");
  }
  return db;
}

export function initDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  applySchema(db);
  migrate(db);
  return db;
}

/** Idempotent migrations for columns added after the initial schema. */
function migrate(db: Database.Database): void {
  const marketCols = (
    db.prepare(`PRAGMA table_info(markets)`).all() as Array<{ name: string }>
  ).map((r) => r.name);

  if (!marketCols.includes("clob_token_id")) {
    db.exec(`ALTER TABLE markets ADD COLUMN clob_token_id TEXT NOT NULL DEFAULT ''`);
  }

  const groupCols = (
    db.prepare(`PRAGMA table_info(groups)`).all() as Array<{ name: string }>
  ).map((r) => r.name);

  if (!groupCols.includes("bucket_key")) {
    db.exec(`ALTER TABLE groups ADD COLUMN bucket_key TEXT NOT NULL DEFAULT ''`);
  }
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      description         TEXT NOT NULL DEFAULT '',
      resolution_condition TEXT NOT NULL DEFAULT '',
      category            TEXT NOT NULL DEFAULT '',
      clob_token_id       TEXT NOT NULL DEFAULT '',
      metadata_hash       TEXT NOT NULL,
      last_seen_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id            TEXT PRIMARY KEY,
      mismatch_type INTEGER NOT NULL,
      market_ids    TEXT NOT NULL,   -- JSON array of market IDs
      confidence    REAL NOT NULL,
      grouped_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mismatches (
      id            TEXT PRIMARY KEY,
      group_id      TEXT NOT NULL,
      mismatch_type INTEGER NOT NULL,
      market_ids    TEXT NOT NULL,   -- JSON array of market IDs
      prices        TEXT NOT NULL,   -- JSON object/array of prices
      magnitude     REAL NOT NULL,
      profitable    INTEGER NOT NULL DEFAULT 0,  -- boolean (0/1)
      detected_at   TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );
  `);
}
