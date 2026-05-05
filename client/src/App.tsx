import { useEffect, useReducer, useRef } from "react";
import type { Filters, GroupsResponse } from "./types";
import { GroupsTable } from "./components/GroupsTable";

interface State {
  response: GroupsResponse | null;
  loading: boolean;
  error: string | null;
  filters: Filters;
  page: number;
}

type Action =
  | { type: "FETCH_START" }
  | { type: "FETCH_SUCCESS"; payload: GroupsResponse }
  | { type: "FETCH_ERROR"; payload: string }
  | { type: "SET_FILTERS"; payload: Filters }
  | { type: "SET_PAGE"; payload: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "FETCH_START":
      return { ...state, loading: true, error: null };
    case "FETCH_SUCCESS":
      return { ...state, loading: false, response: action.payload };
    case "FETCH_ERROR":
      return { ...state, loading: false, error: action.payload };
    case "SET_FILTERS":
      return { ...state, filters: action.payload, page: 1 };
    case "SET_PAGE":
      return { ...state, page: action.payload };
  }
}

const DEFAULT_FILTERS: Filters = {
  type: undefined,
  profitable: false,
  sortBy: "detected_at",
  sortDir: "desc",
};

const INITIAL_STATE: State = {
  response: null,
  loading: true,
  error: null,
  filters: DEFAULT_FILTERS,
  page: 1,
};

function buildUrl(filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.type !== undefined) params.set("type", String(filters.type));
  if (filters.profitable) params.set("profitable", "true");
  params.set("sortBy", filters.sortBy);
  params.set("sortDir", filters.sortDir);
  params.set("page", String(page));
  params.set("pageSize", "50");
  return `/api/groups?${params.toString()}`;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    dispatch({ type: "FETCH_START" });

    fetch(buildUrl(state.filters, state.page), { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<GroupsResponse>;
      })
      .then((data) => dispatch({ type: "FETCH_SUCCESS", payload: data }))
      .catch((err: Error) => {
        if (err.name !== "AbortError") {
          dispatch({ type: "FETCH_ERROR", payload: err.message });
        }
      });

    return () => controller.abort();
  }, [state.filters, state.page]);

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <h1 style={styles.title}>Groups Inspector</h1>
        {state.response && (
          <span style={styles.count}>
            {state.response.total} group{state.response.total !== 1 ? "s" : ""}
          </span>
        )}
      </header>

      <main style={styles.main}>
        <GroupsTable
          response={state.response}
          loading={state.loading}
          error={state.error}
          filters={state.filters}
          onFiltersChange={(f) => dispatch({ type: "SET_FILTERS", payload: f })}
          onPageChange={(p) => dispatch({ type: "SET_PAGE", payload: p })}
        />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "16px 20px",
    borderBottom: "1px solid #2d3148",
    background: "#1a1d2e",
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: "#f1f5f9",
    letterSpacing: "-0.01em",
  },
  count: {
    color: "#64748b",
    fontSize: 13,
  },
  main: {
    flex: 1,
    overflow: "auto",
  },
};
