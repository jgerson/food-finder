// POST /api/explain  { vector | id, course?, limit? }
// turbopuffer's query plan for a search, and the same search timed with strong and eventual consistency.
// The request is rebuilt here from the same inputs /api/search takes; nothing from the browser is sent as-is.
import { after } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { DIM, explainSearch, isCourse, vectorOf } from "@/lib/search";
import { requireUserId } from "@/lib/session";

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const course = isCourse(body.course) ? body.course : undefined;
  const limit = Math.min(Math.max(Number(body.limit) || 24, 1), 48);
  const byId = typeof body.id === "string" && /^[a-z]+-\d+$/.test(body.id) ? body.id : null;

  after(flushLangfuse);
  try {
    const out = await newTrace({ userId: user, tags: ["explain"], traceName: "explain" }, () =>
      startActiveObservation("explain-search", async (obs) => {
        let vector = body.vector as number[] | null;
        if (byId) vector = await vectorOf(byId);
        if (!Array.isArray(vector) || vector.length !== DIM || !vector.every((x) => typeof x === "number" && Number.isFinite(x))) {
          return null;
        }
        const filters: unknown[] = [];
        if (course) filters.push(["course", "Eq", course]);
        if (byId) filters.push(["id", "NotEq", byId]);
        const request = {
          rank_by: ["vector", "ANN", vector], top_k: limit,
          ...(filters.length ? { filters: filters.length === 1 ? filters[0] : ["And", filters] } : {}),
        };
        obs.update({ input: { similarTo: byId ?? undefined, course: course ?? "all", limit } });
        const r = await explainSearch(request);
        obs.update({ output: { strong: r.strong, eventual: r.eventual, planChars: r.plan.length } });
        return r;
      }, { asType: "chain" }));
    return out ? Response.json(out) : Response.json({ error: "Nothing to explain." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
