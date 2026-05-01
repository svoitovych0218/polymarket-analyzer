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
 * Returns true if `keyword` appears in `text` as a whole word.
 * Case-insensitive. Uses lookahead/lookbehind to avoid matching substrings
 * (e.g. "ETH" must not fire inside "ethereum").
 */
function matchesKeyword(keyword: string, text: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "i");
  return pattern.test(text);
}

/**
 * Returns all (category, keyword) pairs that match the market's title,
 * scanning every category section in the entity dictionary.
 * Category is derived from the dictionary — not from the market record —
 * because the Gamma API does not reliably expose a category field.
 */
function matchAll(title: string): Array<{ category: string; entity: string }> {
  const hits: Array<{ category: string; entity: string }> = [];

  for (const [category, keywords] of Object.entries(ENTITY_DICTIONARY)) {
    for (const kw of keywords) {
      if (matchesKeyword(kw, title)) {
        hits.push({ category, entity: kw.toUpperCase() });
      }
    }
  }

  return hits;
}

function bucketKey(category: string, entity: string): string {
  return `${category}::${entity}`;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Pure function: given a list of markets, returns keyword-entity buckets and
 * a list of unmatched market IDs.
 *
 * Bucket identity = dictionary category + entity keyword. A market may appear
 * in multiple buckets if it matches several entities. Category is inferred
 * from the dictionary rather than read from the market record.
 */
export function extractBuckets(markets: Market[]): ExtractorResult {
  const bucketMap = new Map<string, Bucket>();
  const unmatched: string[] = [];

  for (const market of markets) {
    const hits = matchAll(market.title);

    if (hits.length === 0) {
      unmatched.push(market.id);
      continue;
    }

    for (const { category, entity } of hits) {
      const key = bucketKey(category, entity);
      if (!bucketMap.has(key)) {
        bucketMap.set(key, { category, entity, marketIds: [] });
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
