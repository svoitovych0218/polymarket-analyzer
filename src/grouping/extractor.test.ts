import { describe, it, expect } from "vitest";
import { extractBuckets } from "./extractor";
import type { Market } from "../api/gamma";

function makeMarket(overrides: Partial<Market> & { id: string; title: string }): Market {
  return {
    category: "",          // not used by extractor — inferred from dictionary
    description: "",
    resolutionCondition: "",
    clobTokenId: "",
    metadataHash: "abc",
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("extractBuckets", () => {
  it("groups two BTC markets into the same bucket", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will BTC hit $100k in 2025?" }),
      makeMarket({ id: "2", title: "BTC price above $80k on Dec 31?" }),
    ];

    const { buckets, unmatched } = extractBuckets(markets);

    expect(unmatched).toHaveLength(0);
    const btcBucket = buckets.find((b) => b.entity === "BTC");
    expect(btcBucket).toBeDefined();
    expect(btcBucket!.marketIds).toEqual(expect.arrayContaining(["1", "2"]));
    expect(btcBucket!.category).toBe("Crypto");
  });

  it("separates BTC and ETH into different buckets", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will BTC exceed $100k?" }),
      makeMarket({ id: "2", title: "Will ETH reach $10k?" }),
    ];

    const { buckets } = extractBuckets(markets);

    const btc = buckets.find((b) => b.entity === "BTC");
    const eth = buckets.find((b) => b.entity === "ETH");
    expect(btc?.marketIds).toEqual(["1"]);
    expect(eth?.marketIds).toEqual(["2"]);
  });

  it("assigns category from dictionary, not from market record", () => {
    // market.category is empty — category should come from dictionary
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will BTC reach $100k?", category: "" }),
    ];

    const { buckets } = extractBuckets(markets);
    const btc = buckets.find((b) => b.entity === "BTC");
    expect(btc?.category).toBe("Crypto");
  });

  it("puts a market in multiple buckets if it matches multiple entities", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will BTC or ETH hit new ATH first?" }),
    ];

    const { buckets } = extractBuckets(markets);

    const btc = buckets.find((b) => b.entity === "BTC");
    const eth = buckets.find((b) => b.entity === "ETH");
    expect(btc?.marketIds).toContain("1");
    expect(eth?.marketIds).toContain("1");
  });

  it("places no-match markets into unmatched", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will it rain in Dublin next week?" }),
    ];

    const { buckets, unmatched } = extractBuckets(markets);

    expect(unmatched).toEqual(["1"]);
    expect(buckets).toHaveLength(0);
  });

  it("does not match ETH inside 'ethereum' (partial-word guard)", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will ethereum flip bitcoin?" }),
    ];

    const { buckets } = extractBuckets(markets);

    // "ETH" alone must NOT fire on "ethereum"
    const ethKeyword = buckets.find((b) => b.entity === "ETH");
    expect(ethKeyword).toBeUndefined();

    // "Ethereum" keyword SHOULD match
    const ethereumKeyword = buckets.find((b) => b.entity === "ETHEREUM");
    expect(ethereumKeyword?.marketIds).toContain("1");
  });

  it("puts cross-category keyword market in all matching dictionary sections", () => {
    // "Fed" appears in both Politics and Business dictionaries
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will the Fed raise rates in June?" }),
    ];

    const { buckets } = extractBuckets(markets);

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
});
