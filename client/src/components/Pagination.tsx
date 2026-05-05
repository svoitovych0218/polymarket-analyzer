interface Props {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, totalPages, onPageChange }: Props) {
  if (totalPages <= 1) return null;

  return (
    <div style={styles.container}>
      <button
        style={{ ...styles.btn, opacity: page <= 1 ? 0.4 : 1 }}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        ← Previous
      </button>

      <span style={styles.indicator}>
        Page {page} of {totalPages}
      </span>

      <button
        style={{ ...styles.btn, opacity: page >= totalPages ? 0.4 : 1 }}
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "12px 16px",
    borderTop: "1px solid #2d3148",
    justifyContent: "center",
  },
  btn: {
    background: "#1a1d2e",
    border: "1px solid #2d3148",
    color: "#e2e8f0",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer",
  },
  indicator: {
    color: "#94a3b8",
    fontSize: 13,
    minWidth: 120,
    textAlign: "center",
  },
};
