// POST /api/search
//   { vector: number[512], course?, limit?, query? }   search by a query embedding made in the browser
//   { id: string, course?, limit?, query? }            "more like this" for a stored photo
// `query` describes the search for the Langfuse trace: { kind: "text" | "photo" | "similar", text?, embedMs? }.
import { after } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { DIM, isCourse, NAMESPACE, searchById, searchByVector, type SearchResult } from "@/lib/search";
import { requireUserId } from "@/lib/session";

const MAX_LIMIT = 48;

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const course = isCourse(body.course) ? body.course : undefined;
  const limit = Math.min(Math.max(Number(body.limit) || 24, 1), MAX_LIMIT);
  const byId = typeof body.id === "string" && /^[a-z]+-\d+$/.test(body.id) ? body.id : null;
  const v = body.vector;
  if (!byId && (!Array.isArray(v) || v.length !== DIM || !v.every((x) => typeof x === "number" && Number.isFinite(x)))) {
    return Response.json({ error: `vector must be ${DIM} finite numbers` }, { status: 400 });
  }
  const q = (body.query ?? {}) as { kind?: unknown; text?: unknown; embedMs?: unknown };
  const kind = byId ? "similar" : q.kind === "photo" ? "photo" : "text";
  const text = typeof q.text === "string" ? q.text.slice(0, 200) : undefined;
  const embedMs = typeof q.embedMs === "number" ? Math.round(q.embedMs) : undefined;

  after(flushLangfuse);
  try {
    const result = await newTrace(
      { userId: user, tags: ["search", kind], traceName: "search", metadata: { kind, course: course ?? "all" } },
      () => startActiveObservation("search-dishes", async (obs) => {
        // The trace shows the query as the user gave it; the vector itself is never recorded.
        obs.update({ input: { kind, text, similarTo: byId ?? undefined, course: course ?? "all", limit },
          metadata: { namespace: NAMESPACE, embedMsInBrowser: embedMs } });
        const r: SearchResult | null = byId ? await searchById(byId, { course, limit }) : await searchByVector(v as number[], { course, limit });
        if (r) {
          obs.update({
            output: { guess: r.guess, top: r.hits.slice(0, 10).map((h) => ({ id: h.id, dish: h.dish, similarity: round(h.similarity) })) },
            metadata: { hits: r.hits.length, roundMs: r.run.roundMs, serverMs: r.run.serverMs, cache: r.run.cache,
              guess: r.guess?.dish, topSimilarity: r.hits[0] ? round(r.hits[0].similarity) : undefined },
          });
        }
        return r;
      }, { asType: "chain" }),
    );
    return result ? Response.json(result) : Response.json({ error: "Unknown id" }, { status: 404 });
  } catch (err) {
    console.error("search failed", err);
    return Response.json({ error: "Search failed" }, { status: 500 });
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
