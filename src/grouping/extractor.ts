import { ENTITY_DICTIONARY } from "../config/entities";
import type { GammaEvent } from "../api/gamma";

// ── Types ────────────────────────────────────────────────────────────────────

export type EventGroup = GammaEvent;

export interface Bucket {
  category: string;
  entity: string;
  marketIds: string[];
  events: EventGroup[];
}

export interface ExtractorResult {
  buckets: Bucket[];
  /** Markets from events that matched no keyword — logged to surface dictionary gaps */
  unmatched: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchesKeyword(keyword: string, text: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "i");
  return pattern.test(text);
}

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
 * Pure function: given a list of Gamma events, returns keyword-entity buckets
 * (keyed by event title) and a list of unmatched market IDs.
 *
 * Keyword matching runs on event titles (one assignment per event, not per
 * market), so a single event produces one bucket entry regardless of how many
 * child markets it contains. The flat `marketIds` list is retained on each
 * bucket for backward compatibility.
 */
export function extractBuckets(events: GammaEvent[]): ExtractorResult {
  const bucketMap = new Map<string, Bucket>();
  const unmatched: string[] = [];

  for (const event of events) {
    const hits = matchAll(event.title);

    if (hits.length === 0) {
      event.markets.forEach((m) => unmatched.push(m.id));
      continue;
    }

    for (const { category, entity } of hits) {
      const key = bucketKey(category, entity);
      if (!bucketMap.has(key)) {
        bucketMap.set(key, { category, entity, marketIds: [], events: [] });
      }
      const bucket = bucketMap.get(key)!;

      if (!bucket.events.some((e) => e.eventId === event.eventId)) {
        bucket.events.push(event);
        for (const m of event.markets) {
          bucket.marketIds.push(m.id);
        }
      }
    }
  }

  if (unmatched.length > 0) {
    console.warn(
      `Entity extractor: ${unmatched.length} markets from unmatched events ` +
        `(IDs: ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? "…" : ""})`
    );
  }

  return {
    buckets: Array.from(bucketMap.values()).filter((b) => b.marketIds.length > 0),
    unmatched,
  };
}
