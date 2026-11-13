// Server-side turbopuffer access: search by vector, "more like this", and the lookups the copilot's tools use.
// This is the only place the turbopuffer key is used. Every call goes through tpCall (lib/tpuf-log.ts), which logs it
// and records it in Langfuse when a trace is running.
import "server-only";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { COURSES, courseOf, dishName, type Course } from "./courses";
import { shortRankBy, tpCall } from "./tpuf-log";
import { tracedFetch } from "./traced-fetch";

export const DIM = 512;
export const NAMESPACE = process.env.TURBOPUFFER_NAMESPACE ?? "food101";
const ATTRS = ["url", "dish", "label", "course"];

let client: Turbopuffer | null = null;

/** TURBOPUFFER_REGION, defaulting to aws-us-east-1 (unless TURBOPUFFER_BASE_URL points somewhere else). */
export function region(): string | undefined {
  return process.env.TURBOPUFFER_REGION || (process.env.TURBOPUFFER_BASE_URL ? undefined : "aws-us-east-1");
}

function ns() {
  const apiKey = process.env.TURBOPUFFER_API_KEY;
  if (!apiKey) throw new Error("TURBOPUFFER_API_KEY is not set");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client ??= new Turbopuffer({ apiKey, region: region(), maxRetries: 2, fetch: tracedFetch as any });
  return client.namespace(NAMESPACE);
}

export type Hit = {
  id: string; url: string; dish: string; label: string; course: Course;
  rank: number; distance: number; similarity: number;
};
export type Vote = { dish: string; votes: number; score: number; ranks: number[] };
export type Guess = { dish: string; votes: number; of: number };

/** How turbopuffer ran a search, for the Explain panel. */
export type RunInfo = {
  namespace: string;
  request: Record<string, unknown>; // as sent, with the query vector shown as "[512 floats]"
  filters: string[];                // in words
  topK: number;
  roundMs: number;                  // round trip from the Vercel function
  serverMs: number | null;          // turbopuffer's own time
  cache: string | null;             // turbopuffer's cache temperature: hot, warm or cold
  billedBytesQueried: number | null;
  approxRows: number | null;        // rows in the namespace
};
export type SearchResult = { hits: Hit[]; guess: Guess | null; votes: Vote[]; ms: number; run: RunInfo };

export function isCourse(v: unknown): v is Course {
  return typeof v === "string" && (COURSES as readonly string[]).includes(v);
}

type Row = Record<string, unknown> & { id: string | number; $dist?: number };

/** Nearest dishes to `vector`, optionally limited to one course and excluding one id. */
export async function searchByVector(vector: number[], opts: { course?: Course; excludeId?: string; limit: number }): Promise<SearchResult> {
  const t0 = performance.now();
  const filters: unknown[] = [];
  const words: string[] = [];
  if (opts.course) { filters.push(["course", "Eq", opts.course]); words.push(`course = ${opts.course}`); }
  if (opts.excludeId) { filters.push(["id", "NotEq", opts.excludeId]); words.push(`id ≠ ${opts.excludeId} (the photo itself)`); }
  const request: Record<string, unknown> = {
    rank_by: ["vector", "ANN", vector],
    top_k: opts.limit,
    include_attributes: ATTRS,
    ...(filters.length ? { filters: filters.length === 1 ? filters[0] : ["And", filters] } : {}),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res: any;
  const [approxRows] = await Promise.all([
    rowCount(),
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res = await tpCall("query", NAMESPACE, request, () => ns().query(request as any), { label: "search" });
      } catch (err) {
        // The namespace doesn't exist until the data is loaded: show "no matches", not an error.
        if ((err as { status?: number }).status === 404) res = { rows: [] };
        else throw err;
      }
    })(),
  ]);
  const roundMs = Math.round(performance.now() - t0);
  const hits: Hit[] = ((res.rows ?? []) as Row[]).map((r, i) => {
    const distance = Number(r.$dist ?? 1); // cosine_distance = 1 - cosine similarity
    return { id: String(r.id), url: String(r.url), dish: String(r.dish), label: String(r.label), course: r.course as Course,
      rank: i + 1, distance, similarity: 1 - distance };
  });
  const votes = tally(hits);
  const top = votes[0];
  return {
    hits,
    votes,
    guess: top ? { dish: top.dish, votes: top.votes, of: Math.min(10, hits.length) } : null,
    ms: roundMs,
    run: {
      namespace: NAMESPACE,
      request: { ...request, rank_by: shortRankBy(request.rank_by), include_attributes: ATTRS },
      filters: words,
      topK: opts.limit,
      roundMs,
      serverMs: num(res.performance?.server_total_ms),
      cache: typeof res.performance?.cache_temperature === "string" ? res.performance.cache_temperature : null,
      billedBytesQueried: num(res.billing?.billable_logical_bytes_queried),
      approxRows,
    },
  };
}

/** A stored photo's vector, or null if the id isn't in the namespace. */
export async function vectorOf(id: string): Promise<number[] | null> {
  const req = { filters: ["id", "Eq", id], top_k: 1, include_attributes: ["vector"] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tpCall("query", NAMESPACE, req, () => ns().query(req as any), { label: "get-vector" });
  const v = res.rows?.[0]?.vector;
  return Array.isArray(v) ? v.map(Number) : null;
}

/** "More like this": look up a stored row's vector, then search with it. */
export async function searchById(id: string, opts: { course?: Course; limit: number }): Promise<SearchResult | null> {
  const vector = await vectorOf(id);
  return vector ? searchByVector(vector, { ...opts, excludeId: id }) : null;
}

/**
 * Best guess at the dish: a vote among the top 10 hits, where higher-ranked hits count more (1/rank).
 * Returns every dish that got a vote, best first.
 */
function tally(hits: Hit[]): Vote[] {
  const by = new Map<string, Vote>();
  for (const h of hits.slice(0, 10)) {
    const v = by.get(h.dish) ?? { dish: h.dish, votes: 0, score: 0, ranks: [] };
    v.votes += 1;
    v.score += 1 / h.rank;
    v.ranks.push(h.rank);
    by.set(h.dish, v);
  }
  return [...by.values()].sort((a, b) => b.score - a.score);
}

// Row count for the Explain panel, cached for 10 minutes per server instance.
let rows: { at: number; n: number | null } | null = null;
async function rowCount(): Promise<number | null> {
  if (rows && Date.now() - rows.at < 600_000) return rows.n;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = await tpCall("metadata", NAMESPACE, {}, () => ns().metadata(), { label: "metadata" });
    rows = { at: Date.now(), n: num(m.approx_row_count) };
  } catch {
    rows = { at: Date.now(), n: null };
  }
  return rows.n;
}

/** turbopuffer's query plan for a search, and the same search timed with strong and eventual consistency. */
export async function explainSearch(request: Record<string, unknown>) {
  const n = ns();
  // turbopuffer builds the vector index in the background; until it exists there's no plan to show (it answers 400
  // "index does not exist"). The consistency timings still work, so report that instead of failing.
  let plan: string | null = null;
  let planNote: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await tpCall("explain", NAMESPACE, request, () => n.explainQuery(request as any), { label: "explain-query" });
    plan = String(r.plan_text ?? "");
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (!/index does not exist/i.test(msg)) throw e;
    planNote = "turbopuffer hasn't built a vector index for this namespace yet, so there's no query plan to show. " +
      "Until the index exists, searches compare against the stored vectors directly. Try again later.";
  }
  const timed = async (level: "strong" | "eventual") => {
    const req = { ...request, consistency: { level } };
    const t0 = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tpCall("query", NAMESPACE, req, () => n.query(req as any), { label: `consistency-${level}` });
    return { level, roundMs: Math.round(performance.now() - t0), serverMs: num(res.performance?.server_total_ms) };
  };
  // One after the other, so the two timings don't compete for the same connection.
  const strong = await timed("strong");
  const eventual = await timed("eventual");
  return { plan, planNote, strong, eventual };
}

// ---------------------------------------------------------------- copilot lookups

export type Photo = { id: string; url: string; dish: string; label: string; course: Course };
const photoOf = (r: Row): Photo => ({ id: String(r.id), url: String(r.url), dish: String(r.dish), label: String(r.label), course: r.course as Course });

/** A few photos of one dish (by Food-101 label), in id order. */
export async function photosOf(label: string, n: number): Promise<Photo[]> {
  const req = { filters: ["label", "Eq", label], rank_by: ["id", "asc"], top_k: n, include_attributes: ATTRS };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tpCall("query", NAMESPACE, req, () => ns().query(req as any), { label: "dish-photos" });
  return ((res.rows ?? []) as Row[]).map(photoOf);
}

export type SimilarDish = { dish: string; label: string; course: Course; matches: number; best: number; example: Photo };

/**
 * Which other dishes look most like `label` in CLIP space: average the dish's photo vectors into one "typical" vector,
 * find its 200 nearest photos of other dishes, and rank those dishes by how many of their photos showed up.
 */
export async function similarDishes(label: string, k: number): Promise<{ sampled: number; dishes: SimilarDish[] }> {
  const vreq = { filters: ["label", "Eq", label], rank_by: ["id", "asc"], top_k: 40, include_attributes: ["vector"] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vres: any = await tpCall("query", NAMESPACE, vreq, () => ns().query(vreq as any), { label: "dish-vectors" });
  const vecs = ((vres.rows ?? []) as Row[]).map((r) => (r.vector as number[]).map(Number));
  if (!vecs.length) return { sampled: 0, dishes: [] };
  const mean = new Array<number>(DIM).fill(0);
  for (const v of vecs) for (let i = 0; i < DIM; i++) mean[i] += v[i] / vecs.length;
  const norm = Math.hypot(...mean) || 1;
  const centroid = mean.map((x) => x / norm);
  const req = { rank_by: ["vector", "ANN", centroid], top_k: 200, filters: ["label", "NotEq", label], include_attributes: ATTRS };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tpCall("query", NAMESPACE, req, () => ns().query(req as any), { label: "similar-dishes" });
  const by = new Map<string, SimilarDish>();
  for (const r of (res.rows ?? []) as Row[]) {
    const p = photoOf(r);
    const sim = 1 - Number(r.$dist ?? 1);
    const d = by.get(p.label) ?? { dish: p.dish, label: p.label, course: courseOf(p.label), matches: 0, best: sim, example: p };
    d.matches += 1;
    by.set(p.label, d);
  }
  return { sampled: vecs.length, dishes: [...by.values()].sort((a, b) => b.matches - a.matches).slice(0, k) };
}

export const dishLabel = (s: string) => s.trim().toLowerCase().replaceAll(" ", "_");
export { dishName };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
