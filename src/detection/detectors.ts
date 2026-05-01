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

// ── Dispatcher ────────────────────────────────────────────────────────────────

const DETECTORS: Record<number, Detector> = {
  1: detectThresholdOrdering,
  2: detectExhaustivePartition,
  3: detectComplementary,
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
