import { describe, it, expect } from "vitest";
import {
  detectThresholdOrdering,
  detectExhaustivePartition,
  detectComplementary,
  detect,
  type Group,
} from "./detectors";

// ── Helpers ──────────────────────────────────────────────────────────────────

function group(
  mismatch_type: number,
  market_ids: string[],
  overrides: Partial<Group> = {}
): Group {
  return { id: "g1", mismatch_type, market_ids, confidence: 0.9, ...overrides };
}

function prices(...pairs: [string, number][]): Map<string, number> {
  return new Map(pairs);
}

// ── Type 3 — Threshold Ordering ──────────────────────────────────────────────

describe("detectThresholdOrdering", () => {
  it("returns null when fewer than 2 markets", () => {
    expect(detectThresholdOrdering(group(1, ["m1"]), prices(["m1", 0.8]))).toBeNull();
  });

  it("returns null when a price is missing", () => {
    const g = group(1, ["m1", "m2"]);
    expect(detectThresholdOrdering(g, prices(["m1", 0.8]))).toBeNull();
  });

  it("no violation when prices are strictly non-increasing", () => {
    // BTC >50k (0.7) ≥ BTC >100k (0.4) ≥ BTC >150k (0.1) — correct ordering
    const g = group(1, ["m1", "m2", "m3"]);
    const p = prices(["m1", 0.7], ["m2", 0.4], ["m3", 0.1]);
    const result = detectThresholdOrdering(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });

  it("no violation when prices are equal (boundary: exactly 0)", () => {
    const g = group(1, ["m1", "m2"]);
    const p = prices(["m1", 0.5], ["m2", 0.5]);
    const result = detectThresholdOrdering(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });

  it("no violation when breach is below tolerance (0.005 < 0.01)", () => {
    // Small breach well within tolerance — not flagged
    const g = group(1, ["m1", "m2"]);
    const p = prices(["m1", 0.5], ["m2", 0.505]);
    const result = detectThresholdOrdering(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBeCloseTo(0.005);
  });

  it("violation when higher threshold price exceeds lower by more than tolerance", () => {
    // BTC >100k (0.6) > BTC >50k (0.5) — impossible, higher should be cheaper
    const g = group(1, ["m1", "m2"]);
    const p = prices(["m1", 0.5], ["m2", 0.6]);
    const result = detectThresholdOrdering(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.1);
  });

  it("magnitude equals the largest breach across multiple pairs", () => {
    // m1=0.8, m2=0.7, m3=0.9 — breach at m2→m3 of 0.2; breach at m1→m2 = 0
    const g = group(1, ["m1", "m2", "m3"]);
    const p = prices(["m1", 0.8], ["m2", 0.7], ["m3", 0.9]);
    const result = detectThresholdOrdering(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2);
  });

  it("includes all prices in details", () => {
    const g = group(1, ["m1", "m2"]);
    const p = prices(["m1", 0.7], ["m2", 0.3]);
    const result = detectThresholdOrdering(g, p)!;
    expect(result.details).toEqual({ m1: 0.7, m2: 0.3 });
  });
});

// ── Type 4 — Exhaustive Partition ────────────────────────────────────────────

describe("detectExhaustivePartition", () => {
  it("returns null when fewer than 2 markets", () => {
    expect(detectExhaustivePartition(group(2, ["m1"]), prices(["m1", 1.0]))).toBeNull();
  });

  it("returns null when a price is missing", () => {
    const g = group(2, ["m1", "m2", "m3"]);
    expect(detectExhaustivePartition(g, prices(["m1", 0.4], ["m2", 0.3]))).toBeNull();
  });

  it("no violation when prices sum exactly to 1.0", () => {
    const g = group(2, ["m1", "m2", "m3"]);
    const p = prices(["m1", 0.5], ["m2", 0.3], ["m3", 0.2]);
    const result = detectExhaustivePartition(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBeCloseTo(0);
  });

  it("no violation when deviation is below tolerance (0.006 < 0.01)", () => {
    const g = group(2, ["m1", "m2"]);
    const p = prices(["m1", 0.503], ["m2", 0.503]); // sum = 1.006
    const result = detectExhaustivePartition(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBeCloseTo(0.006);
  });

  it("violation when prices sum to more than 1 + tolerance", () => {
    const g = group(2, ["m1", "m2", "m3"]);
    const p = prices(["m1", 0.5], ["m2", 0.4], ["m3", 0.3]); // sum = 1.2
    const result = detectExhaustivePartition(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2);
  });

  it("violation when prices sum to less than 1 - tolerance", () => {
    const g = group(2, ["m1", "m2", "m3"]);
    const p = prices(["m1", 0.2], ["m2", 0.1], ["m3", 0.1]); // sum = 0.4
    const result = detectExhaustivePartition(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.6);
  });
});

// ── Type 1 — Complementary Outcome ───────────────────────────────────────────

describe("detectComplementary", () => {
  it("returns null when market count is not exactly 2", () => {
    expect(detectComplementary(group(3, ["m1"]), prices(["m1", 0.6]))).toBeNull();
    expect(
      detectComplementary(
        group(3, ["m1", "m2", "m3"]),
        prices(["m1", 0.5], ["m2", 0.3], ["m3", 0.2])
      )
    ).toBeNull();
  });

  it("returns null when a price is missing", () => {
    const g = group(3, ["m1", "m2"]);
    expect(detectComplementary(g, prices(["m1", 0.6]))).toBeNull();
  });

  it("no violation when prices sum exactly to 1.0", () => {
    const g = group(3, ["m1", "m2"]);
    const p = prices(["m1", 0.6], ["m2", 0.4]);
    const result = detectComplementary(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBeCloseTo(0);
  });

  it("no violation when deviation is below tolerance (0.006 < 0.01)", () => {
    const g = group(3, ["m1", "m2"]);
    const p = prices(["m1", 0.503], ["m2", 0.503]); // sum = 1.006
    const result = detectComplementary(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBeCloseTo(0.006);
  });

  it("violation when prices sum to more than 1 + tolerance", () => {
    // Both sides priced at 0.6 — sum = 1.2, arb opportunity
    const g = group(3, ["m1", "m2"]);
    const p = prices(["m1", 0.6], ["m2", 0.6]);
    const result = detectComplementary(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2);
  });

  it("violation when prices sum to less than 1 - tolerance (underpriced)", () => {
    const g = group(3, ["m1", "m2"]);
    const p = prices(["m1", 0.4], ["m2", 0.4]); // sum = 0.8
    const result = detectComplementary(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2);
  });
});

// ── Dispatcher ────────────────────────────────────────────────────────────────

describe("detect (dispatcher)", () => {
  it("routes type 1 to threshold ordering", () => {
    const g = group(1, ["m1", "m2"]);
    const p = prices(["m1", 0.3], ["m2", 0.8]); // violation
    const result = detect(g, p)!;
    expect(result.violated).toBe(true);
  });

  it("routes type 2 to exhaustive partition", () => {
    const g = group(2, ["m1", "m2"]);
    const p = prices(["m1", 0.8], ["m2", 0.8]); // sum = 1.6, violation
    const result = detect(g, p)!;
    expect(result.violated).toBe(true);
  });

  it("routes type 3 to complementary", () => {
    const g = group(3, ["m1", "m2"]);
    const p = prices(["m1", 0.7], ["m2", 0.7]); // sum = 1.4, violation
    const result = detect(g, p)!;
    expect(result.violated).toBe(true);
  });

  it("returns null for unknown mismatch type", () => {
    const g = group(99, ["m1", "m2"]);
    const p = prices(["m1", 0.5], ["m2", 0.5]);
    expect(detect(g, p)).toBeNull();
  });
});
