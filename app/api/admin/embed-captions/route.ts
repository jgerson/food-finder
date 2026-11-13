// TEMPORARY (branch caption-bakeoff only; never merged to main): copies food101 into a new namespace, food101-v2,
// whose schema adds `description` (the keywords text) embedded by turbopuffer itself (native embedding,
// voyage/voyage-4-lite). turbopuffer only allows an embedded attribute on a namespace's first write, so the rows are
// copied rather than patched. Pages by id; the client calls it until `next` is null. Guarded by CAPTION_TOKEN.
import { timingSafeEqual } from "node:crypto";
import Turbopuffer from "@turbopuffer/turbopuffer";

export const maxDuration = 120;
const SOURCE = "food101";
const TARGET = "food101-v2";
const EMBED_MODEL = "voyage/voyage-4-lite";
const ATTRS = ["url", "dish", "label", "course", "caption", "keywords"];

function authorized(req: Request) {
  const expected = process.env.CAPTION_TOKEN ?? "";
  const got = req.headers.get("x-caption-token") ?? "";
  return expected.length >= 32 && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { after, size, stats, ids } = (await req.json()) as { after?: string; size?: number; stats?: boolean; ids?: string[] };
  if (stats || ids) {
    const tp0 = new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY!, region: process.env.TURBOPUFFER_REGION || "aws-us-east-1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = async (name: string) => { const r: any = await tp0.namespace(name).query({ aggregate_by: { n: ["Count"] } } as any); return r.aggregations?.n ?? null; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = async (name: string, list: string[]) => { const r: any = await tp0.namespace(name).query({ filters: ["id", "In", list], top_k: list.length, include_attributes: ["label"] } as any); return (r.rows ?? []).map((x: { id: string }) => x.id); };
    return Response.json({
      counts: { [SOURCE]: await count(SOURCE), [TARGET]: await count(TARGET) },
      ...(ids ? { presentInSource: await present(SOURCE, ids.slice(0, 1000)) } : {}),
    });
  }
  const n = Math.min(Math.max(Number(size) || 200, 1), 500);
  const tp = new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY!, region: process.env.TURBOPUFFER_REGION || "aws-us-east-1" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page: any = await tp.namespace(SOURCE).query({
    rank_by: ["id", "asc"], top_k: n, include_attributes: [...ATTRS, "vector"],
    ...(after ? { filters: ["id", "Gt", after] } : {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (page.rows ?? []) as any[];
  const upsert = rows.map((r) => ({
    id: r.id, vector: r.vector, url: r.url, dish: r.dish, label: r.label, course: r.course,
    caption: r.caption ?? "", keywords: r.keywords ?? r.dish, description: r.keywords ?? r.dish,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let w: any = null;
  if (upsert.length) {
    w = await tp.namespace(TARGET).write({
      upsert_rows: upsert,
      distance_metric: "cosine_distance",
      schema: {
        url: { type: "string", filterable: false },
        dish: { type: "string", filterable: false },
        label: { type: "string" },
        course: { type: "string" },
        caption: { type: "string", filterable: false },
        keywords: { type: "string", full_text_search: true, filterable: false },
        description: { type: "string", embed: EMBED_MODEL, filterable: false },
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
  return Response.json({
    read: rows.length, written: upsert.length, missingKeywords: rows.filter((r) => !r.keywords).length,
    // Stop only on an empty page: turbopuffer can return fewer rows than asked (response size limits).
    next: rows.length ? rows.at(-1)!.id : null,
    embeddingTokens: w?.performance?.embedding_tokens ?? null, rowsUpserted: w?.rows_upserted ?? null,
  });
}
