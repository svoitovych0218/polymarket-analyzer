import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDb } from "../db/schema";
import type { MismatchResult, Group } from "./detectors";

// ── Constants ────────────────────────────────────────────────────────────────

const PROFITABLE_THRESHOLD = 0.05;

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
 * Sets `profitable = true` when `magnitude > 0.05`.
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
  const profitable = result.magnitude > PROFITABLE_THRESHOLD;

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
