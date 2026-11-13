// TEMPORARY (branch caption-bakeoff only; never merged to main): captions photos with a chosen Claude model through
// AI Gateway, using this project's OIDC token, for a Haiku vs Sonnet comparison. Guarded by CAPTION_TOKEN.
import { timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { dishName } from "@/lib/courses";

export const maxDuration = 60;
const MODELS = ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"];

const PROMPT = (dish: string) => `This photo is labeled "${dish}" in a food dataset. Describe only what is visible in \
the photo, for a keyword search index. Don't list ingredients the dish usually has unless you can see them; if you \
aren't sure what something is, leave it out. Reply with JSON only, no other text:
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

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { model, items } = (await req.json()) as { model: string; items: { id: string; label: string; url: string }[] };
  if (!MODELS.includes(model) || !Array.isArray(items) || items.length > 10) return Response.json({ error: "bad request" }, { status: 400 });
  const llm = new Anthropic({ baseURL: "https://ai-gateway.vercel.sh", authToken: await getVercelOidcToken(), maxRetries: 2, timeout: 45_000 });
  const out = await Promise.all(items.map(async (it) => {
    if (!it.url.startsWith("https://7gsffjbxpqrsgimi.public.blob.vercel-storage.com/")) return { id: it.id, error: "bad url" };
    const t0 = performance.now();
    try {
      const msg = await llm.messages.create({
        model, max_tokens: 1500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "url", url: it.url } },
          { type: "text", text: PROMPT(dishName(it.label)) },
        ] }],
      });
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      return { id: it.id, text, ms: Math.round(performance.now() - t0), inTokens: msg.usage.input_tokens, outTokens: msg.usage.output_tokens,
        stop: msg.stop_reason, blocks: msg.content.map((b) => b.type) };
    } catch (e) {
      return { id: it.id, error: String((e as Error).message).slice(0, 300) };
    }
  }));
  return Response.json({ model, results: out });
}
