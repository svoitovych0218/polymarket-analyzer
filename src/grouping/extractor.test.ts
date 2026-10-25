import { describe, it, expect } from "vitest";
import { extractBuckets } from "./extractor";
import type { GammaEvent } from "../api/gamma";

// ── Helpers ──────────────────────────────────────────────────────────────────

let _eventId = 0;

function makeEvent(
  overrides: { title: string } & Partial<GammaEvent> & { marketIds?: string[] }
): GammaEvent {
  const id = `evt${++_eventId}`;
  const slug = overrides.eventSlug ?? id;
  const marketIds = overrides.marketIds ?? [id + "-m1"];
  return {
    eventId: id,
    eventSlug: slug,
    negRisk: false,
    title: overrides.title,
    description: "",
    markets: marketIds.map((mid, i) => ({
      id: mid,
      groupItemTitle: "",
      groupItemThreshold: String(i),
    })),
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([k]) => !["title", "marketIds", "eventSlug"].includes(k)
      )
    ),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractBuckets", () => {
  it("groups two BTC events into the same bucket", () => {
    const events: GammaEvent[] = [
      makeEvent({ title: "Will BTC hit $100k in 2025?", marketIds: ["1"] }),
      makeEvent({ title: "BTC price above $80k on Dec 31?", marketIds: ["2"] }),
    ];

    const { buckets, unmatched } = extractBuckets(events);

    expect(unmatched).toHaveLength(0);
    const btcBucket = buckets.find((b) => b.entity === "BTC");
    expect(btcBucket).toBeDefined();
    expect(btcBucket!.marketIds).toEqual(expect.arrayContaining(["1", "2"]));
    expect(btcBucket!.category).toBe("Crypto");
  });

  it("separates BTC and ETH into different buckets", () => {
    const events: GammaEvent[] = [
      makeEvent({ title: "Will BTC exceed $100k?", marketIds: ["1"] }),
      makeEvent({ title: "Will ETH reach $10k?", marketIds: ["2"] }),
    ];

    const { buckets } = extractBuckets(events);

    const btc = buckets.find((b) => b.entity === "BTC");
    const eth = buckets.find((b) => b.entity === "ETH");
    expect(btc?.marketIds).toEqual(["1"]);
    expect(eth?.marketIds).toEqual(["2"]);
  });

  it("assigns category from dictionary, not from event record", () => {
    const events: GammaEvent[] = [
      makeEvent({ title: "Will BTC reach $100k?", marketIds: ["1"] }),
    ];

    const { buckets } = extractBuckets(events);
    const btc = buckets.find((b) => b.entity === "BTC");
    expect(btc?.category).toBe("Crypto");
  });

  it("puts an event in multiple buckets if its title matches multiple entities", () => {
    const events: GammaEvent[] = [
      makeEvent({ title: "Will BTC or ETH hit new ATH first?", marketIds: ["1"] }),
    ];

    const { buckets } = extractBuckets(events);

    const btc = buckets.find((b) => b.entity === "BTC");
    const eth = buckets.find((b) => b.entity === "ETH");
    expect(btc?.marketIds).toContain("1");
    expect(eth?.marketIds).toContain("1");
  });

  it("places markets from no-match events into unmatched", () => {
    const events: GammaEvent[] = [
      makeEvent({ title: "Will it rain in Dublin next week?", marketIds: ["1", "2"] }),
    ];

    const { buckets, unmatched } = extractBuckets(events);

    expect(unmatched).toEqual(expect.arrayContaining(["1", "2"]));
    expect(buckets).toHaveLength(0);
  });

  it("does not match ETH inside 'ethereum' (partial-word guard)", () => {
    const events: GammaEvent[] = [
      makeEvent({ title: "Will ethereum flip bitcoin?", marketIds: ["1"] }),
    ];

    const { buckets } = extractBuckets(events);

    const ethKeyword = buckets.find((b) => b.entity === "ETH");
    expect(ethKeyword).toBeUndefined();

    const ethereumKeyword = buckets.find((b) => b.entity === "ETHEREUM");
    expect(ethereumKeyword?.marketIds).toContain("1");
  });

  it("puts cross-category keyword event in all matching dictionary sections", () => {
    const events: GammaEvent[] = [
      makeEvent({ title: "Will the Fed raise rates in June?", marketIds: ["1"] }),
    ];

    const { buckets } = extractBuckets(events);

    const politicsFed = buckets.find((b) => b.entity === "FED" && b.category === "Politics");
    const businessFed = buckets.find((b) => b.entity === "FED" && b.category === "Business");
    expect(politicsFed?.marketIds).toContain("1");
    expect(businessFed?.marketIds).toContain("1");
  });

  it("returns empty results for empty input", () => {
    const { buckets, unmatched } = extractBuckets([]);
    expect(buckets).toHaveLength(0);
    expect(unmatched).toHaveLength(0);
  });

  it("keyword matching runs on event title — not individual market questions", () => {
    // Event title has no BTC keyword; only the market question does.
    // Extractor must NOT match this event to BTC bucket.
    const events: GammaEvent[] = [
      {
        eventId: "e1",
        eventSlug: "crypto-weekly",
        negRisk: false,
        title: "Weekly crypto tracker",
        description: "",
        markets: [{ id: "m1", groupItemTitle: "Will BTC exceed $100k?", groupItemThreshold: "0" }],
      },
    ];

    const { buckets } = extractBuckets(events);
    // "BTC" in groupItemTitle must not trigger a match — only event.title matters
    const btc = buckets.find((b) => b.entity === "BTC");
    expect(btc).toBeUndefined();
  });

  it("a negRisk event produces an EventGroup with negRisk=true", () => {
    const events: GammaEvent[] = [
      {
        eventId: "e1",
        eventSlug: "tsla-weekly",
        negRisk: true,
        title: "TSLA weekly close",
        description: "",
        markets: [
          { id: "m1", groupItemTitle: "<$360", groupItemThreshold: "0" },
          { id: "m2", groupItemTitle: ">$360", groupItemThreshold: "1" },
        ],
      },
    ];

    const { buckets } = extractBuckets(events);
    const bucket = buckets.find((b) => b.entity === "TSLA");
    expect(bucket?.events[0].negRisk).toBe(true);
  });

  it("flat marketIds contains all market IDs from all events in the bucket", () => {
    const events: GammaEvent[] = [
      {
        eventId: "e1",
        eventSlug: "btc-w1",
        negRisk: false,
        title: "BTC weekly bracket 1",
        description: "",
        markets: [
          { id: "m1", groupItemTitle: "", groupItemThreshold: "0" },
          { id: "m2", groupItemTitle: "", groupItemThreshold: "1" },
        ],
      },
      {
        eventId: "e2",
        eventSlug: "btc-w2",
        negRisk: false,
        title: "BTC weekly bracket 2",
        description: "",
        markets: [{ id: "m3", groupItemTitle: "", groupItemThreshold: "0" }],
      },
    ];

    const { buckets } = extractBuckets(events);
    const btc = buckets.find((b) => b.entity === "BTC");
    expect(btc?.marketIds).toEqual(expect.arrayContaining(["m1", "m2", "m3"]));
    expect(btc?.marketIds).toHaveLength(3);
  });

  it("each event appears only once in a bucket even if the title matches multiple keywords in same category", () => {
    // An event title that matches both "BTC" and "Bitcoin" should add the event to
    // the BTC bucket only once (not duplicated).
    const events: GammaEvent[] = [
      {
        eventId: "e1",
        eventSlug: "btc-bitcoin-poll",
        negRisk: false,
        title: "Will BTC (Bitcoin) reach $200k?",
        description: "",
        markets: [{ id: "m1", groupItemTitle: "", groupItemThreshold: "0" }],
      },
    ];

    const { buckets } = extractBuckets(events);
    const btcBucket = buckets.find((b) => b.entity === "BTC");
    // market m1 should appear only once in the BTC bucket
    const count = btcBucket?.marketIds.filter((id) => id === "m1").length ?? 0;
    expect(count).toBe(1);
  });
});
