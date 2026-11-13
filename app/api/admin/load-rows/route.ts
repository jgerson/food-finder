// TEMPORARY (branch caption-bakeoff only; never merged to main): loads photos that the original ingest missed straight
// into food101-v2: uploads the image to Blob, captions it with Claude Haiku 5.5, and upserts the row (CLIP vector from
// the dataset, caption, keywords, and the natively embedded description). Guarded by CAPTION_TOKEN.
import { timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { put } from "@vercel/blob";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { courseOf, dishName } from "@/lib/courses";

export const maxDuration = 120;
const TARGET = "food101-v2";

const PROMPT = (dish: string) => `This photo is labeled "${dish}" in a food dataset. Describe only the food and its \
dishware that you can see, for a keyword search index. Ignore packaging, menus, tray liners and anything printed. \
Use the usual names for components you can see (say "calamari", not "fried rings"), but don't list ingredients the \
dish usually has unless they're visible; if you aren't sure what something is, leave it out. Reply with JSON only:
{"ingredients": [visible foods and garnishes, most prominent first, max 8],
 "method": [visible cooking methods, e.g. "fried", "grilled", "raw", max 3],
 "colors": [main colors, max 4],
 "serving": "how it's served, e.g. 'bowl of soup', 'plated with sauce'",
 "caption": "one plain sentence, max 20 words"}`;

function authorized(req: Request) {
  const expected = process.env.CAPTION_TOKEN ?? "";
  const got = req.headers.get("x-caption-token") ?? "";
  return expected.length >= 32 && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
const list = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, n).map((x) => x.trim()) : []);

type Item = { id: string; label: string; image: string; vector: number[] };

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { items } = (await req.json()) as { items: Item[] };
  if (!Array.isArray(items) || items.length > 10) return Response.json({ error: "bad request" }, { status: 400 });
  const llm = new Anthropic({ baseURL: "https://ai-gateway.vercel.sh", authToken: await getVercelOidcToken(), maxRetries: 3, timeout: 60_000 });
  const rows = (await Promise.all(items.map(async (it) => {
    if (!/^validation-\d+$/.test(it.id) || !Array.isArray(it.vector) || it.vector.length !== 512) return null;
    const num = it.id.split("-")[1];
    try {
      const { url } = await put(`food101/validation/${num}.webp`, Buffer.from(it.image, "base64"), {
        access: "public", contentType: "image/webp", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000,
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const msg = await llm.messages.create({
          model: "anthropic/claude-haiku-5.5", max_tokens: 1500,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: "image/webp", data: it.image } },
            { type: "text", text: PROMPT(dishName(it.label)) },
          ] }],
        });
        let t = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
        if (t.startsWith("```")) t = t.replace(/^```[a-z]*\n?/, "").replace(/```\s*$/, "");
        let p: { ingredients?: unknown; method?: unknown; colors?: unknown; serving?: unknown; caption?: unknown };
        try { p = JSON.parse(t); } catch { continue; }
        if (typeof p.caption !== "string") continue;
        const caption = p.caption.trim().slice(0, 300);
        const keywords = [dishName(it.label), ...list(p.ingredients, 8), ...list(p.method, 3), ...list(p.colors, 4),
          typeof p.serving === "string" ? p.serving.trim() : "", caption].filter(Boolean).join(" · ");
        return { id: it.id, vector: it.vector, url, label: it.label, dish: dishName(it.label), course: courseOf(it.label),
          caption, keywords, description: keywords };
      }
    } catch {
      // the client re-sends missing ones
    }
    return null;
  }))).filter((r) => r !== null);
  if (rows.length) {
    await new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY!, region: process.env.TURBOPUFFER_REGION || "aws-us-east-1" })
      .namespace(TARGET).write({
        upsert_rows: rows,
        distance_metric: "cosine_distance",
        schema: {
          url: { type: "string", filterable: false },
          dish: { type: "string", filterable: false },
          label: { type: "string" },
          course: { type: "string" },
          caption: { type: "string", filterable: false },
          keywords: { type: "string", full_text_search: true, filterable: false },
          description: { type: "string", embed: "voyage/voyage-4-lite", filterable: false },
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
  }
  return Response.json({ written: rows.map((r) => r.id), failed: items.length - rows.length });
}
