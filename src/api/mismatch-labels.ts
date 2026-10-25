const LABELS: Record<number, string> = {
  1: "Type 1 — Threshold Ordering",
  2: "Type 2 — Exhaustive Partition",
  3: "Type 3 — Complementary Outcome",
  4: "Type 4 — Temporal Dependency",
  5: "Type 5 — Conditional Probability",
  6: "Type 6 — Multi-Market Constraint",
  7: "Type 7 — Implication",
  8: "Type 8 — Mutually Exclusive",
};

export function getMismatchTypeLabel(type: number): string {
  return LABELS[type] ?? `Type ${type} — Unknown`;
}
