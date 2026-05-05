import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { queryGroups } from "./groups-repo";

// ── Schema helpers ────────────────────────────────────────────────────────────

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE groups (
      id            TEXT PRIMARY KEY,
      mismatch_type INTEGER NOT NULL,
      market_ids    TEXT NOT NULL,
      confidence    REAL NOT NULL,
      grouped_at    TEXT NOT NULL,
      bucket_key    TEXT NOT NULL DEFAULT '',
      reasoning     TEXT NOT NULL DEFAULT ''
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

function insertGroup(
  db: Database.Database,
  opts: {
    id: string;
    mismatch_type?: number;
    market_ids?: string[];
    confidence?: number;
    grouped_at?: string;
    bucket_key?: string;
    reasoning?: string;
  }
): void {
  db.prepare(
    `INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.mismatch_type ?? 1,
    JSON.stringify(opts.market_ids ?? ["m1", "m2"]),
    opts.confidence ?? 0.9,
    opts.grouped_at ?? "2025-01-01T00:00:00.000Z",
    opts.bucket_key ?? "crypto:BTC",
    opts.reasoning ?? ""
  );
}

function insertMismatch(
  db: Database.Database,
  opts: {
    id: string;
    group_id: string;
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
    JSON.stringify(["m1", "m2"]),
    JSON.stringify({ m1: 0.6, m2: 0.6 }),
    opts.magnitude ?? 0.1,
    opts.profitable ? 1 : 0,
    opts.detected_at ?? "2025-01-01T12:00:00.000Z"
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("queryGroups", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it("returns empty result when no groups exist", () => {
    const result = queryGroups(db, {});
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
  });

  it("returns all groups with correct shape", () => {
    insertGroup(db, { id: "g1", mismatch_type: 3, confidence: 0.85, bucket_key: "crypto:ETH", reasoning: "Strict complements." });
    insertMismatch(db, { id: "mm1", group_id: "g1", magnitude: 0.12, profitable: true });

    const result = queryGroups(db, {});
    expect(result.total).toBe(1);
    const row = result.data[0];
    expect(row.id).toBe("g1");
    expect(row.mismatch_type).toBe(3);
    expect(row.mismatch_type_label).toBe("Type 3 — Complementary Outcome");
    expect(row.confidence).toBe(0.85);
    expect(row.bucket_key).toBe("crypto:ETH");
    expect(row.reasoning).toBe("Strict complements.");
    expect(row.market_count).toBe(2);
    expect(row.latest_magnitude).toBeCloseTo(0.12);
    expect(row.latest_profitable).toBe(true);
    expect(row.latest_detected_at).toBe("2025-01-01T12:00:00.000Z");
  });

  it("returns reasoning correctly including empty string for legacy groups", () => {
    insertGroup(db, { id: "g1", reasoning: "Price ordering must hold." });
    insertGroup(db, { id: "g2" }); // no reasoning — defaults to ''

    const result = queryGroups(db, {});
    const g1 = result.data.find((r) => r.id === "g1")!;
    const g2 = result.data.find((r) => r.id === "g2")!;
    expect(g1.reasoning).toBe("Price ordering must hold.");
    expect(g2.reasoning).toBe("");
  });

  it("returns null mismatch fields when group has no mismatches", () => {
    insertGroup(db, { id: "g1" });

    const result = queryGroups(db, {});
    expect(result.total).toBe(1);
    const row = result.data[0];
    expect(row.latest_magnitude).toBeNull();
    expect(row.latest_profitable).toBeNull();
    expect(row.latest_detected_at).toBeNull();
  });

  it("returns latest mismatch when multiple mismatches exist", () => {
    insertGroup(db, { id: "g1" });
    insertMismatch(db, {
      id: "mm1",
      group_id: "g1",
      magnitude: 0.05,
      detected_at: "2025-01-01T10:00:00.000Z",
    });
    insertMismatch(db, {
      id: "mm2",
      group_id: "g1",
      magnitude: 0.20,
      profitable: true,
      detected_at: "2025-01-02T10:00:00.000Z",
    });

    const result = queryGroups(db, {});
    expect(result.data[0].latest_magnitude).toBeCloseTo(0.20);
    expect(result.data[0].latest_profitable).toBe(true);
  });

  it("filters by mismatch type", () => {
    insertGroup(db, { id: "g1", mismatch_type: 1 });
    insertGroup(db, { id: "g2", mismatch_type: 2 });
    insertGroup(db, { id: "g3", mismatch_type: 1 });

    const result = queryGroups(db, { type: 1 });
    expect(result.total).toBe(2);
    expect(result.data.every((r) => r.mismatch_type === 1)).toBe(true);
  });

  it("filters profitable-only groups", () => {
    insertGroup(db, { id: "g1" });
    insertGroup(db, { id: "g2" });
    insertMismatch(db, { id: "mm1", group_id: "g1", profitable: true, magnitude: 0.10 });
    insertMismatch(db, { id: "mm2", group_id: "g2", profitable: false, magnitude: 0.02 });

    const result = queryGroups(db, { profitable: true });
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe("g1");
  });

  it("sorts by magnitude descending", () => {
    insertGroup(db, { id: "g1" });
    insertGroup(db, { id: "g2" });
    insertGroup(db, { id: "g3" });
    insertMismatch(db, { id: "mm1", group_id: "g1", magnitude: 0.10 });
    insertMismatch(db, { id: "mm2", group_id: "g2", magnitude: 0.30 });
    insertMismatch(db, { id: "mm3", group_id: "g3", magnitude: 0.05 });

    const result = queryGroups(db, { sortBy: "magnitude", sortDir: "desc" });
    const magnitudes = result.data
      .filter((r) => r.latest_magnitude !== null)
      .map((r) => r.latest_magnitude as number);
    expect(magnitudes[0]).toBeGreaterThan(magnitudes[1]);
    expect(magnitudes[1]).toBeGreaterThan(magnitudes[2]);
  });

  it("sorts by magnitude ascending", () => {
    insertGroup(db, { id: "g1" });
    insertGroup(db, { id: "g2" });
    insertMismatch(db, { id: "mm1", group_id: "g1", magnitude: 0.20 });
    insertMismatch(db, { id: "mm2", group_id: "g2", magnitude: 0.05 });

    const result = queryGroups(db, { sortBy: "magnitude", sortDir: "asc" });
    const magnitudes = result.data
      .filter((r) => r.latest_magnitude !== null)
      .map((r) => r.latest_magnitude as number);
    expect(magnitudes[0]).toBeLessThan(magnitudes[1]);
  });

  it("paginates results correctly", () => {
    for (let i = 1; i <= 5; i++) {
      insertGroup(db, { id: `g${i}` });
    }

    const page1 = queryGroups(db, { page: 1, pageSize: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(2);

    const page2 = queryGroups(db, { page: 2, pageSize: 2 });
    expect(page2.data).toHaveLength(2);

    const page3 = queryGroups(db, { page: 3, pageSize: 2 });
    expect(page3.data).toHaveLength(1);
  });

  it("combines type filter with profitable filter", () => {
    insertGroup(db, { id: "g1", mismatch_type: 1 });
    insertGroup(db, { id: "g2", mismatch_type: 2 });
    insertGroup(db, { id: "g3", mismatch_type: 1 });
    insertMismatch(db, { id: "mm1", group_id: "g1", profitable: true, magnitude: 0.10 });
    insertMismatch(db, { id: "mm2", group_id: "g2", profitable: true, magnitude: 0.15 });
    insertMismatch(db, { id: "mm3", group_id: "g3", profitable: false, magnitude: 0.02 });

    const result = queryGroups(db, { type: 1, profitable: true });
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe("g1");
  });

  it("defaults to page 1 and pageSize 50", () => {
    insertGroup(db, { id: "g1" });

    const result = queryGroups(db, {});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
  });
});
