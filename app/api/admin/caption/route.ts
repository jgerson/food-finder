// TEMPORARY (branch caption-bakeoff only; never merged to main): captions photos with a chosen model through AI
// Gateway, using this project's OIDC token, for a model comparison. Guarded by CAPTION_TOKEN.
import { timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { dishName } from "@/lib/courses";

export const maxDuration = 60;
const GATEWAY = "https://ai-gateway.vercel.sh";
// ":nothink" = the same Claude model with extended thinking turned off.
const MODELS = ["anthropic/claude-haiku-5.5", "anthropic/claude-haiku-5.5:nothink", "anthropic/claude-sonnet-5.5",
  "google/gemini-2.5-flash-lite", "alibaba/qwen3.7-flash"];

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
type Out = { text: string; inTokens: number; outTokens: number; reasoningTokens?: number; stop?: string | null };

async function claude(model: string, it: Item, token: string): Promise<Out> {
  const llm = new Anthropic({ baseURL: GATEWAY, authToken: token, maxRetries: 2, timeout: 45_000 });
  const noThink = model.endsWith(":nothink");
  const msg = await llm.messages.create({
    model: model.replace(":nothink", ""), max_tokens: 1500,
    ...(noThink ? { thinking: { type: "disabled" as const } } : {}),
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: it.url } },
      { type: "text", text: PROMPT(dishName(it.label)) },
    ] }],
  });
  return { text: msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim(),
    inTokens: msg.usage.input_tokens, outTokens: msg.usage.output_tokens, stop: msg.stop_reason };
}

async function openaiCompat(model: string, it: Item, token: string): Promise<Out> {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model, max_tokens: 1500, response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: it.url } },
        { type: "text", text: PROMPT(dishName(it.label)) },
      ] }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  return { text: String(j.choices?.[0]?.message?.content ?? "").trim(), inTokens: j.usage?.prompt_tokens ?? 0,
    outTokens: j.usage?.completion_tokens ?? 0, reasoningTokens: j.usage?.completion_tokens_details?.reasoning_tokens,
    stop: j.choices?.[0]?.finish_reason };
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { model, items } = (await req.json()) as { model: string; items: Item[] };
  if (!MODELS.includes(model) || !Array.isArray(items) || items.length > 10) return Response.json({ error: "bad request" }, { status: 400 });
  const token = await getVercelOidcToken();
  const out = await Promise.all(items.map(async (it) => {
    if (!it.url.startsWith("https://7gsffjbxpqrsgimi.public.blob.vercel-storage.com/")) return { id: it.id, error: "bad url" };
    const t0 = performance.now();
    try {
      const r = model.startsWith("anthropic/") ? await claude(model, it, token) : await openaiCompat(model, it, token);
      return { id: it.id, ...r, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { id: it.id, error: String((e as Error).message).slice(0, 300) };
    }
  }));
  return Response.json({ model, results: out });
}
