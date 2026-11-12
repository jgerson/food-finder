// TEMPORARY loading endpoint (branch ingest-loader only; never merged to main).
// Takes batches of pre-embedded rows with WebP image bytes, uploads the images to Vercel Blob and writes the
// rows to turbopuffer using this project's own env vars, so the turbopuffer key never leaves Vercel.
// Guarded by INGEST_TOKEN (a random value set only for this branch's preview deployments).
import { timingSafeEqual } from "node:crypto";
import { put } from "@vercel/blob";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { courseOf, dishName } from "@/lib/courses";

export const maxDuration = 60;

type InRow = { id: string; label: string; image: string; vector: number[] };

function authorized(req: Request) {
  const expected = process.env.INGEST_TOKEN ?? "";
  const got = req.headers.get("x-ingest-token") ?? "";
  return expected.length >= 32 && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { rows } = (await req.json()) as { rows: InRow[] };
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 100) return Response.json({ error: "1-100 rows" }, { status: 400 });
  for (const r of rows) {
    if (!/^validation-\d+$/.test(r.id) || !/^[a-z_]+$/.test(r.label) || !Array.isArray(r.vector) || r.vector.length !== 512) {
      return Response.json({ error: `bad row ${r.id}` }, { status: 400 });
    }
  }
  const out = await Promise.all(rows.map(async (r) => {
    const { url } = await put(`food101/validation/${r.id.split("-")[1]}.webp`, Buffer.from(r.image, "base64"), {
      access: "public", contentType: "image/webp", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000,
    });
    return { id: r.id, vector: r.vector, url, label: r.label, dish: dishName(r.label), course: courseOf(r.label) };
  }));
  const tpuf = new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY!, region: process.env.TURBOPUFFER_REGION || "aws-us-east-1" });
  await tpuf.namespace(process.env.TURBOPUFFER_NAMESPACE ?? "food101").write({
    upsert_rows: out,
    distance_metric: "cosine_distance",
    schema: {
      url: { type: "string", filterable: false },
      dish: { type: "string", filterable: false },
      label: { type: "string" },
      course: { type: "string" },
    },
  });
  return Response.json({ written: out.length });
}
