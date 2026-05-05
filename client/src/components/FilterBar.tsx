import type { Filters, SortBy, SortDir } from "../types";

const TYPE_OPTIONS: Array<{ value: number | undefined; label: string }> = [
  { value: undefined, label: "All types" },
  { value: 1, label: "Type 1 — Threshold Ordering" },
  { value: 2, label: "Type 2 — Exhaustive Partition" },
  { value: 3, label: "Type 3 — Complementary Outcome" },
  { value: 4, label: "Type 4 — Temporal Dependency" },
  { value: 5, label: "Type 5 — Conditional Probability" },
  { value: 6, label: "Type 6 — Multi-Market Constraint" },
];

const SORT_OPTIONS: Array<{ sortBy: SortBy; sortDir: SortDir; label: string }> = [
  { sortBy: "detected_at", sortDir: "desc", label: "Most recent" },
  { sortBy: "magnitude", sortDir: "desc", label: "Largest magnitude" },
  { sortBy: "magnitude", sortDir: "asc", label: "Smallest magnitude" },
  { sortBy: "detected_at", sortDir: "asc", label: "Oldest first" },
];

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

export function FilterBar({ filters, onChange }: Props) {
  const sortValue = `${filters.sortBy}:${filters.sortDir}`;

  function handleTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const raw = e.target.value;
    onChange({ ...filters, type: raw === "" ? undefined : parseInt(raw, 10) });
  }

  function handleSortChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const [sortBy, sortDir] = e.target.value.split(":") as [SortBy, SortDir];
    onChange({ ...filters, sortBy, sortDir });
  }

  function handleProfitableChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange({ ...filters, profitable: e.target.checked });
  }

  return (
    <div style={styles.bar}>
      <label style={styles.field}>
        <span style={styles.label}>Type</span>
        <select
          style={styles.select}
          value={filters.type ?? ""}
          onChange={handleTypeChange}
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value ?? ""} value={opt.value ?? ""}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label style={styles.field}>
        <span style={styles.label}>Sort by</span>
        <select style={styles.select} value={sortValue} onChange={handleSortChange}>
          {SORT_OPTIONS.map((opt) => (
            <option key={`${opt.sortBy}:${opt.sortDir}`} value={`${opt.sortBy}:${opt.sortDir}`}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label style={{ ...styles.field, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={filters.profitable}
          onChange={handleProfitableChange}
          style={{ width: 16, height: 16, cursor: "pointer" }}
        />
        <span style={styles.label}>Profitable only</span>
      </label>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    padding: "12px 16px",
    background: "#1a1d2e",
    borderBottom: "1px solid #2d3148",
    alignItems: "flex-end",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#94a3b8",
  },
  select: {
    background: "#0f1117",
    border: "1px solid #2d3148",
    color: "#e2e8f0",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
    cursor: "pointer",
  },
};
