import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
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
import type { Bucket, EventGroup } from "./extractor";

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
    eventId: "evt1",
    eventSlug: "test-event",
    negRisk: false,
    groupItemTitle: "",
    groupItemThreshold: "0",
    endDate: "",
  };
}

function makeEventGroup(
  overrides: { eventId: string; eventSlug: string; negRisk?: boolean; markets: Array<{ id: string; groupItemThreshold?: string }> }
): EventGroup {
  return {
    eventId: overrides.eventId,
    eventSlug: overrides.eventSlug,
    negRisk: overrides.negRisk ?? false,
    title: overrides.eventSlug,
    description: "",
    markets: overrides.markets.map((m, i) => ({
      id: m.id,
      groupItemTitle: "",
      groupItemThreshold: m.groupItemThreshold ?? String(i),
    })),
  };
}

function makeBucket(events: EventGroup[]): Bucket {
  return {
    category: "Crypto",
    entity: "BTC",
    marketIds: events.flatMap((e) => e.markets.map((m) => m.id)),
    events,
  };
}

function llmResponse(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function makeDb(
  existingLlmGroups: unknown[] = [],
  existingAutoGroupSlugs: Set<string> = new Set()
) {
  const insertedGroups: unknown[] = [];
  const updatedGroups = new Map<string, string>();

  return {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => {
        if (sql.includes("FROM groups WHERE bucket_key") && sql.includes("source = 'llm'")) {
          return existingLlmGroups;
        }
        return [];
      }),
      get: vi.fn((slug?: string) => {
        if (sql.includes("source = 'auto'") && typeof slug === "string") {
          return existingAutoGroupSlugs.has(slug) ? { id: "existing-auto-id" } : undefined;
        }
        return undefined;
      }),
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

// ── Tests: auto-grouping (negRisk) ───────────────────────────────────────────

describe("groupBucket — negRisk auto-grouping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-creates an exhaustive_partition group for a negRisk event without calling LLM", async () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    const negRiskEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "tsla-week-may-8",
      negRisk: true,
      markets: [
        { id: "m1", groupItemThreshold: "0" },
        { id: "m2", groupItemThreshold: "1" },
        { id: "m3", groupItemThreshold: "2" },
      ],
    });

    const bucket = makeBucket([negRiskEvent]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "<$360")],
      ["m2", makeMarket("m2", "$360-$405")],
      ["m3", makeMarket("m3", ">$405")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1"]));

    expect(mockCreate).not.toHaveBeenCalled();
    const autoGroup = db._insertedGroups.find(
      (g) => (g as unknown[])[7] === "auto"
    );
    expect(autoGroup).toBeDefined();
    // source should be 'auto'
    expect((autoGroup as unknown[])[7]).toBe("auto");
    // confidence should be 1.0
    expect((autoGroup as unknown[])[3]).toBe(1.0);
    // mismatch_type = 2 (exhaustive_partition)
    expect((autoGroup as unknown[])[1]).toBe(2);
    // bucket_key = event slug
    expect((autoGroup as unknown[])[5]).toBe("tsla-week-may-8");
  });

  it("orders markets by groupItemThreshold in the auto-created group", async () => {
    const db = makeDb();
    vi.mocked(getDb).mockReturnValue(db as any);

    const negRiskEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "tsla-week",
      negRisk: true,
      markets: [
        { id: "m3", groupItemThreshold: "2" },
        { id: "m1", groupItemThreshold: "0" },
        { id: "m2", groupItemThreshold: "1" },
      ],
    });

    const bucket = makeBucket([negRiskEvent]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "low")],
      ["m2", makeMarket("m2", "mid")],
      ["m3", makeMarket("m3", "high")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1"]));

    const autoGroup = db._insertedGroups[0] as unknown[];
    const ids: string[] = JSON.parse(autoGroup[2] as string);
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });

  it("auto-grouping is idempotent — skips event that already has an auto group", async () => {
    const db = makeDb([], new Set(["tsla-week"]));
    vi.mocked(getDb).mockReturnValue(db as any);

    const negRiskEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "tsla-week",
      negRisk: true,
      markets: [
        { id: "m1", groupItemThreshold: "0" },
        { id: "m2", groupItemThreshold: "1" },
      ],
    });

    const bucket = makeBucket([negRiskEvent]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "low")],
      ["m2", makeMarket("m2", "high")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1"]));

    expect(db._insertedGroups).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does not call LLM when bucket contains only negRisk events (all already auto-grouped)", async () => {
    const db = makeDb([], new Set(["tsla-week"]));
    vi.mocked(getDb).mockReturnValue(db as any);

    const negRiskEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "tsla-week",
      negRisk: true,
      markets: [
        { id: "m1", groupItemThreshold: "0" },
        { id: "m2", groupItemThreshold: "1" },
      ],
    });

    const bucket = makeBucket([negRiskEvent]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "low")],
      ["m2", makeMarket("m2", "high")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1"]));

    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── Tests: fresh LLM bucket ───────────────────────────────────────────────────

describe("groupBucket — fresh LLM bucket (non-negRisk events)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls LLM and inserts groups for a fresh non-negRisk bucket", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          mismatch_type: "threshold_ordering",
          market_ids: ["m1", "m2"],
          confidence: 0.9,
          reasoning: "Higher threshold markets must be cheaper.",
        },
      ])
    );

    const event = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-weekly",
      negRisk: false,
      markets: [{ id: "m1" }, { id: "m2" }],
    });

    const bucket = makeBucket([event]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will BTC exceed $50k?")],
      ["m2", makeMarket("m2", "Will BTC exceed $100k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    expect(mockCreate).toHaveBeenCalledOnce();
    const llmGroup = db._insertedGroups.find((g) => (g as unknown[])[7] === "llm");
    expect(llmGroup).toBeDefined();
  });

  it("LLM prompt contains the event description only once for a multi-market event", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(llmResponse([]));

    const event: EventGroup = {
      eventId: "e1",
      eventSlug: "btc-weekly",
      negRisk: false,
      title: "BTC Weekly",
      description: "Shared event description — shown only once",
      markets: [
        { id: "m1", groupItemTitle: "<$50k", groupItemThreshold: "0" },
        { id: "m2", groupItemTitle: ">$50k", groupItemThreshold: "1" },
      ],
    };

    const bucket: Bucket = {
      category: "Crypto",
      entity: "BTC",
      marketIds: ["m1", "m2"],
      events: [event],
    };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC below $50k?")],
      ["m2", makeMarket("m2", "BTC above $50k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    const userPrompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    const descriptionOccurrences = userPrompt.split("Shared event description — shown only once").length - 1;
    expect(descriptionOccurrences).toBe(1);
  });

  it("includes negRisk events in the LLM prompt marked [ONE-WINNER] for cross-event analysis", async () => {
    const db = makeDb([], new Set(["tsla-week"]));
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(llmResponse([]));

    const negRiskEvent: EventGroup = {
      eventId: "e1",
      eventSlug: "tsla-week",
      negRisk: true,
      title: "TSLA weekly",
      description: "",
      markets: [
        { id: "m1", groupItemTitle: "<$360", groupItemThreshold: "0" },
        { id: "m2", groupItemTitle: ">$360", groupItemThreshold: "1" },
      ],
    };
    const regularEvent: EventGroup = {
      eventId: "e2",
      eventSlug: "btc-weekly",
      negRisk: false,
      title: "BTC Weekly",
      description: "",
      markets: [{ id: "m3", groupItemTitle: "", groupItemThreshold: "0" }],
    };

    const bucket: Bucket = {
      category: "Crypto",
      entity: "BTC",
      marketIds: ["m1", "m2", "m3"],
      events: [negRiskEvent, regularEvent],
    };
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will TSLA close below $360?")],
      ["m2", makeMarket("m2", "Will TSLA close above $360?")],
      ["m3", makeMarket("m3", "Will BTC exceed $100k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m3"]));

    const userPrompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userPrompt).toContain("Event: tsla-week [ONE-WINNER]");
    expect(userPrompt).toContain("ID: m1");
    expect(userPrompt).toContain("btc-weekly");
  });

  it("includes each market's end date and rules in the LLM prompt", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(llmResponse([]));

    const event = makeEventGroup({ eventId: "e1", eventSlug: "ceasefire-2026", markets: [{ id: "m1" }] });
    const market = {
      ...makeMarket("m1", "Russia x Ukraine ceasefire in 2026?"),
      description: "Resolves YES if an official ceasefire is announced by December 31, 2026.",
      endDate: "2026-12-31T12:00:00Z",
    };

    await groupBucket(makeBucket([event]), new Map([["m1", market]]), new Set(["m1"]));

    const userPrompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userPrompt).toContain('ID: m1 | "Russia x Ukraine ceasefire in 2026?" | ends: 2026-12-31');
    expect(userPrompt).toContain("Rules: Resolves YES if an official ceasefire is announced");
  });

  it("skips buckets with no changed markets", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);

    const event = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-weekly",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const bucket = makeBucket([event]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Q1?")],
      ["m2", makeMarket("m2", "Q2?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m99"]));

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("uses event slug as bucket_key for auto groups and category::entity for LLM groups", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          mismatch_type: "complementary",
          market_ids: ["m1", "m2"],
          confidence: 0.9,
          reasoning: "Exact complements.",
        },
      ])
    );

    const negRiskEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "tsla-week",
      negRisk: true,
      markets: [{ id: "nr1", groupItemThreshold: "0" }, { id: "nr2", groupItemThreshold: "1" }],
    });
    const regularEvent = makeEventGroup({
      eventId: "e2",
      eventSlug: "btc-weekly",
      negRisk: false,
      markets: [{ id: "m1" }, { id: "m2" }],
    });

    const bucket: Bucket = {
      category: "Crypto",
      entity: "BTC",
      marketIds: ["nr1", "nr2", "m1", "m2"],
      events: [negRiskEvent, regularEvent],
    };
    const marketMap = new Map([
      ["nr1", makeMarket("nr1", "low")],
      ["nr2", makeMarket("nr2", "high")],
      ["m1", makeMarket("m1", "Yes")],
      ["m2", makeMarket("m2", "No")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    const autoGroup = db._insertedGroups.find((g) => (g as unknown[])[7] === "auto") as unknown[];
    const llmGroup = db._insertedGroups.find((g) => (g as unknown[])[7] === "llm") as unknown[];

    expect(autoGroup[5]).toBe("tsla-week");      // event slug as bucket_key
    expect(llmGroup[5]).toBe("Crypto::BTC");     // category::entity as bucket_key
  });
});

// ── Tests: existing LLM groups (incremental path) ────────────────────────────

describe("groupBucket — existing LLM groups (new event matching)", () => {
  beforeEach(() => vi.clearAllMocks());

  const existingGroupId = crypto.randomUUID();
  const existingLlmGroups = [
    {
      id: existingGroupId,
      mismatch_type: 1,
      market_ids: JSON.stringify(["m1", "m2"]),
      confidence: 0.9,
      bucket_key: "Crypto::BTC",
    },
  ];

  it("appends new market to existing group when LLM says join", async () => {
    const db = makeDb(existingLlmGroups);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([{ market_id: "m3", action: "join", group_id: existingGroupId }])
    );

    const oldEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-old",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const newEvent = makeEventGroup({
      eventId: "e2",
      eventSlug: "btc-new",
      markets: [{ id: "m3" }],
    });

    const bucket = makeBucket([oldEvent, newEvent]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC >$50k?")],
      ["m2", makeMarket("m2", "BTC >$100k?")],
      ["m3", makeMarket("m3", "BTC >$150k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m3"]));

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(db._updatedGroups.has(existingGroupId)).toBe(true);
    expect(JSON.parse(db._updatedGroups.get(existingGroupId)!)).toContain("m3");
  });

  it("creates a new LLM group when LLM says new_group", async () => {
    const db = makeDb(existingLlmGroups);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          market_id: "m3",
          action: "new_group",
          mismatch_type: "complementary",
          with_market_ids: ["m3", "m4"],
          confidence: 0.9,
          reasoning: "Strict complements.",
        },
      ])
    );

    const oldEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-old",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const newEvent = makeEventGroup({
      eventId: "e2",
      eventSlug: "btc-new",
      markets: [{ id: "m3" }, { id: "m4" }],
    });

    const bucket = makeBucket([oldEvent, newEvent]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC >$50k?")],
      ["m2", makeMarket("m2", "BTC >$100k?")],
      ["m3", makeMarket("m3", "BTC above?")],
      ["m4", makeMarket("m4", "BTC below?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m3"]));

    const newLlmGroup = db._insertedGroups.find((g) => (g as unknown[])[7] === "llm");
    expect(newLlmGroup).toBeDefined();
    expect(db._updatedGroups.size).toBe(0);
  });

  it("does nothing when LLM says none", async () => {
    const db = makeDb(existingLlmGroups);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([{ market_id: "m3", action: "none" }])
    );

    const oldEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-old",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const newEvent = makeEventGroup({
      eventId: "e2",
      eventSlug: "btc-new",
      markets: [{ id: "m3" }],
    });

    const bucket = makeBucket([oldEvent, newEvent]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC >$50k?")],
      ["m2", makeMarket("m2", "BTC >$100k?")],
      ["m3", makeMarket("m3", "weather tomorrow?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m3"]));

    expect(db._insertedGroups).toHaveLength(0);
    expect(db._updatedGroups.size).toBe(0);
  });

  it("skips when all markets in dirty events are already in existing groups", async () => {
    const db = makeDb(existingLlmGroups);
    vi.mocked(getDb).mockReturnValue(db as any);

    const event = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-old",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const bucket = makeBucket([event]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC >$50k?")],
      ["m2", makeMarket("m2", "BTC >$100k?")],
    ]);

    // Both m1 and m2 are changed but already in existingLlmGroups
    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("whole new event is sent to LLM together (not market-by-market)", async () => {
    const db = makeDb(existingLlmGroups);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(llmResponse([]));

    const oldEvent = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-old",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const newEvent = makeEventGroup({
      eventId: "e2",
      eventSlug: "btc-new",
      markets: [{ id: "m3" }, { id: "m4" }, { id: "m5" }],
    });

    const bucket = makeBucket([oldEvent, newEvent]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC >$50k?")],
      ["m2", makeMarket("m2", "BTC >$100k?")],
      ["m3", makeMarket("m3", "BTC A?")],
      ["m4", makeMarket("m4", "BTC B?")],
      ["m5", makeMarket("m5", "BTC C?")],
    ]);

    // Only m3 is in changedIds, but the whole event (m3,m4,m5) should appear in the prompt
    await groupBucket(bucket, marketMap, new Set(["m3"]));

    expect(mockCreate).toHaveBeenCalledOnce();
    const userPrompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    // All three markets from the new event must appear in prompt
    expect(userPrompt).toContain("m3");
    expect(userPrompt).toContain("m4");
    expect(userPrompt).toContain("m5");
  });
});

// ── Tests: validation ────────────────────────────────────────────────────────

describe("groupBucket — validation (isValidGroup)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects fresh-bucket group with confidence below MIN_GROUP_CONFIDENCE (0.80)", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          mismatch_type: "threshold_ordering",
          market_ids: ["m1", "m2"],
          confidence: 0.75,
          reasoning: "Constraint applies.",
        },
      ])
    );

    const event = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-weekly",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const bucket = makeBucket([event]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC >$50k?")],
      ["m2", makeMarket("m2", "BTC >$100k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    expect(db._insertedGroups).toHaveLength(0);
  });

  it("rejects fresh-bucket group with missing reasoning", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          mismatch_type: "threshold_ordering",
          market_ids: ["m1", "m2"],
          confidence: 0.9,
        },
      ])
    );

    const event = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-weekly",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const bucket = makeBucket([event]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC >$50k?")],
      ["m2", makeMarket("m2", "BTC >$100k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    expect(db._insertedGroups).toHaveLength(0);
  });

  it("rejects fresh-bucket group with whitespace-only reasoning", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          mismatch_type: "threshold_ordering",
          market_ids: ["m1", "m2"],
          confidence: 0.9,
          reasoning: "   ",
        },
      ])
    );

    const event = makeEventGroup({
      eventId: "e1",
      eventSlug: "btc-weekly",
      markets: [{ id: "m1" }, { id: "m2" }],
    });
    const bucket = makeBucket([event]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC >$50k?")],
      ["m2", makeMarket("m2", "BTC >$100k?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    expect(db._insertedGroups).toHaveLength(0);
  });

  it("rejects exhaustive_partition groups that span different events", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          mismatch_type: "exhaustive_partition",
          market_ids: ["m1", "m2"],
          confidence: 0.95,
          reasoning: "Incorrectly claims two separate days exhaust the same outcome.",
        },
      ])
    );

    const may5 = makeEventGroup({
      eventId: "e1",
      eventSlug: "xrp-price-on-may-5",
      markets: [{ id: "m1" }],
    });
    const may6 = makeEventGroup({
      eventId: "e2",
      eventSlug: "xrp-price-on-may-6",
      markets: [{ id: "m2" }],
    });
    const bucket = makeBucket([may5, may6]);
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Will XRP be between $1.20 and $1.30 on May 5?")],
      ["m2", makeMarket("m2", "Will XRP be between $1.20 and $1.30 on May 6?")],
    ]);

    await groupBucket(bucket, marketMap, new Set(["m1", "m2"]));

    expect(db._insertedGroups).toHaveLength(0);
  });

  it("accepts a cross-event implication and stores its assumption with the reasoning", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        {
          mismatch_type: "implication",
          market_ids: ["m2", "m1"],
          confidence: 0.85,
          reasoning: "A ceasefire before GTA VI is also a ceasefire in 2026.",
          assumption: "GTA VI releases before 2027-01-01",
        },
      ])
    );

    const in2026 = makeEventGroup({ eventId: "e1", eventSlug: "ceasefire-2026", markets: [{ id: "m1" }] });
    const beforeGta = makeEventGroup({ eventId: "e2", eventSlug: "ceasefire-before-gta-vi", markets: [{ id: "m2" }] });
    const marketMap = new Map([
      ["m1", makeMarket("m1", "Russia x Ukraine ceasefire in 2026?")],
      ["m2", makeMarket("m2", "Russia x Ukraine ceasefire before GTA VI?")],
    ]);

    await groupBucket(makeBucket([in2026, beforeGta]), marketMap, new Set(["m1", "m2"]));

    expect(db._insertedGroups).toHaveLength(1);
    const row = db._insertedGroups[0] as unknown[];
    expect(row[1]).toBe(7);
    expect(JSON.parse(row[2] as string)).toEqual(["m2", "m1"]);
    expect(row[6]).toBe(
      "A ceasefire before GTA VI is also a ceasefire in 2026.\nAssumption: GTA VI releases before 2027-01-01"
    );
  });

  it("rejects cross-event types whose markets all come from one event", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        { mismatch_type: "implication", market_ids: ["m1", "m2"], confidence: 0.9, reasoning: "Same event." },
        { mismatch_type: "mutually_exclusive", market_ids: ["m1", "m2"], confidence: 0.9, reasoning: "Same event." },
      ])
    );

    const event = makeEventGroup({ eventId: "e1", eventSlug: "btc-weekly", markets: [{ id: "m1" }, { id: "m2" }] });
    const marketMap = new Map([
      ["m1", makeMarket("m1", "BTC by March?")],
      ["m2", makeMarket("m2", "BTC by June?")],
    ]);

    await groupBucket(makeBucket([event]), marketMap, new Set(["m1", "m2"]));

    expect(db._insertedGroups).toHaveLength(0);
  });

  it("rejects implication groups that do not have exactly 2 markets", async () => {
    const db = makeDb([]);
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        { mismatch_type: "implication", market_ids: ["m1", "m2", "m3"], confidence: 0.9, reasoning: "Chain." },
      ])
    );

    const events = ["m1", "m2", "m3"].map((id, i) =>
      makeEventGroup({ eventId: `e${i}`, eventSlug: `event-${i}`, markets: [{ id }] })
    );
    const marketMap = new Map(["m1", "m2", "m3"].map((id) => [id, makeMarket(id, id)]));

    await groupBucket(makeBucket(events), marketMap, new Set(["m1", "m2", "m3"]));

    expect(db._insertedGroups).toHaveLength(0);
  });

  it("rejects LLM groups that only re-state a negRisk event's partition", async () => {
    const db = makeDb([], new Set(["senate-mi", "senate-or"]));
    vi.mocked(getDb).mockReturnValue(db as any);
    mockCreate.mockResolvedValueOnce(
      llmResponse([
        { mismatch_type: "exhaustive_partition", market_ids: ["d1", "r1"], confidence: 0.95, reasoning: "One wins." },
        { mismatch_type: "complementary", market_ids: ["d1", "r1"], confidence: 0.95, reasoning: "One wins." },
      ])
    );

    const mi = makeEventGroup({ eventId: "e1", eventSlug: "senate-mi", negRisk: true, markets: [{ id: "d1" }, { id: "r1" }] });
    const or = makeEventGroup({ eventId: "e2", eventSlug: "senate-or", negRisk: true, markets: [{ id: "d2" }, { id: "r2" }] });
    const marketMap = new Map(["d1", "r1", "d2", "r2"].map((id) => [id, makeMarket(id, id)]));

    await groupBucket(makeBucket([mi, or]), marketMap, new Set(["d1"]));

    expect(db._insertedGroups).toHaveLength(0);
  });
});
