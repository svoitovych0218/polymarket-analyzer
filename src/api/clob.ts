// ── Types ────────────────────────────────────────────────────────────────────

interface ClobPriceRequest {
  token_id: string;
  side: "BUY";
}

// Response shape: { [tokenId]: { BUY: "0.58" } }
type ClobPriceResponse = Record<string, { BUY: string }>;

// ── Constants ────────────────────────────────────────────────────────────────

const CLOB_BASE_URL = "https://clob.polymarket.com";
const BATCH_SIZE = 100;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postWithBackoff(
  url: string,
  body: unknown,
  attempt = 0
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(BASE_DELAY_MS * 2 ** attempt);
    return postWithBackoff(url, body, attempt + 1);
  }

  if (res.ok) return res;

  const retryable = res.status === 429 || res.status >= 500;
  if (!retryable || attempt >= MAX_RETRIES) {
    throw new Error(`CLOB API error: ${res.status} ${res.statusText}`);
  }

  const delay =
    res.status === 429
      ? parseInt(res.headers.get("Retry-After") ?? "0", 10) * 1000 ||
        BASE_DELAY_MS * 2 ** attempt
      : BASE_DELAY_MS * 2 ** attempt;

  console.warn(`CLOB API ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1})`);
  await sleep(delay);
  return postWithBackoff(url, body, attempt + 1);
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetches the best YES (BUY-side) price for each market from the CLOB API.
 *
 * @param markets - Array of { id, clobTokenId } objects. Markets with an
 *   empty clobTokenId are silently skipped.
 * @returns Map of marketId → price (0–1). Markets with no active order book
 *   are omitted from the result.
 *
 * Designed to be called every 30 minutes by the scheduler.
 */
export async function fetchPrices(
  markets: Array<{ id: string; clobTokenId: string }>
): Promise<Map<string, number>> {
  // Filter out markets without a token ID and build a reverse lookup
  const eligible = markets.filter((m) => m.clobTokenId !== "");
  const tokenToMarketId = new Map(eligible.map((m) => [m.clobTokenId, m.id]));

  const priceMap = new Map<string, number>();

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    const payload: ClobPriceRequest[] = batch.map((m) => ({
      token_id: m.clobTokenId,
      side: "BUY",
    }));

    const res = await postWithBackoff(`${CLOB_BASE_URL}/prices`, payload);
    const data: ClobPriceResponse = await res.json();

    for (const [tokenId, sides] of Object.entries(data)) {
      const price = parseFloat(sides.BUY);
      if (isNaN(price)) continue;

      const marketId = tokenToMarketId.get(tokenId);
      if (marketId) {
        priceMap.set(marketId, price);
      }
    }
  }

  const skipped = eligible.length - priceMap.size;
  console.log(
    `CLOB price fetch: ${priceMap.size} prices fetched` +
      (skipped > 0 ? `, ${skipped} markets had no order book` : "")
  );

  return priceMap;
}
