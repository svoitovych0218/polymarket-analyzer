import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

// Re-implement the schema/migration logic here so tests run against an
// in-memory database without touching the real DB_PATH.
function buildColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name
  );
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
      market_ids    TEXT NOT NULL,
      confidence    REAL NOT NULL,
      grouped_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mismatches (
      id            TEXT PRIMARY KEY,
      group_id      TEXT NOT NULL,
      mismatch_type INTEGER NOT NULL,
      market_ids    TEXT NOT NULL,
      prices        TEXT NOT NULL,
      magnitude     REAL NOT NULL,
      profitable    INTEGER NOT NULL DEFAULT 0,
      detected_at   TEXT NOT NULL,
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );
  `);
}

function migrate(db: Database.Database): void {
  const marketCols = buildColumns(db, "markets");

  if (!marketCols.includes("clob_token_id"))
    db.exec(`ALTER TABLE markets ADD COLUMN clob_token_id TEXT NOT NULL DEFAULT ''`);
  if (!marketCols.includes("event_id"))
    db.exec(`ALTER TABLE markets ADD COLUMN event_id TEXT NOT NULL DEFAULT ''`);
  if (!marketCols.includes("event_slug"))
    db.exec(`ALTER TABLE markets ADD COLUMN event_slug TEXT NOT NULL DEFAULT ''`);
  if (!marketCols.includes("neg_risk"))
    db.exec(`ALTER TABLE markets ADD COLUMN neg_risk INTEGER NOT NULL DEFAULT 0`);
  if (!marketCols.includes("group_item_title"))
    db.exec(`ALTER TABLE markets ADD COLUMN group_item_title TEXT NOT NULL DEFAULT ''`);
  if (!marketCols.includes("group_item_threshold"))
    db.exec(`ALTER TABLE markets ADD COLUMN group_item_threshold TEXT NOT NULL DEFAULT ''`);

  const groupCols = buildColumns(db, "groups");

  if (!groupCols.includes("bucket_key"))
    db.exec(`ALTER TABLE groups ADD COLUMN bucket_key TEXT NOT NULL DEFAULT ''`);
  if (!groupCols.includes("reasoning"))
    db.exec(`ALTER TABLE groups ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''`);
  if (!groupCols.includes("source"))
    db.exec(`ALTER TABLE groups ADD COLUMN source TEXT NOT NULL DEFAULT 'llm'`);
}

function initTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  migrate(db);
  return db;
}

describe("schema migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initTestDb();
  });

  it("markets table has all five new event-level columns", () => {
    const cols = buildColumns(db, "markets");
    expect(cols).toContain("event_id");
    expect(cols).toContain("event_slug");
    expect(cols).toContain("neg_risk");
    expect(cols).toContain("group_item_title");
    expect(cols).toContain("group_item_threshold");
  });

  it("groups table has the source column", () => {
    const cols = buildColumns(db, "groups");
    expect(cols).toContain("source");
  });

  it("source column defaults to 'llm' for existing rows", () => {
    db.prepare(
      `INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at)
       VALUES ('g1', 1, '[]', 0.9, '2026-01-01T00:00:00Z')`
    ).run();

    const row = db.prepare(`SELECT source FROM groups WHERE id = 'g1'`).get() as {
      source: string;
    };
    expect(row.source).toBe("llm");
  });

  it("neg_risk column defaults to 0", () => {
    db.prepare(
      `INSERT INTO markets (id, title, metadata_hash, last_seen_at)
       VALUES ('m1', 'Test', 'hash', '2026-01-01T00:00:00Z')`
    ).run();

    const row = db.prepare(`SELECT neg_risk FROM markets WHERE id = 'm1'`).get() as {
      neg_risk: number;
    };
    expect(row.neg_risk).toBe(0);
  });

  it("migrations are idempotent — running twice does not throw", () => {
    expect(() => migrate(db)).not.toThrow();
  });
});
