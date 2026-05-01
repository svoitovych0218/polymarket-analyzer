// ── Shared types ─────────────────────────────────────────────────────────────

/** A group record as loaded from the `groups` table. */
export interface Group {
  id: string;
  /** Integer mismatch type (mirrors MISMATCH_TYPE_INT in grouper.ts) */
  mismatch_type: number;
  /** Market IDs in canonical order for this mismatch type. */
  market_ids: string[];
  confidence: number;
}

/**
 * Result returned by a detector.
 * `null` means required prices were missing — evaluation was impossible.
 * `violated: false` means prices were present but no violation was found.
 * `violated: true` means a constraint was breached.
 */
export interface MismatchResult {
  violated: boolean;
  magnitude: number;
  /** Snapshot of prices used for this evaluation. */
  details: Record<string, number>;
}

export type Detector = (
  group: Group,
  prices: Map<string, number>
) => MismatchResult | null;

// ── Constants ────────────────────────────────────────────────────────────────

/** Prices must violate a constraint by more than this to be flagged. */
const TOLERANCE = 0.01;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Looks up prices for all market IDs in the group.
 * Returns null if any price is missing.
 */
function resolvePrices(
  group: Group,
  prices: Map<string, number>
): Record<string, number> | null {
  const details: Record<string, number> = {};
  for (const id of group.market_ids) {
    const p = prices.get(id);
    if (p === undefined) return null;
    details[id] = p;
  }
  return details;
}

// ── Type 3 — Threshold Ordering ───────────────────────────────────────────────
//
// market_ids are ordered from lowest threshold to highest
// (e.g. ["btc>50k", "btc>100k", "btc>150k"]).
// Constraint: prices must be non-increasing down the list.
// Violation: any p[i+1] > p[i] + TOLERANCE.
// Magnitude: largest such breach.

export function detectThresholdOrdering(
  group: Group,
  prices: Map<string, number>
): MismatchResult | null {
  if (group.market_ids.length < 2) return null;

  const details = resolvePrices(group, prices);
  if (details === null) return null;

  const ids = group.market_ids;
  let maxBreach = 0;

  for (let i = 0; i < ids.length - 1; i++) {
    // p[i] (lower threshold) must be >= p[i+1] (higher threshold)
    const breach = details[ids[i + 1]] - details[ids[i]];
    if (breach > maxBreach) maxBreach = breach;
  }

  return {
    violated: maxBreach > TOLERANCE,
    magnitude: maxBreach,
    details,
  };
}

// ── Type 4 — Exhaustive Partition ─────────────────────────────────────────────
//
// Mutually exclusive and collectively exhaustive outcomes: prices must sum to 1.
// Violation: |sum - 1| > TOLERANCE.
// Magnitude: |sum - 1|.

export function detectExhaustivePartition(
  group: Group,
  prices: Map<string, number>
): MismatchResult | null {
  if (group.market_ids.length < 2) return null;

  const details = resolvePrices(group, prices);
  if (details === null) return null;

  const sum = Object.values(details).reduce((a, b) => a + b, 0);
  const magnitude = Math.abs(sum - 1.0);

  return {
    violated: magnitude > TOLERANCE,
    magnitude,
    details,
  };
}

// ── Type 1 — Complementary Outcome ────────────────────────────────────────────
//
// Exactly two markets: P(A) and P(NOT-A). Their YES prices must sum to 1.
// Violation: |p1 + p2 - 1| > TOLERANCE.
// Magnitude: |p1 + p2 - 1|.
//
// Note: this is a special case of exhaustive_partition (exactly 2 markets),
// implemented separately for clarity and explicit group-size validation.

export function detectComplementary(
  group: Group,
  prices: Map<string, number>
): MismatchResult | null {
  if (group.market_ids.length !== 2) return null;

  const details = resolvePrices(group, prices);
  if (details === null) return null;

  const [p1, p2] = Object.values(details);
  const magnitude = Math.abs(p1 + p2 - 1.0);

  return {
    violated: magnitude > TOLERANCE,
    magnitude,
    details,
  };
}

// ── Type 2 — Temporal Dependency ─────────────────────────────────────────────
//
// market_ids ordered from narrowest/earliest to broadest/latest window
// (e.g. ["btc-in-may", "btc-in-q2", "btc-in-2025"]).
// Constraint: prices must be non-decreasing — a broader window can only be
// more likely than a narrower one it contains.
// Violation: any p[i] > p[i+1] + TOLERANCE (narrower priced above broader).
// Magnitude: largest such breach.

export function detectTemporalDependency(
  group: Group,
  prices: Map<string, number>
): MismatchResult | null {
  if (group.market_ids.length < 2) return null;

  const details = resolvePrices(group, prices);
  if (details === null) return null;

  const ids = group.market_ids;
  let maxBreach = 0;

  for (let i = 0; i < ids.length - 1; i++) {
    // p[i] (narrower) must be <= p[i+1] (broader)
    const breach = details[ids[i]] - details[ids[i + 1]];
    if (breach > maxBreach) maxBreach = breach;
  }

  return {
    violated: maxBreach > TOLERANCE,
    magnitude: maxBreach,
    details,
  };
}

// ── Type 5 — Conditional Probability ─────────────────────────────────────────
//
// market_ids[0] = joint/conditional event (e.g. "A AND B").
// market_ids[1..n] = constituent markets (each must be >= joint).
// Constraint: P(joint) <= P(constituent_i) for all i.
// Violation: P(joint) > any P(constituent_i) by more than TOLERANCE.
// Magnitude: largest excess = max(0, max_i(P(joint) - P(constituent_i))).

export function detectConditionalProbability(
  group: Group,
  prices: Map<string, number>
): MismatchResult | null {
  if (group.market_ids.length < 2) return null;

  const details = resolvePrices(group, prices);
  if (details === null) return null;

  const [jointId, ...constituentIds] = group.market_ids;
  const jointPrice = details[jointId];

  let maxExcess = 0;
  for (const id of constituentIds) {
    const excess = jointPrice - details[id];
    if (excess > maxExcess) maxExcess = excess;
  }

  return {
    violated: maxExcess > TOLERANCE,
    magnitude: maxExcess,
    details,
  };
}

// ── Type 6 — Multi-Market Constraint (Fréchet bounds) ────────────────────────
//
// market_ids = [jointId, idA, idB] (exactly 3 markets).
// Fréchet bounds for P(A ∧ B):
//   lower = max(0, P(A) + P(B) - 1)
//   upper = min(P(A), P(B))
// Constraint: lower <= P(joint) <= upper.
// Violation: P(joint) outside [lower - TOLERANCE, upper + TOLERANCE].
// Magnitude: distance to nearest valid bound (0 if within bounds).

export function detectMultiMarketConstraint(
  group: Group,
  prices: Map<string, number>
): MismatchResult | null {
  if (group.market_ids.length !== 3) return null;

  const details = resolvePrices(group, prices);
  if (details === null) return null;

  const [jointId, idA, idB] = group.market_ids;
  const pJoint = details[jointId];
  const pA = details[idA];
  const pB = details[idB];

  const lower = Math.max(0, pA + pB - 1);
  const upper = Math.min(pA, pB);

  let magnitude = 0;
  if (pJoint < lower) {
    magnitude = lower - pJoint;
  } else if (pJoint > upper) {
    magnitude = pJoint - upper;
  }

  return {
    violated: magnitude > TOLERANCE,
    magnitude,
    details,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const DETECTORS: Record<number, Detector> = {
  1: detectThresholdOrdering,
  2: detectExhaustivePartition,
  3: detectComplementary,
  4: detectTemporalDependency,
  5: detectConditionalProbability,
  6: detectMultiMarketConstraint,
};

/**
 * Runs the appropriate detector for the group's mismatch type.
 * Returns null if no detector exists for the type or prices are missing.
 */
export function detect(
  group: Group,
  prices: Map<string, number>
): MismatchResult | null {
  const detector = DETECTORS[group.mismatch_type];
  if (!detector) return null;
  return detector(group, prices);
}
