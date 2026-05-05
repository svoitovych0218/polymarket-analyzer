import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { getMarketsForGroup } from "./markets-repo";

// ── Schema helpers ────────────────────────────────────────────────────────────

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE markets (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      resolution_condition TEXT NOT NULL DEFAULT '',
      category      TEXT NOT NULL DEFAULT '',
      clob_token_id TEXT NOT NULL DEFAULT '',
      metadata_hash TEXT NOT NULL DEFAULT '',
      last_seen_at  TEXT NOT NULL
    );

    CREATE TABLE groups (
      id            TEXT PRIMARY KEY,
      mismatch_type INTEGER NOT NULL,
      market_ids    TEXT NOT NULL,
      confidence    REAL NOT NULL,
      grouped_at    TEXT NOT NULL,
      bucket_key    TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE mismatches (
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
  return db;
}

function insertMarket(
  db: Database.Database,
  opts: { id: string; title: string; category?: string; last_seen_at?: string }
): void {
  db.prepare(
    `INSERT INTO markets (id, title, category, last_seen_at, metadata_hash)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.title,
    opts.category ?? "Crypto",
    opts.last_seen_at ?? "2025-01-01T00:00:00.000Z",
    "hash"
  );
}

function insertGroup(
  db: Database.Database,
  opts: { id: string; market_ids: string[] }
): void {
  db.prepare(
    `INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(opts.id, 1, JSON.stringify(opts.market_ids), 0.9, "2025-01-01T00:00:00.000Z");
}

function insertMismatch(
  db: Database.Database,
  opts: {
    id: string;
    group_id: string;
    prices: Record<string, number>;
    magnitude?: number;
    profitable?: boolean;
    detected_at?: string;
  }
): void {
  db.prepare(
    `INSERT INTO mismatches (id, group_id, mismatch_type, market_ids, prices, magnitude, profitable, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.group_id,
    1,
    JSON.stringify(Object.keys(opts.prices)),
    JSON.stringify(opts.prices),
    opts.magnitude ?? 0.1,
    opts.profitable ? 1 : 0,
    opts.detected_at ?? "2025-01-01T12:00:00.000Z"
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getMarketsForGroup", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it("returns empty result for non-existent group", () => {
    const result = getMarketsForGroup(db, "nonexistent");
    expect(result.markets).toHaveLength(0);
    expect(result.mismatch_status).toBeNull();
  });

  it("returns markets enriched with latest prices", () => {
    insertMarket(db, { id: "m1", title: "Will BTC hit $100k?", category: "Crypto" });
    insertMarket(db, { id: "m2", title: "Will BTC stay below $100k?", category: "Crypto" });
    insertGroup(db, { id: "g1", market_ids: ["m1", "m2"] });
    insertMismatch(db, {
      id: "mm1",
      group_id: "g1",
      prices: { m1: 0.6, m2: 0.6 },
      magnitude: 0.2,
      profitable: true,
    });

    const result = getMarketsForGroup(db, "g1");

    expect(result.markets).toHaveLength(2);
    const m1 = result.markets.find((m) => m.id === "m1")!;
    expect(m1.title).toBe("Will BTC hit $100k?");
    expect(m1.price).toBeCloseTo(0.6);
    expect(m1.category).toBe("Crypto");

    const m2 = result.markets.find((m) => m.id === "m2")!;
    expect(m2.price).toBeCloseTo(0.6);
  });

  it("returns mismatch_status from the latest mismatch", () => {
    insertMarket(db, { id: "m1", title: "Market A", category: "Politics" });
    insertGroup(db, { id: "g1", market_ids: ["m1"] });
    insertMismatch(db, {
      id: "mm1",
      group_id: "g1",
      prices: { m1: 0.4 },
      magnitude: 0.06,
      profitable: true,
      detected_at: "2025-01-02T00:00:00.000Z",
    });

    const result = getMarketsForGroup(db, "g1");
    expect(result.mismatch_status).not.toBeNull();
    expect(result.mismatch_status!.magnitude).toBeCloseTo(0.06);
    expect(result.mismatch_status!.profitable).toBe(true);
    expect(result.mismatch_status!.detected_at).toBe("2025-01-02T00:00:00.000Z");
  });

  it("uses the most recent mismatch for prices when multiple exist", () => {
    insertMarket(db, { id: "m1", title: "Market A", category: "Crypto" });
    insertGroup(db, { id: "g1", market_ids: ["m1"] });
    insertMismatch(db, {
      id: "mm1",
      group_id: "g1",
      prices: { m1: 0.4 },
      detected_at: "2025-01-01T00:00:00.000Z",
    });
    insertMismatch(db, {
      id: "mm2",
      group_id: "g1",
      prices: { m1: 0.75 },
      detected_at: "2025-01-02T00:00:00.000Z",
    });

    const result = getMarketsForGroup(db, "g1");
    expect(result.markets[0].price).toBeCloseTo(0.75);
  });

  it("returns null price when market ID is not in prices JSON", () => {
    insertMarket(db, { id: "m1", title: "Market A", category: "Crypto" });
    insertMarket(db, { id: "m2", title: "Market B", category: "Crypto" });
    insertGroup(db, { id: "g1", market_ids: ["m1", "m2"] });
    // prices only contains m1
    insertMismatch(db, {
      id: "mm1",
      group_id: "g1",
      prices: { m1: 0.5 },
    });

    const result = getMarketsForGroup(db, "g1");
    const m2 = result.markets.find((m) => m.id === "m2")!;
    expect(m2.price).toBeNull();
  });

  it("returns null mismatch_status when group has no mismatches", () => {
    insertMarket(db, { id: "m1", title: "Market A", category: "Crypto" });
    insertGroup(db, { id: "g1", market_ids: ["m1"] });

    const result = getMarketsForGroup(db, "g1");
    expect(result.mismatch_status).toBeNull();
    expect(result.markets[0].price).toBeNull();
  });
});
