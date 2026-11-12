// The copilot: Claude with three tools over the food101 namespace, streamed to the browser as NDJSON events.
// Traced in Langfuse as an agent: a generation per model call and a tool observation per tool call, with every
// turbopuffer call nested under the tool that made it.
//
// Free-text CLIP search runs in the browser (the model is too large for a server function), so the copilot works from
// what turbopuffer can answer server-side: photos of a named dish, dishes that look alike (from averaged vectors),
// more photos like one it can see, and the results currently on screen, which the browser sends along.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { getActiveTraceId, startActiveObservation, startObservation } from "@langfuse/tracing";
import { assistantMessage, promptOf, usageOf } from "./langfuse";
import { costOf, priceOf } from "./pricing";
import { tracedFetch } from "./traced-fetch";
import { COURSE_LABELS, courseOf, dishName, type Course } from "./courses";
import { photosOf, searchById, similarDishes, type Photo } from "./search";
import { LABELS } from "./labels";

export const COPILOT_MODEL = process.env.COPILOT_MODEL
  ?? (process.env.ANTHROPIC_API_KEY ? "claude-haiku-5-5" : "anthropic/claude-haiku-5.5");
export const copilotEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.AI_GATEWAY_API_KEY
  || process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN);

/** The results on screen when the question was asked, sent by the browser. */
export type ScreenContext = {
  query: string; // e.g. 'text "crispy fried noodles"', 'a photo', 'more like Ramen'
  course: Course | null;
  guess: string | null;
  hits: { id: string; dish: string; url: string; similarity: number }[];
};

export type Cited = { id: string; dish: string; url: string };
export type Usage = { calls: number; inTokens: number; outTokens: number; cost: number | null };
export type CopilotEvent =
  | { type: "step"; tool: string; input: Record<string, unknown>; results: number; ms: number; reasoning?: string; summary: string }
  | { type: "text"; delta: string }
  | { type: "citations"; items: Record<string, Cited> }
  | { type: "usage"; usage: Usage }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "trace"; id: string }
  | { type: "done"; seconds: number };

const TOOLS: Anthropic.Tool[] = [
  {
    name: "show_dish_photos",
    description: "Get example photos of one or more Food-101 dishes, by their exact label. Use it to show the user what " +
      "a dish looks like, or to compare dishes side by side.",
    input_schema: {
      type: "object",
      properties: {
        dishes: { type: "array", items: { type: "string", enum: LABELS }, minItems: 1, maxItems: 4 },
        per_dish: { type: "integer", description: "Photos per dish, 1 to 4. Defaults to 3." },
      },
      required: ["dishes"],
    },
  },
  {
    name: "similar_dishes",
    description: "Find which other Food-101 dishes look most like a given dish to the CLIP model. Averages that dish's " +
      "photo vectors, finds the 200 nearest photos of other dishes, and ranks dishes by how many of their photos appear. " +
      "Good for 'what gets confused with X' or 'what else looks like X'.",
    input_schema: {
      type: "object",
      properties: {
        dish: { type: "string", enum: LABELS },
        top_k: { type: "integer", description: "How many dishes to return, 3 to 8. Defaults to 5." },
      },
      required: ["dish"],
    },
  },
  {
    name: "more_like_photo",
    description: "Find the photos nearest to one photo you can see, by its tag (an on-screen result like R3, or a photo " +
      "from an earlier tool call like P2). Optionally limit to one course.",
    input_schema: {
      type: "object",
      properties: {
        photo: { type: "string", description: "A tag such as R3 or P2." },
        course: { type: "string", enum: ["main", "starter", "breakfast", "dessert"] },
        top_k: { type: "integer", description: "3 to 8. Defaults to 6." },
      },
      required: ["photo"],
    },
  },
];

const SYSTEM = (screen: ScreenContext | null) => `You are the Food Finder copilot. Food Finder searches 10,100 photos \
from the Food-101 dataset (100 photos of each of 101 dishes) stored in turbopuffer as 512-number OpenCLIP ViT-B-32 \
vectors. The user searches by typing a description or uploading a photo; the CLIP model runs in their browser.

What you can do: explain the results on screen and why they ranked as they did, show photos of named dishes, find \
which dishes look alike to the model, and find more photos like one you can see. You can't run free-text searches \
yourself; if the user wants one, suggest the words to type in the search box.

How search works, for explanations: text and photos share one vector space, so a query lands near photos with similar \
content. Results are ranked by cosine similarity. Text-to-photo similarities are low (about 0.25 to 0.35) and \
photo-to-photo ones high (0.6 to 0.95); only the order within one search matters. "Looks like X" is a vote among the \
top 10 results where higher ranks count more. Each dish has a course (${Object.values(COURSE_LABELS).join(", ")}) used \
as a filter; that grouping is the app's, not Food-101's.

Rules:
- Cite every photo you mention with its tag, like [R2] or [P5]. Only use tags that appear in the context or tool results.
- Photos show how dishes look, not their ingredients. Never assure anyone a dish is safe for an allergy or diet.
- Be brief and format for a narrow side panel: a sentence or two, then a short bulleted list if useful. Never use tables.

The 101 dish labels: ${LABELS.join(", ")}.

${screen && screen.hits.length
    ? `On screen now: results for ${screen.query}${screen.course ? `, filtered to ${COURSE_LABELS[screen.course]}` : ""}. \
${screen.guess ? `The app's guess: ${screen.guess}. ` : ""}Top results:\n${screen.hits.map((h, i) =>
      `[R${i + 1}] ${h.dish} (similarity ${h.similarity.toFixed(3)})`).join("\n")}`
    : "Nothing is on screen yet."}`;

const GATEWAY_URL = "https://ai-gateway.vercel.sh";

// Direct to Anthropic when ANTHROPIC_API_KEY is set; otherwise through AI Gateway with its key or the Vercel OIDC token.
async function copilotClient(): Promise<Anthropic> {
  if (process.env.ANTHROPIC_API_KEY) return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: tracedFetch });
  const authToken = process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken());
  return new Anthropic({ baseURL: GATEWAY_URL, authToken, maxRetries: 1, timeout: 40_000, fetch: tracedFetch });
}

// One JSON line per step in the Vercel runtime logs.
const log = (event: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ copilot: event, model: COPILOT_MODEL, ...data }));

const MAX_TOKENS = 3000;
const MAX_TURNS = 6;
const SOFT_DEADLINE_MS = 100_000;
const REASONING_MAX = 3000;

// What the model said before calling tools: its thinking plus any text it wrote first.
function reasoningOf(content: Anthropic.ContentBlock[]): string | undefined {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "thinking" && b.thinking.trim()) parts.push(b.thinking.trim());
    else if (b.type === "text" && b.text.trim()) parts.push(b.text.trim());
  }
  const all = parts.join("\n\n");
  return all ? (all.length > REASONING_MAX ? `${all.slice(0, REASONING_MAX)}…` : all) : undefined;
}

// Langfuse observation names for the tools. Keep them stable: dashboards and evaluators filter on them.
const TOOL_OBSERVATION: Record<string, string> = {
  show_dish_photos: "show-dish-photos", similar_dishes: "similar-dishes", more_like_photo: "more-like-photo",
};

/** Answer one question. */
export async function runCopilot(messages: Anthropic.MessageParam[], screen: ScreenContext | null,
  emit: (e: CopilotEvent) => void): Promise<void> {
  const last = messages.at(-1);
  const question = last?.role === "user" && typeof last.content === "string" ? last.content : "";
  return startActiveObservation("answer-copilot-question", async (agent) => {
    agent.update({ input: question, metadata: { model: COPILOT_MODEL, screenQuery: screen?.query ?? null,
      screenHits: screen?.hits.length ?? 0, earlierMessages: messages.length - 1 } });
    try {
      const id = getActiveTraceId();
      if (id) emit({ type: "trace", id });
    } catch {
      // no trace id: feedback buttons stay hidden
    }
    try {
      const r = await loop(messages, screen, emit);
      agent.update({
        output: r.answer || null,
        metadata: { turns: r.calls, inTokens: r.inTokens, outTokens: r.outTokens, cost: r.cost, citations: r.citations, seconds: r.seconds },
        ...(r.answer ? {} : { level: "WARNING" as const, statusMessage: "No answer within the turn limit." }),
      });
    } catch (e) {
      agent.update({ level: "ERROR", statusMessage: (e as Error).message.slice(0, 500) });
      throw e;
    }
  }, { asType: "agent" });
}

async function loop(messages: Anthropic.MessageParam[], screen: ScreenContext | null, emit: (e: CopilotEvent) => void) {
  const llm = await copilotClient();
  const t0 = performance.now();
  // Tags the model can cite: R1.. for on-screen results, P1.. for photos returned by tools.
  const cites: Record<string, Cited> = {};
  const tagOf = new Map<string, string>();
  screen?.hits.forEach((h, i) => { cites[`R${i + 1}`] = { id: h.id, dish: h.dish, url: h.url }; tagOf.set(h.id, `R${i + 1}`); });
  let p = 0;
  const tag = (ph: Photo) => {
    if (!tagOf.has(ph.id)) { p += 1; tagOf.set(ph.id, `P${p}`); cites[`P${p}`] = { id: ph.id, dish: ph.dish, url: ph.url }; }
    return tagOf.get(ph.id)!;
  };

  async function runTool(name: string, input: Record<string, unknown>, reasoning?: string): Promise<string> {
    const t1 = performance.now();
    const step = (results: number, summary: string) =>
      emit({ type: "step", tool: name, input, results, ms: performance.now() - t1, reasoning, summary });
    if (name === "show_dish_photos") {
      const dishes = ((input.dishes as string[]) ?? []).filter((d) => LABELS.includes(d)).slice(0, 4);
      const n = Math.min(4, Math.max(1, Number(input.per_dish) || 3));
      const sets = await Promise.all(dishes.map(async (d) => ({ d, photos: await photosOf(d, n) })));
      const total = sets.reduce((s, x) => s + x.photos.length, 0);
      step(total, `${total} photos of ${dishes.map(dishName).join(", ")}`);
      return sets.map(({ d, photos }) => `${dishName(d)} (${COURSE_LABELS[courseOf(d)]}): ${photos.map((ph) => `[${tag(ph)}]`).join(" ")}`).join("\n")
        || "No photos found.";
    }
    if (name === "similar_dishes") {
      const dish = String(input.dish ?? "");
      if (!LABELS.includes(dish)) return "Unknown dish label.";
      const k = Math.min(8, Math.max(3, Number(input.top_k) || 5));
      const r = await similarDishes(dish, k);
      step(r.dishes.length, `${r.dishes.length} dishes near ${dishName(dish)} (averaged ${r.sampled} photos)`);
      if (!r.dishes.length) return "No similar dishes found.";
      return `Averaged ${r.sampled} photos of ${dishName(dish)}; among the 200 nearest photos of other dishes:\n` +
        r.dishes.map((d) => `- ${d.dish}: ${d.matches} of 200, best similarity ${d.best.toFixed(3)}, example [${tag(d.example)}]`).join("\n");
    }
    if (name === "more_like_photo") {
      const t = String(input.photo ?? "").toUpperCase();
      const target = cites[t];
      if (!target) return `Unknown tag ${t}. Use a tag from the context or an earlier tool result.`;
      const course = ["main", "starter", "breakfast", "dessert"].includes(String(input.course)) ? input.course as Course : undefined;
      const k = Math.min(8, Math.max(3, Number(input.top_k) || 6));
      const r = await searchById(target.id, { course, limit: k });
      const hits = r?.hits ?? [];
      step(hits.length, `${hits.length} photos like ${t} (${target.dish})`);
      return hits.map((h) => `[${tag(h)}] ${h.dish}, similarity ${h.similarity.toFixed(3)}`).join("\n") || "No results.";
    }
    return `Unknown tool ${name}.`;
  }

  const convo = [...messages];
  const used = { calls: 0, inTokens: 0, outTokens: 0 };
  let answer = "";
  let notice: string | null = null;
  const price = await priceOf(COPILOT_MODEL);
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (turn > 0 && performance.now() - t0 > SOFT_DEADLINE_MS) {
      notice = "Stopped early: this question was close to the time limit. Try a narrower question.";
      break;
    }
    const params: Anthropic.MessageStreamParams = {
      model: COPILOT_MODEL, max_tokens: MAX_TOKENS, system: SYSTEM(screen), tools: TOOLS, messages: [...convo],
      thinking: { type: "adaptive", display: "summarized" },
    };
    const gen = startObservation("generate-response", {
      model: COPILOT_MODEL, modelParameters: { max_tokens: MAX_TOKENS, thinking: "adaptive, summarized" },
      input: promptOf(params), metadata: { turn },
    }, { asType: "generation" });
    const stream = llm.messages.stream(params);
    stream.on("text", (delta) => emit({ type: "text", delta }));
    const tm = performance.now();
    let firstToken: number | null = null;
    stream.on("streamEvent", () => { firstToken ??= performance.now() - tm; });
    let msg: Anthropic.Message;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      gen.update({ level: "ERROR", statusMessage: (e as Error).message.slice(0, 500) }).end();
      throw e;
    }
    gen.update({
      output: assistantMessage(msg.content),
      completionStartTime: firstToken === null ? undefined : new Date(performance.timeOrigin + tm + firstToken),
      ...usageOf(msg.usage, price),
      metadata: { turn, stopReason: msg.stop_reason },
    }).end();
    used.calls += 1;
    used.inTokens += msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
    used.outTokens += msg.usage.output_tokens;
    const reasoning = msg.stop_reason === "tool_use" ? reasoningOf(msg.content) : undefined;
    log("model", { turn, ms: Math.round(performance.now() - tm), stop: msg.stop_reason, inTokens: msg.usage.input_tokens, outTokens: msg.usage.output_tokens });
    convo.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason !== "tool_use") {
      answer = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      if (msg.stop_reason === "max_tokens") notice = "The answer was cut off at the length limit. Ask a follow-up to continue.";
      break;
    }
    if (turn === MAX_TURNS - 1) notice = `Stopped after ${MAX_TURNS} steps without a final answer. Try a narrower question.`;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as Record<string, unknown>;
      const out = await startActiveObservation(TOOL_OBSERVATION[block.name] ?? "run-tool", async (obs) => {
        obs.update({ input, metadata: { tool: block.name, toolCallId: block.id, turn } });
        const text = await runTool(block.name, input, reasoning);
        obs.update({ output: text });
        return text;
      }, { asType: "tool" });
      results.push({ type: "tool_result", tool_use_id: block.id, content: out });
    }
    convo.push({ role: "user", content: results });
  }
  const cost = await costOf(COPILOT_MODEL, used.inTokens, used.outTokens);
  if (notice) emit({ type: "notice", message: notice });
  // Only the tags the answer actually uses, so the browser shows just those photos.
  const usedTags = Object.fromEntries(Object.entries(cites).filter(([t]) => answer.includes(`[${t}]`)));
  emit({ type: "citations", items: usedTags });
  emit({ type: "usage", usage: { ...used, cost } });
  const seconds = (performance.now() - t0) / 1000;
  emit({ type: "done", seconds });
  log("done", { seconds: Math.round(seconds), ...used, cost });
  return { answer, ...used, cost, citations: Object.keys(usedTags).length, seconds };
}
