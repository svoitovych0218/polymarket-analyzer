import { useEffect, useState } from "react";
import type { MarketsResponse } from "../types";

interface Props {
  groupId: string;
  colSpan: number;
}

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  return (n * 100).toFixed(decimals) + "%";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function ExpandedGroupRow({ groupId, colSpan }: Props) {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/groups/${encodeURIComponent(groupId)}/markets`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<MarketsResponse>;
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [groupId]);

  return (
    <tr>
      <td colSpan={colSpan} style={styles.cell}>
        {loading && <div style={styles.msg}>Loading…</div>}
        {error && <div style={{ ...styles.msg, color: "#f87171" }}>Error: {error}</div>}

        {data && (
          <div style={styles.inner}>
            {/* Mismatch status bar */}
            {data.mismatch_status ? (
              <div style={styles.statusBar}>
                <span style={styles.statusLabel}>Latest violation</span>
                <span>
                  Magnitude:{" "}
                  <strong>{fmt(data.mismatch_status.magnitude)}</strong>
                </span>
                {data.mismatch_status.profitable && (
                  <span style={styles.profitBadge}>PROFITABLE</span>
                )}
                <span style={{ color: "#94a3b8" }}>
                  Detected: {fmtDate(data.mismatch_status.detected_at)}
                </span>
              </div>
            ) : (
              <div style={styles.statusBar}>
                <span style={{ color: "#94a3b8" }}>No mismatch detected yet</span>
              </div>
            )}

            {/* Markets table */}
            {data.markets.length > 0 ? (
              <table style={styles.marketsTable}>
                <thead>
                  <tr>
                    <th style={styles.th}>Market</th>
                    <th style={{ ...styles.th, width: 90, textAlign: "right" }}>Price</th>
                    <th style={{ ...styles.th, width: 100 }}>Category</th>
                    <th style={{ ...styles.th, width: 160 }}>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.markets.map((m) => (
                    <tr key={m.id} style={styles.marketRow}>
                      <td style={styles.td}>{m.title}</td>
                      <td style={{ ...styles.td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {fmt(m.price)}
                      </td>
                      <td style={styles.td}>
                        <span style={styles.categoryTag}>{m.category || "—"}</span>
                      </td>
                      <td style={{ ...styles.td, color: "#94a3b8" }}>
                        {fmtDate(m.last_seen_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={styles.msg}>No markets found</div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

const styles: Record<string, React.CSSProperties> = {
  cell: {
    padding: 0,
    background: "#131722",
    borderBottom: "2px solid #2d3148",
  },
  inner: {
    padding: "12px 16px",
  },
  msg: {
    padding: "12px 16px",
    color: "#94a3b8",
  },
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "8px 12px",
    background: "#1a1d2e",
    borderRadius: 6,
    marginBottom: 12,
    flexWrap: "wrap",
    fontSize: 13,
  },
  statusLabel: {
    fontWeight: 700,
    color: "#94a3b8",
    textTransform: "uppercase",
    fontSize: 11,
    letterSpacing: "0.06em",
    marginRight: 4,
  },
  profitBadge: {
    background: "#166534",
    color: "#4ade80",
    borderRadius: 4,
    padding: "2px 7px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
  },
  marketsTable: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
  },
  th: {
    textAlign: "left",
    padding: "6px 10px",
    color: "#64748b",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    borderBottom: "1px solid #2d3148",
  },
  marketRow: {
    borderBottom: "1px solid #1e2235",
  },
  td: {
    padding: "7px 10px",
    color: "#cbd5e1",
    verticalAlign: "top",
  },
  categoryTag: {
    background: "#1e2235",
    borderRadius: 4,
    padding: "2px 6px",
    fontSize: 11,
    color: "#94a3b8",
  },
};
