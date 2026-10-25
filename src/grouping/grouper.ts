import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { getDb } from "../db/schema";
import type { Market } from "../api/gamma";
import type { Bucket, EventGroup } from "./extractor";

// ── Types ────────────────────────────────────────────────────────────────────

const VALID_MISMATCH_TYPES = [
  "threshold_ordering",
  "exhaustive_partition",
  "complementary",
  "temporal_dependency",
  "conditional_probability",
  "multi_market_constraint",
  "implication",
  "mutually_exclusive",
] as const;

type MismatchType = (typeof VALID_MISMATCH_TYPES)[number];

const MISMATCH_TYPE_INT: Record<MismatchType, number> = {
  threshold_ordering: 1,
  exhaustive_partition: 2,
  complementary: 3,
  temporal_dependency: 4,
  conditional_probability: 5,
  multi_market_constraint: 6,
  implication: 7,
  mutually_exclusive: 8,
};

/** Types that only make sense across two or more distinct events. */
const CROSS_EVENT_TYPES: ReadonlySet<string> = new Set(["implication", "mutually_exclusive"]);

interface LlmGroup {
  mismatch_type: string;
  market_ids: string[];
  confidence: number;
  reasoning: string;
  assumption?: string;
}

interface DbGroup {
  id: string;
  mismatch_type: number;
  market_ids: string; // JSON-encoded string[]
  confidence: number;
  bucket_key: string;
}

type AssignmentAction =
  | { action: "join"; market_id: string; group_id: string }
  | {
      action: "new_group";
      market_id: string;
      mismatch_type: string;
      with_market_ids: string[];
      confidence: number;
      reasoning: string;
      assumption?: string;
    }
  | { action: "none"; market_id: string };

// ── Prompts ───────────────────────────────────────────────────────────────────

const TYPE_DEFINITIONS = `MISMATCH TYPES (market_ids order matters — follow the order given for each type):

implication: Market A resolving YES guarantees market B resolves YES, so P(A) ≤ P(B). Exactly 2 markets, ordered [A, B] (narrower outcome first). Markets must come from DIFFERENT events. Use this for links that are not a simple threshold or calendar ladder: nested outcomes, or deadlines defined by another event.
  ✓ "Russia x Ukraine ceasefire before GTA VI?" ⇒ "Russia x Ukraine ceasefire in 2026?" — holds only if GTA VI releases before 2027 (state this as the assumption).
  ✓ "Will JD Vance win the 2028 presidential election?" ⇒ "Will a Republican win the 2028 presidential election?"
  ✗ "Will BTC hit $150k in 2026?" ⇒ "Will MicroStrategy buy Bitcoin in 2026?" — plausible correlation, not a logical guarantee.

mutually_exclusive: At most one of the markets can resolve YES, but all of them CAN resolve NO, so the YES prices must sum to ≤ 1. 2+ markets from DIFFERENT events.
  ✓ "Will the Fed cut rates in December?" vs "Will the Fed hike rates in December?" — both can be NO (hold), never both YES.
  ✓ "Will Sinner win Wimbledon 2026?" vs "Will Alcaraz win Wimbledon 2026?" on separate event pages.
  ✗ Two outcomes that are merely unlikely to happen together.

threshold_ordering: Same metric, same subject, same time window, same direction, different thresholds. Ordered from lowest threshold to highest; a higher-threshold YES implies a lower-threshold YES.
  Example: ["Will BTC exceed $50k by Dec 31?", "Will BTC exceed $100k by Dec 31?"]

temporal_dependency: The same outcome with different calendar deadlines. Ordered from earliest deadline to latest; YES by an earlier deadline implies YES by a later one ("by Q1" is contained in "by Q2" — overlapping "by" windows are expected).
  Example: ["Will BTC reach $100k by March 31?", "Will BTC reach $100k by June 30?"]

complementary: Exactly 2 markets where one is the exact negation of the other: exactly one MUST resolve YES.
  KEY TEST: Can both resolve NO? Can both resolve YES? If either answer is yes, they are NOT complementary.
  ✓ "Will BTC close above $50k on Dec 31?" vs "Will BTC close at or below $50k on Dec 31?"
  ✗ "Will Candidate A win?" vs "Will Candidate B win?" in a multi-candidate race — both can be NO.

exhaustive_partition: Markets from ONE event that are mutually exclusive and collectively exhaustive — exactly one resolves YES. No missing and no overlapping outcomes. Never use this for [ONE-WINNER] events (already tracked) or across events.

conditional_probability: Market 0 is a compound outcome that requires every other market in the group to resolve YES (e.g. "A and B" or "A, then B"). Ordered [compound, requirement1, requirement2, ...]. The condition must be stated in the market definitions.

multi_market_constraint: Exactly 3 markets ordered [joint, A, B] where the joint market is "A and B"; its price must stay within the Fréchet bounds of A and B.`;

const ANALYSIS_STEPS = `HOW TO ANALYSE — apply to every candidate set of markets:
1. Same underlying outcome? Compare the resolution rules, not just the titles: same subject, same definition (e.g. what counts as a "ceasefire" or a "release"), compatible resolution sources. If definitions differ, do not group.
2. Express the relationship in YES outcomes: does A YES force B YES? Can both be YES? Can both be NO? Must exactly one be YES?
3. Check deadlines using the end dates provided. A deadline may be another real-world event ("before GTA VI releases", "before the next Fed meeting"). Then the relationship only holds under an assumption about when that event happens — write it in "assumption" and lower confidence if the market data does not confirm it.
4. Try to construct a scenario that breaks the constraint. If you can (given the assumption), do not group.

COMMON MISTAKES — never make these groupings:
1. Grouping on topic or correlation alone. "Likely together" or "unlikely together" is not a constraint.
2. Grouping different subjects (different elections, assets, people, time periods) unless one outcome logically decides the other.
3. Calling two candidates in a multi-candidate race complementary.
4. Returning exhaustive_partition for an [ONE-WINNER] event, or spanning several events.
5. Grouping markets whose resolution rules define the outcome differently.`;

const SYSTEM_PROMPT = `You are a prediction market analyst. You find sets of Polymarket markets whose prices are bound by logic: given how the markets resolve, some price combinations are impossible, which creates arbitrage when prices break the rule.

Your priority is CROSS-EVENT relationships: markets listed under different events that depend on the same real-world outcome (e.g. "ceasefire in 2026" on one event page and "ceasefire before GTA VI" on another). Traders miss these because the markets are not shown together. Relationships within a single event are also valid.

INPUT: markets grouped by event. Each market has an ID, its question, its end date and, where available, its resolution rules. Events marked [ONE-WINNER] have exactly one market resolving YES; that partition is already tracked, so do not return it — but DO use those markets in cross-event groups.

${ANALYSIS_STEPS}

${TYPE_DEFINITIONS}

OUTPUT: a JSON array of groups. Each group must have:
- "mismatch_type": one of the types above
- "market_ids": market IDs in the order the type requires (minimum 2)
- "confidence": float 0.0–1.0
- "reasoning": 1–3 sentences stating the constraint and why it always holds (required, non-empty)
- "assumption": the external fact the constraint depends on (e.g. "GTA VI releases before 2027-01-01"), or "" if it holds purely by the market definitions

When in doubt, leave it out. Return ONLY a JSON array, no markdown, no explanation. If no groups exist, return [].`;

const MATCHING_SYSTEM_PROMPT = `You are a prediction market analyst. You classify new Polymarket markets into existing logical groups, or form new groups whose prices are bound by logic. Prioritise CROSS-EVENT relationships: markets under different events that depend on the same real-world outcome.

You will be given:
1. EXISTING GROUPS: groups already established with their constituent markets
2. UNASSIGNED markets: other markets in the bucket not yet in any LLM group — candidates to group with new markets. [ONE-WINNER] events have exactly one market resolving YES; that partition is already tracked.
3. NEW markets: the market(s) you must classify

${ANALYSIS_STEPS}

${TYPE_DEFINITIONS}

For each new market return exactly one decision:
- Join an existing group: {"market_id":"...","action":"join","group_id":"existing-uuid"}
- Form a new group: {"market_id":"...","action":"new_group","mismatch_type":"...","with_market_ids":["id1","id2"],"confidence":0.9,"reasoning":"...","assumption":""}
  ("with_market_ids" includes the new market itself plus at least one other market, in the order the type requires; "reasoning" is required and non-empty; "assumption" is the external fact the constraint depends on, or "")
- No fit: {"market_id":"...","action":"none"}

Rules:
- Never reassign markets already in an existing group
- Only "join" a group if the market fits that group's type and order; otherwise prefer "new_group" or "none"
- "join" does not require a reasoning field
- When in doubt, return "none"

Return ONLY a JSON array of decisions, one per new market, no markdown.`;

/** Max characters of rules/description text per market or event in a prompt. */
const RULES_MAX_CHARS = 500;

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + "…" : flat;
}

function formatEndDate(endDate: string | undefined): string {
  return endDate ? endDate.slice(0, 10) : "unknown";
}

function renderMarketLine(id: string, label: string, market: Market | undefined): string {
  return `  - ID: ${id} | "${label}" | ends: ${formatEndDate(market?.endDate)}`;
}

function renderEventBlock(event: EventGroup, marketMap: Map<string, Market>): string {
  const header = event.negRisk
    ? `Event: ${event.eventSlug} [ONE-WINNER]`
    : `Event: ${event.eventSlug}`;

  if (event.markets.length === 1) {
    const m = event.markets[0];
    const market = marketMap.get(m.id);
    const lines = [header, renderMarketLine(m.id, market?.title || m.groupItemTitle || m.id, market)];
    const rules = market?.description || event.description;
    if (rules) lines.push(`    Rules: ${truncate(rules, RULES_MAX_CHARS)}`);
    return lines.join("\n");
  }

  const lines = [header, `Title: ${event.title}`];
  if (event.description) lines.push(`Rules: ${truncate(event.description, RULES_MAX_CHARS)}`);
  lines.push("Markets:");
  for (const m of event.markets) {
    const market = marketMap.get(m.id);
    lines.push(renderMarketLine(m.id, market?.title || m.groupItemTitle || m.id, market));
  }
  return lines.join("\n");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildFreshEventPrompt(
  bucket: Bucket,
  chunkEvents: EventGroup[],
  marketMap: Map<string, Market>
): string {
  const sections: string[] = [];

  for (const event of chunkEvents) {
    sections.push(renderEventBlock(event, marketMap));
  }

  return (
    `Today: ${today()}\n` +
    `Markets in the ${bucket.category} / ${bucket.entity} bucket:\n\n` +
    sections.join("\n---\n") +
    "\n\nIdentify logical groups where prices must be constrained, prioritising cross-event relationships. Return a JSON array."
  );
}

function buildMatchingEventPrompt(
  bucket: Bucket,
  existingGroups: DbGroup[],
  marketMap: Map<string, Market>,
  unassignedEvents: EventGroup[],
  newEvents: EventGroup[]
): string {
  const intToType = Object.fromEntries(
    Object.entries(MISMATCH_TYPE_INT).map(([k, v]) => [v, k])
  );

  let prompt = `Today: ${today()}\n`;
  prompt += `New market(s) to classify in the ${bucket.category} / ${bucket.entity} bucket.\n\n`;

  prompt += `EXISTING GROUPS:\n`;
  for (const g of existingGroups) {
    const ids: string[] = JSON.parse(g.market_ids);
    const typeName = intToType[g.mismatch_type] ?? "unknown";
    prompt += `\nGroup ID: ${g.id} (${typeName})\n`;
    for (const id of ids) {
      const m = marketMap.get(id);
      prompt += renderMarketLine(id, m?.title ?? "(unknown)", m) + "\n";
    }
  }

  if (unassignedEvents.length > 0) {
    prompt += `\nUNASSIGNED markets in bucket (may be grouped with new markets):\n`;
    for (const event of unassignedEvents) {
      prompt += "---\n" + renderEventBlock(event, marketMap) + "\n";
    }
  }

  prompt += `\nNEW market(s) to classify:\n`;
  for (const event of newEvents) {
    prompt += "---\n" + renderEventBlock(event, marketMap) + "\n";
  }

  prompt += `\nReturn a JSON array with one decision object per new market.`;
  return prompt;
}

// ── LLM callers ──────────────────────────────────────────────────────────────

const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/** Model name for the active provider. Override with LLM_MODEL in .env. */
function resolveModel(defaultModel: string): string {
  return process.env.LLM_MODEL?.trim() || defaultModel;
}

async function callClaude(systemPrompt: string, userPrompt: string): Promise<string> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: resolveModel(DEFAULT_CLAUDE_MODEL),
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });
  return message.content[0].type === "text" ? message.content[0].text : "[]";
}

async function callOpenAi(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolveModel(DEFAULT_OPENAI_MODEL),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const retryAfter = res.headers.get("Retry-After");
    const err = new Error(`OpenAI API error: ${res.status} ${res.statusText}`) as Error & {
      status: number;
      retryAfter: number | null;
    };
    err.status = res.status;
    err.retryAfter = retryAfter ? parseInt(retryAfter, 10) : null;
    throw err;
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "[]";
}

async function callLlm(systemPrompt: string, userPrompt: string): Promise<string> {
  const provider = (process.env.LLM_PROVIDER ?? "claude").toLowerCase();
  return provider === "openai"
    ? callOpenAi(systemPrompt, userPrompt)
    : callClaude(systemPrompt, userPrompt);
}

const LLM_MAX_RETRIES = 5;
const LLM_BASE_DELAY_MS = 2_000;

/** Delay between successive LLM calls. Set LLM_CALL_DELAY_MS=3000 for OpenAI free tier. */
const LLM_CALL_DELAY_MS = parseInt(process.env.LLM_CALL_DELAY_MS ?? "0", 10);

/** Max events per LLM call. Keeps prompts within context limits. Set lower for OpenAI. */
const BUCKET_CHUNK_SIZE = parseInt(process.env.BUCKET_CHUNK_SIZE ?? "50", 10);

/** Minimum LLM confidence score to persist a group. Groups below this threshold are discarded. */
const MIN_GROUP_CONFIDENCE = parseFloat(process.env.MIN_GROUP_CONFIDENCE ?? "0.80");

async function callLlmWithRetry(
  systemPrompt: string,
  userPrompt: string,
  label: string
): Promise<string | null> {
  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    try {
      const result = await callLlm(systemPrompt, userPrompt);
      if (LLM_CALL_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, LLM_CALL_DELAY_MS));
      }
      return result;
    } catch (err) {
      const isLast = attempt === LLM_MAX_RETRIES - 1;
      const status = (err as { status?: number }).status;
      const retryAfter = (err as { retryAfter?: number | null }).retryAfter;
      const retryable = status === 429 || (status !== undefined && status >= 500);

      if (!retryable || isLast) {
        console.warn(`Grouper: LLM call failed for ${label}, skipping`, err);
        return null;
      }

      const delay =
        status === 429 && retryAfter
          ? retryAfter * 1000
          : LLM_BASE_DELAY_MS * 2 ** attempt;

      console.warn(
        `Grouper: LLM call failed for ${label} (attempt ${attempt + 1}/${LLM_MAX_RETRIES}), retrying in ${delay}ms...`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

// ── Validation ───────────────────────────────────────────────────────────────

function extractArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const wrapped = Object.values(parsed as Record<string, unknown>).find((v) =>
      Array.isArray(v)
    );
    if (wrapped) return wrapped as unknown[];
  }
  return [];
}

interface EventMeta {
  eventIdByMarketId: Map<string, string>;
  negRiskEventIds: Set<string>;
}

function buildEventMeta(events: EventGroup[]): EventMeta {
  return {
    eventIdByMarketId: new Map(
      events.flatMap((event) => event.markets.map((m) => [m.id, event.eventId] as const))
    ),
    negRiskEventIds: new Set(events.filter((e) => e.negRisk).map((e) => e.eventId)),
  };
}

/**
 * Checks that a group's markets span events the way its type requires:
 * exhaustive_partition stays inside one event, cross-event types span 2+ events,
 * and nothing duplicates the auto-created partition of a single negRisk event.
 */
function fitsEventStructure(mismatchType: string, marketIds: string[], meta: EventMeta): boolean {
  const eventIds = new Set(marketIds.map((id) => meta.eventIdByMarketId.get(id)));
  if (eventIds.has(undefined)) return false;

  if (mismatchType === "exhaustive_partition") {
    return eventIds.size === 1 && !meta.negRiskEventIds.has([...eventIds][0]!);
  }
  if (eventIds.size === 1 && meta.negRiskEventIds.has([...eventIds][0]!)) return false;
  if (CROSS_EVENT_TYPES.has(mismatchType) && eventIds.size < 2) return false;
  if (mismatchType === "implication" && marketIds.length !== 2) return false;
  return true;
}

function isValidAssumption(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Reasoning as stored in the DB — the assumption is appended so it shows up in the Inspector. */
function storedReasoning(reasoning: string, assumption: string | undefined): string {
  const a = assumption?.trim();
  return a ? `${reasoning.trim()}\nAssumption: ${a}` : reasoning.trim();
}

function isValidGroup(g: unknown, validIds: Set<string>, meta: EventMeta): g is LlmGroup {
  if (typeof g !== "object" || g === null) return false;
  const obj = g as Record<string, unknown>;
  if (!VALID_MISMATCH_TYPES.includes(obj.mismatch_type as MismatchType)) return false;
  if (!Array.isArray(obj.market_ids) || obj.market_ids.length < 2) return false;
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return false;
  if (obj.confidence < MIN_GROUP_CONFIDENCE) return false;
  if (typeof obj.reasoning !== "string" || obj.reasoning.trim() === "") return false;
  if (!isValidAssumption(obj.assumption)) return false;
  if (!obj.market_ids.every((id) => (typeof id === "string" || typeof id === "number") && validIds.has(String(id)))) return false;
  return fitsEventStructure(obj.mismatch_type as string, obj.market_ids.map(String), meta);
}

function isValidAssignment(
  a: unknown,
  newMarketIds: Set<string>,
  allBucketIds: Set<string>,
  meta: EventMeta
): a is AssignmentAction {
  if (typeof a !== "object" || a === null) return false;
  const obj = a as Record<string, unknown>;
  if (typeof obj.market_id !== "string" || !newMarketIds.has(obj.market_id)) return false;

  if (obj.action === "join") {
    return typeof obj.group_id === "string" && obj.group_id.length > 0;
  }
  if (obj.action === "new_group") {
    if (!VALID_MISMATCH_TYPES.includes(obj.mismatch_type as MismatchType)) return false;
    if (!Array.isArray(obj.with_market_ids) || obj.with_market_ids.length < 2) return false;
    if (!(obj.with_market_ids as unknown[]).every((id) => typeof id === "string" && allBucketIds.has(id))) return false;
    if (!(obj.with_market_ids as string[]).includes(obj.market_id)) return false;
    if (typeof obj.confidence !== "number" || obj.confidence < MIN_GROUP_CONFIDENCE) return false;
    if (typeof obj.reasoning !== "string" || obj.reasoning.trim() === "") return false;
    if (!isValidAssumption(obj.assumption)) return false;
    return fitsEventStructure(obj.mismatch_type as string, obj.with_market_ids as string[], meta);
  }
  if (obj.action === "none") return true;
  return false;
}

// ── Auto-grouping for negRisk events ─────────────────────────────────────────

async function autoGroupNegRiskEvents(
  bucket: Bucket,
  now: string
): Promise<void> {
  const db = getDb();
  const negRiskEvents = bucket.events.filter(
    (e) => e.negRisk && e.markets.length >= 2
  );

  if (negRiskEvents.length === 0) return;

  const checkExisting = db.prepare(
    `SELECT id FROM groups WHERE bucket_key = ? AND source = 'auto' LIMIT 1`
  );

  const toCreate = negRiskEvents.filter(
    (e) => !checkExisting.get(e.eventSlug)
  );

  if (toCreate.length === 0) return;

  const insertGroup = db.prepare(`
    INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key, reasoning, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const event of toCreate) {
      const marketIds = [...event.markets]
        .sort(
          (a, b) =>
            parseInt(a.groupItemThreshold || "0") -
            parseInt(b.groupItemThreshold || "0")
        )
        .map((m) => m.id);

      insertGroup.run(
        crypto.randomUUID(),
        MISMATCH_TYPE_INT.exhaustive_partition,
        JSON.stringify(marketIds),
        1.0,
        now,
        event.eventSlug,
        "Auto-created from negRisk event structure",
        "auto"
      );
    }
  })();

  console.log(
    `Grouper: auto-grouped ${toCreate.length} negRisk event(s) in ${bucket.category}::${bucket.entity}`
  );
}

// ── Case 1: fresh LLM bucket (no existing LLM groups) ────────────────────────

async function classifyFreshBucketEvents(
  bucket: Bucket,
  llmEvents: EventGroup[],
  marketMap: Map<string, Market>,
  llmBucketKey: string,
  now: string
): Promise<void> {
  const validIds = new Set(llmEvents.flatMap((e) => e.markets.map((m) => m.id)));
  const meta = buildEventMeta(llmEvents);
  const allGroups: LlmGroup[] = [];

  for (let i = 0; i < llmEvents.length; i += BUCKET_CHUNK_SIZE) {
    const chunk = llmEvents.slice(i, i + BUCKET_CHUNK_SIZE);
    const chunkLabel =
      llmEvents.length > BUCKET_CHUNK_SIZE
        ? `${llmBucketKey} [events ${i + 1}–${Math.min(i + BUCKET_CHUNK_SIZE, llmEvents.length)}/${llmEvents.length}]`
        : llmBucketKey;

    const userPrompt = buildFreshEventPrompt(bucket, chunk, marketMap);

    if (process.env.DEBUG_PROMPTS === "true") {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`[DEBUG] SYSTEM PROMPT:\n${SYSTEM_PROMPT}`);
      console.log(`\n[DEBUG] USER PROMPT for ${chunkLabel}:\n${userPrompt}`);
      console.log(`${"─".repeat(60)}\n`);
    }

    const raw = await callLlmWithRetry(SYSTEM_PROMPT, userPrompt, chunkLabel);
    if (raw === null) continue;

    if (process.env.DEBUG_PROMPTS === "true") {
      console.log(`[DEBUG] RAW LLM RESPONSE for ${chunkLabel}:\n${raw}\n`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`Grouper: invalid JSON from LLM for ${chunkLabel}`);
      continue;
    }

    const parsedArray = extractArray(parsed);
    const groups = parsedArray
      .filter((g) => isValidGroup(g, validIds, meta))
      .map((g) => ({ ...(g as LlmGroup), market_ids: (g as LlmGroup).market_ids.map(String) }));

    if (parsedArray.length > 0 && groups.length === 0) {
      console.warn(
        `Grouper: LLM returned ${parsedArray.length} group(s) for ${chunkLabel} but all failed validation. Sample:`,
        JSON.stringify(parsedArray[0])
      );
    } else if (parsedArray.length === 0) {
      console.log(`Grouper: LLM returned no groups for ${chunkLabel}`);
    }

    allGroups.push(...groups);
  }

  const db = getDb();
  db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key, reasoning, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of allGroups) {
      insert.run(
        crypto.randomUUID(),
        MISMATCH_TYPE_INT[g.mismatch_type as MismatchType],
        JSON.stringify(g.market_ids),
        g.confidence,
        now,
        llmBucketKey,
        storedReasoning(g.reasoning, g.assumption),
        "llm"
      );
    }
  })();

  console.log(`Grouper: fresh bucket ${llmBucketKey} → ${allGroups.length} LLM groups`);
}

// ── Case 2: existing LLM groups — match new events into them ──────────────────

async function classifyNewEventsLlm(
  bucket: Bucket,
  existingGroups: DbGroup[],
  marketMap: Map<string, Market>,
  newEvents: EventGroup[],
  unassignedEvents: EventGroup[],
  llmBucketKey: string,
  now: string
): Promise<void> {
  const allBucketIds = new Set(bucket.marketIds);
  const meta = buildEventMeta(bucket.events);
  const newMarketIds = new Set(newEvents.flatMap((e) => e.markets.map((m) => m.id)));

  const userPrompt = buildMatchingEventPrompt(
    bucket,
    existingGroups,
    marketMap,
    unassignedEvents,
    newEvents
  );

  const raw = await callLlmWithRetry(MATCHING_SYSTEM_PROMPT, userPrompt, llmBucketKey);
  if (raw === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`Grouper: invalid JSON from matching LLM for ${llmBucketKey}`);
    return;
  }

  const assignments = extractArray(parsed).filter((a) =>
    isValidAssignment(a, newMarketIds, allBucketIds, meta)
  ) as AssignmentAction[];

  const db = getDb();
  const existingGroupIds = new Set(existingGroups.map((g) => g.id));

  db.transaction(() => {
    for (const assignment of assignments) {
      if (assignment.action === "join") {
        if (!existingGroupIds.has(assignment.group_id)) continue;
        const existing = existingGroups.find((g) => g.id === assignment.group_id)!;
        const ids: string[] = JSON.parse(existing.market_ids);
        if (!ids.includes(assignment.market_id)) {
          ids.push(assignment.market_id);
          db.prepare(`UPDATE groups SET market_ids = ? WHERE id = ?`).run(
            JSON.stringify(ids),
            assignment.group_id
          );
        }
      } else if (assignment.action === "new_group") {
        db.prepare(`
          INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key, reasoning, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          MISMATCH_TYPE_INT[assignment.mismatch_type as MismatchType],
          JSON.stringify(assignment.with_market_ids),
          assignment.confidence,
          now,
          llmBucketKey,
          storedReasoning(assignment.reasoning, assignment.assumption),
          "llm"
        );
      }
    }
  })();

  const joined = assignments.filter((a) => a.action === "join").length;
  const created = assignments.filter((a) => a.action === "new_group").length;
  console.log(
    `Grouper: bucket ${llmBucketKey} — ${newEvents.length} new event(s) → ${joined} joined, ${created} new LLM groups`
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Groups markets in a bucket via auto-grouping (negRisk events) and LLM,
 * and persists results to the groups table.
 *
 * negRisk events are auto-grouped as exhaustive_partition deterministically,
 * without an LLM call. All events — negRisk ones included, marked [ONE-WINNER]
 * — are then sent to the LLM so it can find cross-event relationships.
 */
export async function groupBucket(
  bucket: Bucket,
  marketMap: Map<string, Market>,
  changedIds: Set<string>
): Promise<void> {
  const hasChanges = bucket.marketIds.some((id) => changedIds.has(id));
  if (!hasChanges) return;

  const now = new Date().toISOString();

  // Step 1: Auto-group negRisk events (idempotent, no LLM)
  await autoGroupNegRiskEvents(bucket, now);

  // Step 2: LLM grouping. A lone negRisk event has nothing left to find —
  // its partition is auto-grouped and cross-event types need a second event.
  const llmEvents = bucket.events;
  if (llmEvents.length === 0) return;
  if (llmEvents.length === 1 && llmEvents[0].negRisk) return;

  const llmBucketKey = `${bucket.category}::${bucket.entity}`;
  const db = getDb();

  const existingLlmGroups = db
    .prepare(
      `SELECT id, mismatch_type, market_ids, confidence, bucket_key FROM groups WHERE bucket_key = ? AND source = 'llm'`
    )
    .all(llmBucketKey) as DbGroup[];

  if (existingLlmGroups.length === 0) {
    await classifyFreshBucketEvents(bucket, llmEvents, marketMap, llmBucketKey, now);
  } else {
    const groupedMarketIds = new Set(
      existingLlmGroups.flatMap((g) => JSON.parse(g.market_ids) as string[])
    );

    const newEvents = llmEvents.filter((event) =>
      event.markets.some((m) => changedIds.has(m.id) && !groupedMarketIds.has(m.id))
    );

    if (newEvents.length === 0) return;

    const unassignedEvents = llmEvents.filter(
      (event) =>
        !newEvents.includes(event) &&
        event.markets.some((m) => !groupedMarketIds.has(m.id))
    );

    await classifyNewEventsLlm(
      bucket,
      existingLlmGroups,
      marketMap,
      newEvents,
      unassignedEvents,
      llmBucketKey,
      now
    );
  }
}
