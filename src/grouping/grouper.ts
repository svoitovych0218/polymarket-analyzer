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
    }
  | { action: "none"; market_id: string };

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a prediction market analyst specializing in identifying mathematical price constraints between related markets.

Given a list of prediction markets from the same category, identify logical groups where the market prices must be mathematically related. Only group markets that clearly belong together based on their titles, descriptions, and resolution conditions.

Return a JSON array of groups. Each group must have:
- "mismatch_type": one of "threshold_ordering", "exhaustive_partition", "complementary", "temporal_dependency", "conditional_probability", "multi_market_constraint"
- "market_ids": array of market IDs that form this group (minimum 2 markets)
- "confidence": float 0.0–1.0 representing your confidence in this grouping

Mismatch type definitions:
- threshold_ordering: Markets at escalating thresholds where prices must satisfy ordering constraints (e.g. "Will BTC exceed $50k?" vs "Will BTC exceed $100k?")
- exhaustive_partition: Markets that collectively cover all mutually exclusive outcomes where prices must sum to approximately 1
- complementary: A market and its logical negation where prices must sum to 1
- temporal_dependency: Sequential time-window markets where earlier resolution implies later (e.g. "by Q1?" vs "by Q2?")
- conditional_probability: Markets where one is explicitly conditional on another
- multi_market_constraint: Other complex price relationships between 3+ markets

Return ONLY a JSON array, no markdown, no explanation. If no groups exist, return [].`;

const MATCHING_SYSTEM_PROMPT = `You are a prediction market analyst. Your task is to classify new prediction markets into existing logical groups, or identify if they should form new groups.

You will be given:
1. EXISTING GROUPS: groups already established with their constituent markets
2. UNASSIGNED markets: other markets in the bucket not yet in any group (for context only)
3. NEW markets: the market(s) you must classify

For each new market return exactly one decision:
- Join an existing group: {"market_id":"...","action":"join","group_id":"existing-uuid"}
- Form a new group (with ≥1 other unassigned market): {"market_id":"...","action":"new_group","mismatch_type":"...","with_market_ids":["id1","id2"],"confidence":0.9}
  ("with_market_ids" must include the new market itself plus at least one other market)
- No fit: {"market_id":"...","action":"none"}

Rules:
- Never reassign markets already in an existing group
- "new_group" requires at least 2 market IDs in with_market_ids (including the new market)
- Return a JSON array of decisions, one per new market

Valid mismatch types: threshold_ordering, exhaustive_partition, complementary, temporal_dependency, conditional_probability, multi_market_constraint`;

function buildFreshPrompt(bucket: Bucket, markets: Market[]): string {
  const marketList = markets
    .map(
      (m) =>
        `ID: ${m.id}\nTitle: ${m.title}\nDescription: ${m.description}\nResolution: ${m.resolutionCondition}`
    )
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

  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${res.statusText}`);
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

async function callLlmWithRetry(
  systemPrompt: string,
  userPrompt: string,
  label: string
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callLlm(systemPrompt, userPrompt);
    } catch (err) {
      if (attempt === 0) {
        console.warn(`Grouper: LLM call failed for ${label}, retrying...`, err);
      } else {
        console.warn(`Grouper: LLM call failed twice for ${label}, skipping`, err);
      }
    }
  }
  return null;
}

// ── Validation ───────────────────────────────────────────────────────────────

function isValidGroup(g: unknown, validIds: Set<string>): g is LlmGroup {
  if (typeof g !== "object" || g === null) return false;
  const obj = g as Record<string, unknown>;
  if (!VALID_MISMATCH_TYPES.includes(obj.mismatch_type as MismatchType)) return false;
  if (!Array.isArray(obj.market_ids) || obj.market_ids.length < 2) return false;
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return false;
  if (!obj.market_ids.every((id) => typeof id === "string" && validIds.has(id))) return false;
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
  const userPrompt = buildFreshPrompt(bucket, markets);
  const raw = await callLlmWithRetry(SYSTEM_PROMPT, userPrompt, bucketKey);
  if (raw === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`Grouper: invalid JSON from LLM for ${bucketKey}`);
    return;
  }

  const validIds = new Set(bucket.marketIds);
  const groups = (Array.isArray(parsed) ? parsed : []).filter((g) =>
    isValidGroup(g, validIds)
  ) as LlmGroup[];

  const db = getDb();
  db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const g of groups) {
      insert.run(
        crypto.randomUUID(),
        MISMATCH_TYPE_INT[g.mismatch_type as MismatchType],
        JSON.stringify(g.market_ids),
        g.confidence,
        now,
        bucketKey
      );
    }
  })();

  console.log(`Grouper: fresh bucket ${bucketKey} → ${groups.length} groups`);
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

  const assignments = (Array.isArray(parsed) ? parsed : []).filter((a) =>
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
          INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          MISMATCH_TYPE_INT[assignment.mismatch_type as MismatchType],
          JSON.stringify(assignment.with_market_ids),
          assignment.confidence,
          now,
          bucketKey
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
