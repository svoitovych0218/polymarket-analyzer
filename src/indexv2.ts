import "dotenv/config";
import crypto from "crypto";
import { initDb, getDb } from "./db/schema";

// ── Raw API types ─────────────────────────────────────────────────────────────

interface RawTag {
  id: string;
  label: string;
  slug: string;
}

interface RawMarket {
  id: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  clobTokenIds?: string;
  active: boolean;
  closed: boolean;
  negRisk?: boolean;
  groupItemTitle?: string;
  groupItemThreshold?: string;
}

interface RawEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  negRisk?: boolean;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  liquidity?: number;
  volume?: number;
  openInterest?: number;
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  updatedAt?: string;
  markets: RawMarket[];
  tags?: RawTag[];
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const PAGE_LIMIT = 500;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithBackoff(url: string, attempt = 0): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(BASE_DELAY_MS * 2 ** attempt);
    return fetchWithBackoff(url, attempt + 1);
  }

  if (res.ok) return res;

  const retryable = res.status === 429 || res.status >= 500;
  if (!retryable || attempt >= MAX_RETRIES) {
    throw new Error(`Gamma API error: ${res.status} ${res.statusText} — ${url}`);
  }

  const delay =
    res.status === 429
      ? parseInt(res.headers.get("Retry-After") ?? "0", 10) * 1000 ||
        BASE_DELAY_MS * 2 ** attempt
      : BASE_DELAY_MS * 2 ** attempt;

  console.warn(`Gamma API ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1})`);
  await sleep(delay);
  return fetchWithBackoff(url, attempt + 1);
}

async function fetchAllEvents(): Promise<RawEvent[]> {
  const all: RawEvent[] = [];
  let offset = 0;

  while (true) {
    const url =
      `${GAMMA_BASE_URL}/events` +
      `?active=true&closed=false&limit=${PAGE_LIMIT}&offset=${offset}`;

    const res = await fetchWithBackoff(url);
    const page: RawEvent[] = await res.json();

    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }

  return all;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function parseYesTokenId(raw: RawMarket): string {
  try {
    const ids: string[] = JSON.parse(raw.clobTokenIds ?? "[]");
    return ids[0] ?? "";
  } catch {
    return "";
  }
}

function computeHash(title: string, description: string, resolutionCondition: string): string {
  return crypto
    .createHash("sha256")
    .update(`${title}|${description}|${resolutionCondition}`)
    .digest("hex")
    .slice(0, 32);
}

function persistAll(events: RawEvent[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  const upsertEvent = db.prepare(`
    INSERT INTO events
      (id, slug, title, description, neg_risk, active, closed, archived,
       liquidity, volume, open_interest, start_date, end_date, created_at, updated_at)
    VALUES
      (@id, @slug, @title, @description, @negRisk, @active, @closed, @archived,
       @liquidity, @volume, @openInterest, @startDate, @endDate, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      slug          = excluded.slug,
      title         = excluded.title,
      description   = excluded.description,
      neg_risk      = excluded.neg_risk,
      active        = excluded.active,
      closed        = excluded.closed,
      archived      = excluded.archived,
      liquidity     = excluded.liquidity,
      volume        = excluded.volume,
      open_interest = excluded.open_interest,
      start_date    = excluded.start_date,
      end_date      = excluded.end_date,
      updated_at    = excluded.updated_at
  `);

  const upsertTag = db.prepare(`
    INSERT INTO tags (id, label, slug)
    VALUES (@id, @label, @slug)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      slug  = excluded.slug
  `);

  const upsertEventTag = db.prepare(`
    INSERT OR IGNORE INTO event_tags (event_id, tag_id)
    VALUES (@eventId, @tagId)
  `);

  const upsertMarket = db.prepare(`
    INSERT INTO markets
      (id, title, description, resolution_condition, category, clob_token_id,
       metadata_hash, last_seen_at, event_id, event_slug, neg_risk,
       group_item_title, group_item_threshold)
    VALUES
      (@id, @title, @description, @resolutionCondition, '', @clobTokenId,
       @metadataHash, @lastSeenAt, @eventId, @eventSlug, @negRisk,
       @groupItemTitle, @groupItemThreshold)
    ON CONFLICT(id) DO UPDATE SET
      title                = excluded.title,
      description          = excluded.description,
      resolution_condition = excluded.resolution_condition,
      clob_token_id        = excluded.clob_token_id,
      metadata_hash        = excluded.metadata_hash,
      last_seen_at         = excluded.last_seen_at,
      event_id             = excluded.event_id,
      event_slug           = excluded.event_slug,
      neg_risk             = excluded.neg_risk,
      group_item_title     = excluded.group_item_title,
      group_item_threshold = excluded.group_item_threshold
  `);

  let marketCount = 0;
  let tagAssocCount = 0;

  db.transaction(() => {
    for (const event of events) {
      // 1. upsert event
      upsertEvent.run({
        id: event.id,
        slug: event.slug,
        title: event.title ?? "",
        description: event.description ?? "",
        negRisk: event.negRisk ? 1 : 0,
        active: event.active !== false ? 1 : 0,
        closed: event.closed ? 1 : 0,
        archived: event.archived ? 1 : 0,
        liquidity: event.liquidity ?? null,
        volume: event.volume ?? null,
        openInterest: event.openInterest ?? null,
        startDate: event.startDate ?? null,
        endDate: event.endDate ?? null,
        createdAt: event.createdAt ?? null,
        updatedAt: event.updatedAt ?? null,
      });

      // 2. upsert tags + junction rows
      for (const tag of event.tags ?? []) {
        upsertTag.run({ id: tag.id, label: tag.label, slug: tag.slug });
        upsertEventTag.run({ eventId: event.id, tagId: tag.id });
        tagAssocCount++;
      }

      // 3. upsert markets (FK satisfied since event row is already inserted above)
      for (const market of event.markets ?? []) {
        const title = market.question ?? "";
        const description = market.description ?? "";
        const resolutionCondition = market.resolutionSource ?? "";
        upsertMarket.run({
          id: market.id,
          title,
          description,
          resolutionCondition,
          clobTokenId: parseYesTokenId(market),
          metadataHash: computeHash(title, description, resolutionCondition),
          lastSeenAt: now,
          eventId: event.id,
          eventSlug: event.slug,
          negRisk: (market.negRisk ?? event.negRisk) ? 1 : 0,
          groupItemTitle: market.groupItemTitle ?? "",
          groupItemThreshold: market.groupItemThreshold ?? "",
        });
        marketCount++;
      }
    }
  })();

  console.log(
    `Persisted: ${events.length} events, ${marketCount} markets, ${tagAssocCount} event-tag associations`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initDb();
  console.log("Database initialised.");

  console.log("Fetching all events from Gamma API...");
  const events = await fetchAllEvents();
  console.log(`Fetched ${events.length} events.`);

  persistAll(events);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
