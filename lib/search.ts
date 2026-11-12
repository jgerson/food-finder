// Server-side search against turbopuffer. The browser sends a query vector (or the id of a result for
// "more like this"); this file is the only place the turbopuffer key is used.
import "server-only";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { COURSES, type Course } from "./courses";

export const DIM = 512;
const NAMESPACE = process.env.TURBOPUFFER_NAMESPACE ?? "food101";
const ATTRS = ["url", "dish", "label", "course"];

let client: Turbopuffer | null = null;

/** TURBOPUFFER_REGION, defaulting to aws-us-east-1 (unless TURBOPUFFER_BASE_URL points somewhere else). */
export function region(): string | undefined {
  return process.env.TURBOPUFFER_REGION || (process.env.TURBOPUFFER_BASE_URL ? undefined : "aws-us-east-1");
}
function ns() {
  const apiKey = process.env.TURBOPUFFER_API_KEY;
  if (!apiKey) throw new Error("TURBOPUFFER_API_KEY is not set");
  client ??= new Turbopuffer({ apiKey, region: region() });
  return client.namespace(NAMESPACE);
}

export type Hit = { id: string; url: string; dish: string; label: string; course: Course; similarity: number };
export type Guess = { dish: string; votes: number; of: number };
export type SearchResult = { hits: Hit[]; guess: Guess | null; ms: number };

export function isCourse(v: unknown): v is Course {
  return typeof v === "string" && (COURSES as readonly string[]).includes(v);
}

/** Nearest dishes to `vector`, optionally limited to one course and excluding one id. */
export async function searchByVector(vector: number[], opts: { course?: Course; excludeId?: string; limit: number }): Promise<SearchResult> {
  const t0 = performance.now();
  const filters: unknown[] = [];
  if (opts.course) filters.push(["course", "Eq", opts.course]);
  if (opts.excludeId) filters.push(["id", "NotEq", opts.excludeId]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await ns().query({
    rank_by: ["vector", "ANN", vector],
    top_k: opts.limit,
    include_attributes: ATTRS,
    ...(filters.length ? { filters: filters.length === 1 ? filters[0] : ["And", filters] } : {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hits: Hit[] = (res.rows ?? []).map((r: any) => ({
    id: String(r.id),
    url: r.url,
    dish: r.dish,
    label: r.label,
    course: r.course,
    // cosine_distance = 1 - cosine similarity
    similarity: 1 - Number(r.$dist ?? 1),
  }));
  return { hits, guess: guess(hits), ms: Math.round(performance.now() - t0) };
}

/** "More like this": look up a stored row's vector, then search with it. */
export async function searchById(id: string, opts: { course?: Course; limit: number }): Promise<SearchResult | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await ns().query({ filters: ["id", "Eq", id], top_k: 1, include_attributes: ["vector"] } as any);
  const vector = res.rows?.[0]?.vector;
  if (!Array.isArray(vector)) return null;
  return searchByVector(vector.map(Number), { ...opts, excludeId: id });
}

/** Best guess at the dish: a vote among the top 10 hits, where higher-ranked hits count more (1/rank). */
function guess(hits: Hit[]): Guess | null {
  const top = hits.slice(0, 10);
  if (!top.length) return null;
  const score = new Map<string, number>();
  const votes = new Map<string, number>();
  top.forEach((h, i) => {
    score.set(h.dish, (score.get(h.dish) ?? 0) + 1 / (i + 1));
    votes.set(h.dish, (votes.get(h.dish) ?? 0) + 1);
  });
  const dish = [...score].sort((a, b) => b[1] - a[1])[0][0];
  return { dish, votes: votes.get(dish)!, of: top.length };
}
