# PRD: Polymarket Logical Mismatch Detector

## Problem Statement

Prediction markets on Polymarket frequently price logically related events inconsistently — violating fundamental probability laws. A trader watching markets manually cannot systematically identify these structural mispricings across thousands of active markets. There is no tooling that groups related markets, applies probability rules, and surfaces violations in a queryable, persistent record.

## Solution

A scheduled TypeScript/Node.js service that periodically fetches market data from Polymarket, groups related markets using LLM-based classification, evaluates each group against probability constraint rules, and logs all detected violations to a structured file and SQLite database. Violations above a significance threshold are flagged as potentially profitable.

## User Stories

1. As a trader, I want the system to automatically fetch all active Polymarket markets every 4 hours, so that my market catalogue stays current without manual intervention.
2. As a trader, I want markets to be pre-filtered by category and shared entity keywords before LLM grouping, so that the grouping step only considers plausibly related markets.
3. As a trader, I want related markets to be grouped by an LLM using their title, description, and resolution condition, so that semantic relationships are captured even when titles are worded differently.
4. As a trader, I want groups to be cached in SQLite and reused across polling cycles, so that LLM calls are only made for new or changed markets.
5. As a trader, I want newly detected markets to be matched against existing groups in their category+entity bucket, so that a new threshold market correctly joins an existing threshold group.
6. As a trader, I want each market's metadata to be hashed, so that I can detect when a market's title, description, or resolution condition has changed and trigger re-grouping for that market.
7. As a trader, I want the system to detect Threshold Ordering violations (Type 3), so that I am alerted when `P(X > 70k) > P(X > 60k)`.
8. As a trader, I want the system to detect Exhaustive Partition violations (Type 4), so that I am alerted when the sum of probabilities across mutually exclusive outcome buckets deviates from 1.
9. As a trader, I want the system to detect Complementary Outcome violations (Type 1), so that I am alerted when `P(A) + P(B) ≠ 1` for two complement markets.
10. As a trader, I want the system to detect Temporal Dependency violations (Type 2), so that I am alerted when an earlier-timeframe market is priced higher than a later-inclusive one.
11. As a trader, I want the system to detect Conditional Probability violations (Type 5), so that I am alerted when a joint event is priced higher than one of its constituent events.
12. As a trader, I want the system to detect Multi-Market Constraint violations (Type 6), so that I am alerted when a joint probability falls outside its Fréchet bounds.
13. As a trader, I want prices to be fetched from the CLOB API every 30 minutes, so that mismatch detection runs against reasonably fresh market prices.
14. As a trader, I want every detected mismatch to be written to a structured log file, so that I have a human-readable record of all violations.
15. As a trader, I want every detected mismatch to be persisted in SQLite, so that I can query violation history, filter by type, and analyse trends over time.
16. As a trader, I want mismatches with a magnitude greater than 0.05 to be flagged with `profitable: true`, so that I can quickly identify violations large enough to act on.
17. As a trader, I want each logged mismatch to include the mismatch type, the market IDs and titles involved, the specific prices that violate the rule, the violation magnitude, and the detection timestamp, so that I have full context without looking up markets manually.
18. As a trader, I want the system to run on a schedule without manual intervention, so that I can leave it running and review logs at my own cadence.
19. As a trader, I want the LLM grouping output to include a confidence score, so that I can filter out low-confidence groups when reviewing detected mismatches.
20. As a trader, I want the entity keyword dictionary to be maintainable, so that I can add new entities (new tickers, new political figures) as markets evolve.

## Implementation Decisions

### Modules

**Gamma API Client**
Fetches active market metadata (title, description, resolution condition, category, tags) from `gamma-api.polymarket.com`. Runs every 4 hours. Returns a normalised list of market records. Detects changed markets by comparing a hash of title + description + resolution condition against the stored hash in SQLite.

**CLOB API Client**
Fetches current best prices for a given set of market IDs from `clob.polymarket.com`. Runs every 30 minutes. Returns a map of market ID → YES price.

**Entity Extractor**
Applies a two-level filter to produce candidate buckets:
1. Polymarket native category (Crypto, Politics, Sports, etc.)
2. Keyword entity dictionary match within category (BTC, ETH, Trump, Fed, etc.)

Returns a list of buckets, each containing a set of market IDs that share a category and at least one entity keyword. The keyword dictionary is a maintained static config file.

**Market Grouper**
Takes a bucket of markets (title + description + resolution condition) and sends them in a single batched prompt to an LLM (Claude Haiku or GPT-4o-mini). The LLM returns structured JSON identifying logical groups within the bucket, the mismatch type each group participates in, and a confidence score per group. Groups are stored in SQLite. New markets trigger a grouping call against all existing markets in the same bucket.

**Group Cache**
SQLite-backed persistence for market groups. Stores: group ID, mismatch type, member market IDs, LLM confidence score, `grouped_at` timestamp. Supports: lookup by market ID, lookup by category+entity bucket, insertion of new groups, addition of a market to an existing group.

**Mismatch Detectors**
One detector module per mismatch type, each with a single interface: takes a group record + a map of current prices → returns a mismatch result or null.

- Type 3 (Threshold Ordering): verify monotonicity across ordered threshold markets
- Type 4 (Exhaustive Partition): verify sum of bucket probs equals 1 within tolerance
- Type 1 (Complementary Outcome): verify two complement markets sum to 1
- Type 2 (Temporal Dependency): verify earlier-timeframe prob ≤ later-timeframe prob
- Type 5 (Conditional Probability): verify joint event prob ≤ each constituent prob
- Type 6 (Multi-Market Constraint): verify joint prob is within Fréchet bounds

**Alert Logger**
Takes a mismatch result and writes it to: (a) a structured NDJSON log file, (b) the SQLite `mismatches` table. Sets `profitable: true` if magnitude > 0.05. Each record includes: mismatch type, market IDs, market titles, individual prices, violation magnitude, profitable flag, detected_at timestamp.

**Scheduler**
`node-cron` orchestrator that wires the polling loops: Gamma client + grouper on 4-hour cadence, CLOB client + detectors on 30-minute cadence.

### Data Model (SQLite)

- `markets` — id, title, description, resolution_condition, category, metadata_hash, last_seen_at
- `groups` — id, mismatch_type, market_ids (JSON array), confidence, grouped_at
- `mismatches` — id, group_id, mismatch_type, market_ids (JSON array), prices (JSON), magnitude, profitable, detected_at

### API Contracts

LLM grouping output schema (per group within a bucket):
```
{
  "mismatch_type": "threshold_ordering" | "exhaustive_partition" | "complementary" | "temporal_dependency" | "conditional_probability" | "multi_market_constraint",
  "market_ids": string[],
  "confidence": number  // 0–1
}
```

Mismatch detector return type:
```
{
  "violated": boolean,
  "magnitude": number,
  "details": Record<string, number>  // market_id → price
}
```

## Testing Decisions

Good tests for this system verify **external behaviour against defined inputs**, not internal implementation. Each detector module is a pure function (group + prices → result), making them ideal unit test targets. The Group Cache and entity extractor are also fully testable in isolation.

**What to test:**
- **Mismatch Detectors (all 6)**: given a constructed group record and a price map, assert correct violation detection, correct magnitude calculation, and correct non-violation handling for edge cases (prices exactly at boundary, partial data).
- **Entity Extractor**: given a list of market titles and categories, assert correct bucket formation for known entities and correct handling of markets that match no entity.
- **Group Cache**: given a sequence of insert/lookup operations, assert correct group membership, correct hash-based change detection, and correct bucket retrieval for new markets.

**What not to test:**
- LLM grouping output (non-deterministic, tested via prompt evaluation not unit tests)
- Scheduler timing (integration concern, not unit testable)
- API clients (mock at the boundary; test the data normalisation layer if one exists)

## Out of Scope

- Automated trade execution
- Mismatch types 7 (Cross-Market Definition) and 8 (Correlation Mispricing)
- Real-time WebSocket price streaming
- Web dashboard or frontend
- Telegram / Slack / email alerting
- Reclassification of existing market groups
- Multi-exchange price aggregation
- Position sizing or risk management logic

## Further Notes

- The 0.05 profitable threshold is an initial heuristic. Query the SQLite `mismatches` table after a few days of data to calibrate it against observed market spreads.
- The keyword entity dictionary is the most likely component to need manual maintenance. Consider logging any market that passes category filter but matches no entity keyword, to identify gaps.
- LLM grouping confidence scores should be stored but are not currently used to filter alerts. A sensible future threshold is to suppress mismatches from groups with confidence < 0.7.
- Polymarket's Gamma API rate limits are not publicly documented — implement exponential backoff on the client from the start.
