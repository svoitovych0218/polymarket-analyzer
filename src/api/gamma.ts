import crypto from "crypto";
import { getDb } from "../db/schema";

// ── Raw API types ────────────────────────────────────────────────────────────

interface GammaMarket {
  id: string;
  question: string;         // Gamma uses "question" for the market title
  description: string;
  resolutionSource?: string;
  // JSON-encoded string array: [yesTokenId, noTokenId]
  clobTokenIds?: string;
  active: boolean;
  closed: boolean;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface Market {
  id: string;
  title: string;
  description: string;
  resolutionCondition: string;
  category: string;
  clobTokenId: string;      // YES token ID for the CLOB API; "" if unavailable
  metadataHash: string;
  lastSeenAt: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const PAGE_LIMIT = 500;
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

function parseYesTokenId(raw: GammaMarket): string {
  try {
    const ids: string[] = JSON.parse(raw.clobTokenIds ?? "[]");
    return ids[0] ?? "";
  } catch {
    return "";
  }
}

function normalize(raw: GammaMarket, now: string): Market {
  const title = raw.question ?? "";
  const description = raw.description ?? "";
  // Category is not available on the markets endpoint — inferred later
  // by the entity extractor using the keyword dictionary.
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

async function fetchAllMarkets(): Promise<GammaMarket[]> {
  const all: GammaMarket[] = [];
  let offset = 0;

  while (true) {
    const url =
      `${GAMMA_BASE_URL}/markets` +
      `?active=true&closed=false&limit=${PAGE_LIMIT}&offset=${offset}`;

    const res = await fetchWithBackoff(url);
    const page: GammaMarket[] = await res.json();

    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }

  return all;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetches all active markets from the Gamma API, upserts them into SQLite,
 * and returns only the markets whose metadata changed since the last poll.
 * Designed to be called every 4 hours by the scheduler.
 */
export async function pollGammaMarkets(): Promise<Market[]> {
  const raw = await fetchAllMarkets();
  const now = new Date().toISOString();
  const markets = raw.map((r) => normalize(r, now));

  const db = getDb();

  // Load all existing hashes in one query for efficient change detection
  const existingRows = db
    .prepare(`SELECT id, metadata_hash FROM markets`)
    .all() as Array<{ id: string; metadata_hash: string }>;
  const existingHashes = new Map(existingRows.map((r) => [r.id, r.metadata_hash]));

  const changed: Market[] = [];
  for (const m of markets) {
    if (existingHashes.get(m.id) !== m.metadataHash) {
      changed.push(m);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO markets
      (id, title, description, resolution_condition, category, clob_token_id, metadata_hash, last_seen_at)
    VALUES
      (@id, @title, @description, @resolutionCondition, @category, @clobTokenId, @metadataHash, @lastSeenAt)
    ON CONFLICT(id) DO UPDATE SET
      title                = excluded.title,
      description          = excluded.description,
      resolution_condition = excluded.resolution_condition,
      category             = excluded.category,
      clob_token_id        = excluded.clob_token_id,
      metadata_hash        = excluded.metadata_hash,
      last_seen_at         = excluded.last_seen_at
  `);

  db.transaction(() => {
    for (const m of markets) {
      upsert.run(m);
    }
  })();

  console.log(
    `Gamma poll complete: ${markets.length} markets fetched, ${changed.length} changed`
  );
  return changed;
}
