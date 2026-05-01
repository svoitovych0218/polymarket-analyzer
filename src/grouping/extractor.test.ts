import { describe, it, expect } from "vitest";
import { extractBuckets } from "./extractor";
import type { Market } from "../api/gamma";

function makeMarket(overrides: Partial<Market> & { id: string; title: string; category: string }): Market {
  return {
    description: "",
    resolutionCondition: "",
    metadataHash: "abc",
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("extractBuckets", () => {
  it("groups two BTC markets into the same bucket", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will BTC hit $100k in 2025?", category: "Crypto" }),
      makeMarket({ id: "2", title: "BTC price above $80k on Dec 31?", category: "Crypto" }),
    ];

    const { buckets, unmatched } = extractBuckets(markets);

    expect(unmatched).toHaveLength(0);
    const btcBucket = buckets.find((b) => b.entity === "BTC");
    expect(btcBucket).toBeDefined();
    expect(btcBucket!.marketIds).toEqual(expect.arrayContaining(["1", "2"]));
  });

  it("separates BTC and ETH into different buckets", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will BTC exceed $100k?", category: "Crypto" }),
      makeMarket({ id: "2", title: "Will ETH reach $10k?", category: "Crypto" }),
    ];

    const { buckets } = extractBuckets(markets);

    const btc = buckets.find((b) => b.entity === "BTC");
    const eth = buckets.find((b) => b.entity === "ETH");
    expect(btc?.marketIds).toEqual(["1"]);
    expect(eth?.marketIds).toEqual(["2"]);
  });

  it("separates same keyword across different categories", () => {
    // "Fed" appears in both Politics and Business keyword lists
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will the Fed raise rates in June?", category: "Politics" }),
      makeMarket({ id: "2", title: "Fed rate decision impact on markets", category: "Business" }),
    ];

    const { buckets } = extractBuckets(markets);

    const politicsFed = buckets.find((b) => b.entity === "FED" && b.category === "Politics");
    const businessFed = buckets.find((b) => b.entity === "FED" && b.category === "Business");
    expect(politicsFed?.marketIds).toEqual(["1"]);
    expect(businessFed?.marketIds).toEqual(["2"]);
  });

  it("puts a market in multiple buckets if it matches multiple entities", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will BTC or ETH hit new ATH first?", category: "Crypto" }),
    ];

    const { buckets } = extractBuckets(markets);

    const btc = buckets.find((b) => b.entity === "BTC");
    const eth = buckets.find((b) => b.entity === "ETH");
    expect(btc?.marketIds).toContain("1");
    expect(eth?.marketIds).toContain("1");
  });

  it("places no-match markets into unmatched and logs them", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will it rain in Dublin next week?", category: "Weather" }),
    ];

    const { buckets, unmatched } = extractBuckets(markets);

    expect(unmatched).toEqual(["1"]);
    expect(buckets).toHaveLength(0);
  });

  it("does not match partial words (ETH should not match 'ethereum')", () => {
    // "ETH" should not match inside "ethereum" as a substring
    // but "Ethereum" should match via the "Ethereum" keyword
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will ethereum flip bitcoin?", category: "Crypto" }),
    ];

    const { buckets } = extractBuckets(markets);

    // "ETH" alone should NOT match "ethereum" (partial word guard)
    const ethKeyword = buckets.find((b) => b.entity === "ETH");
    expect(ethKeyword).toBeUndefined();

    // "Ethereum" keyword SHOULD match
    const ethereumKeyword = buckets.find((b) => b.entity === "ETHEREUM");
    expect(ethereumKeyword?.marketIds).toContain("1");
  });

  it("is case-insensitive for category normalisation", () => {
    const markets: Market[] = [
      makeMarket({ id: "1", title: "Will BTC reach $100k?", category: "crypto" }),
    ];

    const { buckets } = extractBuckets(markets);
    expect(buckets.find((b) => b.entity === "BTC")?.marketIds).toContain("1");
  });

  it("returns empty buckets and empty unmatched for empty input", () => {
    const { buckets, unmatched } = extractBuckets([]);
    expect(buckets).toHaveLength(0);
    expect(unmatched).toHaveLength(0);
  });
});
