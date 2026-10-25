# Polymarket Analyzer

Detects logical mismatches between related [Polymarket](https://polymarket.com) prediction markets — cases where prices break basic probability rules (e.g. "BTC > $100k" priced higher than "BTC > $50k"). Such mismatches can indicate mispricing or arbitrage opportunities.

## How it works

The app runs two scheduled loops:

**1. Discovery** — on startup, then every 4 hours

1. Polls the [Gamma API](https://gamma-api.polymarket.com) for active events and markets and stores them in SQLite. Only markets whose metadata changed are re-processed.
2. Buckets related events by keyword entity (BTC, Trump, Fed, …) using the dictionary in `src/config/entities.ts`.
3. Polymarket `negRisk` events (exactly one outcome wins) are grouped automatically as exhaustive partitions, without the LLM.
4. Sends each bucket to an LLM with each market's question, end date and resolution rules. The LLM looks for logically linked markets, prioritising **cross-event** links (e.g. "ceasefire before GTA VI" vs "ceasefire in 2026" on separate event pages), and returns each group's mismatch type, confidence, reasoning and any external assumption it depends on. Groups below `MIN_GROUP_CONFIDENCE` are discarded.

**2. Detection** — on startup, then every 30 minutes

1. Fetches current prices from the [CLOB API](https://clob.polymarket.com) for every market in a group.
2. Runs a deterministic check per group type (no LLM involved). A violation must exceed a tolerance of 0.01.
3. Appends violations to `data/mismatches.ndjson`.

### Mismatch types

Types 7 and 8 must span at least two events. When a constraint depends on an outside fact (like a release date), the LLM's assumption is saved with the group's reasoning and shown in the Inspector.

| # | Type | Rule | Example |
|---|------|------|---------|
| 1 | Threshold ordering | Higher threshold ⇒ lower or equal probability | P(BTC > 100k) ≤ P(BTC > 50k) |
| 2 | Exhaustive partition | Mutually exclusive outcomes sum to ≈ 1 | Senate race winners |
| 3 | Complementary outcome | P(A) + P(not A) ≈ 1 | "X wins" vs "X loses" |
| 4 | Temporal dependency | Earlier deadline ⇒ lower or equal probability | P(by June) ≤ P(by December) |
| 5 | Conditional probability | P(A and B) ≤ P(A) | Nominee vs. election winner |
| 6 | Multi-market constraint | max(0, P(A)+P(B)−1) ≤ P(A and B) ≤ min(P(A), P(B)) | "A and B" market vs. A and B markets |
| 7 | Implication (cross-event) | A YES guarantees B YES ⇒ P(A) ≤ P(B) | "Ceasefire before GTA VI" vs "Ceasefire in 2026" |
| 8 | Mutually exclusive (cross-event) | At most one YES, all may be NO ⇒ sum ≤ 1 | "Fed cuts in Dec" vs "Fed hikes in Dec" |

## Requirements

- Node.js 22+
- An Anthropic API key (default) or an OpenAI API key

## Setup

```bash
npm install
cp .env.example .env   # then fill in your API key
```

## Configuration

All settings live in `.env`. See `.env.example` for the full annotated list.

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=claude` |
| `OPENAI_API_KEY` | — | Required when `LLM_PROVIDER=openai` |
| `LLM_PROVIDER` | `claude` | `claude` or `openai` |
| `LLM_MODEL` | `claude-haiku-4-5-20251001` / `gpt-4o-mini` | Model for the selected provider |
| `MIN_GROUP_CONFIDENCE` | `0.80` | Minimum LLM confidence to keep a group |
| `BUCKET_CHUNK_SIZE` | `50` | Max events per LLM call (lower for OpenAI) |
| `LLM_CALL_DELAY_MS` | `0` | Delay between LLM calls (e.g. `3000` for OpenAI low tiers) |
| `MISMATCH_LOG_PATH` | `data/mismatches.ndjson` | Where violations are written |
| `DEBUG_PROMPTS` | `false` | Print LLM prompts and raw responses |
| `SERVER_PORT` | `3001` | Port for the Groups Inspector API |

`LLM_MODEL` applies to whichever provider is selected — change it when you switch providers.

## Running

### Analyzer

```bash
npm start
```

Runs discovery and detection immediately, then keeps running on schedule. Stop with `Ctrl+C`.

### Groups Inspector UI

A small React app for browsing the groups the LLM created and their markets.

```bash
# Production: build the client once, then serve everything from the API server
cd client && npm install && npm run build && cd ..
npm run server            # http://localhost:3001

# Development: API server + Vite dev server with hot reload
npm run server
cd client && npm run dev  # Vite proxies /api to the server
```

### Starting fresh

State lives in `data/` (git-ignored). The database is created automatically on startup, and existing databases are migrated in place. To reset:

```bash
rm data/polymarket.db data/polymarket.db-shm data/polymarket.db-wal data/mismatches.ndjson
```

Note that the first run on an empty database sends every market to the LLM, so it takes longer and costs more than later incremental runs.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## Project structure

```
src/
  index.ts              Entry point: scheduler for discovery + detection loops
  server.ts             Fastify API for the Groups Inspector
  api/
    gamma.ts            Gamma API polling (events + markets)
    clob.ts             CLOB price fetching
  config/entities.ts    Keyword dictionary used for bucketing
  grouping/
    extractor.ts        Buckets events by entity
    grouper.ts          LLM grouping (prompts, provider calls, persistence)
  detection/
    detectors.ts        One detector per mismatch type
    logger.ts           NDJSON violation logging
  db/                   SQLite schema, migrations, and repositories
client/                 Groups Inspector (React + Vite)
api-samples/            Raw Gamma /events responses, kept as data-shape reference
data/                   Runtime state (SQLite DB, mismatch log) — git-ignored
```

`brief.md` describes the mismatch patterns in depth and `PRD.md` holds the product requirements.
