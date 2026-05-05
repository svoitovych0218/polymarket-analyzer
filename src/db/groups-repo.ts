import type Database from "better-sqlite3";
import { getMismatchTypeLabel } from "../api/mismatch-labels";

export interface GroupRow {
  id: string;
  mismatch_type: number;
  mismatch_type_label: string;
  market_count: number;
  confidence: number;
  bucket_key: string;
  grouped_at: string;
  reasoning: string;
  latest_magnitude: number | null;
  latest_profitable: boolean | null;
  latest_detected_at: string | null;
}

export interface GroupsQuery {
  type?: number;
  profitable?: boolean;
  sortBy?: "magnitude" | "detected_at";
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface GroupsResult {
  data: GroupRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface RawGroupRow {
  id: string;
  mismatch_type: number;
  confidence: number;
  bucket_key: string;
  grouped_at: string;
  reasoning: string;
  market_count: number;
  latest_magnitude: number | null;
  latest_profitable: number | null;
  latest_detected_at: string | null;
}

/**
 * Queries groups with optional filtering, sorting, and pagination.
 * Joins with the latest mismatch per group for magnitude/profitable/detected_at.
 */
export function queryGroups(db: Database.Database, query: GroupsQuery): GroupsResult {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const offset = (page - 1) * pageSize;
  const sortBy = query.sortBy ?? "detected_at";
  const sortDir = (query.sortDir ?? "desc").toUpperCase();

  const conditions: string[] = [];
  const filterParams: unknown[] = [];

  if (query.type !== undefined) {
    conditions.push("g.mismatch_type = ?");
    filterParams.push(query.type);
  }

  if (query.profitable) {
    conditions.push("lm.profitable = 1");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sortColumn = sortBy === "magnitude" ? "lm.magnitude" : "lm.detected_at";

  // Inline subquery to get the latest mismatch per group (by detected_at)
  const joinedFrom = `
    groups g
    LEFT JOIN (
      SELECT group_id, magnitude, profitable, detected_at
      FROM mismatches m1
      WHERE detected_at = (
        SELECT MAX(detected_at) FROM mismatches m2 WHERE m2.group_id = m1.group_id
      )
    ) lm ON lm.group_id = g.id
  `;

  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM ${joinedFrom} ${where}`).get(filterParams) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(
      `SELECT
        g.id, g.mismatch_type, g.confidence, g.bucket_key, g.grouped_at, g.reasoning,
        json_array_length(g.market_ids) AS market_count,
        lm.magnitude AS latest_magnitude,
        lm.profitable AS latest_profitable,
        lm.detected_at AS latest_detected_at
      FROM ${joinedFrom} ${where}
      ORDER BY ${sortColumn} ${sortDir} NULLS LAST
      LIMIT ? OFFSET ?`
    )
    .all([...filterParams, pageSize, offset]) as RawGroupRow[];

  const data: GroupRow[] = rows.map((r) => ({
    id: r.id,
    mismatch_type: r.mismatch_type,
    mismatch_type_label: getMismatchTypeLabel(r.mismatch_type),
    market_count: r.market_count,
    confidence: r.confidence,
    bucket_key: r.bucket_key,
    grouped_at: r.grouped_at,
    reasoning: r.reasoning,
    latest_magnitude: r.latest_magnitude,
    latest_profitable: r.latest_profitable === null ? null : r.latest_profitable === 1,
    latest_detected_at: r.latest_detected_at,
  }));

  return { data, total, page, pageSize };
}
