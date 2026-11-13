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
const ATTRS = ["url", "dish", "label", "course", "caption", "keywords"];

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

export type Mode = "vector" | "keyword" | "hybrid";
export const MODES: Mode[] = ["hybrid", "vector", "keyword"];
export const RRF_K = 60;

/** One ranked list's view of a photo: its place in that list and the list's raw score. */
export type Signal = { rank: number; of: number; score: number };

export type Hit = {
  id: string; url: string; dish: string; label: string; course: Course;
  caption: string | null;   // AI-generated description (Claude Haiku 5.5), null until captioned
  keywords: string | null;  // what BM25 searches: dish name, visible ingredients, methods, colors, serving, caption
  rank: number;             // final position
  vector: (Signal & { similarity: number }) | null; // score = cosine distance
  bm25: Signal | null;      // score = BM25
  fused: number | null;     // RRF score, hybrid only
  terms: string[];          // query words found in keywords
  // Kept for the parts of the app that only know vector search: the vector similarity, or null.
  similarity: number | null;
};
export type Vote = { dish: string; votes: number; score: number; ranks: number[] };
export type Guess = { dish: string; votes: number; of: number };

/** How turbopuffer ran a search, for the Explain panel. */
export type RunInfo = {
  namespace: string;
  mode: Mode;
  request: Record<string, unknown>; // as sent, with the query vector shown as "[512 floats]"
  filters: string[];                // in words
  topK: number;
  candidates: number;               // rows asked of each list before fusing
  roundMs: number;                  // round trip from the Vercel function
  serverMs: number | null;          // turbopuffer's own time
  cache: string | null;             // turbopuffer's cache temperature: hot, warm or cold
  billedBytesQueried: number | null;
  approxRows: number | null;        // rows in the namespace
  listSizes: { vector?: number; keyword?: number };
};
export type SearchResult = { hits: Hit[]; guess: Guess | null; votes: Vote[]; ms: number; run: RunInfo; terms: string[] };

export function isCourse(v: unknown): v is Course {
  return typeof v === "string" && (COURSES as readonly string[]).includes(v);
}
export function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as string[]).includes(v);
}

type Row = Record<string, unknown> & { id: string | number; $dist?: number };

const STOP = new Set(["a", "an", "and", "the", "of", "with", "in", "on", "or", "to", "for", "some", "dish", "food", "plate"]);
/** Query words worth highlighting: lowercase, 2+ letters, no stopwords. */
export function queryTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z][a-z-]+/g) ?? [])].filter((w) => !STOP.has(w)).slice(0, 12);
}

/**
 * Search the namespace. `vector` ranks by CLIP similarity, `keyword` by BM25 over the caption keywords, and `hybrid`
 * runs both in one multi_query and fuses them with reciprocal rank fusion: score = Σ 1/(60 + rank) over the lists a
 * photo appears in. Photo queries and "more like this" have no text, so they're vector-only.
 */
export async function search(q: { vector?: number[]; text?: string; mode: Mode; course?: Course; excludeId?: string; limit: number }): Promise<SearchResult> {
  const mode: Mode = q.text ? (q.vector ? q.mode : "keyword") : "vector";
  const t0 = performance.now();
  const filters: unknown[] = [];
  const words: string[] = [];
  if (q.course) { filters.push(["course", "Eq", q.course]); words.push(`course = ${q.course}`); }
  if (q.excludeId) { filters.push(["id", "NotEq", q.excludeId]); words.push(`id ≠ ${q.excludeId} (the photo itself)`); }
  // In hybrid, each list returns more candidates than shown, so a photo ranked lower in one list can still be fused in.
  const candidates = mode === "hybrid" ? Math.min(100, q.limit * 2) : q.limit;
  const base: Record<string, unknown> = {
    top_k: candidates, include_attributes: ATTRS,
    ...(filters.length ? { filters: filters.length === 1 ? filters[0] : ["And", filters] } : {}),
  };
  const vec = { ...base, rank_by: ["vector", "ANN", q.vector] };
  const kw = { ...base, rank_by: ["keywords", "BM25", q.text ?? ""] };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res: any = {};
  let lists: { vector?: Row[]; keyword?: Row[] } = {};
  const [approxRows] = await Promise.all([
    rowCount(),
    (async () => {
      try {
        if (mode === "hybrid") {
          const req = { queries: [vec, kw] };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          res = await tpCall("multi_query", NAMESPACE, req, () => ns().multiQuery(req as any), { label: "search" });
          lists = { vector: res.results?.[0]?.rows ?? [], keyword: res.results?.[1]?.rows ?? [] };
        } else {
          const req = mode === "vector" ? vec : kw;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          res = await tpCall("query", NAMESPACE, req, () => ns().query(req as any), { label: "search" });
          lists = { [mode]: res.rows ?? [] };
        }
      } catch (err) {
        // The namespace doesn't exist until the data is loaded: show "no matches", not an error.
        if ((err as { status?: number }).status !== 404) throw err;
      }
    })(),
  ]);
  const roundMs = Math.round(performance.now() - t0);

  const docs = new Map<string, { row: Row; vector: Hit["vector"]; bm25: Hit["bm25"] }>();
  for (const [name, rows] of Object.entries(lists) as ["vector" | "keyword", Row[]][]) {
    rows.forEach((row, i) => {
      const id = String(row.id);
      const d = docs.get(id) ?? { row, vector: null, bm25: null };
      const score = Number(row.$dist ?? 0);
      if (name === "vector") d.vector = { rank: i + 1, of: rows.length, score, similarity: 1 - score };
      else d.bm25 = { rank: i + 1, of: rows.length, score };
      docs.set(id, d);
    });
  }
  const terms = q.text ? queryTerms(q.text) : [];
  const fusedOf = (d: { vector: Hit["vector"]; bm25: Hit["bm25"] }) =>
    (d.vector ? 1 / (RRF_K + d.vector.rank) : 0) + (d.bm25 ? 1 / (RRF_K + d.bm25.rank) : 0);
  const ordered = [...docs.entries()]
    .map(([id, d]) => ({ id, ...d, fused: fusedOf(d) }))
    .sort((a, b) => (mode === "hybrid" ? b.fused - a.fused : 0));
  const hits: Hit[] = ordered.slice(0, q.limit).map((d, i) => {
    const r = d.row;
    const keywords = typeof r.keywords === "string" ? r.keywords : null;
    const lower = (keywords ?? "").toLowerCase();
    return {
      id: d.id, url: String(r.url), dish: String(r.dish), label: String(r.label), course: r.course as Course,
      caption: typeof r.caption === "string" ? r.caption : null, keywords,
      rank: i + 1, vector: d.vector, bm25: d.bm25, fused: mode === "hybrid" ? d.fused : null,
      terms: terms.filter((t) => new RegExp(`\\b${t.replace(/-/g, "\\-")}`).test(lower)),
      similarity: d.vector?.similarity ?? null,
    };
  });
  const votes = tally(hits);
  const top = votes[0];
  const short = (x: Record<string, unknown>) => ({ ...x, rank_by: shortRankBy(x.rank_by) });
  return {
    hits, votes, terms,
    guess: top ? { dish: top.dish, votes: top.votes, of: Math.min(10, hits.length) } : null,
    ms: roundMs,
    run: {
      namespace: NAMESPACE, mode,
      request: mode === "hybrid" ? { queries: [short(vec), short(kw)] } : short(mode === "vector" ? vec : kw),
      filters: words, topK: q.limit, candidates, roundMs,
      serverMs: num(res.performance?.server_total_ms),
      cache: typeof res.performance?.cache_temperature === "string" ? res.performance.cache_temperature : null,
      billedBytesQueried: num(res.billing?.billable_logical_bytes_queried),
      approxRows,
      listSizes: { vector: lists.vector?.length, keyword: lists.keyword?.length },
    },
  };
}

/** Nearest photos to `vector` (photo queries and "more like this"). */
export function searchByVector(vector: number[], opts: { course?: Course; excludeId?: string; limit: number }): Promise<SearchResult> {
  return search({ vector, mode: "vector", ...opts });
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

/**
 * turbopuffer's query plan for a search (one plan per subquery in hybrid), and the same search timed with strong and
 * eventual consistency.
 */
export async function explainSearch(request: Record<string, unknown>) {
  const n = ns();
  const subqueries = Array.isArray(request.queries) ? (request.queries as Record<string, unknown>[]) : [request];
  const multi = subqueries.length > 1;
  // turbopuffer builds the vector index in the background; until it exists it answers 400 "index does not exist"
  // for a vector plan. The other plans and the consistency timings still work, so report that instead of failing.
  const plans = await Promise.all(subqueries.map(async (q) => {
    const label = Array.isArray(q.rank_by) && q.rank_by[1] === "BM25" ? "Keyword (BM25)" : "Vector (ANN)";
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await tpCall("explain", NAMESPACE, q, () => n.explainQuery(q as any), { label: "explain-query" });
      return { label, plan: String(r.plan_text ?? ""), note: null as string | null };
    } catch (e) {
      if (!/index does not exist/i.test(String((e as Error).message ?? e))) throw e;
      return { label, plan: null, note: "turbopuffer hasn't built this index yet, so there's no plan to show. Until it " +
        "exists, the search reads the stored data directly. Try again later." };
    }
  }));
  const timed = async (level: "strong" | "eventual") => {
    const req = { ...request, consistency: { level } };
    const t0 = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tpCall(multi ? "multi_query" : "query", NAMESPACE, req,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (): Promise<unknown> => (multi ? n.multiQuery(req as any) : n.query(req as any)), { label: `consistency-${level}` });
    return { level, roundMs: Math.round(performance.now() - t0), serverMs: num(res.performance?.server_total_ms) };
  };
  // One after the other, so the two timings don't compete for the same connection.
  const strong = await timed("strong");
  const eventual = await timed("eventual");
  return { plans, strong, eventual };
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
