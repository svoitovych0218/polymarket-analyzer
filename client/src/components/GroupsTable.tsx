import { useState } from "react";
import type { Group, GroupsResponse, Filters } from "../types";
import { FilterBar } from "./FilterBar";
import { ExpandedGroupRow } from "./ExpandedGroupRow";
import { Pagination } from "./Pagination";

interface Props {
  response: GroupsResponse | null;
  loading: boolean;
  error: string | null;
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  onPageChange: (page: number) => void;
}

const COL_COUNT = 7;

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  return (n * 100).toFixed(decimals) + "%";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function GroupsTable({
  response,
  loading,
  error,
  filters,
  onFiltersChange,
  onPageChange,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function toggleRow(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  const totalPages = response ? Math.ceil(response.total / response.pageSize) : 0;

  return (
    <div style={styles.wrapper}>
      <FilterBar filters={filters} onChange={onFiltersChange} />

      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Type</th>
              <th style={{ ...styles.th, width: 70, textAlign: "right" }}>Markets</th>
              <th style={{ ...styles.th, width: 90, textAlign: "right" }}>Confidence</th>
              <th style={styles.th}>Bucket</th>
              <th style={{ ...styles.th, width: 100, textAlign: "right" }}>Magnitude</th>
              <th style={{ ...styles.th, width: 70 }}>Profit</th>
              <th style={{ ...styles.th, width: 160 }}>Detected</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={COL_COUNT} style={styles.statusCell}>
                  Loading…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={COL_COUNT} style={{ ...styles.statusCell, color: "#f87171" }}>
                  Error: {error}
                </td>
              </tr>
            )}
            {!loading && !error && response?.data.length === 0 && (
              <tr>
                <td colSpan={COL_COUNT} style={styles.statusCell}>
                  No groups found
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              response?.data.map((group: Group) => (
                <>
                  <tr
                    key={group.id}
                    style={{
                      ...styles.row,
                      background: expandedId === group.id ? "#1a1d2e" : "transparent",
                    }}
                    onClick={() => toggleRow(group.id)}
                  >
                    <td style={styles.td}>
                      <span style={styles.typeLabel}>{group.mismatch_type_label}</span>
                    </td>
                    <td style={{ ...styles.td, textAlign: "right", color: "#94a3b8" }}>
                      {group.market_count}
                    </td>
                    <td style={{ ...styles.td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmt(group.confidence, 0)}
                    </td>
                    <td style={{ ...styles.td, color: "#94a3b8", fontFamily: "monospace", fontSize: 12 }}>
                      {group.bucket_key || "—"}
                    </td>
                    <td style={{ ...styles.td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmt(group.latest_magnitude)}
                    </td>
                    <td style={styles.td}>
                      {group.latest_profitable ? (
                        <span style={styles.profitBadge}>YES</span>
                      ) : (
                        <span style={{ color: "#475569" }}>—</span>
                      )}
                    </td>
                    <td style={{ ...styles.td, color: "#94a3b8", fontSize: 12 }}>
                      {fmtDate(group.latest_detected_at)}
                    </td>
                  </tr>
                  {expandedId === group.id && (
                    <ExpandedGroupRow
                      key={`${group.id}-expanded`}
                      groupId={group.id}
                      colSpan={COL_COUNT}
                    />
                  )}
                </>
              ))}
          </tbody>
        </table>
      </div>

      <Pagination page={response?.page ?? 1} totalPages={totalPages} onPageChange={onPageChange} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  tableWrapper: {
    overflowX: "auto",
    flex: 1,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  th: {
    textAlign: "left",
    padding: "8px 12px",
    color: "#64748b",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    borderBottom: "2px solid #2d3148",
    whiteSpace: "nowrap",
    background: "#0f1117",
    position: "sticky",
    top: 0,
    zIndex: 1,
  },
  row: {
    borderBottom: "1px solid #1e2235",
    cursor: "pointer",
    transition: "background 0.1s",
  },
  td: {
    padding: "9px 12px",
    color: "#e2e8f0",
    verticalAlign: "middle",
  },
  typeLabel: {
    fontSize: 12,
    color: "#7dd3fc",
  },
  profitBadge: {
    background: "#166534",
    color: "#4ade80",
    borderRadius: 4,
    padding: "2px 7px",
    fontSize: 11,
    fontWeight: 700,
  },
  statusCell: {
    textAlign: "center",
    padding: "40px 0",
    color: "#64748b",
  },
};
