// TEMPORARY (branch hf-upload only; never merged to main): copies photos into the Hugging Face dataset repo named by
// HF_REPO, one commit per request. Guarded by CAPTION_TOKEN; the HF token stays in Vercel's environment.
import { timingSafeEqual } from "node:crypto";
import { uploadFiles, listFiles } from "@huggingface/hub";

export const maxDuration = 300;

function authorized(req: Request) {
  const expected = process.env.CAPTION_TOKEN ?? "";
  const got = req.headers.get("x-caption-token") ?? "";
  return expected.length >= 32 && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
const repo = () => ({ type: "dataset" as const, name: process.env.HF_REPO ?? "" });

// GET: how many photos are already in the repo.
export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.HF_TOKEN || !process.env.HF_REPO) return Response.json({ error: "HF_TOKEN or HF_REPO not set" }, { status: 500 });
  const ids: number[] = [];
  for await (const f of listFiles({ repo: repo(), accessToken: process.env.HF_TOKEN, path: "food101/validation" })) {
    const m = /\/(\d+)\.webp$/.exec(f.path);
    if (m) ids.push(Number(m[1]));
  }
  return Response.json({ repo: process.env.HF_REPO, count: ids.length, ids });
}

// POST {files: [{id, webp(base64)}]}: one commit with all of them.
export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!process.env.HF_TOKEN || !process.env.HF_REPO) return Response.json({ error: "HF_TOKEN or HF_REPO not set" }, { status: 500 });
  const { files } = (await req.json()) as { files: { id: number; webp: string }[] };
  if (!Array.isArray(files) || files.length === 0 || files.length > 400) return Response.json({ error: "bad request" }, { status: 400 });
  const ok = files.filter((f) => Number.isInteger(f.id) && f.id >= 0 && typeof f.webp === "string");
  await uploadFiles({
    repo: repo(),
    accessToken: process.env.HF_TOKEN,
    commitTitle: `Add ${ok.length} Food-101 photos`,
    files: ok.map((f) => ({ path: `food101/validation/${f.id}.webp`, content: new Blob([Buffer.from(f.webp, "base64")], { type: "image/webp" }) })),
  });
  return Response.json({ uploaded: ok.map((f) => f.id) });
}
