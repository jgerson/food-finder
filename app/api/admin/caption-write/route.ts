// TEMPORARY (branch caption-bakeoff only; never merged to main): captions photos with Claude Haiku 5.5 through AI
// Gateway and patches the result onto the existing food101 rows (vectors untouched). Guarded by CAPTION_TOKEN.
//   caption   the one-sentence description, shown in the app
//   keywords  dish name + visible ingredients, methods, colors, serving and the caption; BM25-indexed
import { timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { dishName } from "@/lib/courses";

export const maxDuration = 120;
const MODEL = "anthropic/claude-haiku-5.5";

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

type Item = { id: string; label: string; url: string };
type Parsed = { ingredients?: string[]; method?: string[]; colors?: string[]; serving?: string; caption?: string };

function parse(text: string): Parsed | null {
  let t = text.trim();
  if (t.startsWith("```")) t = t.replace(/^```[a-z]*\n?/, "").replace(/```\s*$/, "");
  try {
    const j = JSON.parse(t);
    return j && typeof j.caption === "string" ? j : null;
  } catch {
    return null;
  }
}

async function imageBase64(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`image ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString("base64");
}

const list = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, n).map((x) => x.trim()) : []);

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { items } = (await req.json()) as { items: Item[] };
  if (!Array.isArray(items) || items.length > 10) return Response.json({ error: "bad request" }, { status: 400 });
  const llm = new Anthropic({ baseURL: "https://ai-gateway.vercel.sh", authToken: await getVercelOidcToken(), maxRetries: 3, timeout: 60_000 });
  let inTokens = 0, outTokens = 0;
  const done = await Promise.all(items.map(async (it) => {
    if (!/^validation-\d+$/.test(it.id) || !it.url.startsWith("https://7gsffjbxpqrsgimi.public.blob.vercel-storage.com/")) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const msg = await llm.messages.create({
          model: MODEL, max_tokens: 1500,
          messages: [{ role: "user", content: [
            // Bytes, not a URL: AI Gateway sometimes routes to a provider that won't fetch image URLs.
            { type: "image", source: { type: "base64", media_type: "image/webp", data: await imageBase64(it.url) } },
            { type: "text", text: PROMPT(dishName(it.label)) },
          ] }],
        });
        inTokens += msg.usage.input_tokens; outTokens += msg.usage.output_tokens;
        const p = parse(msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
        if (!p) continue;
        const caption = String(p.caption).trim().slice(0, 300);
        const keywords = [dishName(it.label), ...list(p.ingredients, 8), ...list(p.method, 3), ...list(p.colors, 4),
          typeof p.serving === "string" ? p.serving.trim() : "", caption].filter(Boolean).join(" · ");
        return { id: it.id, caption, keywords };
      } catch {
        // retry once, then give up on this photo (the client re-sends missing ones)
      }
    }
    return null;
  }));
  const rows = done.filter((r): r is { id: string; caption: string; keywords: string } => r !== null);
  if (rows.length) {
    const tpuf = new Turbopuffer({ apiKey: process.env.TURBOPUFFER_API_KEY!, region: process.env.TURBOPUFFER_REGION || "aws-us-east-1" });
    await tpuf.namespace(process.env.TURBOPUFFER_NAMESPACE ?? "food101").write({
      patch_rows: rows,
      schema: {
        caption: { type: "string", filterable: false },
        keywords: { type: "string", full_text_search: true, filterable: false },
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
  return Response.json({ written: rows.map((r) => r.id), failed: items.length - rows.length, inTokens, outTokens,
    sample: rows[0] ?? null });
}
