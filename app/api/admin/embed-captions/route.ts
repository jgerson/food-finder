// TEMPORARY (branch caption-bakeoff only; never merged to main): copies each photo's keywords text into a new
// `description` attribute that turbopuffer embeds itself (native embedding, voyage/voyage-4-lite), for meaning-based
// caption search. Pages through the namespace by id; the client calls it until `next` is null. Guarded by CAPTION_TOKEN.
import { timingSafeEqual } from "node:crypto";
import Turbopuffer from "@turbopuffer/turbopuffer";

export const maxDuration = 120;
const EMBED_MODEL = "voyage/voyage-4-lite";

function authorized(req: Request) {
  const expected = process.env.CAPTION_TOKEN ?? "";
  const got = req.headers.get("x-caption-token") ?? "";
  return expected.length >= 32 && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { after, size } = (await req.json()) as { after?: string; size?: number };
  const n = Math.min(Math.max(Number(size) || 200, 1), 500);
  const ns = new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY!, region: process.env.TURBOPUFFER_REGION || "aws-us-east-1" })
    .namespace(process.env.TURBOPUFFER_NAMESPACE ?? "food101");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page: any = await ns.query({
    rank_by: ["id", "asc"], top_k: n, include_attributes: ["keywords"],
    ...(after ? { filters: ["id", "Gt", after] } : {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const rows = (page.rows ?? []) as { id: string; keywords?: string }[];
  const patch = rows.filter((r) => typeof r.keywords === "string" && r.keywords).map((r) => ({ id: r.id, description: r.keywords }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let w: any = null;
  if (patch.length) {
    w = await ns.write({
      patch_rows: patch,
      schema: { description: { type: "string", embed: EMBED_MODEL, filterable: false } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
  return Response.json({
    read: rows.length, written: patch.length, missingKeywords: rows.length - patch.length,
    next: rows.length === n ? rows.at(-1)!.id : null,
    embeddingTokens: w?.performance?.embedding_tokens ?? w?.billing?.embedding_tokens ?? null,
    billing: w?.billing ?? null,
  });
}
