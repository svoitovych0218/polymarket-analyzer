import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDb } from "../db/schema";
import type { MismatchResult, Group } from "./detectors";

// ── Constants ────────────────────────────────────────────────────────────────

const PROFITABLE_THRESHOLD = 0.05;

// Mismatch type integers (mirrors MISMATCH_TYPE_INT in grouper.ts)
const TYPE_EXHAUSTIVE_PARTITION = 2;
const TYPE_COMPLEMENTARY = 3;
const TYPE_MULTI_MARKET_CONSTRAINT = 6;

/**
 * Returns true only when the mismatch is exploitable by buying — i.e. no short
 * selling required — and the magnitude clears the profitability threshold.
 *
 * Types 2 & 3 (partition/complementary): profitable only when sum < 1, meaning
 * you can buy all outcomes for less than $1 and collect exactly $1 on resolution.
 * Sum > 1 would require shorting every outcome — a different, harder trade.
 *
 * Type 6 (multi-market / Fréchet): profitable only when the joint market is
 * below its lower Fréchet bound (underpriced → buy it).
 * When joint is above the upper bound it is overpriced and requires shorting.
 *
 * Types 1, 4, 5: the detector fires only in the direction where magnitude > 0,
 * so magnitude alone is a sufficient proxy; these remain unchanged.
 */
function isBuySideProfitable(result: MismatchResult, group: Group): boolean {
  if (result.magnitude <= PROFITABLE_THRESHOLD) return false;

  if (group.mismatch_type === TYPE_EXHAUSTIVE_PARTITION || group.mismatch_type === TYPE_COMPLEMENTARY) {
    const sum = Object.values(result.details).reduce((a, b) => a + b, 0);
    return sum < 1;
  }

  if (group.mismatch_type === TYPE_MULTI_MARKET_CONSTRAINT) {
    const [jointId, idA, idB] = group.market_ids;
    const pJoint = result.details[jointId];
    const pA = result.details[idA];
    const pB = result.details[idB];
    const lowerBound = Math.max(0, pA + pB - 1);
    return pJoint < lowerBound;
  }

  return true;
}

/** Resolved at call time so tests can override via process.env. */
function getLogPath(): string {
  return process.env.MISMATCH_LOG_PATH
    ? path.resolve(process.env.MISMATCH_LOG_PATH)
    : path.join(process.cwd(), "data", "mismatches.ndjson");
}

// ── Types ────────────────────────────────────────────────────────────────────

interface LogEntry {
  id: string;
  group_id: string;
  mismatch_type: number;
  market_ids: string[];
  market_titles: Record<string, string>;
  prices: Record<string, number>;
  magnitude: number;
  profitable: boolean;
  detected_at: string;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Writes a detected mismatch to two sinks:
 * 1. Appends one NDJSON line to the log file (includes market titles).
 * 2. Inserts a row into the `mismatches` SQLite table.
 *
 * Sets `profitable = true` only for buy-side exploitable violations (see `isBuySideProfitable`).
 *
 * @param result      - The MismatchResult from a detector.
 * @param group       - The associated group record.
 * @param marketTitles - Map of marketId → title for enriching the log entry.
 */
export function logMismatch(
  result: MismatchResult,
  group: Group,
  marketTitles: Map<string, string>
): void {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const profitable = isBuySideProfitable(result, group);

  const entry: LogEntry = {
    id,
    group_id: group.id,
    mismatch_type: group.mismatch_type,
    market_ids: group.market_ids,
    market_titles: Object.fromEntries(
      group.market_ids.map((mid) => [mid, marketTitles.get(mid) ?? ""])
    ),
    prices: result.details,
    magnitude: result.magnitude,
    profitable,
    detected_at: now,
  };

  writeToLog(entry);
  writeToDb(entry, group.id);
}

function writeToLog(entry: LogEntry): void {
  const logPath = getLogPath();
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
}

function writeToDb(entry: LogEntry, groupId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO mismatches
      (id, group_id, mismatch_type, market_ids, prices, magnitude, profitable, detected_at)
    VALUES
      (@id, @group_id, @mismatch_type, @market_ids, @prices, @magnitude, @profitable, @detected_at)
  `).run({
    id: entry.id,
    group_id: groupId,
    mismatch_type: entry.mismatch_type,
    market_ids: JSON.stringify(entry.market_ids),
    prices: JSON.stringify(entry.prices),
    magnitude: entry.magnitude,
    profitable: entry.profitable ? 1 : 0,
    detected_at: entry.detected_at,
  });
}
