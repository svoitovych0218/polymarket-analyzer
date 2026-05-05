import { describe, it, expect } from "vitest";
import { getMismatchTypeLabel } from "./mismatch-labels";

describe("getMismatchTypeLabel", () => {
  it("returns correct label for type 1", () => {
    expect(getMismatchTypeLabel(1)).toBe("Type 1 — Threshold Ordering");
  });

  it("returns correct label for type 2", () => {
    expect(getMismatchTypeLabel(2)).toBe("Type 2 — Exhaustive Partition");
  });

  it("returns correct label for type 3", () => {
    expect(getMismatchTypeLabel(3)).toBe("Type 3 — Complementary Outcome");
  });

  it("returns correct label for type 4", () => {
    expect(getMismatchTypeLabel(4)).toBe("Type 4 — Temporal Dependency");
  });

  it("returns correct label for type 5", () => {
    expect(getMismatchTypeLabel(5)).toBe("Type 5 — Conditional Probability");
  });

  it("returns correct label for type 6", () => {
    expect(getMismatchTypeLabel(6)).toBe("Type 6 — Multi-Market Constraint");
  });

  it("returns a fallback for unknown types", () => {
    expect(getMismatchTypeLabel(99)).toBe("Type 99 — Unknown");
  });
});
