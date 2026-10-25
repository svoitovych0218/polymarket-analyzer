import "dotenv/config";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EventRow {
  id: string;
  title: string;
  tags: string;
}

interface CandidateBatch {
  event_ids: string[];
  reason: string;
}

interface PocOutput {
  tag: string;
  event_count: number;
  candidate_count: number;
  batches: CandidateBatch[];
}

// ── DB ────────────────────────────────────────────────────────────────────────

function getEventsByTag(tag: string): EventRow[] {
  const db = new Database(path.join(process.cwd(), "data", "polymarket.db"), {
    readonly: true,
  });

  const rows = db
    .prepare(
      `SELECT e.id, e.title, GROUP_CONCAT(t.label, ', ') AS tags
       FROM events e
       JOIN event_tags ef ON e.id = ef.event_id
       JOIN tags tf ON ef.tag_id = tf.id AND tf.label = ?
       JOIN event_tags ea ON e.id = ea.event_id
       JOIN tags t ON ea.tag_id = t.id
       GROUP BY e.id, e.title
       ORDER BY e.title`
    )
    .all(tag) as EventRow[];

  db.close();
  return rows;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a prediction market analyst identifying complementary event pairs.

A complementary pair is two events where EXACTLY ONE must resolve YES and the other MUST resolve NO — they partition all possible outcomes with zero gaps and zero overlap.

STRICT KEY TEST for every candidate pair:
1. Can BOTH events resolve NO simultaneously? → if yes, REJECT
2. Can BOTH events resolve YES simultaneously? → if yes, REJECT
Only pairs that fail both rejection tests are truly complementary.

VALID examples:
- "Will Proposition X pass?" ↔ "Will Proposition X fail?"
- "Will the government shut down by date X?" ↔ "Will the government NOT shut down by date X?"
- "Will candidate X win the runoff?" ↔ "Will candidate X lose the runoff?" (two-candidate runoff only)

INVALID — do NOT include:
- "Will Candidate A win?" ↔ "Will Candidate B win?" (third candidate can win → both can resolve NO)
- Markets on the same topic but different thresholds or dates
- Markets that are related but do not strictly partition outcomes

Return a JSON object with a single key "batches" containing an array of promising complementary pairs. Be conservative — only include pairs you are confident about.
Format: { "batches": [{ "event_ids": ["id1", "id2"], "reason": "one sentence" }, ...] }
If no confident pairs exist, return { "batches": [] }.
Return ONLY the JSON object. No markdown, no explanation.`;

function buildUserMessage(events: EventRow[]): string {
  const lines = events.map(
    (e) => `ID:${e.id} | "${e.title}" | Tags: ${e.tags}`
  );

  return (
    `Find complementary pairs among these ${events.length} prediction market events:\n\n` +
    lines.join("\n")
  );
}

// ── LLM ──────────────────────────────────────────────────────────────────────

async function callLlm(userMessage: string, attempt = 0): Promise<string> {
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
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (res.status === 429 && attempt < 5) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    console.warn(`Rate limited. Retrying in ${retryAfter}s (attempt ${attempt + 1}/5)...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return callLlm(userMessage, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`OpenAI error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content ?? "[]";
}

// ── Core ──────────────────────────────────────────────────────────────────────

async function processTag(tag: string, outputPath: string): Promise<void> {
  console.log(`\n── ${tag} ──────────────────────────────────────`);

  const events = getEventsByTag(tag);
  console.log(`Events: ${events.length}`);

  if (events.length === 0) {
    console.log("No events found, skipping.");
    fs.writeFileSync(outputPath, JSON.stringify({ tag, event_count: 0, candidate_count: 0, batches: [] }, null, 2));
    return;
  }

  const approxInputTokens = Math.round(
    events.reduce((sum, e) => sum + e.title.length + e.tags.length + 20, 0) / 3.5
  );
  console.log(`Approx input tokens: ~${approxInputTokens.toLocaleString()}`);

  console.log("Calling LLM (stage 1 screening)...");
  const raw = await callLlm(buildUserMessage(events));

  let batches: CandidateBatch[] = [];
  try {
    const parsed = JSON.parse(raw) as { batches?: CandidateBatch[] };
    batches = Array.isArray(parsed.batches) ? parsed.batches : [];
  } catch {
    console.warn("LLM returned invalid JSON — saving raw response.");
    fs.writeFileSync(outputPath.replace(".json", "_raw.txt"), raw);
    return;
  }

  const output: PocOutput = {
    tag,
    event_count: events.length,
    candidate_count: batches.length,
    batches,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Candidate batches: ${batches.length} → ${outputPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  await processTag("Politics", path.join(dataDir, "poc_politics_batches.json"));
  await new Promise(rs => setTimeout(rs, 1000))
  await processTag("Geopolitics", path.join(dataDir, "poc_geopolitics_batches.json"));

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
