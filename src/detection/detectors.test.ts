import { describe, it, expect } from "vitest";
import {
  detectThresholdOrdering,
  detectExhaustivePartition,
  detectComplementary,
  detectTemporalDependency,
  detectConditionalProbability,
  detectMultiMarketConstraint,
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

// ── Type 2 — Temporal Dependency ─────────────────────────────────────────────

describe("detectTemporalDependency", () => {
  it("returns null when fewer than 2 markets", () => {
    expect(detectTemporalDependency(group(4, ["m1"]), prices(["m1", 0.5]))).toBeNull();
  });

  it("returns null when a price is missing", () => {
    const g = group(4, ["m1", "m2"]);
    expect(detectTemporalDependency(g, prices(["m1", 0.4]))).toBeNull();
  });

  it("no violation when prices are non-decreasing (narrower < broader)", () => {
    // May (0.3) → Q2 (0.5) → 2025 (0.8) — correct: broader is more likely
    const g = group(4, ["m1", "m2", "m3"]);
    const p = prices(["m1", 0.3], ["m2", 0.5], ["m3", 0.8]);
    const result = detectTemporalDependency(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });

  it("no violation when prices are equal", () => {
    const g = group(4, ["m1", "m2"]);
    const p = prices(["m1", 0.5], ["m2", 0.5]);
    const result = detectTemporalDependency(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });

  it("no violation when breach is below tolerance (0.005 < 0.01)", () => {
    // Narrower slightly above broader — within noise tolerance
    const g = group(4, ["m1", "m2"]);
    const p = prices(["m1", 0.505], ["m2", 0.5]);
    const result = detectTemporalDependency(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBeCloseTo(0.005);
  });

  it("violation when narrower window is priced higher than broader", () => {
    // May (0.6) > 2025 (0.4) — impossible, "by May" can't be more likely than "by 2025"
    const g = group(4, ["m1", "m2"]);
    const p = prices(["m1", 0.6], ["m2", 0.4]);
    const result = detectTemporalDependency(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2);
  });

  it("magnitude equals the largest breach in a chain", () => {
    // m1=0.5, m2=0.4 (breach 0.1), m3=0.6 (no breach from m2)
    const g = group(4, ["m1", "m2", "m3"]);
    const p = prices(["m1", 0.5], ["m2", 0.4], ["m3", 0.6]);
    const result = detectTemporalDependency(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.1);
  });
});

// ── Type 5 — Conditional Probability ─────────────────────────────────────────

describe("detectConditionalProbability", () => {
  it("returns null when fewer than 2 markets", () => {
    expect(detectConditionalProbability(group(5, ["m1"]), prices(["m1", 0.5]))).toBeNull();
  });

  it("returns null when a price is missing", () => {
    const g = group(5, ["m1", "m2", "m3"]);
    expect(detectConditionalProbability(g, prices(["m1", 0.3], ["m2", 0.5]))).toBeNull();
  });

  it("no violation when joint is below all constituents", () => {
    // P(A∧B) = 0.2 ≤ P(A) = 0.5 and P(B) = 0.6
    const g = group(5, ["joint", "cA", "cB"]);
    const p = prices(["joint", 0.2], ["cA", 0.5], ["cB", 0.6]);
    const result = detectConditionalProbability(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });

  it("no violation when joint equals a constituent (boundary)", () => {
    const g = group(5, ["joint", "cA"]);
    const p = prices(["joint", 0.5], ["cA", 0.5]);
    const result = detectConditionalProbability(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });

  it("no violation when excess is below tolerance (0.005 < 0.01)", () => {
    const g = group(5, ["joint", "cA"]);
    const p = prices(["joint", 0.505], ["cA", 0.5]);
    const result = detectConditionalProbability(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBeCloseTo(0.005);
  });

  it("violation when joint exceeds a constituent", () => {
    // P(A∧B) = 0.7 > P(A) = 0.5 — impossible
    const g = group(5, ["joint", "cA", "cB"]);
    const p = prices(["joint", 0.7], ["cA", 0.5], ["cB", 0.8]);
    const result = detectConditionalProbability(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2); // 0.7 - 0.5
  });

  it("magnitude is the largest excess across all constituents", () => {
    // joint=0.8, cA=0.6 (excess 0.2), cB=0.9 (no excess), cC=0.7 (excess 0.1)
    const g = group(5, ["joint", "cA", "cB", "cC"]);
    const p = prices(["joint", 0.8], ["cA", 0.6], ["cB", 0.9], ["cC", 0.7]);
    const result = detectConditionalProbability(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2);
  });
});

// ── Type 6 — Multi-Market Constraint (Fréchet bounds) ────────────────────────

describe("detectMultiMarketConstraint", () => {
  it("returns null when market count is not exactly 3", () => {
    expect(
      detectMultiMarketConstraint(group(6, ["m1", "m2"]), prices(["m1", 0.5], ["m2", 0.5]))
    ).toBeNull();
    expect(
      detectMultiMarketConstraint(
        group(6, ["m1", "m2", "m3", "m4"]),
        prices(["m1", 0.3], ["m2", 0.5], ["m3", 0.6], ["m4", 0.4])
      )
    ).toBeNull();
  });

  it("returns null when a price is missing", () => {
    const g = group(6, ["joint", "mA", "mB"]);
    expect(detectMultiMarketConstraint(g, prices(["joint", 0.3], ["mA", 0.5]))).toBeNull();
  });

  it("no violation when joint is within Fréchet bounds", () => {
    // P(A)=0.7, P(B)=0.6 → lower=max(0,0.3)=0.3, upper=min(0.7,0.6)=0.6
    // P(joint)=0.4 → within [0.3, 0.6]
    const g = group(6, ["joint", "mA", "mB"]);
    const p = prices(["joint", 0.4], ["mA", 0.7], ["mB", 0.6]);
    const result = detectMultiMarketConstraint(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });

  it("no violation when joint equals the upper bound", () => {
    // P(A)=0.5, P(B)=0.7 → upper=0.5. joint=0.5
    const g = group(6, ["joint", "mA", "mB"]);
    const p = prices(["joint", 0.5], ["mA", 0.5], ["mB", 0.7]);
    const result = detectMultiMarketConstraint(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBe(0);
  });

  it("no violation when lower bound is 0 and joint is 0", () => {
    // P(A)=0.3, P(B)=0.3 → lower=max(0,-0.4)=0. joint=0 — at lower bound
    const g = group(6, ["joint", "mA", "mB"]);
    const p = prices(["joint", 0.0], ["mA", 0.3], ["mB", 0.3]);
    const result = detectMultiMarketConstraint(g, p)!;
    expect(result.violated).toBe(false);
  });

  it("violation when joint exceeds upper Fréchet bound", () => {
    // P(A)=0.4, P(B)=0.5 → upper=0.4. joint=0.6 → excess = 0.2
    const g = group(6, ["joint", "mA", "mB"]);
    const p = prices(["joint", 0.6], ["mA", 0.4], ["mB", 0.5]);
    const result = detectMultiMarketConstraint(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2);
  });

  it("violation when joint falls below lower Fréchet bound", () => {
    // P(A)=0.8, P(B)=0.9 → lower=max(0,0.7)=0.7. joint=0.5 → deficit = 0.2
    const g = group(6, ["joint", "mA", "mB"]);
    const p = prices(["joint", 0.5], ["mA", 0.8], ["mB", 0.9]);
    const result = detectMultiMarketConstraint(g, p)!;
    expect(result.violated).toBe(true);
    expect(result.magnitude).toBeCloseTo(0.2);
  });

  it("no violation when breach is below tolerance (0.005 < 0.01)", () => {
    // P(A)=0.4, P(B)=0.5 → upper=0.4. joint=0.405 → excess=0.005
    const g = group(6, ["joint", "mA", "mB"]);
    const p = prices(["joint", 0.405], ["mA", 0.4], ["mB", 0.5]);
    const result = detectMultiMarketConstraint(g, p)!;
    expect(result.violated).toBe(false);
    expect(result.magnitude).toBeCloseTo(0.005);
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
