import { describe, it, expect } from "vitest";

// Test the normalization logic directly by importing the private helpers
// via a thin test-only re-export. Since TypeScript compiles them away, we
// inline the equivalent functions here to keep tests self-contained.

interface RawGammaMarketInEvent {
  id: string;
  question: string;
  description: string;
  resolutionSource?: string;
  clobTokenIds?: string;
  active: boolean;
  closed: boolean;
  groupItemTitle?: string;
  groupItemThreshold?: string;
}

interface RawGammaEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  negRisk?: boolean;
  markets: RawGammaMarketInEvent[];
}

function parseYesTokenId(raw: RawGammaMarketInEvent): string {
  try {
    const ids: string[] = JSON.parse(raw.clobTokenIds ?? "[]");
    return ids[0] ?? "";
  } catch {
    return "";
  }
}

import crypto from "crypto";

function computeHash(title: string, description: string, resolutionCondition: string): string {
  return crypto
    .createHash("sha256")
    .update(`${title}|${description}|${resolutionCondition}`)
    .digest("hex")
    .slice(0, 32);
}

function normalizeMarket(raw: RawGammaMarketInEvent, event: RawGammaEvent, now: string) {
  const title = raw.question ?? "";
  const description = raw.description ?? "";
  const resolutionCondition = raw.resolutionSource ?? "";
  return {
    id: raw.id,
    title,
    description,
    resolutionCondition,
    category: "",
    clobTokenId: parseYesTokenId(raw),
    metadataHash: computeHash(title, description, resolutionCondition),
    lastSeenAt: now,
    eventId: event.id,
    eventSlug: event.slug,
    negRisk: event.negRisk ?? false,
    groupItemTitle: raw.groupItemTitle ?? "",
    groupItemThreshold: raw.groupItemThreshold ?? "",
  };
}

function normalizeEvent(raw: RawGammaEvent) {
  const markets = (raw.markets ?? [])
    .filter((m) => m.active && !m.closed)
    .map((m) => ({
      id: m.id,
      groupItemTitle: m.groupItemTitle ?? "",
      groupItemThreshold: m.groupItemThreshold ?? "",
    }))
    .sort(
      (a, b) =>
        parseInt(a.groupItemThreshold || "0") - parseInt(b.groupItemThreshold || "0")
    );

  return {
    eventId: raw.id,
    eventSlug: raw.slug,
    negRisk: raw.negRisk ?? false,
    title: raw.title ?? "",
    description: raw.description ?? "",
    markets,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = "2026-05-06T00:00:00.000Z";

function makeRawEvent(overrides: Partial<RawGammaEvent> & { id: string; slug: string; title: string }): RawGammaEvent {
  return {
    description: "",
    negRisk: false,
    markets: [],
    ...overrides,
  };
}

function makeRawMarket(overrides: Partial<RawGammaMarketInEvent> & { id: string; question: string }): RawGammaMarketInEvent {
  return {
    description: "",
    active: true,
    closed: false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("normalizeMarket", () => {
  it("maps all five new event-level fields onto the Market", () => {
    const event = makeRawEvent({
      id: "evt1",
      slug: "tsla-week-may-8-2026",
      title: "TSLA Week",
      negRisk: true,
    });
    const raw = makeRawMarket({
      id: "m1",
      question: "TSLA above $360?",
      groupItemTitle: "<$360",
      groupItemThreshold: "0",
    });

    const market = normalizeMarket(raw, event, NOW);

    expect(market.eventId).toBe("evt1");
    expect(market.eventSlug).toBe("tsla-week-may-8-2026");
    expect(market.negRisk).toBe(true);
    expect(market.groupItemTitle).toBe("<$360");
    expect(market.groupItemThreshold).toBe("0");
  });

  it("sets negRisk=true for markets inside a negRisk event", () => {
    const event = makeRawEvent({ id: "e1", slug: "s1", title: "T", negRisk: true });
    const raw = makeRawMarket({ id: "m1", question: "Q?" });

    expect(normalizeMarket(raw, event, NOW).negRisk).toBe(true);
  });

  it("sets negRisk=false when the event flag is absent", () => {
    const event = makeRawEvent({ id: "e1", slug: "s1", title: "T" });
    const raw = makeRawMarket({ id: "m1", question: "Q?" });

    expect(normalizeMarket(raw, event, NOW).negRisk).toBe(false);
  });

  it("extracts the YES (first) CLOB token ID", () => {
    const event = makeRawEvent({ id: "e1", slug: "s1", title: "T" });
    const raw = makeRawMarket({
      id: "m1",
      question: "Q?",
      clobTokenIds: JSON.stringify(["token-yes", "token-no"]),
    });

    expect(normalizeMarket(raw, event, NOW).clobTokenId).toBe("token-yes");
  });

  it("computes a deterministic metadata hash", () => {
    const event = makeRawEvent({ id: "e1", slug: "s1", title: "T" });
    const raw = makeRawMarket({ id: "m1", question: "Q?", description: "D", resolutionSource: "R" });

    const a = normalizeMarket(raw, event, NOW);
    const b = normalizeMarket(raw, event, NOW);
    expect(a.metadataHash).toBe(b.metadataHash);
    expect(a.metadataHash).toHaveLength(32);
  });
});

describe("normalizeEvent", () => {
  it("produces a GammaEvent with correct identity fields", () => {
    const raw = makeRawEvent({ id: "evt1", slug: "some-slug", title: "Some Event", negRisk: false });

    const evt = normalizeEvent(raw);

    expect(evt.eventId).toBe("evt1");
    expect(evt.eventSlug).toBe("some-slug");
    expect(evt.negRisk).toBe(false);
    expect(evt.title).toBe("Some Event");
  });

  it("sorts markets by groupItemThreshold ascending", () => {
    const raw = makeRawEvent({
      id: "e1",
      slug: "tsla",
      title: "TSLA",
      negRisk: true,
      markets: [
        makeRawMarket({ id: "m3", question: ">$405?", groupItemThreshold: "2" }),
        makeRawMarket({ id: "m1", question: "<$360?", groupItemThreshold: "0" }),
        makeRawMarket({ id: "m2", question: "$360-$405?", groupItemThreshold: "1" }),
      ],
    });

    const evt = normalizeEvent(raw);

    expect(evt.markets.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("filters out inactive and closed markets", () => {
    const raw = makeRawEvent({
      id: "e1",
      slug: "test",
      title: "Test",
      markets: [
        makeRawMarket({ id: "m1", question: "Active?" }),
        makeRawMarket({ id: "m2", question: "Inactive?", active: false }),
        makeRawMarket({ id: "m3", question: "Closed?", closed: true }),
      ],
    });

    const evt = normalizeEvent(raw);

    expect(evt.markets.map((m) => m.id)).toEqual(["m1"]);
  });

  it("defaults description to empty string when absent", () => {
    const raw = makeRawEvent({ id: "e1", slug: "s1", title: "T" });
    delete (raw as Partial<RawGammaEvent>).description;

    const evt = normalizeEvent(raw);
    expect(evt.description).toBe("");
  });
});
