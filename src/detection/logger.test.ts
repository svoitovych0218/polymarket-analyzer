import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

vi.mock("../db/schema", () => ({ getDb: vi.fn() }));

import { getDb } from "../db/schema";
import { logMismatch } from "./logger";
import type { MismatchResult, Group } from "./detectors";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: "group-1",
    mismatch_type: 3,
    market_ids: ["m1", "m2"],
    confidence: 0.9,
    ...overrides,
  };
}

function makeResult(magnitude: number): MismatchResult {
  return {
    violated: true,
    magnitude,
    details: { m1: 0.6, m2: 0.6 },
  };
}

function makeDb() {
  const run = vi.fn();
  return {
    prepare: vi.fn(() => ({ run })),
    _run: run,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("logMismatch", () => {
  let tmpDir: string;
  let logPath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mismatch-test-"));
    logPath = path.join(tmpDir, "mismatches.ndjson");
    originalEnv = process.env.MISMATCH_LOG_PATH;
    process.env.MISMATCH_LOG_PATH = logPath;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MISMATCH_LOG_PATH;
    else process.env.MISMATCH_LOG_PATH = originalEnv;
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("writes one NDJSON line per call", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    logMismatch(makeResult(0.1), makeGroup(), new Map([["m1", "Market A"], ["m2", "Market B"]]));

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.mismatch_type).toBe(3);
    expect(entry.market_ids).toEqual(["m1", "m2"]);
    expect(entry.magnitude).toBe(0.1);
  });

  it("appends across multiple calls (does not overwrite)", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    logMismatch(makeResult(0.1), makeGroup(), new Map());
    logMismatch(makeResult(0.2), makeGroup(), new Map());
    logMismatch(makeResult(0.3), makeGroup(), new Map());

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("includes market_titles in the log entry", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    const titles = new Map([["m1", "Will BTC hit $100k?"], ["m2", "Will BTC stay below $100k?"]]);
    logMismatch(makeResult(0.1), makeGroup(), titles);

    const entry = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(entry.market_titles).toEqual({
      m1: "Will BTC hit $100k?",
      m2: "Will BTC stay below $100k?",
    });
  });

  it("sets profitable=true when magnitude > 0.05", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    logMismatch(makeResult(0.06), makeGroup(), new Map());

    const entry = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(entry.profitable).toBe(true);
  });

  it("sets profitable=false when magnitude <= 0.05", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    logMismatch(makeResult(0.05), makeGroup(), new Map());

    const entry = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(entry.profitable).toBe(false);
  });

  it("includes prices from MismatchResult details", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    logMismatch(makeResult(0.1), makeGroup(), new Map());

    const entry = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(entry.prices).toEqual({ m1: 0.6, m2: 0.6 });
  });

  it("inserts into SQLite with correct fields", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    logMismatch(makeResult(0.08), makeGroup(), new Map());

    expect(db._run).toHaveBeenCalledOnce();
    const runArgs = db._run.mock.calls[0][0] as Record<string, unknown>;
    expect(runArgs.group_id).toBe("group-1");
    expect(runArgs.mismatch_type).toBe(3);
    expect(runArgs.magnitude).toBe(0.08);
    expect(runArgs.profitable).toBe(1); // stored as integer
    expect(JSON.parse(runArgs.market_ids as string)).toEqual(["m1", "m2"]);
  });

  it("stores profitable=0 in SQLite when not profitable", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    logMismatch(makeResult(0.03), makeGroup(), new Map());

    const runArgs = db._run.mock.calls[0][0] as Record<string, unknown>;
    expect(runArgs.profitable).toBe(0);
  });

  it("includes detected_at timestamp in ISO format", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    logMismatch(makeResult(0.1), makeGroup(), new Map());

    const entry = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(entry.detected_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("works for all mismatch types without type-specific logic", () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    for (const mismatch_type of [1, 2, 3, 4, 5, 6]) {
      logMismatch(
        makeResult(0.1),
        makeGroup({ mismatch_type, market_ids: ["m1", "m2"] }),
        new Map()
      );
    }

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    const types = lines.map((l) => JSON.parse(l).mismatch_type);
    expect(types).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
