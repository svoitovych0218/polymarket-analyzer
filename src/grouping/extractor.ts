import { ENTITY_DICTIONARY } from "../config/entities";
import type { Market } from "../api/gamma";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Bucket {
  category: string;
  entity: string;
  marketIds: string[];
}

export interface ExtractorResult {
  buckets: Bucket[];
  /** Markets that matched no keyword — logged to surface dictionary gaps */
  unmatched: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns all entity keywords that appear in `text` for the given category.
 * Matching is case-insensitive and whole-word (avoids "ETH" matching "ethernet").
 */
function matchEntities(category: string, text: string): string[] {
  const keywords = ENTITY_DICTIONARY[category];
  if (!keywords) return [];

  const matched: string[] = [];
  for (const kw of keywords) {
    // Escape special regex chars in the keyword, then wrap in word boundaries.
    // \b doesn't work well before/after "&" or "/" so we use a lookahead/lookbehind
    // that checks for non-word chars or start/end of string.
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "i");
    if (pattern.test(text)) {
      matched.push(kw);
    }
  }
  return matched;
}

/**
 * Canonical entity key: upper-cased, so "BTC" and "btc" land in the same bucket.
 */
function bucketKey(category: string, entity: string): string {
  return `${category}::${entity.toUpperCase()}`;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Pure function: given a list of markets, returns keyword-entity buckets
 * (same category + same entity → same bucket) and a list of unmatched market IDs.
 *
 * A market may appear in multiple buckets if it matches several entities.
 */
export function extractBuckets(markets: Market[]): ExtractorResult {
  // key → { category, entity, marketIds }
  const bucketMap = new Map<string, Bucket>();
  const unmatched: string[] = [];

  for (const market of markets) {
    // Normalise category to title-case so "crypto" and "Crypto" find the same keywords
    const category = normaliseCategory(market.category);
    const entities = matchEntities(category, market.title);

    if (entities.length === 0) {
      unmatched.push(market.id);
      continue;
    }

    for (const entity of entities) {
      const key = bucketKey(category, entity);
      if (!bucketMap.has(key)) {
        bucketMap.set(key, { category, entity: entity.toUpperCase(), marketIds: [] });
      }
      bucketMap.get(key)!.marketIds.push(market.id);
    }
  }

  if (unmatched.length > 0) {
    console.warn(
      `Entity extractor: ${unmatched.length} markets matched no keyword ` +
        `(IDs: ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? "…" : ""})`
    );
  }

  return {
    buckets: Array.from(bucketMap.values()).filter((b) => b.marketIds.length > 0),
    unmatched,
  };
}

function normaliseCategory(raw: string): string {
  if (!raw) return "";
  // Title-case the first letter so "crypto" → "Crypto"
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
