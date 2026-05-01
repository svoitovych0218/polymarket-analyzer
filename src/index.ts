import { initDb, getDb } from "./db/schema";
import { pollGammaMarkets } from "./api/gamma";
import { extractBuckets } from "./grouping/extractor";
import { groupBucket } from "./grouping/grouper";
import type { Market } from "./api/gamma";

async function main(): Promise<void> {
  initDb();
  console.log("Database initialised.");

  const changed = await pollGammaMarkets();
  console.log(`Changed markets: ${changed.length}`);

  if (changed.length === 0) {
    console.log("No market changes — skipping grouping.");
    return;
  }

  // Load all persisted markets to build the full market map for bucket grouping
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, description, resolution_condition, category,
              clob_token_id, metadata_hash, last_seen_at FROM markets`
    )
    .all() as Array<{
    id: string;
    title: string;
    description: string;
    resolution_condition: string;
    category: string;
    clob_token_id: string;
    metadata_hash: string;
    last_seen_at: string;
  }>;

  const marketMap = new Map<string, Market>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        description: r.description,
        resolutionCondition: r.resolution_condition,
        category: r.category,
        clobTokenId: r.clob_token_id,
        metadataHash: r.metadata_hash,
        lastSeenAt: r.last_seen_at,
      },
    ])
  );

  const allMarkets = Array.from(marketMap.values());
  const { buckets } = extractBuckets(allMarkets);
  const changedIds = new Set(changed.map((m) => m.id));

  console.log(`Running grouper on ${buckets.length} buckets (${changedIds.size} changed markets)...`);

  for (const bucket of buckets) {
    await groupBucket(bucket, marketMap, changedIds);
  }

  console.log("Grouping complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
