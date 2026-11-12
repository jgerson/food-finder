// Every turbopuffer call in the app goes through tpCall, which records it in two places:
//
// - Vercel runtime logs: one JSON line per call, `{"tpuf":"search", ...}`, with the namespace, the request (without
//   include_attributes, and with written rows reduced to ids), timings, cache state, billed bytes, row count, the top
//   ids with their scores, and any error. Search the logs for `"tpuf"` to see them.
// - Langfuse (when its keys are set): a `turbopuffer-<label>` observation with the same request and summary, nested
//   under whatever is running: a search or a copilot tool step. Calls made outside a trace only get their own
//   Langfuse trace when LANGFUSE_TRACE_PAGE_LOADS=true.
//
// Logging never changes what the call returns and never makes an extra turbopuffer request. If Langfuse fails, the
// call still goes through.
import "server-only";
import { after } from "next/server";
import { getActiveTraceId, startActiveObservation } from "@langfuse/tracing";
import { langfuseEnabled } from "./langfuse-setup";
import { flushLangfuse, insideTrace, newTrace } from "./langfuse";

export type TpufOp = "query" | "multi_query" | "write" | "metadata" | "warm" | "explain";

type Opts<T> = {
  /** Short name for the call, e.g. "search" or "list-notes". Becomes the log key and the observation name. */
  label: string;
  /** Extra fields for the log line and observation output, worked out from the result. */
  extra?: (res: T) => Record<string, unknown>;
};

const tracePageLoads = process.env.LANGFUSE_TRACE_PAGE_LOADS === "true";
// Calls at least this slow are marked WARNING in Langfuse, so they can be filtered by level.
const SLOW_MS = 1000;

/**
 * Flat, filterable metadata for a turbopuffer observation: Langfuse can filter and chart on these keys (namespace, cache,
 * timings, rows, billed bytes), where nested output is only readable by opening the trace.
 */
function searchable(label: string, op: TpufOp, namespace: string, ms: number, networkMs: number | undefined,
  s: Record<string, unknown>): Record<string, unknown> {
  const rows = Array.isArray(s.rows) ? (s.rows as number[]) : typeof s.rows === "number" ? [s.rows] : [];
  const out: Record<string, unknown> = {
    label, op, namespace, ms, networkMs, serverMs: s.serverMs, embeddingMs: s.embeddingMs, cache: s.cache,
    rowsTotal: rows.length ? rows.reduce((a, b) => a + b, 0) : undefined,
    rowsVector: op === "multi_query" ? rows[0] : undefined, rowsBm25: op === "multi_query" ? rows[1] : undefined,
    billedBytesQueried: s.billedBytesQueried, billedBytesWritten: s.billedBytesWritten, slow: ms >= SLOW_MS,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
const TOP_N = 10;

/** Run one turbopuffer call and record it in the logs and, when available, Langfuse. */
export async function tpCall<T>(op: TpufOp, namespace: string, request: Record<string, unknown>, run: () => Promise<T>,
  opts: Opts<T>): Promise<T> {
  const logged = loggable(op, request);
  const exec = async (observe?: (u: Record<string, unknown>) => void): Promise<T> => {
    const t0 = performance.now();
    try {
      const res = await run();
      const summary = { ...summarize(op, res), ...(opts.extra?.(res) ?? {}) };
      const ms = round(performance.now() - t0);
      // Time outside turbopuffer's servers: network, TLS and the client library.
      const networkMs = typeof summary.serverMs === "number" ? round(ms - summary.serverMs) : undefined;
      line({ tpuf: opts.label, op, namespace, ms, ...(networkMs !== undefined ? { networkMs } : {}), ...summary, request: logged });
      observe?.({ output: summary, metadata: searchable(opts.label, op, namespace, ms, networkMs, summary),
        ...(ms >= SLOW_MS ? { level: "WARNING", statusMessage: `slow turbopuffer call: ${Math.round(ms)} ms${summary.cache ? `, cache ${summary.cache}` : ""}` } : {}) });
      return res;
    } catch (e) {
      const err = errorOf(e);
      const ms = round(performance.now() - t0);
      line({ tpuf: opts.label, op, namespace, ms, error: err, request: logged });
      // A 404 means the namespace has nothing in it yet; callers treat that as empty, so it isn't an error in Langfuse.
      observe?.({ output: { error: err }, metadata: { label: opts.label, op, namespace, ms, error: true },
        ...(err.status === 404 ? {} : { level: "ERROR", statusMessage: err.message }) });
      throw e;
    }
  };

  if (!langfuseEnabled) return exec();
  const traced = insideTrace();
  if (!traced && !tracePageLoads) return exec();

  const observed = () => safeObserve(`turbopuffer-${opts.label}`, op, { namespace, ...logged }, exec);
  if (traced) return observed();
  try {
    after(flushLangfuse);
  } catch {
    // Outside a request (a script), there's nothing to schedule; spans flush on the next batch.
  }
  return newTrace({ tags: ["page-load"], traceName: `turbopuffer-${opts.label}` }, observed);
}

/** Wrap exec in a Langfuse observation. If Langfuse itself throws, run the call without it. */
async function safeObserve<T>(name: string, op: TpufOp, input: Record<string, unknown>,
  exec: (observe?: (u: Record<string, unknown>) => void) => Promise<T>): Promise<T> {
  let started = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = async (obs: { update: (u: any) => unknown }): Promise<T> => {
    started = true;
    obs.update({ input });
    return exec((u) => {
      try {
        obs.update(u);
      } catch {
        // ignore: a tracing problem must not fail the request
      }
    });
  };
  try {
    return op === "write"
      ? await startActiveObservation(name, body, { asType: "span" })
      : await startActiveObservation(name, body, { asType: "retriever" });
  } catch (e) {
    if (started) throw e; // the turbopuffer call itself failed; exec already logged it
    return exec();
  }
}

// ---------------------------------------------------------------- what gets recorded

/** The request as logged: no include_attributes (just display fields), written rows reduced to ids and text size. */
function loggable(op: TpufOp, request: Record<string, unknown>): Record<string, unknown> {
  // Query vectors are 512 numbers each: logged as a placeholder so log lines and traces stay readable.
  const strip = (q: Record<string, unknown>) => Object.fromEntries(Object.entries(q)
    .filter(([k]) => k !== "include_attributes")
    .map(([k, v]) => [k, k === "rank_by" ? shortRankBy(v) : v]));
  if (op === "multi_query" && Array.isArray(request.queries)) {
    return { ...request, queries: (request.queries as Record<string, unknown>[]).map(strip) };
  }
  if (op === "write") {
    const rows = (request.upsert_rows as Record<string, unknown>[] | undefined) ?? [];
    const { upsert_rows: _rows, schema, ...rest } = request;
    void _rows;
    return { ...rest, upsert_rows: rows.map((r) => ({ id: r.id })),
      schema_fields: schema ? Object.keys(schema as object) : undefined };
  }
  return strip(request);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarize(op: TpufOp, res: any): Record<string, unknown> {
  if (!res || typeof res !== "object") return {};
  const perf = res.performance ?? {};
  const billing = res.billing ?? {};
  const out: Record<string, unknown> = {
    serverMs: num(perf.server_total_ms), embeddingMs: num(perf.embedding_ms),
    cache: typeof perf.cache_temperature === "string" ? perf.cache_temperature : undefined,
    billedBytesQueried: num(billing.billable_logical_bytes_queried),
    billedBytesReturned: num(billing.billable_logical_bytes_returned),
  };
  if (op === "write") {
    Object.assign(out, { rowsUpserted: num(res.rows_upserted), rowsAffected: num(res.rows_affected),
      embeddingTokens: num(perf.embedding_tokens), billedBytesWritten: num(billing.billable_logical_bytes_written) });
  } else if (op === "multi_query") {
    const lists = ((res.results ?? []) as { rows?: Record<string, unknown>[] }[]).map((r) => r.rows ?? []);
    Object.assign(out, { rows: lists.map((l) => l.length), top: lists.map(top) });
  } else if (res.aggregation_groups) {
    out.groups = (res.aggregation_groups as unknown[]).length;
  } else if (res.aggregations) {
    out.aggregations = res.aggregations;
  } else if (op === "metadata") {
    Object.assign(out, { approxRows: num(res.approx_row_count), approxBytes: num(res.approx_logical_bytes) });
  } else if (op === "warm") {
    out.status = res.status;
  } else if (op === "explain") {
    out.planChars = typeof res.plan_text === "string" ? res.plan_text.length : undefined;
  } else if (Array.isArray(res.rows)) {
    Object.assign(out, { rows: res.rows.length, top: top(res.rows) });
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null));
}

/** The first rows as [id, score]; the score is the vector distance or BM25 score when the query ranked by one. */
const top = (rows: Record<string, unknown>[]) =>
  rows.slice(0, TOP_N).map((r) => (typeof r.$dist === "number" ? [r.id, round(r.$dist, 4)] : [r.id]));

function errorOf(e: unknown): { message: string; status?: number } {
  const x = e as { message?: string; status?: number };
  return { message: String(x?.message ?? e).slice(0, 300), ...(typeof x?.status === "number" ? { status: x.status } : {}) };
}

/** One log line, with the Langfuse trace id when there is one so the two can be matched up. Kept under 8 KB. */
function line(fields: Record<string, unknown>) {
  let traceId: string | undefined;
  try {
    traceId = langfuseEnabled ? getActiveTraceId() : undefined;
  } catch {
    traceId = undefined;
  }
  let s = JSON.stringify(traceId ? { ...fields, traceId } : fields);
  if (s.length > 8000) s = JSON.stringify({ ...fields, request: "(too long to log)", traceId });
  console.log(s);
}

/** ["vector", "ANN", [512 numbers]] -> ["vector", "ANN", "[512 floats]"] */
export function shortRankBy(v: unknown): unknown {
  return Array.isArray(v) && Array.isArray(v[2]) ? [v[0], v[1], `[${(v[2] as unknown[]).length} floats]`] : v;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? round(v) : undefined);
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
