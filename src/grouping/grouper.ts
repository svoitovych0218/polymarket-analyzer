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

// ── Prompt ───────────────────────────────────────────────────────────────────

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

function buildUserPrompt(bucket: Bucket, markets: Market[]): string {
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

// ── LLM callers ──────────────────────────────────────────────────────────────

async function callClaude(userPrompt: string): Promise<LlmGroup[]> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "[]";
  return JSON.parse(text);
}

async function callOpenAi(userPrompt: string): Promise<LlmGroup[]> {
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
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const text = data.choices?.[0]?.message?.content ?? "[]";
  const parsed: unknown = JSON.parse(text);
  // json_object mode may wrap the array; unwrap if needed
  return Array.isArray(parsed)
    ? (parsed as LlmGroup[])
    : ((parsed as Record<string, unknown>).groups as LlmGroup[] ?? []);
}

function callLlm(userPrompt: string): Promise<LlmGroup[]> {
  const provider = (process.env.LLM_PROVIDER ?? "claude").toLowerCase();
  return provider === "openai" ? callOpenAi(userPrompt) : callClaude(userPrompt);
}

// ── Validation ───────────────────────────────────────────────────────────────

function isValidGroup(g: unknown, bucketMarketIds: Set<string>): g is LlmGroup {
  if (typeof g !== "object" || g === null) return false;
  const obj = g as Record<string, unknown>;
  if (!VALID_MISMATCH_TYPES.includes(obj.mismatch_type as MismatchType)) return false;
  if (!Array.isArray(obj.market_ids) || obj.market_ids.length < 2) return false;
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return false;
  if (!obj.market_ids.every((id) => typeof id === "string" && bucketMarketIds.has(id))) return false;
  return true;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Groups all markets in a bucket via LLM and persists results to the groups table.
 * Skips the LLM call when no market in the bucket has changed.
 * Retries the LLM call once on failure; skips the bucket on second failure.
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
  const userPrompt = buildUserPrompt(bucket, markets);

  let groups: LlmGroup[] | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      groups = await callLlm(userPrompt);
      break;
    } catch (err) {
      if (attempt === 0) {
        console.warn(`Grouper: LLM call failed for ${bucketKey}, retrying...`, err);
      } else {
        console.warn(`Grouper: LLM call failed twice for ${bucketKey}, skipping`, err);
      }
    }
  }

  if (groups === null) return;

  const bucketMarketIds = new Set(bucket.marketIds);
  const validGroups = (groups as unknown[]).filter((g) =>
    isValidGroup(g, bucketMarketIds)
  ) as LlmGroup[];

  const db = getDb();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`DELETE FROM groups WHERE bucket_key = ?`).run(bucketKey);

    const insert = db.prepare(`
      INSERT INTO groups (id, mismatch_type, market_ids, confidence, grouped_at, bucket_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const g of validGroups) {
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

  console.log(`Grouper: bucket ${bucketKey} → ${validGroups.length} groups persisted`);
}
