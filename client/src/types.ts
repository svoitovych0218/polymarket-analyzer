export interface Group {
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

export interface GroupsResponse {
  data: Group[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Market {
  id: string;
  title: string;
  price: number | null;
  category: string;
  last_seen_at: string;
}

export interface MismatchStatus {
  magnitude: number;
  profitable: boolean;
  detected_at: string;
}

export interface MarketsResponse {
  markets: Market[];
  mismatch_status: MismatchStatus | null;
  reasoning: string;
}

export type SortBy = "magnitude" | "detected_at";
export type SortDir = "asc" | "desc";

export interface Filters {
  type: number | undefined;
  profitable: boolean;
  sortBy: SortBy;
  sortDir: SortDir;
}
