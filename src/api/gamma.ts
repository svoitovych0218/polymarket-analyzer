import crypto from "crypto";
import { getDb } from "../db/schema";

// ── Raw API types ────────────────────────────────────────────────────────────

interface RawGammaMarketInEvent {
  id: string;
  question: string;
  description: string;
  resolutionSource?: string;
  clobTokenIds?: string;
  active: boolean;
  closed: boolean;
  groupItemTitle?: string;
  groupItemThreshold?: string;
  endDate?: string;
}

interface RawGammaEvent {
  id: string;
  slug: string;
  title: string;
  description?: string;
  negRisk?: boolean;
  markets: RawGammaMarketInEvent[];
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface Market {
  id: string;
  title: string;
  description: string;
  resolutionCondition: string;
  category: string;
  clobTokenId: string;
  metadataHash: string;
  lastSeenAt: string;
  eventId: string;
  eventSlug: string;
  negRisk: boolean;
  groupItemTitle: string;
  groupItemThreshold: string;
  /** ISO timestamp when the market closes; "" if Gamma omits it. */
  endDate: string;
}

export interface GammaEvent {
  eventId: string;
  eventSlug: string;
  negRisk: boolean;
  title: string;
  description: string;
  markets: Array<{ id: string; groupItemTitle: string; groupItemThreshold: string }>;
}

export interface PollResult {
  changed: Market[];
  events: GammaEvent[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
/** Gamma caps /events at 100 per page regardless of the requested limit. */
const PAGE_LIMIT = 100;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function computeHash(
  title: string,
  description: string,
  resolutionCondition: string
): string {
  return crypto
    .createHash("sha256")
    .update(`${title}|${description}|${resolutionCondition}`)
    .digest("hex")
    .slice(0, 32);
}

function parseYesTokenId(raw: RawGammaMarketInEvent): string {
  try {
    const ids: string[] = JSON.parse(raw.clobTokenIds ?? "[]");
    return ids[0] ?? "";
  } catch {
    return "";
  }
}

function normalizeMarket(
  raw: RawGammaMarketInEvent,
  event: RawGammaEvent,
  now: string
): Market {
  const title = raw.question ?? "";
  const description = raw.description ?? "";
  const resolutionCondition = raw.resolutionSource ?? "";
  return {
    id: raw.id,
    title,
    description,
    resolutionCondition,
    category: "",
    clobTokenId: parseYesTokenId(raw),
    metadataHash: computeHash(title, description, resolutionCondition),
    lastSeenAt: now,
    eventId: event.id,
    eventSlug: event.slug,
    negRisk: event.negRisk ?? false,
    groupItemTitle: raw.groupItemTitle ?? "",
    groupItemThreshold: raw.groupItemThreshold ?? "",
    endDate: raw.endDate ?? "",
  };
}

function normalizeEvent(raw: RawGammaEvent): GammaEvent {
  const markets = (raw.markets ?? [])
    .filter((m) => m.active && !m.closed)
    .map((m) => ({
      id: m.id,
      groupItemTitle: m.groupItemTitle ?? "",
      groupItemThreshold: m.groupItemThreshold ?? "",
    }))
    .sort(
      (a, b) =>
        parseInt(a.groupItemThreshold || "0") - parseInt(b.groupItemThreshold || "0")
    );

  return {
    eventId: raw.id,
    eventSlug: raw.slug,
    negRisk: raw.negRisk ?? false,
    title: raw.title ?? "",
    description: raw.description ?? "",
    markets,
  };
}

// ── Fetch with exponential backoff ───────────────────────────────────────────

async function fetchWithBackoff(
  url: string,
  attempt = 0
): Promise<Response> {
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

// ── Pagination ────────────────────────────────────────────────────────────────

async function fetchAllEvents(): Promise<RawGammaEvent[]> {
  const all: RawGammaEvent[] = [];
  let offset = 0;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() + 1);
  const endDateMax = cutoff.toISOString().slice(0, 10);

  while (true) {
    const url =
      `${GAMMA_BASE_URL}/events` +
      `?active=true&closed=false&limit=${PAGE_LIMIT}&offset=${offset}&end_date_max=${endDateMax}`;

    const res = await fetchWithBackoff(url);
    const page: RawGammaEvent[] = await res.json();

    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    offset += page.length;
  }

  return all;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetches all active events from the Gamma API, upserts their markets into
 * SQLite, and returns the changed markets and structured event list.
 * Designed to be called every 4 hours by the scheduler.
 */
export async function pollGammaMarkets(): Promise<PollResult> {
  const rawEvents = await fetchAllEvents();
  const now = new Date().toISOString();

  // Derive flat market list and structured event list from events
  const markets: Market[] = rawEvents.flatMap((event) =>
    (event.markets ?? [])
      .filter((m) => m.active && !m.closed)
      .map((m) => normalizeMarket(m, event, now))
  );
  const events: GammaEvent[] = rawEvents.map(normalizeEvent);

  const db = getDb();

  const existingRows = db
    .prepare(`SELECT id, metadata_hash FROM markets`)
    .all() as Array<{ id: string; metadata_hash: string }>;
  const existingHashes = new Map(existingRows.map((r) => [r.id, r.metadata_hash]));

  const changed = markets.filter((m) => existingHashes.get(m.id) !== m.metadataHash);

  const upsert = db.prepare(`
    INSERT INTO markets
      (id, title, description, resolution_condition, category, clob_token_id, metadata_hash, last_seen_at,
       event_id, event_slug, neg_risk, group_item_title, group_item_threshold, end_date)
    VALUES
      (@id, @title, @description, @resolutionCondition, @category, @clobTokenId, @metadataHash, @lastSeenAt,
       @eventId, @eventSlug, @negRisk, @groupItemTitle, @groupItemThreshold, @endDate)
    ON CONFLICT(id) DO UPDATE SET
      title                = excluded.title,
      description          = excluded.description,
      resolution_condition = excluded.resolution_condition,
      category             = excluded.category,
      clob_token_id        = excluded.clob_token_id,
      metadata_hash        = excluded.metadata_hash,
      last_seen_at         = excluded.last_seen_at,
      event_id             = excluded.event_id,
      event_slug           = excluded.event_slug,
      neg_risk             = excluded.neg_risk,
      group_item_title     = excluded.group_item_title,
      group_item_threshold = excluded.group_item_threshold,
      end_date             = excluded.end_date
  `);

  db.transaction(() => {
    for (const m of markets) {
      upsert.run({ ...m, negRisk: m.negRisk ? 1 : 0 });
    }
  })();

  console.log(
    `Gamma poll complete: ${markets.length} markets fetched, ${changed.length} changed`
  );
  return { changed, events };
}
