import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Shared mock for Anthropic messages.create — configured per-test via mockResolvedValueOnce
const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  // Must be a regular function so `new Anthropic()` works
  default: vi.fn(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock("../db/schema", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../db/schema";
import { groupBucket } from "./grouper";
import type { Market } from "../api/gamma";
import type { Bucket } from "./extractor";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMarket(id: string, title: string): Market {
  return {
    id,
    title,
    description: "",
    resolutionCondition: "",
    category: "Crypto",
    clobTokenId: "",
    metadataHash: "hash_" + id,
    lastSeenAt: new Date().toISOString(),
  };
}

function llmResponse(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function makeDb(existingGroups: unknown[] = []) {
  const insertedGroups: unknown[] = [];
  const updatedGroups = new Map<string, string>();

  return {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() =>
        sql.includes("FROM groups WHERE bucket_key") ? existingGroups : []
      ),
      run: vi.fn((...args: unknown[]) => {
        if (sql.includes("INSERT INTO groups")) insertedGroups.push(args);
        if (sql.includes("UPDATE groups SET market_ids"))
          updatedGroups.set(args[1] as string, args[0] as string);
      }),
    })),
    transaction: vi.fn((fn: () => void) => () => fn()),
    _insertedGroups: insertedGroups,
    _updatedGroups: updatedGroups,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("groupBucket — fresh bucket (no existing groups)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls LLM and inserts groups for a fresh bucket", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([{ mismatch_type: "threshold_ordering", market_ids: ["m1", "m2"], confidence: 0.9 }])
    );

    const bucket: Bucket = { category: "Crypto", entity: "BTC", marketIds: ["m1", "m2"] };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will BTC exceed $50k?")],
      ["m2", makeMarket("m2", "Will BTC exceed $100k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(db._insertedGroups).toHaveLength(1);
    expect(db._updatedGroups.size).toBe(0);
  });

  it("skips buckets with no changed markets", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);

    const bucket: Bucket = { category: "Crypto", entity: "BTC", marketIds: ["m1", "m2"] };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will BTC exceed $50k?")],
      ["m2", makeMarket("m2", "Will BTC exceed $100k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m99"]));

    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("groupBucket — existing groups (new market matching)", () => {
  beforeEach(() => vi.clearAllMocks());

  const existingGroupId = crypto.randomUUID();
  const existingGroups = [
    {
      id: existingGroupId,
      mismatch_type: 1, // threshold_ordering
      market_ids: JSON.stringify(["m1", "m2"]),
      confidence: 0.9,
      bucket_key: "Crypto::BTC",
    },
  ];

  it("appends new market to an existing group when LLM says join", async () => {
    const db = makeDb(existingGroups);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([{ market_id: "m3", action: "join", group_id: existingGroupId }])
    );

    const bucket: Bucket = { category: "Crypto", entity: "BTC", marketIds: ["m1", "m2", "m3"] };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will BTC exceed $50k?")],
      ["m2", makeMarket("m2", "Will BTC exceed $100k?")],
      ["m3", makeMarket("m3", "Will BTC exceed $150k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m3"]));

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(db._updatedGroups.has(existingGroupId)).toBe(true);
    expect(JSON.parse(db._updatedGroups.get(existingGroupId)!)).toContain("m3");
    expect(db._insertedGroups).toHaveLength(0);
  });

  it("creates a new group when LLM says new_group", async () => {
    const db = makeDb(existingGroups);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          market_id: "m3",
          action: "new_group",
          mismatch_type: "complementary",
          with_market_ids: ["m3", "m4"],
          confidence: 0.8,
        },
      ])
    );

    const bucket: Bucket = { category: "Crypto", entity: "BTC", marketIds: ["m1", "m2", "m3", "m4"] };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will BTC exceed $50k?")],
      ["m2", makeMarket("m2", "Will BTC exceed $100k?")],
      ["m3", makeMarket("m3", "Will BTC stay below $50k?")],
      ["m4", makeMarket("m4", "Will BTC not exceed $50k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m3"]));

    expect(db._insertedGroups).toHaveLength(1);
    expect(db._updatedGroups.size).toBe(0); // existing group untouched
  });

  it("does nothing when LLM says none", async () => {
    const db = makeDb(existingGroups);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([{ market_id: "m3", action: "none" }])
    );

    const bucket: Bucket = { category: "Crypto", entity: "BTC", marketIds: ["m1", "m2", "m3"] };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will BTC exceed $50k?")],
      ["m2", makeMarket("m2", "Will BTC exceed $100k?")],
      ["m3", makeMarket("m3", "Will it rain tomorrow?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m3"]));

    expect(db._insertedGroups).toHaveLength(0);
    expect(db._updatedGroups.size).toBe(0);
  });

  it("skips when all changed markets are already in existing groups", async () => {
    const db = makeDb(existingGroups);
    vi.mocked(getDb).mockReturnValue(db as any);

    const bucket: Bucket = { category: "Crypto", entity: "BTC", marketIds: ["m1", "m2"] };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will BTC exceed $50k?")],
      ["m2", makeMarket("m2", "Will BTC exceed $100k?")],
    ]);

    // m1 and m2 changed but both already in existingGroups
    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("silently discards hallucinated group_id in join response", async () => {
    const db = makeDb(existingGroups);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([{ market_id: "m3", action: "join", group_id: "nonexistent-uuid" }])
    );

    const bucket: Bucket = { category: "Crypto", entity: "BTC", marketIds: ["m1", "m2", "m3"] };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will BTC exceed $50k?")],
      ["m2", makeMarket("m2", "Will BTC exceed $100k?")],
      ["m3", makeMarket("m3", "Will BTC exceed $150k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m3"]));

    expect(db._updatedGroups.size).toBe(0);
    expect(db._insertedGroups).toHaveLength(0);
  });
});
