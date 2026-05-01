import cron from "node-cron";
import { initDb, getDb } from "./db/schema";
import { pollGammaMarkets } from "./api/gamma";
import { fetchPrices } from "./api/clob";
import { extractBuckets } from "./grouping/extractor";
import { groupBucket } from "./grouping/grouper";
import { detect } from "./detection/detectors";
import { logMismatch } from "./detection/logger";
import type { Market } from "./api/gamma";
import type { Group } from "./detection/detectors";

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadMarketMap(): Map<string, Market> {
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

  return new Map(
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
}

function loadGroups(): Group[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, mismatch_type, market_ids, confidence FROM groups`)
    .all() as Array<{
    id: string;
    mismatch_type: number;
    market_ids: string;
    confidence: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    mismatch_type: r.mismatch_type,
    market_ids: JSON.parse(r.market_ids) as string[],
    confidence: r.confidence,
  }));
}

// ── Loop implementations ──────────────────────────────────────────────────────

async function runDiscoveryLoop(): Promise<void> {
  console.log("[discovery] Starting Gamma poll + grouping cycle...");

  const changed = await pollGammaMarkets();
  console.log(`[discovery] Changed markets: ${changed.length}`);

  if (changed.length === 0) {
    console.log("[discovery] No market changes — skipping grouping.");
    return;
  }

  const marketMap = loadMarketMap();
  const allMarkets = Array.from(marketMap.values());
  const { buckets } = extractBuckets(allMarkets);
  const changedIds = new Set(changed.map((m) => m.id));

  console.log(
    `[discovery] Running grouper on ${buckets.length} buckets (${changedIds.size} changed markets)...`
  );

  for (const bucket of buckets) {
    await groupBucket(bucket, marketMap, changedIds);
  }

  console.log("[discovery] Cycle complete.");
}

async function runDetectionLoop(): Promise<void> {
  console.log("[detection] Starting CLOB price fetch + mismatch detection...");

  const marketMap = loadMarketMap();
  const groups = loadGroups();

  if (groups.length === 0) {
    console.log("[detection] No groups yet — skipping detection.");
    return;
  }

  // Collect all market IDs referenced by groups (with their CLOB token IDs)
  const groupedMarketIds = new Set(groups.flatMap((g) => g.market_ids));
  const marketsForPriceFetch = Array.from(groupedMarketIds)
    .map((id) => marketMap.get(id))
    .filter((m): m is Market => m !== undefined)
    .map((m) => ({ id: m.id, clobTokenId: m.clobTokenId }));

  const prices = await fetchPrices(marketsForPriceFetch);

  const marketTitles = new Map(
    Array.from(marketMap.values()).map((m) => [m.id, m.title])
  );

  let violations = 0;
  for (const group of groups) {
    const result = detect(group, prices);
    if (result === null || !result.violated) continue;

    violations++;
    console.log(
      `[detection] Violation found — group ${group.id}, type ${group.mismatch_type}, magnitude ${result.magnitude.toFixed(4)}`
    );
    logMismatch(result, group, marketTitles);
  }

  console.log(
    `[detection] Cycle complete. Checked ${groups.length} groups, found ${violations} violation(s).`
  );
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function withErrorBoundary(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`[${name}] Unhandled error in cycle:`, err);
    }
  };
}

async function main(): Promise<void> {
  initDb();
  console.log("Database initialised.");

  const discovery = withErrorBoundary("discovery", runDiscoveryLoop);
  const detection = withErrorBoundary("detection", runDetectionLoop);

  // Run both loops immediately on startup
  await discovery();
  await detection();

  // Schedule recurring loops
  const discoveryTask = cron.schedule("0 */4 * * *", discovery);  // every 4 hours
  const detectionTask = cron.schedule("*/30 * * * *", detection); // every 30 minutes

  console.log("Scheduler running. Discovery: every 4h. Detection: every 30min.");

  // Graceful shutdown
  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}. Stopping schedulers...`);
    discoveryTask.stop();
    detectionTask.stop();
    console.log("Shutdown complete.");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
