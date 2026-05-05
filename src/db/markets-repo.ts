import type Database from "better-sqlite3";

export interface MarketWithPrice {
  id: string;
  title: string;
  price: number | null;
  category: string;
  last_seen_at: string;
}

export interface MismatchStatus {
  magnitude: number;
  profitable: boolean;
  detected_at: string;
}

export interface MarketsForGroupResult {
  markets: MarketWithPrice[];
  mismatch_status: MismatchStatus | null;
  reasoning: string;
}

interface RawMarket {
  id: string;
  title: string;
  category: string;
  last_seen_at: string;
}

interface RawMismatch {
  magnitude: number;
  profitable: number;
  detected_at: string;
  prices: string;
}

/**
 * Returns markets belonging to a group, enriched with latest mismatch prices.
 */
export function getMarketsForGroup(
  db: Database.Database,
  groupId: string
): MarketsForGroupResult {
  const group = db
    .prepare(`SELECT market_ids, reasoning FROM groups WHERE id = ?`)
    .get(groupId) as { market_ids: string; reasoning: string } | undefined;

  if (!group) {
    return { markets: [], mismatch_status: null, reasoning: "" };
  }

  const marketIds: string[] = JSON.parse(group.market_ids);

  if (marketIds.length === 0) {
    return { markets: [], mismatch_status: null, reasoning: group.reasoning ?? "" };
  }

  const placeholders = marketIds.map(() => "?").join(", ");
  const marketRows = db
    .prepare(`SELECT id, title, category, last_seen_at FROM markets WHERE id IN (${placeholders})`)
    .all(marketIds) as RawMarket[];

  const latestMismatch = db
    .prepare(
      `SELECT magnitude, profitable, detected_at, prices
       FROM mismatches WHERE group_id = ? ORDER BY detected_at DESC LIMIT 1`
    )
    .get(groupId) as RawMismatch | undefined;

  let pricesMap: Record<string, number> = {};
  let mismatch_status: MismatchStatus | null = null;

  if (latestMismatch) {
    pricesMap = JSON.parse(latestMismatch.prices) as Record<string, number>;
    mismatch_status = {
      magnitude: latestMismatch.magnitude,
      profitable: latestMismatch.profitable === 1,
      detected_at: latestMismatch.detected_at,
    };
  }

  const markets: MarketWithPrice[] = marketRows.map((m) => ({
    id: m.id,
    title: m.title,
    price: pricesMap[m.id] ?? null,
    category: m.category,
    last_seen_at: m.last_seen_at,
  }));

  return { markets, mismatch_status, reasoning: group.reasoning ?? "" };
}
