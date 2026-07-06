/**
 * In-memory progress tracker for CDR fetch jobs.
 * Keyed by jobId (uuid provided by client). TTL: 10 minutes.
 */
export interface ProgressState {
  jobId: string;
  status: "pending" | "fetching" | "aggregating" | "done" | "error";
  page: number;
  totalPages: number | null; // null until first response with total_number
  records: number;
  totalReported: number | null;
  message: string;
  updatedAt: number;
  error?: string;
}

const store = new Map<string, ProgressState>();
const TTL_MS = 10 * 60_000;

function gc() {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.updatedAt > TTL_MS) store.delete(k);
}

export function initJob(jobId: string): ProgressState {
  gc();
  const s: ProgressState = {
    jobId, status: "pending", page: 0, totalPages: null,
    records: 0, totalReported: null, message: "Starting…", updatedAt: Date.now(),
  };
  store.set(jobId, s);
  return s;
}

export function updateJob(jobId: string, patch: Partial<ProgressState>) {
  const existing = store.get(jobId);
  if (!existing) return;
  Object.assign(existing, patch, { updatedAt: Date.now() });
}

export function getJob(jobId: string): ProgressState | null {
  return store.get(jobId) ?? null;
}

export function finishJob(jobId: string, totalReported: number | null, records: number) {
  updateJob(jobId, {
    status: "done", message: `Loaded ${records.toLocaleString()} records`,
    records, totalReported,
  });
}

export function failJob(jobId: string, error: string) {
  updateJob(jobId, { status: "error", error, message: error });
}
