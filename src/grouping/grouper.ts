import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { getDb } from "../db/schema";
import type { Market } from "../api/gamma";
import type { Bucket } from "./extractor";

// ── Types ────────────────────────────────────────────────────────────────────

const VALID_MISMATCH_TYPES = [
  "threshold_ordering",
  "exhaustive_partition",
  "complementary",
  "temporal_dependency",
  "conditional_probability",
  "multi_market_constraint",
] as const;

type MismatchType = (typeof VALID_MISMATCH_TYPES)[number];

const MISMATCH_TYPE_INT: Record<MismatchType, number> = {
  threshold_ordering: 1,
  exhaustive_partition: 2,
  complementary: 3,
  temporal_dependency: 4,
  conditional_probability: 5,
  multi_market_constraint: 6,
};

interface LlmGroup {
  mismatch_type: string;
  market_ids: string[];
  confidence: number;
  reasoning: string;
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
    }
  | { action: "none"; market_id: string };

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a prediction market analyst specializing in identifying mathematical price constraints between related markets.

Given a list of prediction markets from the same category, identify logical groups where the market prices MUST be mathematically constrained — meaning the laws of probability or logic make certain price combinations impossible or necessary.

Return a JSON array of groups. Each group must have:
- "mismatch_type": one of the types listed below
- "market_ids": array of market IDs that form this group (minimum 2 markets)
- "confidence": float 0.0–1.0 representing your confidence in this grouping
- "reasoning": a concise explanation (1–3 sentences) of why the mathematical constraint applies (required, non-empty)

MISMATCH TYPE DEFINITIONS:

threshold_ordering: Markets measure the same metric at escalating threshold values, so a higher-threshold YES necessarily implies a lower-threshold YES. Markets must share the same time window, same asset/subject, and same direction. The probability of the higher-threshold event can never exceed the probability of the lower-threshold event.
  Example: "Will BTC exceed $50k by Dec 31?" vs "Will BTC exceed $100k by Dec 31?"

exhaustive_partition: A set of markets that are mutually exclusive and collectively exhaustive — exactly one resolves YES and all others resolve NO. The prices must sum to approximately 1.0. All markets must cover the same event with no overlapping and no missing outcomes.
  Example: "Will Candidate A win?" + "Will Candidate B win?" + "Will Candidate C win?" where exactly one of three candidates will win.

complementary: A market and its exact logical negation — the two markets partition all outcomes so that one MUST resolve YES and the other MUST resolve NO. Their prices must sum to 1.0.
  KEY TEST: Ask "Can both markets resolve NO simultaneously?" If yes, they are NOT complementary. Ask "Can both resolve YES simultaneously?" If yes, they are NOT complementary.
  ✓ VALID: "Will BTC close above $50k on Dec 31?" vs "Will BTC close at or below $50k on Dec 31?" — these partition all outcomes; exactly one resolves YES.
  ✗ INVALID: "Will BTC reach $94k May 4–10?" vs "Will BTC dip to $78k May 4–10?" — BTC could stay between $78k–$94k, so BOTH can resolve NO. NOT complementary.
  ✗ INVALID: "Will Candidate A win?" vs "Will Candidate B win?" in a multi-candidate race — both can resolve NO. NOT complementary.

temporal_dependency: Sequential time-window markets measuring the same outcome where an earlier-window YES implies a later-window YES. Markets must share the same asset, same direction, and have strictly ordered, non-overlapping time windows. An earlier YES is a logical subset of a later YES.
  Example: "Will BTC reach $100k by end of Q1?" vs "Will BTC reach $100k by end of Q2?" — Q1 YES implies Q2 YES.

conditional_probability: One market is explicitly conditional on the resolution of another market. The conditioning relationship must be stated in the market titles or descriptions. Do not infer conditioning from topic similarity alone.

multi_market_constraint: Three or more markets with a complex mathematical relationship not captured by the above types. The constraint must be derivable from probability rules or market definitions, not just thematic similarity.

COMMON MISTAKES — never make these groupings:
1. Do NOT group two directional markets as complementary when both can resolve NO (e.g. two different price targets for the same asset in the same window).
2. Do NOT group markets as threshold_ordering when they cover different time windows or different assets.
3. Do NOT group markets as exhaustive_partition unless you are certain no outcome is missing and none overlap — when in doubt, do not group.
4. Do NOT group markets based on topic or thematic similarity alone — the mathematical constraint must be real and directly derivable from the market definitions.
5. Do NOT group markets from different underlying events (different assets, different elections, different subjects).
6. Do NOT group two candidates in a multi-candidate race as complementary.

Return ONLY a JSON array, no markdown, no explanation. If no groups exist, return [].`;

const MATCHING_SYSTEM_PROMPT = `You are a prediction market analyst. Your task is to classify new prediction markets into existing logical groups, or identify if they should form new groups.

You will be given:
1. EXISTING GROUPS: groups already established with their constituent markets
2. UNASSIGNED markets: other markets in the bucket not yet in any group (for context only)
3. NEW markets: the market(s) you must classify

For each new market return exactly one decision:
- Join an existing group: {"market_id":"...","action":"join","group_id":"existing-uuid"}
- Form a new group (with ≥1 other unassigned market): {"market_id":"...","action":"new_group","mismatch_type":"...","with_market_ids":["id1","id2"],"confidence":0.9,"reasoning":"..."}
  ("with_market_ids" must include the new market itself plus at least one other market; "reasoning" is required and non-empty)
- No fit: {"market_id":"...","action":"none"}

Rules:
- Never reassign markets already in an existing group
- "new_group" requires at least 2 market IDs in with_market_ids (including the new market)
- "new_group" requires a non-empty "reasoning" string explaining the mathematical constraint
- "join" does not require a reasoning field
- Return a JSON array of decisions, one per new market

Valid mismatch types: threshold_ordering, exhaustive_partition, complementary, temporal_dependency, conditional_probability, multi_market_constraint

complementary KEY TEST: Can both markets resolve NO simultaneously? If yes, do NOT use complementary.`;

function buildFreshPrompt(bucket: Bucket, markets: Market[]): string {
  const marketList = markets
    .map((m) => `ID: ${m.id}\nTitle: ${m.title}\nDescription: ${m.description}`)
    .join("\n---\n");

  return (
    `Markets in the ${bucket.category} / ${bucket.entity} bucket:\n\n${marketList}\n\n` +
    `Identify logical groups where prices must be mathematically constrained. Return a JSON array.`
  );
}

function buildMatchingPrompt(
  bucket: Bucket,
  existingGroups: DbGroup[],
  marketMap: Map<string, Market>,
  unassigned: Market[],
  newMarkets: Market[]
): string {
  const intToType = Object.fromEntries(
    Object.entries(MISMATCH_TYPE_INT).map(([k, v]) => [v, k])
  );

  let prompt = `New market(s) to classify in the ${bucket.category} / ${bucket.entity} bucket.\n\n`;

  prompt += `EXISTING GROUPS:\n`;
  for (const g of existingGroups) {
    const ids: string[] = JSON.parse(g.market_ids);
    const typeName = intToType[g.mismatch_type] ?? "unknown";
    prompt += `\nGroup ID: ${g.id} (${typeName})\n`;
    for (const id of ids) {
      const m = marketMap.get(id);
      prompt += `  - ID: ${id} | "${m?.title ?? "(unknown)"}"\n`;
    }
  }

  if (unassigned.length > 0) {
    prompt += `\nUNASSIGNED markets in bucket (may be grouped with new markets):\n`;
    for (const m of unassigned) {
      prompt += `  - ID: ${m.id} | "${m.title}"\n`;
    }
  }

  prompt += `\nNEW market(s) to classify:\n`;
  for (const m of newMarkets) {
    prompt += `---\nID: ${m.id}\nTitle: ${m.title}\nDescription: ${m.description}\nResolution: ${m.resolutionCondition}\n`;
  }

  prompt += `\nReturn a JSON array with one decision object per new market.`;
  return prompt;
}

// ── LLM callers ──────────────────────────────────────────────────────────────

async function callClaude(systemPrompt: string, userPrompt: string): Promise<string> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
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
      model: "gpt-4o-mini",
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

/** Max markets per LLM call. Keeps prompts within context limits. Set lower for OpenAI. */
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

/**
 * Extracts an array from the LLM response.
 * Handles both bare arrays `[...]` and wrapped objects `{"groups": [...]}`,
 * since OpenAI json_object mode cannot return a bare array.
 */
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

function isValidGroup(g: unknown, validIds: Set<string>): g is LlmGroup {
  if (typeof g !== "object" || g === null) return false;
  const obj = g as Record<string, unknown>;
  if (!VALID_MISMATCH_TYPES.includes(obj.mismatch_type as MismatchType)) return false;
  if (!Array.isArray(obj.market_ids) || obj.market_ids.length < 2) return false;
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return false;
  if (obj.confidence < MIN_GROUP_CONFIDENCE) return false;
  if (typeof obj.reasoning !== "string" || obj.reasoning.trim() === "") return false;
  // Accept both string and numeric IDs — LLMs often return numbers for numeric-looking IDs
  if (!obj.market_ids.every((id) => (typeof id === "string" || typeof id === "number") && validIds.has(String(id)))) return false;
  return true;
}

function isValidAssignment(a: unknown, newMarketIds: Set<string>, allBucketIds: Set<string>): a is AssignmentAction {
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
    if (typeof obj.confidence !== "number") return false;
    if (typeof obj.reasoning !== "string" || obj.reasoning.trim() === "") return false;
    return true;
  }
  if (obj.action === "none") return true;
  return false;
}

// ── Case 1: fresh bucket (no existing groups) ────────────────────────────────

async function classifyFreshBucket(
  bucket: Bucket,
  markets: Market[],
  bucketKey: string,
  now: string
): Promise<void> {
  const validIds = new Set(bucket.marketIds);
  const allGroups: LlmGroup[] = [];

  // Split large buckets into chunks to stay within context limits
  for (let i = 0; i < markets.length; i += BUCKET_CHUNK_SIZE) {
    const chunk = markets.slice(i, i + BUCKET_CHUNK_SIZE);
    const chunkLabel =
      markets.length > BUCKET_CHUNK_SIZE
        ? `${bucketKey} [${i + 1}–${Math.min(i + BUCKET_CHUNK_SIZE, markets.length)}/${markets.length}]`
        : bucketKey;

    const userPrompt = buildFreshPrompt(bucket, chunk);

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
      .filter((g) => isValidGroup(g, validIds))
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
      INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of allGroups) {
      insert.run(
        crypto.randomUUID(),
        MISMATCH_TYPE_INT[g.mismatch_type as MismatchType],
        JSON.stringify(g.market_ids),
        g.confidence,
        now,
        bucketKey,
        g.reasoning
      );
    }
  })();

  console.log(`Grouper: fresh bucket ${bucketKey} → ${allGroups.length} groups`);
}

// ── Case 2: existing groups — match new markets into them ─────────────────────

async function classifyNewMarkets(
  bucket: Bucket,
  existingGroups: DbGroup[],
  marketMap: Map<string, Market>,
  newMarkets: Market[],
  unassigned: Market[],
  bucketKey: string,
  now: string
): Promise<void> {
  const allBucketIds = new Set(bucket.marketIds);
  const newMarketIds = new Set(newMarkets.map((m) => m.id));

  const userPrompt = buildMatchingPrompt(
    bucket,
    existingGroups,
    marketMap,
    unassigned,
    newMarkets
  );

  const raw = await callLlmWithRetry(MATCHING_SYSTEM_PROMPT, userPrompt, bucketKey);
  if (raw === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`Grouper: invalid JSON from matching LLM for ${bucketKey}`);
    return;
  }

  const assignments = extractArray(parsed).filter((a) =>
    isValidAssignment(a, newMarketIds, allBucketIds)
  ) as AssignmentAction[];

  const db = getDb();
  const existingGroupIds = new Set(existingGroups.map((g) => g.id));

  db.transaction(() => {
    for (const assignment of assignments) {
      if (assignment.action === "join") {
        if (!existingGroupIds.has(assignment.group_id)) continue; // guard against hallucinated IDs
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
          INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key, reasoning)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          MISMATCH_TYPE_INT[assignment.mismatch_type as MismatchType],
          JSON.stringify(assignment.with_market_ids),
          assignment.confidence,
          now,
          bucketKey,
          assignment.reasoning
        );
      }
      // action === "none": nothing to do
    }
  })();

  const joined = assignments.filter((a) => a.action === "join").length;
  const created = assignments.filter((a) => a.action === "new_group").length;
  console.log(
    `Grouper: bucket ${bucketKey} — ${newMarkets.length} new markets → ${joined} joined, ${created} new groups`
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Groups markets in a bucket via LLM and persists results to the groups table.
 *
 * - If no existing groups for this bucket: classifies all markets from scratch.
 * - If existing groups are present: only classifies new/changed markets,
 *   assigning them to existing groups or creating new ones. Existing group
 *   memberships are never modified except by appending new market IDs.
 */
export async function groupBucket(
  bucket: Bucket,
  marketMap: Map<string, Market>,
  changedIds: Set<string>
): Promise<void> {
  const hasChanges = bucket.marketIds.some((id) => changedIds.has(id));
  if (!hasChanges) return;

  const markets = bucket.marketIds
    .map((id) => marketMap.get(id))
    .filter((m): m is Market => m !== undefined);

  if (markets.length < 2) return;

  const bucketKey = `${bucket.category}::${bucket.entity}`;
  const now = new Date().toISOString();
  const db = getDb();

  const existingGroups = db
    .prepare(`SELECT id, mismatch_type, market_ids, confidence, bucket_key FROM groups WHERE bucket_key = ?`)
    .all(bucketKey) as DbGroup[];

  if (existingGroups.length === 0) {
    // Fresh bucket: classify everything from scratch
    await classifyFreshBucket(bucket, markets, bucketKey, now);
  } else {
    // Existing groups: only process markets not already in a group
    const groupedMarketIds = new Set(
      existingGroups.flatMap((g) => JSON.parse(g.market_ids) as string[])
    );

    const newMarkets = markets.filter(
      (m) => changedIds.has(m.id) && !groupedMarketIds.has(m.id)
    );

    if (newMarkets.length === 0) return; // all changed markets already grouped

    const unassigned = markets.filter(
      (m) => !groupedMarketIds.has(m.id) && !newMarkets.some((n) => n.id === m.id)
    );

    await classifyNewMarkets(
      bucket,
      existingGroups,
      marketMap,
      newMarkets,
      unassigned,
      bucketKey,
      now
    );
  }
}
